/**
 * 阿里云验证码（zcode-plan 请求校验）的 UI 侧封装。
 *
 * 参考实现来自官方闭源发行版，这里按同一套服务端契约重新实现，不依赖任何私有密钥：
 *  - SDK 由公开 CDN 提供：`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
 *  - `SceneId` / `region` / `prefix` 全部来自服务端下发的 `configs.captcha`
 *  - 成功后拿到 `captchaVerifyParam`，由调用方放进 `X-Aliyun-Captcha-Verify-Param` 头
 *
 * 本模块只负责「拉起 SDK → 让用户完成校验 → 返回证明」；是否该校验由
 * `@zcode/shared` 的 `requiresRequestVerification` 决定，错误展示在各调用点。
 */
import type { RequestVerificationConfig, RequestVerificationProof } from "@zcode/shared";

import type { RequestVerificationConfigSource } from "./contract.js";
import { useEffect, useRef } from "react";

import { useServices } from "@/hooks/useServices.js";

/** 阿里云验证码 SDK 的公开入口。区域不同但入口一致，区域信息由 `AliyunCaptchaConfig.region` 给出。 */
const CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

/** SDK 初始化/脚本加载超时：超过这个时间认为 SDK 不可用，不再无限等待。 */
const CAPTCHA_INIT_TIMEOUT_MS = 10_000;
/** 用户完成验证的总时限。留足时间给弹窗交互，但不至于让请求永久挂起。 */
const CAPTCHA_VERIFY_TIMEOUT_MS = 120_000;
/** 脚本加载完成后稍等再拉起实例：SDK 内部还有异步初始化，立即调用可能拿到未就绪实例。 */
const CAPTCHA_TRIGGER_DELAY_MS = 2_000;
/** 配置快照缓存时间：同一轮交互里不要为同一份配置反复打远端。 */
const CONFIG_CACHE_TTL_MS = 60_000;

/** Host 容器与 SDK 挂载点的固定 id（SDK 按选择器查找，不能随组件重命名）。 */
export const CAPTCHA_CONTAINER_ID = "zcode-aliyun-captcha-container";
export const CAPTCHA_ELEMENT_ID = "zcode-aliyun-captcha-element";
export const CAPTCHA_BUTTON_ID = "zcode-aliyun-captcha-button";

interface AliyunCaptchaInstance {
  show?: () => void;
  startTracelessVerification?: () => void;
}

interface AliyunCaptchaInitOptions {
  SceneId: string;
  region?: string;
  prefix?: string;
  mode?: "popup" | "embed" | "inline";
  language?: string;
  showErrorTip?: boolean;
  element: string;
  button: string;
  getInstance?: (instance: AliyunCaptchaInstance) => void;
  success?: (captchaVerifyParam: string) => void;
  fail?: (result: unknown) => void;
  onError?: (error: unknown) => void;
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: AliyunCaptchaInitOptions) => void;
    AliyunCaptchaConfig?: { region?: string; prefix?: string };
  }
}

/** SDK 回调载荷里可能出现的字段（不同版本大小写不一致，逐个探测）。 */
interface CaptchaSdkResult {
  success?: boolean;
  verifyResult?: boolean;
  verifyCode?: string;
  VerifyCode?: string;
  captchaVerifyParam?: string;
  CaptchaVerifyParam?: string;
}

function readSdkResult(value: unknown): CaptchaSdkResult | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const verifyCode =
    typeof source.verifyCode === "string"
      ? source.verifyCode
      : typeof source.VerifyCode === "string"
        ? source.VerifyCode
        : undefined;
  return {
    success: typeof source.success === "boolean" ? source.success : undefined,
    verifyResult: typeof source.verifyResult === "boolean" ? source.verifyResult : undefined,
    verifyCode,
    VerifyCode: typeof source.VerifyCode === "string" ? source.VerifyCode : undefined,
    captchaVerifyParam:
      typeof source.captchaVerifyParam === "string" ? source.captchaVerifyParam : undefined,
    CaptchaVerifyParam:
      typeof source.CaptchaVerifyParam === "string" ? source.CaptchaVerifyParam : undefined,
  };
}

