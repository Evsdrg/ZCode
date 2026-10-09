import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { PromptAttachmentUploadPort } from "@zcode/services";
import {
  isHostFileUploadCandidate,
  supportsHostFileUploads,
  uploadArbitraryFile,
} from "./arbitraryFileUpload.js";

function fixture(bytes: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let metadata: unknown;
  const service: PromptAttachmentUploadPort = {
    beginUpload: vi.fn(async (params) => {
      metadata = params;
      return { state: "staging" as const, nextChunkIndex: 0 };
    }),
    uploadChunk: vi.fn(async (params) => {
      chunks.push(new Uint8Array(Buffer.from(params.dataBase64, "base64")));
      return { nextChunkIndex: params.chunkIndex + 1 };
    }),
    commitUpload: vi.fn(async (operationId) => ({
      operationId,
      ref: "/owned/fixture.binpkg",
      bytes: bytes.length,
      staged: true,
    })),
  };
  const file = {
    name: "fixture.binpkg",
    type: "",
    size: bytes.length,
    arrayBuffer: vi.fn(async () => Uint8Array.from(bytes).buffer),
  };
  return { service, file, chunks, metadata: () => metadata };
}

vi.stubGlobal("crypto", webcrypto);

describe("任意文件Host上传事务", () => {
  it.each([0, 4, 1024 * 1024, PROTOCOL_V4_LIMITS.attachmentMaxBytes])(
    "完整保留 %i 字节并按384KiB分片",
    async (size) => {
      const bytes = new Uint8Array(size).fill(255);
      const f = fixture(bytes);
      const progress = vi.fn();
      const result = await uploadArbitraryFile({
        ...f,
        operationId: "op-1",
        sessionId: "session-1",
        workspacePath: "/ws",
        mime: "application/octet-stream",
        onProgress: progress,
      });
      const combined = Buffer.concat(f.chunks.map((chunk) => Buffer.from(chunk)));
      expect(createHash("sha256").update(combined).digest("hex")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(f.chunks.every((chunk) => chunk.length <= 384 * 1024)).toBe(true);
      expect(f.metadata()).toMatchObject({
        totalBytes: size,
        checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      });
      expect(result).toEqual({
        ref: "/owned/fixture.binpkg",
        bytes: size,
        fileName: "fixture.binpkg",
        mime: "application/octet-stream",
      });
      expect(progress).toHaveBeenLastCalledWith({
        phase: "committing",
        uploadedBytes: size,
        totalBytes: size,
      });
    },
  );

  it("超限在读取正文或发起RPC前拒绝", async () => {
    const f = fixture(new Uint8Array(1));
    f.file.size = PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1;
    await expect(
      uploadArbitraryFile({
        ...f,
        operationId: "op",
        sessionId: "session",
        workspacePath: "/ws",
        mime: "",
      }),
    ).rejects.toThrow("payloadTooLarge");
    expect(f.file.arrayBuffer).not.toHaveBeenCalled();
    expect(f.service.beginUpload).not.toHaveBeenCalled();
  });

  it("committed重放不重复上传", async () => {
    const f = fixture(new Uint8Array([1, 2]));
    f.service.beginUpload = vi.fn(async () => ({
      state: "committed" as const,
      nextChunkIndex: 1,
      ref: "/owned/replayed",
      bytes: 2,
    }));
    const result = await uploadArbitraryFile({
      ...f,
      operationId: "op",
      sessionId: "session",
      workspacePath: "/ws",
      mime: "application/octet-stream",
    });
    expect(result.ref).toBe("/owned/replayed");
    expect(f.service.uploadChunk).not.toHaveBeenCalled();
    expect(f.service.commitUpload).not.toHaveBeenCalled();
  });

  it("取消后不继续发chunk或commit", async () => {
    const f = fixture(new Uint8Array(800 * 1024));
    const controller = new AbortController();
    f.service.uploadChunk = vi.fn(async () => {
      controller.abort();
      return { nextChunkIndex: 1 };
    });
    await expect(
      uploadArbitraryFile({
        ...f,
        operationId: "op",
        sessionId: "session",
        workspacePath: "/ws",
        mime: "application/octet-stream",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(f.service.uploadChunk).toHaveBeenCalledTimes(1);
    expect(f.service.commitUpload).not.toHaveBeenCalled();
  });

  it("仅无路径本机普通文件进入Host链路，媒体/远端/桌面不变", () => {
    const base = {
      id: "file",
      filename: "file.binpkg",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      file: new File(["test"], "file.binpkg"),
    };
    expect(isHostFileUploadCandidate(base, {})).toBe(true);
    expect(isHostFileUploadCandidate({ ...base, mimeType: "text/plain" }, {})).toBe(true);
    for (const mimeType of ["image/png", "video/mp4", "application/pdf"])
      expect(isHostFileUploadCandidate({ ...base, mimeType }, {})).toBe(false);
    expect(isHostFileUploadCandidate(base, { workspaceIdentity: "remote:identity" })).toBe(false);
    expect(isHostFileUploadCandidate(base, { remoteSessionId: "remote-session" })).toBe(false);
    expect(isHostFileUploadCandidate({ ...base, localPath: "/source.binpkg" }, {})).toBe(false);
  });

  it("能力关闭或旧Host缺方法时保留既有链路；网络错误不伪装成无能力", async () => {
    const port = {
      getUploadCapabilities: vi.fn(async () => ({
        arbitraryFiles: false,
        maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
      })),
    };
    expect(await supportsHostFileUploads(port as never)).toBe(false);
    port.getUploadCapabilities = vi.fn(async () => {
      throw new Error("Method not found: getUploadCapabilities");
    });
    expect(await supportsHostFileUploads(port as never)).toBe(false);
    port.getUploadCapabilities = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(supportsHostFileUploads(port as never)).rejects.toThrow("network unavailable");
  });
});
