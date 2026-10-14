// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责（tasks-index 属主方案）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - 轮询 automation_runs 里的 manual run，手动触发累计 run_count，但不推进 next_run_at / max_runs / lifecycle
//   - 维护派发状态机：misfire 跳过、single-flight 认领、成功结算、失败退避重试
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行 createTask+sendPrompt）
//   - 收到 main 回报后结算 automation + automation_runs
//   - 闲时任务（off_peak_tasks）：启动回收中断任务，认领 schedulable=1 的 queued 任务派发；
//     与 automation 表/消息/常量全部独立，⚠ 无 misfire-skip 语义（顺延不丢弃）
//
// 认领/派发编排/结算的核心逻辑已下沉到 @zcode/services/node 的 AutomationScheduler，
// 与自部署 server 共用一份实现。本进程只提供「消息端口」：把请求 postMessage 给 main，
// 结果经消息回报触发回调。本进程只读写 tasks-index，不碰 UI / agent runtime。
import { AutomationRepo, AutomationScheduler, OffPeakTaskRepo } from "@zcode/services/node";
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  OffPeakDispatchRequest,
  OffPeakDispatchResultMessage,
} from "@zcode/services/node";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

const { parentPort } = process;

const repo = new AutomationRepo();
// ---- 闲时任务（off-peak）----
const offPeakRepo = new OffPeakTaskRepo();

/** 在途派发的回调：结果消息回来后按 runId / offPeakTaskId 找回并触发结算。 */
const automationCallbacks = new Map<string, (result: AutomationDispatchResult) => void>();
const offPeakCallbacks = new Map<string, (result: OffPeakDispatchResultMessage) => void>();

let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

const scheduler = new AutomationScheduler({
  automationRepo: repo,
  offPeakRepo,
  recoverInterruptedOnStart: true,
  log,
  onOffPeakActiveCountChanged: (count) => {
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  },
  dispatch: {
    dispatchAutomation(request: AutomationDispatchRequest, onResult) {
      automationCallbacks.set(request.runId, onResult);
      parentPort?.postMessage({
        ...request,
        type: "cron-dispatch-request",
      } satisfies SchedulerToMainMessage);
    },
    dispatchOffPeak(request: OffPeakDispatchRequest, onResult) {
      offPeakCallbacks.set(request.offPeakTaskId, onResult);
      parentPort?.postMessage({
        ...request,
        type: "offpeak-dispatch-request",
      } satisfies SchedulerToMainMessage);
    },
  },
});

async function dispose(): Promise<void> {
  if (resourceTelemetry) {
    resourceTelemetry.stop();
    resourceTelemetry = null;
  }
  await scheduler.dispose();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  try {
    offPeakRepo.close();
  } catch {
    // 忽略。
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    const callback = automationCallbacks.get(msg.runId);
    automationCallbacks.delete(msg.runId);
    if (callback) {
      callback({
        runId: msg.runId,
        ok: msg.ok,
        ...(msg.taskId ? { taskId: msg.taskId } : {}),
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        ...(msg.error ? { error: msg.error } : {}),
        ...(msg.failureKind ? { failureKind: msg.failureKind } : {}),
      });
    }
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    const callback = offPeakCallbacks.get(msg.offPeakTaskId);
    offPeakCallbacks.delete(msg.offPeakTaskId);
    callback?.({
      offPeakTaskId: msg.offPeakTaskId,
      ok: msg.ok,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      ...(msg.error ? { error: msg.error } : {}),
      ...(msg.failureKind ? { failureKind: msg.failureKind } : {}),
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    scheduler.wake(msg.automationId);
  }
});

async function main(): Promise<void> {
  await scheduler.start();
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
