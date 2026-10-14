// 自部署 server 的定时任务派发端口。
//
// 桌面形态里 automation 派发在 host 进程（packages/desktop/src/host/index.ts 的 dispatchCronRun /
// dispatchManualAutomationRun），经 main 的消息转发执行。自部署 server 没有 main/host 分层，
// 直接在本进程用同一套 @zcode/services 任务域实现等价语义：
//   固定 run 级模型选择 → 订阅 bot 回推 → 订阅终态 → createTask/resumeTask → sendPrompt。
//
// 与桌面的唯一语义差异是 clientMode：server 是常驻后端，投递档位必须是 web-remote-replayable。
// 闲时任务派发见 offPeakDispatch.ts（与 automation 表/链路独立）。
import type { ServiceCollection } from "@zcode/services";
import { IBotsService, IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import {
  recordCronRunOutcomeBestEffort,
  resolveAutomationSubmissionModelSelection,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
  startManualClaimHeartbeat,
  watchCronRunBotDelivery,
  type AutomationDispatchRequest,
  type AutomationDispatchResult,
  type AutomationSchedulerDispatchPort,
  type AutomationRepo,
  type OffPeakTaskRepo,
} from "@zcode/services/node";
import {
  formatModelPickerValue,
  resolveWorkspaceKey,
  type ModelSelection,
  type TraceId,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ZCodeTaskMode,
} from "@zcode/shared";
import {
  parseRunScheduledAt,
  SERVER_CLIENT_MODE,
  subscriptionKey,
  type DispatchLogger,
} from "./automationDispatchShared.js";
import { createServerOffPeakDispatch } from "./offPeakDispatch.js";

export interface ServerAutomationDispatchRuntime {
  /** 交给 AutomationScheduler 的派发端口。 */
  port: AutomationSchedulerDispatchPort;
  /** createLocalServices 的 onAutomationManualRunRequested 实现（「立即运行」直接派发）。 */
  dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void>;
  /** 释放终态订阅。 */
  dispose(): void;
}

export interface ServerAutomationDispatchDeps {
  services: ServiceCollection;
  automationRepo: AutomationRepo;
  offPeakRepo: OffPeakTaskRepo;
  logger: DispatchLogger;
}

/**
 * 构造 server 的调度派发运行时：派发端口 + 立即运行派发器。
 * 认领/结算由 AutomationScheduler 持有；本模块只负责「请求 → 执行 → 回调结果」。
 */
export function createServerAutomationDispatchRuntime(
  deps: ServerAutomationDispatchDeps,
): ServerAutomationDispatchRuntime {
  const { services, automationRepo, logger } = deps;
  const logWarn = (message: string, error: unknown) => logger.warn(message, error);

  // run 终态订阅：与桌面 trackCronRunOutcome 等价。taskId+traceId 为键，先 dispose 旧的再挂新的。
  const cronRunSubscriptions = new Map<string, { dispose(): void }>();
  const disposeCronSubscription = (key: string): void => {
    const disposable = cronRunSubscriptions.get(key);
    if (!disposable) return;
    cronRunSubscriptions.delete(key);
    disposable.dispose();
  };

  function trackCronRunOutcome(params: {
    zcodeTaskService: IZCodeTaskService;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): void {
    const key = subscriptionKey(params.taskId, params.traceId);
    disposeCronSubscription(key);
    void recordCronRunOutcomeBestEffort({
      runId: params.runId,
      automationId: params.automationId,
      workspaceKey: params.workspaceKey,
      scheduledAt: params.scheduledAt,
      trigger: params.trigger,
      outcome: "running",
      repo: automationRepo,
      logWarn,
    });
    const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (result.inputId !== params.traceId) return;
        void settleCronRunTerminalOutcome({
          runId: params.runId,
          automationId: params.automationId,
          workspaceKey: params.workspaceKey,
          scheduledAt: params.scheduledAt,
          trigger: params.trigger,
          outcome: result.outcome as Exclude<ZCodeAutomationRunOutcome, "running">,
          ...(result.error ? { error: result.error } : {}),
          repo: automationRepo,
          logWarn,
        });
        // 后台完成统一置未读，打开 task 时由导航链路清除（与桌面同款）。
        void params.zcodeTaskService
          .setTaskUnread({
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            unread: true,
          })
          .catch(() => {});
        disposeCronSubscription(key);
      },
    );
    const claimHeartbeat =
      params.trigger === "manual"
        ? startManualClaimHeartbeat({
            automationId: params.automationId,
            runId: params.runId,
            workspaceKey: params.workspaceKey,
            repo: automationRepo,
            logWarn,
          })
        : null;
    cronRunSubscriptions.set(key, {
      dispose() {
        claimHeartbeat?.dispose();
        disposable.dispose();
      },
    });
  }

  async function applyRunConfigToExistingTask(params: {
    zcodeTaskService: IZCodeTaskService;
    taskId: string;
    traceId: TraceId;
    modelSelection?: ModelSelection;
    mode?: string;
  }): Promise<void> {
    let thoughtAppliedWithModel = false;
    let modeAppliedWithModel = false;
    if (params.modelSelection) {
      await params.zcodeTaskService.setAutomationSessionConfig({
        taskId: params.taskId,
        traceId: params.traceId,
        modelSelection: params.modelSelection,
        thoughtLevel: params.modelSelection.options?.reasoningLevel,
        mode: params.mode?.trim() as ZCodeTaskMode | undefined,
      });
      thoughtAppliedWithModel = true;
      modeAppliedWithModel = true;
    }
    if (!modeAppliedWithModel && params.mode?.trim()) {
      await params.zcodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "mode",
        value: params.mode.trim(),
      });
    }
    if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
      await params.zcodeTaskService.setConfigOption({
        taskId: params.taskId,
        traceId: params.traceId,
        configId: "thought_level",
        value: params.modelSelection.options.reasoningLevel,
      });
    }
  }

  /** automation 派发核心：成功返回 taskId/sessionId，失败抛出。 */
  async function runAutomationDispatch(request: AutomationDispatchRequest): Promise<{
    taskId: string;
    sessionId: string;
  }> {
    const zcodeTaskService = services.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      throw new Error("ZCode task service is not initialized.");
    }
    const modelSelectionService = services.getOptional(IModelSelectionService);
    if (!modelSelectionService) {
      throw new Error("Model Selection service is not initialized.");
    }
    const workspaceKey = resolveWorkspaceKey(request);
    // 长期配置是原意图；已有 run 必须直接复用固定选择，不能被账号变化重新解释。
    const existingRun = await automationRepo.getRun(request.runId);
    const resolvedSelection = await resolveAutomationSubmissionModelSelection({
      selection: request.modelSelection,
      fixedSelection: existingRun?.modelSelection,
      modelSelectionService,
      readSelection: () =>
        automationRepo.getModelSelectionForDispatch(request.automationId, workspaceKey),
    });
    const submissionModelSelection = await automationRepo.fixRunModelSelection(
      request.runId,
      resolvedSelection,
    );
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseRunScheduledAt(request.runId, request.automationId);
    let trackedKey: string | null = null;
    try {
      const task = request.targetTaskId
        ? { taskId: request.targetTaskId }
        : await zcodeTaskService.createTask({
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
            model: formatModelPickerValue(submissionModelSelection),
            mode: request.mode,
            thoughtLevel: submissionModelSelection.options?.reasoningLevel,
            automationId: request.automationId,
          });
      // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
      const promptTraceId = request.runId as TraceId;
      if (request.targetTaskId) {
        await zcodeTaskService.resumeTask({
          taskId: task.taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
        await applyRunConfigToExistingTask({
          zcodeTaskService,
          taskId: task.taskId,
          traceId: promptTraceId,
          modelSelection: submissionModelSelection,
          mode: request.mode,
        });
      }
      const botsService = services.getOptional(IBotsService);
      if (botsService) {
        try {
          await watchCronRunBotDelivery({
            automationId: request.automationId,
            workspaceKey,
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            taskId: task.taskId,
            repo: automationRepo,
            botsService,
          });
        } catch (error) {
          // Bot 回推是 best-effort 辅助通道；失败不阻断派发与结算。
          logger.warn(
            `automation Bot delivery subscription failed automation=${request.automationId}`,
            error,
          );
        }
      }
      trackedKey = subscriptionKey(task.taskId, promptTraceId);
      trackCronRunOutcome({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
      });
      await zcodeTaskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId,
        content: request.prompt,
        clientMode: SERVER_CLIENT_MODE,
        automationId: request.automationId,
      });
      return { taskId: task.taskId, sessionId: task.taskId };
    } catch (error) {
      if (trackedKey) disposeCronSubscription(trackedKey);
      throw error;
    }
  }

  async function dispatchAutomationToResult(
    request: AutomationDispatchRequest,
  ): Promise<AutomationDispatchResult> {
    const workspaceKey = resolveWorkspaceKey(request);
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseRunScheduledAt(request.runId, request.automationId);
    try {
      const result = await runAutomationDispatch(request);
      return {
        runId: request.runId,
        ok: true,
        taskId: result.taskId,
        sessionId: result.sessionId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 派发失败：与桌面一致，先落 failed 终态再做失败结算。
      void recordCronRunOutcomeBestEffort({
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
        outcome: "failed",
        error: message,
        repo: automationRepo,
        logWarn,
      });
      return {
        runId: request.runId,
        ok: false,
        error: message,
        failureKind: "transient",
      };
    }
  }

  /**
   * 「立即运行」直接派发（不绕 scheduler）：
   * runNow 已占用 single-flight claim；失败必须结算 claim 后再抛，UI 才能如实报错。
   */
  async function dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void> {
    const request: AutomationDispatchRequest = {
      type: "automation",
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      ...(params.automation.targetTaskId ? { targetTaskId: params.automation.targetTaskId } : {}),
      ...((params.run.modelSelection ?? params.automation.modelSelection)
        ? {
            modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
          }
        : {}),
      ...(params.automation.mode ? { mode: params.automation.mode } : {}),
      workspacePath: params.automation.workspacePath,
      ...(params.automation.workspaceIdentity
        ? { workspaceIdentity: params.automation.workspaceIdentity }
        : {}),
    };
    let result: { taskId: string; sessionId: string };
    try {
      result = await runAutomationDispatch(request);
    } catch (error) {
      logger.warn(
        `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}`,
        error,
      );
      await settleManualDispatchFailureBestEffort({
        repo: automationRepo,
        automationId: params.automation.automationId,
        runId: params.run.runId,
        workspaceKey: params.automation.workspaceKey,
        scheduledAt: params.run.scheduledAt ?? null,
        trigger: "manual",
        dispatchError: error,
        logWarn,
      });
      throw error;
    }
    try {
      await automationRepo.markManualRunDispatched({
        runId: params.run.runId,
        sessionId: result.sessionId,
        dispatchedAt: Date.now(),
      });
    } catch (error) {
      // prompt 已 accepted/queued；台账回写失败不能伪装成派发失败并提前释放锁。
      logger.warn(
        `回写 manual automation dispatched 状态失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
        error,
      );
    }
  }

  const offPeak = createServerOffPeakDispatch({
    services,
    offPeakRepo: deps.offPeakRepo,
    logger,
  });

  return {
    port: {
      dispatchAutomation(request, onResult) {
        void dispatchAutomationToResult(request).then(onResult);
      },
      dispatchOffPeak(request, onResult) {
        void offPeak.dispatch(request).then(onResult);
      },
    },
    dispatchManualRun,
    dispose() {
      for (const disposable of cronRunSubscriptions.values()) disposable.dispose();
      cronRunSubscriptions.clear();
      offPeak.dispose();
    },
  };
}
