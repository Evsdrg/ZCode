// 闲时任务的调度协作器：认领 → 派发 → 退避结算。
//
// 从 automationScheduler 拆出，保持单一职责：automation 调度与 off-peak 调度表/消息/常量完全独立。
// 只读写 tasks-index，不碰 UI / agent runtime。
import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import { settleOffPeakDispatchResult } from "./automationOffPeakSettlement.js";
import type {
  OffPeakDispatchRequest,
  OffPeakDispatchResultMessage,
} from "./automationSchedulerTypes.js";

type SchedulerLogLevel = "info" | "warn" | "error";

export interface OffPeakDispatchPort {
  dispatchOffPeak(
    request: OffPeakDispatchRequest,
    onResult: (result: OffPeakDispatchResultMessage) => void,
  ): void;
}

export interface OffPeakSchedulerDeps {
  repo: OffPeakTaskRepo;
  dispatch: OffPeakDispatchPort;
  log: (level: SchedulerLogLevel, message: string) => void;
  now: () => number;
  /** 执行中计数变化（桌面据此切 powerSaveBlocker；server 不需要）。 */
  onActiveCountChanged?: (count: number) => void;
  /** 启动时把残留 running 的闲时任务置回 queued（本进程是 app/服务单例）。 */
  recoverInterruptedOnStart?: boolean;
}

/**
 * 闲时任务调度协作器。生命周期由 AutomationScheduler 持有：
 * start() 后每轮 tick 调 claimAndDispatch()；退出时 releaseInFlight()。
 */
export class OffPeakScheduler {
  private readonly repo: OffPeakTaskRepo;
  private readonly dispatch: OffPeakDispatchPort;
  private readonly log: (level: SchedulerLogLevel, message: string) => void;
  private readonly now: () => number;
  private readonly onActiveCountChanged: ((count: number) => void) | undefined;

  /** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。重启即重置，无害。 */
  private readonly retryAt = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  /** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
  private readonly inFlight = new Set<string>();
  private lastActiveCount = -1;

  constructor(deps: OffPeakSchedulerDeps) {
    this.repo = deps.repo;
    this.dispatch = deps.dispatch;
    this.log = deps.log;
    this.now = deps.now;
    this.onActiveCountChanged = deps.onActiveCountChanged;
  }

  async ensureRepoReady(): Promise<void> {
    await this.repo.ensureReady();
  }

  async recoverOnStart(): Promise<void> {
    await this.repo.ensureReady();
    // 闲时任务中断恢复：本进程是 app/服务单例，先于任何派发启动——此刻 DB 里的
    // running 必属上一个进程实例残留，安全置回 queued（session 保留供 resume 续跑）。
    try {
      const recovered = await this.repo.recoverInterrupted(this.now());
      if (recovered > 0) {
        this.log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
      }
    } catch (error) {
      this.log(
        "error",
        `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 每轮 tick：认领到期任务 → 派发/退避。 */
  async claimAndDispatch(now: number): Promise<void> {
    const claimed = await this.repo.claimDue(now);
    for (const task of claimed) {
      await this.handleClaimed(task.offPeakTaskId, now, task);
    }
  }

  /** 执行中计数上报（keep-awake）：仅在值变化时上报，减噪。 */
  async reportActiveCount(): Promise<void> {
    try {
      const count = await this.repo.countActive();
      if (count === this.lastActiveCount) return;
      this.lastActiveCount = count;
      this.onActiveCountChanged?.(count);
    } catch (error) {
      this.log(
        "warn",
        `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 认领后派发闲时任务。退避中的任务立即释放认领等下轮（进程内退避表；每轮 claim+release
   * 两次写，任务数小、WAL 下开销可忽略）。
   */
  private async handleClaimed(
    offPeakTaskId: string,
    now: number,
    task: {
      prompt: string;
      permissionMode: string;
      modelSelection?: unknown;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
  ): Promise<void> {
    // claimDue 已跳过无 Selection 的历史行；这里再兜一次，避免类型收窄成断言。
    if (!task.modelSelection) {
      await this.repo.releaseClaim(offPeakTaskId, { now });
      return;
    }
    const retryAt = this.retryAt.get(offPeakTaskId) ?? 0;
    if (retryAt > now) {
      await this.repo.releaseClaim(offPeakTaskId, { now });
      return;
    }
    this.inFlight.add(offPeakTaskId);
    const request: OffPeakDispatchRequest = {
      type: "offpeak",
      offPeakTaskId,
      prompt: task.prompt,
      permissionMode: task.permissionMode,
      modelSelection: task.modelSelection as OffPeakDispatchRequest["modelSelection"],
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    };
    this.dispatch.dispatchOffPeak(request, (result) => {
      this.inFlight.delete(result.offPeakTaskId);
      void settleOffPeakDispatchResult(
        {
          repo: this.repo,
          retryAt: this.retryAt,
          retryAttempts: this.retryAttempts,
          now: this.now,
          log: this.log,
        },
        result,
      ).catch((error) => {
        this.log(
          "error",
          `settle off-peak dispatch result failed task=${result.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    this.log("info", `off-peak dispatch requested task=${offPeakTaskId}`);
  }

  /** 退出路径：释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。 */
  async releaseInFlight(): Promise<void> {
    for (const offPeakTaskId of this.inFlight) {
      try {
        await this.repo.releaseClaim(offPeakTaskId);
      } catch {
        // 忽略：退出路径尽力而为。
      }
    }
    this.inFlight.clear();
  }
}
