/**
 * 自部署 WebUI 的日志导出。
 *
 * 桌面端 `exportLogs()` 在 Electron main 里打包 zip 并用 `shell.showItemInFolder` 定位；
 * 浏览器没有文件管理器，改为请求 server 的 `/api/logs/export` 并以附件形式下载。
 *
 * 实现选择：先 fetch 拿到完整响应再转 blob 下载，而不是直接 `<a href>` 指向导出 URL。
 * 原因是后者在服务端失败时会让浏览器把 JSON 错误体存成「下载文件」，用户只看到坏掉的
 * zip、拿不到原因；这条路径把错误原因如实返回给调用方（与桌面的 `{success,error}` 一致）。
 *
 * 代价：导出包会完整驻留一次内存。日志包通常几十 MB，浏览器可承受；同时服务端侧本身
 * 也要先落盘打包，内存峰值不只发生在这里。
 *
 * success 只表示「已把下载交给浏览器」——浏览器下载没有完成回执，与 `saveBrowserFile` 一致。
 */

/** 导出接口路径：与 server 的 `createHttpServer` 中注册的路由一致。 */
export const WEB_LOG_EXPORT_ROUTE = "/api/logs/export";

export async function exportLogsInBrowser(): Promise<{
  success: boolean;
  path?: string;
  error?: string;
}> {
  if (typeof document === "undefined" || typeof fetch !== "function") {
    return { success: false, error: "log_export_unavailable" };
  }
  try {
    const response = await fetch(WEB_LOG_EXPORT_ROUTE, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/zip" },
    });
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: unknown) =>
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : undefined,
        )
        .catch(() => undefined);
      return { success: false, error: detail ?? `http_${response.status}` };
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const fileNameMatch = /filename="([^"]+)"/u.exec(disposition);
    const fileName = fileNameMatch?.[1] ?? "zcode-logs.zip";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 与 saveBrowserFile 同策略：下载没有完成回执，保留有界时间供浏览器消费。
    setTimeout(() => URL.revokeObjectURL(url), 40_000);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
