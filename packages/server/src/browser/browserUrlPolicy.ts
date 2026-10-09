/**
 * 托管 headless 浏览器的导航白名单。
 *
 * 自部署形态下模型可驱动 server 所在机器上的真实浏览器，能访问该机器可达的网络
 * （含 localhost 上的其它本机服务）。这里对齐 CLI 托管后端的收紧口径：
 * 只允许 http:、https: 与精确的 about:blank，其它 scheme（file:、data:、javascript:、
 * chrome: 等）一律拒绝。file: 可作为选后端提示但不是可直接导航的目标。
 */
export function isAllowedManagedBrowserUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** 拒绝时抛出、供执行器转成 BrowserCommandResult 失败分支的理由。 */
export function describeDisallowedBrowserUrl(url: string): string {
  return `Navigation is restricted to http(s) URLs (or about:blank); refused: ${url}`;
}
