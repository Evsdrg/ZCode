// 浏览器侧固定路径反代（OAuth token 交换 / help 配置）。
//
// 背景：自部署 Web 的 renderer 在普通浏览器里跑，没有 Electron main 的 net.fetch。
// zcode.z.ai 对整个 /api/v1/* 按 Origin 做白名单，浏览器直连会被 403（实测同一 URL
// 无 Origin 200、带部署站 Origin 403），CORS 预检也不会通过。因此由 server 代发。
//
// 这一层必须守住两条边界：
// 1. 只代理白名单路径，不能被调用方当成开放代理（任意 URL 转发）。
// 2. 不透传调用方的 Cookie / Authorization；反代的身份是 server 自己。
import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../src/http.js";
import { createZCodeEndpointProxy, ZCodeEndpointProxyError } from "../src/zcodeEndpointProxy.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function createFakeUpstream(
  handler: (request: CapturedRequest) => { status: number; body: unknown },
): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    const captured = { url, method, headers, body };
    requests.push(captured);
    const result = handler(captured);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

describe("ZCode endpoint proxy", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  function startServer(proxy: ReturnType<typeof createZCodeEndpointProxy>) {
    const server = createHttpServer(new ServiceCollection(), 0, { zcodeEndpointProxy: proxy });
    servers.push(server);
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it("OAuth token 交换被转发到配置的 endpoint，并带来源头", async () => {
    const upstream = createFakeUpstream(() => ({
      status: 200,
      body: { code: 0, data: { token: "test-jwt" } },
    }));
    const proxy = createZCodeEndpointProxy({
      fetch: upstream.fetch,
      resolveEndpointOrigin: async () => "https://example.test",
      buildSourceHeaders: () => ({ "X-Title": "Z Code@electron", "User-Agent": "ZCode/test" }),
    });
    const origin = startServer(proxy);

    const response = await fetch(`${origin}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zai", code: "abc", redirect_uri: "http://x/y", state: "s" }),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ code: 0, data: { token: "test-jwt" } });
    expect(upstream.requests).toHaveLength(1);
    const sent = upstream.requests[0]!;
    expect(sent.url).toBe("https://example.test/api/v1/oauth/token");
    expect(sent.method).toBe("POST");
    // 来源头来自 server 侧构造，不是浏览器带来的。
    expect(sent.headers["x-title"]).toBe("Z Code@electron");
    expect(sent.headers["user-agent"]).toBe("ZCode/test");
    expect(JSON.parse(sent.body)).toMatchObject({ provider: "zai", code: "abc" });
  });

  it("help 配置 GET 保留查询参数", async () => {
    const upstream = createFakeUpstream(() => ({
      status: 200,
      body: { code: 0, data: { configs: { feedbackUrl: { feedback_url: "https://example.test/f" } } } },
    }));
    const proxy = createZCodeEndpointProxy({
      fetch: upstream.fetch,
      resolveEndpointOrigin: async () => "https://example.test",
    });
    const origin = startServer(proxy);

    const response = await fetch(`${origin}/api/v1/client/configs?app_version=3.17.1`);
    expect(response.status).toBe(200);
    expect(upstream.requests[0]!.url).toBe(
      "https://example.test/api/v1/client/configs?app_version=3.17.1",
    );
  });

  it("不透传浏览器的 Cookie 与 Authorization", async () => {
    const upstream = createFakeUpstream(() => ({ status: 200, body: { ok: true } }));
    const proxy = createZCodeEndpointProxy({
      fetch: upstream.fetch,
      resolveEndpointOrigin: async () => "https://example.test",
    });
    const origin = startServer(proxy);

    await fetch(`${origin}/api/v1/client/configs`, {
      headers: {
        cookie: "zcode_lite_token=secret",
        authorization: "Bearer secret",
      },
    });

    const sent = upstream.requests[0]!;
    expect(sent.headers["cookie"]).toBeUndefined();
    expect(sent.headers["authorization"]).toBeUndefined();
  });

  it("非白名单路径不会被代理（不是开放代理）", async () => {
    const upstream = createFakeUpstream(() => ({ status: 200, body: { ok: true } }));
    const proxy = createZCodeEndpointProxy({
      fetch: upstream.fetch,
      resolveEndpointOrigin: async () => "https://example.test",
    });

    await expect(
      proxy({ method: "GET", path: "/api/v1/some-other-endpoint" }),
    ).rejects.toBeInstanceOf(ZCodeEndpointProxyError);
    expect(upstream.requests).toHaveLength(0);
  });

  it("上游不可达时归一成 upstream_unreachable", async () => {
    const proxy = createZCodeEndpointProxy({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      resolveEndpointOrigin: async () => "https://example.test",
    });

    await expect(proxy({ method: "GET", path: "/api/v1/client/configs" })).rejects.toMatchObject({
      reason: "upstream_unreachable",
    });
  });

  it("未配置反代时不注册代理路由", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/oauth/token`, {
      method: "POST",
    });
    // 没有代理时该路径不存在；静态回退/404 均可接受，但绝不应该是 200。
    expect(response.status).not.toBe(200);
  });
});
