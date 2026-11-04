import { describe, expect, it } from "vitest";
import { openExternalFile } from "./openTarget.js";

/**
 * `openExternalFile` 的边界语义（对齐 Electron `shell.openPath`）。
 *
 * 只测不需要真实图形会话的失败分支：真实 GUI 启动无法在 CI 断言，
 * 由 `docs/specs/selfhost-host-native-platform-service.md` 的手工验收覆盖。
 */
describe("openExternalFile", () => {
  it("空路径显式失败", async () => {
    await expect(openExternalFile("", {})).resolves.toEqual({
      success: false,
      error: "empty path",
    });
  });

  it("只有空白字符也视为空路径", async () => {
    await expect(openExternalFile("   ", {})).resolves.toEqual({
      success: false,
      error: "empty path",
    });
  });

  it("没有图形会话时 fail-closed，不尝试启动子进程", async () => {
    // 显式给一个不含 DISPLAY / WAYLAND_DISPLAY 的环境，避免依赖 CI 宿主实际环境。
    await expect(openExternalFile("/tmp/a.txt", { PATH: "/usr/bin" })).resolves.toEqual({
      success: false,
      error: "no_display",
    });
  });
});
