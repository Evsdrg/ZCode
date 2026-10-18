import { describe, expect, it, vi } from "vitest";
import {
  browserBackendDescriptorSchema,
  browserCommandResultSchema,
  type BrowserCommand,
} from "@zcode/shared";
import { createHeadlessBrowserExecutor } from "./headlessBrowserExecutor.js";
import { createFakePlaywright } from "./headlessBrowserTestUtils.js";
import { isAllowedManagedBrowserUrl, describeDisallowedBrowserUrl } from "./browserUrlPolicy.js";

const listInput = { sessionId: "s1", workspaceKey: "/w", workspacePath: "/w" };

function cmd(command: BrowserCommand) {
  return { ...listInput, requestId: "r1", command };
}

describe("browserUrlPolicy", () => {
  it("只放行 http/https 与 about:blank", () => {
    for (const url of ["https://example.com", "http://localhost:3000/x", "about:blank"])
      expect(isAllowedManagedBrowserUrl(url)).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<h1>x",
      "javascript:alert(1)",
      "chrome://settings",
      "not a url",
    ])
      expect(isAllowedManagedBrowserUrl(url)).toBe(false);
  });

  it("拒绝理由包含目标地址", () => {
    expect(describeDisallowedBrowserUrl("file:///x")).toContain("file:///x");
  });
});

