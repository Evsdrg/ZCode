import { describe, expect, it } from "vitest";

import {
  isRequestSecurityFailure,
  requestSecuritySensitiveHeaders,
} from "./policy.js";
import {
  allowRequestVerificationHeaders,
  isRequestVerificationMessage,
  readRequestVerificationConfig,
  readValidatedRequestVerificationConfig,
  REQUEST_VERIFICATION_REQUIRED,
  requestVerificationClaimHeaders,
  requestVerificationDiagnostics,
  requestVerificationReasons,
  requestVerificationTimeoutMessage,
  requiresRequestVerification,
  summarizeRequestVerificationHeaders,
  withoutRequestVerificationHeaders,
} from "./verification-policy.js";

/**
 * 回归：请求校验（阿里云验证码）策略。
 *
 * 历史缺陷：本发行版所有函数都是空桩——
 *  - `readRequestVerificationConfig` 恒返回 null → 服务端下发的 captcha 配置永远读不到；
 *  - `requestVerificationClaimHeaders` 恒返回 {} → 领取请求不带证明头，被 WAF 拦截；
 *  - `isRequestSecurityFailure` 恒返回 false → WAF 拦截页被当成普通网络错误；
 *  - `requestVerificationInteractionAvailable = false` → 上层直接跳过整个校验链路。
 * 用户看到的是「request has been blocked due to unusual activity」。
 */

const VALID_CAPTCHA = {
  enabled: true,
  region: "cn",
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  skip_model_request: true,
};

describe("requestSecuritySensitiveHeaders", () => {
  it("覆盖两枚验证码证明头，供日志与抓包打码", () => {
    expect(requestSecuritySensitiveHeaders).toContain("X-Aliyun-Captcha-Verify-Param");
    expect(requestSecuritySensitiveHeaders).toContain("X-Aliyun-Captcha-Verify-Region");
  });
});

describe("readRequestVerificationConfig", () => {
  it("读取服务端 captcha 并把 skip_model_request 改名为 camelCase", () => {
    expect(readRequestVerificationConfig({ captcha: VALID_CAPTCHA })).toEqual({
      enabled: true,
      region: "cn",
      prefix: "no8xfe",
      sceneId: "11xygtvd",
      skipModelRequest: true,
    });
  });

  it("没有 captcha 段时返回 null，不抛错", () => {
    expect(readRequestVerificationConfig(null)).toBeNull();
    expect(readRequestVerificationConfig({})).toBeNull();
    expect(readRequestVerificationConfig({ captcha: null })).toBeNull();
  });

  it("skip_model_request 非 boolean 时不写出 skipModelRequest（保留原始字段）", () => {
    const config = readRequestVerificationConfig({
      captcha: { ...VALID_CAPTCHA, skip_model_request: "true" },
    });
    expect(config?.skipModelRequest).toBeUndefined();
  });
});

describe("readValidatedRequestVerificationConfig", () => {
  it("合法配置原样返回", () => {
    expect(readValidatedRequestVerificationConfig({ captcha: VALID_CAPTCHA })).toEqual({
      enabled: true,
      region: "cn",
      prefix: "no8xfe",
      sceneId: "11xygtvd",
      skipModelRequest: true,
    });
  });

  it("enabled 非 boolean 视为坏配置（不能按关闭处理）", () => {
    expect(() =>
      readValidatedRequestVerificationConfig({ captcha: { ...VALID_CAPTCHA, enabled: "yes" } }),
    ).toThrow("Request verification configuration is invalid");
  });

  it("skip_model_request 非 boolean 视为坏配置", () => {
    expect(() =>
      readValidatedRequestVerificationConfig({
        captcha: { ...VALID_CAPTCHA, skip_model_request: 1 },
      }),
    ).toThrow("Request verification configuration is invalid");
  });

  it("需要校验时 region/prefix/sceneId 缺一不可", () => {
    // 注意必须去掉 skip_model_request：跳过模型请求校验时不再要求这三项（见下一条用例）。
    const { skip_model_request: _skip, ...challengeRequired } = VALID_CAPTCHA;
    for (const key of ["region", "prefix", "sceneId"] as const) {
      expect(() =>
        readValidatedRequestVerificationConfig({
          captcha: { ...challengeRequired, [key]: "  " },
        }),
      ).toThrow("Request verification configuration is invalid");
    }
  });

  it("已关闭或已跳过时不要求 region/prefix/sceneId", () => {
    expect(
      readValidatedRequestVerificationConfig({ captcha: { enabled: false } }),
    ).toEqual({ enabled: false });
    expect(
      readValidatedRequestVerificationConfig({
        captcha: { enabled: true, skip_model_request: true },
      }),
    ).toEqual({ enabled: true, skipModelRequest: true });
  });

  it("captcha 缺失返回 null（不是坏配置）", () => {
    expect(readValidatedRequestVerificationConfig({})).toBeNull();
  });
});