function readCaptchaParam(value: unknown): string | undefined {
  const result = readSdkResult(value);
  const param = result?.captchaVerifyParam ?? result?.CaptchaVerifyParam;
  return param?.trim() || undefined;
}

/** `T006` 表示服务端判定校验已通过（即使 SDK 回调走的是 fail 分支）。 */
function isTerminalPass(value: unknown): boolean {
  const result = readSdkResult(value);
  if (!result) return false;
  return result.verifyCode === "T006";
}

/** `F008` 表示同一份证明被重复提交。需要重新验证，不能复用。 */
function isDuplicateSubmission(value: unknown): boolean {
  return readSdkResult(value)?.verifyCode === "F008";
}

/** SDK 明确返回「需要升级/暂不可交互」：此时不应立刻 reject，等 success 回调兜底。 */
function isAwaitingUpgrade(value: unknown): boolean {
  const result = readSdkResult(value);
  if (!result) return false;
  return (
    result.success === true &&
    result.verifyResult === false &&
    (!result.verifyCode || result.verifyCode === "F015")
  );
}

/**
 * 验证码不可交互（例如当前环境无法展示弹窗）时的专用错误。
 *
 * 与普通失败区分：调用方据此决定是提示用户重试还是降级为「无法完成校验」。
 */
export class CaptchaInteractiveRequiredError extends Error {
  readonly code = "CAPTCHA_INTERACTIVE_REQUIRED";
  constructor(message = "Captcha requires interactive verification.") {
    super(message);
    this.name = "CaptchaInteractiveRequiredError";
  }
}

let scriptLoadPromise: Promise<void> | null = null;
let scriptLoadedAt = 0;

/** 已初始化的 SDK 控制器（同一份配置复用，配置变化则重建）。 */
interface CaptchaController {
  configKey: string;
  instance: AliyunCaptchaInstance;
  buttonElement: HTMLButtonElement;
  buttonSelector: string;
}

let controller: CaptchaController | null = null;
/** 初始化中的控制器：SDK 的 `initAliyunCaptcha` 是异步回填实例的。 */
let initializing: {
  configKey: string;
  completion: Promise<void>;
  drain?: Promise<void>;
} | null = null;

/** 当前等待结果的 pending（同一时刻只允许一次验证）。 */
interface PendingVerification {
  resolve: (param: string) => void;
  reject: (error: unknown) => void;
  allowInteractive: boolean;
  awaitingDeferredSdkSuccess?: boolean;
  handleDeferredFail?: (result: unknown) => void;
}

let pending: PendingVerification | null = null;
let verificationInProgress = false;

function resetController(): void {
  pending = null;
  controller = null;
  if (typeof document !== "undefined") {
    document.getElementById(CAPTCHA_ELEMENT_ID)?.replaceChildren();
  }
}

function loadCaptchaScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("Captcha requires browser environment."));
      return;
    }
    // 已注入但 initAliyunCaptcha 尚不可用（例如上次加载到一半）：直接当成就绪，
    // 由后续 init 调用自行判断。
    if (typeof window.initAliyunCaptcha === "function") {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CAPTCHA_SDK_URL}"]`);
    const onError = (element: HTMLScriptElement): void => {
      element.remove();
      reject(new Error("Failed to load captcha script."));
    };
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => onError(existing), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = CAPTCHA_SDK_URL;
    script.async = true;
    script.onload = () => {
      scriptLoadedAt = Date.now();
      resolve();
    };
    script.onerror = () => onError(script);
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptLoadPromise = null;
    throw error;
  });
  return scriptLoadPromise;
}

function readCaptchaHostElements(): {
  containerElement: HTMLElement;
  mountElement: HTMLElement;
  buttonElement: HTMLButtonElement;
} {
  const containerElement = document.getElementById(CAPTCHA_CONTAINER_ID);
  const mountElement = document.getElementById(CAPTCHA_ELEMENT_ID);
  const buttonElement = document.getElementById(CAPTCHA_BUTTON_ID);
  if (!(containerElement instanceof HTMLElement)) {
    throw new Error("Captcha host container is not mounted.");
  }
  if (!(mountElement instanceof HTMLElement)) {
    throw new Error("Captcha host element is not mounted.");
  }
  if (!(buttonElement instanceof HTMLButtonElement)) {
    throw new Error("Captcha host button is not mounted.");
  }
  return { containerElement, mountElement, buttonElement };
}

