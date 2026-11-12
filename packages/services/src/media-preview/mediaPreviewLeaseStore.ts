/**
 * 本地媒体预览的路径授权表（服务端）。
 *
 * 背景：`IMediaPreviewService.prepare()` 只有在同时提供 `authorizeLocalMediaPreviewPath` 与
 * `createLocalMediaPreviewUrl` 时才走 `local-url` 分支；否则退回 `inline`（base64 内联），
 * 而内联受 8MB 上限约束，超过即直接抛错。桌面端由 Electron main 的 `zcode-media` 协议承担
 * 「登记精确路径 + Range 读取」；自部署 server 没有该协议，于是 >8MB 的音视频预览在 WebUI
 * 上必定失败。
 *
 * 本模块承担登记与复核：只登记 Host 已校验过的精确路径（realpath 规范化 + 常规文件 +
 * 大小上限 + TTL + LRU 容量上限），HTTP 路由再按此表复核后才读取文件（支持 Range）。
 * 与桌面端 `localMediaPreviewPathRegistry` 语义一致。
 *
 * 安全要点：
 * - 授权表按**规范化后的绝对路径**做白名单，不接受 URL 里的任意路径；
 * - 每次复核都重新 realpath 并比对，防止授权后把文件替换成指向别处的符号链接；
 * - 未登记路径一律 404，因此知道路由格式也无法读取未授权文件。
 */
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** 授权条目默认有效期：与桌面端 localMediaPreviewPathRegistry 一致（30 分钟）。 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** 授权表默认容量上限，防止长期运行下无界增长（LRU 淘汰）。 */
const DEFAULT_MAX_ENTRIES = 256;
/** 单文件大小上限：与桌面端 remoteMediaPreviewProxy 默认值一致（512MB）。 */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;

export interface MediaPreviewLeaseStore {
  /**
   * 登记一个已通过 Host 校验的媒体路径，返回 realpath 规范化后的绝对路径。
   * 非绝对路径、非常规文件、超限文件一律拒绝。
   */
  authorize(path: string, mediaType: string): Promise<string>;
  /**
   * 复核该路径当前是否仍在有效授权内。命中返回 `{ canonicalPath, size, mediaType }`，
   * 否则返回 null（过期、未登记、realpath 变化、非常规文件都会失效并移除条目）。
   */
  resolve(path: string): Promise<{ canonicalPath: string; size: number; mediaType: string } | null>;
  /** 清空全部授权（服务释放时调用）。 */
  clear(): void;
  /** 当前有效条目数（诊断 / 测试用）。 */
  size(): number;
}

export function createMediaPreviewLeaseStore(
  dependencies: {
    realpath?: (path: string) => Promise<string>;
    stat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
    maxFileBytes?: number;
  } = {},
): MediaPreviewLeaseStore {
  const authorized = new Map<
    string,
    { expiresAt: number; lastAccessAt: number; mediaType: string }
  >();
  const realpath = dependencies.realpath ?? fsRealpath;
  const stat = dependencies.stat ?? ((path: string) => fsStat(path));
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = dependencies.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxFileBytes = dependencies.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  function pruneExpired(observedAt: number): void {
    for (const [path, entry] of authorized) {
      if (entry.expiresAt <= observedAt) authorized.delete(path);
    }
  }

  function evictLeastRecentlyUsed(): void {
    while (authorized.size > maxEntries) {
      let oldestPath: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [path, entry] of authorized) {
        if (entry.lastAccessAt < oldestAccess) {
          oldestAccess = entry.lastAccessAt;
          oldestPath = path;
        }
      }
      if (!oldestPath) return;
      authorized.delete(oldestPath);
    }
  }

  return {
    async authorize(path, mediaType) {
      if (!isAbsolute(path)) {
        throw new Error("Local media preview path must be absolute");
      }
      const canonicalPath = await realpath(path);
      const fileStat = await stat(canonicalPath);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a media file: ${path}`);
      }
      if (fileStat.size > maxFileBytes) {
        throw new Error(`Media file is too large for preview: ${path}`);
      }
      const observedAt = now();
      pruneExpired(observedAt);
      authorized.set(canonicalPath, {
        expiresAt: observedAt + ttlMs,
        lastAccessAt: observedAt,
        mediaType,
      });
      evictLeastRecentlyUsed();
      return canonicalPath;
    },
    async resolve(path) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = authorized.get(path);
      if (!entry) return null;
      try {
        const canonicalPath = await realpath(path);
        if (canonicalPath !== path) {
          authorized.delete(path);
          return null;
        }
        const fileStat = await stat(canonicalPath);
        if (!fileStat.isFile()) {
          authorized.delete(path);
          return null;
        }
        entry.lastAccessAt = observedAt;
        return { canonicalPath, size: fileStat.size, mediaType: entry.mediaType };
      } catch {
        authorized.delete(path);
        return null;
      }
    },
    clear() {
      authorized.clear();
    },
    size() {
      pruneExpired(now());
      return authorized.size;
    },
  };
}
