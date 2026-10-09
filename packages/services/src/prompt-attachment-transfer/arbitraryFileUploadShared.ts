import { createHash } from "node:crypto";
import { z } from "zod";
import type { PromptAttachmentUploadBeginParams } from "./promptAttachmentTransfer.js";

/**
 * 通用文件附件上传（自部署 WebUI）的常量、运行时 schema 与参数校验。
 * spec: docs/specs/selfhost-webui-arbitrary-file-attachments.md
 */

/** 单文件上限 20 MiB（20,971,520 字节）；等于上限允许，0 字节允许，超出在读内容前拒绝。 */
export const ARBITRARY_UPLOAD_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 每片 decoded 上限 512 KiB（Web 端实际使用 384 KiB，由调用方决定分片大小）。 */
export const ARBITRARY_UPLOAD_MAX_CHUNK_BYTES = 512 * 1024;
/** totalChunks 上限：Web 384KiB 分片下 20MiB 为 54 片，契约允许 0..64 片。 */
export const ARBITRARY_UPLOAD_MAX_CHUNKS = 64;
/** 全局同时在传（uploading）的 operation 数上限。 */
export const ARBITRARY_UPLOAD_MAX_CONCURRENT_UPLOADS = 16;
/** uploading 状态声明（reserved）的暂存总字节上限。 */
export const ARBITRARY_UPLOAD_RESERVED_BYTES = 64 * 1024 * 1024;
/** 未发送配额允许现有8附件全部达到20MiB；上传中另受64MiB并发预留限制。 */
export const ARBITRARY_UPLOAD_READY_QUOTA_BYTES = 8 * ARBITRARY_UPLOAD_MAX_FILE_BYTES;
/** 全部managed文件默认2GiB，可用quota.retainedBytes覆盖，既有引用不自动回收。 */
export const ARBITRARY_UPLOAD_RETAINED_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
/** ready 但未被引用的持久回收期：24 小时；retained 永不按 TTL 清理。 */
export const ARBITRARY_UPLOAD_READY_TTL_MS = 24 * 60 * 60 * 1000;
/** 空 MIME 的规范值。 */
export const ARBITRARY_UPLOAD_EMPTY_MIME = "application/octet-stream";
/** 空内容的 SHA-256（0 字节文件允许提交）。 */
export const SHA256_EMPTY_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type ArbitraryUploadStatus = "uploading" | "ready" | "retained" | "canceled";

/**
 * 持久 manifest：磁盘是唯一事实来源；内存锁/索引只是它的投影，不做权威判断。
 * 只保存元数据与片校验哈希，不含正文。
 */
export interface ArbitraryUploadManifest {
  version: 1;
  operationId: string;
  sessionId: string;
  /** 统一隔离 key：workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  /** 已 sanitize 的安全 basename */
  fileName: string;
  mime: string;
  totalBytes: number;
  /** 全量原字节 SHA-256（内部统一裸小写 hex） */
  checksum: string;
  totalChunks: number;
  /** 每片 decoded 字节的 SHA-256，按序追加 */
  chunkHashes: string[];
  /** 已确认落盘的累计字节数（分片大小可变，不能由片数推导） */
  uploadedBytes: number;
  status: ArbitraryUploadStatus;
  createdAt: number;
  updatedAt: number;
  retainedAt?: number;
  /** ready 之后才是 owner 生成的稳定绝对路径 */
  ref?: string;
}

export type ArbitraryFileUploadErrorCode =
  | "invalid-params"
  | "conflict"
  | "capacity"
  | "invalid-state"
  | "checksum-mismatch"
  | "io";

export class ArbitraryFileUploadError extends Error {
  constructor(
    readonly code: ArbitraryFileUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArbitraryFileUploadError";
  }
}

/** 判断字符串是否含 NUL/CRLF 等控制字符（显式码点判断，拒绝而非静默清洗）。 */
export function containsControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** 声明字节数对应的最少分片数（每片 ≤512KiB）；0 字节 → 0 片。 */
export function expectedChunkCount(totalBytes: number): number {
  return Math.ceil(totalBytes / ARBITRARY_UPLOAD_MAX_CHUNK_BYTES);
}

