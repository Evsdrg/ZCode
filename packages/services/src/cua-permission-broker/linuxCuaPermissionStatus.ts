// Linux CUA 权限状态查询：连 Linux Helper 的 broker socket，握手 authenticate 后
// 调 permission_status，取回系统级授权状态（xdg-desktop-portal 的屏幕录制 / 远程桌面）。
//
// 与 mac/win 的 permission_status 语义对齐：返回 accessibility / screen_recording
// 两个 CuaPermissionState。Linux 上「accessibility」对应 AT-SPI 可访问性（本实现默认可用），
// 「screen_recording」对应 portal ScreenCast 授权，由 helper 通过查询 portal 状态给出。
import { createConnection } from "node:net";

import type { CuaPermissionState } from "@zcode/zcode-cua/broker";

export interface LinuxCuaPermissionReport {
  accessibility: CuaPermissionState;
  screen_recording: CuaPermissionState;
  grant_owner?: string;
  /** 是否尚未完成首次授权（需要用户点「请求授权」走一次 portal 弹窗）。 */
  needs_grant?: boolean;
}

interface NdjsonReply {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

/** 一次握手：发送 authenticate + 一个业务方法，按 id 取回业务回复。 */
function callBrokerOnce(
  socketPath: string,
  method: string,
  timeoutMs: number,
): Promise<NdjsonReply | null> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    let buffer = "";
    const finish = (value: NdjsonReply | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(`{"id":0,"method":"authenticate","params":{"clientApiVersion":3}}\n`);
      socket.write(`{"id":1,"method":"${method}","params":{}}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          const reply = JSON.parse(line) as NdjsonReply;
          if (reply.id === 1) {
            finish(reply);
            return;
          }
        } catch {
          // 忽略无法解析的行，继续等业务回复
        }
      }
    });
    socket.on("error", () => finish(null));
  });
}

/**
 * 查询 Linux CUA 权限状态。失败返回 null（上层 fail-closed）。
 */
export async function probeLinuxCuaPermissionStatus(
  socketPath: string,
  timeoutMs = 3000,
): Promise<LinuxCuaPermissionReport | null> {
  const reply = await callBrokerOnce(socketPath, "permission_status", timeoutMs);
  if (!reply || reply.ok !== true || typeof reply.result !== "object" || reply.result === null) {
    return null;
  }
  const r = reply.result as Partial<LinuxCuaPermissionReport>;
  const asState = (v: unknown): CuaPermissionState =>
    v === "granted" || v === "stale" || v === "denied" || v === "unknown" ? v : "unknown";
  return {
    accessibility: asState(r.accessibility),
    screen_recording: asState(r.screen_recording),
    grant_owner: typeof r.grant_owner === "string" ? r.grant_owner : undefined,
    needs_grant: r.needs_grant === true,
  };
}
