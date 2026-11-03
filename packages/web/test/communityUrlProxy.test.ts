// 自部署 Web 的 help/feedback 配置读取必须走同源反代，不能直连 zcode.z.ai。
//
// 回归背景：renderer 在普通浏览器里跑，没有 Electron main 的 net.fetch。
// zcode.zai 对 /api/v1/* 按 Origin 做白名单，浏览器直连会被 403
// （实测同一 URL 无 Origin 200、带部署站 Origin 403），CORS 预检也不会过。
// 因此生产路径必须只请求同源 /api/v1/client/configs，由 server 代发。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; credentials?: string }> = [];
let originalFetch: typeof fetch;
let currentHandler: (url: string) => unknown = () => undefined;

function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, credentials: init?.credentials });
    const body = currentHandler(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const FEEDBACK_ENVELOPE = {
  code: 0,
  data: {
    configs: {
      feedbackUrl: {
        feedback_url: "https://example.test/feedback",
        community_urls: {
          "zh-CN": "https://example.test/community-zh",
          "en-US": "https://example.test/community-en",
        },
      },
    },
  },
};

// communityUrl 内部有一个按 URL 缓存 60 分钟的 reader，且它在模块加载时就构造好了。
// 每个用例必须拿一份全新的模块实例，否则命中上一条用例的缓存。
async function loadFreshModule() {
  vi.resetModules();
  return import("../src/communityUrl.js");
}

beforeEach(() => {
  calls.length = 0;
  currentHandler = () => undefined;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Web help/feedback 配置读取", () => {
  it("生产路径只请求同源反代，不直连 zcode.z.ai", async () => {
    currentHandler = () => FEEDBACK_ENVELOPE;
    const { resolveWebHelpConfig } = await loadFreshModule();

    const config = await resolveWebHelpConfig();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/v1/client/configs");
    // 自部署 server 的 /api/ 受 token 保护，必须带上鉴权 cookie。
    expect(calls[0]!.credentials).toBe("include");
    expect(config.feedback_url).toBe("https://example.test/feedback");
  });

  it("社区链接按 locale 从同源反代结果解析", async () => {
    currentHandler = () => FEEDBACK_ENVELOPE;
    const { resolveWebCommunityUrl } = await loadFreshModule();

    expect(await resolveWebCommunityUrl("zh-CN")).toBe("https://example.test/community-zh");
    expect(await resolveWebCommunityUrl("en-US")).toBe("https://example.test/community-en");
    // 两次调用命中同一个 60 分钟缓存，不应重复打请求。
    expect(calls).toHaveLength(1);
  });

  it("反代失败时回退到内置入口，不抛错", async () => {
    currentHandler = () => undefined; // 404
    const { resolveWebHelpConfig } = await loadFreshModule();

    const config = await resolveWebHelpConfig();
    // 内置配置里有默认值；关键是不抛错且不产生第二个远端源。
    expect(typeof config.feedback_url === "string" || config.feedback_url === undefined).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/v1/client/configs");
  });

  it("显式注入 fetchImpl 时保留旧语义（供 e2e 替身使用）", async () => {
    const injected: string[] = [];
    const injectedFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      injected.push(url);
      return new Response(JSON.stringify(FEEDBACK_ENVELOPE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { resolveWebHelpConfig } = await loadFreshModule();

    await resolveWebHelpConfig({
      fetchImpl: injectedFetch,
      endpointOrigin: "http://127.0.0.1:9999",
    });

    expect(injected).toHaveLength(1);
    // 版本号来自构建常量，测试环境是 0.0.0-dev；只断言路径与参数键。
    expect(injected[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/api\/v1\/client\/configs\?app_version=/u,
    );
  });
});
