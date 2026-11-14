/**
 * log-export 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const logExportModule = {
  id: "log-export",
  // cli-memory-diagnostics：复用其 feedbackLogArchive 生成诊断归档（3.18.1 起该文件归入该模块）。
  requires: ["services", "shared", "cli-memory-diagnostics"],
  provides: ["log-export"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
