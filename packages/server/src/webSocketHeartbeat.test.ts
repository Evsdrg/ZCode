import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebSocketHeartbeat, type HeartbeatSocketLike } from "./webSocketHeartbeat.js";

/** 可控 fake：记录 ping/terminate，暴露 pong 触发。 */
function createFakeSocket() {
  let pongListener: (() => void) | null = null;
  const pings: number[] = [];
  const socket: HeartbeatSocketLike = {
    ping: () => pings.push(Date.now()),
    terminate: vi.fn(),
    on: (_event, listener) => {
      pongListener = listener;
      return socket;
    },
  };
  return {
    socket,
    pings,
    firePong: () => pongListener?.(),
    terminate: socket.terminate as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startWebSocketHeartbeat", () => {
  it("按间隔周期性发送 ping", () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const hb = startWebSocketHeartbeat({ socket: fake.socket, intervalMs: 1000, timeoutMs: 10000 });
    vi.advanceTimersByTime(3500);
    expect(fake.pings).toHaveLength(3);
    hb.dispose();
  });

  it("超时未收到 pong 则 terminate（半死连接判定）", () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const onTimeout = vi.fn();
    startWebSocketHeartbeat({ socket: fake.socket, intervalMs: 1000, timeoutMs: 3000, onTimeout });
    vi.advanceTimersByTime(4000);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(expect.any(Number));
  });

  it("收到 pong 重置计时，不误判超时", () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const hb = startWebSocketHeartbeat({ socket: fake.socket, intervalMs: 1000, timeoutMs: 3000 });
    vi.advanceTimersByTime(2500);
    fake.firePong();
    vi.advanceTimersByTime(2500); // 距上次 pong 仅 2500 < 3000
    expect(fake.terminate).not.toHaveBeenCalled();
    hb.dispose();
  });

  it("dispose 后停止发 ping", () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const hb = startWebSocketHeartbeat({ socket: fake.socket, intervalMs: 1000, timeoutMs: 10000 });
    vi.advanceTimersByTime(2000);
    const before = fake.pings.length;
    hb.dispose();
    vi.advanceTimersByTime(5000);
    expect(fake.pings).toHaveLength(before);
  });

  it("terminate 后不再重复触发", () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    startWebSocketHeartbeat({ socket: fake.socket, intervalMs: 1000, timeoutMs: 2000 });
    vi.advanceTimersByTime(5000);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("ping 抛错不冒泡（关闭竞态）", () => {
    vi.useFakeTimers();
    const socket: HeartbeatSocketLike = {
      ping: () => {
        throw new Error("closed");
      },
      terminate: vi.fn(),
      on: () => socket,
    };
    const hb = startWebSocketHeartbeat({ socket, intervalMs: 1000, timeoutMs: 10000 });
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    hb.dispose();
  });
});
