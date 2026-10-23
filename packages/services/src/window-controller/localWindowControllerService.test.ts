import { Emitter } from "@zcode/rpc";
import { describe, expect, it, vi } from "vitest";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeTaskListItem, ZCodeTaskListQuery } from "../session/zcodeTaskListTypes.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { createLocalWindowControllerService } from "./localWindowControllerService.js";

function taskItem(overrides: Partial<ZCodeTaskListItem>): ZCodeTaskListItem {
  return {
    taskId: "t1",
    traceId: "trace-1",
    title: "task",
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 2,
    mode: "agent",
    ...overrides,
  } as ZCodeTaskListItem;
}

interface FakeTaskServiceOptions {
  listTaskList: (params: ZCodeTaskListQuery) => Promise<{
    items: ZCodeTaskListItem[];
    total: number;
    hasMore: boolean;
  }>;
  workspaceEvents?: Emitter<ZCodeWorkspaceEvent>;
}

function fakeTaskService(options: FakeTaskServiceOptions): IZCodeTaskService {
  const workspaceEvents = options.workspaceEvents ?? new Emitter<ZCodeWorkspaceEvent>();
  return {
    listTaskList: options.listTaskList,
    onDynamicWorkspaceEvent: () => workspaceEvents.event,
  } as unknown as IZCodeTaskService;
}

describe("createLocalWindowControllerService.listTaskList", () => {
  it("透传 query.scope 并补齐 sourceAvailability/liveStatus，保留分页字段", async () => {
    const seenQueries: ZCodeTaskListQuery[] = [];
    const service = createLocalWindowControllerService({
      taskService: fakeTaskService({
        listTaskList: async (params) => {
          seenQueries.push(params);
          return {
            items: [
              taskItem({ taskId: "a", status: "running" }),
              taskItem({ taskId: "b", status: "completed" }),
              taskItem({ taskId: "c", status: "error" }),
            ],
            total: 7,
            hasMore: true,
          };
        },
      }),
    });

    const query: ZCodeTaskListQuery = {
      kind: "timeline",
      workspaceScopes: [{ workspacePath: "/ws" }],
      sortBy: "updated",
      limit: 3,
    };
    const result = await service.listTaskList(query);

    // scope 必须原样下传：这是控制器相对 all-workspaces 视图保留分页/隔离语义的关键。
    expect(seenQueries).toEqual([query]);
    expect(result.total).toBe(7);
    expect(result.hasMore).toBe(true);
    expect(result.items.map((item) => item.taskId)).toEqual(["a", "b", "c"]);
    // running 不重解释为 live；仅终态可信（与 desktop liveStatusFromMeta 同口径）。
    expect(result.items.map((item) => item.liveStatus)).toEqual(["idle", "completed", "error"]);
    expect(result.items.every((item) => item.sourceAvailability === "online")).toBe(true);
  });
});

describe("createLocalWindowControllerService 订阅/失效帧", () => {
  it("subscribe/resync 返回合法 ACK，事件面可订阅但不自动推送", async () => {
    const service = createLocalWindowControllerService({
      taskService: fakeTaskService({
        listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
      }),
    });
    const subscribe = await service.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    expect(subscribe.ack.mode).toBe("snapshot");
    expect(typeof subscribe.ack.subscriptionId).toBe("string");
    const resync = await service.resyncControllerV4({
      subscriptionId: subscribe.ack.subscriptionId,
      base: null,
    });
    expect(resync.ack.subscriptionId).toBe(subscribe.ack.subscriptionId);
    const listener = vi.fn();
    const disposable = service.onDynamicControllerFrame()(listener);
    expect(listener).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("workspace_task_list_changed 触发空快照帧（驱动客户端失效缓存重拉）", async () => {
    const workspaceEvents = new Emitter<ZCodeWorkspaceEvent>();
    const service = createLocalWindowControllerService({
      taskService: fakeTaskService({
        listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
        workspaceEvents,
      }),
    });
    const subscribe = await service.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC });
    const listener = vi.fn();
    const disposable = service.onDynamicControllerFrame()(listener);

    // 查询建立 scope 事件订阅后，归属类事件必须产生失效帧。
    await service.listTaskList({
      kind: "timeline",
      workspaceScopes: [{ workspacePath: "/ws" }],
      sortBy: "updated",
    });
    workspaceEvents.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/ws",
      reason: "task_archived",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const frame = listener.mock.calls[0]![0];
    expect(frame.subscriptionId).toBe(subscribe.ack.subscriptionId);
    expect(frame.topic).toBe(CONTROLLER_TASKS_INDEX_TOPIC);
    expect(frame.payload.kind).toBe("snapshot");
    if (frame.payload.kind === "snapshot") {
      expect(frame.payload.snapshot.tasks).toEqual([]);
      expect(frame.payload.snapshot.logEpoch).toBe(frame.logEpoch);
    }

    // 非 task-list 事件不触发帧；退订后也不再推送。
    listener.mockClear();
    workspaceEvents.fire({
      type: "workspace_config_options_update",
      workspacePath: "/ws",
      configOptions: [],
    });
    expect(listener).not.toHaveBeenCalled();
    await service.unsubscribeControllerV4({ subscriptionId: subscribe.ack.subscriptionId });
    workspaceEvents.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/ws",
      reason: "task_archived",
    });
    expect(listener).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("deleteArchivedTasks 空批次短路；未知 mutation 仍显式拒绝", async () => {
    const service = createLocalWindowControllerService({
      taskService: fakeTaskService({
        listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
      }),
    });
    await expect(
      service.deleteArchivedTasks({ address: { workspacePath: "/ws", taskId: "x" }, taskIds: [] }),
    ).resolves.toEqual({ deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] });
    // 已知 mutation 均已转交任务服务（见下个 describe）；契约外的新 mutation 保持显式失败。
    await expect(
      service.mutateTask({
        address: { workspacePath: "/ws", taskId: "x" },
        mutation: { kind: "unknown-future" } as never,
      }),
    ).rejects.toThrow(/not supported/);
  });
});