/**
 * totalChunks 与 totalBytes 的契约：0 字节必须 0 片；正字节最少 ceil(total/512KiB) 片
 * （每片 ≤512KiB），至多 64 片；不逐片强制 512KiB（分片大小可变，提交按实际字节计量）。
 */
export function isValidChunkCount(totalBytes: number, totalChunks: number): boolean {
  if (
    !Number.isInteger(totalChunks) ||
    totalChunks < 0 ||
    totalChunks > ARBITRARY_UPLOAD_MAX_CHUNKS
  ) {
    return false;
  }
  if (totalBytes === 0) {
    return totalChunks === 0;
  }
  return totalChunks >= expectedChunkCount(totalBytes);
}

/** 归一化前端/v4 规范校验和（"sha256:<64hex>" 或裸 hex，大小写不敏感）为内部裸小写 hex。 */
export function normalizeSha256Checksum(raw: string): string {
  const body = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new ArbitraryFileUploadError("invalid-params", "checksum 必须是 sha256 的 64 位 hex");
  }
  return body.toLowerCase();
}

const checksumInputPattern = /^sha256:[0-9a-fA-F]{64}$|^[0-9a-fA-F]{64}$/;
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

function boundedString(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !containsControlChars(value), "含 NUL/CRLF 等控制字符");
}

export const operationIdSchema = boundedString(200);

export const beginUploadParamsSchema = z
  .object({
    operationId: operationIdSchema,
    sessionId: boundedString(512),
    workspacePath: boundedString(4096),
    workspaceIdentity: z.string().max(512).optional(),
    remoteSessionId: z.string().max(512).optional(),
    fileName: z.string().min(1).max(1024),
    mime: z
      .string()
      .max(255)
      .refine((value) => !containsControlChars(value), "MIME 含控制字符"),
    totalBytes: z.number().int().min(0).max(ARBITRARY_UPLOAD_MAX_FILE_BYTES),
    totalChunks: z.number().int().min(0).max(ARBITRARY_UPLOAD_MAX_CHUNKS),
    checksum: z
      .string()
      .min(1)
      .max(71)
      .refine(
        (value) => checksumInputPattern.test(value),
        "checksum 必须是 sha256 hex（可带 sha256: 前缀）",
      ),
  })
  .strict();

export const uploadChunkParamsSchema = z
  .object({
    operationId: operationIdSchema,
    chunkIndex: z.number().int().min(0),
    // base64 字符串长度上限按 512KiB decoded 换算并留余量，避免先解码超大串
    dataBase64: z
      .string()
      .max(Math.ceil(ARBITRARY_UPLOAD_MAX_CHUNK_BYTES / 3) * 4 + 8)
      .refine(
        (value) => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0,
        "dataBase64 不是合法 base64",
      ),
  })
  .strict();