describe("requestVerificationClaimHeaders", () => {
  it("构造两枚证明头", () => {
    expect(
      requestVerificationClaimHeaders({ captchaVerifyParam: "P", captchaRegion: "cn" }),
    ).toEqual({
      "X-Aliyun-Captcha-Verify-Param": "P",
      "X-Aliyun-Captcha-Verify-Region": "cn",
    });
  });

  it("没有 region 时只发 param 头", () => {
    expect(requestVerificationClaimHeaders({ captchaVerifyParam: "P" })).toEqual({
      "X-Aliyun-Captcha-Verify-Param": "P",
    });
  });

  it("空证明不发头（宁可被服务端按缺证明拒绝，也不发空头被当成伪造）", () => {
    expect(requestVerificationClaimHeaders({})).toEqual({});
    expect(requestVerificationClaimHeaders({ captchaVerifyParam: "   " })).toEqual({});
  });
});

describe("withoutRequestVerificationHeaders / allowRequestVerificationHeaders", () => {
  it("剥离静态头里的旧证明（大小写不敏感）", () => {
    expect(
      withoutRequestVerificationHeaders({
        "x-aliyun-captcha-verify-param": "stale",
        "X-Aliyun-Captcha-Verify-Region": "cn",
        Authorization: "Bearer t",
      }),
    ).toEqual({ Authorization: "Bearer t" });
  });

  it("只放行证明头，且规范化为标准头名", () => {
    expect(
      allowRequestVerificationHeaders({
        "x-aliyun-captcha-verify-param": " P ",
        authorization: "Bearer evil",
        "X-Aliyun-Captcha-Verify-Region": "cn",
      }),
    ).toEqual({
      "X-Aliyun-Captcha-Verify-Param": "P",
      "X-Aliyun-Captcha-Verify-Region": "cn",
    });
  });

  it("空值头不写入", () => {
    expect(allowRequestVerificationHeaders({ "X-Aliyun-Captcha-Verify-Param": "  " })).toEqual({});
  });
});

describe("requiresRequestVerification", () => {
  it("非 start-plan 一律不需要", () => {
    expect(requiresRequestVerification({ mode: "individual-coding-plan" })).toBe(false);
    expect(requiresRequestVerification({ mode: "team-coding-plan" }, { enabled: true })).toBe(
      false,
    );
  });

  it("明确关闭或跳过时不需要", () => {
    expect(requiresRequestVerification({ mode: "start-plan" }, { enabled: false })).toBe(false);
    expect(
      requiresRequestVerification({ mode: "start-plan" }, { enabled: true, skipModelRequest: true }),
    ).toBe(false);
  });

  it("配置缺失不隐式放行", () => {
    expect(requiresRequestVerification({ mode: "start-plan" })).toBe(true);
    expect(requiresRequestVerification({ mode: "start-plan" }, null)).toBe(true);
  });
});

describe("isRequestVerificationMessage", () => {
  it("同时认中文与英文措辞", () => {
    expect(isRequestVerificationMessage("请完成安全验证后重试")).toBe(true);
    expect(isRequestVerificationMessage("Please complete security verification")).toBe(true);
  });

  it("普通错误不误判", () => {
    expect(isRequestVerificationMessage("quota exceeded")).toBe(false);
  });
});

describe("诊断摘要", () => {
  it("只报有没有证明，不泄露证明内容", () => {
    const summary = summarizeRequestVerificationHeaders({
      "X-Aliyun-Captcha-Verify-Param": "SECRET",
      "X-Aliyun-Captcha-Verify-Region": "cn",
    });
    expect(summary.hasRequestVerificationProof).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("requestVerificationDiagnostics 从 outboundHeaderKeys 推断", () => {
    expect(
      requestVerificationDiagnostics({
        outboundHeaderKeys: ["x-aliyun-captcha-verify-param", "authorization"],
      }),
    ).toEqual({
      requestVerificationHeaderKeys: ["X-Aliyun-Captcha-Verify-Param"],
      hasRequestVerificationProof: true,
    });
  });
});

describe("isRequestSecurityFailure", () => {
  it("识别 WAF 拦截页正文", () => {
    expect(
      isRequestSecurityFailure("<html>request has been blocked due to unusual activity</html>", []),
    ).toBe(true);
    expect(isRequestSecurityFailure({ message: "see errors.aliyun.com" }, [])).toBe(true);
  });

  it("识别验证码错误码", () => {
    expect(isRequestSecurityFailure(null, ["CAPTCHA_VERIFY_FAILED"])).toBe(true);
    expect(isRequestSecurityFailure(null, ["F001"])).toBe(true);
  });

  it("普通错误不误判", () => {
    expect(isRequestSecurityFailure("model overloaded", ["1305"])).toBe(false);
    expect(isRequestSecurityFailure(null, [])).toBe(false);
  });
});

describe("常量契约", () => {
  it("原因枚举与超时文案稳定", () => {
    expect(requestVerificationReasons).toEqual(["model-request", "captcha-retry"]);
    expect(requestVerificationTimeoutMessage).toContain("send your message again");
    expect(REQUEST_VERIFICATION_REQUIRED).toBe("request_verification_unavailable");
  });
});
