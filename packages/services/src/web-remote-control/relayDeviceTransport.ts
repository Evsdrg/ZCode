import type { ServiceLogger } from "../logger/serviceLogger.js";
import { calculateRelayProof, type RelayDeviceCredential } from "./relayProtocol.js";

/**
 * relay 设备端传输：负责 WebSocket 连接、注册/挑战鉴权、配对状态机、心跳与重连。
 * 状态的所有者是本 transport；上层服务只消费 onStateChange/onPayload/onRegisteredAuth
 * 事件并调用 start/dispose。数据帧（rpc-frame）经 onPayload 原样上抛，由桥接层解析。
 */

export type RelayDeviceTransportState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "error";

/** 依赖注入的最小 WebSocket 客户端接口（ws 兼容子集），测试用 fake 替换。 */
export interface RelayWebSocketLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
}

export type RelayWebSocketCtor = (
  url: string,
  options: { headers: Record<string, string>; perMessageDeflate: boolean },
) => RelayWebSocketLike;

export interface RelayDeviceMeta {
  platform: string;
  version: string;
  name: string;
}

export interface RelayDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  credential: RelayDeviceCredential;
  meta: RelayDeviceMeta;
  logger: ServiceLogger;
  webSocketCtor: RelayWebSocketCtor;
  heartbeatIntervalMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectDelayMs?: number;
  onStateChange?: (state: RelayDeviceTransportState) => void;
  onPayload?: (payload: unknown) => void;
  onRegisteredAuth?: (credential: RelayDeviceCredential) => void;
  onTerminalError?: (code: string, message: string) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export class RelayDeviceTransport {
  private readonly options: RelayDeviceTransportOptions;
  private socket: RelayWebSocketLike | null = null;
  private state: RelayDeviceTransportState = "idle";
  private manuallyClosed = false;
  private credential: RelayDeviceCredential;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPairStatusAckAt = 0;

  constructor(options: RelayDeviceTransportOptions) {
    this.options = options;
    this.credential = options.credential;
  }

  get currentState(): RelayDeviceTransportState {
    return this.state;
  }

  start(): void {
    this.manuallyClosed = false;
    this.connect();
  }

  dispose(): void {
    this.manuallyClosed = true;
    this.clearTimers();
    this.socket?.close(1000, "client-dispose");
    this.socket = null;
    this.setState("idle");
  }

  /** 发送数据面帧；仅在 paired 状态可用。 */
  sendPayload(payload: unknown): boolean {
    if (this.state !== "paired" || !this.socket || this.socket.readyState !== this.socket.OPEN) {
      // info 级：远控会话排障必需的发送拒绝事实（状态/就绪度）。
      this.options.logger.info(undefined, "[relay] sendPayload 拒绝", {
        state: this.state,
        socketOpen: this.socket ? this.socket.readyState === this.socket.OPEN : false,
        zcodeType:
          (payload as { zcode_type?: string } | null)?.zcode_type ??
          String((payload as { type?: string })?.type),
      });
      return false;
    }
    this.socket.send(JSON.stringify({ type: "data", payload }));
    return true;
  }

  private connect(): void {
    this.clearTimers();
    this.setState("connecting");
    const url = new URL(this.options.relayWsUrl);
    url.searchParams.set("mid", this.options.deviceMid);
    const socket = this.options.webSocketCtor(url.toString(), {
      headers: { "X-Device-ID": this.options.deviceMid },
      perMessageDeflate: true,
    });
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket) return;
      if (!this.credential.deviceSid) {
        this.setState("registering");
        this.send({
          type: "device_register_init",
          device_mid: this.options.deviceMid,
          pass_hash: this.credential.passHash,
          meta: this.meta(),
          client_ts: Date.now(),
        });
        return;
      }
      this.sendAuthInit(this.credential.deviceSid);
    });
    socket.on("message", (data) => {
      if (socket !== this.socket) return;
      this.handleMessage(parseRelayMessage(data));
    });
    socket.on("error", (error) => {
      if (socket !== this.socket) return;
      this.options.logger.warn(undefined, "[web-remote-control:relay] socket error", {
        message: error.message,
      });
    });
    socket.on("close", () => {
      if (socket !== this.socket) return;
      this.handleDisconnected();
    });
  }

  private meta(): RelayDeviceMeta {
    return this.options.meta;
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private sendAuthInit(deviceSid: string): void {
    this.setState("authenticating");
    this.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: this.meta(),
      client_ts: Date.now(),
    });
  }

  private handleMessage(message: RelayMessage | null): void {
    if (!message) return;
    if (message.type === "data") {
      // info 级：记录控制/数据帧到达事实，用于定位手机端启动序列的断点。
      const payloadType = (message.payload as { zcode_type?: string } | null)?.zcode_type;
      this.options.logger.info(undefined, "[relay] 收到 data 帧", { payloadType });
    } else {
      this.options.logger.info(undefined, "[relay] 收到控制消息", { type: message.type });
    }
    switch (message.type) {
      case "device_register_ack": {
        const credential: RelayDeviceCredential = {
          deviceMid: this.options.deviceMid,
          deviceSid: message.device_sid,
          passHash: this.credential.passHash,
        };
        this.credential = credential;
        this.options.onRegisteredAuth?.(credential);
        this.sendAuthInit(message.device_sid);
        break;
      }
      case "auth_challenge": {
        const deviceSid = this.credential.deviceSid;
        if (!deviceSid) {
          this.enterError("auth", "auth challenge arrived before device_sid");
          return;
        }
        this.send({
          type: "auth_response",
          device_sid: deviceSid,
          proof: calculateRelayProof(this.credential.passHash, message.nonce, "device", deviceSid),
          client_ts: Date.now(),
        });
        break;
      }
      case "auth_ack":
      case "pair_status_ack": {
        this.applyPairStatus(message.pair_status);
        break;
      }
      case "data": {
        this.options.onPayload?.(message.payload);
        break;
      }
      case "error": {
        this.handleRelayError(
          message.code,
          typeof message.message === "string" ? message.message : "",
        );
        break;
      }
      default:
        break;
    }
  }

  private applyPairStatus(pairStatus: unknown): void {
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatWatchdog();
    if (pairStatus === "waiting") {
      this.setState("waiting_terminal");
      this.scheduleHeartbeat();
      return;
    }
    if (pairStatus === "matched") {
      this.setState("paired");
      this.scheduleHeartbeat();
      return;
    }
    this.options.logger.warn(undefined, "[web-remote-control:relay] unknown pair_status", {
      pairStatus,
    });
  }

  private handleRelayError(code: string, message: string): void {
    if (code === "KICKED") {
      this.options.logger.warn(undefined, "[web-remote-control:relay] kicked, reconnecting", {
        message,
      });
      this.socket?.close(4000, "kicked");
      return;
    }
    if (code === "AUTH_FAILED") {
      this.options.onTerminalError?.(code, message);
      return;
    }
    this.options.logger.warn(undefined, "[web-remote-control:relay] relay error", {
      code,
      message,
    });
    this.options.onTerminalError?.(code, message);
  }

  private handleDisconnected(): void {
    this.clearTimers();
    this.socket = null;
    if (this.manuallyClosed) return;
    this.options.logger.warn(
      undefined,
      "[web-remote-control:relay] disconnected, scheduling reconnect",
    );
    this.setState("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manuallyClosed) this.connect();
    }, this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  }

  private enterError(kind: string, message: string): void {
    this.setState("error");
    this.options.logger.error(`[web-remote-control:relay] ${kind}: ${message}`);
    this.options.onTerminalError?.(kind, message);
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const tick = () => {
      this.heartbeatTimer = null;
      const deviceSid = this.credential.deviceSid;
      if (!deviceSid || (this.state !== "paired" && this.state !== "waiting_terminal")) return;
      this.send({ type: "pair_status_query", device_sid: deviceSid, client_ts: Date.now() });
      this.scheduleHeartbeat();
    };
    this.heartbeatTimer = setTimeout(
      tick,
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
  }

  /** 心跳 ack watchdog：超时未收到 pair_status_ack 视为半死连接，主动断开走重连。 */
  private armHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdogTimer) clearTimeout(this.heartbeatWatchdogTimer);
    this.heartbeatWatchdogTimer = setTimeout(() => {
      this.heartbeatWatchdogTimer = null;
      if (this.manuallyClosed) return;
      if (
        Date.now() - this.lastPairStatusAckAt >
        (this.options.heartbeatAckTimeoutMs ?? DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS)
      ) {
        this.options.logger.warn(
          undefined,
          "[web-remote-control:relay] heartbeat ack watchdog expired",
        );
        this.socket?.close(4001, "heartbeat-timeout");
      }
    }, this.options.heartbeatAckTimeoutMs ?? DEFAULT_HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatWatchdogTimer) clearTimeout(this.heartbeatWatchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.heartbeatWatchdogTimer = null;
    this.reconnectTimer = null;
  }

  private setState(state: RelayDeviceTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}

type RelayMessage =
  | { type: "device_register_ack"; device_sid: string }
  | { type: "auth_challenge"; nonce: string }
  | { type: "auth_ack"; pair_status?: unknown }
  | { type: "pair_status_ack"; pair_status?: unknown }
  | { type: "data"; payload: unknown }
  | { type: "error"; code: string; message?: unknown };

function parseRelayMessage(data: unknown): RelayMessage | null {
  try {
    const text =
      typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.type !== "string") return null;
    return candidate as unknown as RelayMessage;
  } catch {
    return null;
  }
}
