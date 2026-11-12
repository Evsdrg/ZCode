/**
 * media-preview 对外契约。
 *
 * 这个模块只解决一件事：**本地音视频在浏览器里怎么播**。
 *
 * 背景：`IMediaPreviewService.prepare()` 有两条路径——`local-url`（HTTP Range，可播大文件、
 * 可 seek）与 `inline`（base64，8MB 上限）。桌面端靠 Electron 的 `zcode-media://` 协议走
 * `local-url`；自部署 server 没有自定义协议，于是所有 >8MB 的音频/视频都退化成
 * 「文件过大无法预览」。
 *
 * 契约由三部分组成，缺一不可：
 * 1. `MediaPreviewLeaseStore` —— 授权表。只有 Host 显式登记过的**规范化绝对路径**才可读，
 *    未登记路径一律 404。登记带 TTL 与 LRU 容量上限，避免长期运行下无界增长。
 * 2. `parseMediaByteRange` —— 单区间 Range 解析。音视频 seek 与「moov 在 mdat 之后」的
 *    MP4 元数据探测都依赖 206 + Content-Range，缺了会表现为无法播放/不能拖动进度。
 * 3. `buildServerMediaPreviewUrl` —— 同源 HTTP URL 构造。必须同源：浏览器在另一台机器
 *    访问时，`127.0.0.1` 指向的是浏览器自己而不是 server。
 *
 * 不变量：
 * - URL 里的 `path` 参数**不构成授权**；授权只看 lease store。
 * - `resolve()` 每次都重新 realpath 并比对，防止授权后把文件替换成指向别处的符号链接。
 * - 媒体类型在 authorize 时确定，HTTP 响应不再按扩展名二次推断。
 */
export type {
  MediaPreviewLeaseStore,
} from "./mediaPreviewLeaseStore.js";
export type { MediaByteRange } from "./mediaPreviewRange.js";
export { parseMediaByteRange } from "./mediaPreviewRange.js";
export { SERVER_MEDIA_PREVIEW_ROUTE, buildServerMediaPreviewUrl } from "./mediaPreviewUrl.js";
