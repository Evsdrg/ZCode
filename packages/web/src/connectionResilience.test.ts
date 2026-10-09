import { describe, expect, it, vi } from "vitest";
import { createReconnectController } from "./connectionResilience.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createReconnectController", () => {
  it("非预期关闭：提示一次并按退避探测，可达即重载", async () => {
    const reload = vi.fn();
    const onReconnecting = vi.fn();
    const controller = createReconnectController({
      probe: async () => true,
      reload,
      onReconnecting,
      sleep: async () => {},
    });
    controller.notifyClosed();
    await flush();
    expect(onReconnecting).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("重复关闭只重连一次（幂等）", async () => {
    const probe = vi.fn(async () => true);
    const controller = createReconnectController({
      probe,
      reload: vi.fn(),
      onReconnecting: vi.fn(),
      sleep: async () => {},
    });
    controller.notifyClosed();
    controller.notifyClosed();
    controller.notifyClosed();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("不可达则持续重试、不重载", async () => {
    const probe = vi.fn(async () => false);
    const reload = vi.fn();
    let sleeps = 0;
    const controller = createReconnectController({
      probe,
      reload,
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 3) controller.dispose();
      },
    });
    controller.notifyClosed();
    await flush();
    await flush();
    await flush();
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("卸载中（markShuttingDown）不触发重连", async () => {
    const onReconnecting = vi.fn();
    const controller = createReconnectController({
      probe: async () => true,
      reload: vi.fn(),
      onReconnecting,
      sleep: async () => {},
    });
    controller.markShuttingDown();
    controller.notifyClosed();
    await flush();
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it("探测抛错按不可达处理，不冒泡", async () => {
    let n = 0;
    const controller = createReconnectController({
      probe: async () => {
        if (n++ === 0) throw new Error("network");
        return true;
      },
      reload: vi.fn(),
      sleep: async () => {},
    });
    expect(() => controller.notifyClosed()).not.toThrow();
    await flush();
    await flush();
  });
});
