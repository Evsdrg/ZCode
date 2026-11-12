/**
 * log-export 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { LogExportService } from "./logExportService.js";

/**
 * 一次完整的日志导出。
 *
 * 关键点：
 * - 必须检查 `format`：zip 才是可下载产物，`directory` 表示 zip 打包失败后回退到目录，
 *   浏览器无法直接下载目录，调用方应把 `path` 作为诊断信息展示而不是当成下载成功。
 * - `success: true` 且 `format: "zip"` 时 `bytes` 一定存在。
 * - 导出可能耗时数十秒（要遍历多个日志目录并逐个脱敏），不要在 UI 主线程同步等待。
 */
export async function exampleExportLogs(
  service: LogExportService,
): Promise<{ downloadReady: boolean; fileName?: string; error?: string }> {
  const result = await service.export();
  if (!result.success) {
    return { downloadReady: false, error: result.error ?? "unknown" };
  }
  if (result.format !== "zip" || !result.bytes) {
    return { downloadReady: false, error: `log export fell back to directory: ${result.path ?? "?"}` };
  }
  return { downloadReady: true, fileName: result.fileName };
}
