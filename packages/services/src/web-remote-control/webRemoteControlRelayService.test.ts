import { describe, expect, it } from "vitest";
import { ServiceCollection } from "../collection.js";
import type { ICredentialService } from "../credential/credential.js";
import type { WebRemoteControlRelaySocketLike } from "./relayDeviceTransportV2.js";
import { createWebRemoteControlRelayService } from "./webRemoteControlRelayService.js";

/**
 * 服务状态机测试：用 fake relay WebSocket 驱动官方协议消息序列，
 * 验证状态投影、凭据持久化、配对/断开幂等与 AUTH_FAILED 自愈。
 */

function createMemoryCredentialService(): ICredentialService & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async load(key) {
      return store.get(key) ?? null;
    },
    async save(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

class FakeRelaySocket implements WebRemoteControlRelaySocketLike {
  readyState = 0;
  OPEN = 1;
  sent: string[] = [];
  listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === "open") this.readyState = this.OPEN;
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
    if (event === "close") this.readyState = 0;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", 1000, "test");
  }

  sentJson(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  lastSentOfType(type: string): Record<string, unknown> | undefined {
    return this.sentJson()
      .reverse()
      .find((m) => (m as { type?: string }).type === type) as Record<string, unknown> | undefined;
  }
}

type Flush = () => Promise<void>;

function createHarness() {
  const credentialService = createMemoryCredentialService();
  const sockets: FakeRelaySocket[] = [];
  const services = new ServiceCollection();
  const flush: Flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const service = createWebRemoteControlRelayService({
    credentialService,
    resolveServices: () => services,
    relayWsUrl: "wss://relay.test/ws",
    deviceName: "test-host",
    appVersion: "0.0.0-test",
    webSocketCtor: (url, options) => {
      expect(url.startsWith("wss://relay.test/ws?mid=")).toBe(true);
      expect(options.headers["X-Device-ID"]).toBeTruthy();
      const socket = new FakeRelaySocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { credentialService, sockets, service, flush };
}

/** 驱动 fake socket 走完 register → challenge → auth → waiting。 */
function driveToWaiting(socket: FakeRelaySocket): void {
  socket.emit("open");
  const registerInit = socket.lastSentOfType("device_register_init");
  expect(registerInit).toBeTruthy();
  socket.emit("message", JSON.stringify({ type: "device_register_ack", device_sid: "d_sid_1" }));
  const authInit = socket.lastSentOfType("auth_init");
  expect(authInit?.["device_sid"]).toBe("d_sid_1");
  socket.emit("message", JSON.stringify({ type: "auth_challenge", nonce: "n-1" }));
  const authResponse = socket.lastSentOfType("auth_response");
  expect(authResponse?.["proof"]).toBeTruthy();
  socket.emit("message", JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
}

describe("webRemoteControlRelayService 状态机", () => {
  it("开启后走完注册/鉴权并进入 waiting；凭据与开关持久化", async () => {
    const h = createHarness();
    const status = await h.service.setEnabled(true);
    expect(status).toMatchObject({ enabled: true, state: "connecting" });
    const socket = h.sockets[0]!;
    driveToWaiting(socket);
    expect(await h.service.getStatus()).toMatchObject({ enabled: true, state: "waiting" });
    const pairing = await h.service.getPairingInfo();
    expect(pairing).not.toBeNull();
    expect(pairing!.qrUrl.startsWith("https://zcode.z.ai/remote/v4?")).toBe(true);
    expect(pairing!.qrUrl).toContain("sid=d_sid_1");
    // 持久化包含 enabled 与注册后的 deviceSid
    const persisted = JSON.parse(
      h.credentialService.store.get("web-remote-control:relay-device-state")!,
    );
    expect(persisted.enabled).toBe(true);
    expect(persisted.credential.deviceSid).toBe("d_sid_1");
  });

  it("matched 进入 paired；waiting 抖动先进入怀疑态而非立即降级", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    const socket = h.sockets[0]!;
    driveToWaiting(socket);
    socket.emit("message", JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
    expect(await h.service.getStatus()).toMatchObject({ state: "paired" });
    // transport 用下沉自官方的实现：已配对后首次收到 waiting 不立刻降级，而是进入
    // 「stale waiting 怀疑态」（sendPayload 暂停业务发送）并挂 15s 恢复计时，
    // 避免 relay 单次抖动被放大成手机断线。见 relayDeviceTransportV2.applyPairStatus。
    socket.emit("message", JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
    expect(await h.service.getStatus()).toMatchObject({ state: "paired" });
  });

  it("重复 setEnabled(true) 幂等：不新建连接", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    driveToWaiting(h.sockets[0]!);
    await h.service.setEnabled(true);
    expect(h.sockets.length).toBe(1);
  });

  it("关闭后状态 disabled、连接断开，再开启复用持久 deviceSid 不再注册", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    driveToWaiting(h.sockets[0]!);
    const status = await h.service.setEnabled(false);
    expect(status).toEqual({ enabled: false, state: "disabled" });
    expect(h.sockets[0]!.readyState).not.toBe(h.sockets[0]!.OPEN);
    await h.service.setEnabled(true);
    const second = h.sockets[1]!;
    second.emit("open");
    // 复用持久 sid：直接 auth_init，不再发 device_register_init
    expect(second.lastSentOfType("device_register_init")).toBeUndefined();
    expect(second.lastSentOfType("auth_init")?.["device_sid"]).toBe("d_sid_1");
  });

  it("AUTH_FAILED 且有持久 sid 时丢弃 sid 重注册一次", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    driveToWaiting(h.sockets[0]!);
    h.sockets[0]!.emit("message", JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
    // transport 用下沉自官方的实现：AUTH_FAILED 后本地清 deviceSid、切 register 模式，
    // 再经 scheduleReconnect(0) 用 setTimeout 重连（不是同步重建），因此需要多等一轮
    // 宏任务才能观察到第二个 socket。
    await h.flush();
    await h.flush();
    const second = h.sockets[1]!;
    expect(second).toBeTruthy();
    second.emit("open");
    expect(second.lastSentOfType("device_register_init")).toBeTruthy();
  });

  it("resetPairing 生成新 mid 并重新注册", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    driveToWaiting(h.sockets[0]!);
    await h.service.resetPairing();
    await h.flush();
    const second = h.sockets[1]!;
    second.emit("open");
    const registerInit = second.lastSentOfType("device_register_init");
    expect(registerInit).toBeTruthy();
    const persisted = JSON.parse(
      h.credentialService.store.get("web-remote-control:relay-device-state")!,
    );
    expect(persisted.credential.deviceSid).toBeUndefined();
  });
});