function resolveConfigKey(config: RequestVerificationConfig): string {
  return [config.region, config.prefix, config.sceneId, "popup"].join("::");
}

function isControllerUsable(instance: CaptchaController | null): boolean {
  if (!instance) return false;
  // 实例有 2 分钟生命周期上限：过旧的实例可能已被 SDK 内部销毁，重建更稳妥。
  return Date.now() - scriptLoadedAt < 2 * 60 * 1000;
}

function createController(
  config: RequestVerificationConfig,
  onReady: (controller: CaptchaController) => void,
): { configKey: string; instancePromise: Promise<AliyunCaptchaInstance> } {
  const configKey = resolveConfigKey(config);
  const { buttonElement } = readCaptchaHostElements();
  const buttonSelector = `#${CAPTCHA_BUTTON_ID}`;
  let resolveInstance: (instance: AliyunCaptchaInstance) => void = () => {};
  let rejectInstance: (error: unknown) => void = () => {};
  const instancePromise = new Promise<AliyunCaptchaInstance>((resolve, reject) => {
    resolveInstance = resolve;
    rejectInstance = reject;
  });
  const entry: CaptchaController = {
    configKey,
    instance: null as unknown as AliyunCaptchaInstance,
    buttonElement,
    buttonSelector,
  };
  let settled = false;
  const failOnce = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectInstance(error);
  };
  const completion = new Promise<void>((resolve) => {
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = window.setTimeout(() => {
      failOnce(
        new Error(
          "Captcha initialization timed out. Please restart the app or reload the page and try again.",
        ),
      );
      settle();
    }, CAPTCHA_INIT_TIMEOUT_MS);
    const init = window.initAliyunCaptcha;
    if (typeof init !== "function") {
      window.clearTimeout(timeout);
      failOnce(new Error("Captcha SDK is unavailable."));
      settle();
      return;
    }
    window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
    try {
      init({
        SceneId: config.sceneId ?? "",
        region: config.region,
        prefix: config.prefix,
        mode: "popup",
        language: resolveCaptchaLanguage(),
        showErrorTip: false,
        element: `#${CAPTCHA_ELEMENT_ID}`,
        button: buttonSelector,
        getInstance: (instance) => {
          window.clearTimeout(timeout);
          entry.instance = instance;
          onReady(entry);
          resolveInstance(instance);
          settle();
        },
        success: (captchaVerifyParam) => {
          const value = captchaVerifyParam?.trim();
          if (!value) return;
          const current = pending;
          pending = null;
          current?.resolve(value);
        },
        fail: (result) => {
          handleSdkFail(result, failOnce);
        },
        onError: (error) => {
          if (pending && !pending.allowInteractive) {
            pending.reject(new CaptchaInteractiveRequiredError());
            pending = null;
            return;
          }
          pending?.reject(error ?? new Error("Captcha errored."));
          pending = null;
          failOnce(error);
        },
      });
    } catch (error) {
      window.clearTimeout(timeout);
      failOnce(error);
      settle();
    }
  });
  void completion;
  return { configKey, instancePromise };
}

/**
 * SDK 失败回调的统一处理。
 *
 * 关键分支（都来自服务端/SDK 的真实行为）：
 *  - `T006`：判定通过但走 fail 通道，若带 param 直接成功；
 *  - `F008`：重复提交，必须重新验证；
 *  - `F015`/`success && !verifyResult`：SDK 还在等后续 success，占住 pending 不 reject；
 *  - 其余：真实失败。
 */
function handleSdkFail(result: unknown, failInitialization: (error: unknown) => void): void {
  if (isDuplicateSubmission(result)) {
    const current = pending;
    pending = null;
    resetController();
    current?.reject(new Error("Captcha verification data was already submitted."));
    return;
  }
  if (isTerminalPass(result)) {
    const param = readCaptchaParam(result);
    const current = pending;
    pending = null;
    if (param) {
      current?.resolve(param);
      return;
    }
    if (current) current.awaitingDeferredSdkSuccess = true;
    return;
  }
  if (isAwaitingUpgrade(result)) {
    const current = pending;
    if (!current) {
      failInitialization(new CaptchaInteractiveRequiredError());
      return;
    }
    if (!current.allowInteractive) {
      pending = null;
      current.reject(new CaptchaInteractiveRequiredError());
      return;
    }
    current.awaitingDeferredSdkSuccess = true;
    current.handleDeferredFail?.(result);
    return;
  }
  const current = pending;
  pending = null;
  if (current && !current.allowInteractive) {
    current.reject(new CaptchaInteractiveRequiredError());
    return;
  }
  current?.reject(result ?? new Error("Captcha failed."));
  failInitialization(result);
}

