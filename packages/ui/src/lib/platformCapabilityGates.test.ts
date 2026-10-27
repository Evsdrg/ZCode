import { describe, expect, it } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import { supportsLocalWindowsCuaEntry } from "@/lib/cuaPlatform.js";

/**
 * 能力门控回归：`executeDesktopCommand` 是 IPlatformService 的**必需**方法，
 * `createWebPlatform` 必须提供一个空实现，因此 `typeof platform.executeDesktopCommand === "function"`
 * 在浏览器里恒为真。若用它当 Windows CUA 能力判据，Windows 上的普通浏览器会被误判成桌面。
 */
describe("supportsLocalWindowsCuaEntry", () => {
  const stubPlatform = (overrides: Partial<IPlatformService>) =>
    ({
      // Web 形态：必需方法全部存在（含空桩），但 canOpenLocalFiles 为 false。
      executeDesktopCommand: () => Promise.resolve(),
      canOpenLocalFiles: false,
      ...overrides,
    }) as Pick<IPlatformService, "canOpenLocalFiles">;

  const withUserAgent = (ua: string, fn: () => void) => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: ua },
    });
    try {
      fn();
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: original,
      });
    }
  };

  it("Windows 桌面（canOpenLocalFiles=true）判定为可用", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", () => {
      expect(supportsLocalWindowsCuaEntry(stubPlatform({ canOpenLocalFiles: true }))).toBe(true);
    });
  });

  it("Windows 浏览器（canOpenLocalFiles=false，但必需方法桩存在）判定为不可用", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", () => {
      expect(supportsLocalWindowsCuaEntry(stubPlatform({ canOpenLocalFiles: false }))).toBe(false);
    });
  });

  it("canOpenLocalFiles 缺失按 false 处理", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", () => {
      expect(supportsLocalWindowsCuaEntry(stubPlatform({}))).toBe(false);
    });
  });

  it("非 Windows 平台一律不可用（macOS UA）", () => {
    withUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", () => {
      expect(supportsLocalWindowsCuaEntry(stubPlatform({ canOpenLocalFiles: true }))).toBe(false);
    });
  });

  it("platform 为 null/undefined 时不可用", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", () => {
      expect(supportsLocalWindowsCuaEntry(null)).toBe(false);
      expect(supportsLocalWindowsCuaEntry(undefined)).toBe(false);
    });
  });
});
