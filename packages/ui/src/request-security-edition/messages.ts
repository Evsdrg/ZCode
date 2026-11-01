/**
 * 请求安全相关的 i18n 文案（英文 / 中文）。
 *
 * 这些键覆盖三类用户可见文本：
 *  1. 验证码校验失败（3007 / CAPTCHA_VERIFY_FAILED）；
 *  2. 请求校验配置读取失败（网络 vs 配置非法）；
 *  3. 空流终态提示（验证码未完成也会表现为空流）。
 *
 * 中文文案与官方发行版一致，避免用户在不同形态下看到两套措辞。
 */
export const requestSecurityMessagesEnUS = {
  "chat.configReadRetryStatus": "Retrying request verification configuration ({attempt}/{maxRetries})…",
  "chat.configReadFailed":
    "Temporarily unable to read request verification configuration; this message has not been sent. Check your network and retry.",
  "chat.configInvalid":
    "Request verification configuration is invalid. Check your account or contact support.",
  "manualClaimPlan.claim.failure.captcha": "Captcha verification failed. Please try again.",
  "chat.error.action.retryCaptcha": "Retry captcha",
  "chat.captcha.verifyFailed": "Captcha verification failed. Please try again.",
  "zcode.error.providerBusiness.3007": "Captcha verification failed. Please try again.",
  "zcode.error.modelSuspiciousEmpty":
    "The model returned no content (often caused by captcha not completed, an expired token, or plan issues). Send again and captcha verification will run before the request.",
};

export const requestSecurityMessagesZhCN = {
  "chat.configReadRetryStatus": "正在重新读取请求校验配置（{attempt}/{maxRetries}）…",
  "chat.configReadFailed": "暂时无法读取请求校验配置，消息尚未发送。请检查网络后重试。",
  "chat.configInvalid": "请求校验配置无效，请检查账号或联系支持。",
  "manualClaimPlan.claim.failure.captcha": "验证码校验失败，请重试。",
  "chat.error.action.retryCaptcha": "重试验证码",
  "chat.captcha.verifyFailed": "验证码校验失败，请重试。",
  "zcode.error.providerBusiness.3007": "验证码校验失败，请重试。",
};
