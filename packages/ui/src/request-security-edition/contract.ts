/**
 * request-security-ui 对外契约：请求校验（验证码）在 UI 侧的两个挂载点。
 *
 * 调用方只需要知道两件事：
 *  1. `RequestSecurityHost` 必须常驻渲染（验证码 SDK 需要它的 DOM 锚点）；
 *  2. `RequestSecurityWorkspaceBridge` 必须为每个打开的 workspace tab 常驻挂载
 *     （它是 `providerRuntimeHeaders.request` 的应答方，缺失会让任务卡在「工作中」）。
 *
 * 其余（SDK 加载、pending 管理、错误文案）都是模块内部实现，不对外暴露。
 */
import type { ReactElement } from "react";

import type { RequestSecurityWorkspaceTab } from "@/request-security.js";
import type { RequestVerificationConfig } from "@zcode/shared";

/**
 * 本模块需要的最小配置源端口。
 *
 * 为什么不用 `ICodingPlanSubscriptionService`：`packages/ui` 的架构规则禁止 UI 层直接
 * 依赖 service 实现（`ui-implementation-import`）。这里只需要一个方法，就只声明这一个方法；
 * 调用方传 `services.codingPlanSubscriptionService` 时结构上自然满足。
 */
export interface RequestVerificationConfigSource {
  getRequestVerificationConfig(): Promise<RequestVerificationConfig | null>;
}

export interface RequestSecurityUiContract {
  /**
   * 渲染验证码 SDK 所需的隐藏 DOM 容器。
   *
   * 前置：无。后置：页面内存在三个固定 id 的节点，供 SDK 挂载弹窗。
   * 幂等：可以重复渲染（React 只保留一棵），但不能卸载——卸载后正在进行的验证会抛
   * `Captcha host container is not mounted.`。
   */
  RequestSecurityHost(): ReactElement;

  /**
   * 为给定 workspace tab 集合维持常驻应答方。
   *
   * 前置：每个 tab 必须带 `workspacePath`（可带 `workspaceIdentity` / `remoteSessionId`）。
   * 后置：每个 tab 一个订阅，收到 `providerRuntimeHeaders.request` 后异步回填验证码证明。
   * 副作用：会拉起系统验证码弹窗（用户交互），失败时回 `headersApplied: false`。
   * 幂等：tab 列表不变时不重复订阅；tab 移除时订阅随之释放。
   */
  RequestSecurityWorkspaceBridge(props: {
    workspaceTabs: readonly RequestSecurityWorkspaceTab[];
  }): ReactElement | null;
}
