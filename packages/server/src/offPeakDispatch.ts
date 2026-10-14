// 自部署 server 的闲时任务派发。
//
// 桌面形态里这段逻辑在 host 进程（dispatchOffPeakRun），经 main 消息转发。自部署 server 没有
// main/host 分层，直接在本进程用同一套 @zcode/services 任务域实现等价语义：
// 三分支（init / bound-first-run / resume）→ 订阅终态 → sendPrompt → 终态回写 files_changed。
//
// 与桌面的唯一语义差异是 clientMode：server 是常驻后端，投递档位必须是 web-remote-replayable。
import { randomUUID } from "node:crypto";
import type { ServiceCollection } from "@zcode/services";
import { IOffPeakTaskService, IZCodeTaskService } from "@zcode/services";
import {
  assertBoundSessionDispatchable,
  buildTaskChangeSummary,
  getOffPeakRequestAuthBuilder,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  resolveOffPeakDispatchKind,
  type OffPeakDispatchRequest,
  type OffPeakDispatchResultMessage,
  type OffPeakRequestAuthBuilder,
  type OffPeakTaskRepo,
  type OffPeakTaskService,
} from "@zcode/services/node";
import type {
  ModelSelection,
  TraceId,
  ZCodeAutomationRunOutcome,
  ZCodeTaskMode,
} from "@zcode/shared";
import {
  SERVER_CLIENT_MODE,
  subscriptionKey,
  type DispatchLogger,
} from "./automationDispatchShared.js";

const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

export interface OffPeakDispatchRuntime {
  dispatch(request: OffPeakDispatchRequest): Promise<OffPeakDispatchResultMessage>;
  dispose(): void;
}

