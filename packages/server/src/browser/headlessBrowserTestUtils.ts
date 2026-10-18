import { vi } from "vitest";
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
  const pageListeners = new Map<string, Array<(payload: unknown) => void>>();
  const page = {
    url: () => "http://example.test/",
    title: async () => "Example",
    viewportSize: () => ({ width: 1280, height: 720 }),
    evaluate: vi.fn(async () => ({ x: 0, y: 0 })),
    goto,
    isClosed: () => false,
    close: vi.fn(async () => {}),
    locator: () => locator,
    mouse,
    keyboard,
    on: (event: string, listener: (payload: unknown) => void) => {
      const list = pageListeners.get(event) ?? [];
      list.push(listener);
      pageListeners.set(event, list);
    },
  };
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const newContext = vi.fn(async () => {
    const context = {
      pages: () => [page],
      on: () => {},
      newPage: async () => page,
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
    /** 模拟页面弹出 JS 对话框；返回 fake Dialog 供断言。 */
    emitDialog: (dialog: {
      type: () => string;
      message: () => string;
      defaultValue: () => string;
      accept: ReturnType<typeof vi.fn>;
      dismiss: ReturnType<typeof vi.fn>;
    }) => {
      for (const listener of pageListeners.get("dialog") ?? []) listener(dialog);
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
