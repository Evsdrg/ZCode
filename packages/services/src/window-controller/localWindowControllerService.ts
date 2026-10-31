import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import type { WindowHostTaskAddress } from "@zcode/shared/zcode-protocol-v4";
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
  type WindowHostTaskUnreadSignal,
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
  const unreadSignalEmitter = new Emitter<WindowHostTaskUnreadSignal>();
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
      // 上游 3.17 起 workspaceScopes 可以是 "host"（存储 owner 决定全部范围）。
      // 自部署的 taskService 就是存储 owner，直接透传即可；只有显式 scope 列表才需
      // 建立 workspace 事件订阅（"host" 没有可订阅的具体 workspace）。
      if (params.workspaceScopes !== "host") {
        for (const scope of params.workspaceScopes) ensureScopeEventSubscription(scope);
      }
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
    // 3.16.2 起侧栏的置顶/归档/删除/未读/重命名经窗口 Controller 下发（3.15.x 直连任务服务，
    // 本实现当时显式拒绝写面）。自部署即本机 Host，直接转交同一任务服务，保持与桌面同语义。
    async mutateTask({ address, mutation }) {
      const target = {
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
      };
      switch (mutation.kind) {
        case "rename":
          return taskService.renameTask({ ...target, title: mutation.title });
        case "pin":
          return taskService.setTaskPinned({ ...target, pinned: mutation.pinned });
        case "archive":
          // 归档后任务仍在索引中（列表按 kind=archived 查询），返回新 meta 供 UI 即时刷新。
          return mutation.archived
            ? taskService.archiveTask(target)
            : taskService.unarchiveTask(target);
        case "delete":
          await taskService.deleteTask(target);
          return null;
        case "delete-archived":
          await taskService.deleteArchivedTask(target);
          return null;
        case "mark-read":
          return taskService.setTaskUnread({
            ...target,
            unread: false,
            ...(mutation.expectedUnreadAt !== undefined
              ? { expectedUnreadAt: mutation.expectedUnreadAt }
              : {}),
          });
        case "mark-unread":
          return taskService.setTaskUnread({ ...target, unread: true });
        case "open":
        case "resume":
          // 导航类意图由 UI 本地处理（切 tab/开任务），服务端无对应状态写入。
          return null;
        default:
          throw new Error(
            `window controller mutation is not supported on the self-hosted server: ${String(mutation)}`,
          );
      }
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
    // 轻量 meta 直通 task service：自部署没有实时 overlay，读到的就是索引事实。
    async getTaskMeta(params: { address: WindowHostTaskAddress }) {
      return taskService.getTaskMeta({
        taskId: params.address.taskId,
        workspacePath: params.address.workspacePath,
        ...(params.address.workspaceIdentity
          ? { workspaceIdentity: params.address.workspaceIdentity }
          : {}),
      });
    },
    onDynamicControllerFrame(): Event<WindowHostControllerFrame> {
      return frameEmitter.event;
    },
    // 未读信号依赖桌面 runtime 的实时事件流；自部署列表层未接入，发空事件流，
    // 未读计数由 UI 侧按列表刷新推导，不订阅该信号。
    onDynamicTaskUnreadSignal(): Event<WindowHostTaskUnreadSignal> {
      return unreadSignalEmitter.event;
    },
  };
}
