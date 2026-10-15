import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardText, ClipboardUnavailableError } from "@/lib/clipboard.js";

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

describe("writeClipboardText", () => {
  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    await writeClipboardText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("propagates the error when navigator.clipboard.writeText rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    setClipboard({ writeText });
    await expect(writeClipboardText("x")).rejects.toThrow("NotAllowedError");
  });

  it("rejects when clipboard is unavailable and the private-deployment gate is off", async () => {
    // 测试构建未注入 __ZCODE_PRIVATE_DEPLOYMENT__，门控为 false → 不走 execCommand 兜底。
    setClipboard(undefined);
    await expect(writeClipboardText("x")).rejects.toBeInstanceOf(ClipboardUnavailableError);
  });

  it("does not fall back to execCommand when the gate is off", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
      writable: true,
    });
    await expect(writeClipboardText("x")).rejects.toBeInstanceOf(ClipboardUnavailableError);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
