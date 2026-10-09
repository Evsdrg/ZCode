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

export interface HeadlessBrowserRuntimeOptions {
  engine?: HeadlessBrowserEngine;
  loadPlaywright?: () => Promise<typeof import("playwright-core")>;
  executablePath?: string;
}

export class ManagedBrowserUnavailableError extends Error {}

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
  readonly #sessions = new Map<string, Promise<HeadlessBrowserSession>>();
  readonly #closing = new Set<Promise<void>>();
  readonly #closedBrowsers = new WeakSet<Browser>();
  readonly #logger = createServiceLogger("browser-use");
  #browser: Browser | undefined;
  #launchPromise: Promise<Browser> | undefined;
  #generation = 1;
  #disposed = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(options: HeadlessBrowserRuntimeOptions) {
    this.#options = options;
    this.engine = options.engine ?? "chromium";
    this.browserId = `server-headless-${this.engine}`;
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
    const load = this.#options.loadPlaywright ?? (() => import("playwright-core"));
    const pw = await load();
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
      for (const pending of this.#sessions.values()) this.trackClose(pending);
      this.#sessions.clear();
    });
    this.#logger.info(undefined, "[browser-use] managed browser started", { engine: this.engine });
    return launched;
  }

  sessionFor(input: BrowserExecutorListInput, generation: number): Promise<HeadlessBrowserSession> {
    this.assertCurrent(generation);
    const key = scopeKey(input);
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const pending = this.createSession(generation);
    this.#sessions.set(key, pending);
    void pending.catch(() => {
      if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
    });
    return pending;
  }

  private async createSession(generation: number): Promise<HeadlessBrowserSession> {
    const browser = await this.ensureBrowser();
    this.assertCurrent(generation);
    const context = await browser.newContext();
    // 修复原因：Context 创建是异步的，断连或关闭后的结果不能进入新代次注册表。
    if (this.#disposed || generation !== this.#generation || !browser.isConnected()) {
      await context.close().catch(() => {});
      throw new ManagedBrowserUnavailableError("Managed browser closed during context creation");
    }
    return new HeadlessBrowserSession(context);
  }

  private trackClose(pending: Promise<HeadlessBrowserSession>): void {
    const closing = pending.then((session) => session.close()).catch(() => {});
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
    this.#shutdownPromise = (async () => {
      for (const pending of this.#sessions.values()) this.trackClose(pending);
      this.#sessions.clear();
      await Promise.allSettled([this.#launchPromise, ...this.#closing]);
      const browser = this.#browser;
      this.#browser = undefined;
      if (browser) await this.closeBrowser(browser);
    })();
    return this.#shutdownPromise;
  }
}
