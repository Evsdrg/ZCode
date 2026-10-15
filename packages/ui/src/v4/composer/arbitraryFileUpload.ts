import type { IPromptAttachmentTransferService, PromptAttachmentUploadPort } from "@zcode/services";
import { sha256Checksum } from "@zcode/shared";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isVideoChatComposerAttachment,
} from "@/lib/chatAttachments.js";

export class ArbitraryFileTooLargeError extends Error {
  constructor() {
    super("proto.payloadTooLarge");
    this.name = "ArbitraryFileTooLargeError";
  }
}

export function isHostFileUploadCandidate(
  attachment: ChatComposerAttachment,
  target: { workspaceIdentity?: string; remoteSessionId?: string },
): boolean {
  return Boolean(
    attachment.file &&
    !attachment.localPath &&
    !target.workspaceIdentity?.trim() &&
    !target.remoteSessionId?.trim() &&
    !isImageChatComposerAttachment(attachment) &&
    !isVideoChatComposerAttachment(attachment) &&
    !isPdfChatComposerAttachment(attachment),
  );
}

export async function supportsHostFileUploads(
  service: IPromptAttachmentTransferService,
): Promise<boolean> {
  if (!service.getUploadCapabilities) return false;
  try {
    const capability = await service.getUploadCapabilities();
    return (
      capability.arbitraryFiles && capability.maxBytes >= PROTOCOL_V4_LIMITS.attachmentMaxBytes
    );
  } catch (error) {
    // 旧RPC代理会虚拟出所有方法；仅缺失能力允许回到既有链路，网络失败必须保留重试语义。
    if (
      error instanceof Error &&
      /Unknown channel|Method not found|unsupported/iu.test(`${error.name} ${error.message}`)
    ) {
      return false;
    }
    throw error;
  }
}

const CHUNK_BYTES = 384 * 1024;

export async function uploadArbitraryFile(input: {
  service: PromptAttachmentUploadPort;
  file: Pick<File, "name" | "type" | "size" | "arrayBuffer">;
  operationId: string;
  sessionId: string;
  workspacePath: string;
  mime: string;
  signal?: AbortSignal;
  onProgress?: (progress: {
    phase: "uploading" | "committing";
    uploadedBytes: number;
    totalBytes: number;
  }) => void;
}): Promise<AttachmentRef> {
  input.signal?.throwIfAborted();
  if (input.file.size > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
    throw new ArbitraryFileTooLargeError();
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  if (bytes.byteLength !== input.file.size) throw new Error("fault.attachment.fileChanged");
  input.signal?.throwIfAborted();
  const checksum = await sha256Checksum(bytes);
  input.signal?.throwIfAborted();
  const totalChunks = Math.ceil(bytes.length / CHUNK_BYTES);
  const begin = await input.service.beginUpload({
    operationId: input.operationId,
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    fileName: input.file.name,
    mime: input.mime || "application/octet-stream",
    totalBytes: bytes.length,
    totalChunks,
    checksum,
  });
  input.signal?.throwIfAborted();
  if (begin.state === "committed") {
    if (begin.bytes !== bytes.length) throw new Error("fault.attachment.invalidServerProgress");
    return {
      ref: begin.ref,
      fileName: input.file.name,
      mime: input.mime || "application/octet-stream",
      bytes: begin.bytes,
    };
  }
  if (begin.nextChunkIndex < 0 || begin.nextChunkIndex > totalChunks) {
    throw new Error("fault.attachment.invalidServerProgress");
  }
  for (let index = begin.nextChunkIndex; index < totalChunks; index++) {
    input.signal?.throwIfAborted();
    const chunk = bytes.subarray(
      index * CHUNK_BYTES,
      Math.min(bytes.length, (index + 1) * CHUNK_BYTES),
    );
    let binary = "";
    for (let offset = 0; offset < chunk.length; offset += 0x8000) {
      binary += String.fromCharCode(...chunk.subarray(offset, offset + 0x8000));
    }
    const result = await input.service.uploadChunk({
      operationId: input.operationId,
      chunkIndex: index,
      dataBase64: btoa(binary),
    });
    if (result.nextChunkIndex !== index + 1)
      throw new Error("fault.attachment.invalidServerProgress");
    input.onProgress?.({
      phase: "uploading",
      uploadedBytes: Math.min(bytes.length, (index + 1) * CHUNK_BYTES),
      totalBytes: bytes.length,
    });
  }
  input.signal?.throwIfAborted();
  input.onProgress?.({
    phase: "committing",
    uploadedBytes: bytes.length,
    totalBytes: bytes.length,
  });
  const result = await input.service.commitUpload(input.operationId);
  input.signal?.throwIfAborted();
  if (!result.staged || result.bytes !== bytes.length)
    throw new Error("fault.attachment.invalidServerProgress");
  return {
    ref: result.ref,
    fileName: input.file.name,
    mime: input.mime || "application/octet-stream",
    bytes: result.bytes,
  };
}
