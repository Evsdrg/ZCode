import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export type PromptAttachmentTransferPhase = "uploading" | "committing" | "complete" | "canceled";

export interface PromptAttachmentTransferProgress {
  operationId: string;
  phase: PromptAttachmentTransferPhase;
  uploadedBytes: number;
  totalBytes: number;
}

export interface PromptAttachmentStageParams {
  operationId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  localPath: string;
  fileName: string;
  mime: string;
  sizeBytes?: number;
}

export interface PromptAttachmentStageResult {
  operationId: string;
  ref: string;
  bytes: number;
  staged: boolean;
}

export interface PromptAttachmentUploadBeginParams {
  operationId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export type PromptAttachmentUploadBeginResult =
  | { state: "staging"; nextChunkIndex: number }
  | { state: "committed"; nextChunkIndex: number; ref: string; bytes: number };

export interface PromptAttachmentUploadPort {
  beginUpload(
    params: PromptAttachmentUploadBeginParams,
  ): Promise<PromptAttachmentUploadBeginResult>;
  uploadChunk(params: {
    operationId: string;
    chunkIndex: number;
    dataBase64: string;
  }): Promise<{ nextChunkIndex: number }>;
  commitUpload(operationId: string): Promise<PromptAttachmentStageResult>;
}

export interface PromptAttachmentRetentionTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachments: readonly AttachmentRef[];
}

export interface PromptAttachmentRetentionPort {
  retainForSend(target: PromptAttachmentRetentionTarget): Promise<void>;
}

/**
 * Renderer 只消费这个 host 服务，不直接依赖 SSH/WSL/Docker backend。
 * 本地 host 返回零拷贝路径，remote host wrapper 则先完成跨机暂存。
 */
export interface IPromptAttachmentTransferService {
  getUploadCapabilities?(): Promise<{ arbitraryFiles: boolean; maxBytes: number }>;
  beginUpload?: PromptAttachmentUploadPort["beginUpload"];
  uploadChunk?: PromptAttachmentUploadPort["uploadChunk"];
  commitUpload?: PromptAttachmentUploadPort["commitUpload"];
  stage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult>;
  adopt(operationId: string): Promise<void>;
  cancel(operationId: string): Promise<void>;
  cleanup(operationId: string): Promise<void>;
  onDynamicProgress(operationId: string): Event<PromptAttachmentTransferProgress>;
}

export const IPromptAttachmentTransferService =
  createServiceDescriptor<IPromptAttachmentTransferService>(
    ServiceChannels.PromptAttachmentTransfer,
  );
