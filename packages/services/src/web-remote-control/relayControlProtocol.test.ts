import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildRelayBootstrapResult,
  buildRelayWorkspaceListResult,
  projectRelayTaskView,
  resolveRelayWorkspaceKey,
} from "./relayControlProtocol.js";

const workspace = {
  workspacePath: "/workspace/project",
  label: "helloworld",
  kind: "local" as const,
  connectionState: "connected",
};

function meta(partial: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "t-1",
    traceId: "trace-1",
    title: "任务标题",
    workspacePath: "/workspace/project",
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    ...partial,
  } as ZCodeTaskMeta;
}

describe("relayControlProtocol", () => {
  it("workspaceKey 采用 identity 优先规则（对齐桌面 Ue）", () => {
    expect(resolveRelayWorkspaceKey({ workspacePath: "/a" })).toBe("/a");
    expect(resolveRelayWorkspaceKey({ workspacePath: "/a", workspaceIdentity: "id-1" })).toBe(
      "id-1",
    );
    expect(resolveRelayWorkspaceKey({ workspacePath: "/a", workspaceIdentity: "  " })).toBe("/a");
  });

  it("task 投影只携带远控协议消费的字段", () => {
    const view = projectRelayTaskView(
      meta({ unreadAt: 5, workspaceIdentity: "id-1", status: "error" }),
      { pinned: true, workspaceLabel: "helloworld" },
    );
    expect(view).toMatchObject({
      taskId: "t-1",
      title: "任务标题",
      workspacePath: "/workspace/project",
      workspaceIdentity: "id-1",
      workspaceLabel: "helloworld",
      workspaceKind: "local",
      createdAt: 1,
      updatedAt: 2,
      pinned: true,
      unreadAt: 5,
      displayStatus: "error",
    });
    expect(Object.keys(view)).not.toContain("traceId");
  });

  it("workspace-list result：多工作区投影，activeWorkspaceKey 指向主工作区", () => {
    const second = { ...workspace, workspacePath: "/workspace/project/cpap", label: "cpap" };
    const result = buildRelayWorkspaceListResult({
      workspaces: [workspace, second],
      primaryWorkspace: workspace,
      tasks: [],
    });
    expect(result.workspaces).toHaveLength(2);
    expect(result.tasks).toEqual([]);
    expect(result.activeWorkspaceKey).toBe("/workspace/project");
    expect(result.activeTaskId).toBeUndefined();
  });

  it("bootstrap result：有任务时补 activeTaskId 与 initialViewState", () => {
    const result = buildRelayBootstrapResult({
      windowControlSessionId: "d_sid",
      workspaces: [workspace],
      primaryWorkspace: workspace,
      tasks: [projectRelayTaskView(meta({ taskId: "t-9" }), { workspaceLabel: "helloworld" })],
      latestTaskId: "t-9",
    });
    expect(result.activeTaskId).toBe("t-9");
    expect(result.windowControlSessionId).toBe("d_sid");
    expect(result.initialViewState).toMatchObject({
      activeWorkspaceKey: "/workspace/project",
      activeTaskId: "t-9",
    });
  });
});
