import type { WebRemoteControlStatus } from "@zcode/shared";
import type {
  IWebRemoteControlRelayService,
  WebRemoteControlRelayPairingInfo,
  WebRemoteControlRelayState,
  WebRemoteControlRelayStatus,
} from "./webRemoteControlRelay.js";

/**
 * 自部署 relay 状态 → 官方 `WebRemoteControlStatus` 的纯投影。
 *
 * 背景：官方对话框（`WebRemoteControlDialog`）与 `platform.startWebRemoteControl` 等
 * 四个方法共同构成一套「发起端」契约，但只有 Electron 桌面实现了它。自部署 server
 * 侧实际拥有同一套 relay 能力（`IWebRemoteControlRelayService`），只是状态枚举与
 * 字段名不同。这里做纯投影，让官方卡片在自部署形态直接可用，无需分叉 UI。
 *
 * 映射规则（两侧语义对齐，但枚举名不同，不能同名透传）：
 *
 * | relay `enabled/state` | 官方 `status` | 说明 |
 * | --- | --- | --- |
 * | `enabled:false` | `idle` | 未开启 |
 * | `connecting` | `starting` | 正在连 relay / 注册鉴权中 |
 * | `waiting` | `running` | 已就绪、等待手机扫码 |
 * | `paired` | `active` | 手机已连上 |
 * | `error` | `error` | 终态失败 |
 *
 * `mobileConnected` 只在 `paired` 为真；官方宽限逻辑（`isReusableWebRemoteControlSession`）
 * 依赖它跨 workspace 复用会话。
 */

/** relay 状态 → 官方 status kind。 */
export function mapRelayStateToStatusKind(
  state: WebRemoteControlRelayState,
): WebRemoteControlStatus["status"] {
  switch (state) {
    case "disabled":
      return "idle";
    case "connecting":
      return "starting";
    case "waiting":
      return "running";
    case "paired":
      return "active";
    case "error":
      return "error";
  }
}

export interface RelayStatusProjectionInput {
  relayStatus: WebRemoteControlRelayStatus;
  /** `getPairingInfo()` 的结果；未注册完成时为 null。 */
  pairing: WebRemoteControlRelayPairingInfo | null;
  /** 当前打开的对话框目标工作区（官方契约要求回填 workspacePath 以判定同一目标）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  /** relay 已注册的 deviceSid（windowControlSessionId 口径）。 */
  windowControlSessionId?: string;
}

export function projectRelayStatusToWebRemoteControlStatus(
  input: RelayStatusProjectionInput,
): WebRemoteControlStatus {
  const { relayStatus, pairing } = input;
  const status = mapRelayStateToStatusKind(relayStatus.state);
  const mobileConnected = relayStatus.state === "paired";
  return {
    status,
    // 回填工作区身份：官方对话框用 workspacePath/workspaceIdentity 判定「是否同一目标」，
    // 缺失会让弹层每次打开都重新 start。
    workspacePath: input.workspacePath,
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
    ...(input.initialTaskId ? { initialTaskId: input.initialTaskId } : {}),
    ...(input.windowControlSessionId
      ? {
          windowControlSessionId: input.windowControlSessionId,
          sessionId: input.windowControlSessionId,
        }
      : {}),
    ...(mobileConnected ? { mobileConnected: true } : {}),
    ...(pairing ? { qrUrl: pairing.qrUrl, connectUrl: pairing.qrUrl } : {}),
    ...(relayStatus.state === "error" && relayStatus.errorMessage
      ? { error: relayStatus.errorMessage }
      : {}),
  };
}

/** 供平台实现读取 relay service 的窄接口。 */
export type RelayStatusSource = Pick<
  IWebRemoteControlRelayService,
  "getStatus" | "getPairingInfo" | "setEnabled" | "resetPairing"
>;
