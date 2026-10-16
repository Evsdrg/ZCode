import type { IPlatformService } from "@zcode/shared";
import type { IWebRemoteControlRelayService, WebRemoteControlRelayStatus } from "@zcode/services";

/**
 * 远控对话框的展示投影：官方「手机扫码连接」卡片的可用性，以及自部署中转卡片的
 * 可见性与状态文案。事实所有者分别是桌面端原生远控与服务端 WebRemoteControlRelayService；
 * 本文件只做展示投影，不缓存连接事实。
 */

/**
 * 官方「手机扫码连接」卡片能否发起远控。
 *
 * 该卡片走官方四个 platform 方法，此前只有 Electron 桌面实现了原生链路
 * （需要 MessagePort sideband 把 AttachServicePort 注入窗口 Host），Web 平台是拒绝桩，
 * 所以自部署浏览器里开屏必报 startFailed。现在自部署 server 侧把 relay 服务
 * （同一个 zcode.z.ai 中转）投影进这四个方法（见 packages/web 的 createWebPlatform
 * 与 services 的 relayStatusProjection），卡片在两种形态下都能发起。
 *
 * 判据：桌面看 preload 注入的 openCuaPermissionOnboarding（可选方法，Web 平台没有）；
 * 自部署看 server 是否注册了 relay 服务。
 */
export function resolveWebRemoteControlAvailable(input: {
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined;
  relayService: IWebRemoteControlRelayService | undefined | null;
}): boolean {
  if (typeof input.platform?.openCuaPermissionOnboarding === "function") return true;
  return Boolean(input.relayService);
}

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
