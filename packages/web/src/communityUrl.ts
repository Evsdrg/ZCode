import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildHelpAppConfigUrl,
  createHelpAppConfigReader,
  resolveHelpAppConfig,
  type Locale,
} from "@zcode/shared";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

interface ResolveWebCommunityUrlOptions {
  fetchImpl?: typeof fetch;
  localConfig?: unknown;
  endpointOrigin?: string;
}

/** 同源反代路径：由自部署 server 代发到当前配置的 ZCode endpoint。 */
const HELP_CONFIG_PROXY_PATH = "/api/v1/client/configs";

/**
 * 自部署 Web 的 help/feedback 配置读取。
 *
 * 为什么不能直连：renderer 在普通浏览器里跑，没有 Electron main 的 `net.fetch`。
 * zcode.z.ai 对 `/api/v1/*` 按 Origin 做白名单，浏览器直连会被 403（实测同一 URL
 * 无 Origin 200、带部署站 Origin 403），CORS 预检也不会通过。
 *
 * 因此浏览器侧只请求**同源**的 `/api/v1/client/configs`，由 server 的固定路径反代
 * 代发到当前配置的 endpoint（见 packages/server/src/zcodeEndpointProxy.ts）。
 * - `credentials: "include"`：该路径在自部署 server 上受 token 保护，需要带上鉴权 cookie。
 * - 不再传 `endpointOrigin`：反代目标由 server 侧设置决定；旧参数只保留给桌面 e2e 的
 *   注入式替身使用（见 resolveWebHelpConfig 的 fetchImpl 分支）。
 */
const readHelpConfig = createHelpAppConfigReader({
  fetchImpl: (input, init) => fetch(input, init),
  credentials: "include",
});

function readWithInjectedFetch(fetchImpl: typeof fetch) {
  // 注入 fetch 的调用方（e2e 替身、单测）自己负责目标地址与凭据语义。
  return createHelpAppConfigReader({ fetchImpl });
}

export async function resolveWebHelpConfig(options: ResolveWebCommunityUrlOptions = {}) {
  let url: string;
  if (options.fetchImpl) {
    // 注入式路径保留旧语义：按调用方给的 endpoint 直连（测试替身里的同源 server）。
    const env = import.meta.env;
    const endpoint =
      options.endpointOrigin ??
      (env?.VITE_ZCODE_BASE_URL?.trim() ||
        env?.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
        DEFAULT_ZCODE_ENDPOINT_ORIGIN);
    url = buildHelpAppConfigUrl(endpoint, ZCODE_VERSION);
  } else if (options.endpointOrigin) {
    // 显式指定 endpoint 时仍按该 endpoint 构造 URL：给跨源自测留出可验证入口。
    url = buildHelpAppConfigUrl(options.endpointOrigin, ZCODE_VERSION);
  } else {
    // 生产路径：同源反代。不上报 platform（服务端拒绝 platform=web）。
    url = HELP_CONFIG_PROXY_PATH;
  }

  let remote: unknown;
  try {
    remote = await (options.fetchImpl ? readWithInjectedFetch(options.fetchImpl) : readHelpConfig)(
      url,
    );
  } catch {
    // 远端不可用时保留内置入口，不使用旧 CDN 作为第二个远端配置源。
  }
  return resolveHelpAppConfig(remote, options.localConfig ?? localDefaultAppConfig);
}

export async function resolveWebCommunityUrl(
  locale: Locale,
  options: ResolveWebCommunityUrlOptions = {},
): Promise<string | undefined> {
  return (await resolveWebHelpConfig(options)).community_urls?.[locale];
}
