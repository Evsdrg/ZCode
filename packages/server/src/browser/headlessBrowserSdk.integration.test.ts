import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserBackendDescriptorSchema,
  browserCommandResultSchema,
  browserCommandSchema,
  type BrowserCommand,
} from "@zcode/shared";
import { createConfiguredBrowserExecutor } from "./managedBrowserRouter.js";

interface SdkTab {
  id: string;
  goto(url: string): Promise<void>;
  playwright: {
    waitForLoadState(options: { state: "domcontentloaded" }): Promise<void>;
    evaluate(expression: string): Promise<unknown>;
    domSnapshot(): Promise<string>;
    getByRole(
      role: string,
      options: { name: string; exact: boolean },
    ): {
      fill(value: string): Promise<void>;
      click(): Promise<void>;
    };
  };
  screenshot(): Promise<Uint8Array>;
}

interface SdkBrowser {
  browserId: string;
  documentation(): Promise<string>;
  tabs: { new: () => Promise<SdkTab>; list(): Promise<Array<{ id: string }>> };
}

const clientPath = process.env["ZCODE_TEST_BROWSER_CLIENT_MODULE"];
const enabled = process.env["ZCODE_BROWSER_INTEGRATION"] === "1" && Boolean(clientPath);

describe.skipIf(!enabled)("installed Browser Use SDK integration", () => {
  it("真实 SDK 同时发现双引擎、默认 Chromium、按 ID 选择且隔离状态", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<title>SDK fixture</title><label>Name<input aria-label=\"Name\"></label><button onclick=\"document.querySelector('p').textContent='Hello '+document.querySelector('input').value\">Apply</button><p role=\"status\">Idle</p>",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
    const firefoxPath = process.env["ZCODE_TEST_FIREFOX_EXECUTABLE"];
    const chromiumPath = process.env["ZCODE_TEST_CHROMIUM_EXECUTABLE"];
    const executor = createConfiguredBrowserExecutor({
      engines: [
        { engine: "chromium", ...(chromiumPath ? { executablePath: chromiumPath } : {}) },
        { engine: "firefox", ...(firefoxPath ? { executablePath: firefoxPath } : {}) },
      ],
    });
    const scope = {
      sessionId: "sdk-fixture",
      workspaceKey: "sdk-fixture",
      workspacePath: "/workspace/fixture",
    };
    const globals: Record<string | symbol, unknown> = {};
    const methods: string[] = [];
    globals[Symbol.for("zcode.node-repl.browser-control-bridge")] = {
      assertAvailable: () => {},
      documentationRoot: resolve(dirname(clientPath!), "../docs"),
      list: async () =>
        (await executor.list(scope)).map((descriptor) =>
          browserBackendDescriptorSchema.parse(JSON.parse(JSON.stringify(descriptor))),
        ),
      execute: async (browserId: string, browserGeneration: number, command: BrowserCommand) => {
        const parsed = browserCommandSchema.parse(JSON.parse(JSON.stringify(command)));
        methods.push(parsed.method);
        const result = await executor.execute({
          ...scope,
          requestId: crypto.randomUUID(),
          browserId,
          browserGeneration,
          command: parsed,
        });
        return browserCommandResultSchema.parse(JSON.parse(JSON.stringify(result)));
      },
    };
    try {
      const module = (await import(pathToFileURL(clientPath!).href)) as {
        setupBrowserRuntime(input: { globals: Record<string | symbol, unknown> }): Promise<void>;
      };
      await module.setupBrowserRuntime({ globals });
      const agent = globals.agent as {
        browsers: {
          list(): Promise<Array<{ id: string; name: string; metadata?: Record<string, string> }>>;
          get(id: string): Promise<SdkBrowser>;
          getDefault(): Promise<SdkBrowser>;
        };
      };
      const available = await agent.browsers.list();
      expect(available).toMatchObject([
        { id: "server-headless-chromium", name: "ZCode Server Headless Chromium" },
        { id: "server-headless-firefox", name: "ZCode Server Headless Firefox" },
      ]);
      expect(available[0]!.metadata?.selectionPolicy).toContain("get(id)");
      expect((await agent.browsers.getDefault()).browserId).toBe("server-headless-chromium");
      const browser = await agent.browsers.get("server-headless-firefox");
      expect(await browser.documentation()).toContain("Firefox");
      expect(await browser.tabs.list()).toEqual([]);
      const tab = await browser.tabs.new();
      await tab.goto(`http://127.0.0.1:${address.port}`);
      await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
      expect(await tab.playwright.domSnapshot()).toContain('button "Apply"');
      await tab.playwright.getByRole("textbox", { name: "Name", exact: true }).fill("SDK");
      await tab.playwright.getByRole("button", { name: "Apply", exact: true }).click();
      expect(await tab.playwright.domSnapshot()).toContain("Hello SDK");
      await tab.playwright.evaluate('document.cookie = "engine=firefox; path=/"');
      const chromium = await agent.browsers.get("server-headless-chromium");
      expect(await chromium.tabs.list()).toEqual([]);
      const chromiumTab = await chromium.tabs.new();
      await chromiumTab.goto(`http://127.0.0.1:${address.port}`);
      await chromiumTab.playwright.waitForLoadState({ state: "domcontentloaded" });
      expect(await chromiumTab.playwright.evaluate("document.cookie")).toBe("");
      expect(await chromiumTab.playwright.domSnapshot()).toContain("Idle");
      await module.setupBrowserRuntime({ globals });
      const fresh = globals.agent as typeof agent;
      const selectedAgain = await fresh.browsers.get("server-headless-firefox");
      expect((await selectedAgain.tabs.list()).map((item) => item.id)).toContain(tab.id);
      expect((await chromium.tabs.list()).map((item) => item.id)).not.toContain(tab.id);
      expect(
        Buffer.from(await tab.screenshot())
          .subarray(0, 8)
          .toString("hex"),
      ).toBe("89504e470d0a1a0a");
      expect(methods).toContain("playwright");
      expect(methods).toContain("screenshot");
    } finally {
      await executor.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);
});
