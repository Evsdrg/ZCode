# 私有部署 WebUI 静态资源压缩

状态：已实施
适用：`packages/server/src/http.ts` 的静态资源分支（`staticRoot`）。桌面、Web 与远程资产下载路径不变。

## 背景与实测

自部署 WebUI 由 `packages/server` 直接托管 `packages/web/dist`。2026-10-18 在
`http://<内网 IP>:<端口>` 实测：

| 指标             | 值      |
| ---------------- | ------- |
| 首屏请求数       | 59      |
| 首屏传输（原始） | 9.47 MB |
| `index-*.js`     | 6.42 MB |
| `index-*.css`    | 443 KB  |

带 `Accept-Encoding: gzip, deflate, br` 请求时响应**没有** `Content-Encoding`：
`app.get("*")` 用 `c.body(await readFile(filePath))` 直接把 Buffer 交给 Hono，
Hono 不做内容协商压缩。

压缩后的体积（同一份产物）：

| 文件               | 原始    | gzip    | brotli  |
| ------------------ | ------- | ------- | ------- |
| `index-*.js`       | 6421 KB | 1802 KB | 1354 KB |
| `index-*.css`      | 443 KB  | 70 KB   | 53 KB   |
| 首屏 59 个文件合计 | 9.47 MB | 2.60 MB | —       |

内网千兆下首屏约 50ms，影响不大；但**手机远控/公网访问的首次加载**要传 9.47MB。
压缩后是 2.60MB（−72%）。

## 产品规则

- 只压缩**可压缩的文本类型**：`.js`、`.mjs`、`.css`、`.html`、`.json`、`.svg`、`.txt`、
  `.map`、`.wasm`。二进制（图片、字体、压缩包）原样输出——它们已经压缩过，再压只会变慢。
- 按 `Accept-Encoding` 做内容协商，优先级 **brotli > gzip**。两者都不支持时输出原始字节。
- 只压缩**大于阈值**的响应（`1024` 字节）。小文件压缩后反而可能更大，且多一次 CPU 开销。
- 保持现有 `Cache-Control` 语义不变：`index.html` 是 `no-cache`，其余是
  `public, max-age=31536000, immutable`。压缩不改变缓存键——`Vary: Accept-Encoding`
  用于区分同一 URL 的不同编码表示。
- 压缩结果按 `路径 + mtime + size` 缓存，避免每个请求重复压缩同一个 bundle。

## 所有者与接口

- **唯一所有者**：`packages/server/src/http.ts` 的静态资源分支。
- 压缩能力抽成独立模块 `packages/server/src/staticAssetCompression.ts`，导出：

  ```ts
  export type StaticAssetEncoding = "br" | "gzip";

  /** 按 Accept-Encoding 选最优编码；不支持或类型不可压缩时返回 null。 */
  export function selectStaticAssetEncoding(
    acceptEncoding: string | undefined,
    filePath: string,
  ): StaticAssetEncoding | null;

  /** 压缩字节；结果进入进程内 LRU 缓存。 */
  export function compressStaticAsset(
    body: Uint8Array,
    encoding: StaticAssetEncoding,
    cacheKey: string,
  ): Promise<Uint8Array>;
  ```

- `http.ts` 的静态分支按以下顺序处理：

  ```text
  resolveStaticFile → stat → 读 header 选编码 → 小于阈值/不可压缩 → 原样返回
                                        ↓ 可压缩
                                   查缓存 → 命中直接返回
                                        ↓ 未命中
                                   zlib 压缩 → 写缓存 → 返回（附 Content-Encoding + Vary）
  ```

- 状态所有权：压缩缓存只属于 HTTP 进程的内存，不落盘、不跨进程共享。文件修改后
  （mtime/size 变化）自然产生新缓存键，旧条目由 LRU 淘汰。

## 边界与不变量

- **不改变** 404/SPA fallback 语义、鉴权中间件顺序、`isTokenProtectedPath` 判定。
- 请求头声明 `Accept-Encoding` 但实际不支持时，必须回原始字节，不能返回空的压缩体。
- `HEAD` 请求沿用同一路径（当前实现走 `app.get("*")`，Node 的 `serve` 会正确处理）。
- 压缩失败（zlib 抛错）时回退到原始字节，不能 500。

## 验收场景

1. `Accept-Encoding: gzip` 请求 `app.js` → 200，`Content-Encoding: gzip`，
   `Vary: Accept-Encoding`，解压后内容与原文一致。
2. `Accept-Encoding: br` 请求同一文件 → 使用 brotli（当文件超过阈值时）。
3. 不带 `Accept-Encoding` → 无 `Content-Encoding`，原始字节。
4. 请求 `.png` / `.woff2` → 即使声明支持编码也不压缩。
5. 小于阈值的文件 → 不压缩。
6. 同一文件连续请求两次 → 第二次命中缓存（不重复压缩）。
7. SPA fallback 与 `/api/missing` 404 行为不变。

验证：`packages/server/test/staticAssetCompression.test.ts` 覆盖纯函数；
`packages/server/test/serverInfoHttp.test.ts` 补充端到端响应头断言；
`pnpm typecheck`、`pnpm lint`、架构检查。

## 实测结果

2026-10-18，用同一份 `packages/web/dist` 起临时 HTTP 服务（与 `http.ts` 静态分支同逻辑），
`curl` 实测：

| 请求                                        | `Content-Encoding` | `Content-Length` |
| ------------------------------------------- | ------------------ | ---------------- |
| `index-*.js` + `Accept-Encoding: gzip`      | `gzip`             | 1,862,126        |
| `index-*.js` + `Accept-Encoding: br, gzip`  | `br`               | 1,390,960        |
| `index-*.js` + `Accept-Encoding: identity`  | 无                 | 6,575,746        |
| `index-*.css` + `Accept-Encoding: br, gzip` | `br`               | 54,699           |

主包：6.58 MB → **1.39 MB（brotli，−79%）**；CSS：443 KB → **53 KB（−88%）**。
所有响应带 `Vary: Accept-Encoding`；`identity` 请求保持原样。

单测：`packages/server/test/staticAssetCompression.test.ts` 15 例、
`packages/server/test/serverInfoHttp.test.ts` 5 例（含 3 例新增端到端）全部通过。

## 已验证的边界

- 小于 `1024` 字节的文件不压缩，返回原始字节；
- `.png` 等二进制即使客户端支持编码也不压缩；
- 客户端声明 `identity` 或缺失 `Accept-Encoding` 时返回原始字节；
- `q=0` 视为显式拒绝；
- 同一文件并发请求共用一次压缩（`inFlightCompression`）；
- zlib 抛错时回退原始字节，不返回 5xx。
