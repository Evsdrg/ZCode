import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requestLinuxCuaAccess } from "../src/cua-permission-broker/linuxCuaPermissionStatus.js";

/**
 * 回归：Linux 主动授权失败必须能区分「环境不具备条件」与「用户拒绝」。
 *
 * 历史缺陷：`requestLinuxCuaAccess` 只返回 boolean，把 helper 的 `ok:false` 与「用户点了拒绝」
 * 压成同一个 `false`；`node.ts` 再统一翻译成 "Portal authorization was not granted."。
 * 当机器没有活动图形会话（portal 的 RemoteDesktop 前端根本没导出）时，这句提示把环境故障
 * 误报成用户操作问题，用户无从判断该去登录桌面还是重试授权。
 *
 * 这里用真实 unix socket 模拟 helper，覆盖四种失败形态与成功形态。
 */

type Handler = (method: string) => string | null;

interface FakeHelper {
  socketPath: string;
  server: Server;
  close: () => Promise<void>;
}

/** 起一个最小 NDJSON helper：authenticate 回 ok，业务方法按 handler 返回。 */
async function startFakeHelper(dir: string, handler: Handler): Promise<FakeHelper> {
  const socketPath = join(dir, "helper.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as { id?: number; method?: string };
        if (request.method === "authenticate") {
          socket.write(`${JSON.stringify({ id: request.id, ok: true })}\n`);
          continue;
        }
        const payload = handler(request.method ?? "");
        if (payload !== null) socket.write(`${payload}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** helper 的失败帧形状，与 Rust 侧 `fail()` 一致。 */
function failureFrame(message: string): string {
  return JSON.stringify({
    id: 1,
    ok: false,
    error: {
      message,
      code: "action_unavailable",
      details: { action_sent: false, reason: "not_sent" },
    },
  });
}

describe("requestLinuxCuaAccess 失败原因透传", () => {
  let dir: string;
  let helper: FakeHelper | null;
  let originalRuntimeDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cua-perm-test-"));
    helper = null;
    originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
  });

  afterEach(async () => {
    if (helper) await helper.close();
    await rm(dir, { recursive: true, force: true });
    if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  });

  /**
   * 把 XDG_RUNTIME_DIR 指向一个含 wayland socket 的临时目录，模拟「有活动图形会话」。
   * portal 前端缺失的归类会二次确认会话是否存在，不控好这个变量测试结果取决于 CI 环境。
   */
  async function withGraphicalSession(): Promise<void> {
    const runtimeDir = join(dir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "wayland-0"), "");
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  }

  /** 模拟「停在登录界面」：运行时目录里没有任何 wayland socket。 */
  async function withoutGraphicalSession(): Promise<void> {
    const runtimeDir = join(dir, "runtime-empty");
    await mkdir(runtimeDir, { recursive: true });
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  }

  it("成功授权返回 granted: true 且不带失败码", async () => {
    helper = await startFakeHelper(dir, () =>
      JSON.stringify({ id: 1, ok: true, result: { granted: true } }),
    );
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result).toEqual({ granted: true });
  });

  it("有图形会话时，portal 前端缺失归类为 portal_frontend_unavailable", async () => {
    await withGraphicalSession();
    const raw =
      "request_access: RemoteDesktop::new: A portal frontend implementing `org.freedesktop.portal.RemoteDesktop` was not found";
    helper = await startFakeHelper(dir, () => failureFrame(raw));
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result.granted).toBe(false);
    expect(result.failureCode).toBe("portal_frontend_unavailable");
    // 原文必须逐字保留，排障时用户能直接把它贴出来。
    expect(result.errorMessage).toBe(raw);
  });

  it("没有图形会话时，即使错误文本是 portal 前端缺失也归类为 graphical_session_unavailable", async () => {
    // 这正是本机当前的真实形态：停在登录界面 → portal-kde 起不来 → 前端缺失。
    await withoutGraphicalSession();
    const raw =
      "request_access: RemoteDesktop::new: A portal frontend implementing `org.freedesktop.portal.RemoteDesktop` was not found";
    helper = await startFakeHelper(dir, () => failureFrame(raw));
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result.failureCode).toBe("graphical_session_unavailable");
    expect(result.errorMessage).toBe(raw);
  });

  it("没有图形会话归类为 graphical_session_unavailable", async () => {
    const raw = "request_access: start: could not connect to display";
    helper = await startFakeHelper(dir, () => failureFrame(raw));
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result.failureCode).toBe("graphical_session_unavailable");
    expect(result.errorMessage).toBe(raw);
  });

  it("用户拒绝归类为 authorization_denied", async () => {
    helper = await startFakeHelper(dir, () =>
      failureFrame("request_access: start response: Response(1) cancelled by user"),
    );
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result.failureCode).toBe("authorization_denied");
  });

  it("helper 不可达（socket 不存在）归类为 helper_unreachable", async () => {
    const result = await requestLinuxCuaAccess(join(dir, "missing.sock"), 1000);
    expect(result.granted).toBe(false);
    expect(result.failureCode).toBe("helper_unreachable");
  });

  it("helper 不回复归类为 authorization_timeout 而非 helper_unreachable", async () => {
    // handler 返回 null：只完成 authenticate，业务帧永不回。
    helper = await startFakeHelper(dir, () => null);
    const result = await requestLinuxCuaAccess(helper.socketPath, 300);
    expect(result.granted).toBe(false);
    expect(result.failureCode).toBe("authorization_timeout");
  });

  it("未登记的错误文本归为 unknown，但不丢原文", async () => {
    const raw = "request_access: something nobody has seen before";
    helper = await startFakeHelper(dir, () => failureFrame(raw));
    const result = await requestLinuxCuaAccess(helper.socketPath, 3000);
    expect(result.failureCode).toBe("unknown");
    expect(result.errorMessage).toBe(raw);
  });
});
