import { describe, expect, it } from "vitest";

import {
  resolveLinuxCuaAccessFailureMessageId,
  shouldAppendLinuxCuaAccessFailureDetail,
} from "./cuaPermissionAction.js";

/**
 * 回归：Linux 主动授权失败必须能区分「环境不具备条件」与「用户拒绝」。
 *
 * 历史缺陷：`requestLinuxCuaAccess` 只返回 boolean，`node.ts` 统一翻译成
 * "Portal authorization was not granted."。当机器没有活动图形会话时，portal 的
 * RemoteDesktop 前端根本没导出，用户看到这句话会以为是自己拒绝或权限没设，
 * 实际需要的是「先登录桌面」。
 *
 * 这组用例锁定失败码 → 文案 id 的映射，防止有人把分类改回单一文案。
 */
describe("resolveLinuxCuaAccessFailureMessageId", () => {
  it.each([
    ["portal_frontend_unavailable", "settings.computerUse.linuxAccess.failure.portalFrontendUnavailable"],
    [
      "graphical_session_unavailable",
      "settings.computerUse.linuxAccess.failure.graphicalSessionUnavailable",
    ],
    ["authorization_denied", "settings.computerUse.linuxAccess.failure.denied"],
    ["authorization_timeout", "settings.computerUse.linuxAccess.failure.timeout"],
    ["helper_unreachable", "settings.computerUse.linuxAccess.failure.helperUnreachable"],
    ["unknown", "settings.computerUse.linuxAccess.failure.unknown"],
  ])("失败码 %s 映射到 %s", (code, expected) => {
    expect(resolveLinuxCuaAccessFailureMessageId(code)).toBe(expected);
  });

  it.each([undefined, null, "", "some_future_code"])(
    "未登记的失败码 %s 返回 undefined（由调用方回退到原始错误）",
    (code) => {
      expect(resolveLinuxCuaAccessFailureMessageId(code)).toBeUndefined();
    },
  );
});

describe("shouldAppendLinuxCuaAccessFailureDetail", () => {
  it("环境类失败附带原始错误（便于用户报障时给出 portal 原话）", () => {
    expect(shouldAppendLinuxCuaAccessFailureDetail("portal_frontend_unavailable")).toBe(true);
    expect(shouldAppendLinuxCuaAccessFailureDetail("graphical_session_unavailable")).toBe(true);
  });

  it("用户行为类失败不附带技术细节", () => {
    expect(shouldAppendLinuxCuaAccessFailureDetail("authorization_denied")).toBe(false);
    expect(shouldAppendLinuxCuaAccessFailureDetail("authorization_timeout")).toBe(false);
    expect(shouldAppendLinuxCuaAccessFailureDetail("helper_unreachable")).toBe(false);
    expect(shouldAppendLinuxCuaAccessFailureDetail("unknown")).toBe(false);
    expect(shouldAppendLinuxCuaAccessFailureDetail(undefined)).toBe(false);
  });
});
