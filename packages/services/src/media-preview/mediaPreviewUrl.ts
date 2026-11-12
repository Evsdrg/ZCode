/**
 * 自部署形态的本地媒体预览 URL 构造（服务端与 HTTP 路由的唯一事实来源）。
 *
 * 桌面端用自定义协议 `zcode-media://local/preview?path=...`，由 Electron main 的
 * protocol handler 读取；自部署 server 没有自定义协议，改用同源 HTTP 路由：
 * 浏览器解析相对 URL 后自动带同源 Cookie（`/api/*` 受部署 token 保护），
 * 因此远程访问（手机远控、另一台机器）也能命中 server，而不是指向浏览器的 127.0.0.1。
 *
 * 路径以查询参数携带而非路径段：路径里可能含 `/`、空格、中文，放进 query 只需 encode 一次；
 * 真正的授权判断在 lease store（只认已登记的规范化绝对路径），URL 本身不构成授权。
 */
export const SERVER_MEDIA_PREVIEW_ROUTE = "/api/media/preview";

export function buildServerMediaPreviewUrl(path: string): string {
  return `${SERVER_MEDIA_PREVIEW_ROUTE}?path=${encodeURIComponent(path)}`;
}
