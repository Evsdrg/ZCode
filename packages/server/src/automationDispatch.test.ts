import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "@zcode/services";
import { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import type { AutomationRepo } from "@zcode/services/node";
import type { OffPeakTaskRepo } from "@zcode/services/node";
import type {
  ModelSelection,
  ZCodeAutomation,
  ZCodeAutomationRun,
  ZCodeTaskClientMode,
} from "@zcode/shared";
import { createServerAutomationDispatchRuntime } from "./automationDispatch.js";

const WORKSPACE = "/workspace/project";

function modelSelection(): ModelSelection {
  return {
    providerId: "bigmodel",
    modelId: "glm-4.6",
    options: { reasoningLevel: "medium" },
  } as ModelSelection;
}

function modelSelectionView() {
  const selection = modelSelection();
  return {
    effectiveSelection: selection,
    preferredSelection: selection,
    selectionIssue: undefined,
  };
}

interface SentPrompt {
  taskId: string;
  traceId: string;
  content: string;
  clientMode?: ZCodeTaskClientMode;
  automationId?: string;
}

function makeHarness(options: { automationRepo: Partial<AutomationRepo> }) {
  const sent: SentPrompt[] = [];
  const created: Array<{ workspacePath: string; automationId?: string }> = [];
  const unread: Array<{ taskId: string; unread: boolean }> = [];
  const terminalListeners = new Map<
    string,
    (result: { inputId: string; outcome: string }) => void
  >();

  const taskService = {
    createTask: async (params: { workspacePath: string; automationId?: string }) => {
      created.push({
        workspacePath: params.workspacePath,
        ...(params.automationId ? { automationId: params.automationId } : {}),
      });
      return { taskId: "task-1", traceId: "trace-created" };
    },
    resumeTask: async () => ({}),
    sendPrompt: async (params: SentPrompt) => {
      sent.push(params);
    },
    setAutomationSessionConfig: async () => [],
    setConfigOption: async () => [],
    setTaskUnread: async (params: { taskId: string; unread: boolean }) => {
      unread.push({ taskId: params.taskId, unread: params.unread });
    },
    onDynamicTaskTerminalOutcome:
      (taskId: string) => (listener: (r: { inputId: string; outcome: string }) => void) => {
        terminalListeners.set(taskId, listener);
        return { dispose: () => terminalListeners.delete(taskId) };
      },
    listTasks: async () => [],
    listDeletedTaskIds: async () => [],
    getTaskSnapshot: async () => ({ fileChanges: undefined }),
  };

  const modelSelectionService = {
    onDidChange: () => ({ dispose: () => {} }),
    getView: async () => modelSelectionView(),
  };

  const services = new ServiceCollection()
    .register(IZCodeTaskService, taskService as never)
    .register(IModelSelectionService, modelSelectionService as never);

  const automationRepo = {
    getRun: async () => null,
    getModelSelectionForDispatch: async () => modelSelection(),
    fixRunModelSelection: async (_runId: string, selection: ModelSelection) => selection,
    ensureRunClaimed: async () => {},
    markRunOutcome: async () => {},
    markRunDispatch: async () => {},
    markManualRunDispatched: async () => true,
    touchManualClaim: async () => {},
    releaseClaim: async () => {},
    releaseManualClaim: async () => {},
    ...options.automationRepo,
  } as unknown as AutomationRepo;

  const offPeakRepo = {
    markTerminal: async () => ({}),
  } as unknown as OffPeakTaskRepo;

  const runtime = createServerAutomationDispatchRuntime({
    services,
    automationRepo,
    offPeakRepo,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return {
    runtime,
    sent,
    created,
    unread,
    terminalListeners,
    services,
    automationRepo,
  };
}

describe("createServerAutomationDispatchRuntime", () => {
  it("automation 派发用 web-remote-replayable 档位并固定 run 级选择", async () => {
    const harness = makeHarness({ automationRepo: {} });
    const results: Array<{ ok: boolean }> = [];

    harness.runtime.port.dispatchAutomation(
      {
        type: "automation",
        automationId: "auto-1",
        runId: "auto-1:1000000",
        prompt: "do it",
        workspacePath: WORKSPACE,
      },
      (result) => results.push({ ok: result.ok }),
    );

    await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
    expect(harness.sent[0]?.clientMode).toBe("web-remote-replayable");
    expect(harness.created[0]?.automationId).toBe("auto-1");
    await vi.waitFor(() => expect(results).toEqual([{ ok: true }]));
    harness.runtime.dispose();
  });

  it("「立即运行」直接派发成功并回写 manual dispatched", async () => {
    const markManual = vi.fn(async () => true);
    const harness = makeHarness({
      automationRepo: { markManualRunDispatched: markManual },
    });
    const automation = {
      automationId: "auto-1",
      prompt: "run now",
      workspaceKey: WORKSPACE,
      workspacePath: WORKSPACE,
      modelSelection: modelSelection(),
    } as ZCodeAutomation;
    const run = {
      runId: "auto-1:manual:xyz",
      automationId: "auto-1",
      workspaceKey: WORKSPACE,
      trigger: "manual",
      dispatchStatus: "claimed",
      attempts: 1,
      createdAt: 0,
      updatedAt: 0,
    } as ZCodeAutomationRun;

    await harness.runtime.dispatchManualRun({ automation, run });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.clientMode).toBe("web-remote-replayable");
    expect(markManual).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "auto-1:manual:xyz" }),
    );
    harness.runtime.dispose();
  });

  it("「立即运行」派发失败释放 single-flight claim 并抛出", async () => {
    const releaseManualClaim = vi.fn(async () => {});
    const markRunDispatch = vi.fn(async () => {});
    const harness = makeHarness({
      automationRepo: {
        getModelSelectionForDispatch: async () => {
          throw new Error("model selection unavailable");
        },
        releaseManualClaim,
        markRunDispatch,
      },
    });
    const automation = {
      automationId: "auto-1",
      prompt: "run now",
      workspaceKey: WORKSPACE,
      workspacePath: WORKSPACE,
      modelSelection: modelSelection(),
    } as ZCodeAutomation;
    const run = {
      runId: "auto-1:manual:xyz",
      automationId: "auto-1",
      workspaceKey: WORKSPACE,
      trigger: "manual",
      dispatchStatus: "claimed",
      attempts: 1,
      createdAt: 0,
      updatedAt: 0,
    } as ZCodeAutomationRun;

    await expect(harness.runtime.dispatchManualRun({ automation, run })).rejects.toThrow(
      "model selection unavailable",
    );
    expect(releaseManualClaim).toHaveBeenCalled();
    expect(markRunDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchStatus: "failed_to_dispatch" }),
    );
    // 未真正派发 prompt。
    expect(harness.sent).toHaveLength(0);
    harness.runtime.dispose();
  });
});
