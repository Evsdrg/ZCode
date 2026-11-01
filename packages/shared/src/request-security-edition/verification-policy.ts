/**
 * 请求校验（验证码）策略：配置读取、证明头构造、白名单与诊断摘要。
 *
 * 完整链路（对齐服务端契约）：
 *   1. 服务端 `GET /api/v1/client/configs` 下发 `configs.captcha`
 *      = `{ enabled, region, prefix, sceneId, skip_model_request? }`（snake_case）。
 *   2. `getRequestVerificationConfig()` 读同一份快照并做**严格校验**，坏配置直接抛错，
 *      不能按网络故障重试、更不能隐式放行。
 *   3. 需要校验时，Host 拉起阿里云验证码拿到 `captchaVerifyParam`，
 *      经 `X-Aliyun-Captcha-Verify-Param` 头随请求发出（`captchaRegion` 可选）。
 *
 * 这里只做纯策略；交互、SDK 加载与 pending 管理由 Host 负责。
 */

/** 服务端下发的原始 captcha 配置（snake_case）。 */
export interface RequestVerificationRawConfig {
  enabled?: unknown;
  region?: unknown;
  prefix?: unknown;
  sceneId?: unknown;
  skip_model_request?: unknown;
}

/**
 * Host 消费的规范化配置。
 *
 * `skipModelRequest` 与 `skip_model_request` 并存是刻意的：调用方在 shared 层统一用
 * camelCase，服务端字段只在读取边界出现。
 */
export interface RequestVerificationConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  sceneId?: string;
  skipModelRequest?: boolean;
  [key: string]: unknown;
}

/** 验证码证明：claim 一类写操作直接展开进请求体/头。 */
export interface RequestVerificationProof {
  captchaVerifyParam?: string;
  captchaRegion?: string;
}

/** 客户端的 `configs` 载荷（只声明本策略关心的部分，其余原样透传）。 */
export interface RequestVerificationClientConfig {
  captcha?: RequestVerificationRawConfig | null;
  [key: string]: unknown;
}

/**
 * 需要交互的原因。
 *
 * `captcha-retry` 是服务端明确要求重试校验时走的重入路径（例如 F008 重复提交后），
 * 与普通模型请求前预校验区分，便于诊断时定位触发源。
 */
export const requestVerificationReasons = ["model-request", "captcha-retry"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];

export const requestVerificationTimeoutMessage =
  "Provider runtime headers request timed out. Please send your message again.";

/**
 * 账号鉴权刷新因缺少验证码而无法完成时的稳定错误码。
 *
 * 不能用自然语言，因为要跨 Host/CLI 边界并按码分支；文案由 UI 本地化。
 */
export const REQUEST_VERIFICATION_REQUIRED = "request_verification_unavailable";

/** 验证码证明头名（发请求用）。 */
export const REQUEST_VERIFICATION_HEADER_PARAM = "X-Aliyun-Captcha-Verify-Param";
export const REQUEST_VERIFICATION_HEADER_REGION = "X-Aliyun-Captcha-Verify-Region";

const REQUEST_VERIFICATION_HEADERS = [
  REQUEST_VERIFICATION_HEADER_PARAM,
  REQUEST_VERIFICATION_HEADER_REGION,
] as const;

/**
 * 读取原始 captcha 配置（不做校验）。
 *
 * `skip_model_request` → `skipModelRequest` 的改名只在这一层做：上层全部用 camelCase，
 * 避免 snake_case 泄漏到服务与 UI。
 */
export function readRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const captcha = configs?.captcha;
  if (!captcha || typeof captcha !== "object" || Array.isArray(captcha)) return null;
  const { skip_model_request: skipModelRequest, ...rest } = captcha as RequestVerificationRawConfig;
  // 只保留已知的强类型字段；其余原样透传（服务端可新增字段，不阻塞旧客户端）。
  const normalized: RequestVerificationConfig = {
    ...(typeof rest.enabled === "boolean" ? { enabled: rest.enabled } : {}),
    ...(typeof rest.region === "string" ? { region: rest.region } : {}),
    ...(typeof rest.prefix === "string" ? { prefix: rest.prefix } : {}),
    ...(typeof rest.sceneId === "string" ? { sceneId: rest.sceneId } : {}),
  };
  for (const [key, value] of Object.entries(rest)) {
    if (key in normalized) continue;
    normalized[key] = value;
  }
  if (typeof skipModelRequest === "boolean") {
    normalized.skipModelRequest = skipModelRequest;
  }
  return normalized;
}

/**
 * 读取并校验 captcha 配置。
 *
 * 校验规则（与 `zcode-plan` 服务端约定一致，放宽到「关闭时不必填 region/prefix/sceneId」）：
 *  - `enabled` 存在时必须是 boolean；
 *  - `skip_model_request` 存在时必须是 boolean；
 *  - 只有在「未关闭且未跳过」时，`region` / `prefix` / `sceneId` 才必须是非空字符串。
 *
 * 为什么不能宽松：配置坏掉时如果返回 null，调用方会把「服务端要求校验」误当成
 * 「无需校验」直接放行；如果按网络错误重试，坏配置会无限重试。必须显式抛错。
 */
