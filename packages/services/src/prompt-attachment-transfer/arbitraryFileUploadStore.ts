import { lstat, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  PromptAttachmentRetentionPort,
  PromptAttachmentRetentionTarget,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
  PromptAttachmentUploadBeginParams,
  PromptAttachmentUploadBeginResult,
  PromptAttachmentUploadPort,
} from "./promptAttachmentTransfer.js";
import {
  ARBITRARY_UPLOAD_MAX_CHUNK_BYTES,
  ARBITRARY_UPLOAD_READY_QUOTA_BYTES,
  ARBITRARY_UPLOAD_RETAINED_QUOTA_BYTES,
  ARBITRARY_UPLOAD_READY_TTL_MS,
  ArbitraryFileUploadError,
  operationIdHash,
  operationIdSchema,
  sha256Hex,
  uploadChunkParamsSchema,
  validateBeginUploadParams,
  type ArbitraryUploadManifest,
  type ValidatedBeginMeta,
} from "./arbitraryFileUploadShared.js";
import { retainAttachmentsForSend } from "./arbitraryFileUploadRetention.js";
import {
  appendChunkVerified,
  assertRealDirectory,
  createOperationDir,
  finalFilePath,
  hashFileContents,
  partFilePath,
  removeOperationContent,
  writeManifestAtomic,
  writeOperationTombstone,
} from "./arbitraryFileUploadFs.js";
import { assertUploadCapacity, sweepExpiredReadyOperations } from "./arbitraryFileUploadQuota.js";
import { markOperationCanceled, recoverUploadRoot } from "./arbitraryFileUploadRecovery.js";

export interface ArbitraryFileUploadStoreOptions {
  /** 存储根由 Host 注入（如 <dataRoot>/attachments/prompt-files），store 不读取 HOME。 */
  root: string;
  now?: () => number;
  quota?: { readyBytes?: number; retainedBytes?: number };
  /** 上传事务进度回调（uploading/complete/canceled）；回调异常不影响存储事务。 */
  onProgress?: (progress: PromptAttachmentTransferProgress) => void;
}

export interface ArbitraryFileUploadStore
  extends PromptAttachmentUploadPort, PromptAttachmentRetentionPort {
  /** 启动恢复：uploading→canceled 清 .part；ready>24h 未引用回收；retained 永不 TTL。 */
  recover(): Promise<void>;
  cancel(operationId: string): Promise<void>;
  /** UI adopt：与 retain 同状态迁移（ready→retained），幂等且不改文件路径。 */
  adopt(operationId: string): Promise<void>;
  /** 仅清理未 retained 内容与 canceled tombstone；路径由 owner 生成，绝不触碰用户路径。 */
  cleanup(operationId: string): Promise<void>;
  /** 释放：等待全部在途串行事务落盘后返回；保留已提交文件，不留句柄/定时器。 */
  disposeAllAndWait(): Promise<void>;
}

/**
 * Host 通用上传存储：事务、文件与持久 manifest 的唯一所有者。
 * 磁盘 manifest 是事实来源，内存 map/队列只是投影；所有 mutation 全局串行，
 * cancel/commit/retain 天然互斥，晚到 chunk/commit 无法复活已取消 operation。
 * 每次变更都遵守“先落盘成功、后更新内存投影”，IO 失败不留下脏投影。
 */
