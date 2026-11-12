/**
 * media-preview 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { MediaPreviewLeaseStore } from "./mediaPreviewLeaseStore.js";
import { buildServerMediaPreviewUrl, SERVER_MEDIA_PREVIEW_ROUTE } from "./mediaPreviewUrl.js";

/**
 * 一次完整的本地视频预览登记 + URL 构造。
 *
 * 关键点：
 * - `authorize()` 只接受**绝对路径**且必须是常规文件；相对路径、目录、超限文件都会抛错。
 * - 返回的是 realpath 规范化后的路径，后续 `resolve()` 必须用同一路径比对。
 * - URL 必须由 `buildServerMediaPreviewUrl` 生成：它返回同源相对路径，
 *   浏览器换机器访问也能命中 server（写成 `127.0.0.1` 只在本机可用）。
 */
export async function examplePrepareLocalVideo(
  store: MediaPreviewLeaseStore,
  videoPath: string,
): Promise<{ url: string; canonicalPath: string }> {
  const canonicalPath = await store.authorize(videoPath, "video/mp4");
  const url = buildServerMediaPreviewUrl(canonicalPath);
  if (!url.startsWith(SERVER_MEDIA_PREVIEW_ROUTE)) {
    throw new Error("media preview url must stay on the same-origin route");
  }
  return { url, canonicalPath };
}