export function readValidatedRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const raw = configs?.captcha;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Request verification configuration is invalid");
  }
  const source = raw as RequestVerificationRawConfig;
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
    throw new Error("Request verification configuration is invalid");
  }
  if (source.skip_model_request !== undefined && typeof source.skip_model_request !== "boolean") {
    throw new Error("Request verification configuration is invalid");
  }
  const config = readRequestVerificationConfig(configs);
  if (!config) return null;
  const needsChallenge = config.enabled !== false && config.skipModelRequest !== true;
  if (needsChallenge) {
    const complete = [config.region, config.prefix, config.sceneId].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (!complete) throw new Error("Request verification configuration is invalid");
  }
  return config;
}

/**
 * 把验证码证明转成请求头。
 *
 * 空 `captchaVerifyParam` 不产生头：宁可让服务端按「缺少证明」拒绝，也不发一个空头
 * 让 WAF 判定成伪造证明。
 */
export function requestVerificationClaimHeaders(
  proof: RequestVerificationProof,
): Record<string, string> {
  const param = proof.captchaVerifyParam?.trim();
  if (!param) return {};
  const headers: Record<string, string> = { [REQUEST_VERIFICATION_HEADER_PARAM]: param };
  const region = proof.captchaRegion?.trim();
  if (region) headers[REQUEST_VERIFICATION_HEADER_REGION] = region;
  return headers;
}

/**
 * 从静态 provider 头里剥掉验证码证明头。
 *
 * 静态配置里的证明头一定是过期的（证明一次性且短命），留着会让 SDK 优先使用旧凭据。
 */
export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isRequestVerificationHeaderName(name)) continue;
    result[name] = value;
  }
  return result;
}

/**
 * 从 Host 回传的任意 header 集合里挑出验证码证明头。
 *
 * 只放行这两枚：Host 与 CLI 之间走的是同一信任域，但仍不能让渲染进程用任意头覆盖
 * 认证头（例如 Authorization）。大小写不敏感匹配后统一按规范名回写。
 */
export function allowRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = REQUEST_VERIFICATION_HEADERS.find(
      (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
    );
    if (!canonical) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    result[canonical] = trimmed;
  }
  return result;
}

function isRequestVerificationHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return REQUEST_VERIFICATION_HEADERS.some(
    (candidate) => candidate.toLowerCase() === normalized,
  );
}

/**
 * 账号是否需要验证码交互。
 *
 * 契约（见 `contract.test.ts`）：
 *  - 非 `start-plan` 一律不需要；
 *  - `enabled === false` 或 `skipModelRequest === true` 一律不需要；
 *  - 配置缺失（undefined / null）**不隐式放行**，按「需要」处理——
 *    此时上层会去读配置，读不到就报 configInvalid，而不是跳过校验。
 */
export function requiresRequestVerification(
  access: { mode: string } | undefined,
  config?: RequestVerificationConfig | null,
): boolean {
  if (access?.mode !== "start-plan") return false;
  if (config?.enabled === false) return false;
  if (config?.skipModelRequest === true) return false;
  return true;
}

/**
 * 服务端「请完成安全验证」文案判定（中英双语，覆盖 WAF 与业务侧两种措辞）。
 */
export function isRequestVerificationMessage(message: string): boolean {
  return message.includes("请完成安全验证") || /security verification/iu.test(message);
}

/**
 * 出站头诊断摘要：只报「有没有带证明」，绝不报证明内容。
 */
export function summarizeRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  let hasParam = false;
  let hasRegion = false;
  for (const name of Object.keys(headers)) {
    const canonical = REQUEST_VERIFICATION_HEADERS.find(
      (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
    );
    if (canonical === REQUEST_VERIFICATION_HEADER_PARAM) hasParam = true;
    if (canonical === REQUEST_VERIFICATION_HEADER_REGION) hasRegion = true;
  }
  return {
    requestVerificationHeaderKeys: [
      ...(hasParam ? [REQUEST_VERIFICATION_HEADER_PARAM] : []),
      ...(hasRegion ? [REQUEST_VERIFICATION_HEADER_REGION] : []),
    ],
    hasRequestVerificationProof: hasParam,
  };
}

/**
 * 请求校验诊断字段（喂给空流终态与错误归因日志）。
 *
 * 入参可能是 finish chunk、provider metadata 或诊断对象，字段名不统一；
 * 这里只按已知的几种形状做只读探测，不写入任何原始证明内容。
 */
export function requestVerificationDiagnostics(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const headerKeys = readStringArray(input.outboundHeaderKeys) ?? [];
  const normalized = new Set(headerKeys.map((key) => key.trim().toLowerCase()));
  const hasParam = normalized.has(REQUEST_VERIFICATION_HEADER_PARAM.toLowerCase());
  const hasRegion = normalized.has(REQUEST_VERIFICATION_HEADER_REGION.toLowerCase());
  return {
    requestVerificationHeaderKeys: [
      ...(hasParam ? [REQUEST_VERIFICATION_HEADER_PARAM] : []),
      ...(hasRegion ? [REQUEST_VERIFICATION_HEADER_REGION] : []),
    ],
    hasRequestVerificationProof: hasParam,
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 本发行版是否具备验证码交互能力。
 *
 * 开源构建补齐实现后为 true：`RequestSecurityHost` 会挂载阿里云验证码容器，
 * `prepareRequestVerificationClaim` 能真正拉起 SDK 并取得证明。
 * 该常量同时决定 `requiresRequestVerification` 的「配置缺失」分支语义，
 * 因此不能与 Host 实现脱节。
 */
export const requestVerificationInteractionAvailable = true;
