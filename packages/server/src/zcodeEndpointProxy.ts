/**
 * ZCode endpoint 的浏览器侧反代。
 *
 * 背景：自部署 Web 把 Electron 的 renderer 拆出来在普通浏览器里跑，但 renderer 里有几处
 * 是「浏览器直接连 zcode.z.ai」的写法（OAuth token 交换、help/feedback 配置）。Electron
 * 里这些请求走 main 进程的 `net.fetch`，属 Node 侧、没有同源策略；浏览器里则会被
 * zcode.z.ai 的 Origin 白名单直接 403（实测：同一 URL 无 Origin 200，带部署站 Origin 403），
 * 且 CORS 预检也不会通过。
 *
 * 因此由 server 代发这些请求：server 与 zcode.z.ai 之间是进程间调用，不含 Origin，
 * 也就能复用 server 自己那套出口（HTTP 代理 / 自定义 CA / 来源头）。
 *
 * 安全边界：
 * - 只允许固定的路径白名单，不接受调用方指定任意 URL（避免变成开放代理）。
 * - 不把上游的 Set-Cookie 透传回浏览器；上游凭据只留在 JSON 响应体里。
 * - 路由本身仍受 server 的 `/api/` 鉴权中间件保护。
 */

/** 允许反代的固定上游路径。新增路径必须在这里显式登记。 */
const ALLOWED_PROXY_PATHS = new Set(["/api/v1/oauth/token", "/api/v1/client/configs"]);

export interface ZCodeEndpointProxyOptions {
  /** 与 server 自身 API 调用同一出口，含设置里的 HTTP 代理与自定义 CA。 */
  fetch: typeof fetch;
  /** 解析当前 ZCode endpoint origin（含设置里的覆盖）。 */
  resolveEndpointOrigin: () => Promise<string>;
  /** 构造 ZCode 来源头；缺失时只带最小头。 */
  buildSourceHeaders?: () => Record<string, string>;
}

export interface ZCodeEndpointProxyRequest {
  method: "GET" | "POST";
  /** 必须是 ALLOWED_PROXY_PATHS 中的一项。 */
  path: string;
  /** 原样转发的查询串（含前导 `?`），为空表示无查询。 */
  search?: string;
  /** 请求体（仅 POST）。 */
  body?: string;
}

export class ZCodeEndpointProxyError extends Error {
  constructor(
    readonly reason: "path_not_allowed" | "invalid_request" | "upstream_unreachable",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ZCodeEndpointProxyError";
  }
}

export function createZCodeEndpointProxy(options: ZCodeEndpointProxyOptions) {
  return async function forward(
    request: ZCodeEndpointProxyRequest,
  ): Promise<{ status: number; contentType: string; body: ArrayBuffer }> {
    if (!ALLOWED_PROXY_PATHS.has(request.path)) {
      throw new ZCodeEndpointProxyError("path_not_allowed", `Path ${request.path} is not proxied`);
    }
    const endpointOrigin = (await options.resolveEndpointOrigin()).trim().replace(/\/+$/u, "");
    if (!endpointOrigin) {
      throw new ZCodeEndpointProxyError("invalid_request", "ZCode endpoint origin is empty");
    }

    const target = new URL(`${endpointOrigin}${request.path}`);
    if (request.search) {
      // 直接把上游查询参数搬过来；不用 URLSearchParams 重新编码，避免 app_version 之类
      // 的值被二次转义。
      for (const [key, value] of new URLSearchParams(request.search).entries()) {
        target.searchParams.set(key, value);
      }
    }

    const headers = new Headers(options.buildSourceHeaders?.() ?? {});
    // 上游按 JSON 路由解析；OAuth token 交换是 POST，help config 是 GET。
    if (request.method === "POST") {
      headers.set("Content-Type", "application/json");
    }
    // 不接受调用方传来的 Cookie / Authorization：反代的身份是 server 自己，
    // 透传用户凭据只会让上游把两者混在一起。
    headers.delete("cookie");
    headers.delete("authorization");

    let response: Response;
    try {
      response = await options.fetch(target, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "manual",
      });
    } catch (error) {
      throw new ZCodeEndpointProxyError(
        "upstream_unreachable",
        `Failed to reach ZCode endpoint: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: await response.arrayBuffer(),
    };
  };
}
