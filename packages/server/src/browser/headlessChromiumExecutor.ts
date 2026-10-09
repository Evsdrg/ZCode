import type { Browser, BrowserContext } from "playwright-core";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserErrorCode,
} from "@zcode/shared";
import { createServiceLogger } from "@zcode/services/node";
import { HeadlessBrowserSession } from "./headlessBrowserSession.js";
import { describeDisallowedBrowserUrl, isAllowedManagedBrowserUrl } from "./browserUrlPolicy.js";
import {
  evaluateExpression,
  handlePlaywrightAction,
  readPageState,
  runElementAction,
  runPageKeyboardAction,
  summarizeTab,
} from "./headlessBrowserCommands.js";

/**
 * 自部署 server 的 Browser Use 执行器：托管 headless Chromium。
 *
 * 浏览器命令是反向请求（agent → interaction/browserExecute → App/Host 执行）。桌面客户端用
 * IAB 执行器；自部署没有，故这里用 playwright-core 起 headless Chromium 顶上。
 * 仅在显式开启时注册（见 entry-http 的 browserControlExecutor 注入点）。
 *
 * 安全边界对齐 CLI 托管后端（选项 a）：收紧下载/用户 tab/历史等能力；导航仅限 http(s)。
 */

const MANAGED_BROWSER_ID = "server-headless-chromium";
const NAVIGATION_TIMEOUT_MS = 15000;

export interface BrowserExecutorListInput {
  sessionId: string;
  workspaceKey: string;
  workspacePath: string;
}

export interface BrowserExecutorExecuteInput extends BrowserExecutorListInput {
  requestId: string;
  browserId?: string;
  browserGeneration?: number;
  command: BrowserCommand;
}

export interface BrowserControlExecutor {
  list(input: BrowserExecutorListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserExecutorExecuteInput): Promise<BrowserCommandResult>;
  shutdown(): Promise<void>;
}

export interface HeadlessChromiumExecutorOptions {
  loadPlaywright?: () => Promise<typeof import("playwright-core")>;
  executablePath?: string;
}

function createDescriptor(generation: number): BrowserBackendDescriptor {
  return {
    id: MANAGED_BROWSER_ID,
    generation,
    type: "cdp",
    name: "ZCode Server Headless Chromium",
    capabilities: { browser: [], tab: [] },
    // 选项 a：沿用 CLI 托管后端的收紧项（无下载/文件选择器/用户 tab/历史/Locator.evaluate）。
    apiSupportOverrides: {
      "BrowserUser.openTabs": false,
      "BrowserUser.history": false,
      "PlaywrightAPI.waitForEvent": false,
      "PlaywrightDownload.path": false,
      "PlaywrightFileChooser.setFiles": false,
      "PlaywrightLocator.downloadMedia": false,
      "PlaywrightLocator.evaluate": false,
      "CUAAPI.downloadMedia": false,
      "DomCUAAPI.downloadMedia": false,
    },
    metadata: { provider: "zcode-server", launchMode: "managed", headless: "true" },
  };
}

