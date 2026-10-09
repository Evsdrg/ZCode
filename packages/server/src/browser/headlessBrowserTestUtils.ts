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
  const page = {
    url: () => "http://example.test/",
    title: async () => "Example",
    viewportSize: () => ({ width: 1280, height: 720 }),
    evaluate: async () => ({ x: 0, y: 0 }),
    goto,
    isClosed: () => false,
    close: vi.fn(async () => {}),
    locator: () => locator,
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
  const chromiumLaunch = vi.fn(async () => browser);
  const firefoxLaunch = vi.fn(async () => browser);
  return {
    goto,
    clickSpy,
    contexts,
    browser,
    newContext,
    close,
    chromiumLaunch,
    firefoxLaunch,
    disconnect: () => {
      connected = false;
      for (const listener of disconnectedListeners) listener();
    },
    module: {
      chromium: { launch: chromiumLaunch },
      firefox: { launch: firefoxLaunch },
    } as unknown as typeof import("playwright-core"),
  };
}
