import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserErrorCode,
} from "@zcode/shared";
import { createServiceLogger } from "@zcode/services/node";
import type { HeadlessBrowserSession } from "./headlessBrowserSession.js";
import {
  HeadlessBrowserRuntime,
  ManagedBrowserUnavailableError,
  type BrowserExecutorListInput,
  type HeadlessBrowserRuntimeOptions,
} from "./headlessBrowserRuntime.js";
import { describeDisallowedBrowserUrl, isAllowedManagedBrowserUrl } from "./browserUrlPolicy.js";
import {
  evaluateExpression,
  handlePlaywrightAction,
  readPageState,
  runElementAction,
  runPageKeyboardAction,
  summarizeTab,
} from "./headlessBrowserCommands.js";

const NAVIGATION_TIMEOUT_MS = 15000;

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

function createDescriptor(runtime: HeadlessBrowserRuntime): BrowserBackendDescriptor {
  return {
    id: runtime.browserId,
    generation: runtime.generation,
    // 现有 Agent schema 只接受三种类型；Firefox 沿用兼容分类，实际驱动由 metadata 声明。
    type: "cdp",
    name: `ZCode Server Headless ${runtime.engine === "firefox" ? "Firefox" : "Chromium"}`,
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
    metadata: {
      provider: "zcode-server",
      engine: runtime.engine,
      driver: "playwright",
      launchMode: "managed",
      headless: "true",
    },
  };
}

export function createHeadlessBrowserExecutor(
  options: HeadlessBrowserRuntimeOptions = {},
): BrowserControlExecutor {
  const logger = createServiceLogger("browser-use");
  const runtime = new HeadlessBrowserRuntime(options);

  async function list(): Promise<BrowserBackendDescriptor[]> {
    try {
      await runtime.ensureBrowser();
      return [createDescriptor(runtime)];
    } catch (error) {
      logger.warn(undefined, "[browser-use] managed browser unavailable", {
        engine: runtime.engine,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async function execute(input: BrowserExecutorExecuteInput): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    const generation = input.browserGeneration ?? runtime.generation;
    const command = input.command;
    let session: HeadlessBrowserSession | undefined;
    const withMeta = (
      result: Omit<BrowserCommandResult, "elapsedMs" | "meta">,
    ): BrowserCommandResult => ({
      ...result,
      meta: {
        browserUse: true,
        backendType: "cdp",
        browserId: runtime.browserId,
        browserGeneration: generation,
        openTabIds: session?.tabIds ?? [],
        ...(result.tab ? { tabId: result.tab.tabId, currentUrl: result.tab.url } : {}),
      },
      elapsedMs: Date.now() - startedAt,
    });
    const fail = (code: BrowserErrorCode, message: string): BrowserCommandResult =>
      withMeta({ ok: false, error: { code, message } });
    try {
      runtime.assertCurrent(generation, input.browserId);
      session = await runtime.sessionFor(input, generation);
      runtime.assertCurrent(generation, input.browserId);
    } catch (error) {
      return fail("backend_unavailable", error instanceof Error ? error.message : String(error));
    }
    try {
      const result = await dispatch(session, command, withMeta, fail);
      runtime.assertCurrent(generation, input.browserId);
      return result;
    } catch (error) {
      // 修复原因：Playwright 断连通常先抛 Target closed，仍需按 owner 代次判断后端失效。
      try {
        runtime.assertCurrent(generation, input.browserId);
      } catch (unavailable) {
        return fail(
          "backend_unavailable",
          unavailable instanceof Error ? unavailable.message : String(unavailable),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ManagedBrowserUnavailableError)
        return fail("backend_unavailable", message);
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

  return { list, execute, shutdown: () => runtime.shutdown() };
}
