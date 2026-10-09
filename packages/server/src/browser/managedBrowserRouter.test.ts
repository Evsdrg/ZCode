import { describe, expect, it, vi } from "vitest";
import type { BrowserBackendDescriptor, BrowserCommandResult } from "@zcode/shared";
import {
  createManagedBrowserRouter,
  createConfiguredBrowserExecutor,
} from "./managedBrowserRouter.js";
import {
  createHeadlessBrowserExecutor,
  type BrowserControlExecutor,
} from "./headlessBrowserExecutor.js";
import { createFakePlaywright, deferred } from "./headlessBrowserTestUtils.js";

const scope = { sessionId: "s1", workspaceKey: "/w", workspacePath: "/w" };
const input = { ...scope, requestId: "r1", command: { method: "getState" as const } };

function backend(id: string): BrowserBackendDescriptor {
  return { id, type: "cdp", generation: 1, name: id, capabilities: {} };
}

function mockExecutor(id: string) {
  return {
    list: vi.fn(async () => [backend(id)]),
    execute: vi.fn(async (): Promise<BrowserCommandResult> => ({ ok: true, elapsedMs: 0 })),
    shutdown: vi.fn(async () => {}),
  } satisfies BrowserControlExecutor;
}

function harness() {
  const chromium = mockExecutor("server-headless-chromium");
  const firefox = mockExecutor("server-headless-firefox");
  const router = createManagedBrowserRouter([
    { browserId: "server-headless-chromium", executor: chromium },
    { browserId: "server-headless-firefox", executor: firefox },
  ]);
  return { router, chromium, firefox };
}

describe("managed browser router", () => {
  it("并行 discovery 按配置顺序返回而非完成顺序，并暴露选择建议", async () => {
    const { router, chromium, firefox } = harness();
    const pending = deferred<BrowserBackendDescriptor[]>();
    chromium.list.mockImplementationOnce(() => pending.promise);
    const list = router.list(scope);
    expect(firefox.list).toHaveBeenCalledWith(scope);
    pending.resolve([backend("server-headless-chromium")]);
    const available = await list;
    expect(available.map((item) => item.id)).toEqual([
      "server-headless-chromium",
      "server-headless-firefox",
    ]);
    expect(available[0]!.metadata?.selectionPolicy).toContain("get(id)");
    expect(available[0]!.metadata?.selectionPolicy).toContain("Chromium");
    await router.shutdown();
  });

  it("一侧 discovery 异常或空列表不阻断另一侧", async () => {
    const { router, chromium, firefox } = harness();
    chromium.list.mockRejectedValueOnce(new Error("unavailable"));
    expect((await router.list(scope)).map((item) => item.id)).toEqual(["server-headless-firefox"]);
    firefox.list.mockResolvedValueOnce([]);
    expect((await router.list(scope)).map((item) => item.id)).toEqual(["server-headless-chromium"]);
    await router.shutdown();
  });

  it("按 ID 精确转发完整上下文，指定引擎失败时不重放到另一侧", async () => {
    const { router, chromium, firefox } = harness();
    const request = {
      ...input,
      browserId: "server-headless-firefox",
      browserGeneration: 2,
      workspaceIdentity: "identity",
      remoteSessionId: "remote",
    };
    firefox.execute.mockResolvedValueOnce({
      ok: false,
      elapsedMs: 1,
      error: { code: "backend_unavailable", message: "missing" },
    });
    const result = await router.execute(request);
    expect(result.error?.code).toBe("backend_unavailable");
    expect(firefox.execute).toHaveBeenCalledWith(request);
    expect(chromium.execute).not.toHaveBeenCalled();
    await router.shutdown();
  });

  it("缺失或未知 ID、缺失代次不执行动作", async () => {
    const { router, chromium, firefox } = harness();
    for (const context of [
      {},
      { browserId: "unknown", browserGeneration: 1 },
      { browserId: "server-headless-firefox" },
    ]) {
      expect((await router.execute({ ...input, ...context })).error?.code).toBe(
        "backend_unavailable",
      );
    }
    expect(chromium.execute).not.toHaveBeenCalled();
    expect(firefox.execute).not.toHaveBeenCalled();
    await router.shutdown();
  });

  it("异常转结构化错误且不会触发 fallback", async () => {
    const { router, chromium, firefox } = harness();
    firefox.execute.mockRejectedValueOnce(new Error("Target closed"));
    expect(
      (
        await router.execute({
          ...input,
          browserId: "server-headless-firefox",
          browserGeneration: 1,
        })
      ).error?.code,
    ).toBe("execution_error");
    expect(chromium.execute).not.toHaveBeenCalled();
    await router.shutdown();
  });

  it("shutdown 幂等等待两侧，在一侧失败时仍等另一侧释放", async () => {
    const { router, chromium, firefox } = harness();
    const close = deferred<void>();
    chromium.shutdown.mockRejectedValueOnce(new Error("close failed"));
    firefox.shutdown.mockImplementationOnce(() => close.promise);
    const shutdown = router.shutdown();
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(firefox.shutdown).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    close.resolve();
    await shutdown;
    await router.shutdown();
    expect(chromium.shutdown).toHaveBeenCalledTimes(1);
    expect(firefox.shutdown).toHaveBeenCalledTimes(1);
    expect(await router.list(scope)).toEqual([]);
    expect(
      (
        await router.execute({
          ...input,
          browserId: "server-headless-firefox",
          browserGeneration: 1,
        })
      ).error?.code,
    ).toBe("backend_unavailable");
  });

  it("在途 discovery 关闭后不返回可用描述符", async () => {
    const { router, firefox } = harness();
    const pending = deferred<BrowserBackendDescriptor[]>();
    firefox.list.mockImplementationOnce(() => pending.promise);
    const list = router.list(scope);
    await router.shutdown();
    pending.resolve([backend("server-headless-firefox")]);
    expect(await list).toEqual([]);
  });

  it("拒绝重复注册相同 ID", () => {
    const executor = mockExecutor("same");
    expect(() =>
      createManagedBrowserRouter([
        { browserId: "same", executor },
        { browserId: "same", executor },
      ]),
    ).toThrow("Duplicate");
  });

  it("单模式保留旧调用，双模式创建独立 launcher 并隔离 generation", async () => {
    const single = createFakePlaywright();
    const one = createConfiguredBrowserExecutor({ engine: "firefox" }, (options) =>
      createHeadlessBrowserExecutor({ ...options, loadPlaywright: async () => single.module }),
    );
    expect((await one.execute(input)).ok).toBe(true);
    await one.shutdown();
    const chromium = createFakePlaywright();
    const firefox = createFakePlaywright();
    const router = createConfiguredBrowserExecutor(
      { engines: [{ engine: "chromium" }, { engine: "firefox" }] },
      (options) =>
        createHeadlessBrowserExecutor({
          ...options,
          loadPlaywright: async () =>
            options.engine === "chromium" ? chromium.module : firefox.module,
        }),
    );
    await router.list(scope);
    const request = { ...input, browserId: "server-headless-firefox", browserGeneration: 1 };
    expect((await router.execute(request)).ok).toBe(true);
    firefox.disconnect();
    expect((await router.execute(request)).error?.code).toBe("backend_unavailable");
    expect(
      (
        await router.execute({
          ...input,
          browserId: "server-headless-chromium",
          browserGeneration: 1,
        })
      ).ok,
    ).toBe(true);
    expect(chromium.chromiumLaunch).toHaveBeenCalledTimes(1);
    expect(firefox.firefoxLaunch).toHaveBeenCalledTimes(1);
    await router.shutdown();
  });
});
