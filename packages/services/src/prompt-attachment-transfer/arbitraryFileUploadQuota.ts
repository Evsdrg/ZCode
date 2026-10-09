import type {
  ArbitraryUploadManifest,
  ArbitraryUploadStatus,
} from "./arbitraryFileUploadShared.js";
import {
  ArbitraryFileUploadError,
  ARBITRARY_UPLOAD_MAX_CONCURRENT_UPLOADS,
  ARBITRARY_UPLOAD_RESERVED_BYTES,
} from "./arbitraryFileUploadShared.js";
import { removeOperationContent } from "./arbitraryFileUploadFs.js";

/**
 * 磁盘配额与 TTL 回收助手：
 * - ready 未引用与在传合计默认160MiB，允许8个20MiB附件；
 * - retained 按默认 2GiB 配额有界（可配置）；
 * - ready>24h 未引用在启动与同进程 begin 时都会被回收（retained 永不 TTL 清理）。
 */

export function sumAllocatedBytes(
  manifests: Map<string, ArbitraryUploadManifest>,
  status: ArbitraryUploadStatus,
): number {
  let total = 0;
  for (const manifest of manifests.values()) {
    if (manifest.status === status) {
      total += manifest.totalBytes;
    }
  }
  return total;
}

export function assertUploadCapacity(
  manifests: Map<string, ArbitraryUploadManifest>,
  totalBytes: number,
  readyQuota: number,
  retainedQuota: number,
): void {
  const uploadingCount = Array.from(manifests.values()).filter(
    (item) => item.status === "uploading",
  ).length;
  const reservedBytes = sumAllocatedBytes(manifests, "uploading");
  if (uploadingCount + 1 > ARBITRARY_UPLOAD_MAX_CONCURRENT_UPLOADS) {
    throw new ArbitraryFileUploadError(
      "capacity",
      `并发上传数超过上限 ${ARBITRARY_UPLOAD_MAX_CONCURRENT_UPLOADS}`,
    );
  }
  if (reservedBytes + totalBytes > ARBITRARY_UPLOAD_RESERVED_BYTES) {
    throw new ArbitraryFileUploadError("capacity", "暂存总量超过保留上限");
  }
  const pendingBytes = reservedBytes + sumAllocatedBytes(manifests, "ready") + totalBytes;
  if (pendingBytes > readyQuota)
    throw new ArbitraryFileUploadError("capacity", "未发送附件存储配额不足");
  if (pendingBytes + sumAllocatedBytes(manifests, "retained") > retainedQuota) {
    throw new ArbitraryFileUploadError("capacity", "附件存储配额不足，已发送内容不会自动删除");
  }
}

/** 仅清理未 retained 内容；路径由 owner 生成（hash 目录），绝不触碰用户路径。 */
export async function cleanupUnretainedOperation(
  root: string,
  manifests: Map<string, ArbitraryUploadManifest>,
  cleaned: Set<string>,
  hash: string,
): Promise<void> {
  const manifest = manifests.get(hash);
  if (!manifest) {
    return;
  }
  if (manifest.status === "retained") {
    // 发送失败/ACK 丢失时保守保留优于破坏已接受消息
    throw new ArbitraryFileUploadError("invalid-state", "已 retained 的附件不允许 cleanup");
  }
  await removeOperationContent(root, hash);
  manifests.delete(hash);
  cleaned.add(hash);
}

/** 回收过期 ready（updatedAt 距 now 超过 TTL）；返回回收数量。 */
export async function sweepExpiredReadyOperations(
  root: string,
  manifests: Map<string, ArbitraryUploadManifest>,
  cleaned: Set<string>,
  now: () => number,
  ttlMs: number,
): Promise<number> {
  const expired: string[] = [];
  for (const [hash, manifest] of manifests) {
    if (manifest.status === "ready" && now() - manifest.updatedAt > ttlMs) {
      expired.push(hash);
    }
  }
  for (const hash of expired) {
    await cleanupUnretainedOperation(root, manifests, cleaned, hash);
  }
  return expired.length;
}