describe("headlessBrowserExecutor", () => {
  it("缺省引擎保留 Chromium ID、名称；discovery 不拉起进程，首次执行才启动", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const backends = await executor.list(listInput);
    expect(backends).toHaveLength(1);
    expect(backends[0]).toMatchObject({
      id: "server-headless-chromium",
      type: "cdp",
      name: "ZCode Server Headless Chromium",
    });
    // discovery 只返回描述符，不启动浏览器进程。
    expect(fake.chromiumLaunch).not.toHaveBeenCalled();
    expect(fake.firefoxLaunch).not.toHaveBeenCalled();
    // 首次 execute 才启动，且携带既有参数。
    const result = await executor.execute(cmd({ method: "getState" }));
    expect(result.ok).toBe(true);
    expect(fake.chromiumLaunch).toHaveBeenCalledWith({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    expect(fake.firefoxLaunch).not.toHaveBeenCalled();
    await executor.shutdown();
  });

  it("Firefox 使用独立 launcher，不传 Chromium 参数且描述符符合旧协议", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({
      engine: "firefox",
      executablePath: "/test/firefox",
      ...fake.runtimeOptions,
    });
    const [backend] = await executor.list(listInput);
    expect(browserBackendDescriptorSchema.parse(backend)).toMatchObject({
      id: "server-headless-firefox",
      type: "cdp",
      name: "ZCode Server Headless Firefox",
      metadata: { engine: "firefox", driver: "playwright", headless: "true" },
      apiSupportOverrides: { "BrowserUser.openTabs": false, "PlaywrightLocator.evaluate": false },
    });
    // execute 才真实启动 Firefox launcher。
    const exec = await executor.execute(cmd({ method: "getState" }));
    expect(exec.ok).toBe(true);
    expect(fake.firefoxLaunch).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/test/firefox",
    });
    expect(fake.chromiumLaunch).not.toHaveBeenCalled();
    const result = await executor.execute(cmd({ method: "getState" }));
    expect(browserCommandResultSchema.parse(result).meta).toMatchObject({
      browserId: "server-headless-firefox",
      backendType: "cdp",
    });
    await executor.shutdown();
  });

  it("Firefox 启动失败不回退 Chromium；execute 报 backend_unavailable 且可重试", async () => {
    const fake = createFakePlaywright();
    fake.firefoxLaunch.mockRejectedValueOnce(new Error("no firefox"));
    const executor = createHeadlessBrowserExecutor({
      engine: "firefox",
      ...fake.runtimeOptions,
    });
    // discovery 仍返回描述符（不探测启动）。
    expect(await executor.list(listInput)).toHaveLength(1);
    // 首次 execute 启动失败：backend_unavailable，不回退 Chromium。
    const failed = await executor.execute(cmd({ method: "getState" }));
    expect(failed.error?.code).toBe("backend_unavailable");
    expect(fake.chromiumLaunch).not.toHaveBeenCalled();
    // 重试成功。
    const retried = await executor.execute(cmd({ method: "getState" }));
    expect(retried.ok).toBe(true);
    expect(fake.firefoxLaunch).toHaveBeenCalledTimes(2);
    await executor.shutdown();
  });

  it("可执行文件缺失或 runtime 已关闭时 discovery 返回空，且都不拉起进程", async () => {
    const fake = createFakePlaywright();
    fake.executableAvailable.mockReturnValue(false);
    const missing = createHeadlessBrowserExecutor({
      engine: "firefox",
      executablePath: "/missing/firefox",
      ...fake.runtimeOptions,
    });
    expect(await missing.list(listInput)).toEqual([]);
    expect(fake.executableAvailable).toHaveBeenCalledWith("/missing/firefox");
    await missing.shutdown();

    fake.executableAvailable.mockReturnValue(true);
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    expect(await executor.list(listInput)).toHaveLength(1);
    expect(fake.executableAvailable).toHaveBeenCalledWith("/fake/chromium");
    await executor.shutdown();
    expect(await executor.list(listInput)).toEqual([]);
    expect(fake.chromiumLaunch).not.toHaveBeenCalled();
    expect(fake.firefoxLaunch).not.toHaveBeenCalled();
  });

  it("非 http(s) 导航被拒绝为 navigation_blocked", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(cmd({ method: "navigate", url: "file:///etc/passwd" }));
    expect(result.error?.code).toBe("navigation_blocked");
    expect(fake.goto).not.toHaveBeenCalled();
    await executor.shutdown();
  });

  it("http 导航放行并调用 goto", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(
      cmd({ method: "navigate", url: "https://example.test/" }),
    );
    expect(result.ok).toBe(true);
    expect(fake.goto).toHaveBeenCalledWith("https://example.test/", expect.anything());
    expect(result.meta?.backendType).toBe("cdp");
    await executor.shutdown();
  });

  it("domSnapshot 仍返回 facade 要求的 string", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(
      cmd({ method: "playwright", action: { name: "domSnapshot" } }),
    );
    expect(result.ok).toBe(true);
    expect(typeof result.value).toBe("string");
    await executor.shutdown();
  });

  it("locator 的 click 和 count 分派正确", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const click = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "click" },
      }),
    );
    expect(click.ok).toBe(true);
    expect(fake.clickSpy).toHaveBeenCalledTimes(1);
    const count = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "count" },
      }),
    );
    expect(count.value).toBe(2);
    await executor.shutdown();
  });

  it("locator 未知 operation 返回明确错误", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(
      cmd({
        method: "playwright",
        action: { name: "locator", selector: "#b", operation: "nope" },
      } as unknown as BrowserCommand),
    );
    expect(result.error?.code).toBe("execution_error");
    await executor.shutdown();
  });

  it("未支持命令返回 capability_unsupported", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(cmd({ method: "recordingStart" }));
    expect(result.error?.code).toBe("capability_unsupported");
    await executor.shutdown();
  });

  it("getDialog 无弹窗时返回 null，弹出后返回类型与消息", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    expect((await executor.execute(cmd({ method: "getDialog" }))).dialog).toBeNull();

    fake.emitDialog({
      type: () => "confirm",
      message: () => "继续吗？",
      defaultValue: () => "",
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    });
    const result = await executor.execute(cmd({ method: "getDialog" }));
    expect(result.dialog).toEqual({ type: "confirm", message: "继续吗？" });
    await executor.shutdown();
  });

  it("handleDialog accept 转发 promptText 并清登记，dismiss 走对应分支", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    // 先触发一次命令让 session/context 建立（page.on("dialog") 挂上），再弹窗。
    expect((await executor.execute(cmd({ method: "getDialog" }))).dialog).toBeNull();
    const accept = vi.fn(async () => {});
    fake.emitDialog({
      type: () => "prompt",
      message: () => "输入名字",
      defaultValue: () => "默认",
      accept,
      dismiss: vi.fn(async () => {}),
    });
    const result = await executor.execute(
      cmd({ method: "handleDialog", accept: true, promptText: "zcode" }),
    );
    expect(result.ok).toBe(true);
    expect(accept).toHaveBeenCalledWith("zcode");
    // 处理完成后 getDialog 回到 null，重复 handleDialog 报错而不是卡死。
    expect((await executor.execute(cmd({ method: "getDialog" }))).dialog).toBeNull();
    const again = await executor.execute(cmd({ method: "handleDialog", accept: false }));
    expect(again.ok).toBe(false);
    await executor.shutdown();
  });

  it("cuaKeypress 修饰键 down→press→up 顺序执行", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const result = await executor.execute(cmd({ method: "cuaKeypress", keys: ["Control", "a"] }));
    expect(result.ok).toBe(true);
    expect(fake.keyboard.down).toHaveBeenCalledWith("Control");
    expect(fake.keyboard.press).toHaveBeenCalledWith("a");
    expect(fake.keyboard.up).toHaveBeenCalledWith("Control");
    await executor.shutdown();
  });

  it("cuaScroll 移动锚点后滚轮；cuaDrag 逐点移动并保证抬起", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const scroll = await executor.execute(
      cmd({ method: "cuaScroll", x: 100, y: 200, scrollX: 0, scrollY: 480 }),
    );
    expect(scroll.ok).toBe(true);
    expect(fake.mouse.move).toHaveBeenCalledWith(100, 200);
    expect(fake.mouse.wheel).toHaveBeenCalledWith(0, 480);

    const drag = await executor.execute(
      cmd({
        method: "cuaDrag",
        path: [
          { x: 0, y: 0 },
          { x: 50, y: 50 },
          { x: 100, y: 100 },
        ],
      }),
    );
    expect(drag.ok).toBe(true);
    expect(fake.mouse.down).toHaveBeenCalledTimes(1);
    expect(fake.mouse.move).toHaveBeenCalledTimes(4);
    expect(fake.mouse.up).toHaveBeenCalledTimes(1);
    await executor.shutdown();
  });

  it("playwrightWaitForTimeout 与 listUserTabs/nameSession 返回兼容语义", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ ...fake.runtimeOptions });
    const wait = await executor.execute(cmd({ method: "playwrightWaitForTimeout", timeoutMs: 0 }));
    expect(wait.ok).toBe(true);
    const userTabs = await executor.execute(cmd({ method: "listUserTabs" }));
    expect(userTabs.ok).toBe(true);
    expect(userTabs.userTabs).toEqual([]);
    const name = await executor.execute(cmd({ method: "nameSession", name: "probe" }));
    expect(name.ok).toBe(true);
    await executor.shutdown();
  });
});
