import type { ElementHandle, Page } from "playwright-core";
import type { BrowserCommand, BrowserPageState, BrowserTabSummary } from "@zcode/shared";
import type { HeadlessBrowserSession } from "./headlessBrowserSession.js";

/**
 * 浏览器命令的具体执行helpers（从执行器拆出，避免单文件超限）。
 * 全部基于 Playwright 的 ElementHandle / Page / Mouse API，不依赖 CDP。
 */

export const DEFAULT_COMMAND_TIMEOUT_MS = 3000;

export interface ManagedTabRef {
  id: string;
  page: Page;
}

export async function readPageState(
  session: HeadlessBrowserSession,
  page: Page,
): Promise<BrowserPageState> {
  const scroll = (await page
    .evaluate("({ x: window.scrollX, y: window.scrollY })")
    .catch(() => ({ x: 0, y: 0 }))) as { x: number; y: number };
  const viewport = page.viewportSize() ?? session.viewport;
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    canGoBack: false,
    canGoForward: false,
    scrollX: scroll.x,
    scrollY: scroll.y,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

export function summarizeTab(session: HeadlessBrowserSession, tabId: string): BrowserTabSummary {
  return (
    session.listTabs().find((item) => item.tabId === tabId) ?? {
      tabId,
      url: "",
      title: "",
      viewport: session.viewport,
      active: false,
    }
  );
}

export async function evaluateExpression(
  page: Page,
  command: { expression?: string; expressionKind?: "string" | "function"; arg?: unknown },
): Promise<unknown> {
  if (!command.expression) return undefined;
  const source =
    command.expressionKind === "function"
      ? `(${command.expression})(${JSON.stringify(command.arg)})`
      : command.expression;
  return page.evaluate(source);
}

/** ref 命中元素时返回 ElementHandle；提供坐标时返回坐标，供鼠标 API 使用。 */
async function resolveTarget(
  session: HeadlessBrowserSession,
  tab: ManagedTabRef,
  ref?: string,
  x?: number,
  y?: number,
): Promise<{ kind: "element"; handle: ElementHandle } | { kind: "point"; x: number; y: number }> {
  if (ref) {
    return { kind: "element", handle: await session.resolveRef(tab as never, ref) };
  }
  if (typeof x === "number" && typeof y === "number") {
    return { kind: "point", x, y };
  }
  throw new Error("Browser action requires a ref or x/y coordinates");
}

/**
 * 指针/键盘/表单类的元素动作统一入口（click/hover/fill/type/press/scroll/select/check）。
 * 使用 ElementHandle 原生方法（不含 Locator 专有的 pressSequentially）。
 */
export async function runElementAction(
  session: HeadlessBrowserSession,
  tab: ManagedTabRef,
  command: BrowserCommand,
): Promise<void> {
  const timeout = DEFAULT_COMMAND_TIMEOUT_MS;
  const ref = (command as { ref?: string }).ref;
  const x = (command as { x?: number }).x;
  const y = (command as { y?: number }).y;
  const target = await resolveTarget(session, tab, ref, x, y);

  if (target.kind === "point") {
    switch (command.method) {
      case "click":
        await session.runInputAction(tab, (page) => page.mouse.click(target.x, target.y));
        return;
      case "hover":
        await tab.page.mouse.move(target.x, target.y);
        return;
      case "scroll":
        await tab.page.mouse.move(target.x, target.y);
        await tab.page.mouse.wheel(0, tab.page.viewportSize()?.height ?? 720);
        return;
      default:
        throw new Error(`Command ${command.method} requires an element ref`);
    }
  }

  const handle = target.handle;
  switch (command.method) {
    case "click":
    case "hover": {
      // Bug 原因：ElementHandle.click/hover 会等待 actionability，页面弹 JS 对话框时
      // click 永久挂起（命令层无法先返回再 handleDialog）。对齐 CLI 托管后端：
      // 解析元素中心坐标后走 mouse API，命令立即返回，对话框由 getDialog/handleDialog 处理。
      const rect = await handle.boundingBox();
      if (!rect) throw new Error("Element has no bounding box; take a fresh snapshot");
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (command.method === "click")
        await session.runInputAction(tab, (page) => page.mouse.click(x, y));
      else await tab.page.mouse.move(x, y);
      return;
    }
    case "fill":
      await handle.fill((command as { value: string }).value, { timeout });
      return;
    case "type":
      await handle.type((command as { text: string }).text, { timeout });
      return;
    case "press":
      await handle.press((command as { key: string }).key, { timeout });
      return;
    case "select":
      await handle.selectOption((command as { values: string[] }).values, { timeout });
      return;
    case "check":
      if ((command as { checked?: boolean }).checked === false) await handle.uncheck({ timeout });
      else await handle.check({ timeout });
      return;
    case "scroll":
      await handle.scrollIntoViewIfNeeded({ timeout });
      return;
    default:
      throw new Error(`Unsupported element action: ${command.method}`);
  }
}

/** type/press 未带 ref 时的页面级键盘输入。 */
export async function runPageKeyboardAction(
  tab: ManagedTabRef,
  command: BrowserCommand,
): Promise<void> {
  if (command.method === "type") await tab.page.keyboard.type((command as { text: string }).text);
  else if (command.method === "press")
    await tab.page.keyboard.press((command as { key: string }).key);
}

function normalizedModifier(key: string): string {
  if (key === "ControlOrMeta") return process.platform === "darwin" ? "Meta" : "Control";
  return key;
}

/** cuaKeypress：keys 是一组组合键（如 ["Control","a"]），末位是主键，其余是修饰键。 */
export async function runCuaKeypress(page: Page, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const normalized = keys.map(normalizedModifier);
  const modifiers = normalized.slice(0, -1);
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    await page.keyboard.press(normalized.at(-1) ?? "");
  } finally {
    for (const key of modifiers.reverse()) await page.keyboard.up(key);
  }
}

