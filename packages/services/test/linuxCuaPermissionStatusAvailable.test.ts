import { describe, expect, it } from "vitest";
import { isCuaPermissionStatusAvailable } from "@zcode/zcode-cua/broker/ports";

/**
 * 回归：Linux `getStatus` 分支返回的成功对象必须带 `available: true`。
 *
 * 历史缺陷（阶段 5 漏改）：`CuaPermissionStatus.available` 在类型里是可选字面量 `true`，
 * 但运行时判定 `isCuaPermissionStatusAvailable` 要求 `available === true`。Linux 分支手工
 * 构造返回对象时漏了该字段，导致设置页把「Helper 已就绪、accessibility=granted」误判为
 * 不可用，权限状态恒显示「未知」、主动授权按钮拿不到真实状态。
 * 见 docs/specs/linux-computer-use-adaptation.md 4.3。
 */
describe("Linux CUA permission status availability", () => {
  it("缺少 available 字段的成功结果会被判为不可用（缺陷形态）", () => {
    const legacyShape = {
      platform: "linux",
      grantOwner: "xdg-desktop-portal",
      accessibility: "granted" as const,
      screenRecording: "denied" as const,
    };
    expect(isCuaPermissionStatusAvailable(legacyShape as never)).toBe(false);
  });

  it("带 available: true 的结果被判为可用（修复后形态）", () => {
    const fixedShape = {
      available: true as const,
      platform: "linux",
      grantOwner: "xdg-desktop-portal",
      accessibility: "granted" as const,
      screenRecording: "denied" as const,
    };
    expect(isCuaPermissionStatusAvailable(fixedShape)).toBe(true);
  });
});
