import type { ZCodeTaskMeta } from "@zcode/shared";
import type { IZCodeTaskService } from "./zcodeTaskService.js";
import type { ZCodeTaskListQuery, ZCodeTaskListResult } from "./zcodeTaskListTypes.js";

/**
 * 自部署全工作区任务视图。
 *
 * 自部署 server 是单工作区模型（ZCODE_SERVER_WORKSPACE 钉死主工作区），而本机的任务
 * 实际分布在多个 workspace_key 下（各项目目录、远程身份变体、「不在项目中工作」的
 * default 草稿工作区）。按主工作区 scope 查询会让其余任务对 WebUI 全部不可见。
 *
 * 本视图把任务列表的 scope 过滤替换为「全部有未删除任务的 workspace_path」：
 * - 各工作区结果合并并按 taskId 去重；
 * - 展示层归一 workspace_path（去尾斜杠），让 /workspace/project/ 变体任务并入同一项目分组；
 * - 除列表方法外的所有成员经 base 透传（绑定 this=base，内部 #私有字段语义不被破坏）。
 */

export type WorkspacePathsProvider = () => Promise<string[]>;

export interface AllWorkspacesTaskViewOptions {
  base: IZCodeTaskService;
  listWorkspacePaths: WorkspacePathsProvider;
}

function normalizeMeta<T extends ZCodeTaskMeta>(meta: T): T {
  const workspacePath = meta.workspacePath?.replace(/\/+$/, "") || meta.workspacePath;
  return meta.workspacePath === workspacePath ? meta : { ...meta, workspacePath };
}

function dedupeByTaskId<T extends { taskId: string; updatedAt?: number }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const existing = byId.get(item.taskId);
    if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) byId.set(item.taskId, item);
  }
  return [...byId.values()];
}

export function createAllWorkspacesTaskView(
  options: AllWorkspacesTaskViewOptions,
): IZCodeTaskService {
  const base = options.base;

  async function listWorkspacePathsInternal(): Promise<string[]> {
    const paths = await options.listWorkspacePaths();
    return paths.length > 0 ? paths : ["/"];
  }

  async function mergePerWorkspace<T extends ZCodeTaskMeta>(
    run: (workspacePath: string) => Promise<T[]>,
  ): Promise<T[]> {
    const paths = await listWorkspacePathsInternal();
    const results = await Promise.all(
      paths.map((workspacePath) => run(workspacePath).catch(() => [] as T[])),
    );
    return dedupeByTaskId(results.flat()).map((item) => normalizeMeta(item));
  }

  const view = {
    async listTasks(): Promise<ZCodeTaskMeta[]> {
      return mergePerWorkspace((workspacePath) => base.listTasks({ workspacePath }));
    },
    async listPinnedTasks(params: { workspacePath: string; workspaceIdentity?: string }) {
      return mergePerWorkspace((workspacePath) =>
        base.listPinnedTasks({ workspacePath, workspaceIdentity: params.workspaceIdentity }),
      );
    },
    async listArchivedTasks(params: { workspacePath: string; workspaceIdentity?: string }) {
      return mergePerWorkspace((workspacePath) =>
        base.listArchivedTasks({ workspacePath, workspaceIdentity: params.workspaceIdentity }),
      );
    },
    async listDeletedTaskIds(params: { workspacePath: string; workspaceIdentity?: string }) {
      const paths = await listWorkspacePathsInternal();
      const results = await Promise.all(
        paths.map((workspacePath) =>
          base
            .listDeletedTaskIds({ workspacePath, workspaceIdentity: params.workspaceIdentity })
            .catch(() => [] as string[]),
        ),
      );
      return dedupeByTaskId(results.flat().map((taskId) => ({ taskId }))).map(
        (meta) => meta.taskId,
      );
    },
    async listTaskList(query: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> {
      const paths = await listWorkspacePathsInternal();
      const result = await base.listTaskList({
        ...query,
        workspaceScopes: paths.map((workspacePath) => ({ workspacePath })),
      });
      return { ...result, items: result.items.map((item) => normalizeMeta(item)) };
    },
  };

  // 除列表方法外的所有成员绑定 base 透传（this=base，内部 #私有字段语义不被破坏）。
  return new Proxy(view as unknown as IZCodeTaskService, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) {
        // view 自身方法（闭包实现）绑定 target；闭包不依赖 this。
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
      // view 上没有的成员（如 listPinnedTaskIds）委托 base——保证不因缺成员而炸。
      const baseValue = Reflect.get(base as object, prop);
      return typeof baseValue === "function"
        ? (baseValue as (...args: unknown[]) => unknown).bind(base)
        : baseValue;
    },
  }) as IZCodeTaskService;
}
