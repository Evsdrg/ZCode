import { describe, expect, it } from "vitest";
import { resolveHeadlessBrowserConfig } from "./headlessBrowserConfig.js";

describe("resolveHeadlessBrowserConfig", () => {
  it("未启用时不注册且不解释 engine", () => {
    expect(
      resolveHeadlessBrowserConfig({ ZCODE_SERVER_BROWSER_ENGINE: "unknown" }),
    ).toBeUndefined();
    expect(resolveHeadlessBrowserConfig({ ZCODE_SERVER_BROWSER_USE: "other" })).toBeUndefined();
  });

  it("缺省为 Chromium，保留旧 headless 开关", () => {
    expect(resolveHeadlessBrowserConfig({ ZCODE_SERVER_BROWSER_USE: " headless " })).toEqual({
      engine: "chromium",
    });
  });

  it("显式 Firefox 与可执行路径去除首尾空格", () => {
    expect(
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: " firefox ",
        ZCODE_SERVER_BROWSER_EXECUTABLE: " /test/firefox ",
      }),
    ).toEqual({ engine: "firefox", executablePath: "/test/firefox" });
  });

  it("拒绝相对 executablePath，避免启动 cwd 改变实际浏览器", () => {
    expect(() =>
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_EXECUTABLE: "browser/firefox",
      }),
    ).toThrow("absolute path");
  });

  it("双引擎保留旧路径给 Chromium，Firefox 使用自己的默认制品", () => {
    expect(
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: "both",
        ZCODE_SERVER_BROWSER_EXECUTABLE: "/test/chromium",
      }),
    ).toEqual({
      engines: [{ engine: "chromium", executablePath: "/test/chromium" }, { engine: "firefox" }],
    });
  });

  it("双引擎专用路径覆盖旧路径并保持固定顺序", () => {
    expect(
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: " both ",
        ZCODE_SERVER_BROWSER_EXECUTABLE: "/old/chromium",
        ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE: " /test/chromium ",
        ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE: " /test/firefox ",
      }),
    ).toEqual({
      engines: [
        { engine: "chromium", executablePath: "/test/chromium" },
        { engine: "firefox", executablePath: "/test/firefox" },
      ],
    });
  });

  it("单 Firefox 专用路径优先于旧路径", () => {
    expect(
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: "firefox",
        ZCODE_SERVER_BROWSER_EXECUTABLE: "/old/firefox",
        ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE: "/test/firefox",
      }),
    ).toEqual({ engine: "firefox", executablePath: "/test/firefox" });
  });

  it("双模式拒绝专用相对路径", () => {
    expect(() =>
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: "both",
        ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE: "firefox",
      }),
    ).toThrow("ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE");
  });

  it("启用时拒绝不支持的 engine，不静默降级", () => {
    expect(() =>
      resolveHeadlessBrowserConfig({
        ZCODE_SERVER_BROWSER_USE: "headless",
        ZCODE_SERVER_BROWSER_ENGINE: "webkit",
      }),
    ).toThrow("ZCODE_SERVER_BROWSER_ENGINE");
  });
});
