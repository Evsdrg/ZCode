import { describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService } from "./zcodeTaskService.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createAllWorkspacesTaskView } from "./allWorkspacesTaskView.js";

const PATHS = [
  "/workspace/project",
  "/workspace/project/",
  "/home/example/.zcode/workspace/default",
];

function meta(taskId: string, workspacePath: string, updatedAt = 1): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `任务 ${taskId}`,
    workspacePath,
    createdAt: 1,
    updatedAt,
    mode: "build",
  } as ZCodeTaskMeta;
}

function createHarness(options: {
  tasksByPath: Record<string, ZCodeTaskMeta[]>;
  listWorkspacePaths?: () => Promise<string[]>;
}) {
  const calls: Array<[string, string | undefined]> = [];
  const base = {
    listTasks: async (params: { workspacePath: string }) => {
      calls.push(["listTasks", params.workspacePath]);
      return options.tasksByPath[params.workspacePath] ?? [];
    },
    listPinnedTasks: async (params: { workspacePath: string }) => {
      calls.push(["listPinnedTasks", params.workspacePath]);
      return [] as ZCodeTaskMeta[];
    },
    listArchivedTasks: async (params: { workspacePath: string }) => {
      calls.push(["listArchivedTasks", params.workspacePath]);
      return [] as ZCodeTaskMeta[];
    },
    listDeletedTaskIds: async (params: { workspacePath: string }) => {
      calls.push(["listDeletedTaskIds", params.workspacePath]);
      return [] as string[];
    },
    listTaskList: async (query: { workspaceScopes: Array<{ workspacePath: string }> }) => {
      for (const scope of query.workspaceScopes) {
        calls.push(["listTaskList", scope.workspacePath]);
      }
      return { items: [], total: 0, hasMore: false };
    },
  } as unknown as IZCodeTaskService;

  const listPinnedTaskIds = vi.fn(async () => [] as string[]);
  const view = createAllWorkspacesTaskView({
    base: { ...base, listPinnedTaskIds } as unknown as IZCodeTaskService,
    listWorkspacePaths: options.listWorkspacePaths ?? (async () => PATHS),
  });
  return { view, calls, base };
}

describe("createAllWorkspacesTaskView（自部署全工作区任务视图）", () => {
  it("listTasks 合并全部工作区任务，并归一尾斜杠路径", async () => {
    const { view } = createHarness({
      tasksByPath: {
        "/workspace/project": [meta("t-1", "/workspace/project")],
        "/workspace/project/": [meta("t-2", "/workspace/project/")],
        "/home/example/.zcode/workspace/default": [
          meta("t-3", "/home/example/.zcode/workspace/default"),
        ],
      },
    });
    const tasks = await view.listTasks({ workspacePath: "/workspace/project" });
    expect(tasks.map((t) => t.workspacePath)).toEqual([
      "/workspace/project",
      "/workspace/project",
      "/home/example/.zcode/workspace/default",
    ]);
    expect(tasks.map((t) => t.taskId)).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("同 taskId 出现在多个 key 时按 updatedAt 去重", async () => {
    const { view } = createHarness({
      tasksByPath: {
        "/workspace/project": [meta("t-dup", "/workspace/project", 1)],
        "/workspace/project/": [meta("t-dup", "/workspace/project/", 2)],
      },
    });
    const tasks = await view.listTasks({ workspacePath: "/workspace/project" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.updatedAt).toBe(2);
  });

  it("listTaskList 用全部 workspace_path 作为 scopes", async () => {
    const { view, calls } = createHarness({ tasksByPath: {} as Record<string, ZCodeTaskMeta[]> });
    await view.listTaskList({
      kind: "active",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "/only" }],
    });
    expect(calls).toEqual(PATHS.map((path) => ["listTaskList", path]));
  });

  it("非列表成员直通 base（listPinnedTaskIds 本就全局、无 scope）", async () => {
    const harness = createHarness({ tasksByPath: {} });
    const ids = await harness.view.listPinnedTaskIds();
    expect(ids).toEqual([]);
  });
});
