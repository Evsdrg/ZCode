import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import type { ZCodeTaskMeta, ZCodeWorkspaceEvent } from "@zcode/shared";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  type ControllerResyncParams,
  type ControllerResyncResult,
  type ControllerSubscribeParams,
  type ControllerSubscribeResult,
  type ControllerUnsubscribeParams,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import {
  IWindowControllerService,
  type WindowHostControllerFrame,
  type WindowHostControllerTaskListItem,
} from "./windowController.js";

/**
 * 自部署 server 的窗口级 Controller 服务（本地实现）。
 *
 * 背景：窗口 Controller 过去只由桌面 Host 注册（`packages/desktop/src/host`），供
 * Renderer 的 `useGlobalTaskList` 读取时间线 / 置顶 / 归档 / 命令面板等「全局任务列表」。
 * 自部署 server 从不注册它，于是浏览器/手机经 `/ws` 连上来时该 channel 不存在——
 * `useGlobalTaskList` 的每次读取都超时降级为空列表，表现为侧栏「任务」分区与时间线视图恒空
 * （项目分区走 useWorkspaceTaskLists 的直连读 + 自有事件订阅，不受影响）。
 *
 * 本实现只覆盖列表投影：按 query 的 workspaceScopes/kind 直读本地 tasks-index，
 * 与桌面 Host Controller 一样做 total/hasMore 分页语义。桌面端靠 Controller 的
 * `controller/tasks-index` 增量帧驱动列表刷新；自部署没有 sessions-index 实时投影、
 * 产不出逐行 delta，这里改为**监听任务服务的 workspace 事件并推送空快照帧**——
 * 客户端 registry 收到快照即清空查询缓存并 bump revision，等价于「这批查询已失效，
 * 重新拉取」。没有这一步，归档/置顶后服务端已落库，但时间线列表永远停留在旧数据
 * （实测即「无法归档」的观感：RPC 成功、行不消失）。
 */
export function createLocalWindowControllerService(options: {
  taskService: IZCodeTaskService;
}): IWindowControllerService {
  const taskService = options.taskService;
  const frameEmitter = new Emitter<WindowHostControllerFrame>();
  const logEpoch = `local-${randomUUID()}`;
  const tasksIndexSubscriptionIds = new Set<string>();
  /** 已建立 workspace 事件订阅的 scope（去重键 = workspaceKey）。 */
  const scopeDisposables = new Map<string, { dispose(): void }>();

  function notifyTasksIndexChanged(): void {
    for (const subscriptionId of tasksIndexSubscriptionIds) {
      frameEmitter.fire({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId,
        logEpoch,
        // 快照帧按协议必须从 seq 0 开始；客户端对快照不做 gap 判定。
        fromSeq: 0,
        toSeq: 0,
        sentAt: Date.now(),
        payload: {
          kind: "snapshot",
          snapshot: { protocolVersion: 1 as const, logEpoch, tasks: [] },
        },
      });
    }
  }

  function ensureScopeEventSubscription(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): void {
    const key = scope.workspaceIdentity?.trim() || scope.workspacePath;
    if (scopeDisposables.has(key)) return;
    const disposable = taskService.onDynamicWorkspaceEvent(scope)((event: ZCodeWorkspaceEvent) => {
      if (event.type !== "workspace_task_list_changed") return;
      notifyTasksIndexChanged();
    });
    scopeDisposables.set(key, disposable);
  }

  function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskListItem["liveStatus"] {
    // 与桌面的 liveStatusFromMeta 同口径：无实时 overlay 时，仅终态可信，running 不重解释。
    if (meta.status === "completed") return "completed";
    if (meta.status === "error") return "error";
    return "idle";
  }

  return {
    async listTaskList(params) {
      for (const scope of params.workspaceScopes) ensureScopeEventSubscription(scope);
      const result = await taskService.listTaskList(params);
      return {
        items: result.items.map((item) => ({
          ...item,
          sourceAvailability: "online" as const,
          liveStatus: liveStatusFromMeta(item),
        })),
        total: result.total,
        hasMore: result.hasMore,
      };
    },

    // 以下写入面在自部署 UI 不被调用（侧栏 pin/archive/delete 直连 zcodeTaskService）。
    // 归档删除按契约转交 task service；其余保留显式 unsupported，避免静默吞掉未预期调用。
    async deleteArchivedTask() {
      return false;
    },
    async deleteArchivedTasks({ address, taskIds }) {
      if (taskIds.length === 0) {
        return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
      }
      return taskService.deleteArchivedTasks({
        workspacePath: address.workspacePath,
        ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        taskIds,
      });
    },
    async mutateTask() {
      throw new Error("window controller mutateTask is not implemented on the self-hosted server");
    },

    async subscribeControllerV4(
      params: ControllerSubscribeParams,
    ): Promise<ControllerSubscribeResult> {
      const subscriptionId = randomUUID();
      if (params.topic === CONTROLLER_TASKS_INDEX_TOPIC) {
        tasksIndexSubscriptionIds.add(subscriptionId);
      }
      return { ack: { subscriptionId, mode: "snapshot", logEpoch } };
    },
    async resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult> {
      return { ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch } };
    },
    async unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void> {
      tasksIndexSubscriptionIds.delete(params.subscriptionId);
    },
    onDynamicControllerFrame(): Event<WindowHostControllerFrame> {
      return frameEmitter.event;
    },
  };
}
