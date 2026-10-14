// 自部署 server 调度派发的共享常量与工具。
// 与桌面 host 的等价实现保持同一语义，只是 host 侧经 main 消息转发，server 侧在本进程执行。

/** 派发在 server 侧恒用可重放快照档位：常驻后端没有桌面那种连续投递通道。 */
export const SERVER_CLIENT_MODE = "web-remote-replayable" as const;

export interface DispatchLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

/** 终态订阅键：taskId + traceId，避免同 task 不同 turn 互相顶掉监听。 */
export function subscriptionKey(taskId: string, traceId: string): string {
  return `${taskId}\u0000${traceId}`;
}

/** 从 runId 还原 scheduledAt：`automationId:scheduledAt` / `automationId:manual:uuid`。 */
export function parseRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
