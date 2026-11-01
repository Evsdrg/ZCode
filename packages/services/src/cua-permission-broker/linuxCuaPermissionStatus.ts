// Linux CUA 权限状态查询：连 Linux Helper 的 broker socket，握手 authenticate 后
// 调 permission_status，取回系统级授权状态（xdg-desktop-portal 的屏幕录制 / 远程桌面）。
//
// 与 mac/win 的 permission_status 语义对齐：返回 accessibility / screen_recording
// 两个 CuaPermissionState。Linux 上「accessibility」对应 AT-SPI 可访问性（本实现默认可用），
// 「screen_recording」对应 portal ScreenCast 授权，由 helper 通过查询 portal 状态给出。
import { createConnection } from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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

/** 单次握手调用的失败原因：连接不上（helper 未运行）与等待超时（通常弹窗未处理）需要区分。 */
type BrokerCallOutcome =
  | { kind: "reply"; reply: NdjsonReply }
  | { kind: "unreachable" }
  | { kind: "timeout" };

/** 一次握手：发送 authenticate + 一个业务方法，按 id 取回业务回复。 */
function callBrokerOnce(
  socketPath: string,
  method: string,
  timeoutMs: number,
): Promise<BrokerCallOutcome> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    let buffer = "";
    const finish = (value: BrokerCallOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
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
            finish({ kind: "reply", reply });
            return;
          }
        } catch {
          // 忽略无法解析的行，继续等业务回复
        }
      }
    });
    socket.on("error", () => finish({ kind: "unreachable" }));
  });
}

/**
 * 查询 Linux CUA 权限状态。失败返回 null（上层 fail-closed）。
 */
