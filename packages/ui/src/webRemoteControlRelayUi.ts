import type { IPlatformService } from "@zcode/shared";
import type { IWebRemoteControlRelayService } from "@zcode/services";

/**
 * 远控入口的展示投影。
 *
 * 对话框只有一张官方「手机扫码连接」卡片（上游 3.15.1 引入），它走官方四个
 * platform 方法。该卡片此前只在桌面可用——自部署浏览器里 Web 平台是拒绝桩。
 * 现在自部署 server 把 relay 服务（同一个 zcode.z.ai 中转）投影进这四个方法
 * （见 packages/web 的 createWebPlatform 与 services 的 relayStatusProjection），
 * 卡片在两种形态下都能发起。本文件只做判定与图标映射，不缓存连接事实。
 */

/**
 * 官方「手机扫码连接」卡片能否发起远控。
 *
 * 桌面走原生链路：openCuaPermissionOnboarding 只在 Electron preload 注入
 * （Web 平台没有该属性），故 typeof 判定即可区分，无需 UA 嗅探。
 * 自部署走 relay：server 注册了 relay 服务即代表四个方法已接它。
 */
export function resolveWebRemoteControlAvailable(input: {
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined;
  relayService: IWebRemoteControlRelayService | undefined | null;
}): boolean {
  if (typeof input.platform?.openCuaPermissionOnboarding === "function") return true;
  return Boolean(input.relayService);
}

/** 侧栏入口手机图标的颜色：开启中用 amber（状态指示，见 DESIGN.md 色彩语义约束）。 */
export function resolveRelayTriggerIconClass(active: boolean): string {
  return active ? "text-amber-500" : "text-foreground-subtle";
}