export function createHeadlessChromiumExecutor(
  options: HeadlessChromiumExecutorOptions = {},
): BrowserControlExecutor {
  const logger = createServiceLogger("browser-use");
  const loadPlaywright = options.loadPlaywright ?? (() => import("playwright-core"));

  let browser: Browser | undefined;
  let launchPromise: Promise<Browser> | undefined;
  let generation = 1;
  const sessions = new Map<string, HeadlessBrowserSession>();

  async function ensureBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;
    launchPromise ??= (async () => {
      const pw = await loadPlaywright();
      const launched = await pw.chromium.launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      browser = launched;
      logger.info(undefined, "[browser-use] headless Chromium 已启动");
      launched.on("disconnected", () => {
        browser = undefined;
        launchPromise = undefined;
        generation += 1;
        for (const session of sessions.values()) void session.close().catch(() => {});
        sessions.clear();
      });
      return launched;
    })();
    try {
      return await launchPromise;
    } catch (error) {
      launchPromise = undefined;
      throw error;
    }
  }

  async function sessionFor(sessionId: string): Promise<HeadlessBrowserSession> {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const launched = await ensureBrowser();
    const context: BrowserContext = await launched.newContext();
    const session = new HeadlessBrowserSession(context);
    sessions.set(sessionId, session);
    return session;
  }

  async function list(): Promise<BrowserBackendDescriptor[]> {
    try {
      await ensureBrowser();
    } catch (error) {
      logger.warn(undefined, "[browser-use] headless Chromium 不可用", {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    return [createDescriptor(generation)];
  }

  async function execute(input: BrowserExecutorExecuteInput): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    const command = input.command;
    const withMeta = (
      result: Omit<BrowserCommandResult, "elapsedMs" | "meta">,
    ): BrowserCommandResult => ({
      ...result,
      meta: {
        browserUse: true,
        backendType: "cdp",
        browserId: MANAGED_BROWSER_ID,
        browserGeneration: generation,
        openTabIds: sessions.get(input.sessionId)?.tabIds ?? [],
        ...(result.tab ? { tabId: result.tab.tabId, currentUrl: result.tab.url } : {}),
      },
      elapsedMs: Date.now() - startedAt,
    });
    const fail = (code: BrowserErrorCode, message: string): BrowserCommandResult =>
      withMeta({ ok: false, error: { code, message } });

    let session: HeadlessBrowserSession;
    try {
      session = await sessionFor(input.sessionId);
    } catch (error) {
      return fail("backend_unavailable", error instanceof Error ? error.message : String(error));
    }
    try {
      return await dispatch(session, command, withMeta, fail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, "[browser-use] 命令执行失败", { method: command.method, message });
      return fail(command.method === "snapshot" ? "ref_not_found" : "execution_error", message);
    }
  }

  async function dispatch(
    session: HeadlessBrowserSession,
    command: BrowserCommand,
    withMeta: (r: Omit<BrowserCommandResult, "elapsedMs" | "meta">) => BrowserCommandResult,
    fail: (code: BrowserErrorCode, message: string) => BrowserCommandResult,
  ): Promise<BrowserCommandResult> {
    // 导航类命令先做 URL 白名单。
    if (command.method === "navigate") {
      if (!isAllowedManagedBrowserUrl(command.url)) {
        return fail("navigation_blocked", describeDisallowedBrowserUrl(command.url));
      }
      const tab = await session.ensureTab(command.tabId);
      await tab.page.goto(command.url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return withMeta({ ok: true, state: await readPageState(session, tab.page) });
    }
    switch (command.method) {
      case "back":
      case "forward":
      case "reload": {
        const tab = await session.ensureTab(command.tabId);
        const options = { waitUntil: "domcontentloaded" as const, timeout: NAVIGATION_TIMEOUT_MS };
        if (command.method === "back") await tab.page.goBack(options).catch(() => null);
        else if (command.method === "forward") await tab.page.goForward(options).catch(() => null);
        else await tab.page.reload(options).catch(() => null);
        return withMeta({ ok: true, state: await readPageState(session, tab.page) });
      }
      case "getState": {
        const tab = await session.ensureTab(command.tabId);
        return withMeta({ ok: true, state: await readPageState(session, tab.page) });
      }
      case "snapshot": {
        const tab = await session.ensureTab(command.tabId);
        return withMeta({ ok: true, snapshot: await session.snapshot(tab) });
      }
      case "screenshot": {
        const tab = await session.ensureTab(command.tabId);
        const buffer = await tab.page.screenshot({
          ...(command.fullPage ? { fullPage: true } : {}),
          type: "png",
        });
        return withMeta({
          ok: true,
          image: { base64: buffer.toString("base64"), mimeType: "image/png" },
        });
      }
      case "evaluate": {
        const tab = await session.ensureTab(command.tabId);
        return withMeta({ ok: true, value: await evaluateExpression(tab.page, command) });
      }
      case "type":
      case "press": {
        const tab = await session.ensureTab(command.tabId);
        // 带 ref 走元素；不带 ref 走页面级键盘输入。
        if (command.ref) await runElementAction(session, tab, command);
        else await runPageKeyboardAction(tab, command);
        return withMeta({ ok: true });
      }
      case "click":
      case "hover":
      case "fill":
      case "scroll":
      case "select":
      case "check": {
        const tab = await session.ensureTab(command.tabId);
        await runElementAction(session, tab, command);
        return withMeta({ ok: true });
      }
      case "playwright": {
        const tab = await session.ensureTab(command.tabId);
        return withMeta({ ok: true, ...(await handlePlaywrightAction(session, tab, command)) });
      }
      case "newTab": {
        const tab = await session.createTab();
        return withMeta({ ok: true, tab: summarizeTab(session, tab.id) });
      }
      case "list":
        return withMeta({ ok: true, tabs: await session.listTabsWithTitles() });
      case "activateTab": {
        const tab = session.activateTab(command.tabId);
        return withMeta({ ok: true, tab: summarizeTab(session, tab.id) });
      }
      case "close": {
        await session.closeTab(command.tabId);
        return withMeta({ ok: true });
      }
      case "capabilities":
      case "browserVisibilitySet":
      case "browserViewportReset":
      case "turnEnded":
        return withMeta({ ok: true });
      case "browserVisibilityGet":
        return withMeta({ ok: true, value: true });
      case "browserViewportSet": {
        session.setViewport({
          width: Math.round(command.width),
          height: Math.round(command.height),
        });
        return withMeta({ ok: true });
      }
      default:
        return fail("capability_unsupported", `Unsupported browser command: ${command.method}`);
    }
  }

  async function shutdown(): Promise<void> {
    for (const session of sessions.values()) await session.close().catch(() => {});
    sessions.clear();
    await browser?.close().catch(() => {});
    browser = undefined;
    launchPromise = undefined;
  }

  return { list, execute, shutdown };
}