describe("createLocalWindowControllerService.mutateTask", () => {
  // 3.16.2 起侧栏归档/置顶/未读经窗口 Controller 下发；此前实现显式拒绝写面导致归档失败。
  const address = {
    taskId: "t1",
    workspacePath: "/ws",
    workspaceIdentity: "id-1",
  };

  function harness() {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const taskService = {
      listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
      onDynamicWorkspaceEvent: () => new Emitter<ZCodeWorkspaceEvent>().event,
      renameTask: async (p: Record<string, unknown>) => {
        calls.push({ method: "renameTask", params: p });
        return { taskId: "t1" };
      },
      setTaskPinned: async (p: Record<string, unknown>) => {
        calls.push({ method: "setTaskPinned", params: p });
        return { taskId: "t1" };
      },
      setTaskUnread: async (p: Record<string, unknown>) => {
        calls.push({ method: "setTaskUnread", params: p });
        return { taskId: "t1" };
      },
      archiveTask: async (p: Record<string, unknown>) => {
        calls.push({ method: "archiveTask", params: p });
        return { taskId: "t1" };
      },
      unarchiveTask: async (p: Record<string, unknown>) => {
        calls.push({ method: "unarchiveTask", params: p });
        return { taskId: "t1" };
      },
      deleteTask: async (p: Record<string, unknown>) => {
        calls.push({ method: "deleteTask", params: p });
      },
      deleteArchivedTask: async (p: Record<string, unknown>) => {
        calls.push({ method: "deleteArchivedTask", params: p });
        return true;
      },
    } as unknown as IZCodeTaskService;
    const service = createLocalWindowControllerService({ taskService });
    return { service, calls };
  }

  it("archive 归档转交任务服务并透传 workspace 身份", async () => {
    const { service, calls } = harness();
    const meta = await service.mutateTask({
      address,
      mutation: { kind: "archive", archived: true },
    });
    expect(meta).toMatchObject({ taskId: "t1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "archiveTask",
      params: { taskId: "t1", workspacePath: "/ws", workspaceIdentity: "id-1" },
    });
  });

  it("unarchive 走 unarchiveTask；delete 返回 null", async () => {
    const { service, calls } = harness();
    await service.mutateTask({ address, mutation: { kind: "archive", archived: false } });
    expect(await service.mutateTask({ address, mutation: { kind: "delete" } })).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["unarchiveTask", "deleteTask"]);
  });

  it("mark-read 透传 CAS 的 expectedUnreadAt；pin/rename 映射到对应方法", async () => {
    const { service, calls } = harness();
    await service.mutateTask({
      address,
      mutation: { kind: "mark-read", expectedUnreadAt: 123 },
    });
    await service.mutateTask({ address, mutation: { kind: "pin", pinned: true } });
    await service.mutateTask({ address, mutation: { kind: "rename", title: "新标题" } });
    expect(calls.map((c) => c.method)).toEqual(["setTaskUnread", "setTaskPinned", "renameTask"]);
    expect(calls[0]?.params).toMatchObject({ unread: false, expectedUnreadAt: 123 });
    expect(calls[2]?.params).toMatchObject({ title: "新标题" });
  });

  it("open/resume 为导航意图，服务端无写入返回 null", async () => {
    const { service, calls } = harness();
    expect(await service.mutateTask({ address, mutation: { kind: "open" } })).toBeNull();
    expect(await service.mutateTask({ address, mutation: { kind: "resume" } })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