export function createArbitraryFileUploadStore(
  options: ArbitraryFileUploadStoreOptions,
): ArbitraryFileUploadStore {
  const root = options.root;
  if (typeof root !== "string" || root.trim() === "" || !isAbsolute(root)) {
    throw new ArbitraryFileUploadError("invalid-params", "root 必须为非空绝对路径");
  }
  const readyQuota = options.quota?.readyBytes ?? ARBITRARY_UPLOAD_READY_QUOTA_BYTES;
  const retainedQuota = options.quota?.retainedBytes ?? ARBITRARY_UPLOAD_RETAINED_QUOTA_BYTES;
  if (![readyQuota, retainedQuota].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new ArbitraryFileUploadError("invalid-params", "quota 必须为非负安全整数");
  }
  const now = options.now ?? Date.now;
  const onProgress = options.onProgress;
  const manifests = new Map<string, ArbitraryUploadManifest>();
  const cleaned = new Set<string>();
  let queueTail: Promise<unknown> = Promise.resolve();
  let recoverPromise: Promise<void> | null = null;
  let disposed = false;

  const emit = (progress: PromptAttachmentTransferProgress): void => {
    try {
      onProgress?.(progress);
    } catch {
      // 进度回调失败不能影响存储事务
    }
  };

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (disposed) {
      return Promise.reject(
        new ArbitraryFileUploadError("invalid-state", "store 已释放，拒绝新事务"),
      );
    }
    const run = queueTail.then(task, task);
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 必须在串行事务内部调用；恢复只执行一次，后续事务复用同一 promise。 */
  function ensureRecovered(): Promise<void> {
    recoverPromise ??= recoverUploadRoot(root, { manifests, cleaned, now });
    return recoverPromise;
  }

  function requireManifest(operationId: string): {
    hash: string;
    manifest: ArbitraryUploadManifest;
  } {
    const parsed = operationIdSchema.safeParse(operationId);
    if (!parsed.success) {
      throw new ArbitraryFileUploadError("invalid-params", "operationId 不合法");
    }
    const hash = operationIdHash(parsed.data);
    const manifest = manifests.get(hash);
    if (!manifest) {
      throw new ArbitraryFileUploadError("invalid-state", "operation 不存在");
    }
    return { hash, manifest };
  }

  function assertSameMeta(existing: ArbitraryUploadManifest, meta: ValidatedBeginMeta): void {
    if (
      existing.sessionId !== meta.sessionId ||
      existing.workspaceKey !== meta.workspaceKey ||
      existing.fileName !== meta.fileName ||
      existing.mime !== meta.mime ||
      existing.totalBytes !== meta.totalBytes ||
      existing.totalChunks !== meta.totalChunks ||
      existing.checksum !== meta.checksum
    ) {
      throw new ArbitraryFileUploadError("conflict", "begin 重放参数与既有 manifest 冲突");
    }
  }

  /** retained 永不允许 cleanup：发送失败/ACK 丢失时保守保留优于破坏已接受消息。 */
  async function cleanupInternal(hash: string, manifest: ArbitraryUploadManifest): Promise<void> {
    if (manifest.status === "retained") {
      throw new ArbitraryFileUploadError("invalid-state", "已 retained 的附件不允许 cleanup");
    }
    await removeOperationContent(root, hash);
    manifests.delete(hash);
    cleaned.add(hash);
  }

  const beginUpload = async (
    params: PromptAttachmentUploadBeginParams,
  ): Promise<PromptAttachmentUploadBeginResult> =>
    enqueue(async () => {
      await ensureRecovered();
      await sweepExpiredReadyOperations(
        root,
        manifests,
        cleaned,
        now,
        ARBITRARY_UPLOAD_READY_TTL_MS,
      );
      const meta = validateBeginUploadParams(params);
      const hash = operationIdHash(meta.operationId);
      const dir = join(root, hash);
      const existing = manifests.get(hash);
      if (existing) {
        assertSameMeta(existing, meta);
        if (existing.status === "uploading") {
          return { state: "staging", nextChunkIndex: existing.chunkHashes.length };
        }
        if (existing.status === "ready" || existing.status === "retained") {
          return {
            state: "committed",
            nextChunkIndex: meta.totalChunks,
            ref: existing.ref as string,
            bytes: meta.totalBytes,
          };
        }
        throw new ArbitraryFileUploadError(
          "invalid-state",
          "operation 已取消，不能复用（请换新 operationId）",
        );
      }
      if (cleaned.has(hash)) {
        throw new ArbitraryFileUploadError("conflict", "operationId 已被清理，UI 需换新 id 重试");
      }
      assertUploadCapacity(manifests, meta.totalBytes, readyQuota, retainedQuota);
      // 目录 + content/ + 空 .part（0 字节提交也依赖该 .part），全部 owner 生成
      await createOperationDir(dir, meta.fileName);
      const manifest: ArbitraryUploadManifest = {
        version: 1,
        operationId: meta.operationId,
        sessionId: meta.sessionId,
        workspaceKey: meta.workspaceKey,
        fileName: meta.fileName,
        mime: meta.mime,
        totalBytes: meta.totalBytes,
        checksum: meta.checksum,
        totalChunks: meta.totalChunks,
        chunkHashes: [],
        uploadedBytes: 0,
        status: "uploading",
        createdAt: now(),
        updatedAt: now(),
      };
      await writeManifestAtomic(dir, manifest);
      manifests.set(hash, manifest);
      return { state: "staging", nextChunkIndex: 0 };
    });

  const uploadChunk = async (params: {
    operationId: string;
    chunkIndex: number;
    dataBase64: string;
  }): Promise<{ nextChunkIndex: number }> =>
    enqueue(async () => {
      await ensureRecovered();
      const parsed = uploadChunkParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new ArbitraryFileUploadError("invalid-params", "chunk 参数不合法");
      }
      const { operationId, chunkIndex } = parsed.data;
      const data = Buffer.from(parsed.data.dataBase64, "base64");
      if (data.length > ARBITRARY_UPLOAD_MAX_CHUNK_BYTES) {
        throw new ArbitraryFileUploadError("invalid-params", "单 decoded 分片超过 512KiB");
      }
      const hash = operationIdHash(operationId);
      const manifest = manifests.get(hash);
      if (!manifest) {
        throw new ArbitraryFileUploadError("invalid-state", "operation 不存在");
      }
      if (manifest.status !== "uploading") {
        throw new ArbitraryFileUploadError("invalid-state", "operation 已结束，晚到分片拒绝");
      }
      const receivedCount = manifest.chunkHashes.length;
      const digest = sha256Hex(data);
      if (chunkIndex < receivedCount) {
        if (manifest.chunkHashes[chunkIndex] === digest) {
          return { nextChunkIndex: receivedCount }; // 重复同片字节一致：幂等确认
        }
        throw new ArbitraryFileUploadError("conflict", "重复分片内容与已确认分片不一致");
      }
      if (data.length === 0 || receivedCount >= manifest.totalChunks) {
        throw new ArbitraryFileUploadError("invalid-params", "拒绝空分片或超过声明分片数");
      }
      if (chunkIndex !== receivedCount) {
        throw new ArbitraryFileUploadError("invalid-state", "分片必须按序上传");
      }
      if (manifest.uploadedBytes + data.length > manifest.totalBytes) {
        throw new ArbitraryFileUploadError("invalid-params", "分片累计超出声明 totalBytes");
      }
      const dir = join(root, hash);
      await appendChunkVerified(partFilePath(dir, manifest.fileName), data, manifest.uploadedBytes);
      const updated: ArbitraryUploadManifest = {
        ...manifest,
        chunkHashes: [...manifest.chunkHashes, digest],
        uploadedBytes: manifest.uploadedBytes + data.length,
        updatedAt: now(),
      };
      await writeManifestAtomic(dir, updated); // 先落盘成功，才更新内存投影
      manifests.set(hash, updated);
      emit({
        operationId,
        phase: "uploading",
        uploadedBytes: updated.uploadedBytes,
        totalBytes: updated.totalBytes,
      });
      return { nextChunkIndex: updated.chunkHashes.length };
    });

  const commitUpload = async (operationId: string): Promise<PromptAttachmentStageResult> =>
    enqueue(async () => {
      await ensureRecovered();
      const { hash, manifest } = requireManifest(operationId);
      const dir = join(root, hash);
      if (manifest.status === "ready" || manifest.status === "retained") {
        // 重复提交幂等：返回相同稳定路径
        return {
          operationId,
          ref: manifest.ref as string,
          bytes: manifest.totalBytes,
          staged: true,
        };
      }
      if (manifest.status !== "uploading") {
        throw new ArbitraryFileUploadError("invalid-state", "operation 已取消，commit 拒绝");
      }
      if (
        manifest.chunkHashes.length !== manifest.totalChunks ||
        manifest.uploadedBytes !== manifest.totalBytes
      ) {
        throw new ArbitraryFileUploadError("invalid-state", "分片未收齐，上传中的附件不允许提交");
      }
      const partPath = partFilePath(dir, manifest.fileName);
      await assertRealDirectory(dirname(partPath));
      const partInfo = await lstat(partPath).catch(() => null);
      if (!partInfo || partInfo.isSymbolicLink() || !partInfo.isFile()) {
        throw new ArbitraryFileUploadError("io", ".part 缺失或被符号链接替换");
      }
      // 提交前按磁盘实际字节重新计量与哈希，不信任客户端声明；失败不 ready
      const actual = await hashFileContents(partPath);
      if (actual.bytes !== manifest.totalBytes || actual.checksum !== manifest.checksum) {
        throw new ArbitraryFileUploadError(
          "checksum-mismatch",
          "提交校验失败：磁盘内容与声明 SHA-256/长度不符",
        );
      }
      const finalPath = finalFilePath(dir, manifest.fileName);
      const existingFinal = await lstat(finalPath).catch(() => null);
      if (existingFinal) {
        throw new ArbitraryFileUploadError("conflict", "目标文件已存在，不覆盖");
      }
      await rename(partPath, finalPath); // 同目录原子 rename，得到稳定路径
      const updated: ArbitraryUploadManifest = {
        ...manifest,
        status: "ready",
        ref: finalPath,
        updatedAt: now(),
      };
      await writeManifestAtomic(dir, updated);
      manifests.set(hash, updated);
      emit({
        operationId,
        phase: "complete",
        uploadedBytes: updated.totalBytes,
        totalBytes: updated.totalBytes,
      });
      return { operationId, ref: finalPath, bytes: updated.totalBytes, staged: true };
    });

  const cancelOperation = async (operationId: string): Promise<void> =>
    enqueue(async () => {
      await ensureRecovered();
      const { hash, manifest } = requireManifest(operationId);
      if (manifest.status === "canceled") {
        return; // 幂等
      }
      if (manifest.status !== "uploading") {
        throw new ArbitraryFileUploadError(
          "invalid-state",
          "已提交/已保留的 operation 不允许 cancel",
        );
      }
      const dir = join(root, hash);
      await rm(partFilePath(dir, manifest.fileName), { force: true }); // 只删该 operation 的未引用暂存
      const canceled = await markOperationCanceled(dir, manifest, now);
      manifests.set(hash, canceled);
      emit({
        operationId,
        phase: "canceled",
        uploadedBytes: manifest.uploadedBytes,
        totalBytes: manifest.totalBytes,
      });
    });

  const adopt = async (operationId: string): Promise<void> =>
    enqueue(async () => {
      await ensureRecovered();
      const { hash, manifest } = requireManifest(operationId);
      if (manifest.status === "retained") {
        return; // 幂等
      }
      if (manifest.status !== "ready") {
        throw new ArbitraryFileUploadError("invalid-state", "仅 ready 附件可以 adopt");
      }
      const dir = join(root, hash);
      const retained: ArbitraryUploadManifest = {
        ...manifest,
        status: "retained",
        retainedAt: now(),
        updatedAt: now(),
      };
      await writeManifestAtomic(dir, retained);
      manifests.set(hash, retained); // 只迁移状态，不改文件路径
    });

  const cleanup = async (operationId: string): Promise<void> =>
    enqueue(async () => {
      await ensureRecovered();
      const parsed = operationIdSchema.safeParse(operationId);
      if (!parsed.success) {
        throw new ArbitraryFileUploadError("invalid-params", "operationId 不合法");
      }
      const hash = operationIdHash(parsed.data);
      const manifest = manifests.get(hash);
      if (!manifest) {
        // 取消可能早于begin（前端仍在读取/哈希），墓碑防止晚到begin复活已移除附件。
        await writeOperationTombstone(root, hash);
        cleaned.add(hash);
        return;
      }
      await cleanupInternal(hash, manifest);
    });

  /** 发送前持久保留：root 内 managed ref 校验 + ready→retained 持久化（先于 CLI 请求）。 */
  const retainForSend = (target: PromptAttachmentRetentionTarget): Promise<void> =>
    enqueue(async () => {
      await ensureRecovered();
      await retainAttachmentsForSend(root, manifests, target, now);
    });

  return {
    beginUpload,
    uploadChunk,
    commitUpload,
    retainForSend,
    recover: () => enqueue(ensureRecovered),
    cancel: cancelOperation,
    adopt,
    cleanup,
    disposeAllAndWait: () => {
      disposed = true;
      return queueTail.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