/** cuaScroll：移动到锚点后滚轮。 */
export async function runCuaScroll(
  page: Page,
  anchor: { x: number; y: number },
  scrollX: number,
  scrollY: number,
): Promise<void> {
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(scrollX, scrollY);
}

/** drag 通用体：按下后沿路径逐点移动（steps=4 平滑），finally 保证抬起。 */
export async function runDragPath(
  page: Page,
  path: ReadonlyArray<{ x: number; y: number }>,
): Promise<void> {
  if (path.length === 0) throw new Error("Browser drag requires a non-empty path");
  const [first, ...rest] = path;
  if (!first) throw new Error("Browser drag requires a non-empty path");
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  try {
    for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 4 });
  } finally {
    await page.mouse.up();
  }
}

export async function handlePlaywrightAction(
  session: HeadlessBrowserSession,
  tab: ManagedTabRef,
  command: BrowserCommand,
): Promise<Record<string, unknown>> {
  const action = (command as { action?: { name: string } & Record<string, unknown> }).action;
  if (!action) return {};
  const page = tab.page;
  switch (action.name) {
    case "domSnapshot":
      // 对齐 CLI 托管后端：facade 的 domSnapshot(): Promise<string> 读取 value，
      // 内容是 Playwright 的 AI/ARIA 树（YAML 文本），是定位的唯一真相。
      return {
        value: await page.locator("html").ariaSnapshot({ timeout: DEFAULT_COMMAND_TIMEOUT_MS }),
      };
    case "locator":
      // locator 链由 facade 编码为单条 selector（Playwright 内部引擎语法：
      // internal:role=/internal:text=/internal:testid= 等），这里重建 Locator 并执行操作。
      return runLocatorOperation(
        page,
        action as unknown as { selector: string; operation: string } & Record<string, unknown>,
      );
    case "evaluate":
      return { value: await page.evaluate(String(action.expression ?? "")) };
    case "waitForLoadState": {
      const state =
        (action.state as "load" | "domcontentloaded" | "networkidle") ?? "domcontentloaded";
      await page.waitForLoadState(state === "networkidle" ? "load" : state, {
        timeout: (action.timeoutMs as number) ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
      return {};
    }
    case "waitForURL":
      await page.waitForURL(String(action.url), {
        timeout: (action.timeoutMs as number) ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
      return {};
    default:
      throw new Error(`Unsupported playwright action: ${action.name}`);
  }
}

/** locator 操作的执行体（selector 由 facade 编码，operation 决定行为）。 */
async function runLocatorOperation(
  page: Page,
  action: { selector: string; operation: string } & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeout = (action.timeoutMs as number) ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const locator = page.locator(action.selector);
  switch (action.operation) {
    case "click":
      await locator.click({ timeout, force: action.force as boolean | undefined });
      return {};
    case "dblclick":
      await locator.dblclick({ timeout, force: action.force as boolean | undefined });
      return {};
    case "fill":
      if (action.replace === false)
        await locator.pressSequentially(String(action.value ?? ""), { timeout });
      else await locator.fill(String(action.value ?? ""), { timeout });
      return {};
    case "press":
      await locator.press(String(action.value ?? ""), { timeout });
      return {};
    case "selectOption":
      await locator.selectOption((action.selections ?? []) as never, { timeout });
      return {};
    case "setChecked":
      await locator.setChecked(Boolean(action.checked), {
        timeout,
        force: action.force as boolean | undefined,
      });
      return {};
    case "count":
      return { value: await locator.count() };
    case "allTextContents":
      return { value: await locator.allTextContents() };
    case "innerText":
      return { value: await locator.innerText({ timeout }) };
    case "textContent":
      return { value: await locator.textContent({ timeout }) };
    case "getAttribute":
      return { value: await locator.getAttribute(String(action.attribute ?? ""), { timeout }) };
    case "isEnabled":
      return { value: await locator.isEnabled({ timeout }) };
    case "isVisible":
      return { value: await locator.isVisible() };
    case "waitFor":
      await locator.waitFor({
        state: (action.state as "attached" | "detached" | "visible" | "hidden") ?? "visible",
        timeout,
      });
      return {};
    default:
      throw new Error(`Unsupported playwright locator operation: ${action.operation}`);
  }
}
