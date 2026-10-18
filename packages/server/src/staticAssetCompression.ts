/**
 * 静态资源压缩：自部署 WebUI 由 server 直接托管 `packages/web/dist`，
 * 首屏 59 个文件合计 9.47MB。Hono 的 `c.body(Buffer)` 不做内容协商压缩，
 * 因此需要在这里按 Accept-Encoding 选择编码并压缩。
 *
 * 设计约束见 docs/specs/selfhost-webui-static-asset-compression.md：
 * - 只压缩文本类型；二进制（图片、字体）已压缩过，再压只会变慢。
 * - brotli 优先于 gzip；都不支持时返回 null，调用方原样输出。
 * - 小于阈值的响应不压缩（多一次 CPU 开销且可能变大）。
 * - 压缩结果按「路径 + mtime + size」缓存，避免每个请求重复压缩同一个 bundle。
 */
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { extname } from "node:path";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type StaticAssetEncoding = "br" | "gzip";

/** 小于该大小的响应不做压缩：压缩后的头部开销可能超过收益。 */
export const STATIC_ASSET_COMPRESSION_MIN_BYTES = 1024;

/** 已压缩过的二进制类型不在列表内，避免无意义二次压缩。 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".cjs",
  ".svg",
  ".txt",
  ".wasm",
]);

const COMPRESSION_CACHE_MAX_ENTRIES = 64;
const compressionCache = new Map<string, Uint8Array<ArrayBuffer>>();
/** 同一文件的并发请求共用一次压缩，避免首屏同时打满 CPU。 */
const inFlightCompression = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

export function isCompressibleStaticAsset(filePath: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * 按 Accept-Encoding 选最优编码。
 *
 * 只做最小可用的内容协商：解析 `q=` 权重，显式 `q=0` 视为不支持；
 * `*` 通配符按权重参与。真实浏览器只会发 `gzip, deflate, br` 这类简单串，
 * 这里覆盖该场景并保留正确的 `q=0` 语义即可。
 */
export function selectStaticAssetEncoding(
  acceptEncoding: string | undefined,
  filePath: string,
): StaticAssetEncoding | null {
  if (!isCompressibleStaticAsset(filePath)) {
    return null;
  }
  if (!acceptEncoding) {
    return null;
  }

  const weights = parseAcceptEncoding(acceptEncoding);
  if (weights.get("br") === 0) {
    weights.delete("br");
  }
  if (weights.get("gzip") === 0) {
    weights.delete("gzip");
  }
  // `x-gzip` 是 gzip 的历史别名，部分客户端只发它。
  if (!weights.has("gzip") && weights.has("x-gzip")) {
    weights.set("gzip", weights.get("x-gzip") ?? 1);
  }

  const brotliWeight = weights.get("br");
  const gzipWeight = weights.get("gzip");

  if (brotliWeight === undefined && gzipWeight === undefined) {
    return null;
  }
  if (brotliWeight === undefined) {
    return "gzip";
  }
  if (gzipWeight === undefined) {
    return "br";
  }
  return brotliWeight >= gzipWeight ? "br" : "gzip";
}

function parseAcceptEncoding(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawToken, ...params] = part.split(";");
    const token = rawToken?.trim().toLowerCase();
    if (!token) {
      continue;
    }
    let weight = 1;
    for (const param of params) {
      const [rawKey, rawValue] = param.split("=");
      if (rawKey?.trim().toLowerCase() !== "q" || rawValue === undefined) {
        continue;
      }
      const parsed = Number.parseFloat(rawValue.trim());
      if (Number.isFinite(parsed)) {
        weight = Math.min(1, Math.max(0, parsed));
      }
    }
    weights.set(token, weight);
  }
  return weights;
}

/**
 * 压缩并缓存。`cacheKey` 由调用方按「路径 + mtime + size」生成；
 * 文件改变后自然产生新 key，旧条目由 LRU 淘汰。
 */
export async function compressStaticAsset(
  body: Uint8Array,
  encoding: StaticAssetEncoding,
  cacheKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${encoding}:${cacheKey}`;
  const cached = compressionCache.get(key);
  if (cached) {
    // 命中时刷新 LRU 顺序。
    compressionCache.delete(key);
    compressionCache.set(key, cached);
    return cached;
  }

  const pending = inFlightCompression.get(key);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const compressed = encoding === "br" ? await brotliCompressAsync(body) : await gzipAsync(body);
    // Hono `c.body` 只接受 `Uint8Array<ArrayBuffer>`；zlib 返回的 Buffer 类型参数是
    // `ArrayBufferLike`（可能含 SharedArrayBuffer），拷进独立 ArrayBuffer 收窄类型。
    const result = new Uint8Array(compressed.byteLength);
    result.set(compressed);
    compressionCache.set(key, result);
    trimCache();
    return result;
  })();

  inFlightCompression.set(key, task);
  try {
    return await task;
  } finally {
    inFlightCompression.delete(key);
  }
}

function trimCache(): void {
  while (compressionCache.size > COMPRESSION_CACHE_MAX_ENTRIES) {
    const oldest = compressionCache.keys().next();
    if (oldest.done) {
      return;
    }
    compressionCache.delete(oldest.value);
  }
}

/** 仅用于测试：清空进程内缓存。 */
export function resetStaticAssetCompressionCache(): void {
  compressionCache.clear();
  inFlightCompression.clear();
}
