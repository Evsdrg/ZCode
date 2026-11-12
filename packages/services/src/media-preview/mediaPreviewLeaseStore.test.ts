import { describe, expect, it, vi } from "vitest";
import { createMediaPreviewLeaseStore } from "./mediaPreviewLeaseStore.js";
import { parseMediaByteRange } from "./mediaPreviewRange.js";
import { buildServerMediaPreviewUrl, SERVER_MEDIA_PREVIEW_ROUTE } from "./mediaPreviewUrl.js";

function createStore(overrides: {
  now?: () => number;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
  ttlMs?: number;
  maxEntries?: number;
  maxFileBytes?: number;
} = {}) {
  return createMediaPreviewLeaseStore({
    realpath: overrides.realpath ?? (async (path: string) => path),
    stat: overrides.stat ?? (async () => ({ isFile: () => true, size: 1024 })),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides.maxEntries !== undefined ? { maxEntries: overrides.maxEntries } : {}),
    ...(overrides.maxFileBytes !== undefined ? { maxFileBytes: overrides.maxFileBytes } : {}),
  });
}

describe("createMediaPreviewLeaseStore", () => {
  it("登记后可在有效期内复核通过", async () => {
    const store = createStore();
    const canonical = await store.authorize("/tmp/video.mp4", "video/mp4");
    expect(canonical).toBe("/tmp/video.mp4");
    expect(store.size()).toBe(1);

    const resolved = await store.resolve("/tmp/video.mp4");
    expect(resolved).toEqual({ canonicalPath: "/tmp/video.mp4", size: 1024, mediaType: "video/mp4" });
  });

  it("未登记的路径一律拒绝（URL 里的 path 不构成授权）", async () => {
    const store = createStore();
    await store.authorize("/tmp/video.mp4", "video/mp4");
    expect(await store.resolve("/etc/passwd")).toBeNull();
  });

  it("非绝对路径直接拒绝", async () => {
    const store = createStore();
    await expect(store.authorize("video.mp4", "video/mp4")).rejects.toThrow(
      "Local media preview path must be absolute",
    );
  });

  it("非常规文件（目录等）拒绝", async () => {
    const store = createStore({
      stat: async () => ({ isFile: () => false, size: 0 }),
    });
    await expect(store.authorize("/tmp/dir.mp4", "video/mp4")).rejects.toThrow(
      "Path is not a media file",
    );
  });

  it("超过单文件上限拒绝", async () => {
    const store = createStore({
      stat: async () => ({ isFile: () => true, size: 100 }),
      maxFileBytes: 50,
    });
    await expect(store.authorize("/tmp/big.mp4", "video/mp4")).rejects.toThrow(
      "Media file is too large for preview",
    );
  });

  it("超过 TTL 后失效", async () => {
    let now = 1_000;
    const store = createStore({ now: () => now, ttlMs: 100 });
    await store.authorize("/tmp/video.mp4", "video/mp4");
    now = 1_050;
    expect(await store.resolve("/tmp/video.mp4")).not.toBeNull();
    now = 1_101;
    expect(await store.resolve("/tmp/video.mp4")).toBeNull();
  });

  it("授权后文件被替换成符号链接（realpath 变化）即失效", async () => {
    let realpathValue = "/tmp/video.mp4";
    const store = createStore({
      realpath: async () => realpathValue,
    });
    await store.authorize("/tmp/video.mp4", "video/mp4");
    realpathValue = "/etc/passwd";
    expect(await store.resolve("/tmp/video.mp4")).toBeNull();
  });

  it("LRU 淘汰：超过 maxEntries 时移除最久未访问的条目", async () => {
    let now = 1_000;
    const store = createStore({ now: () => now, maxEntries: 2 });
    await store.authorize("/tmp/a.mp4", "video/mp4");
    now = 1_010;
    await store.authorize("/tmp/b.mp4", "video/mp4");
    now = 1_020;
    await store.resolve("/tmp/a.mp4"); // a 变成最近访问
    now = 1_030;
    await store.authorize("/tmp/c.mp4", "video/mp4"); // 触发淘汰，应淘汰 b
    expect(await store.resolve("/tmp/a.mp4")).not.toBeNull();
    expect(await store.resolve("/tmp/b.mp4")).toBeNull();
    expect(await store.resolve("/tmp/c.mp4")).not.toBeNull();
  });

  it("clear() 清空全部授权", async () => {
    const store = createStore();
    await store.authorize("/tmp/video.mp4", "video/mp4");
    store.clear();
    expect(await store.resolve("/tmp/video.mp4")).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("resolve 每次重新校验 realpath 与文件类型，不只信初始快照", async () => {
    const realpathSpy = vi.fn(async (path: string) => path);
    const statSpy = vi.fn(async () => ({ isFile: () => true, size: 1024 }));
    const store = createStore({ realpath: realpathSpy, stat: statSpy });
    await store.authorize("/tmp/video.mp4", "video/mp4");
    await store.resolve("/tmp/video.mp4");
    // authorize 1 次 + resolve 1 次
    expect(realpathSpy).toHaveBeenCalledTimes(2);
    expect(statSpy).toHaveBeenCalledTimes(2);
  });
});

describe("parseMediaByteRange", () => {
  const size = 1000;

  it("无 Range 头返回 undefined（全量 200）", () => {
    expect(parseMediaByteRange(undefined, size)).toBeUndefined();
    expect(parseMediaByteRange("", size)).toBeUndefined();
  });

  it("解析闭区间", () => {
    expect(parseMediaByteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
  });

  it("解析开区间（end 缺省到文件末尾）", () => {
    expect(parseMediaByteRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
  });

  it("解析后缀区间", () => {
    expect(parseMediaByteRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("end 超过文件大小时收敛到末尾", () => {
    expect(parseMediaByteRange("bytes=0-99999", size)).toEqual({ start: 0, end: 999 });
  });

  it("多区间 / 非 bytes 单位 / 空区间判为非法", () => {
    expect(parseMediaByteRange("bytes=0-99,200-299", size)).toBe("invalid");
    expect(parseMediaByteRange("items=0-99", size)).toBe("invalid");
    expect(parseMediaByteRange("bytes=-", size)).toBe("invalid");
  });

  it("越界起点、end < start、负值判为非法", () => {
    expect(parseMediaByteRange("bytes=1000-", size)).toBe("invalid");
    expect(parseMediaByteRange("bytes=500-100", size)).toBe("invalid");
    expect(parseMediaByteRange("bytes=-0", size)).toBe("invalid");
  });

  it("空文件任何 Range 都非法", () => {
    expect(parseMediaByteRange("bytes=0-0", 0)).toBe("invalid");
  });
});

describe("buildServerMediaPreviewUrl", () => {
  it("使用同源 HTTP 路由而不是 zcode-media 自定义协议", () => {
    const url = buildServerMediaPreviewUrl("/tmp/a b/视频.mp4");
    expect(url.startsWith(`${SERVER_MEDIA_PREVIEW_ROUTE}?path=`)).toBe(true);
    expect(url).not.toContain("zcode-media");
  });

  it("路径中的特殊字符被正确编码，可被 URLSearchParams 还原", () => {
    const original = "/tmp/a b/视频 #1.mp4";
    const url = buildServerMediaPreviewUrl(original);
    const parsed = new URL(url, "http://example.test");
    expect(parsed.pathname).toBe(SERVER_MEDIA_PREVIEW_ROUTE);
    expect(parsed.searchParams.get("path")).toBe(original);
  });
});
