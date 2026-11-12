/**
 * log-export 对外契约。
 *
 * 这个模块只解决一件事：**浏览器里怎么拿到日志包**。
 *
 * 桌面端 `exportLogs()` 在 Electron main 里收集、脱敏、打包 zip，然后用
 * `shell.showItemInFolder` 把文件管理器定位到产物。浏览器没有文件管理器，因此本模块：
 * - 保留完全相同的收集范围、3 天时间窗与敏感字段脱敏规则（行为一致性）；
 * - 把「打开文件管理器」换成「把 zip 字节交给 HTTP 响应」；
 * - 目录回退（zip 写入失败时）如实上报，不伪装成可下载文件。
 *
 * 不变量：
 * - 导出的内容必须经过 `sanitizeSensitiveLog.ts` 的脱敏，不能直出原始日志。
 * - zip 打包失败时回退目录导出，两者都失败才报错——与桌面端语义一致。
 * - `success` 只表示「已把下载交给浏览器」，浏览器下载没有落盘回执。
 */
export type { LogExportResult, LogExportService } from "./logExportService.js";
export {
  createLogExportService,
  removeLogExportArtifact,
} from "./logExportService.js";
