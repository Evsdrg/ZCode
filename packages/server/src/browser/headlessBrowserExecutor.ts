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
  runCuaKeypress,
  runCuaScroll,
  runDragPath,
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
      case "cuaKeypress": {
        const tab = await session.ensureTab(command.tabId);
        await runCuaKeypress(tab.page, command.keys);
        return withMeta({ ok: true });
      }
      case "cuaScroll": {
        const tab = await session.ensureTab(command.tabId);
        await runCuaScroll(
          tab.page,
          { x: command.x, y: command.y },
          command.scrollX,
          command.scrollY,
        );
        return withMeta({ ok: true });
      }
      case "domCuaScroll": {
        const tab = await session.ensureTab(command.tabId);
        // nodeId 即 snapshot ref；无 ref 时以视口中心为锚点，与 CLI 托管后端语义一致。
        const anchor = command.nodeId
          ? await session.resolveRefCenter(tab, command.nodeId)
          : ((await tab.page.evaluate(
              "({ x: window.innerWidth / 2, y: window.innerHeight / 2 })",
            )) as { x: number; y: number });
        await runCuaScroll(tab.page, anchor, command.scrollX, command.scrollY);
        return withMeta({ ok: true });
      }
      case "drag": {
        const tab = await session.ensureTab(command.tabId);
        const from = await session.resolveRefCenter(
          tab,
          command.fromRef,
          command.from?.x,
          command.from?.y,
        );
        const to = await session.resolveRefCenter(tab, command.toRef, command.to?.x, command.to?.y);
        await runDragPath(tab.page, [from, to]);
        return withMeta({ ok: true });
      }
      case "cuaDrag": {
        const tab = await session.ensureTab(command.tabId);
        await runDragPath(tab.page, command.path);
        return withMeta({ ok: true });
      }
      case "elementInfo": {
        const tab = await session.ensureTab(command.tabId);
        // 语义对齐 CLI 托管后端：取结构化快照后按 rect 命中测试返回单个元素。
        const snapshot = await session.snapshot(tab);
        const element = snapshot.elements.find(
          (item) =>
            command.x >= item.rect.x &&
            command.x <= item.rect.x + item.rect.width &&
            command.y >= item.rect.y &&
            command.y <= item.rect.y + item.rect.height,
        );
        return withMeta({ ok: true, element });
      }
      case "playwrightWaitForTimeout": {
        await new Promise<void>((resolve) => setTimeout(resolve, command.timeoutMs));
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
      case "getDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        const type = dialog?.type();
        return withMeta({
          ok: true,
          dialog:
            dialog && type && ["alert", "confirm", "prompt", "beforeunload"].includes(type)
              ? {
                  type: type as "alert" | "confirm" | "prompt" | "beforeunload",
                  message: dialog.message(),
                  ...(dialog.defaultValue() ? { defaultPrompt: dialog.defaultValue() } : {}),
                }
              : null,
        });
      }
      case "handleDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        if (!dialog) {
          return fail("execution_error", "No JavaScript dialog is pending for this tab");
        }
        if (command.accept) await dialog.accept(command.promptText);
        else await dialog.dismiss();
        session.clearDialog(tab.id);
        return withMeta({ ok: true });
      }
      case "listUserTabs":
        // 托管后端不接管用户标签页；SDK facade 依赖该命令可调用且不报错。
        return withMeta({ ok: true, userTabs: [] });
      case "nameSession":
        // 名称由 Host 会话层管理；与 CLI 托管后端一致返回 ok。
        return withMeta({ ok: true });
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
