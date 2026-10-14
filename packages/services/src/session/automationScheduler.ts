// 定时任务调度核心（认领 + 派发编排 + 结算）。
//
// 这是桌面 scheduler 进程与自部署 server 共用的唯一实现：调用方只注入 repo 与「派发端口」。
// - 桌面：端口把请求 postMessage 给 main，结果经消息回报触发回调（非阻塞，语义与旧实现一致）。
// - server：端口直接调用本进程 task service，完成后回调（同样非阻塞）。
//
// 本模块只读写 tasks-index，不碰 UI / agent runtime；createTask 由调用方端口执行。
// 闲时任务的认领/派发/退避在 automationOffPeakScheduler（表/消息/常量与 automation 独立）。
import { computeAutomationNextRunAt, isOneShotAutomation } from "./automationCron.js";
import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { AutomationRepo } from "./automationRepo.js";
import {
  settleManualClaimForDispatchResult,
  type CronRunLifecycleRepo,
  type LogWarn,
} from "./automationRunLifecycle.js";
import { OffPeakScheduler } from "./automationOffPeakScheduler.js";
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult,
  OffPeakDispatchRequest,
  OffPeakDispatchResultMessage,
} from "./automationSchedulerTypes.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ZCodeAutomation, ZCodeAutomationRun, ZCodeAutomationTrigger } from "@zcode/shared";

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
export const AUTOMATION_SCHEDULER_POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 */
export const AUTOMATION_SCHEDULER_MISFIRE_GRACE_MS = 5 * 60_000;

/**
 * 派发端口：调用方负责把请求送到真正的执行域，并在结果产生时回调。
 * 端口实现必须对同一 request 恰好回调一次（成功或失败都算）。
 */
export interface AutomationSchedulerDispatchPort {
  dispatchAutomation(
    request: AutomationDispatchRequest,
    onResult: (result: AutomationDispatchResult) => void,
  ): void;
  dispatchOffPeak?(
    request: OffPeakDispatchRequest,
    onResult: (result: OffPeakDispatchResultMessage) => void,
  ): void;
}

type SchedulerLogLevel = "info" | "warn" | "error";

export interface AutomationSchedulerDeps {
  automationRepo: AutomationRepo;
  /** 闲时任务与 automation 完全独立；未提供则不调度闲时任务。 */
  offPeakRepo?: OffPeakTaskRepo;
  dispatch: AutomationSchedulerDispatchPort;
  log: (level: SchedulerLogLevel, message: string) => void;
  now?: () => number;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
  /** 闲时任务执行中计数变化（桌面据此切 powerSaveBlocker；server 不需要）。 */
  onOffPeakActiveCountChanged?: (count: number) => void;
  /** 启动时把残留 running 的闲时任务置回 queued。桌面 scheduler 是 app 单例，server 是进程单例。 */
  recoverInterruptedOnStart?: boolean;
}

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

/**
 * 单例调度器。生命周期：start() 起轮询 → wake() 或定时触发 tick → dispose() 释放在途认领。
 * repo 由调用方持有并负责关闭；本类只释放「认领」这一软状态。
 */
export class AutomationScheduler {
  private readonly automationRepo: AutomationRepo;
  private readonly offPeak: OffPeakScheduler | undefined;
  private readonly dispatch: AutomationSchedulerDispatchPort;
  private readonly log: (level: SchedulerLogLevel, message: string) => void;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly misfireGraceMs: number;
  private readonly recoverInterruptedOnStart: boolean;

  /** runId → 在途派发上下文；等结果回调后结算。进程重启丢失时靠 claimDue 的僵尸回收兜底。 */
  private readonly inFlight = new Map<string, InFlight>();

