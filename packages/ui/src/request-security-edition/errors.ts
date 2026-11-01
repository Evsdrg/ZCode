/**
 * 请求校验（验证码）在 UI 侧的错误识别、恢复动作与归因。
 *
 * 这一层的职责是把「后端/CLI 报上来的错误」翻译成「用户能据此行动的 UI」：
 *  - `3007` / `CAPTCHA_VERIFY_FAILED` 统一识别为验证码失败，给出「重试验证码」动作；
 *  - 配置读取失败（网络 vs 配置非法）给出不同提示，前者可重试、后者要找支持；
 *  - 归因表让 ARMS/诊断把验证码失败记成 provider/auth_failed，而不是未知错误。
 */

/** 服务端验证码失败的标准文案（WAF 与业务侧共用）。 */
export const REQUEST_VERIFICATION_REJECTED_MESSAGE =
  "Captcha verification failed or the verify token was rejected.";

/** claim 失败（3007）后展示的本地化文案 id。 */
export const requestVerificationClaimFailureMessageId = "manualClaimPlan.claim.failure.captcha";

/**
 * 错误文案里出现的验证码失败特征。
 *
 * 覆盖三种来源：
 *  1. 服务端标准文案（英文）；
 *  2. WAF 拦截页/网关原话（`captcha verify failed`）；
 *  3. 服务端中文文案（`验证码校验失败`）。
 */
const REQUEST_VERIFICATION_MESSAGE_PATTERNS = [
  "Captcha verification failed or the verify token was rejected.",
  "verify token was rejected",
  "captcha verify failed",
  "captcha verification failed",
  "验证码校验失败",
] as const;

export function isRequestVerificationRejectedMessage(message: string | undefined): boolean {
  const text = message?.trim();
  if (!text) return false;
  const normalized = text.toLowerCase();
  return REQUEST_VERIFICATION_MESSAGE_PATTERNS.some((pattern) =>
    pattern === pattern.toLowerCase()
      ? normalized.includes(pattern)
      : text.includes(pattern),
  );
}

/**
 * 把错误码/文案归一到业务码 `3007`。
 *
 * 为什么需要归一：`3007` 可能来自业务后端，也可能被 CLI 压成 `CAPTCHA_VERIFY_FAILED`，
 * 还有历史任务只留下文案。三者对用户是同一件事，必须收敛到同一 UI 分支。
 */
export function resolveRequestVerificationBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3007" | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode === "3007" || normalizedCode === "CAPTCHA_VERIFY_FAILED") return "3007";
  return isRequestVerificationRejectedMessage(message) ? "3007" : undefined;
}

/**
 * 验证码失败是否为「终态」——不再自动重试，需要用户重新过验证码。
 *
 * 目前只有 `CAPTCHA_VERIFY_FAILED` 被视为终态；`3007` 既可能是证明过期（可重试），
 * 也可能是账号被风控（重试无用），由上层按重试次数决定，这里不擅自升级为终态。
 */
export function isRequestVerificationTerminalError(error: {
  code?: string;
  message?: string;
} | null | undefined): boolean {
  if (!error) return false;
  return error.code?.trim() === "CAPTCHA_VERIFY_FAILED";
}

/** 验证码失败的恢复动作 id（供错误横幅渲染按钮）。 */
export const requestVerificationRecoveryAction = "retry-captcha";

export type RequestVerificationRecoveryAction = typeof requestVerificationRecoveryAction;

/** 恢复动作 → 按钮文案 id。 */
export const requestVerificationActionMessages: Record<
  RequestVerificationRecoveryAction,
  string
> = {
  "retry-captcha": "chat.error.action.retryCaptcha",
};

/**
 * 错误归因表：验证码失败记为 provider/auth_failed。
 *
 * 语义上它确实是鉴权失败（WAF 拒绝了请求），归到 auth_failed 能让现有
 * 「鉴权类错误不自动重试」的策略自然生效，避免无意义重试撞 WAF。
 */
export const requestVerificationErrorAttribution = {
  CAPTCHA_VERIFY_FAILED: { source: "provider", reason: "auth_failed" },
} as const;

/**
 * 验证码弹窗的 DOM 选择器：营销弹窗的「当前是否已有模态」检测必须把它们算进去，
 * 否则验证码弹窗会被营销 banner 覆盖。选择器由阿里云 SDK 决定，不能改名。
 */
export const additionalRequestModalSelectors: readonly string[] = [
  ".aliyunCaptcha-mask",
  ".aliyunCaptcha-window",
];

/**
 * 配置读取错误的本地化文案 id。
 *
 * 两条路径必须区分：
 *  - `request_verification_config_network` / 明确文案 → 网络问题，可重试；
 *  - `request_verification_config_invalid` → 配置坏，重试无用，要找支持。
 */
export function resolveRequestSecurityErrorMessageId(error: {
  code?: string;
  message?: string;
}): string | undefined {
  const code = error.code?.trim();
  if (code === "request_verification_config_network") return "chat.configReadFailed";
  if (code === "request_verification_config_invalid") return "chat.configInvalid";
  const message = error.message?.trim();
  if (message === "Request verification configuration read failed") return "chat.configReadFailed";
  if (message === "Request verification configuration is invalid") return "chat.configInvalid";
  return undefined;
}

/** 只有「配置读取网络失败」可以复用原输入重跑（配置非法重试无意义）。 */
export function isRequestVerificationConfigNetworkError(error: {
  code?: string;
  message?: string;
} | null | undefined): boolean {
  if (!error) return false;
  return resolveRequestSecurityErrorMessageId(error) === "chat.configReadFailed";
}