export async function probeLinuxCuaPermissionStatus(
  socketPath: string,
  timeoutMs = 3000,
): Promise<LinuxCuaPermissionReport | null> {
  const outcome = await callBrokerOnce(socketPath, "permission_status", timeoutMs);
  if (outcome.kind !== "reply") return null;
  const reply = outcome.reply;
  if (reply.ok !== true || typeof reply.result !== "object" || reply.result === null) {
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

/**
 * 主动请求 portal 授权（触发一次弹窗）的结果。
 *
 * 历史缺陷：这里原先只返回 boolean，把 helper 的 `ok:false` 与「用户点了拒绝」压成同一个
 * `false`，上层只能显示「Portal authorization was not granted.」。当环境根本不具备授权
 * 条件（没有图形会话、portal 后端未运行）时，这句话把环境问题误报成用户操作问题。
 * 现在把 helper 的原始错误码/文本一并带出，由上层翻译成可操作的提示。
 */
export type LinuxCuaAccessFailureCode =
  /** portal 前端不存在：org.freedesktop.portal.RemoteDesktop 未在会话总线上导出。 */
  | "portal_frontend_unavailable"
  /** 没有可用的图形会话（未登录桌面 / Wayland socket 缺失 / Qt 平台插件加载失败）。 */
  | "graphical_session_unavailable"
  /** 用户在系统弹窗中拒绝，或弹窗被关闭。 */
  | "authorization_denied"
  /** 等待用户操作超时。 */
  | "authorization_timeout"
  /** helper 进程不可达（socket 不存在 / 连接被拒 / 握手无响应）。 */
  | "helper_unreachable"
  | "unknown";

export interface LinuxCuaAccessResult {
  granted: boolean;
  failureCode?: LinuxCuaAccessFailureCode;
  /** helper / portal 返回的原始错误文本，用于诊断与兜底展示。 */
  errorMessage?: string;
}

/**
 * 探测当前用户是否存在活动图形会话。
 *
 * 为什么需要这层探测：当机器停在登录界面（无人登录桌面）时，portal 后端
 * xdg-desktop-portal-kde 根本无法启动（它需要连 display），于是 D-Bus 上不会导出
 * org.freedesktop.impl.portal.desktop.kde，helper 只能看到「portal 前端缺失」。
 * 但「没登录桌面」与「登录了但 portal 坏了」对用户的处置完全不同，必须区分。
 *
 * 判定依据是运行时目录下的 Wayland socket（KDE Plasma 6 默认 Wayland）。
 * 不读 WAYLAND_DISPLAY 环境变量：server 由 systemd user service 启动，早于图形会话，
 * 拿不到该变量，读它会恒判为无会话。
 */
async function hasActiveGraphicalSession(): Promise<boolean> {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return false;
  try {
    const entries = await readdir(runtimeDir);
    return entries.some((name) => name.startsWith("wayland-"));
  } catch {
    return false;
  }
}

/**
 * 把 helper 的原始错误文本归类成可操作的失败码。
 * 只做归类，不改写原文——`errorMessage` 始终保留 portal 的原话，便于排障。
 */
function classifyAccessFailure(message: string): LinuxCuaAccessFailureCode {
  const text = message.toLowerCase();
  // 图形会话缺失：Qt 平台插件 / display 连接失败 / Wayland socket 缺失。
  // 放在 portal 前端之前判定：没有图形会话时 portal 前端必然也不存在，
  // 但「去登录桌面」与「去修 portal」是两件不同的事，前者更具体。
  if (
    text.includes("could not connect to display") ||
    text.includes("could not load the qt platform plugin") ||
    text.includes("no such file or directory") ||
    text.includes("wayland_display") ||
    text.includes("failed to connect to socket")
  ) {
    return "graphical_session_unavailable";
  }
  // portal 前端缺失：ashpd 的 RemoteDesktop::new 在找不到实现时抛这句。
  if (text.includes("portal frontend implementing") || text.includes("was not found")) {
    return "portal_frontend_unavailable";
  }
  // 用户拒绝 / 弹窗取消：xdg-desktop-portal 的 Response 为 1（取消）或 2（其它错误）。
  if (
    text.includes("cancelled") ||
    text.includes("canceled") ||
    text.includes("denied") ||
    text.includes("dismissed") ||
    text.includes("response: 1") ||
    text.includes("response: 2")
  ) {
    return "authorization_denied";
  }
  return "unknown";
}

/**
 * 主动请求 portal 授权（触发一次弹窗）。
 * 成功（用户在弹窗里确认）返回 `{ granted: true }`；失败时带回失败码与原始错误文本。
 * timeoutMs 需足够长（允许用户操作弹窗），默认 120s。
 */
export async function requestLinuxCuaAccess(
  socketPath: string,
  timeoutMs = 120_000,
): Promise<LinuxCuaAccessResult> {
  const outcome = await callBrokerOnce(socketPath, "request_access", timeoutMs);
  if (outcome.kind === "unreachable") {
    // helper 没起来：与「用户拒绝」完全不同的处置路径，必须分开报。
    return {
      granted: false,
      failureCode: "helper_unreachable",
      errorMessage: "Linux CUA Helper is not reachable on its broker socket",
    };
  }
  if (outcome.kind === "timeout") {
    // 握手/弹窗一直没回：常见于系统弹窗未被处理（用户不在机器前，或弹窗被遮挡）。
    return {
      granted: false,
      failureCode: "authorization_timeout",
      errorMessage: `Linux CUA Helper did not answer request_access within ${timeoutMs}ms`,
    };
  }
  const reply = outcome.reply;
  if (reply.ok === true) {
    const r = reply.result as { granted?: unknown } | null;
    return { granted: r?.granted === true };
  }
  // helper 的失败帧：{ error: { message, code, details } }。
  const error = reply.error as { message?: unknown; code?: unknown } | null | undefined;
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "request_access failed without an error message";
  let failureCode = classifyAccessFailure(message);
  // portal 前端缺失有两种成因，文本本身分不出来：没登录桌面（portal 后端起不来）
  // vs 登录了但 portal-kde 崩溃/未安装。用运行时目录里的 wayland socket 二次确认。
  if (failureCode === "portal_frontend_unavailable" && !(await hasActiveGraphicalSession())) {
    failureCode = "graphical_session_unavailable";
  }
  return {
    granted: false,
    failureCode,
    errorMessage: message,
  };
}
