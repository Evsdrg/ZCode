/**
 * 浏览器 WS 连接心跳。
 *
 * 自部署链路（浏览器 → edge-proxy → SSH 隧道 → 本机 Host）是唯一没有应用层保活的长连接：
 * 空闲期（模型静默思考、长工具执行）可能被中间有状态设备（云 NAT/网关、mesh）掐断，
 * 且半开连接无法靠 TCP 感知。这里用 WS 控制帧 Ping/Pong：
 * - 周期性发 Ping → 双向产生流量，重置各跳空闲计时器（浏览器按规范自动回 Pong，无需 JS）；
 * - 超时未收到 Pong → 判定半死连接，terminate 触发浏览器重连。
 *
 * 只发控制帧，不改业务负载格式，也不引入 PersistentProtocol 的 ACK/重放语义
 * （服务端每次 upgrade 新建会话，无法透明续传）。
 */

/** 心跳所需的最小 socket 接口（ws 库 WebSocket 的子集），便于注入 fake 测试。 */
export interface HeartbeatSocketLike {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 25_000;
export const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface WebSocketHeartbeat {
  /** 连接关闭时必须调用：清理定时器。 */
  dispose(): void;
}

export function startWebSocketHeartbeat(options: {
  socket: HeartbeatSocketLike;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  onTimeout?: (idleMs: number) => void;
}): WebSocketHeartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let lastPongAt = now();
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  options.socket.on("pong", () => {
    lastPongAt = now();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  timer = setInterval(() => {
    if (disposed) return;
    const idleMs = now() - lastPongAt;
    if (idleMs > timeoutMs) {
      // 半死连接：TCP 感知不到，靠 Pong 缺失判定，主动终止触发对端重连。
      try {
        options.onTimeout?.(idleMs);
        options.socket.terminate();
      } catch {
        // 终止竞态异常忽略：连接已在关闭中。
      }
      dispose();
      return;
    }
    try {
      options.socket.ping();
    } catch {
      // 关闭竞态：ping 抛错忽略，等 close 事件清理。
    }
  }, intervalMs);

  // 定时器不阻止进程/测试退出。
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return { dispose };
}
