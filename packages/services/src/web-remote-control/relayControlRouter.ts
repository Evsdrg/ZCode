import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { RelayWorkspaceSource } from "./relayWorkspaceSource.js";

/**
 * 官方手机页的控制消息路由（bootstrap / workspace-list / bridge-open / reconnect /
 * platform / 数据面帧）。与桥的生命周期解耦：本模块只做协议分派，
 * 具体的桥挂载与 rpc-frame 处理由调用方注入。
 *
 * 任何异常都不得上抛：路由入口由 relay socket 事件驱动，
 * 未捕获异常会终止 server 主进程（曾实测）。
 */

export type RelayControlMessage = {
  zcode_type: string;
  requestId?: unknown;
  [key: string]: unknown;
};

export interface RelayControlRouterDeps {
  sendFrame(message: Record<string, unknown>): void;
  source: RelayWorkspaceSource;
  /** 挂载数据面桥并回 workspace-bridge-ready/error。 */
  openBridge(message: RelayControlMessage): Promise<void>;
  handleRpcFrame(message: RelayControlMessage): void;
  logger: ServiceLogger;
}

export interface RelayControlRouter {
  route(payload: unknown): void;
}

export function createRelayControlRouter(deps: RelayControlRouterDeps): RelayControlRouter {
  const sendControl = deps.sendFrame;

  function routeUnsafe(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const message = payload as RelayControlMessage;
    const requestId = message.requestId;
    switch (message.zcode_type) {
      case "bootstrap-request":
        void deps.source.buildBootstrapResult().then(
          (result) => {
            const sent = sendControl({
              zcode_type: "bootstrap-response",
              requestId,
              success: true,
              result,
            });
            deps.logger.info(undefined, "[relay] bootstrap-response 已发送", { sent });
          },
          (error: unknown) => {
            const sent = sendControl({
              zcode_type: "bootstrap-response",
              requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
            deps.logger.info(undefined, "[relay] bootstrap-response(失败) 已发送", { sent });
          },
        );
        break;
      case "workspace-list-request":
        void deps.source.buildListResult().then(
          (result) =>
            sendControl({
              zcode_type: "workspace-list-response",
              requestId,
              success: true,
              result,
            }),
          (error: unknown) =>
            sendControl({
              zcode_type: "workspace-list-response",
              requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        break;
      case "workspace-bridge-open":
        void deps.openBridge(message);
        break;
      case "workspace-reconnect-request":
        // 自部署形态的 workspace 常驻本进程，无远端重连语义；恒成功。
        sendControl({
          zcode_type: "workspace-reconnect-response",
          requestId,
          workspaceKey: message.workspaceKey,
          success: true,
        });
        break;
      case "platform-request":
        sendControl({
          zcode_type: "platform-response",
          requestId,
          method: message.method,
          success: false,
          error: "platform requests are not supported on the self-host relay bridge",
        });
        break;
      case "mobile-view-state-update":
      case "telemetry-report":
      case "mobile-diagnostic":
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        deps.handleRpcFrame(message);
        break;
      default:
        deps.logger.debug(undefined, "[relay] 忽略未知控制消息", {
          zcodeType: message.zcode_type,
        });
        break;
    }
  }

  return {
    route(payload: unknown) {
      try {
        routeUnsafe(payload);
      } catch (error) {
        deps.logger.warn(undefined, "[relay] 路由 payload 抛错（已忽略，不影响主进程）", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
