import { describe, expect, it } from "vitest";
import { ServiceCollection } from "../collection.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { createRelayBridgeChannel } from "./relayBridgeChannel.js";
import { createRelayWorkspaceSource } from "./relayWorkspaceSource.js";

/**
 * 回归：桥的挂载/释放路径必须永不抛错。
 * 事故背景：日志包装层（LoggingChannelServer）没有 dispose 方法，桥释放时抛出
 * 未捕获 TypeError，直接终止 server 主进程（WebUI 无响应、刷新后会话被停掉）。
 */

const logger = createServiceLogger("web-remote-control-test", { isDebugEnabled: false });

function createBridge(services: ServiceCollection) {
  const sent: unknown[] = [];
  const bridge = createRelayBridgeChannel({
    services,
    sendFrame: (payload) => {
      sent.push(payload);
      return true;
    },
    workspace: {
      workspacePath: "/workspace/project",
      label: "helloworld",
      kind: "local",
      connectionState: "connected",
    },
    source: createRelayWorkspaceSource({
      primaryWorkspace: {
        workspacePath: "/workspace/project",
        label: "helloworld",
        kind: "local",
        connectionState: "connected",
      },
      port: {
        listWorkspaces: async () => [
          {
            workspacePath: "/workspace/project",
            label: "helloworld",
            kind: "local" as const,
            connectionState: "connected",
          },
          {
            workspacePath: "/workspace/project/zcode",
            label: "zcode",
            kind: "local" as const,
            connectionState: "connected",
          },
        ],
        listTasks: async () => [],
      },
      windowControlSessionId: "d_sid",
      logger,
    }),
    logger,
  });
  return { bridge, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function bridgeOpen(overrides: Record<string, unknown> = {}) {
  return {
    zcode_type: "workspace-bridge-open",
    requestId: "req-1",
    bridgeSessionId: "bridge-1",
    bridgeGeneration: 1,
    workspaceKey: "/workspace/project",
    ...overrides,
  };
}

describe("relayBridgeChannel 生命周期健壮性", () => {
  it("挂载后释放不抛错（事故回归点）", async () => {
    const services = new ServiceCollection();
    const { bridge } = createBridge(services);
    bridge.routePayload(bridgeOpen());
    await flush();
    expect(() => bridge.dispose()).not.toThrow();
  });

  it("重复释放幂等且不抛错", () => {
    const services = new ServiceCollection();
    const { bridge } = createBridge(services);
    bridge.routePayload(bridgeOpen());
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
  });

  it("换桥（二次 bridge-open）释放旧桥不抛错", async () => {
    const services = new ServiceCollection();
    const { bridge } = createBridge(services);
    bridge.routePayload(bridgeOpen());
    await flush();
    expect(() =>
      bridge.routePayload(bridgeOpen({ bridgeSessionId: "bridge-2", requestId: "req-2" })),
    ).not.toThrow();
    bridge.dispose();
  });

  it("畸形 payload 不抛错", () => {
    const services = new ServiceCollection();
    const { bridge } = createBridge(services);
    for (const payload of [null, undefined, 42, "text", [], { zcode_type: "unknown-x" }]) {
      expect(() => bridge.routePayload(payload)).not.toThrow();
    }
  });

  it("bridge-open 指向未知工作区时回错误而不是抛错", async () => {
    const services = new ServiceCollection();
    const { bridge, sent } = createBridge(services);
    bridge.routePayload(bridgeOpen({ workspaceKey: "/other/path" }));
    await flush();
    expect(
      sent.some((m) => (m as { zcode_type?: string }).zcode_type === "workspace-bridge-error"),
    ).toBe(true);
    bridge.dispose();
  });
});

describe("relayBridgeChannel 多工作区开桥", () => {
  it("非主工作区的 bridge-open 应被接受并回显该工作区", async () => {
    const services = new ServiceCollection();
    const { bridge, sent } = createBridge(services);
    bridge.routePayload(
      bridgeOpen({
        bridgeSessionId: "bs-z",
        requestId: "req-z",
        workspaceKey: "/workspace/project/zcode",
      }),
    );
    await flush();
    const ready = sent.find(
      (m) => (m as { zcode_type?: string }).zcode_type === "workspace-bridge-ready",
    ) as { bridge?: { workspaceKey?: string; workspacePath?: string } } | undefined;
    expect(ready?.bridge?.workspaceKey).toBe("/workspace/project/zcode");
    expect(ready?.bridge?.workspacePath).toBe("/workspace/project/zcode");
    expect(
      sent.some((m) => (m as { zcode_type?: string }).zcode_type === "workspace-bridge-error"),
    ).toBe(false);
    bridge.dispose();
  });

  it("列表外的 workspaceKey 仍被拒绝", async () => {
    const services = new ServiceCollection();
    const { bridge, sent } = createBridge(services);
    bridge.routePayload(
      bridgeOpen({ bridgeSessionId: "bs-x", requestId: "req-x", workspaceKey: "/not/listed" }),
    );
    await flush();
    expect(
      sent.some((m) => (m as { zcode_type?: string }).zcode_type === "workspace-bridge-error"),
    ).toBe(true);
    bridge.dispose();
  });
});
