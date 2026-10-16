import { describe, expect, it } from "vitest";
import {
  mapRelayStateToStatusKind,
  projectRelayStatusToWebRemoteControlStatus,
} from "./relayStatusProjection.js";
import type { WebRemoteControlRelayState } from "./webRemoteControlRelay.js";

function project(
  state: WebRemoteControlRelayState,
  overrides: Partial<Parameters<typeof projectRelayStatusToWebRemoteControlStatus>[0]> = {},
) {
  return projectRelayStatusToWebRemoteControlStatus({
    relayStatus: { enabled: state !== "disabled", state },
    pairing: {
      qrUrl: "https://zcode.z.ai/remote/v4?sid=s&hash=h",
      deviceName: "host",
      deviceSid: "s",
    },
    workspacePath: "/w",
    windowControlSessionId: "s",
    ...overrides,
  });
}

describe("relayStatusProjection 状态映射", () => {
  it("relay 枚举逐项映射到官方 status kind", () => {
    expect(mapRelayStateToStatusKind("disabled")).toBe("idle");
    expect(mapRelayStateToStatusKind("connecting")).toBe("starting");
    expect(mapRelayStateToStatusKind("waiting")).toBe("running");
    expect(mapRelayStateToStatusKind("paired")).toBe("active");
    expect(mapRelayStateToStatusKind("error")).toBe("error");
  });

  it("mobileConnected 只在 paired 为真", () => {
    expect(project("paired").mobileConnected).toBe(true);
    for (const state of ["disabled", "connecting", "waiting", "error"] as const) {
      expect(project(state).mobileConnected).toBeUndefined();
    }
  });

  it("回填工作区身份与 sessionId，保证对话框能判定“同一目标”", () => {
    const status = project("waiting", {
      workspacePath: "/proj",
      workspaceIdentity: "ssh://host/proj",
      remoteSessionId: "remote-1",
      initialTaskId: "task-1",
    });
    expect(status.workspacePath).toBe("/proj");
    expect(status.workspaceIdentity).toBe("ssh://host/proj");
    expect(status.remoteSessionId).toBe("remote-1");
    expect(status.initialTaskId).toBe("task-1");
    expect(status.sessionId).toBe("s");
    expect(status.windowControlSessionId).toBe("s");
  });

  it("配对信息同时作为 qrUrl 与 connectUrl（与官方一致）", () => {
    const status = project("waiting");
    expect(status.qrUrl).toBe("https://zcode.z.ai/remote/v4?sid=s&hash=h");
    expect(status.connectUrl).toBe(status.qrUrl);
  });

  it("无配对信息时不产出 qrUrl/connectUrl", () => {
    const status = project("connecting", { pairing: null });
    expect(status.qrUrl).toBeUndefined();
    expect(status.connectUrl).toBeUndefined();
  });

  it("error 态带上 errorMessage 作为 error", () => {
    const status = projectRelayStatusToWebRemoteControlStatus({
      relayStatus: { enabled: true, state: "error", errorMessage: "AUTH_FAILED" },
      pairing: null,
      workspacePath: "/w",
    });
    expect(status.status).toBe("error");
    expect(status.error).toBe("AUTH_FAILED");
  });

  it("未开启时 status 为 idle 且不产出 sessionId", () => {
    const status = project("disabled", { pairing: null, windowControlSessionId: undefined });
    expect(status.status).toBe("idle");
    expect(status.sessionId).toBeUndefined();
    expect(status.windowControlSessionId).toBeUndefined();
  });
});
