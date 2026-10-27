import { describe, expect, it } from "vitest";
import { shouldUseCuaPermissionService } from "../src/node.js";

/**
 * 回归：Linux 必须通过插件总开关门控。
 *
 * 历史缺陷（阶段 5 漏改）：`shouldUseCuaPermissionService` 只认 darwin/win32，
 * 但 `getStatus` 与 `requestAccess` 的 Linux 分支内部又调用了它——于是 Linux 上
 * 这两个方法永远直接返回 "ZCode Computer Use is not enabled"，设置页看不到真实
 * 授权状态、主动授权按钮也不可用。见 docs/specs/linux-computer-use-adaptation.md 4.3。
 */
describe("shouldUseCuaPermissionService", () => {
  it.each(["darwin", "win32", "linux"] as const)("支持平台 %s 在插件启用时返回 true", (platform) => {
    expect(shouldUseCuaPermissionService({ platform, cuaEnabled: true })).toBe(true);
  });

  it.each(["darwin", "win32", "linux"] as const)("支持平台 %s 在插件关闭时返回 false", (platform) => {
    expect(shouldUseCuaPermissionService({ platform, cuaEnabled: false })).toBe(false);
  });

  it.each(["freebsd", "sunos", "aix"] as const)("未支持平台 %s 即使插件启用也 fail-closed", (platform) => {
    expect(shouldUseCuaPermissionService({ platform, cuaEnabled: true })).toBe(false);
  });

  it("省略 platform 时使用当前进程平台", () => {
    expect(shouldUseCuaPermissionService({ cuaEnabled: true })).toBe(
      process.platform === "darwin" ||
        process.platform === "win32" ||
        process.platform === "linux",
    );
  });
});
