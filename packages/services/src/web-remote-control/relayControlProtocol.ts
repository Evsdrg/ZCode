import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * relay 控制协议的结果构造（bootstrap / workspace-list）。
 *
 * 字段事实来源：官方桌面 `buildBootstrapResult` / `buildWorkspaceListResult`
 * 与官方手机页 `/remote/v4` 的消费逻辑（WebRemoteControlMobileTaskHome）。
 * 手机端以 `workspaceIdentity ?? workspacePath` 为 workspaceKey 做分组与选中匹配。
 */

export interface RelayWorkspaceView {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 手机端 zod schema 必填：工作区显示名（server 形态用 basename）。 */
  label: string;
  kind: "local" | "remote";
  connectionState?: string;
  remoteSessionId?: string;
  lastConnectionError?: string;
}

export interface RelayTaskView {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 手机端 zod schema 必填：所属工作区显示名与类型。 */
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  displayStatus?: "idle" | "running" | "completed" | "error";
  pinned?: boolean;
  archived?: boolean;
  unreadAt?: number;
}

export interface RelayViewState {
  activeWorkspaceKey: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface RelayWorkspaceListResult {
  workspaces: RelayWorkspaceView[];
  tasks: RelayTaskView[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export interface RelayBootstrapResult extends RelayWorkspaceListResult {
  windowControlSessionId: string;
  initialViewState?: RelayViewState;
  mobileViewState?: unknown;
}

export function resolveRelayWorkspaceKey(workspace: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

/**
 * ZCodeTaskMeta → 远控协议 task 视图。pinned 由调用方经 listPinnedTaskIds 标注
 * （meta 本身不携带）；listTasks 只返回未归档任务，archived 恒缺省。
 * workspaceLabel/workspaceKind/createdAt/updatedAt 是手机端 zod schema 必填项，
 * 缺任一则整条 bootstrap/workspace-list 消息被手机端 safeParse 拒绝并静默丢弃。
 */
export function projectRelayTaskView(
  task: ZCodeTaskMeta,
  options: { pinned?: boolean; workspaceLabel: string; workspaceKind?: "local" | "remote" },
): RelayTaskView {
  return {
    taskId: task.taskId,
    title: task.title,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    workspaceLabel: options.workspaceLabel,
    workspaceKind: options.workspaceKind ?? "local",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.status ? { displayStatus: task.status } : {}),
    ...(options.pinned ? { pinned: true } : {}),
    ...(typeof task.unreadAt === "number" ? { unreadAt: task.unreadAt } : {}),
  };
}

export function buildRelayWorkspaceListResult(options: {
  workspaces: RelayWorkspaceView[];
  /** 主工作区（activeWorkspaceKey 的缺省锚点）。 */
  primaryWorkspace: RelayWorkspaceView;
  tasks: RelayTaskView[];
  /** 最近活跃任务；无任务时缺省选中主工作区。 */
  latestTaskId?: string;
}): RelayWorkspaceListResult {
  const activeWorkspaceKey = resolveRelayWorkspaceKey(options.primaryWorkspace);
  return {
    workspaces: options.workspaces,
    tasks: options.tasks,
    activeWorkspaceKey,
    ...(options.latestTaskId ? { activeTaskId: options.latestTaskId } : {}),
  };
}

export function buildRelayBootstrapResult(options: {
  windowControlSessionId: string;
  workspaces: RelayWorkspaceView[];
  primaryWorkspace: RelayWorkspaceView;
  tasks: RelayTaskView[];
  latestTaskId?: string;
}): RelayBootstrapResult {
  const list = buildRelayWorkspaceListResult(options);
  return {
    ...list,
    windowControlSessionId: options.windowControlSessionId,
    ...(options.latestTaskId
      ? {
          initialViewState: {
            activeWorkspaceKey: list.activeWorkspaceKey!,
            activeTaskId: options.latestTaskId,
            updatedAt: Date.now(),
          },
        }
      : {}),
  };
}
