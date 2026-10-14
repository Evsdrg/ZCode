// automation / cron 运行生命周期（纯逻辑，无 IO 与 Electron 依赖）。
// 桌面 Host 与自部署 server 共用：两侧只注入各自的 repo 端口与日志，语义必须一致。
import type { ZCodeAutomationRunOutcome, ZCodeAutomationTrigger } from "@zcode/shared";

export interface CronRunLifecycleRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface CronRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

export type LogWarn = (message: string, error: unknown) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function startManualClaimHeartbeat(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "touchManualClaim">;
    logWarn: LogWarn;
    intervalMs?: number;
  },
): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

async function releaseManualClaimBestEffort(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "releaseManualClaim">;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    dispatchError: unknown;
    logWarn: LogWarn;
  },
): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error
      ? params.dispatchError.message
      : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `回写 manual automation 派发失败状态失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
  await releaseManualClaimBestEffort(params);
}

/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}

export interface ManualClaimReleaseRepo {
  get(automationId: string): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

export async function releaseManualClaimForSettledRun(
  params: ManualClaimReleaseParams,
): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // scheduler 重启 / inFlight 丢失后仍可能收到迟到回报；manual
  // single-flight 锁必须用 run 台账或 automation 兜回 workspaceKey，否则会卡到 stale 回收。
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // host ok 只表示 prompt accepted/queued，真实终态由 host subscription
  // 收口；scheduler 仅在派发失败、没有可等待 turn 时释放 manual claim。
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
