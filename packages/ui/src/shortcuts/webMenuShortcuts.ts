/**
 * Web 端可配置的 menu 通道命令白名单（唯一事实来源）。
 *
 * menu 通道命令的默认语义是「由 Electron 原生菜单的 accelerator 触发」，浏览器没有原生菜单，
 * 因此 Web 端历史上一律置灰不可改。但其中两条命令在 Web 有真实回退实现
 * （`useRootPlatformEffects` 的 window keydown 监听直接调用根级动作）：
 * - newTask：在当前工作区新建任务
 * - openWorkspace：打开工作区选择
 *
 * 只要回退监听改为按「生效绑定表」匹配（而不是硬编码默认键位），这两条就可以允许用户改键：
 * 改键后设置页写入 overrides → 生效表重算 → 回退监听读到新键位，行为与桌面端一致。
 *
 * 其余四条（closeActiveContext / zoomIn / zoomOut / resetZoom）在 Web 没有等价实现：
 * 关窗/缩放都依赖宿主窗口，浏览器没有窗口层，因此保持置灰。
 */
import type { ShortcutCommandId } from "@zcode/shared";

/** Web 端有真实回退实现、因此允许改键的 menu 通道命令。 */
export const WEB_CONFIGURABLE_MENU_COMMAND_IDS: ReadonlySet<ShortcutCommandId> = new Set([
  "newTask",
  "openWorkspace",
]);

/** 该 menu 通道命令在 Web 端是否允许改键（非 menu 通道恒为 false）。 */
export function isWebConfigurableMenuCommand(
  commandId: ShortcutCommandId,
  channel: "window" | "menu",
): boolean {
  return channel === "menu" && WEB_CONFIGURABLE_MENU_COMMAND_IDS.has(commandId);
}

/**
 * 快捷键设置页某行的录制入口是否应置灰：仅 Web 端 + menu 通道 + 不在白名单内。
 * 桌面端（isDesktop=true）menu 通道由 main 注册 accelerator，全部可改。
 */
export function isMenuChannelUnavailable(
  commandId: ShortcutCommandId,
  channel: "window" | "menu",
  isDesktop: boolean,
): boolean {
  return channel === "menu" && !isDesktop && !isWebConfigurableMenuCommand(commandId, channel);
}
