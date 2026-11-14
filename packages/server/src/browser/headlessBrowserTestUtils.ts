import { vi, type Mock } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createFakePlaywright() {
  const goto = vi.fn(async () => null);
  const clickSpy = vi.fn(async () => {});
  const locator = {
    click: clickSpy,
    count: async () => 2,
    innerText: async () => "文本",
    ariaSnapshot: async () => "- document:",
  };
  const mouse = {
    move: vi.fn(async () => {}),
    down: vi.fn(async () => {}),
    up: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    wheel: vi.fn(async () => {}),
  };
  const keyboard = {
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    down: vi.fn(async () => {}),
    up: vi.fn(async () => {}),
  };
  // 1x1 PNG，够断言 base64 与调用参数；真实像素尺寸由集成测试覆盖。
  const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const screenshot = vi.fn(
    async (_options?: Record<string, unknown>) => Buffer.from(PNG_1X1, "base64"),
  );
  // 每个 page 独立持有 viewport 与监听器：browserViewportSet 的隔离语义必须可断言，
  // 且 HeadlessBrowserSession.tabForPage 按 page 对象 identity 去重，共用同一 page 无法构造多 tab。
  type FakePage = {
    url: () => string;
    title: () => Promise<string>;
    viewportSize: () => { width: number; height: number };
    setViewportSize: Mock<(size: { width: number; height: number }) => Promise<void>>;
    screenshot: Mock<(options?: Record<string, unknown>) => Promise<Buffer>>;
    evaluate: Mock<(...args: unknown[]) => Promise<unknown>>;
    goto: typeof goto;
    isClosed: () => boolean;
    close: Mock<() => Promise<void>>;
    locator: () => typeof locator;
    mouse: typeof mouse;
    keyboard: typeof keyboard;
    on: (event: string, listener: (payload: unknown) => void) => void;
  };
  const listenersByPage = new WeakMap<FakePage, Map<string, Array<(payload: unknown) => void>>>();
  const createPage = (): FakePage => {
    let pageViewport = { width: 1280, height: 720 };
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const page: FakePage = {
      url: () => "http://example.test/",
      title: async () => "Example",
      viewportSize: () => ({ ...pageViewport }),
      setViewportSize: vi.fn(async (size: { width: number; height: number }) => {
        pageViewport = { ...size };
      }),
      screenshot,
      evaluate: vi.fn(async () => ({ x: 0, y: 0 })),
      goto,
      isClosed: () => false,
      close: vi.fn(async () => {}),
      locator: () => locator,
      mouse,
      keyboard,
      on: (event, listener) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    };
    listenersByPage.set(page, listeners);
    return page;
  };
  const page = createPage();
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  let pageIndex = 0;
  const newContext = vi.fn(async () => {
    const context = {
      pages: () => [],
      on: () => {},
      newPage: async () => {
        const next = pageIndex === 0 ? page : createPage();
        pageIndex += 1;
        return next;
      },
      close: vi.fn(async () => {}),
    };
    contexts.push(context);
    return context as unknown as BrowserContext;
  });
  const disconnectedListeners: Array<() => void> = [];
  let connected = true;
  const close = vi.fn(async () => {
    connected = false;
    for (const listener of disconnectedListeners) listener();
  });
  const browser = {
    isConnected: () => connected,
    newContext,
    on: (event: string, listener: () => void) => {
      if (event === "disconnected") disconnectedListeners.push(listener);
    },
    close,
  } as unknown as Browser;
  // 真实 launch 每次返回新进程；fake 复用同一对象，重新 launch 时恢复连接态。
  const relaunch = async () => {
    connected = true;
    return browser;
  };
  const chromiumLaunch = vi.fn(relaunch);
  const firefoxLaunch = vi.fn(relaunch);
  const module = {
    chromium: { launch: chromiumLaunch, executablePath: () => "/fake/chromium" },
    firefox: { launch: firefoxLaunch, executablePath: () => "/fake/firefox" },
  } as unknown as typeof import("playwright-core");
  const executableAvailable = vi.fn((_path: string) => true);
  return {
    goto,
    clickSpy,
    contexts,
    page,
    mouse,
    keyboard,
    setViewportSize: page.setViewportSize,
    screenshot,
    /** 模拟页面弹出 JS 对话框；返回 fake Dialog 供断言。 */
    emitDialog: (dialog: {
      type: () => string;
      message: () => string;
      defaultValue: () => string;
      accept: ReturnType<typeof vi.fn>;
      dismiss: ReturnType<typeof vi.fn>;
    }) => {
      for (const listener of listenersByPage.get(page)?.get("dialog") ?? []) listener(dialog);
      return dialog;
    },
    browser,
    newContext,
    close,
    chromiumLaunch,
    firefoxLaunch,
    disconnect: () => {
      connected = false;
      for (const listener of disconnectedListeners) listener();
    },
    module,
    executableAvailable,
    runtimeOptions: {
      loadPlaywright: async () => module,
      isExecutableAvailable: async (path: string) => executableAvailable(path),
    },
  };
}