  private ticking = false;
  private tickRequested = false;
  private ready = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AutomationSchedulerDeps) {
    this.automationRepo = deps.automationRepo;
    this.dispatch = deps.dispatch;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? AUTOMATION_SCHEDULER_POLL_INTERVAL_MS;
    this.misfireGraceMs = deps.misfireGraceMs ?? AUTOMATION_SCHEDULER_MISFIRE_GRACE_MS;
    this.recoverInterruptedOnStart = deps.recoverInterruptedOnStart ?? false;
    this.offPeak =
      deps.offPeakRepo && deps.dispatch.dispatchOffPeak
        ? new OffPeakScheduler({
            repo: deps.offPeakRepo,
            dispatch: {
              dispatchOffPeak: deps.dispatch.dispatchOffPeak.bind(deps.dispatch),
            },
            log: deps.log,
            now: this.now,
            ...(deps.onOffPeakActiveCountChanged
              ? { onActiveCountChanged: deps.onOffPeakActiveCountChanged }
              : {}),
          })
        : undefined;
  }

  private get lifecycleRepo(): AutomationRepo & CronRunLifecycleRepo {
    return this.automationRepo as AutomationRepo & CronRunLifecycleRepo;
  }

  private logWarn: LogWarn = (message, error) => {
    this.log("warn", `${message}: ${error instanceof Error ? error.message : String(error)}`);
  };

  async start(): Promise<void> {
    await this.automationRepo.ensureReady();
    if (this.offPeak) {
      // OffPeakScheduler 在 recoverOnStart 内完成 repo ensureReady；未开恢复时也要初始化 repo。
      if (this.recoverInterruptedOnStart) {
        await this.offPeak.recoverOnStart();
      } else {
        await this.offPeak.ensureRepoReady();
      }
    }
    if (this.disposed) return;
    this.ready = true;
    this.log("info", "automation scheduler started");
    this.requestTick();
    this.pollTimer = setInterval(() => this.requestTick(), this.pollIntervalMs);
  }

  /** manual run 落库后立即唤醒，不等待下一次轮询。 */
  wake(automationId: string): void {
    if (this.disposed) return;
    this.log("info", `manual run wake requested automation=${automationId}`);
    this.requestTick();
  }

  private requestTick(): void {
    if (this.disposed) return;
    // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
    // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
    if (!this.ready || this.ticking) {
      this.tickRequested = true;
      return;
    }
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.ready || this.ticking) return;
    this.ticking = true;
    try {
      do {
        this.tickRequested = false;
        try {
          const now = this.now();
          const claimed = await this.automationRepo.claimDue(now);
          for (const automation of claimed) {
            await this.handleClaimed(automation, now);
          }
          const manualRuns = await this.automationRepo.claimManualRuns(now);
          for (const manualRun of manualRuns) {
            await this.handleClaimedManual(manualRun.automation, manualRun.run);
          }
          if (this.offPeak) {
            await this.offPeak.claimAndDispatch(now);
            // keep-awake：上报执行中计数，桌面 main 据此 + 设置决定 powerSaveBlocker。
            await this.offPeak.reportActiveCount();
          }
        } catch (error) {
          this.log(
            "error",
            `tick failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } while (this.tickRequested && !this.disposed);
    } finally {
      this.ticking = false;
    }
  }

  /** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
  private resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
    return automation.nextRunAt ?? automation.retryAt ?? now;
  }

  private buildRunId(automationId: string, scheduledAt: number): string {
    return `${automationId}:${scheduledAt}`;
  }

  private async handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
    const scheduledAt = this.resolveScheduledAt(automation, now);
    const runId = this.buildRunId(automation.automationId, scheduledAt);
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - this.misfireGraceMs;
    if (missed) {
      // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
      // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
      // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
      await this.automationRepo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      this.log(
        "info",
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }

    // 正常派发：先落/更新 run 台账（claimed），再请求端口派发。
    await this.automationRepo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
      // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
    });
    this.inFlight.set(runId, {
      automationId: automation.automationId,
      workspaceKey,
      trigger: "schedule",
    });
    const run = await this.automationRepo.getRun(runId);
    this.postDispatchRequest(automation, runId, run?.modelSelection);
  }

  private postDispatchRequest(
    automation: ZCodeAutomation,
    runId: string,
    fixedSelection?: ZCodeAutomationRun["modelSelection"],
  ): void {
    const request: AutomationDispatchRequest = {
      type: "automation",
      automationId: automation.automationId,
      runId,
      prompt: automation.prompt,
      ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
      ...((fixedSelection ?? automation.modelSelection)
        ? { modelSelection: fixedSelection ?? automation.modelSelection }
        : {}),
      ...(automation.mode ? { mode: automation.mode } : {}),
      workspacePath: automation.workspacePath,
      ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
    };
    this.dispatch.dispatchAutomation(request, (result) => {
      void this.settleDispatchResult(result).catch((error) => {
        this.log(
          "error",
          `settle dispatch result failed runId=${result.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  private async handleClaimedManual(
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
  ): Promise<void> {
    this.inFlight.set(run.runId, {
      automationId: automation.automationId,
      workspaceKey: resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      }),
      trigger: "manual",
    });
    this.postDispatchRequest(automation, run.runId, run.modelSelection);
  }

  private async settleDispatchResult(msg: AutomationDispatchResult): Promise<void> {
    const context = this.inFlight.get(msg.runId);
    this.inFlight.delete(msg.runId);
    const now = this.now();
    // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
    const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
    const workspaceKey = context?.workspaceKey;
    const trigger: ZCodeAutomationTrigger =
      context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
    try {
      if (msg.ok) {
        if (trigger === "manual") {
          await this.automationRepo.markManualRunDispatched({
            runId: msg.runId,
            sessionId: msg.sessionId ?? null,
            dispatchedAt: now,
          });
          await settleManualClaimForDispatchResult({
            repo: this.lifecycleRepo,
            automationId,
            runId: msg.runId,
            workspaceKey,
            ok: true,
            logError: (message) => this.log("error", message),
          });
          return;
        }
        await this.automationRepo.markRunDispatch({
          runId: msg.runId,
          dispatchStatus: "dispatched",
          sessionId: msg.sessionId ?? null,
        });
        const automation = await this.automationRepo.get(automationId);
        const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
        await this.automationRepo.markDispatched(automationId, {
          dispatchedAt: now,
          nextRunAt,
        });
        return;
      }

      await this.automationRepo.markRunDispatch({
        runId: msg.runId,
        dispatchStatus: "failed_to_dispatch",
        error: msg.error ?? "dispatch failed",
      });
      if (trigger === "manual") {
        await settleManualClaimForDispatchResult({
          repo: this.lifecycleRepo,
          automationId,
          runId: msg.runId,
          workspaceKey,
          ok: false,
          logError: (message) => this.log("error", message),
        });
        return;
      }
      const kind = msg.failureKind ?? "transient";
      await this.automationRepo.markDispatchFailed(automationId, {
        failedAt: now,
        error: msg.error ?? "dispatch failed",
        kind,
        // transient 达上限后循环任务跳下一个正常 next_run_at。
        nextRunAt: await this.automationRepo
          .get(automationId)
          .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
      });
    } finally {
      // 结算后立即补跑一轮：manual run 可能因同一 automation 已有派发在途而暂时无法认领，
      // 释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
      this.requestTick();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。repo 由调用方关闭。
    for (const [, context] of this.inFlight) {
      try {
        if (context.trigger === "manual") {
          await this.automationRepo.releaseManualClaim(context.automationId, context.workspaceKey);
        } else {
          await this.automationRepo.releaseClaim(context.automationId);
        }
      } catch {
        // 忽略：退出路径尽力而为。
      }
    }
    this.inFlight.clear();
    await this.offPeak?.releaseInFlight();
  }
}