export function createServerOffPeakDispatch(deps: {
  services: ServiceCollection;
  offPeakRepo: OffPeakTaskRepo;
  logger: DispatchLogger;
}): OffPeakDispatchRuntime {
  const { services, offPeakRepo, logger } = deps;
  const runSubscriptions = new Map<string, { dispose(): void }>();
  let offPeakRuntime: {
    service: OffPeakTaskService;
    validateSelection: (selection: ModelSelection) => Promise<boolean>;
    buildRequestAuth: OffPeakRequestAuthBuilder;
  } | null = null;

  async function ensureRuntime(): Promise<typeof offPeakRuntime> {
    if (offPeakRuntime) return offPeakRuntime;
    const service = services.getOptional(IOffPeakTaskService);
    if (!service) return null;
    const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
    if (!buildRequestAuth) return null;
    offPeakRuntime = {
      service: service as OffPeakTaskService,
      validateSelection: (selection: ModelSelection) =>
        (service as OffPeakTaskService).validateDispatchModelSelection(selection),
      buildRequestAuth,
    };
    return offPeakRuntime;
  }

  function trackRunOutcome(params: {
    zcodeTaskService: IZCodeTaskService;
    offPeakTaskId: string;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
  }): void {
    const key = subscriptionKey(params.taskId, params.traceId);
    runSubscriptions.get(key)?.dispose();
    const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (result.inputId !== params.traceId) return;
        runSubscriptions.get(key)?.dispose();
        runSubscriptions.delete(key);
        void finalizeRun({
          zcodeTaskService: params.zcodeTaskService,
          offPeakTaskId: params.offPeakTaskId,
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          outcome: result.outcome as ZCodeAutomationRunOutcome,
          ...(result.error ? { error: result.error } : {}),
        }).catch((error) => logger.warn("off-peak 终态回写失败", error as Error));
      },
    );
    runSubscriptions.set(key, disposable);
  }

  async function finalizeRun(params: {
    zcodeTaskService: IZCodeTaskService;
    offPeakTaskId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
  }): Promise<void> {
    const status =
      params.outcome === "succeeded"
        ? ("completed" as const)
        : params.outcome === "stopped"
          ? ("cancelled" as const)
          : ("failed" as const);
    let filesChanged: number | undefined;
    try {
      const snapshot = await params.zcodeTaskService.getTaskSnapshot({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      const fileChanges = snapshot?.fileChanges;
      if (fileChanges) {
        filesChanged = buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
      }
    } catch (error) {
      logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）", error as Error);
    }
    const updated = await offPeakRepo.markTerminal(params.offPeakTaskId, {
      status,
      endedAt: Date.now(),
      ...(params.error ? { failureReason: params.error } : {}),
      ...(filesChanged !== undefined ? { filesChanged } : {}),
    });
    if (!updated) return;
    void params.zcodeTaskService
      .setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      })
      .catch(() => {});
  }

  async function dispatch(request: OffPeakDispatchRequest): Promise<OffPeakDispatchResultMessage> {
    const zcodeTaskService = services.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      throw new Error("ZCode task service is not initialized.");
    }
    const runtime = await ensureRuntime();
    if (!runtime) {
      throw new Error("off-peak runtime is not available");
    }
    if (!request.serverTicketId) {
      throw new Error("off-peak dispatch without server ticket");
    }
    const idleSelection = request.modelSelection;
    if (!(await runtime.validateSelection(idleSelection))) {
      throw new OffPeakModelUnavailableError("idlePlan");
    }
    const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
    const dispatchKind = resolveOffPeakDispatchKind(request);
    const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
    let trackedKey: string | null = null;
    try {
      let taskId: string;
      let traceId: TraceId;
      let promptContent = request.prompt;
      if (dispatchKind === "bound-first-run") {
        taskId = request.sessionId!;
        traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
        const workspaceScope = {
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
        };
        const [deletedIds, tasks] = await Promise.all([
          zcodeTaskService.listDeletedTaskIds(workspaceScope),
          zcodeTaskService.listTasks(workspaceScope),
        ]);
        assertBoundSessionDispatchable({
          sessionId: taskId,
          deleted: deletedIds.includes(taskId),
          running: tasks.find((task) => task.taskId === taskId)?.status === "running",
        });
        await zcodeTaskService.resumeTask({
          ...workspaceScope,
          taskId,
          offPeakTaskId: request.offPeakTaskId,
        });
        await zcodeTaskService.setConfigOption({
          taskId,
          traceId,
          configId: "mode",
          value: request.permissionMode,
        });
      } else if (dispatchKind === "resume") {
        taskId = request.conversationId!;
        traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
        promptContent = OFF_PEAK_RESUME_PROMPT;
        await zcodeTaskService.resumeTask({
          taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          offPeakTaskId: request.offPeakTaskId,
        });
        await zcodeTaskService.setConfigOption({
          taskId,
          traceId,
          configId: "mode",
          value: request.permissionMode,
        });
      } else {
        const task = await zcodeTaskService.createTask({
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          mode: request.permissionMode as ZCodeTaskMode,
          deferPersistenceUntilFirstPrompt: true,
          offPeakTaskId: request.offPeakTaskId,
        });
        taskId = task.taskId;
        traceId = task.traceId;
      }
      trackedKey = subscriptionKey(taskId, traceId);
      trackRunOutcome({
        zcodeTaskService,
        offPeakTaskId: request.offPeakTaskId,
        taskId,
        traceId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
      });
      await zcodeTaskService.sendPrompt({
        taskId,
        traceId,
        content: promptContent,
        clientMode: SERVER_CLIENT_MODE,
        toolDenylist: ["CronCreate", "OffPeakCreate"],
        modelSelection: idleSelection,
        modelExecution: {
          memoryExtraction: "skip",
          selectionScope: "execution",
          requestAuth,
          subagents: { foregroundModel: "submission", background: "deny" },
        },
        offPeakTaskId: request.offPeakTaskId,
        offPeakRunType,
      });
      return {
        offPeakTaskId: request.offPeakTaskId,
        ok: true,
        conversationId: taskId,
        sessionId: taskId,
      };
    } catch (error) {
      if (trackedKey) {
        runSubscriptions.get(trackedKey)?.dispose();
        runSubscriptions.delete(trackedKey);
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        offPeakTaskId: request.offPeakTaskId,
        ok: false,
        error: message,
        failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
      };
    }
  }

  return {
    dispatch,
    dispose() {
      for (const disposable of runSubscriptions.values()) disposable.dispose();
      runSubscriptions.clear();
    },
  };
}
