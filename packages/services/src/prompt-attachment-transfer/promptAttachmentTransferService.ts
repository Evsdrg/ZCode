import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { createArbitraryFileUploadStore } from "./arbitraryFileUploadStore.js";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentRetentionPort,
  PromptAttachmentTransferProgress,
} from "./promptAttachmentTransfer.js";

export function createLocalPromptAttachmentTransferService(options?: {
  uploadRoot?: string;
  uploadQuota?: { readyBytes?: number; retainedBytes?: number };
}): IPromptAttachmentTransferService &
  PromptAttachmentRetentionPort & {
    disposeAllAndWait(): Promise<void>;
  } {
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };
  const uploads = options?.uploadRoot
    ? createArbitraryFileUploadStore({
        root: options.uploadRoot,
        quota: options.uploadQuota,
        onProgress: (progress) => emitters.get(progress.operationId)?.fire(progress),
      })
    : undefined;

  return {
    async getUploadCapabilities() {
      return { arbitraryFiles: Boolean(uploads), maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes };
    },
    async beginUpload(params) {
      if (!uploads) throw new Error("fault.attachment.uploadUnsupported");
      return uploads.beginUpload(params);
    },
    async uploadChunk(params) {
      if (!uploads) throw new Error("fault.attachment.uploadUnsupported");
      return uploads.uploadChunk(params);
    },
    async commitUpload(operationId) {
      if (!uploads) throw new Error("fault.attachment.uploadUnsupported");
      return uploads.commitUpload(operationId);
    },
    async stage(params) {
      const bytes =
        typeof params.sizeBytes === "number" && params.sizeBytes > 0
          ? params.sizeBytes
          : await stat(params.localPath)
              .then((value) => value.size)
              .catch(() => 0);
      return { operationId: params.operationId, ref: params.localPath, bytes, staged: false };
    },
    async adopt(operationId) {
      await uploads?.adopt(operationId);
    },
    async cancel(operationId) {
      await uploads?.cleanup(operationId);
    },
    async cleanup(operationId) {
      await uploads?.cleanup(operationId);
    },
    async retainForSend(target) {
      await uploads?.retainForSend(target);
    },
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
    async disposeAllAndWait() {
      await uploads?.disposeAllAndWait();
      for (const emitter of emitters.values()) emitter.dispose();
      emitters.clear();
    },
  };
}
