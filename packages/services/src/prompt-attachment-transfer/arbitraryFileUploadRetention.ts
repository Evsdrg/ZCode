import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PromptAttachmentRetentionTarget } from "./promptAttachmentTransfer.js";
import {
  ArbitraryFileUploadError,
  retentionTargetSchema,
  type ArbitraryUploadManifest,
} from "./arbitraryFileUploadShared.js";
import {
  assertRealDirectory,
  classifyManagedRef,
  writeManifestAtomic,
} from "./arbitraryFileUploadFs.js";

/**
 * 发送前附件保留：只校验本服务 root 内的 managed ref（桌面原生路径与 CLI artifact
 * 一律忽略）。ready→retained 持久化发生在返回之前（调用方 await 后才发 CLI 请求），
 * 覆盖 send ACK 与 UI adopt 之间的崩溃窗口；先落盘成功、后更新内存投影。
 */
export async function retainAttachmentsForSend(
  root: string,
  manifests: Map<string, ArbitraryUploadManifest>,
  target: PromptAttachmentRetentionTarget,
  now: () => number,
): Promise<void> {
  // 新会话媒体/桌面引用不属于本服务；只对managed路径要求已有session绑定。
  const managedAttachments = target.attachments.filter(
    (item) => classifyManagedRef(root, item.ref).kind !== "outside",
  );
  if (managedAttachments.length === 0) return;
  const parsed = retentionTargetSchema.safeParse({ ...target, attachments: managedAttachments });
  if (!parsed.success) {
    throw new ArbitraryFileUploadError("invalid-params", "retain target 不合法");
  }
  const t = parsed.data;
  if (t.remoteSessionId !== undefined && t.remoteSessionId.trim() !== "") {
    // 远端 scope fail closed：本机 managed 路径不能被其他 Host 发送
    for (const attachment of t.attachments) {
      if (classifyManagedRef(root, attachment.ref).kind !== "outside") {
        throw new ArbitraryFileUploadError(
          "invalid-state",
          "远端 target 不允许携带本机 managed 附件",
        );
      }
    }
    return;
  }
  // 统一隔离 key：workspaceIdentity?.trim() || workspacePath（identity 校验隔离保留）
  const identity = t.workspaceIdentity?.trim() ?? "";
  const workspaceKey = identity !== "" ? identity : t.workspacePath;
  for (const attachment of t.attachments) {
    const classified = classifyManagedRef(root, attachment.ref);
    if (classified.kind === "outside") {
      continue; // 桌面原生 localPath / CLI artifact：不归本 store 管
    }
    if (classified.kind === "unmanaged") {
      throw new ArbitraryFileUploadError("invalid-state", "root 内出现非 owned 路径，拒绝发送");
    }
    const manifest = manifests.get(classified.hash);
    if (!manifest || manifest.ref !== classified.finalPath) {
      throw new ArbitraryFileUploadError("invalid-state", "managed 路径与 manifest 不匹配");
    }
    if (manifest.status !== "ready" && manifest.status !== "retained") {
      throw new ArbitraryFileUploadError("invalid-state", "附件未提交完成，不允许发送");
    }
    if (manifest.sessionId !== t.sessionId || manifest.workspaceKey !== workspaceKey) {
      throw new ArbitraryFileUploadError("invalid-state", "session/workspace 绑定不一致，拒绝串用");
    }
    if (
      attachment.fileName !== manifest.fileName ||
      attachment.mime !== manifest.mime ||
      attachment.bytes !== manifest.totalBytes
    ) {
      throw new ArbitraryFileUploadError("invalid-state", "附件元信息（文件名/MIME/大小）不一致");
    }
    await assertRealDirectory(dirname(classified.finalPath));
    const info = await lstat(classified.finalPath).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size !== manifest.totalBytes) {
      throw new ArbitraryFileUploadError("io", "附件正文缺失/被链接替换/长度不符");
    }
    if (manifest.status === "retained") {
      continue; // retain 幂等
    }
    const dir = join(root, classified.hash);
    const retained: ArbitraryUploadManifest = {
      ...manifest,
      status: "retained",
      retainedAt: now(),
      updatedAt: now(),
    };
    await writeManifestAtomic(dir, retained);
    manifests.set(classified.hash, retained);
  }
}
