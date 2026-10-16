import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 官方中转远程控制服务（自部署形态）。
 *
 * 状态所有者：本服务（实现见 webRemoteControlRelayService.ts）。UI 只读投影并发命令，
 * 不缓存第二份连接事实。desktop host 不注册本服务（accessor 上为可选成员）。
 */

export type WebRemoteControlRelayState = "disabled" | "connecting" | "waiting" | "paired" | "error";

export interface WebRemoteControlRelayStatus {
  enabled: boolean;
  state: WebRemoteControlRelayState;
  /** 最近的终态错误码（auth / network / …）；非 error 态为空。 */
  errorCode?: string;
  errorMessage?: string;
}

export interface WebRemoteControlRelayPairingInfo {
  /** 官方手机页 URL（含一次性配对参数），前端渲染为二维码。 */
  qrUrl: string;
  deviceName: string;
  /** relay 注册分配的设备会话 id；官方 status 的 sessionId/windowControlSessionId 同口径。 */
  deviceSid: string;
}

export interface IWebRemoteControlRelayService {
  getStatus(): Promise<WebRemoteControlRelayStatus>;
  /** waiting 态返回配对二维码信息；未注册完成时返回 null。 */
  getPairingInfo(): Promise<WebRemoteControlRelayPairingInfo | null>;
  /** 开关远控。幂等：状态不变时 no-op。开启后持久化，server 重启自动重连。 */
  setEnabled(enabled: boolean): Promise<WebRemoteControlRelayStatus>;
  /** 重置配对：重新生成本地设备凭证，旧二维码立即失效。 */
  resetPairing(): Promise<WebRemoteControlRelayStatus>;
}

export const IWebRemoteControlRelayService = createServiceDescriptor<IWebRemoteControlRelayService>(
  ServiceChannels.WebRemoteControlRelay,
);
