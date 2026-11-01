/**
 * 请求校验（验证码）的 UI 宿主与常驻应答方。
 *
 * 两部分职责：
 *  1. `RequestSecurityHost`：渲染阿里云验证码 SDK 需要的三个隐藏 DOM 节点。
 *     节点 id 由 SDK 约定（container / element / button），必须常驻挂载，
 *     否则验证码开始初始化时会抛 `Captcha host container is not mounted.`。
 *  2. `RequestSecurityWorkspaceBridge`：为每个打开的 workspace 维持一个常驻应答方，
 *     收到 agent 的 `providerRuntimeHeaders.request` 后拉起验证码、回填 header。
 *     必须与「当前展示的 session pane」解耦——否则 web 远控新建的会话在桌面没有 pane，
 *     请求会永远滞留 pending，任务卡在「工作中」。
 */
import type { IPlatformService } from "@zcode/shared";
import { useEffect, useRef } from "react";

import type { RequestSecurityWorkspaceTab } from "@/request-security.js";
import { useServices } from "@/hooks/useServices.js";

import {
  CAPTCHA_BUTTON_ID,
  CAPTCHA_CONTAINER_ID,
  CAPTCHA_ELEMENT_ID,
  prepareRequestVerificationClaim,
} from "./claim.js";

/** 被 `setRequestSecurityReporter` 记录的 reporter，供诊断上报（当前仅保存，便于后续扩展）。 */
let reporter: IPlatformService | null = null;

export function setRequestSecurityReporter(value: IPlatformService | null): void {
  reporter = value;
  void reporter;
}

/**
 * 验证码 SDK 的 DOM 宿主。
 *
 * 容器本身 0 尺寸且 `aria-hidden`：它只是 SDK 用来测量/挂载弹窗的锚点，
 * 真正的弹窗由 SDK 自己插入 body。`z-[2147483647]` 保证不被任何业务弹窗遮挡。
 */
export function RequestSecurityHost() {
  return (
    <div
      id={CAPTCHA_CONTAINER_ID}
      aria-hidden="true"
      className="fixed left-0 top-0 z-[2147483647] h-0 w-0 overflow-visible"
    >
      <div id={CAPTCHA_ELEMENT_ID} className="absolute left-0 top-0 h-0 w-0 overflow-visible" />
      <button
        id={CAPTCHA_BUTTON_ID}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 border-0 p-0 opacity-0"
      />
    </div>
  );
}

/**
 * 每个 workspace tab 一个常驻应答方。
 *
 * 订阅时必须先注册 listener 再消费补投的 pending——这是 service 侧保证的语义，
 * 这里只需保证「订阅生命周期 = tab 在窗口中打开的时间」，不随页面可见性变化。
 */
function WorkspaceProviderRuntimeHeadersResponder({
  tab,
}: {
  tab: RequestSecurityWorkspaceTab;
}): null {
  const services = useServices();
  const workspaceTarget = {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
  };
  // 用 ref 保存最新的 target，避免对象字面量每次渲染都改变 effect 依赖导致反复重订阅。
  const targetRef = useRef(workspaceTarget);
  targetRef.current = workspaceTarget;

  useEffect(() => {
    const agentService = services.zcodeAgentService;
    const subscription = agentService.onDynamicWorkspaceProviderRuntimeHeadersRequest(
      targetRef.current,
    );
    const disposable = subscription((request) => {
      void (async () => {
        // 只处理账号确实需要校验的请求：service 侧已按 requiresRequestVerification 过滤过
        // 投递条件，这里再兜一层，避免把无关的 runtime header 刷新也拉去弹验证码。
        const config = request.requestVerificationConfig;
        if (config && (config.enabled === false || config.skipModelRequest === true)) return;
        try {
          const proof = await prepareRequestVerificationClaim(
            services.codingPlanSubscriptionService,
            new AbortController().signal,
            () => {},
          );
          const headers = proof?.captchaVerifyParam
            ? {
                "X-Aliyun-Captcha-Verify-Param": proof.captchaVerifyParam,
                ...(proof.captchaRegion
                  ? { "X-Aliyun-Captcha-Verify-Region": proof.captchaRegion }
                  : {}),
              }
            : {};
          if (!proof?.captchaVerifyParam) {
            await agentService.respondProviderRuntimeHeaders({
              ...targetRef.current,
              sessionId: request.sessionId,
              requestId: request.requestId,
              response: {
                headersApplied: false,
                errorMessage: "Captcha verification did not produce a proof.",
              },
            });
            return;
          }
          await agentService.respondProviderRuntimeHeaders({
            ...targetRef.current,
            sessionId: request.sessionId,
            requestId: request.requestId,
            response: { headersApplied: true, runtimeProviderHeaders: headers },
          });
        } catch (error) {
          await agentService
            .respondProviderRuntimeHeaders({
              ...targetRef.current,
              sessionId: request.sessionId,
              requestId: request.requestId,
              response: {
                headersApplied: false,
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            })
            .catch(() => {
              // 请求可能已被取消或超时；此时应答失败属正常，不向 UI 抛错。
            });
        }
      })();
    });
    return () => {
      disposable.dispose();
    };
  }, [services, tab.workspacePath, tab.workspaceIdentity, tab.remoteSessionId]);

  return null;
}

/**
 * workspace 级应答方集合。
 *
 * `workspaceTabs` 由 Root 传入当前窗口打开的全部 tab，包含 web 远控新建的会话。
 */
export function RequestSecurityWorkspaceBridge({
  workspaceTabs,
}: {
  workspaceTabs: readonly RequestSecurityWorkspaceTab[];
}): React.ReactElement | null {
  if (workspaceTabs.length === 0) return null;
  return (
    <>
      {workspaceTabs.map((tab) => (
        <WorkspaceProviderRuntimeHeadersResponder
          key={`${tab.workspaceIdentity ?? tab.workspacePath}::${tab.remoteSessionId ?? ""}`}
          tab={tab}
        />
      ))}
    </>
  );
}
