/**
 * 日志归档的路径过滤规则：哪些路径不导出、哪些只保留近 3 天。
 *
 * 从 desktop 的 exportLogs.ts 抽出。判断顺序是「先排除（凭据/缓存/高体积运行态），
 * 再按 mtime 收敛日志类文件」——排障配置不参与时间过滤，避免久未修改但影响当前行为的配置丢失。
 */
import { stat } from "node:fs/promises";

export interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

export interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

export function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * Glob patterns to exclude from the exported log archive.
 * Each pattern is relative to the source directory being archived.
 */
const ZIP_EXCLUDE_PATTERNS: string[] = [];

export const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);
export const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
export const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  "repo-snapshots",
  "repo-wiki",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
export const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
export const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);
export const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function isExcludedCachePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return (
    normalizedRelativePath === "Library/Caches" ||
    normalizedRelativePath.startsWith("Library/Caches/")
  );
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  const firstSegment = normalizedRelativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return NON_LOG_STATE_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  const fileName = normalizedRelativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  return normalizedRelativePath
    .split("/")
    .some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // 完整日志导出过去只做内容脱敏，仍会把 credentials.json 文件本身放进包。
  // 凭据存储文件不是排障日志，且不同提供商可能复用同名文件；因此在收集清单阶段按文件名跳过。
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // debug 目录通常是模型/运行时高频轨迹，不是用户要交付的日志包材料。
  // 过去显式收集 ~/.zcode/cli/debug 会把这类上下文带进手动导出和反馈完整日志，这里按目录段统一跳过。
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev 保存 stdio-traffic 等高频协议流，真实机器上会累计到 GB 级。
  // 远超反馈附件的大小上限，不应随诊断包带出。
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // docshot 历史备份和素材目录体积可达 GB 级，
  // 且不属于用户反馈所需的诊断日志。
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ACP runtime 目录已退役，老用户数据里仍可能残留数百 MB 抓包和旧鉴权文件。
  // 当前运行态配置已经迁到 agent-config；继续导出这些旧目录会让导出长时间无反馈，还可能带出旧代理证书私钥。
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  // Library/Caches 是运行时缓存，不是排障所需日志；导出它只会放大日志包。
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }

  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

export async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // 导出日志过去按目录全量打包，长时间运行后旧 diagnostics 会把日志包放大到数百 MB。
    // 这里仅对“可由时间窗口复现现场”的日志类文件按 mtime 保留近 3 天；
    // settings 等排障配置不参与过滤，避免久未修改但仍影响当前行为的配置丢失。
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}
