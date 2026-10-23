import { describe, expect, it } from "vitest";
import { ServiceCollection } from "../collection.js";
import type { ICredentialService } from "../credential/credential.js";
import { ISettingService } from "../setting/setting.js";
import type { WebRemoteControlRelaySocketCtor } from "./relayDeviceTransportV2.js";
import { createWebRemoteControlRelayService } from "./webRemoteControlRelayService.js";

/**
 * 服务状态机测试（V2 协议）：register/token 走 fake HTTP，WS 用 fake socket 驱动
 * auth_init → auth_ack(pair_status)。验证状态投影、持久化、幂等与 AUTH_FAILED 自愈。
 */

function createMemoryCredentialService(seed?: Record<string, string>): ICredentialService & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(seed ?? {}));
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

/** 预置 z.ai 登录态（telemetry 只读账号入口读取的三把 key）。 */
const LOGIN_SEED = {
  "oauth:active_provider": "zai",
  "oauth:zai:user_info": JSON.stringify({ id: "user-1" }),
  zcodejwttoken: "jwt-token-1",
};

class FakeRelaySocket {
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

interface HttpCall {
  path: string;
  body: unknown;
  authorization: string;
}

function createHarness() {
  const credentialService = createMemoryCredentialService(LOGIN_SEED);
  const sockets: FakeRelaySocket[] = [];
  const httpCalls: HttpCall[] = [];
  let nextSid = "d_sid_1";
  const settings: Record<string, unknown> = {};
  const services = new ServiceCollection();
  services.register(ISettingService, {
    async get() {
      return settings as never;
    },
    async update(patch: Record<string, unknown>) {
      Object.assign(settings, patch);
    },
  } as unknown as ISettingService);
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const httpFetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    httpCalls.push({
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      authorization: String(new Headers(init?.headers).get("Authorization") ?? ""),
    });
    // 官方路由：POST /api/v1/remote/device=register、/device/delete=delete、/token=token。
    const body =
      url.pathname === "/api/v1/remote/device"
        ? {
            code: 0,
            msg: "ok",
            // 响应 schema：device 需要 created_at/meta；token 为 21 字符 Base64URL + [AQgw]。
            data: {
              device_sid: nextSid,
              device_mid: "mid",
              online: true,
              created_at: 1_760_000_000,
              meta: {},
            },
          }
        : url.pathname === "/api/v1/remote/device/delete"
          ? { code: 0, msg: "ok", data: null }
          : url.pathname === "/api/v1/remote/token"
            ? { code: 0, msg: "ok", data: { token: `${"A".repeat(21)}g`, expires_in: 300 } }
            : { code: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const webSocketCtor: WebRemoteControlRelaySocketCtor = (url) => {
    expect(String(url).startsWith("wss://relay.test/ws?")).toBe(true);
    const socket = new FakeRelaySocket();
    sockets.push(socket);
    return socket as unknown as ReturnType<WebRemoteControlRelaySocketCtor>;
  };
  const service = createWebRemoteControlRelayService({
    credentialService,
    resolveServices: () => services,
    relayWsUrl: "wss://relay.test/ws",
    remoteUrl: "https://relay.test/remote/v4",
    deviceName: "test-host",
    appVersion: "0.0.0-test",
    webSocketCtor,
    httpFetcher,
  });
  return {
    credentialService,
    sockets,
    service,
    flush,
    httpCalls,
    settings,
    nextSidOf: () => nextSid,
  };
}

/** 驱动 fake socket 走完 register/token(HTTP) → WS auth → waiting。 */
function driveToWaiting(socket: FakeRelaySocket): void {
  socket.emit("open");
  const authInit = socket.lastSentOfType("auth_init");
  expect(authInit).toBeTruthy();
  expect(authInit?.["device_sid"]).toBe("d_sid_1");
  expect((authInit?.["meta"] as { name?: string })?.name).toBe("test-host");
  socket.emit(
    "message",
    JSON.stringify({ type: "auth_ack", device_sid: "d_sid_1", pair_status: "waiting" }),
  );
}

describe("webRemoteControlRelayService 状态机（V2）", () => {
  it("开启后经 HTTP register/token 建连并进入 waiting；开关与 mid 持久化", async () => {
    const h = createHarness();
    const status = await h.service.setEnabled(true);
    expect(status).toMatchObject({ enabled: true, state: "connecting" });
    await h.flush();
    const registerCall = h.httpCalls.find((c) => c.path === "/api/v1/remote/device");
    expect(registerCall?.authorization).toBe("Bearer jwt-token-1");
    const socket = h.sockets[0]!;
    driveToWaiting(socket);
    expect(await h.service.getStatus()).toMatchObject({ enabled: true, state: "waiting" });
    const pairing = await h.service.getPairingInfo();
    expect(pairing).not.toBeNull();
    // V2 二维码：sid/mid/name 参数，不再携带 V1 的 hash/t 凭据。
    expect(pairing!.qrUrl.startsWith("https://relay.test/remote/v4?")).toBe(true);
    expect(pairing!.qrUrl).toContain("sid=d_sid_1");
    expect(pairing!.qrUrl).not.toContain("hash=");
    const persisted = JSON.parse(
      h.credentialService.store.get("web-remote-control:relay-device-state")!,
    );
    expect(persisted.enabled).toBe(true);
    expect(typeof persisted.deviceMid).toBe("string");
    // deviceSid 落官方 AppSettings 位。
    expect(h.settings["webRemoteControlRelayV2Device"]).toMatchObject({
      deviceSid: "d_sid_1",
      userId: "user-1",
    });
  });

  it("matched 进入 paired；waiting 抖动保持 paired（官方 stale 恢复语义）", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    await h.flush();
    const socket = h.sockets[0]!;
    driveToWaiting(socket);
    socket.emit("message", JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
    expect(await h.service.getStatus()).toMatchObject({ state: "paired" });
    // 官方 V2 没有 V1 的 stale waiting 怀疑态：waiting 即时反映（手机端断开），
    // 再次 matched 立即恢复 paired。
    socket.emit("message", JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
    expect(await h.service.getStatus()).toMatchObject({ state: "waiting" });
    socket.emit("message", JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
    expect(await h.service.getStatus()).toMatchObject({ state: "paired" });
  });

  it("重复 setEnabled(true) 幂等：不新建连接", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    await h.flush();
    driveToWaiting(h.sockets[0]!);
    await h.service.setEnabled(true);
    expect(h.sockets.length).toBe(1);
  });

  it("关闭后 disabled，再开启复用持久 deviceSid 不再 register", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    await h.flush();
    driveToWaiting(h.sockets[0]!);
    const status = await h.service.setEnabled(false);
    expect(status).toEqual({ enabled: false, state: "disabled" });
    await h.service.setEnabled(true);
    await h.flush();
    expect(h.httpCalls.filter((c) => c.path === "/api/v1/remote/device")).toHaveLength(1);
    const second = h.sockets[1]!;
    expect(second).toBeTruthy();
    second.emit("open");
    expect(second.lastSentOfType("auth_init")?.["device_sid"]).toBe("d_sid_1");
  });

  it("握手期 AUTH_FAILED 时强制重注册（HTTP register 再次出现）", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    await h.flush();
    // 官方 V2：AUTH_FAILED 自愈仅在握手期（authenticating）触发重注册；
    // 已配对后的 AUTH_FAILED 走普通重连，不再换 sid。
    h.sockets[0]!.emit("open");
    h.sockets[0]!.emit("message", JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
    // transport 收 AUTH_FAILED 后经 scheduleReconnect(0) 重连；宏任务两轮后可见第二个 socket。
    await h.flush();
    await h.flush();
    const second = h.sockets[1];
    expect(second).toBeTruthy();
    expect(h.httpCalls.filter((c) => c.path === "/api/v1/remote/device")).toHaveLength(2);
  });

  it("resetPairing 删除旧 sid 并强制重注册", async () => {
    const h = createHarness();
    await h.service.setEnabled(true);
    await h.flush();
    driveToWaiting(h.sockets[0]!);
    await h.service.resetPairing();
    await h.flush();
    expect(h.httpCalls.some((c) => c.path === "/api/v1/remote/device/delete")).toBe(true);
    await h.flush();
    await h.flush();
    expect(h.sockets[1]).toBeTruthy();
  });
});
