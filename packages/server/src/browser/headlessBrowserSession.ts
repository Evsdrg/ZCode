import type { BrowserContext, Page, ElementHandle } from "playwright-core";
import {
  browserSnapshotSchema,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTabSummary,
  type BrowserViewportSize,
} from "@zcode/shared";

/**
 * 托管 headless Chromium 的会话：一个 Playwright BrowserContext + 受控 tab 注册表。
 * 语义对齐 CLI 托管后端（session.ts / snapshot.ts），但为 server 侧独立实现。
 */

const DEFAULT_VIEWPORT: BrowserViewportSize = { width: 1280, height: 720 };
const DEFAULT_MAX_ELEMENTS = 200;

interface ManagedTab {
  id: string;
  page: Page;
}

/**
 * 注入页面执行的快照脚本（字符串形式，避免 server 侧 TS 引用 DOM lib）。
 * 自包含、不引用模块闭包；ref → ElementHandle 绑定由 adapter 侧接管，脚本不持有 ref map。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const actionSelector =
    "a[href],button,input,textarea,select,[role],[onclick],[tabindex],summary,label,[contenteditable]";
  const hidden = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
      (rect.width <= 0 && rect.height <= 0);
  };
  const norm = (v, max) => String(v == null ? "" : v).trim().replace(/\\s+/g, " ").slice(0, max);
  const implicitRole = (el, tag) => {
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return "";
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "search") return "searchbox";
    return "textbox";
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = sibs.indexOf(node) + 1;
      parts.unshift(sibs.length > 1 ? tag + ":nth-of-type(" + idx + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  };
  const xpathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift("/" + tag); break; }
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift("/" + tag + "[" + (sibs.indexOf(node) + 1) + "]");
      node = parent;
    }
    return parts.join("");
  };
  const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  const elements = [];
  for (const el of Array.from(document.querySelectorAll(actionSelector))) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (hidden(el)) continue;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const name of ["type", "name", "aria-label", "placeholder", "href", "value"]) {
      const v = el.getAttribute(name);
      if (v) attrs[name] = norm(v, 120);
    }
    elements.push({
      ref: "e" + (elements.length + 1),
      tag,
      role: (el.getAttribute("role") || implicitRole(el, tag)).toLowerCase() || undefined,
      name: norm(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") ||
        el.getAttribute("placeholder") || el.innerText || el.value || "", 120) || undefined,
      text: norm(el.innerText, 160) || undefined,
      value: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? (norm(el.value, 160) || undefined) : undefined,
      disabled: (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) ? el.disabled : undefined,
      checked: el instanceof HTMLInputElement ? el.checked : undefined,
      selector: cssPath(el),
      xpath: xpathOf(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0,
      attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
    });
  }
  const domSelector = "h1,h2,h3,h4,h5,h6,p,li,td,th,caption,blockquote,pre,label,button,a[href]";
  const depthOf = (el) => { let d = 0, n = el.parentElement; while (n && d < 64) { d++; n = n.parentElement; } return d; };
  const dom = [];
  for (const el of Array.from(document.querySelectorAll(domSelector))) {
    if (dom.length >= 300) break;
    if (hidden(el)) continue;
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    dom.push({
      tag,
      depth: depthOf(el),
      inViewport: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0,
      text: norm(el.innerText, 200) || undefined,
      role: (el.getAttribute("role") || implicitRole(el, tag)).toLowerCase() || undefined,
    });
  }
  return { elements, dom };
})()`.replace("MAX_ELEMENTS", "200");

export class HeadlessBrowserSession {
  readonly #context: BrowserContext;
  readonly #tabs = new Map<string, ManagedTab>();
  readonly #refsByPage = new WeakMap<Page, Map<string, ElementHandle>>();
  #activeTabId: string | undefined;
  #viewport: BrowserViewportSize = DEFAULT_VIEWPORT;

  constructor(context: BrowserContext) {
    this.#context = context;
    for (const page of context.pages()) this.registerPage(page);
    context.on("page", (page) => this.registerPage(page));
  }

  get tabIds(): string[] {
    return [...this.#tabs.keys()];
  }

  private registerPage(page: Page): ManagedTab {
    const existing = this.tabForPage(page);
    if (existing) return existing;
    const tab: ManagedTab = {
      id: `tab-${this.#tabs.size + 1}-${Math.random().toString(36).slice(2, 8)}`,
      page,
    };
    this.#tabs.set(tab.id, tab);
    if (!this.#activeTabId) this.#activeTabId = tab.id;
    return tab;
  }

  private tabForPage(page: Page): ManagedTab | undefined {
    for (const tab of this.#tabs.values()) if (tab.page === page) return tab;
    return undefined;
  }

  async ensureTab(tabId?: string): Promise<ManagedTab> {
    if (tabId) {
      const tab = this.#tabs.get(tabId);
      if (!tab || tab.page.isClosed()) throw new Error(`Browser tab '${tabId}' is unavailable`);
      return tab;
    }
    const active = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    if (active && !active.page.isClosed()) return active;
    return this.createTab();
  }

  async createTab(): Promise<ManagedTab> {
    const page = await this.#context.newPage();
    await page.setViewportSize(this.#viewport);
    const tab = this.registerPage(page);
    this.#activeTabId = tab.id;
    return tab;
  }

  activateTab(tabId: string): ManagedTab {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.page.isClosed()) throw new Error(`Browser tab '${tabId}' is unavailable`);
    this.#activeTabId = tabId;
    return tab;
  }

  async closeTab(tabId?: string): Promise<void> {
    const tab = tabId
      ? this.#tabs.get(tabId)
      : this.#activeTabId
        ? this.#tabs.get(this.#activeTabId)
        : undefined;
    if (!tab) return;
    this.#tabs.delete(tab.id);
    if (this.#activeTabId === tab.id) this.#activeTabId = [...this.#tabs.keys()][0];
    if (!tab.page.isClosed()) await tab.page.close().catch(() => {});
  }

  listTabs(): BrowserTabSummary[] {
    return [...this.#tabs.values()].map((tab) => ({
      tabId: tab.id,
      url: tab.page.url(),
      title: "",
      viewport: this.#viewport,
      active: tab.id === this.#activeTabId,
    }));
  }

  async listTabsWithTitles(): Promise<BrowserTabSummary[]> {
    const out: BrowserTabSummary[] = [];
    for (const tab of this.#tabs.values()) {
      let title = "";
      try {
        title = await tab.page.title();
      } catch {
        // 页面可能在读取期间关闭；保留空标题。
      }
      out.push({
        tabId: tab.id,
        url: tab.page.url(),
        title,
        viewport: this.#viewport,
        active: tab.id === this.#activeTabId,
      });
    }
    return out;
  }

  setViewport(size: BrowserViewportSize): void {
    this.#viewport = size;
    for (const tab of this.#tabs.values()) void tab.page.setViewportSize(size).catch(() => {});
  }

  get viewport(): BrowserViewportSize {
    return this.#viewport;
  }

  activeTab(): ManagedTab | undefined {
    return this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
  }

  async snapshot(tab: ManagedTab): Promise<BrowserSnapshot> {
    const raw = (await tab.page.evaluate(SNAPSHOT_SCRIPT)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dom: any[];
    };
    // ref → ElementHandle 绑定由 adapter 侧接管，页面脚本不得持有 ref map。
    const refMap = new Map<string, ElementHandle>();
    const elements: BrowserSnapshotElement[] = [];
    for (const item of raw.elements) {
      const handle = await tab.page
        .locator(item.selector)
        .first()
        .elementHandle()
        .catch(() => null);
      if (handle) refMap.set(item.ref, handle as ElementHandle);
      elements.push({
        ref: item.ref,
        tag: item.tag,
        ...(item.role ? { role: item.role } : {}),
        ...(item.name ? { name: item.name } : {}),
        ...(item.text ? { text: item.text } : {}),
        ...(item.value ? { value: item.value } : {}),
        ...(typeof item.disabled === "boolean" ? { disabled: item.disabled } : {}),
        ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
        selector: item.selector,
        xpath: item.xpath,
        rect: item.rect,
        inViewport: item.inViewport,
        ...(item.attributes ? { attributes: item.attributes } : {}),
      });
    }
    this.#refsByPage.set(tab.page, refMap);
    const domNodes = Array.isArray(raw.dom)
      ? raw.dom.map((node) => ({
          tag: String(node.tag ?? ""),
          depth: Number(node.depth ?? 0),
          inViewport: Boolean(node.inViewport),
          ...(node.text ? { text: String(node.text) } : {}),
          ...(node.role ? { role: String(node.role) } : {}),
        }))
      : undefined;
    return browserSnapshotSchema.parse({
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      ...(domNodes && domNodes.length > 0 ? { dom: domNodes } : {}),
      elements,
      truncated: raw.elements.length >= DEFAULT_MAX_ELEMENTS,
    });
  }

  async resolveRef(tab: ManagedTab, ref: string): Promise<ElementHandle> {
    const map = this.#refsByPage.get(tab.page);
    const handle = map?.get(ref);
    if (!handle) {
      throw new Error(`Element ref '${ref}' is unknown; take a fresh snapshot first`);
    }
    return handle;
  }

  async close(): Promise<void> {
    for (const tab of this.#tabs.values()) {
      if (!tab.page.isClosed()) await tab.page.close().catch(() => {});
    }
    this.#tabs.clear();
    this.#activeTabId = undefined;
    await this.#context.close().catch(() => {});
  }
}
