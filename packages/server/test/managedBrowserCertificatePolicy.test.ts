import { describe, expect, it, vi } from "vitest";
import { createConfiguredBrowserExecutor } from "../src/browser/managedBrowserRouter.js";
import { createFakePlaywright } from "../src/browser/headlessBrowserTestUtils.js";

const scope = { sessionId: "s1", workspaceKey: "/w", workspacePath: "/w" };
const input = { ...scope, requestId: "r1", command: { method: "getState" as const } };

describe("managed browser certificate policy", () => {
  it("关闭时每个 Context 都显式 ignoreHTTPSErrors=false（保持严格校验）", async () => {
    const fake = createFakePlaywright();
    const executor = createConfiguredBrowserExecutor(
      { engine: "chromium" },
      undefined,
      { ...fake.runtimeOptions, resolveIgnoreHTTPSErrors: async () => false },
    );
    const [backend] = await executor.list(scope);
    expect(
      (
        await executor.execute({
          ...input,
          browserId: backend!.id,
          browserGeneration: backend!.generation,
        })
      ).ok,
    ).toBe(true);
    expect(fake.newContext).toHaveBeenCalledWith({ ignoreHTTPSErrors: false });
    await executor.shutdown();
  });

  it("开启时把 ignoreHTTPSErrors=true 传给 Playwright Context，且每次新建都重新读取", async () => {
    const fake = createFakePlaywright();
    let allow = false;
    const resolveIgnoreHTTPSErrors = vi.fn(async () => allow);
    const executor = createConfiguredBrowserExecutor(
      { engine: "chromium" },
      undefined,
      { ...fake.runtimeOptions, resolveIgnoreHTTPSErrors },
    );
    const [backend] = await executor.list(scope);
    const run = (sessionId: string) =>
      executor.execute({
        ...scope,
        sessionId,
        requestId: crypto.randomUUID(),
        browserId: backend!.id,
        browserGeneration: backend!.generation,
        command: { method: "getState" as const },
      });

    expect((await run("first")).ok).toBe(true);
    expect(fake.newContext).toHaveBeenLastCalledWith({ ignoreHTTPSErrors: false });

    allow = true;
    expect((await run("second")).ok).toBe(true);
    // 开关改了不需要重启浏览器：新 Context 立刻按新值生效。
    expect(fake.newContext).toHaveBeenLastCalledWith({ ignoreHTTPSErrors: true });
    expect(resolveIgnoreHTTPSErrors).toHaveBeenCalledTimes(2);
    await executor.shutdown();
  });

  it("读取设置失败时 fail-closed 回退严格校验，不阻断浏览器启动", async () => {
    const fake = createFakePlaywright();
    const executor = createConfiguredBrowserExecutor(
      { engine: "chromium" },
      undefined,
      {
        ...fake.runtimeOptions,
        resolveIgnoreHTTPSErrors: async () => {
          throw new Error("setting service unavailable");
        },
      },
    );
    const [backend] = await executor.list(scope);
    expect(
      (
        await executor.execute({
          ...input,
          browserId: backend!.id,
          browserGeneration: backend!.generation,
        })
      ).ok,
    ).toBe(true);
    expect(fake.newContext).toHaveBeenCalledWith({ ignoreHTTPSErrors: false });
    await executor.shutdown();
  });

  it("未注入策略时不向 newContext 传 ignoreHTTPSErrors，保持既有默认行为", async () => {
    const fake = createFakePlaywright();
    const executor = createConfiguredBrowserExecutor(
      { engine: "chromium" },
      undefined,
      fake.runtimeOptions,
    );
    const [backend] = await executor.list(scope);
    await executor.execute({
      ...input,
      browserId: backend!.id,
      browserGeneration: backend!.generation,
    });
    expect(fake.newContext).toHaveBeenCalledWith({});
    await executor.shutdown();
  });
});
