/**
 * 日志导出用的 about 快照（纯 Node，无 Electron 依赖）。
 *
 * 从 `packages/desktop/src/main/about.ts` 的纯函数部分抽出来，供 services 的日志导出复用。
 * 差异有两点，都是必要的：
 * 1. 不读 `import.meta.dirname/../metadata/build-meta.json`——services 可能被 server 打包，
 *    相对路径没有意义；改由调用方显式传入 `buildMetadataPath`（server 传 undefined 即回落
 *    编译时常量，与桌面端缺文件时的行为一致）。
 * 2. 不包含 Electron 专属字段的取值逻辑差异：`runtimeVersions.electron` 在纯 Node 下为
 *    undefined，`normalizeValue` 会给出 "Unknown"，正好如实反映「非 Electron 环境」。
 */
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { ZCODE_BUILD_TIME, ZCODE_COMMIT, ZCODE_ENV, ZCODE_VERSION } from "@zcode/shared";

export interface LogExportBuildMetadata {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronBuilderVersion?: string;
}

export interface LogExportAboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

function normalizeValue(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Unknown";
}

export function readBuildMetadataFile(filePath: string): LogExportBuildMetadata | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as LogExportBuildMetadata;
  } catch {
    return null;
  }
}

export function createAboutSnapshotForLogExport(
  options: { buildMetadata?: LogExportBuildMetadata | null } = {},
): LogExportAboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = process.versions as NodeJS.ProcessVersions & { electron?: string };
  const osInfo = {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    environment: normalizeValue(ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: normalizeValue(buildMetadata?.electronBuilderVersion),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

export function formatAboutDetail(snapshot: LogExportAboutSnapshot): string {
  return [
    `Version: ${snapshot.appVersion}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}
