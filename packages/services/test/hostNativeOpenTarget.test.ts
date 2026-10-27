import { describe, expect, it } from "vitest";
import {
  LINUX_FILE_APPLICATION_DEFS,
  matchesFileApplication,
  openInEditor,
  openInFileManager,
  resolveExecutable,
  resolveFileApplicationPath,
  hasGraphicalSession,
} from "../src/host-native/openTarget.js";

describe("host-native openTarget", () => {
  it("没有图形会话时 fail-closed，不尝试 spawn", async () => {
    const env = { PATH: "/usr/bin", DISPLAY: "", WAYLAND_DISPLAY: "" };
    expect(hasGraphicalSession(env)).toBe(false);
    await expect(openInFileManager("/tmp", env)).resolves.toEqual({
      success: false,
      error: "no_display",
    });
  });

  it("空路径直接报错", async () => {
    const env = { PATH: "/usr/bin", DISPLAY: ":0" };
    await expect(openInFileManager("  ", env)).resolves.toEqual({
      success: false,
      error: "empty path",
    });
  });

  it("未知 editorId 不会拼命令", async () => {
    const env = { PATH: "/usr/bin", DISPLAY: ":0" };
    const result = await openInEditor("rm -rf /", "/tmp/x.pdf", {}, env);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown editor");
  });

  it("目录 / 远端目标 / 非绝对路径 / 扩展名不匹配 → unsupported", async () => {
    const env = { PATH: "/usr/bin", DISPLAY: ":0" };
    for (const [options, path] of [
      [{ pathKind: "directory" as const }, "/tmp/x.pdf"],
      [{ remoteTarget: { kind: "ssh" } }, "/tmp/x.pdf"],
      [{}, "relative/x.pdf"],
      [{}, "/tmp/x.txt"],
    ] as const) {
      const result = await openInEditor("evince", path, options, env);
      expect(result.error).toBe("unsupported file application target");
    }
  });

  it("定义表与 Electron 的 Linux fileApplications 完全一致", () => {
    expect(LINUX_FILE_APPLICATION_DEFS.map((d) => d.id)).toEqual([
      "evince",
      "okular",
      "firefox",
      "wps",
      "wps-presentation",
      "wps-spreadsheets",
      "libreoffice-writer",
      "libreoffice-impress",
      "libreoffice-calc",
      "vlc",
      "mpv",
    ]);
    for (const def of LINUX_FILE_APPLICATION_DEFS) {
      expect(def.fileExtensions.length).toBeGreaterThan(0);
      expect(def.executableNames.length).toBeGreaterThan(0);
    }
  });

  it("matchesFileApplication 按扩展名（大小写不敏感）", () => {
    const evince = LINUX_FILE_APPLICATION_DEFS.find((d) => d.id === "evince")!;
    expect(matchesFileApplication(evince, "/tmp/a.pdf")).toBe(true);
    expect(matchesFileApplication(evince, "/tmp/a.PDF")).toBe(true);
    expect(matchesFileApplication(evince, "/tmp/a.txt")).toBe(false);
    expect(matchesFileApplication(evince, "/tmp/noext")).toBe(false);
  });

  it("resolveFileApplicationPath 找不到时返回 null", async () => {
    const def = {
      id: "fake",
      name: "Fake",
      appPath: "/definitely/not/here/fake-app",
      executableNames: ["fake-app"],
      fileExtensions: ["pdf"],
    };
    expect(await resolveFileApplicationPath(def, { PATH: "/definitely/not/here" })).toBeNull();
  });

  it("resolveExecutable 按 PATH 解析并支持绝对路径", async () => {
    const env = { PATH: "/definitely/not/here" };
    expect(await resolveExecutable("/bin/sh", env)).toBe("/bin/sh");
    expect(await resolveExecutable("sh", { PATH: "/bin" })).toBe("/bin/sh");
    expect(await resolveExecutable("no-such-binary-xyz", { PATH: "/bin" })).toBeNull();
  });
});
