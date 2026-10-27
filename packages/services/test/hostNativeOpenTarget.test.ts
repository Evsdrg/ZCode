import { describe, expect, it } from "vitest";
import {
  EDITOR_LAUNCH_DEFS,
  hasGraphicalSession,
  openInEditor,
  openInFileManager,
  resolveExecutable,
} from "../src/host-native/openTarget.js";

describe("host-native openTarget", () => {
  it("没有图形会话时 fail-closed，不尝试 spawn", async () => {
    const env = { PATH: "/usr/bin", DISPLAY: "", WAYLAND_DISPLAY: "" };
    expect(hasGraphicalSession(env)).toBe(false);
    await expect(openInFileManager("/tmp", env)).resolves.toEqual({
      success: false,
      error: "no_display",
    });
    await expect(openInEditor("dolphin", "/tmp", env)).resolves.toEqual({
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
    const result = await openInEditor("rm -rf /", "/tmp", env);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown editor");
  });

  it("编辑器列表里没有任何 shell 元字符命令", () => {
    for (const [id, def] of Object.entries(EDITOR_LAUNCH_DEFS)) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(def.executable).toMatch(/^[a-z0-9.-]+$/);
    }
  });

  it("resolveExecutable 按 PATH 解析并支持绝对路径", async () => {
    const env = { PATH: "/definitely/not/here" };
    expect(await resolveExecutable("/bin/sh", env)).toBe("/bin/sh");
    expect(await resolveExecutable("sh", { PATH: "/bin" })).toBe("/bin/sh");
    expect(await resolveExecutable("no-such-binary-xyz", { PATH: "/bin" })).toBeNull();
  });
});