export const retentionTargetSchema = z
  .object({
    sessionId: boundedString(512),
    workspacePath: boundedString(4096),
    workspaceIdentity: z.string().max(512).optional(),
    remoteSessionId: z.string().max(512).optional(),
    attachments: z.array(
      z
        .object({
          ref: z.string().min(1),
          fileName: z.string(),
          mime: z.string(),
          bytes: z.number(),
          // 兼容标准 AttachmentRef 的可选字段
          previewRef: z.string().optional(),
          sourceKind: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const arbitraryUploadManifestSchema = z
  .object({
    version: z.literal(1),
    operationId: operationIdSchema,
    sessionId: boundedString(512),
    workspaceKey: z.string().min(1).max(4096),
    fileName: z.string().min(1).max(255),
    mime: z.string().min(1).max(255),
    totalBytes: z.number().int().min(0).max(ARBITRARY_UPLOAD_MAX_FILE_BYTES),
    checksum: sha256HexSchema,
    totalChunks: z.number().int().min(0).max(ARBITRARY_UPLOAD_MAX_CHUNKS),
    chunkHashes: z.array(sha256HexSchema),
    uploadedBytes: z.number().int().min(0).max(ARBITRARY_UPLOAD_MAX_FILE_BYTES),
    status: z.enum(["uploading", "ready", "retained", "canceled"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    retainedAt: z.number().int().nonnegative().optional(),
    ref: z.string().min(1).optional(),
  })
  .strict()
  .refine((m) => isValidChunkCount(m.totalBytes, m.totalChunks), "totalChunks 与 totalBytes 不一致")
  .refine((m) => m.chunkHashes.length <= m.totalChunks, "chunkHashes 超出 totalChunks")
  .refine((m) => m.uploadedBytes <= m.totalBytes, "uploadedBytes 超出 totalBytes")
  .refine(
    (m) => (m.status === "ready" || m.status === "retained") === (typeof m.ref === "string"),
    "ref 与 status 不一致",
  )
  .refine(
    (m) => m.status !== "retained" || typeof m.retainedAt === "number",
    "retained 必须带 retainedAt",
  );

export interface ValidatedBeginMeta {
  operationId: string;
  sessionId: string;
  workspaceKey: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

/**
 * 文件名只接受裸 basename：路径分隔符、NUL、CRLF/控制字符一律拒绝（fail-closed），
 * 不做静默改写以避免同名歧义；扩展名不设限（含 .part / manifest.json 等合法名字，
 * 由 hash/content/ 布局避免与元数据碰撞）；长度按 UTF-8 字节计 ≤255。
 */
export function sanitizeUploadFileName(raw: string): string {
  if (raw.includes("/") || raw.includes("\\")) {
    throw new ArbitraryFileUploadError(
      "invalid-params",
      `fileName 必须是裸 basename，拒绝路径分隔符: ${JSON.stringify(raw.slice(0, 64))}`,
    );
  }
  if (containsControlChars(raw)) {
    throw new ArbitraryFileUploadError("invalid-params", "fileName 含 NUL/CRLF 等控制字符");
  }
  if (raw.length === 0 || raw === "." || raw === "..") {
    throw new ArbitraryFileUploadError("invalid-params", "fileName 非法");
  }
  if (Buffer.byteLength(raw, "utf8") > 255) {
    throw new ArbitraryFileUploadError("invalid-params", "fileName 超过 255 字节");
  }
  return raw;
}

/**
 * begin 的语义校验。本轮 local-only：remoteSessionId 与非空 workspaceIdentity 一律拒绝
 * （远端输入 fail closed）；workspace 隔离语义保留在 retainForSend 的 workspaceKey 校验里。
 */
export function validateBeginUploadParams(
  params: PromptAttachmentUploadBeginParams,
): ValidatedBeginMeta {
  const parsed = beginUploadParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ArbitraryFileUploadError(
      "invalid-params",
      `begin 参数不合法: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const p = parsed.data;
  if (p.remoteSessionId !== undefined && p.remoteSessionId.trim() !== "") {
    throw new ArbitraryFileUploadError(
      "invalid-params",
      "远端会话不允许任意文件上传（本轮仅本地）",
    );
  }
  const identity = p.workspaceIdentity?.trim() ?? "";
  if (identity !== "") {
    throw new ArbitraryFileUploadError(
      "invalid-params",
      "带 workspaceIdentity 的上传暂不支持（本轮仅本地）",
    );
  }
  if (!isValidChunkCount(p.totalBytes, p.totalChunks)) {
    throw new ArbitraryFileUploadError("invalid-params", "totalChunks 与 totalBytes 不一致");
  }
  const trimmedMime = p.mime.trim();
  return {
    operationId: p.operationId,
    sessionId: p.sessionId,
    workspaceKey: identity !== "" ? identity : p.workspacePath,
    fileName: sanitizeUploadFileName(p.fileName),
    mime: trimmedMime === "" ? ARBITRARY_UPLOAD_EMPTY_MIME : trimmedMime,
    totalBytes: p.totalBytes,
    totalChunks: p.totalChunks,
    checksum: normalizeSha256Checksum(p.checksum),
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** operation → 稳定目录名：sha256 hex，跨重启稳定且无法携带路径语义。 */
export function operationIdHash(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}