function resolveCaptchaLanguage(): string {
  if (typeof localStorage === "undefined") return "en";
  const preference = localStorage.getItem("zcode-locale-preference");
  if (preference === "zh-CN") return "cn";
  if (preference === "en-US") return "en";
  const navigatorLanguage =
    typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return navigatorLanguage.startsWith("zh") ? "cn" : "en";
}

async function drainPendingInitialization(signal?: AbortSignal): Promise<void> {
  while (initializing) {
    const current = initializing;
    current.drain ??= new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(
          new Error(
            "Captcha initialization timed out. Please restart the app or reload the page and try again.",
          ),
        );
      }, CAPTCHA_INIT_TIMEOUT_MS);
      current.completion.then(() => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
    await withAbort(current.drain, signal);
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return withAbort(
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    }),
    signal,
  );
}

/**
 * 确保 SDK 与实例就绪。
 *
 * 与闭源实现同构：同一份配置复用实例；配置变化或实例过期则重建；
 * 初始化期间的并发调用排队等待，不会重复 init。
 */
async function ensureController(
  config: RequestVerificationConfig,
  signal?: AbortSignal,
): Promise<CaptchaController | null> {
  signal?.throwIfAborted();
  const configKey = resolveConfigKey(config);
  if (controller && controller.configKey === configKey && isControllerUsable(controller)) {
    return controller;
  }
  if (controller) resetController();
  if (initializing) {
    await drainPendingInitialization(signal);
    if (controller && controller.configKey === configKey) return controller;
  }
  if (!config.region || !config.prefix || !config.sceneId) {
    throw new Error("Request verification configuration is invalid");
  }
  let readyController: CaptchaController | null = null;
  const created = createController(config, (value) => {
    readyController = value;
    controller = value;
  });
  initializing = {
    configKey: created.configKey,
    completion: created.instancePromise.then(
      () => undefined,
      () => undefined,
    ),
  };
  try {
    window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
    await withAbort(loadCaptchaScript(), signal);
    await withAbort(created.instancePromise, signal);
    return readyController ?? controller;
  } finally {
    initializing = null;
  }
}

/** 单次验证的入口：串行执行，避免 SDK 的全局 pending 被并发覆盖。 */
let verificationQueue: Promise<unknown> = Promise.resolve();

async function runVerification(
  config: RequestVerificationConfig,
  options: { signal?: AbortSignal; onInteractiveChallenge?: () => void },
): Promise<string> {
  const { signal } = options;
  signal?.throwIfAborted();
  const ready = await ensureController(config, signal);
  signal?.throwIfAborted();
  if (!ready) throw new Error("Captcha SDK is unavailable.");
  // SDK 内部初始化有余量，触发前稍等，避免拿到尚未 completed 的实例。
  if (scriptLoadedAt > 0 && Date.now() - scriptLoadedAt < CAPTCHA_TRIGGER_DELAY_MS) {
    await delay(CAPTCHA_TRIGGER_DELAY_MS - (Date.now() - scriptLoadedAt), signal);
  }
  signal?.throwIfAborted();
  const instance = ready.instance;
  const paramPromise = new Promise<string>((resolve, reject) => {
    pending = {
      resolve,
      reject,
      allowInteractive: true,
      handleDeferredFail: () => options.onInteractiveChallenge?.(),
    };
    try {
      // 交互式弹窗：点击绑定按钮由 SDK 负责弹出，用户完成校验后走 success 回调。
      options.onInteractiveChallenge?.();
      ready.buttonElement.click();
    } catch (error) {
      pending = null;
      reject(error);
    }
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = window.setTimeout(() => {
      const current = pending;
      pending = null;
      reject(new Error(`Captcha verification timed out after ${CAPTCHA_VERIFY_TIMEOUT_MS}ms.`));
      void current;
    }, CAPTCHA_VERIFY_TIMEOUT_MS);
    // 成功/失败时清掉计时器，避免页面长期持有定时器。
    void paramPromise.finally(() => window.clearTimeout(timer)).catch(() => {});
  });
  try {
    return await withAbort(Promise.race([paramPromise, timeoutPromise]), signal);
  } finally {
    pending = null;
    verificationInProgress = false;
  }
}

