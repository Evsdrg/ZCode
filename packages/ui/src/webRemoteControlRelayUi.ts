import type { IWebRemoteControlRelayService, WebRemoteControlRelayStatus } from "@zcode/services";

/**
 * 「官方中转远程控制」区块的纯逻辑：可见性、状态文案与主操作的映射。
 * 事实所有者是服务端 WebRemoteControlRelayService；本文件只做展示投影，不缓存连接事实。
 */

export function resolveRelaySectionVisible(
  service: IWebRemoteControlRelayService | undefined | null,
): service is IWebRemoteControlRelayService {
  return Boolean(service);
}

export type RelayStateLabelId =
  | "webRemoteControl.relay.state.disabled"
  | "webRemoteControl.relay.state.connecting"
  | "webRemoteControl.relay.state.waiting"
  | "webRemoteControl.relay.state.paired"
  | "webRemoteControl.relay.state.error";

export function resolveRelayStateLabelId(
  status: WebRemoteControlRelayStatus | null,
): RelayStateLabelId {
  if (!status?.enabled) return "webRemoteControl.relay.state.disabled";
  switch (status.state) {
    case "waiting":
      return "webRemoteControl.relay.state.waiting";
    case "paired":
      return "webRemoteControl.relay.state.paired";
    case "error":
      return "webRemoteControl.relay.state.error";
    default:
      return "webRemoteControl.relay.state.connecting";
  }
}

export type RelayStatusTone = "neutral" | "loading" | "success" | "danger";

export function resolveRelayStatusTone(
  status: WebRemoteControlRelayStatus | null,
): RelayStatusTone {
  if (!status?.enabled) return "neutral";
  switch (status.state) {
    case "paired":
      return "success";
    case "error":
      return "danger";
    case "waiting":
      return "success";
    default:
      return "loading";
  }
}

export type RelayPrimaryAction = "enable" | "disable" | "retry" | null;

/** 状态 → 主按钮动作；waiting/paired 都属于已开启（disable），error 提供重试。 */
export function resolveRelayPrimaryAction(
  status: WebRemoteControlRelayStatus | null,
): RelayPrimaryAction {
  if (!status?.enabled) return "enable";
  if (status.state === "error") return "retry";
  return "disable";
}

/** 二维码只在等待扫码阶段展示；paired 后保留最近一张以便新设备接入。 */
export function shouldRenderRelayQrCode(status: WebRemoteControlRelayStatus | null): boolean {
  if (!status?.enabled) return false;
  return status.state === "waiting" || status.state === "paired";
}

/** 侧栏入口手机图标的颜色：开启中用 amber（状态指示，见 DESIGN.md 色彩语义约束）。 */
export function resolveRelayTriggerIconClass(active: boolean): string {
  return active ? "text-amber-500" : "text-foreground-subtle";
}
