import { afterEach, describe, expect, it, vi } from "vitest";
import { canReadClipboard, readClipboardText } from "@/lib/clipboardRead.js";

const originalNavigator = globalThis.navigator;

function setClipboard(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { ...originalNavigator, clipboard: value },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

describe("readClipboardText", () => {
  // 私有部署 WebUI 以 HTTP 访问非 localhost 地址时不是安全上下文，navigator.clipboard
  // 为 undefined。此时必须返回 null 而不是抛错，调用方据此走原生 paste 路径。
  it("navigator.clipboard 缺失时返回 null 而非抛错", async () => {
    setClipboard(undefined);
    await expect(readClipboardText()).resolves.toBeNull();
    expect(canReadClipboard()).toBe(false);
  });

  it("clipboard 存在但没有 readText 时返回 null", async () => {
    setClipboard({ writeText: vi.fn() });
    await expect(readClipboardText()).resolves.toBeNull();
    expect(canReadClipboard()).toBe(false);
  });

  it("可用时返回剪贴板文本", async () => {
    setClipboard({ readText: vi.fn(async () => "pasted text") });
    await expect(readClipboardText()).resolves.toBe("pasted text");
    expect(canReadClipboard()).toBe(true);
  });

  it("读取被拒（如文档未聚焦）时按读不到处理", async () => {
    setClipboard({
      readText: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    await expect(readClipboardText()).resolves.toBeNull();
    // 存在 readText 即视为可用：拦截仍然安全，失败只是本次读不到。
    expect(canReadClipboard()).toBe(true);
  });
});
