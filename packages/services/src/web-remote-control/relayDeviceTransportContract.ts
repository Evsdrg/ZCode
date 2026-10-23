import type { WebRemoteControlAppPayload } from "@zcode/shared";
import type { WebRemoteControlRelayV2Meta } from "@zcode/shared/web-remote-relay";
import type { WebSocket as NodeWebSocket } from "ws";

// 下沉自桌面 web-remote-relay/contract.ts 的 transport 相关类型；
// 设备存储/登录类型由 server 侧自行实现（settings + 账号凭据）。

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

/** 下沉新增：测试注入 fake socket；未注入时行为与官方一致（ws）。 */
export type WebRemoteControlRelaySocketCtor = (
  url: string | URL,
  options: { perMessageDeflate: boolean },
) => NodeWebSocket;

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  meta?: WebRemoteControlRelayV2Meta;
  socketCtor?: WebRemoteControlRelaySocketCtor;
  getToken(signal: AbortSignal): Promise<string>;
  resolveDeviceSid(signal: AbortSignal, forceRegistration: boolean): Promise<string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
}
