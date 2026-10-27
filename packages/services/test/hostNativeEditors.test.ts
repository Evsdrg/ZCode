import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInstalledEditors } from "../src/host-native/editors.js";

/**
 * 与 Electron 语义对齐的两条硬约束：
 * 1. 不传 filePath → 空数组（Linux 上没有「通用编辑器」概念）；
 * 2. 传 filePath → 只列扩展名匹配且已安装的文档/媒体应用。
 */
describe("host-native getInstalledEditors", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-editors-"));
    env = {
      PATH: join(root, "bin"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_DATA_DIRS: join(root, "sysdata"),
    };
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "data", "applications"), { recursive: true });
    await mkdir(join(root, "sysdata", "applications"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function installFakeApp(executable: string, desktopName: string) {
    await writeFile(join(root, "bin", executable), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      join(root, "data", "applications", `${desktopName}.desktop`),
      ["[Desktop Entry]", `Name=${desktopName}`, "Icon=fakeicon", "Type=Application"].join("\n"),
    );
  }

  it("不传 filePath 时恒为空（Linux 无通用编辑器）", async () => {
    await installFakeApp("evince", "org.gnome.Evince");
    expect(await getInstalledEditors(undefined, env)).toEqual([]);
  });

  it("传 .pdf 时只列 pdf 类应用，未安装的不出现", async () => {
    await installFakeApp("evince", "org.gnome.Evince");
    const editors = await getInstalledEditors("/tmp/doc.pdf", env);
    // `resolveFileApplicationPath` 会先看 def.appPath（/usr/bin/<exe>），与 Electron 一致，
    // 所以本机真实安装的 pdf 应用也会出现；这里只断言集合关系，不依赖宿主机装了哪些。
    const ids = editors.map((e) => e.id);
    expect(ids).toContain("evince");
    // 只可能是 pdf 类应用
    expect(ids.every((id) => ["evince", "okular", "firefox"].includes(id))).toBe(true);
  });

  it("扩展名不匹配时返回空", async () => {
    await installFakeApp("evince", "org.gnome.Evince");
    expect(await getInstalledEditors("/tmp/doc.txt", env)).toEqual([]);
  });

  it("图标取不到时返回空串，但仍列出该项", async () => {
    await installFakeApp("evince", "org.gnome.Evince");
    const editors = await getInstalledEditors("/tmp/doc.pdf", env);
    const evince = editors.find((e) => e.id === "evince");
    expect(evince).toBeDefined();
    expect(evince!.iconDataUrl).toBe("");
  });
});
