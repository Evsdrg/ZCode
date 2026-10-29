import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Browser } from "playwright-core";
import { createServiceLogger } from "@zcode/services/node";
import { HeadlessBrowserSession } from "./headlessBrowserSession.js";
import type { HeadlessBrowserEngine } from "./headlessBrowserConfig.js";

export interface BrowserExecutorListInput {
  sessionId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export class ManagedBrowserUnavailableError extends Error {}

/** session 空闲多久后回收；10 分钟覆盖常规多轮浏览器任务间隔，仍保留短程复用。 */
export const IDLE_SESSION_TIMEOUT_MS = 10 * 60_000;
/** 最后一个 session 回收后，浏览器进程再保留多久才退出；给"马上还要用"留缓冲。 */
export const IDLE_BROWSER_CLOSE_DELAY_MS = 5 * 60_000;
/** 空闲扫描间隔。 */
export const IDLE_RECLAIM_INTERVAL_MS = 60_000;

interface IdleTrackedSession {
  promise: Promise<HeadlessBrowserSession>;
  /** 创建成功后回填，供 execute 侧按实例反查（避免读非标准的 promise.status）。 */
  resolved?: HeadlessBrowserSession;
  lastUsedAt: number;
  inFlight: number;
}

export interface HeadlessBrowserRuntimeOptions {
  engine?: HeadlessBrowserEngine;
  loadPlaywright?: () => Promise<typeof import("playwright-core")>;
  executablePath?: string;
  /**
   * 自部署：每次新建 Context 时读取「允许不安全证书」设置。桌面端该开关由 Electron main
   * 装到 Session；自部署没有 Electron，托管浏览器在 server 进程里，必须在建 Context 时
   * 把 ignoreHTTPSErrors 传给 Playwright，否则访问自签名/过期证书的内网站点直接失败且无配置入口。
   * 不传时保持 Playwright 默认（严格校验），不影响桌面/旧行为。
   */
  resolveIgnoreHTTPSErrors?: () => Promise<boolean>;
  /** 测试注入时钟与扫描间隔；生产缺省用 Date.now 与 60s。 */
  now?: () => number;
  idleReclaimIntervalMs?: number;
  /** 测试注入可执行文件探测；生产缺省检查文件存在且可执行。 */
  isExecutableAvailable?: (path: string) => Promise<boolean>;
}

async function defaultExecutableAvailable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scopeKey(input: BrowserExecutorListInput): string {
  return JSON.stringify([
    input.workspaceIdentity?.trim() || input.workspaceKey,
    input.remoteSessionId ?? "",
    input.sessionId,
  ]);
}

export class HeadlessBrowserRuntime {
  readonly engine: HeadlessBrowserEngine;
  readonly browserId: string;
  readonly #options: HeadlessBrowserRuntimeOptions;
  // session 记账：promise + lastUsedAt + 在途命令计数。空闲回收只删条目并
  // trackClose，正在执行的（inFlight > 0）顺延，不中断在途命令。
  readonly #sessions = new Map<string, IdleTrackedSession>();
  readonly #closing = new Set<Promise<void>>();
  readonly #closedBrowsers = new WeakSet<Browser>();
  readonly #logger = createServiceLogger("browser-use");
  readonly #now: () => number;
  #browser: Browser | undefined;
  #launchPromise: Promise<Browser> | undefined;
  #generation = 1;
  #disposed = false;
  #shutdownPromise: Promise<void> | undefined;
  /** 最后一个 session 关闭完成的时刻；浏览器进程延迟退出以此为起点。 */
  #browserIdleSince: number | undefined;
  #reclaimTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HeadlessBrowserRuntimeOptions = {}) {
    this.#options = options;
    this.engine = options.engine ?? "chromium";
    this.browserId = `server-headless-${this.engine}`;
    this.#now = options.now ?? Date.now;
    // 长驻 server 没有桌面窗口与 CLI 进程退出两级兜底，空闲资源必须由 owner 主动收敛。
    this.#reclaimTimer = setInterval(
      () => this.reclaimIdle(),
      options.idleReclaimIntervalMs ?? IDLE_RECLAIM_INTERVAL_MS,
    );
    // 扫描器不阻止进程退出。
    this.#reclaimTimer.unref?.();
  }

  /**
   * discovery 用的廉价可用性判断：不拉起进程，只确认 runtime 未关闭、
   * 浏览器可执行文件存在（显式配置路径或 Playwright 缺省安装路径）。
   */
  async isDiscoverable(): Promise<boolean> {
    if (this.#disposed) return false;
    try {
      const path =
        this.#options.executablePath ?? (await this.loadPlaywright())[this.engine].executablePath();
      const check = this.#options.isExecutableAvailable ?? defaultExecutableAvailable;
      return !this.#disposed && (await check(path));
    } catch {
      return false;
    }
  }

  private loadPlaywright(): Promise<typeof import("playwright-core")> {
    return (this.#options.loadPlaywright ?? (() => import("playwright-core")))();
  }

  get generation(): number {
    return this.#generation;
  }

  assertCurrent(generation: number, browserId?: string): void {
    if (
      this.#disposed ||
      generation !== this.#generation ||
      (browserId && browserId !== this.browserId)
    ) {
      throw new ManagedBrowserUnavailableError("Managed browser identity is unavailable or stale");
    }
  }

  async ensureBrowser(): Promise<Browser> {
    this.assertCurrent(this.#generation);
    if (this.#browser?.isConnected()) return this.#browser;
    const generation = this.#generation;
    if (!this.#launchPromise) {
      const pending = this.launch(generation);
      this.#launchPromise = pending;
      void pending
        .finally(() => {
          if (this.#launchPromise === pending) this.#launchPromise = undefined;
        })
        .catch(() => {});
    }
    const browser = await this.#launchPromise;
    this.assertCurrent(generation);
    if (!browser.isConnected())
      throw new ManagedBrowserUnavailableError("Managed browser disconnected");
    return browser;
  }

  private async launch(generation: number): Promise<Browser> {
    const pw = await this.loadPlaywright();
    this.assertCurrent(generation);
    const launched = await pw[this.engine].launch({
      headless: true,
      ...(this.#options.executablePath ? { executablePath: this.#options.executablePath } : {}),
      ...(this.engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
    });
    // 修复原因：shutdown 可能早于 launch 完成，迟到的浏览器必须由同一 owner 回收。
    if (this.#disposed || generation !== this.#generation) {
      await this.closeBrowser(launched);
      throw new ManagedBrowserUnavailableError("Managed browser closed during launch");
    }
    this.#browser = launched;
    launched.on("disconnected", () => {
      if (this.#browser !== launched) return;
      this.#browser = undefined;
      this.#generation += 1;
      for (const entry of this.#sessions.values()) this.trackClose(entry.promise);
      this.#sessions.clear();
    });
    this.#logger.info(undefined, "[browser-use] managed browser started", { engine: this.engine });
    return launched;
  }

  sessionFor(input: BrowserExecutorListInput, generation: number): Promise<HeadlessBrowserSession> {
    this.assertCurrent(generation);
    const key = scopeKey(input);
    const existing = this.#sessions.get(key);
    if (existing) {
      existing.lastUsedAt = this.#now();
      return existing.promise;
    }
    const pending = this.createSession(generation);
    const entry: IdleTrackedSession = { promise: pending, lastUsedAt: this.#now(), inFlight: 0 };
    this.#sessions.set(key, entry);
    void pending.then(
      (session) => {
        entry.resolved = session;
      },
      () => {
        const current = this.#sessions.get(key);
        if (current && current.promise === pending) this.#sessions.delete(key);
      },
    );
    return pending;
  }

  /** executor 在命令执行期间调用：在途计数 +1，返回减 1 的收尾函数。 */
  trackSessionActivityByInstance(session: HeadlessBrowserSession): () => void {
    for (const entry of this.#sessions.values()) {
      if (entry.resolved === session) return this.trackEntry(entry);
    }
    // session 已不在注册表（刚被回收/断连）：命令本身会在后续断言失败，无需记账。
    return () => {};
  }

  trackSessionActivity(promise: Promise<HeadlessBrowserSession>): () => void {
    for (const entry of this.#sessions.values()) {
      if (entry.promise === promise) return this.trackEntry(entry);
    }
    return () => {};
  }

  private trackEntry(entry: IdleTrackedSession): () => void {
    entry.inFlight += 1;
    entry.lastUsedAt = this.#now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.inFlight -= 1;
    };
  }

  /**
   * 空闲回收：关掉超时空闲且无在途命令的 session；session 全部回收后，
   * 浏览器进程再延迟 IDLE_BROWSER_CLOSE_DELAY_MS 退出。任何 execute 都会
   * 重置 #browserIdleSince（session 复用即活跃）。
   */
  reclaimIdle(): void {
    if (this.#disposed) return;
    const now = this.#now();
    let removedAny = false;
    for (const [key, entry] of this.#sessions) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastUsedAt < IDLE_SESSION_TIMEOUT_MS) continue;
      this.#sessions.delete(key);
      this.trackClose(entry.promise);
      removedAny = true;
      this.#logger.info(undefined, "[browser-use] idle session reclaimed", {
        engine: this.engine,
        idleMs: now - entry.lastUsedAt,
      });
    }
    if (this.#sessions.size > 0 || this.#launchPromise !== undefined) {
      this.#browserIdleSince = undefined;
      return;
    }
    if (removedAny || this.#browserIdleSince === undefined) {
      // 最后一个 session 刚被回收（或浏览器刚闲置），从现在起算浏览器退出延迟。
      this.#browserIdleSince = now;
      return;
    }
    if (now - this.#browserIdleSince < IDLE_BROWSER_CLOSE_DELAY_MS) return;
    if (!this.#browser) return;
    this.#logger.info(undefined, "[browser-use] idle browser closed", {
      engine: this.engine,
      idleMs: now - this.#browserIdleSince,
    });
    // 等在途关闭收尾后关进程；不置 #disposed，下次 execute 透明重启。
    // 不 bump generation：此时所有 session 已回收，没有旧 Context/tab 能漂移到新进程
    // （tabId 随 session 销毁，旧 tabId 自然报 unavailable）；bump 只会让模型缓存的
    // browser wrapper 无故 stale、多一次 backend_unavailable。断连路径仍照常 bump。
    const browser = this.#browser;
    this.#browser = undefined;
    this.#browserIdleSince = undefined;
    const pendingSessionCloses = Promise.allSettled(this.#closing);
    // 登记进 #closing，让并发的 shutdown() 也等这台进程退出。
    const closing = pendingSessionCloses.then(() => this.closeBrowser(browser));
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing));
  }

  private async createSession(generation: number): Promise<HeadlessBrowserSession> {
    const browser = await this.ensureBrowser();
    this.assertCurrent(generation);
    // 修复原因：自部署托管浏览器没有 Electron Session 承载证书策略，ignoreHTTPSErrors
    // 只能在每个 Context 上设置。读取失败按严格校验处理（fail-closed），不向调用方抛错。
    const ignoreHTTPSErrors = this.#options.resolveIgnoreHTTPSErrors
      ? await this.#options.resolveIgnoreHTTPSErrors().catch(() => false)
      : undefined;
    const context = await browser.newContext(
      ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors },
    );
    // 修复原因：Context 创建是异步的，断连或关闭后的结果不能进入新代次注册表。
    if (this.#disposed || generation !== this.#generation || !browser.isConnected()) {
      await context.close().catch(() => {});
      throw new ManagedBrowserUnavailableError("Managed browser closed during context creation");
    }
    return new HeadlessBrowserSession(context);
  }

  private trackClose(pending: Promise<HeadlessBrowserSession>): void {
    const closing = pending
      .then((session) => session.close())
      .catch(() => {})
      .finally(() => {
        // 关闭收尾后若已无任何 session，浏览器开始进入闲置计时。
        if (this.#sessions.size === 0 && this.#browserIdleSince === undefined) {
          this.#browserIdleSince = this.#now();
        }
      });
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing));
  }

  private async closeBrowser(browser: Browser): Promise<void> {
    if (this.#closedBrowsers.has(browser)) return;
    this.#closedBrowsers.add(browser);
    await browser.close().catch(() => {});
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#disposed = true;
    if (this.#reclaimTimer) {
      clearInterval(this.#reclaimTimer);
      this.#reclaimTimer = undefined;
    }
    this.#shutdownPromise = (async () => {
      for (const entry of this.#sessions.values()) this.trackClose(entry.promise);
      this.#sessions.clear();
      await Promise.allSettled([this.#launchPromise, ...this.#closing]);
      const browser = this.#browser;
      this.#browser = undefined;
      if (browser) await this.closeBrowser(browser);
    })();
    return this.#shutdownPromise;
  }
}
