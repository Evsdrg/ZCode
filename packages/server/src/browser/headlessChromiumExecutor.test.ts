import { describe, expect, it, vi } from "vitest";
import type { BrowserCommand } from "@zcode/shared";
import { createHeadlessChromiumExecutor } from "./headlessChromiumExecutor.js";
import { isAllowedManagedBrowserUrl, describeDisallowedBrowserUrl } from "./browserUrlPolicy.js";

/** 构造 fake playwright，避免单测真启浏览器。 */
function createFakePlaywright() {
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
    locator: () => locator,
  };
  const context = {
    pages: () => [page],
    on: () => {},
    newPage: async () => page,
    close: async () => {},
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
    on: () => {},
    close: async () => {},
  };
  return {
    goto,
    clickSpy,
    module: {
      chromium: { launch: vi.fn(async () => browser) },
    } as unknown as typeof import("playwright-core"),
  };
}

const listInput = { sessionId: "s1", workspaceKey: "/w", workspacePath: "/w" };

function cmd(command: BrowserCommand) {
  return { ...listInput, requestId: "r1", command };
}

describe("browserUrlPolicy", () => {
  it("只放行 http/https 与 about:blank", () => {
    expect(isAllowedManagedBrowserUrl("https://example.com")).toBe(true);
    expect(isAllowedManagedBrowserUrl("http://localhost:3000/x")).toBe(true);
    expect(isAllowedManagedBrowserUrl("about:blank")).toBe(true);
    expect(isAllowedManagedBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedManagedBrowserUrl("data:text/html,<h1>x")).toBe(false);
    expect(isAllowedManagedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedManagedBrowserUrl("chrome://settings")).toBe(false);
    expect(isAllowedManagedBrowserUrl("not a url")).toBe(false);
  });

  it("拒绝理由包含目标地址", () => {
    expect(describeDisallowedBrowserUrl("file:///x")).toContain("file:///x");
  });
});

describe("headlessChromiumExecutor", () => {
  it("list() 返回 cdp 后端且收紧项就位", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const backends = await executor.list(listInput);
    expect(backends).toHaveLength(1);
    expect(backends[0]).toMatchObject({ type: "cdp", name: "ZCode Server Headless Chromium" });
    expect(backends[0]!.apiSupportOverrides).toMatchObject({
      "BrowserUser.openTabs": false,
      "PlaywrightLocator.evaluate": false,
    });
    await executor.shutdown();
  });

  it("启动失败时 list() 返回空（不伪装可用）", async () => {
    const executor = createHeadlessChromiumExecutor({
      loadPlaywright: async () =>
        ({
          chromium: {
            launch: vi.fn(async () => {
              throw new Error("no chromium");
            }),
          },
        }) as unknown as typeof import("playwright-core"),
    });
    expect(await executor.list(listInput)).toEqual([]);
  });

  it("非 http(s) 导航被拒绝为 navigation_blocked", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute(cmd({ method: "navigate", url: "file:///etc/passwd" }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("navigation_blocked");
    expect(fake.goto).not.toHaveBeenCalled();
    await executor.shutdown();
  });

  it("http 导航放行并调用 goto", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute(
      cmd({ method: "navigate", url: "https://example.test/" }),
    );
    expect(result.ok).toBe(true);
    expect(fake.goto).toHaveBeenCalledWith("https://example.test/", expect.anything());
    expect(result.meta?.backendType).toBe("cdp");
    await executor.shutdown();
  });

  it("playwright domSnapshot 走 locator 的 ariaSnapshot 并回 value（对齐 facade 的 string 契约）", async () => {
    const fake = createFakePlaywright();
    const loc = fake.module as unknown as { chromium: unknown };
    void loc;
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute(
      cmd({ method: "playwright", action: { name: "domSnapshot" } } as BrowserCommand),
    );
    expect(result.ok).toBe(true);
    expect(typeof result.value).toBe("string");
    await executor.shutdown();
  });

  it("locator 操作：click 与 count 分派正确", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const click = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "click" },
      } as BrowserCommand),
    );
    expect(click.ok).toBe(true);
    expect(fake.clickSpy).toHaveBeenCalledTimes(1);
    const count = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "count" },
      } as BrowserCommand),
    );
    expect(count.value).toBe(2);
    await executor.shutdown();
  });

  it("locator 未知 operation 返回 execution_error（不静默）", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "nope" },
      } as unknown as BrowserCommand),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("execution_error");
    await executor.shutdown();
  });

  it("不支持的命令返回 capability_unsupported（不抛到进程边界）", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessChromiumExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute(
      cmd({ method: "recordingStart", outputPath: "/tmp/x.webm" } as BrowserCommand),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("capability_unsupported");
    await executor.shutdown();
  });
});
