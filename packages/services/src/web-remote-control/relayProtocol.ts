import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { VSBuffer } from "@zcode/rpc";

/**
 * 官方中转远控（relay）协议纯逻辑：设备凭证、挑战证明、配对二维码与 v4 RPC 桥帧。
 *
 * 协议事实来源：官方桌面 `app.asar`（`WebRemoteControlDeviceTransport`）与官方手机页
 * `/remote/v4` 的实现，已用 PoC 实测注册/鉴权/配对等待全链路。relay 不做账号绑定，
 * 凭证完全由设备本地生成、经二维码带外交给手机端。
 */

export const WEB_REMOTE_CONTROL_RELAY_WS_URL_ENV_KEY = "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL";
export const DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL = "wss://zcode.z.ai/ws";
export const DEFAULT_WEB_REMOTE_CONTROL_PAIRING_PAGE_URL = "https://zcode.z.ai/remote/v4";

/** relay 单帧上限与官方桌面一致；超过即拒发/拒收，避免长连接被大帧拖死。 */
export const WEB_REMOTE_CONTROL_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function resolveRelayWsUrl(env: Record<string, string | undefined> = process.env): string {
  return (
    env[WEB_REMOTE_CONTROL_RELAY_WS_URL_ENV_KEY]?.trim() || DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL
  );
}

/** 设备凭证。deviceMid 是本地稳定设备标识；deviceSid 由 relay 注册后分配。 */
export interface RelayDeviceCredential {
  deviceMid: string;
  deviceSid?: string;
  passHash: string;
}

export function createRelayPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function createRelayPassHash(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

export function createRelayDeviceCredential(): RelayDeviceCredential {
  return { deviceMid: randomUUID(), passHash: createRelayPassHash(createRelayPassword()) };
}

export function buildRelayPairingQrUrl(options: {
  baseUrl?: string;
  deviceSid: string;
  passHash: string;
  timestamp?: number;
  deviceMid: string;
  deviceName?: string;
  appVersion?: string;
}): string {
  const url = new URL(options.baseUrl ?? DEFAULT_WEB_REMOTE_CONTROL_PAIRING_PAGE_URL);
  url.searchParams.set("sid", options.deviceSid);
  url.searchParams.set("hash", options.passHash);
  url.searchParams.set("t", String(options.timestamp ?? Date.now()));
  url.searchParams.set("mid", options.deviceMid);
  if (options.deviceName?.trim()) url.searchParams.set("name", options.deviceName.trim());
  if (options.appVersion?.trim()) url.searchParams.set("app_version", options.appVersion.trim());
  return url.toString();
}

// ============================================================================
// v4 RPC 桥帧 —— relay data 帧的 payload 格式
// ============================================================================

export interface RelayRpcFrameChecksum {
  algorithm: "crc32";
  value: string;
}

/**
 * rpc-frame 的手机端 zod schema（Xm，strict）要求全部字段：
 * seq=物理帧序号、messageSeq=逻辑消息序号、fragmentIndex/Count=分片、
 * messageBytes=完整消息字节数、checksum=整条消息的 CRC32。缺任一字段，
 * 手机端 safeParse 失败并静默丢弃该帧（实测导致 RPC 永久无响应）。
 */
export interface RelayRpcFrame {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: RelayRpcFrameChecksum;
  dataBase64: string;
}

export interface RelayRpcFrameAck {
  zcode_type: "rpc-frame-ack";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  ackMessageSeq: number;
}

export type RelayBridgePayload = RelayRpcFrame | RelayRpcFrameAck;

/** CRC-32（反射式 0xEDB88320），小写十六进制 8 位——对完整消息字节计算。 */
export function computeRelayFrameChecksum(bytes: Uint8Array): RelayRpcFrameChecksum {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return { algorithm: "crc32", value: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0") };
}

export function isRelayBridgePayload(value: unknown): value is RelayBridgePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

export interface RelayBridgeIdentity {
  bridgeSessionId: string;
  bridgeGeneration: number;
  recoveryId: string;
}

/** 单分片容量（保守 2MB：base64 后约 2.7MB，留足 envelope 余量 < 4MB 帧上限）。 */
export const RELAY_FRAME_FRAGMENT_BYTES = 2 * 1024 * 1024;
/** 官方桥协议的消息上限（Y.maxMessageBytes）。 */
export const RELAY_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * 把 ChannelSocket 原始帧封装为 rpc-frame（含 CRC32 与按需分片）。
 * 每个分片携带自己的物理 seq；messageSeq 标识同一条逻辑消息。
 */
export function encodeRelayRpcFrames(
  identity: RelayBridgeIdentity,
  message: {
    messageSeq: number;
    firstSeq: number;
    bytes: Uint8Array;
  },
): RelayRpcFrame[] {
  const bytes = message.bytes;
  if (bytes.byteLength === 0 || bytes.byteLength > RELAY_MAX_MESSAGE_BYTES) {
    throw new Error(`relay rpc message out of range: ${bytes.byteLength}`);
  }
  const checksum = computeRelayFrameChecksum(bytes);
  const fragmentCount = Math.max(1, Math.ceil(bytes.byteLength / RELAY_FRAME_FRAGMENT_BYTES));
  const frames: RelayRpcFrame[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const start = index * RELAY_FRAME_FRAGMENT_BYTES;
    const end = Math.min(bytes.byteLength, start + RELAY_FRAME_FRAGMENT_BYTES);
    frames.push({
      zcode_type: "rpc-frame",
      bridgeSessionId: identity.bridgeSessionId,
      ...(identity.bridgeGeneration !== undefined
        ? { bridgeGeneration: identity.bridgeGeneration }
        : {}),
      ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
      seq: message.firstSeq + index,
      messageSeq: message.messageSeq,
      fragmentIndex: index,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: Buffer.from(bytes.subarray(start, end)).toString("base64"),
    });
  }
  return frames;
}

export function decodeRelayRpcFrameData(frame: { dataBase64: string }): VSBuffer | null {
  try {
    const bytes = Buffer.from(frame.dataBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > WEB_REMOTE_CONTROL_MAX_FRAME_BYTES)
      return null;
    return VSBuffer.wrap(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
