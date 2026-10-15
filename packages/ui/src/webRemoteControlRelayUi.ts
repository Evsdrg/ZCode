import type { IPlatformService } from "@zcode/shared";
import type { IWebRemoteControlRelayService, WebRemoteControlRelayStatus } from "@zcode/services";

/**
 * 远控对话框两张卡片的纯逻辑：官方中转卡片与原生「手机扫码连接」卡片的可见性、
 * 状态文案与主操作映射。事实所有者分别是服务端 WebRemoteControlRelayService 与
 * 桌面端原生远控；本文件只做展示投影，不缓存连接事实。
 */

export function resolveRelaySectionVisible(
  service: IWebRemoteControlRelayService | undefined | null,
): service is IWebRemoteControlRelayService {
  return Boolean(service);
}

/**
 * 原生「手机扫码连接」卡片是否可用。
 *
 * 上游 3.15.1 给对话框加了这张卡，它走 platform.startWebRemoteControl，而只有
 * Electron 桌面端能真正发起：Web 平台的实现是永远拒绝的桩（main.tsx 里
 * "Web remote control can only be started from desktop"）。自部署浏览器里开屏必报
 * 这个错，且这张卡与上面的官方中转卡片功能重复（都是二维码 + 复制链接），
 * 自部署可用的入口是中转卡片。
 *
 * 判据用可选方法 openCuaPermissionOnboarding——它只在桌面 preload 注入
 * （packages/desktop/src/preload/index.ts），Web 平台没有该属性，因此
 * typeof 判定即可区分，无需 UA 嗅探。与 lib/cuaPlatform.ts 的
 * 「UA + capability」双判同一模式：先确认平台真有这个能力，再渲染依赖它的入口。
 */
export function resolveNativeWebRemoteControlVisible(
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined,
): boolean {
  return typeof platform?.openCuaPermissionOnboarding === "function";
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
