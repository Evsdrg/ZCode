/**
 * 下沉后 transport 的遥测端口。
 *
 * 官方 transport 原先直接调用桌面专属的 `desktopNetworkTelemetry`
 * （经 `@arms/rum-electron` 上报 ARMS）。下沉到 `@zcode/services` 后不能反向依赖
 * desktop 包，因此改为端口注入：桌面传入真实实现，server 侧不注入即用 no-op。
 *
 * 只保留官方 transport 实际用到的两个事件语义，不搬运桌面聚合器。
 */
export interface WebRemoteControlRelayTelemetryPort {
  /**
   * 一次连接尝试结束。`success` 为 false 表示失败或未配对即断开。
   * `error` 仅在 socket error 路径提供；`attempt` 为自增的尝试序号。
   */
  noteConnectAttempt(
    durationMs: number,
    success: boolean,
    details: { error?: unknown; attempt?: number },
  ): void;
  /** 已配对连接断开并即将重连。 */
  noteReconnect(): void;
}

/** 默认实现：不做任何上报。server 与测试环境使用。 */
export const NOOP_WEB_REMOTE_CONTROL_RELAY_TELEMETRY: WebRemoteControlRelayTelemetryPort = {
  noteConnectAttempt: () => {},
  noteReconnect: () => {},
};

// 下沉适配：官方 transport 直接 import 桌面遥测函数。这里提供同名模块级函数，
// 转发到端口；server 侧无桌面聚合器，默认 no-op。未来如需服务端遥测再注入端口实现。
let telemetryPort: WebRemoteControlRelayTelemetryPort = NOOP_WEB_REMOTE_CONTROL_RELAY_TELEMETRY;

export function setWebRemoteControlRelayTelemetryPort(
  port: WebRemoteControlRelayTelemetryPort,
): void {
  telemetryPort = port;
}

export function noteWebRemoteRelayConnectAttempt(
  durationMs: number,
  success: boolean,
  details: { attempt?: number },
): void {
  telemetryPort.noteConnectAttempt(durationMs, success, details);
}

export function noteWebRemoteRelayReconnect(): void {
  telemetryPort.noteReconnect();
}
