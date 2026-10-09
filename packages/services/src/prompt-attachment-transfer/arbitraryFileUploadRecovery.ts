import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ARBITRARY_UPLOAD_READY_TTL_MS,
  operationIdHash,
  sanitizeUploadFileName,
  type ArbitraryUploadManifest,
} from "./arbitraryFileUploadShared.js";
import {
  assertRealDirectory,
  contentDirPath,
  TOMBSTONE_DIR_NAME,
  ensurePrivateDir,
  finalFilePath,
  isOperationDirName,
  partFilePath,
  readManifest,
  removeOperationContent,
  writeManifestAtomic,
} from "./arbitraryFileUploadFs.js";

/**
 * Host 启动/重启恢复：扫描存储 root 并修正事务中断状态。
 * 磁盘 manifest 是事实来源；本模块只更新传入的内存投影（先落盘、后 set）。
 */

export interface UploadRecoveryProjection {
  /** hash → manifest 投影（就地更新） */
  manifests: Map<string, ArbitraryUploadManifest>;
  /** 已清理 hash 投影（就地更新，tombstone 文件是持久事实） */
  cleaned: Set<string>;
  now: () => number;
}

/** canceled tombstone 持久化：先写盘成功，再由调用方更新内存投影。
 * 必须剥离 ref/retainedAt：schema 约束 ref 只允许出现在 ready/retained，
 * canceled 若保留 ref 会让后续读取全部判为损坏。 */
export async function markOperationCanceled(
  operationDir: string,
  manifest: ArbitraryUploadManifest,
  now: () => number,
): Promise<ArbitraryUploadManifest> {
  const canceled: ArbitraryUploadManifest = { ...manifest, status: "canceled", updatedAt: now() };
  delete canceled.ref;
  delete canceled.retainedAt;
  await writeManifestAtomic(operationDir, canceled);
  return canceled;
}

export async function recoverUploadRoot(
  root: string,
  projection: UploadRecoveryProjection,
): Promise<void> {
  await ensurePrivateDir(root);
  await ensurePrivateDir(join(root, TOMBSTONE_DIR_NAME));
  for (const name of await readdir(join(root, TOMBSTONE_DIR_NAME))) {
    if (isOperationDirName(name)) {
      projection.cleaned.add(name);
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!isOperationDirName(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      continue; // 非常规条目不索引、不改动，避免符号链接逃逸
    }
    const dir = join(root, entry.name);
    try {
      await assertRealDirectory(dir);
      await assertRealDirectory(contentDirPath(dir));
    } catch {
      continue;
    }
    const manifest = await readManifest(dir);
    if (!manifest) {
      continue; // manifest 缺失/损坏：保持原样，不索引不误删
    }
    if (operationIdHash(manifest.operationId) !== entry.name) {
      continue; // manifest 与目录 hash 不绑定：视为损坏，保守跳过
    }
    try {
      sanitizeUploadFileName(manifest.fileName);
    } catch {
      continue; // fileName 不再是安全 basename：视为损坏，保守跳过
    }
    if (manifest.status === "uploading") {
      // Host 重建：未完成上传一律作废（commit 未被确认即视为未发生），清 .part 与半提交正文
      await rm(partFilePath(dir, manifest.fileName), { force: true });
      await rm(finalFilePath(dir, manifest.fileName), { force: true });
      projection.manifests.set(
        entry.name,
        await markOperationCanceled(dir, manifest, projection.now),
      );
      continue;
    }
    if (manifest.status === "canceled") {
      projection.manifests.set(entry.name, manifest);
      continue;
    }
    // ready/retained：正文必须是 owner 生成的路径，不信任 manifest.ref 指向的任意外部路径
    const ownerFinalPath = finalFilePath(dir, manifest.fileName);
    if (manifest.ref !== ownerFinalPath) {
      projection.manifests.set(
        entry.name,
        await markOperationCanceled(dir, manifest, projection.now),
      );
      continue;
    }
    const info = await lstat(ownerFinalPath).catch(() => null);
    const bodyIntact =
      info !== null && !info.isSymbolicLink() && info.isFile() && info.size === manifest.totalBytes;
    if (!bodyIntact) {
      // 正文丢失/被符号链接替换/长度不符：fail-closed 作废
      projection.manifests.set(
        entry.name,
        await markOperationCanceled(dir, manifest, projection.now),
      );
      continue;
    }
    if (
      manifest.status === "ready" &&
      projection.now() - manifest.updatedAt > ARBITRARY_UPLOAD_READY_TTL_MS
    ) {
      await removeOperationContent(root, entry.name); // ready>24h 未引用按持久记录回收
      projection.manifests.delete(entry.name);
      projection.cleaned.add(entry.name);
      continue;
    }
    projection.manifests.set(entry.name, manifest); // retained 永不 TTL 清理
  }
}
