import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";

vi.mock("@/project-sidebar/index.js", () => ({
  ProjectDirectoryProvider: ({ children }: { children: unknown }) => children,
}));

const workspaceSettingsLayerMock = vi.fn(() => null);

vi.mock("../src/App.js", () => ({
  App: () => null,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/root/WorkspaceSettingsLayer.js", () => ({
  WorkspaceSettingsLayer: (props: Record<string, unknown>) => {
    workspaceSettingsLayerMock(props);
    return createElement("div", null, "settings");
  },
}));

function makeServices(id: string): IServiceAccessor {
  return { __testId: id } as unknown as IServiceAccessor;
}

describe("RootWorkspaceContent settings layer services", () => {
  beforeEach(() => {
    workspaceSettingsLayerMock.mockClear();
  });

  it("passes workspace-scoped services into the settings overlay", async () => {
    const { RootWorkspaceContent } = await import("../src/root/RootWorkspaceContent.js");
    const workspaceScopedServices = makeServices("remote-workspace");

    renderToStaticMarkup(
      createElement(RootWorkspaceContent, {
        workspaceScopedServices,
        workspaceShellPath: "/workspace/remote",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        workspaceRemoteSessionId: "remote-session-1",
        activeWorkspacePath: "/workspace/remote",
        isSettingsTabActive: true,
        handleConnectRemote: vi.fn(),
        handleSelectRemoteProject: vi.fn(),
        handleCancelRemoteProject: vi.fn(),
        handleReconnectRemoteWorkspace: vi.fn(),
        handleCreateTask: vi.fn(),
        handleOpenWorkspace: vi.fn(),
        remoteWorkspaceSessions: [],
        allowRemoteWorkspace: true,
        handleBackFromSettings: vi.fn(),
        user: null,
        reconnectingRemoteWorkspaceKeys: [],
        remoteWorkspaceErrorByWorkspaceKey: {},

        allowOpenWorkspace: true,
      }),
    );

    expect(workspaceSettingsLayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceScopedServices }),
    );
  });
});

describe("RootWorkspaceContent host platform passthrough", () => {
  beforeEach(() => {
    workspaceSettingsLayerMock.mockClear();
  });

  // 回归：阶段 5 只把 hostPlatform 接到了 Root.tsx 的 settingsLayerProps，漏了实际主用的
  // RootWorkspaceContent → WorkspaceSettingsLayer 链路，导致自部署 WebUI 的
  // SettingsPage 永远收到 undefined hostPlatform、Linux 下「电脑控制」区整块不可见。
  it("forwards hostPlatform into the settings overlay", async () => {
    const { RootWorkspaceContent } = await import("../src/root/RootWorkspaceContent.js");

    renderToStaticMarkup(
      createElement(RootWorkspaceContent, {
        workspaceScopedServices: makeServices("local"),
        workspaceShellPath: "/workspace/local",
        activeWorkspacePath: "/workspace/local",
        isSettingsTabActive: true,
        hostPlatform: "linux",
        handleConnectRemote: vi.fn(),
        handleSelectRemoteProject: vi.fn(),
        handleCancelRemoteProject: vi.fn(),
        handleReconnectRemoteWorkspace: vi.fn(),
        handleCreateTask: vi.fn(),
        handleOpenWorkspace: vi.fn(),
        remoteWorkspaceSessions: [],
        allowRemoteWorkspace: true,
        handleBackFromSettings: vi.fn(),
        user: null,
        reconnectingRemoteWorkspaceKeys: [],
        remoteWorkspaceErrorByWorkspaceKey: {},
        allowOpenWorkspace: true,
      }),
    );

    expect(workspaceSettingsLayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostPlatform: "linux" }),
    );
  });
});
