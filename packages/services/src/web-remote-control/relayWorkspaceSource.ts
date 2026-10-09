import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  buildRelayBootstrapResult,
  buildRelayWorkspaceListResult,
  resolveRelayWorkspaceKey,
  type RelayBootstrapResult,
  type RelayTaskView,
  type RelayWorkspaceListResult,
  type RelayWorkspaceView,
} from "./relayControlProtocol.js";

/**
 * 手机端工作区/任务数据源：从本地 services 投影 bootstrap 与 workspace-list 结果。
 *
 * 数据读取失败一律降级为空/当前工作区，绝不上抛——relay 是可选功能，
 * 不能因为读不到设置或任务而影响 server 主进程与远控连接本身。
 */

export interface RelayWorkspaceSource {
  buildListResult(): Promise<RelayWorkspaceListResult>;
  buildBootstrapResult(): Promise<RelayBootstrapResult>;
  /** 按 workspaceKey（identity 优先规则）解析工作区；手机端开桥时用。 */
  resolveWorkspaceByKey(key: string): Promise<RelayWorkspaceView | null>;
}

/** 手机端可见工作区与任务的上游读取端口（由服务装配层实现）。 */
export interface RelayWorkspaceSourcePort {
  listWorkspaces(): Promise<RelayWorkspaceView[]>;
  listTasks(workspaces: RelayWorkspaceView[]): Promise<RelayTaskView[]>;
}

export function createRelayWorkspaceSource(options: {
  primaryWorkspace: RelayWorkspaceView;
  port?: RelayWorkspaceSourcePort;
  windowControlSessionId: string;
  logger: ServiceLogger;
}): RelayWorkspaceSource {
  async function resolveWorkspaceViews(): Promise<RelayWorkspaceView[]> {
    if (!options.port?.listWorkspaces) return [options.primaryWorkspace];
    try {
      const views = await options.port.listWorkspaces();
      if (views.length > 0) return views;
    } catch (error) {
      options.logger.warn(undefined, "[relay] 读取工作区列表失败，回退为当前工作区", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return [options.primaryWorkspace];
  }

  async function listTaskViews(workspaces: RelayWorkspaceView[]): Promise<RelayTaskView[]> {
    if (!options.port) return [];
    try {
      return await options.port.listTasks(workspaces);
    } catch (error) {
      options.logger.warn(undefined, "[relay] 读取任务列表失败，回退为空列表", {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  return {
    async buildListResult() {
      const workspaces = await resolveWorkspaceViews();
      const tasks = await listTaskViews(workspaces);
      return buildRelayWorkspaceListResult({
        workspaces,
        primaryWorkspace: options.primaryWorkspace,
        tasks,
        latestTaskId: tasks[0]?.taskId,
      });
    },
    async buildBootstrapResult() {
      const workspaces = await resolveWorkspaceViews();
      const tasks = await listTaskViews(workspaces);
      return buildRelayBootstrapResult({
        windowControlSessionId: options.windowControlSessionId,
        workspaces,
        primaryWorkspace: options.primaryWorkspace,
        tasks,
        latestTaskId: tasks[0]?.taskId,
      });
    },
    async resolveWorkspaceByKey(key) {
      const views = await resolveWorkspaceViews();
      return views.find((view) => resolveRelayWorkspaceKey(view) === key) ?? null;
    },
  };
}