/**
 * 读取配置（带短缓存）。
 *
 * 用缓存而不是每次都打远端：一次「点击领取」会连续读 2~3 次配置，
 * 每次都打远端既慢又会放大会话首屏的请求量。
 */
let configCache: { value: RequestVerificationConfig | null; expiresAt: number } | null = null;

async function readConfigCached(
  service: RequestVerificationConfigSource,
): Promise<RequestVerificationConfig | null> {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) return configCache.value;
  const value = await service.getRequestVerificationConfig();
  configCache = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return value;
}

function isConfigChallengeable(
  config: RequestVerificationConfig | null,
): config is RequestVerificationConfig {
  if (!config) return false;
  if (config.enabled === false) return false;
  return Boolean(config.region && config.prefix && config.sceneId);
}

/**
 * 走一次完整验证，返回 `captchaVerifyParam`。
 *
 * 配置缺失/关闭时返回 `undefined`（调用方据此提示失败），而不是静默放行：
 * 领取接口没有证明就会被 WAF 拦，静默放行只会把「配置问题」变成「网络错误」。
 */
async function verifyRequestChallenge(
  service: RequestVerificationConfigSource,
  options: { signal?: AbortSignal; onInteractiveChallenge?: () => void } = {},
): Promise<string | undefined> {
  const config = await readConfigCached(service);
  if (!isConfigChallengeable(config)) return undefined;
  if (verificationInProgress) throw new Error("Captcha verification is already in progress.");
  verificationInProgress = true;
  const run = verificationQueue.then(async () => runVerification(config, options));
  // 队列不能因为一次失败就断掉，后续验证仍要能排队。
  verificationQueue = run.catch(() => undefined);
  return run;
}

/**
 * 领取套餐前的验证码准备。
 *
 * 返回 `{ captchaVerifyParam, captchaRegion }` 直接展开进 `claimManualPlan` 请求；
 * 返回 `undefined` 表示没有拿到证明（配置缺失或用户未完成校验），调用方按失败处理。
 */
export async function prepareRequestVerificationClaim(
  service: RequestVerificationConfigSource,
  signal: AbortSignal,
  onVerifying: () => void,
): Promise<RequestVerificationProof | undefined> {
  onVerifying();
  const config = await readConfigCached(service);
  signal.throwIfAborted();
  const param = await verifyRequestChallenge(service, { signal });
  signal.throwIfAborted();
  if (!param) return undefined;
  return {
    captchaVerifyParam: param,
    ...(config?.region ? { captchaRegion: config.region } : {}),
  };
}

/**
 * 页面可见时预加载验证码 SDK。
 *
 * 预加载只做「下载脚本 + 初始化实例」，不会弹窗；用户真正点击时能省掉 1~2 秒白屏等待。
 * 失败静默：预加载失败不影响后续点击（点击时会重新尝试）。
 */
export function useRequestVerificationPrewarm(visible: boolean): void {
  const services = useServices();
  const triggeredRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      triggeredRef.current = false;
      return;
    }
    let cancelled = false;
    const prewarm = (): void => {
      if (cancelled || triggeredRef.current) return;
      if (document.visibilityState === "hidden") return;
      triggeredRef.current = true;
      void (async () => {
        try {
          const config = await readConfigCached(services.codingPlanSubscriptionService);
          if (!isConfigChallengeable(config)) return;
          await ensureController(config);
        } catch {
          // 预加载失败静默：点击时会重新走完整链路。
        }
      })();
    };
    prewarm();
    document.addEventListener("visibilitychange", prewarm);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", prewarm);
    };
  }, [services.codingPlanSubscriptionService, visible]);
}
