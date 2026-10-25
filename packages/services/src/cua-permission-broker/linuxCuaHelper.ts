// Linux Computer Use Helper 的生命周期管理。
//
// 作用：在 Linux 上为 CUA 提供与 mac/win 等价的「permission broker Helper」——
// 一个监听 unix socket、按 CUA broker 线协议（NDJSON）应答的本地进程。
// mac/win 的 Helper 是各自平台的原生可执行物；Linux 没有对应产物，这里 spawn
// 一个 Rust 实现（AT-SPI 读树 + xdg-desktop-portal 抓屏/注入），由本模块负责
// 稳定性（惰性单例 + 存活探测 + 退出清理）。
//
// 与 mac/win 的差异只在「谁提供 Helper 进程」，对上层注入 broker socket 的路径完全一致。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("cua-linux-helper");

const HELPER_BIN_ENV = "ZCODE_CUA_LINUX_HELPER_BIN";
const HELPER_DISABLE_ENV = "ZCODE_CUA_LINUX_HELPER_DISABLE";
const HELPER_SOCKET_ENV = "ZCODE_CUA_LINUX_HELPER_SOCKET";

let helperProcess: ChildProcess | undefined;
let helperSocketPath: string | undefined;
let helperStarting: Promise<string | null> | undefined;

/** 解析 Linux helper 可执行文件路径：显式 env 优先，其次是安装目录约定位置。 */
export function resolveLinuxCuaHelperBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env[HELPER_BIN_ENV]?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  // 约定：与 node 可执行文件同级的 cua-linux-helper，或 PATH 上的 cua-linux-helper
  const candidates = [
    join(dirname(process.execPath), "cua-linux-helper"),
    "/usr/local/bin/cua-linux-helper",
    "/usr/bin/cua-linux-helper",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** 是否应在当前进程启用 Linux CUA Helper（仅 linux，且未被显式禁用，且能找到二进制）。 */
export function isLinuxCuaHelperAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return false;
  if (env[HELPER_DISABLE_ENV]?.trim() === "1") return false;
  return Boolean(resolveLinuxCuaHelperBinary(env));
}

function resolveLinuxHelperSocketPath(): string {
  const fromEnv = process.env[HELPER_SOCKET_ENV]?.trim();
  if (fromEnv) return fromEnv;
  // 稳定路径（同一用户下稳定），便于 helper 被外部提前拉起时复用。
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join("/tmp", `zcode-cua-linux-helper-${uid}.sock`);
}

/** 用 broker 的 ping 探针判断 socket 上是否已有活的 helper。 */
async function probeHelperSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => {
      socket.write(`{"id":0,"method":"ping","params":{}}\n`);
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          try {
            const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { ok?: boolean };
            finish(reply.ok === true);
          } catch {
            finish(false);
          }
        }
      });
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * 确保 Linux CUA Helper 在运行，返回可注入 agent 的 broker socket 路径。
 *
 * 惰性单例：并发调用共享同一次启动；已有活的 helper 时直接复用。失败返回 null
 * （上层据此不注入 socket，CUA 保持不可用，fail-closed）。
 */
export async function ensureLinuxCuaHelper(): Promise<string | null> {
  if (!isLinuxCuaHelperAvailable()) return null;
  const socketPath = resolveLinuxHelperSocketPath();

  // 已就绪（本进程拉起过，或外部已启动）
  if (helperProcess && !helperProcess.killed && (await probeHelperSocket(socketPath))) {
    return socketPath;
  }
  if (await probeHelperSocket(socketPath)) {
    helperSocketPath = socketPath;
    return socketPath;
  }
  if (helperStarting) return await helperStarting;

  helperStarting = (async (): Promise<string | null> => {
    const binary = resolveLinuxCuaHelperBinary();
    if (!binary) return null;
    try {
      await mkdir(dirname(socketPath), { recursive: true });
      await rm(socketPath, { force: true });
    } catch {
      // 忽略：helper 自己也会清理 socket
    }
    const child = spawn(binary, ["--socket", socketPath], {
      // stderr 继承父进程：helper 的诊断日志（portal 会话步骤等）直接进 systemd journal。
      // 之前走 logger.debug 转发，但 debug 级在生产环境不落盘，诊断信息会丢。
      stdio: ["ignore", "ignore", "inherit"],
      detached: false,
    });
    child.on("exit", (code, signal) => {
      if (helperProcess === child) {
        helperProcess = undefined;
        logger.info?.(undefined, "CUA Linux Helper exited", { code, signal });
      }
    });
    child.on("error", (error) => {
      logger.error?.(undefined, "CUA Linux Helper failed to spawn", error);
    });
    helperProcess = child;

    // 轮询就绪（最多 5s）
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await probeHelperSocket(socketPath)) {
        helperSocketPath = socketPath;
        logger.info?.(undefined, "CUA Linux Helper ready", { socketPath });
        return socketPath;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.warn?.(undefined, "CUA Linux Helper did not become ready in time", { socketPath });
    return null;
  })();

  try {
    return await helperStarting;
  } finally {
    helperStarting = undefined;
  }
}

/** 关闭当前进程拉起的 helper（Host/App dispose 时调用）。 */
export async function disposeLinuxCuaHelper(): Promise<void> {
  const child = helperProcess;
  helperProcess = undefined;
  const socketPath = helperSocketPath;
  helperSocketPath = undefined;
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // 忽略
    }
  }
  if (socketPath) {
    // 只在确实是我们管理的稳定路径时才删；helper 自身也会删
    await rm(socketPath, { force: true }).catch(() => undefined);
  }
}

/** 供测试重置。 */
export function __resetLinuxCuaHelperForTest(): void {
  helperProcess = undefined;
  helperSocketPath = undefined;
  helperStarting = undefined;
}
