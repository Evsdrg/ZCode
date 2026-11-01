/**
 * 请求安全策略（发行策略实现）。
 *
 * 背景：zcode-plan 的 `billing/claim` 等写操作由阿里云 WAF 前置，缺少验证码证明头时
 * 会直接返回 WAF 拦截页（`request has been blocked due to unusual activity`）。
 * 客户端需要把「验证码证明」透传到请求头，同时把这两枚头从日志/诊断/网络抓包中隐去。
 *
 * 本文件只放平台无关的纯函数，供 shared / services / cli / ui 共用。
 */

/** 验证码证明头：出现在真实请求里，必须在日志与抓包里打码。 */
export const requestSecuritySensitiveHeaders: readonly string[] = [
  "X-Aliyun-Captcha-Verify-Param",
  "X-Aliyun-Captcha-Verify-Region",
];

/**
 * WAF / 网关安全校验失败的判定。
 *
 * 两条证据都要认：
 *  1. `body` 是 WAF 拦截页（HTML、`errors.aliyun.com`、`request has been blocked`）；
 *  2. `codes` 里出现阿里云验证码错误码（`F001`..`T006` 形态）或 `CAPTCHA_VERIFY_FAILED`。
 *
 * 为什么不能只看业务码：WAF 拦截常常根本没进业务后端，HTTP 层拿到的是 HTML，
 * 业务码为空；反过来 3007 也可能来自业务侧风控，没有 HTML。
 */
export function isRequestSecurityFailure(
  body: unknown,
  codes: readonly (string | undefined)[],
): boolean {
  if (codes.some((code) => isRequestSecurityCode(code))) return true;
  return isRequestSecurityWafBody(body);
}

const REQUEST_SECURITY_CODE_PATTERN = /^(?:CAPTCHA_VERIFY_FAILED|VERIFY_[A-Z_]+|[FT]\d{3})$/u;

function isRequestSecurityCode(code: string | undefined): boolean {
  const normalized = code?.trim();
  if (!normalized) return false;
  return REQUEST_SECURITY_CODE_PATTERN.test(normalized);
}

const WAF_BODY_MARKERS = [
  "errors.aliyun.com",
  "request has been blocked",
  "unusual activity",
  "acw_tc",
  "cdn_sec_tc",
] as const;

function isRequestSecurityWafBody(body: unknown): boolean {
  const text = readBodyText(body);
  if (!text) return false;
  const normalized = text.toLowerCase();
  return WAF_BODY_MARKERS.some((marker) => normalized.includes(marker));
}

function readBodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  // 常见包装：{ message }, { msg }, { error: { message } }, { data: { message } }
  for (const key of ["message", "msg", "error", "data", "body", "responseBodySummary"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value !== null && typeof value === "object") {
      const nested = readBodyText(value);
      if (nested) return nested;
    }
  }
  return "";
}
