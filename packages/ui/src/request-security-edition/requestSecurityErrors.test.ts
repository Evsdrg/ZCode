import { describe, expect, it } from "vitest";

import {
  additionalRequestModalSelectors,
  isRequestVerificationConfigNetworkError,
  isRequestVerificationRejectedMessage,
  isRequestVerificationTerminalError,
  resolveRequestSecurityErrorMessageId,
  resolveRequestVerificationBusinessCode,
  REQUEST_VERIFICATION_REJECTED_MESSAGE,
  requestVerificationActionMessages,
  requestVerificationClaimFailureMessageId,
  requestVerificationErrorAttribution,
  requestVerificationRecoveryAction,
} from "./errors.js";

/**
 * 回归：请求校验错误在 UI 侧的识别与归因。
 *
 * 历史缺陷：本发行版全是空桩——
 *  - `resolveRequestVerificationBusinessCode` 恒 undefined → 3007 不会走验证码文案；
 *  - `requestVerificationRecoveryAction` 为 null → 错误横幅没有「重试验证码」按钮；
 *  - `additionalRequestModalSelectors` 为空 → 验证码弹窗被营销弹窗判定为「无模态」而覆盖；
 *  - `isRequestVerificationConfigNetworkError` 恒 false → 配置读取失败后无法复用原输入重试。
 */

describe("resolveRequestVerificationBusinessCode", () => {
  it("3007 与 CAPTCHA_VERIFY_FAILED 都归一为 3007", () => {
    expect(resolveRequestVerificationBusinessCode("3007", undefined)).toBe("3007");
    expect(resolveRequestVerificationBusinessCode("CAPTCHA_VERIFY_FAILED", undefined)).toBe("3007");
  });

  it("只有文案时也能识别（覆盖历史任务与 WAF 原话）", () => {
    expect(
      resolveRequestVerificationBusinessCode(undefined, REQUEST_VERIFICATION_REJECTED_MESSAGE),
    ).toBe("3007");
    expect(resolveRequestVerificationBusinessCode(undefined, "captcha verify failed")).toBe("3007");
    expect(resolveRequestVerificationBusinessCode(undefined, "验证码校验失败，请重试")).toBe("3007");
  });

  it("其它业务码不误判", () => {
    expect(resolveRequestVerificationBusinessCode("3006", "model not available")).toBeUndefined();
    expect(resolveRequestVerificationBusinessCode(undefined, "quota exceeded")).toBeUndefined();
  });
});

describe("isRequestVerificationRejectedMessage", () => {
  it("空白与无关文案返回 false", () => {
    expect(isRequestVerificationRejectedMessage(undefined)).toBe(false);
    expect(isRequestVerificationRejectedMessage("   ")).toBe(false);
    expect(isRequestVerificationRejectedMessage("network error")).toBe(false);
  });
});

describe("isRequestVerificationTerminalError", () => {
  it("只有 CAPTCHA_VERIFY_FAILED 视为终态", () => {
    expect(isRequestVerificationTerminalError({ code: "CAPTCHA_VERIFY_FAILED" })).toBe(true);
    expect(isRequestVerificationTerminalError({ code: "3007" })).toBe(false);
    expect(isRequestVerificationTerminalError(null)).toBe(false);
  });
});

describe("恢复动作与归因", () => {
  it("恢复动作 id 与按钮文案 id 已接线", () => {
    expect(requestVerificationRecoveryAction).toBe("retry-captcha");
    expect(requestVerificationActionMessages["retry-captcha"]).toBe("chat.error.action.retryCaptcha");
  });

  it("CAPTCHA_VERIFY_FAILED 归因为 provider/auth_failed", () => {
    expect(requestVerificationErrorAttribution.CAPTCHA_VERIFY_FAILED).toEqual({
      source: "provider",
      reason: "auth_failed",
    });
  });

  it("claim 失败用专门的验证码文案 id（不是泛化 generic）", () => {
    expect(requestVerificationClaimFailureMessageId).toBe("manualClaimPlan.claim.failure.captcha");
  });
});

describe("additionalRequestModalSelectors", () => {
  it("包含阿里云验证码弹窗选择器（否则会被营销弹窗覆盖）", () => {
    expect(additionalRequestModalSelectors).toContain(".aliyunCaptcha-mask");
    expect(additionalRequestModalSelectors).toContain(".aliyunCaptcha-window");
  });
});

describe("resolveRequestSecurityErrorMessageId", () => {
  it("网络失败 → 可重试文案", () => {
    expect(resolveRequestSecurityErrorMessageId({ code: "request_verification_config_network" })).toBe(
      "chat.configReadFailed",
    );
    expect(
      resolveRequestSecurityErrorMessageId({ message: "Request verification configuration read failed" }),
    ).toBe("chat.configReadFailed");
  });

  it("配置非法 → 不可重试文案", () => {
    expect(resolveRequestSecurityErrorMessageId({ code: "request_verification_config_invalid" })).toBe(
      "chat.configInvalid",
    );
    expect(
      resolveRequestSecurityErrorMessageId({
        message: "Request verification configuration is invalid",
      }),
    ).toBe("chat.configInvalid");
  });

  it("无关错误返回 undefined", () => {
    expect(resolveRequestSecurityErrorMessageId({ code: "3007" })).toBeUndefined();
  });
});

describe("isRequestVerificationConfigNetworkError", () => {
  it("只有网络失败可复用原输入重跑", () => {
    expect(
      isRequestVerificationConfigNetworkError({ code: "request_verification_config_network" }),
    ).toBe(true);
    expect(
      isRequestVerificationConfigNetworkError({ code: "request_verification_config_invalid" }),
    ).toBe(false);
    expect(isRequestVerificationConfigNetworkError(null)).toBe(false);
  });
});
