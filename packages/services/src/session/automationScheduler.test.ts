import { describe, expect, it } from "vitest";
import type {
  ZCodeAutomation,
  ZCodeAutomationRun,
  ZCodeOffPeakTask,
  ModelSelection,
} from "@zcode/shared";
import type { AutomationRepo } from "./automationRepo.js";
import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import {
  AutomationScheduler,
  AUTOMATION_SCHEDULER_MISFIRE_GRACE_MS,
} from "./automationScheduler.js";

const WORKSPACE = "/workspace/project";

function modelSelection(): ModelSelection {
  return {
    providerId: "bigmodel",
    modelId: "glm-4.6",
    options: { reasoningLevel: "medium" },
  } as ModelSelection;
}

function makeAutomation(overrides: Partial<ZCodeAutomation> = {}): ZCodeAutomation {
  const now = 1_000_000;
  return {
    automationId: "auto-1",
    title: "t",
    cronExpr: "* * * * *",
    prompt: "do it",
    workspaceKey: WORKSPACE,
    workspacePath: WORKSPACE,
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    nextRunAt: now,
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ZCodeAutomation;
}

interface FakeAutomationRepoState {
  due: ZCodeAutomation[];
  manualRuns: Array<{ automation: ZCodeAutomation; run: ZCodeAutomationRun }>;
  runs: Map<string, ZCodeAutomationRun>;
  dispatched: Array<{ automationId: string; nextRunAt: number | null }>;
  dispatchFailed: Array<{ automationId: string; kind: string }>;
  manualDispatched: string[];
  skipped: Array<{ runId: string; finalize?: boolean }>;
  runDispatches: Array<{ runId: string; status: string }>;
  releasedClaims: string[];
  releasedManualClaims: string[];
}

function fakeAutomationRepo(state: FakeAutomationRepoState): AutomationRepo {
  const repo = {
    ensureReady: async () => {},
    claimDue: async () => state.due.splice(0, state.due.length),
    claimManualRuns: async () => state.manualRuns.splice(0, state.manualRuns.length),
    upsertRunClaimed: async (params: { runId: string }) => {
      state.runs.set(params.runId, {
        runId: params.runId,
        automationId: "auto-1",
        workspaceKey: WORKSPACE,
        trigger: "schedule",
        dispatchStatus: "claimed",
        attempts: 0,
        createdAt: 0,
        updatedAt: 0,
      } as ZCodeAutomationRun);
    },
    getRun: async (runId: string) => state.runs.get(runId) ?? null,
    get: async (automationId: string) => makeAutomation({ automationId, nextRunAt: 1_000_000 }),
    skipAndReschedule: async (params: { runId: string; finalize?: boolean }) => {
      state.skipped.push({
        runId: params.runId,
        ...(params.finalize ? { finalize: true } : {}),
      });
    },
    markDispatched: async (automationId: string, options: { nextRunAt: number | null }) => {
      state.dispatched.push({ automationId, nextRunAt: options.nextRunAt });
    },
    markDispatchFailed: async (automationId: string, options: { kind: string }) => {
      state.dispatchFailed.push({ automationId, kind: options.kind });
    },
    markRunDispatch: async (params: { runId: string; dispatchStatus: string }) => {
      state.runDispatches.push({
        runId: params.runId,
        status: params.dispatchStatus,
      });
    },
    markManualRunDispatched: async (params: { runId: string }) => {
      state.manualDispatched.push(params.runId);
      return true;
    },
    ensureRunClaimed: async () => {},
    markRunOutcome: async () => {},
    touchManualClaim: async () => {},
    releaseClaim: async (automationId: string) => {
      state.releasedClaims.push(automationId);
    },
    releaseManualClaim: async (automationId: string) => {
      state.releasedManualClaims.push(automationId);
    },
  };
  return repo as unknown as AutomationRepo;
}

function emptyState(): FakeAutomationRepoState {
  return {
    due: [],
    manualRuns: [],
    runs: new Map(),
    dispatched: [],
    dispatchFailed: [],
    manualDispatched: [],
    skipped: [],
    runDispatches: [],
    releasedClaims: [],
    releasedManualClaims: [],
  };
}

describe("AutomationScheduler", () => {
  it("到期 automation 先落 run 台账再派发，成功后 markDispatched", async () => {
    const state = emptyState();
    state.due.push(makeAutomation({ nextRunAt: 1_000_000 }));
    const dispatched: string[] = [];
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      dispatch: {
        dispatchAutomation(request, onResult) {
          dispatched.push(request.runId);
          onResult({
            runId: request.runId,
            ok: true,
            taskId: "task-1",
            sessionId: "task-1",
          });
        },
      },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(dispatched).toEqual(["auto-1:1000000"]);
    expect(state.runDispatches.at(-1)).toEqual({
      runId: "auto-1:1000000",
      status: "dispatched",
    });
    expect(state.dispatched.at(-1)?.automationId).toBe("auto-1");
    expect(state.dispatchFailed).toHaveLength(0);
  });

  it("派发失败按 failureKind=permanent 结算为 failed", async () => {
    const state = emptyState();
    state.due.push(makeAutomation({ nextRunAt: 1_000_000 }));
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      dispatch: {
        dispatchAutomation(request, onResult) {
          onResult({
            runId: request.runId,
            ok: false,
            error: "bad model",
            failureKind: "permanent",
          });
        },
      },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(state.runDispatches.at(-1)?.status).toBe("failed_to_dispatch");
    expect(state.dispatchFailed.at(-1)).toEqual({
      automationId: "auto-1",
      kind: "permanent",
    });
  });

  it("错过窗口的一次性任务记 skipped 并终态化，不补跑", async () => {
    const state = emptyState();
    state.due.push(
      makeAutomation({
        recurring: false,
        nextRunAt: 1_000_000 - AUTOMATION_SCHEDULER_MISFIRE_GRACE_MS - 1,
      }),
    );
    const dispatched: string[] = [];
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      dispatch: {
        dispatchAutomation(request, onResult) {
          dispatched.push(request.runId);
          onResult({ runId: request.runId, ok: true });
        },
      },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(dispatched).toHaveLength(0);
    expect(state.skipped).toHaveLength(1);
    expect(state.skipped[0]?.finalize).toBe(true);
  });

  it("dispose 释放在途 schedule 认领（未回结果时）", async () => {
    const state = emptyState();
    state.due.push(makeAutomation());
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      // 永不回调，模拟退出时仍在途。
      dispatch: { dispatchAutomation() {} },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(state.releasedClaims).toContain("auto-1");
  });

  it("manual run 派发成功后 markManualRunDispatched，不推进 nextRunAt", async () => {
    const state = emptyState();
    const automation = makeAutomation();
    const run: ZCodeAutomationRun = {
      runId: "auto-1:manual:xyz",
      automationId: "auto-1",
      workspaceKey: WORKSPACE,
      trigger: "manual",
      dispatchStatus: "claimed",
      attempts: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    state.manualRuns.push({ automation, run });
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      dispatch: {
        dispatchAutomation(request, onResult) {
          onResult({
            runId: request.runId,
            ok: true,
            taskId: "t",
            sessionId: "s",
          });
        },
      },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(state.manualDispatched).toContain("auto-1:manual:xyz");
    // manual 不写 automations 的 next_run_at。
    expect(state.dispatched).toHaveLength(0);
  });

  it("manual run 派发失败释放 single-flight claim", async () => {
    const state = emptyState();
    const automation = makeAutomation();
    const run: ZCodeAutomationRun = {
      runId: "auto-1:manual:xyz",
      automationId: "auto-1",
      workspaceKey: WORKSPACE,
      trigger: "manual",
      dispatchStatus: "claimed",
      attempts: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    state.manualRuns.push({ automation, run });
    const scheduler = new AutomationScheduler({
      automationRepo: fakeAutomationRepo(state),
      log: () => {},
      now: () => 1_000_000,
      dispatch: {
        dispatchAutomation(request, onResult) {
          onResult({ runId: request.runId, ok: false, error: "boom" });
        },
      },
    });

    await scheduler.start();
    await scheduler.wake("auto-1");
    await new Promise((r) => setTimeout(r, 10));
    await scheduler.dispose();

    expect(state.releasedManualClaims).toContain("auto-1");
    expect(state.manualDispatched).toHaveLength(0);
  });

  describe("off-peak", () => {
    function fakeOffPeakRepo(state: {
      due: ZCodeOffPeakTask[];
      markRunning: string[];
      markTerminal: string[];
      released: string[];
    }): OffPeakTaskRepo {
      return {
        ensureReady: async () => {},
        claimDue: async () => state.due.splice(0, state.due.length),
        countActive: async () => 0,
        recoverInterrupted: async () => 0,
        markRunning: async (id: string) => {
          state.markRunning.push(id);
          return {} as ZCodeOffPeakTask;
        },
        markTerminal: async (id: string) => {
          state.markTerminal.push(id);
          return {} as ZCodeOffPeakTask;
        },
        releaseClaim: async (id: string) => {
          state.released.push(id);
        },
      } as unknown as OffPeakTaskRepo;
    }

    function makeOffPeakTask(): ZCodeOffPeakTask {
      return {
        offPeakTaskId: "offpeak-1",
        prompt: "idle work",
        permissionMode: "build",
        modelSelection: modelSelection(),
        workspaceKey: WORKSPACE,
        workspacePath: WORKSPACE,
        status: "queued",
        serverTicketId: "ticket-1",
        queuedAt: 0,
        createdAt: 0,
        updatedAt: 0,
        attemptCount: 0,
      } as unknown as ZCodeOffPeakTask;
    }

    it("派发成功转 running 并回填 conversation/session", async () => {
      const ostate = {
        due: [makeOffPeakTask()],
        markRunning: [] as string[],
        markTerminal: [] as string[],
        released: [] as string[],
      };
      const scheduler = new AutomationScheduler({
        automationRepo: fakeAutomationRepo(emptyState()),
        offPeakRepo: fakeOffPeakRepo(ostate),
        log: () => {},
        now: () => 1_000_000,
        dispatch: {
          dispatchAutomation() {},
          dispatchOffPeak(request, onResult) {
            onResult({
              offPeakTaskId: request.offPeakTaskId,
              ok: true,
              conversationId: "conv-1",
              sessionId: "sess-1",
            });
          },
        },
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.dispose();

      expect(ostate.markRunning).toEqual(["offpeak-1"]);
      expect(ostate.markTerminal).toHaveLength(0);
    });

    it("transient 失败释放认领等待退避重试", async () => {
      const ostate = {
        due: [makeOffPeakTask()],
        markRunning: [] as string[],
        markTerminal: [] as string[],
        released: [] as string[],
      };
      const scheduler = new AutomationScheduler({
        automationRepo: fakeAutomationRepo(emptyState()),
        offPeakRepo: fakeOffPeakRepo(ostate),
        log: () => {},
        now: () => 1_000_000,
        dispatch: {
          dispatchAutomation() {},
          dispatchOffPeak(request, onResult) {
            onResult({
              offPeakTaskId: request.offPeakTaskId,
              ok: false,
              error: "busy",
            });
          },
        },
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.dispose();

      expect(ostate.released).toEqual(["offpeak-1"]);
      expect(ostate.markTerminal).toHaveLength(0);
    });

    it("permanent 失败直接落 failed 终态", async () => {
      const ostate = {
        due: [makeOffPeakTask()],
        markRunning: [] as string[],
        markTerminal: [] as string[],
        released: [] as string[],
      };
      const scheduler = new AutomationScheduler({
        automationRepo: fakeAutomationRepo(emptyState()),
        offPeakRepo: fakeOffPeakRepo(ostate),
        log: () => {},
        now: () => 1_000_000,
        dispatch: {
          dispatchAutomation() {},
          dispatchOffPeak(request, onResult) {
            onResult({
              offPeakTaskId: request.offPeakTaskId,
              ok: false,
              error: "no plan",
              failureKind: "permanent",
            });
          },
        },
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.dispose();

      expect(ostate.markTerminal).toEqual(["offpeak-1"]);
    });

    it("无 modelSelection 的历史行释放认领不派发", async () => {
      const task = makeOffPeakTask();
      (task as { modelSelection?: ModelSelection }).modelSelection = undefined;
      const ostate = {
        due: [task],
        markRunning: [] as string[],
        markTerminal: [] as string[],
        released: [] as string[],
      };
      const dispatched: string[] = [];
      const scheduler = new AutomationScheduler({
        automationRepo: fakeAutomationRepo(emptyState()),
        offPeakRepo: fakeOffPeakRepo(ostate),
        log: () => {},
        now: () => 1_000_000,
        dispatch: {
          dispatchAutomation() {},
          dispatchOffPeak(request, onResult) {
            dispatched.push(request.offPeakTaskId);
            onResult({ offPeakTaskId: request.offPeakTaskId, ok: true });
          },
        },
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.dispose();

      expect(dispatched).toHaveLength(0);
      expect(ostate.released).toEqual(["offpeak-1"]);
    });
  });
});
