import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getApplicationIcon,
  parseDesktopEntryIcon,
  resolveDesktopEntryIcon,
  resolveIconDataUrl,
} from "./applicationIcons.js";

/** 造一个最小的 XDG 目录树，避免依赖宿主实际安装的图标主题。 */
async function makeXdgTree(): Promise<{
  home: string;
  dataHome: string;
  dataDirs: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-icons-"));
  const home = join(root, "home");
  const dataHome = join(root, "data-home");
  const dataDirs = join(root, "data-dirs");
  await mkdir(home, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  await mkdir(dataDirs, { recursive: true });
  return { home, dataHome, dataDirs };
}

describe("parseDesktopEntryIcon", () => {
  it("只读取 [Desktop Entry] 段内的 Icon", () => {
    const content = [
      "[Desktop Entry]",
      "Name=Foo",
      "Icon=foo-app",
      "",
      "[Desktop Action new]",
      "Icon=should-not-match",
    ].join("\n");
    expect(parseDesktopEntryIcon(content)).toBe("foo-app");
  });

  it("忽略 Icon 之前的其它段", () => {
    const content = ["[Other]", "Icon=wrong", "", "[Desktop Entry]", "Icon=right"].join("\n");
    expect(parseDesktopEntryIcon(content)).toBe("right");
  });

  it("没有 Icon 时返回 null", () => {
    expect(parseDesktopEntryIcon("[Desktop Entry]\nName=NoIcon\n")).toBeNull();
  });

  it("空 Icon 值视为缺失", () => {
    expect(parseDesktopEntryIcon("[Desktop Entry]\nIcon=\n")).toBeNull();
  });

  it("忽略注释行", () => {
    const content = ["[Desktop Entry]", "# Icon=commented", "Icon=real"].join("\n");
    expect(parseDesktopEntryIcon(content)).toBe("real");
  });

  it("接受 CRLF 换行", () => {
    expect(parseDesktopEntryIcon("[Desktop Entry]\r\nIcon=crlf-app\r\n")).toBe("crlf-app");
  });
});

describe("resolveIconDataUrl", () => {
  it("绝对路径直接读文件", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    const iconPath = join(home, "icon.png");
    await writeFile(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await resolveIconDataUrl(iconPath, {
      env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
      homeDirectory: home,
    });
    expect(result).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`);
  });

  it("按主题图标名在 hicolor 查找", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    const iconDir = join(dataDirs, "icons", "hicolor", "48x48", "apps");
    await mkdir(iconDir, { recursive: true });
    await writeFile(join(iconDir, "demo.svg"), "<svg/>");
    const result = await resolveIconDataUrl("demo", {
      env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
      homeDirectory: home,
    });
    expect(result).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });

  it("沿 index.theme 的 Inherits 链找到非 hicolor 主题里的图标", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    // 用户主题 Custom 继承 Papirus，图标只在 Papirus 里。
    const customDir = join(dataHome, "icons", "Custom");
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, "index.theme"), "[Icon Theme]\nInherits=Papirus\n");
    const papirusDir = join(dataDirs, "icons", "Papirus", "64x64", "apps");
    await mkdir(papirusDir, { recursive: true });
    await writeFile(join(papirusDir, "themed.png"), Buffer.from([1, 2, 3]));
    const result = await resolveIconDataUrl("themed", {
      env: {
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: dataDirs,
        HOME: home,
        ZCODE_ICON_THEME: "Custom",
      },
      homeDirectory: home,
    });
    expect(result).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  });

  it("找不到图标时返回 null", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    await expect(
      resolveIconDataUrl("missing-icon", {
        env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
        homeDirectory: home,
      }),
    ).resolves.toBeNull();
  });

  it("空图标名返回 null", async () => {
    await expect(resolveIconDataUrl("   ")).resolves.toBeNull();
  });
});

describe("resolveDesktopEntryIcon", () => {
  it("按 .desktop 文件名找到 Icon 并解析", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    const appsDir = join(dataDirs, "applications");
    await mkdir(appsDir, { recursive: true });
    await writeFile(
      join(appsDir, "demo-app.desktop"),
      "[Desktop Entry]\nType=Application\nName=Demo\nIcon=demo-icon\n",
    );
    const iconDir = join(dataDirs, "icons", "hicolor", "48x48", "apps");
    await mkdir(iconDir, { recursive: true });
    await writeFile(join(iconDir, "demo-icon.png"), Buffer.from([9, 9]));

    const result = await resolveDesktopEntryIcon("demo-app", {
      env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
      homeDirectory: home,
    });
    expect(result).toBe(`data:image/png;base64,${Buffer.from([9, 9]).toString("base64")}`);
  });

  it("app id 不存在时返回 null", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    await expect(
      resolveDesktopEntryIcon("nope", {
        env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
        homeDirectory: home,
      }),
    ).resolves.toBeNull();
  });
});

describe("getApplicationIcon", () => {
  it("字符串输入按 app id 解析", async () => {
    const { home, dataHome, dataDirs } = await makeXdgTree();
    const appsDir = join(dataDirs, "applications");
    await mkdir(appsDir, { recursive: true });
    await writeFile(join(appsDir, "id-app.desktop"), "[Desktop Entry]\nIcon=id-icon\n");
    const iconDir = join(dataDirs, "icons", "hicolor", "48x48", "apps");
    await mkdir(iconDir, { recursive: true });
    await writeFile(join(iconDir, "id-icon.png"), Buffer.from([7]));

    await expect(
      getApplicationIcon("id-app", {
        env: { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs, HOME: home },
        homeDirectory: home,
      }),
    ).resolves.toEqual({
      iconDataUrl: `data:image/png;base64,${Buffer.from([7]).toString("base64")}`,
    });
  });

  it("结构化 locator 在 Linux 上返回 null（与 Electron 非 darwin/win32 分支一致）", async () => {
    await expect(
      getApplicationIcon({ locators: [{ kind: "darwin-bundle-id", value: "com.apple.Safari" }] }),
    ).resolves.toBeNull();
  });

  it("含路径分隔符的输入被拒绝，避免被当作任意文件读取", async () => {
    await expect(getApplicationIcon("../etc/passwd")).resolves.toBeNull();
    await expect(getApplicationIcon("/etc/passwd")).resolves.toBeNull();
  });

  it("空输入返回 null", async () => {
    await expect(getApplicationIcon("")).resolves.toBeNull();
  });
});
