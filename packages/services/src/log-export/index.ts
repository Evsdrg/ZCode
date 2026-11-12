/**
 * log-export 模块公开入口。
 *
 * 只导出契约与工厂；脱敏（sanitizeSensitiveLog）、路径过滤（logArchiveFilters）、
 * about 快照（aboutSnapshot）都是 adapters 层内部件，调用方不应直接 import。
 */
export {
  createLogExportService,
  removeLogExportArtifact,
  type LogExportResult,
  type LogExportService,
} from "./contract.js";
export { exportLogs as exportLogsArchive } from "./exportLogs.js";
