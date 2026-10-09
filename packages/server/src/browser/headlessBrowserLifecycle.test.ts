import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { createHeadlessBrowserExecutor } from "./headlessBrowserExecutor.js";
import { createFakePlaywright, deferred } from "./headlessBrowserTestUtils.js";

const input = {
  sessionId: "same-session",
  workspaceKey: "/w",
  workspacePath: "/w",
  requestId: "r1",
  command: { method: "getState" as const },
};

describe("managed browser scope and lifecycle", () => {
  it("并发 discovery 合并启动；同 scope 并发只创建一个 Context", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    await Promise.all([executor.list(input), executor.list(input)]);
    const results = await Promise.all([executor.execute(input), executor.execute(input)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.chromiumLaunch).toHaveBeenCalledTimes(1);
    expect(fake.newContext).toHaveBeenCalledTimes(1);
    await executor.shutdown();
  });

  it("相同 sessionId 在不同工作区 identity 或 remote session 中隔离", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    const scopes = [
      { workspaceIdentity: " identity-a " },
      { workspaceIdentity: "identity-a" },
      { workspaceIdentity: "identity-b" },
      { workspaceIdentity: "identity-a", remoteSessionId: "remote-a" },
      { workspaceIdentity: "identity-a", remoteSessionId: "remote-b" },
      { workspaceKey: "/another" },
    ];
    for (const scope of scopes)
      expect((await executor.execute({ ...input, ...scope })).ok).toBe(true);
    expect(fake.newContext).toHaveBeenCalledTimes(5);
    await executor.shutdown();
  });

  it("错误 browser ID 和旧代次不创建 Context 或执行动作", async () => {
    const fake = createFakePlaywright();
    const executor = createHeadlessBrowserExecutor({
      engine: "firefox",
      loadPlaywright: async () => fake.module,
    });
    const [backend] = await executor.list(input);
    const wrong = await executor.execute({ ...input, browserId: "server-headless-chromium" });
    const stale = await executor.execute({
      ...input,
      browserId: backend!.id,
      browserGeneration: backend!.generation + 1,
    });
    expect(wrong.error?.code).toBe("backend_unavailable");
    expect(stale.error?.code).toBe("backend_unavailable");
    expect(fake.newContext).not.toHaveBeenCalled();
    await executor.shutdown();
  });

  it("断连后 generation 增加，旧对象不启动新浏览器", async () => {
    const old = createFakePlaywright();
    const next = createFakePlaywright();
    let loads = 0;
    const executor = createHeadlessBrowserExecutor({
      loadPlaywright: async () => (++loads === 1 ? old.module : next.module),
    });
    const [backend] = await executor.list(input);
    await executor.execute(input);
    old.disconnect();
    const stale = await executor.execute({ ...input, browserGeneration: backend!.generation });
    expect(stale.error?.code).toBe("backend_unavailable");
    expect(next.chromiumLaunch).not.toHaveBeenCalled();
    const [replacement] = await executor.list(input);
    expect(replacement!.generation).toBe(backend!.generation + 1);
    old.disconnect();
    expect(
      (await executor.execute({ ...input, browserGeneration: replacement!.generation })).ok,
    ).toBe(true);
    await executor.shutdown();
  });

  it("Context 创建失败后清除在途缓存，后续请求可以重试", async () => {
    const fake = createFakePlaywright();
    fake.newContext.mockRejectedValueOnce(new Error("context failed"));
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    expect((await executor.execute(input)).error?.code).toBe("backend_unavailable");
    expect((await executor.execute(input)).ok).toBe(true);
    expect(fake.newContext).toHaveBeenCalledTimes(2);
    await executor.shutdown();
  });

  it("动作期间断连不把旧结果标记为新代次成功", async () => {
    const fake = createFakePlaywright();
    const action = deferred<null>();
    const entered = deferred<void>();
    fake.goto.mockImplementationOnce(() => {
      entered.resolve();
      return action.promise;
    });
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    const pending = executor.execute({
      ...input,
      command: { method: "navigate", url: "https://example.test" },
    });
    await entered.promise;
    fake.disconnect();
    action.resolve(null);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_unavailable");
    expect(result.meta?.browserGeneration).toBe(1);
    await executor.shutdown();
  });

  it("断连导致 Playwright 抛错时仍返回 backend_unavailable", async () => {
    const fake = createFakePlaywright();
    fake.goto.mockImplementationOnce(async () => {
      fake.disconnect();
      throw new Error("Target closed");
    });
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    const result = await executor.execute({
      ...input,
      command: { method: "navigate", url: "https://example.test" },
    });
    expect(result.error?.code).toBe("backend_unavailable");
    await executor.shutdown();
  });

  it("Context 创建期间断连时回收迟到资源，不执行旧请求", async () => {
    const fake = createFakePlaywright();
    const pendingContext = deferred<BrowserContext>();
    const entered = deferred<void>();
    const context = await fake.newContext();
    fake.newContext.mockImplementationOnce(() => {
      entered.resolve();
      return pendingContext.promise;
    });
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    await executor.list(input);
    const pending = executor.execute(input);
    await entered.promise;
    fake.disconnect();
    pendingContext.resolve(context);
    expect((await pending).error?.code).toBe("backend_unavailable");
    expect(fake.contexts[0]!.close).toHaveBeenCalledTimes(1);
    await executor.shutdown();
  });

  it("shutdown 等待在途启动、回收迟到浏览器且关闭后不复活", async () => {
    const fake = createFakePlaywright();
    const launch = deferred<Browser>();
    const entered = deferred<void>();
    fake.chromiumLaunch.mockImplementationOnce(() => {
      entered.resolve();
      return launch.promise;
    });
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    const discovery = executor.list(input);
    await entered.promise;
    const shutdown = executor.shutdown();
    launch.resolve(fake.browser);
    expect(await discovery).toEqual([]);
    await shutdown;
    await executor.shutdown();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(await executor.list(input)).toEqual([]);
    expect((await executor.execute(input)).error?.code).toBe("backend_unavailable");
    expect(fake.chromiumLaunch).toHaveBeenCalledTimes(1);
  });

  it("shutdown 等待在途 Context 创建并只关闭一次", async () => {
    const fake = createFakePlaywright();
    const context = await fake.newContext();
    const pendingContext = deferred<BrowserContext>();
    const entered = deferred<void>();
    fake.newContext.mockImplementationOnce(() => {
      entered.resolve();
      return pendingContext.promise;
    });
    const executor = createHeadlessBrowserExecutor({ loadPlaywright: async () => fake.module });
    await executor.list(input);
    const execution = executor.execute(input);
    await entered.promise;
    const shutdown = executor.shutdown();
    pendingContext.resolve(context);
    expect((await execution).error?.code).toBe("backend_unavailable");
    await shutdown;
    expect(fake.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
