/**
 * 日志导出服务（自部署形态）。
 *
 * 桌面端 `exportLogs()` 的实现在 Electron main 里，唯一与 Electron 绑定的动作是
 * `shell.showItemInFolder(zipPath)`；其余（收集、脱敏、打包成 zip、回退目录）全是纯 Node。
 * 自部署 server 没有 Electron，因此把纯 Node 部分搬到 services，由本服务以「返回 zip 字节」
 * 的形式对外提供，浏览器侧用普通下载保存。
 *
 * 与桌面端的行为差异（有意）：
 * - 不自动打开系统文件管理器（浏览器无法定位下载后的文件）；
 * - 返回 `fileName` + `bytes`，由 HTTP 路由作为下载响应回给浏览器。
 *
 * 其余语义保持一致：同样的收集范围（应用数据目录 + `~/.zcode/cli/log` + CUA helper 日志）、
 * 同样的 3 天时间窗、同样的敏感字段脱敏规则、zip 失败时回退目录导出。
 */
import { readFile, rm } from "node:fs/promises";
import { createFeedbackLogArchiveFromExportLogs, exportLogs } from "./exportLogs.js";
import { getAppConfigDir } from "#src/paths.js";

export interface LogExportResult {
  success: boolean;
  /** 下载文件名（如 `zcode-logs-20261109-101530.zip`）。 */
  fileName?: string;
  /** zip 字节；仅在 success 且 format=zip 时存在。 */
  bytes?: Uint8Array;
  /** 产物是 zip 还是目录回退（目录回退无法作为下载响应，此时只有 path）。 */
  format?: "zip" | "directory";
  /** 服务端落盘路径（诊断用；目录回退时浏览器无法直接下载）。 */
  path?: string;
  error?: string;
}

export interface LogExportService {
  export(): Promise<LogExportResult>;
  createFeedbackArchive(): Promise<{ path: string; size: number }>;
}

export function createLogExportService(): LogExportService {
  return {
    async export() {
      const result = await exportLogs();
      if (!result.success || !result.path) {
        return { success: false, ...(result.error ? { error: result.error } : {}) };
      }
      // 目录回退路径（zip 写入失败时）没有单文件可下载；如实报告，让调用方提示用户。
      if (!result.path.toLowerCase().endsWith(".zip")) {
        return { success: true, format: "directory", path: result.path };
      }
      try {
        const bytes = await readFile(result.path);
        return {
          success: true,
          format: "zip",
          path: result.path,
          fileName: result.path.split(/[\\/]/u).pop() ?? "zcode-logs.zip",
          bytes: new Uint8Array(bytes),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async createFeedbackArchive() {
      // 与桌面端 desktopHostProcess 的同名路径一致：把应用数据目录交给反馈归档器。
      const result = await createFeedbackLogArchiveFromExportLogs(getAppConfigDir());
      return result;
    },
  };
}

/** 测试与清理钩子：删除导出产物（导出目录可能含大量文件）。 */
export async function removeLogExportArtifact(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
