import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createConfiguredBrowserExecutor } from "./managedBrowserRouter.js";
import type { BrowserCommand } from "@zcode/shared";

const enabled = process.env["ZCODE_BROWSER_INTEGRATION"] === "1";
const scope = {
  sessionId: "dual-fixture",
  workspaceKey: "dual-fixture",
  workspacePath: "/workspace/fixture",
};

describe.skipIf(!enabled)("dual browser failure isolation", () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((_request, response) =>
      response.end("<title>Dual fixture</title><h1>Dual fixture</h1>"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(
    async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  it("Chromium 缺失时仍可发现和使用 Firefox，指定缺失引擎不 fallback", async () => {
    const firefoxPath = process.env["ZCODE_TEST_FIREFOX_EXECUTABLE"];
    const executor = createConfiguredBrowserExecutor({
      engines: [
        { engine: "chromium", executablePath: "/nonexistent/zcode-test-chromium" },
        { engine: "firefox", ...(firefoxPath ? { executablePath: firefoxPath } : {}) },
      ],
    });
    try {
      const available = await executor.list(scope);
      expect(available.map((item) => item.id)).toEqual(["server-headless-firefox"]);
      const firefox = available[0]!;
      const run = (command: BrowserCommand) =>
        executor.execute({
          ...scope,
          requestId: crypto.randomUUID(),
          browserId: firefox.id,
          browserGeneration: firefox.generation,
          command,
        });
      expect((await run({ method: "navigate", url: origin })).ok).toBe(true);
      const failed = await executor.execute({
        ...scope,
        requestId: "missing",
        browserId: "server-headless-chromium",
        browserGeneration: 1,
        command: { method: "navigate", url: origin },
      });
      expect(failed.error?.code).toBe("backend_unavailable");
      expect((await run({ method: "list" })).tabs).toHaveLength(1);
      expect((await run({ method: "getState" })).state?.title).toBe("Dual fixture");
    } finally {
      await executor.shutdown();
    }
    expect(await executor.list(scope)).toEqual([]);
  }, 60_000);
});
