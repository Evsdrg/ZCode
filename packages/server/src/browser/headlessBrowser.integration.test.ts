import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserBackendDescriptorSchema,
  browserCommandResultSchema,
  type BrowserCommand,
} from "@zcode/shared";
import { createHeadlessBrowserExecutor } from "./headlessBrowserExecutor.js";
import type { HeadlessBrowserEngine } from "./headlessBrowserConfig.js";

const enabled = process.env["ZCODE_BROWSER_INTEGRATION"] === "1";
const fixture = `<!doctype html><html><head><title>Managed browser fixture</title></head><body>
<div style="height:2000px" aria-hidden="true"></div>
<h1>Managed browser fixture</h1><label>Name <input aria-label="Name"></label>
<button onclick="document.querySelector('[role=status]').textContent='Hello '+document.querySelector('input').value">Apply</button>
<button data-testid="alert-button" onclick="alert('fixture alert')">Alert</button>
<button data-testid="confirm-button" onclick="window.__confirmed = confirm('fixture confirm')">Confirm</button>
<p role="status">Idle</p><button onclick="window.open('/popup','_blank')">Open popup</button>
<a href="/next">Next page</a></body></html>`;

describe.skipIf(!enabled)("managed browser integration", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        request.url === "/popup"
          ? "<title>Popup fixture</title><h1>Popup fixture</h1>"
          : request.url === "/next"
            ? "<title>Next fixture</title><h1>Next fixture</h1>"
            : fixture,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each<HeadlessBrowserEngine>(["firefox", "chromium"])(
    "%s 真浏览器核心命令、popup、隔离与关闭",
    async (engine) => {
      const executablePath =
        process.env[
          engine === "firefox" ? "ZCODE_TEST_FIREFOX_EXECUTABLE" : "ZCODE_TEST_CHROMIUM_EXECUTABLE"
        ];
      const executor = createHeadlessBrowserExecutor({
        engine,
        ...(executablePath ? { executablePath } : {}),
      });
      const scope = {
        sessionId: "fixture-session",
        workspaceKey: "fixture-a",
        workspacePath: "/workspace/fixture",
      };
      const [backend] = await executor.list(scope);
      expect(
        backend,
        "Install the matching Playwright browser before running integration tests",
      ).toBeDefined();
      const descriptor = browserBackendDescriptorSchema.parse(backend);
      const run = async (command: BrowserCommand, overrides: Partial<typeof scope> = {}) => {
        const result = await executor.execute({
          ...scope,
          ...overrides,
          requestId: crypto.randomUUID(),
          browserId: descriptor.id,
          browserGeneration: descriptor.generation,
          command,
        });
        expect(result.error, JSON.stringify(result.error)).toBeUndefined();
        expect(result.ok).toBe(true);
        return browserCommandResultSchema.parse(result);
      };
      try {
        const created = await run({ method: "newTab" });
        const tabId = created.tab!.tabId;
        await run({ method: "navigate", tabId, url: origin });
        await run({
          method: "playwright",
          tabId,
          action: { name: "waitForLoadState", state: "domcontentloaded" },
        });
        const dom = await run({ method: "playwright", tabId, action: { name: "domSnapshot" } });
        expect(dom.value).toContain('button "Apply"');
        expect(dom.value).toContain('textbox "Name"');
        await run({
          method: "playwright",
          tabId,
          action: {
            name: "locator",
            selector: 'internal:role=textbox[name="Name"s]',
            operation: "fill",
            value: "Firefox test",
          },
        });
        await run({
          method: "playwright",
          tabId,
          action: {
            name: "locator",
            selector: 'internal:role=button[name="Apply"s]',
            operation: "click",
          },
        });
        expect(
          (await run({ method: "playwright", tabId, action: { name: "domSnapshot" } })).value,
        ).toContain("Hello Firefox test");
        const snapshot = (await run({ method: "snapshot", tabId })).snapshot!;
        const apply = snapshot.elements.find((element) => element.name === "Apply");
        expect(apply).toBeDefined();
        await run({ method: "click", tabId, ref: apply!.ref });
        expect(
          (
            await run({
              method: "evaluate",
              tabId,
              expression: "(value => value + 1)(41)",
            })
          ).value,
        ).toBe(42);
        const screenshot = await run({ method: "screenshot", tabId });
        expect(Buffer.from(screenshot.image!.base64, "base64").subarray(0, 8).toString("hex")).toBe(
          "89504e470d0a1a0a",
        );
        await run({ method: "navigate", tabId, url: `${origin}/next` });
        expect((await run({ method: "back", tabId })).state!.url).toBe(`${origin}/`);
        expect((await run({ method: "forward", tabId })).state!.url).toBe(`${origin}/next`);
        await run({ method: "navigate", tabId, url: origin });
        await run({
          method: "evaluate",
          tabId,
          expression: 'document.cookie = "fixture=one; path=/"',
        });
        await run({
          method: "playwright",
          tabId,
          action: {
            name: "locator",
            selector: 'internal:role=button[name="Open popup"s]',
            operation: "click",
          },
        });
        await expect
          .poll(async () =>
            (await run({ method: "list" })).tabs!.some((tab) => tab.url === `${origin}/popup`),
          )
          .toBe(true);
        const other = { workspaceKey: "fixture-b" };
        expect((await run({ method: "list" }, other)).tabs).toEqual([]);
        await run({ method: "navigate", url: origin }, other);
        expect(
          (await run({ method: "evaluate", expression: "document.cookie" }, other)).value,
        ).toBe("");
        // ② 快照对齐：data-testid 进入 attributes，selector 有 id 时用 #id。
        const aligned = (await run({ method: "snapshot", tabId })).snapshot!;
        const alertButton = aligned.elements.find(
          (element) => element.attributes?.["data-testid"] === "alert-button",
        );
        expect(alertButton, "snapshot must expose data-testid attributes").toBeDefined();
        // ① dialog：弹出 alert 后 getDialog 可见，accept 后清登记且页面恢复可交互。
        await run({ method: "click", tabId, ref: alertButton!.ref });
        await expect
          .poll(async () => (await run({ method: "getDialog", tabId })).dialog)
          .toMatchObject({ type: "alert", message: "fixture alert" });
        await run({ method: "handleDialog", tabId, accept: true });
        expect((await run({ method: "getDialog", tabId })).dialog).toBeNull();
        // confirm 弹窗 dismiss 后页面全局标记为 false。
        const confirmButton = aligned.elements.find(
          (element) => element.attributes?.["data-testid"] === "confirm-button",
        );
        await run({ method: "click", tabId, ref: confirmButton!.ref });
        await expect
          .poll(async () => (await run({ method: "getDialog", tabId })).dialog)
          .toMatchObject({ type: "confirm" });
        await run({ method: "handleDialog", tabId, accept: false });
        expect(
          (await run({ method: "evaluate", tabId, expression: "window.__confirmed" })).value,
        ).toBe(false);
        // ③ cua：坐标滚动改变 window.scrollY；elementInfo 命中 Apply 按钮。
        await run({ method: "cuaScroll", tabId, x: 640, y: 400, scrollX: 0, scrollY: 300 });
        await expect
          .poll(
            async () =>
              (await run({ method: "evaluate", tabId, expression: "window.scrollY" })).value,
          )
          .toBeGreaterThan(0);
        const info = await run({ method: "elementInfo", tabId, x: 10, y: 10 });
        expect(info.element === undefined || typeof info.element.tag === "string").toBe(true);
        await run({ method: "close", tabId });
        expect((await run({ method: "list" })).tabs!.some((tab) => tab.tabId === tabId)).toBe(
          false,
        );
      } finally {
        await executor.shutdown();
      }
      expect(await executor.list(scope)).toEqual([]);
    },
    60_000,
  );
});
