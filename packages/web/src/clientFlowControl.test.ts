import { describe, expect, it, vi } from "vitest";
import {
  createClientFlowControl,
  type ClientFlowStatePort,
  type VisibilityDocument,
} from "./clientFlowControl.js";

/** 可切换可见性、可手动触发监听器的 fake document。 */
function createFakeDocument(initial: string): VisibilityDocument & {
  setVisibility(next: string): void;
} {
  let visibilityState = initial;
  const listeners = new Set<() => void>();
  return {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    setVisibility(next) {
      visibilityState = next;
      for (const listener of listeners) listener();
    },
  };
}

function createPort(): ClientFlowStatePort & {
  calls: Array<{ state: "saturated" | "drained" }>;
  failNext(error: unknown): void;
} {
  const calls: Array<{ state: "saturated" | "drained" }> = [];
  let pendingError: unknown = null;
  return {
    calls,
    failNext(error) {
      pendingError = error;
    },
    async setClientFlowStateV4(params) {
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        throw error;
      }
      calls.push(params);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createClientFlowControl", () => {
  it("隐藏置 saturated，可见置 drained", async () => {
    const documentTarget = createFakeDocument("visible");
    const port = createPort();
    const control = createClientFlowControl({ port, documentTarget });

    documentTarget.setVisibility("hidden");
    await flush();
    expect(port.calls).toEqual([{ state: "saturated" }]);

    documentTarget.setVisibility("visible");
    await flush();
    expect(port.calls).toEqual([{ state: "saturated" }, { state: "drained" }]);

    control.dispose();
  });

  it("同态重复触发不重复上报", async () => {
    const documentTarget = createFakeDocument("visible");
    const port = createPort();
    const control = createClientFlowControl({ port, documentTarget });

    documentTarget.setVisibility("hidden");
    documentTarget.setVisibility("hidden");
    await flush();
    expect(port.calls).toEqual([{ state: "saturated" }]);

    control.dispose();
  });

  it("sync 按当前可见性立即同步一次", async () => {
    const documentTarget = createFakeDocument("hidden");
    const port = createPort();
    const control = createClientFlowControl({ port, documentTarget });

    control.sync();
    await flush();
    expect(port.calls).toEqual([{ state: "saturated" }]);

    control.dispose();
  });

  it("上报失败清记忆，下次变化重试", async () => {
    const documentTarget = createFakeDocument("visible");
    const port = createPort();
    const onError = vi.fn();
    const control = createClientFlowControl({ port, documentTarget, onError });

    port.failNext(new Error("boom"));
    documentTarget.setVisibility("hidden");
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(port.calls).toEqual([]);

    // 失败后记忆被清，下一次可见性变化会重新同步当前档位。
    documentTarget.setVisibility("visible");
    await flush();
    expect(port.calls).toEqual([{ state: "drained" }]);

    documentTarget.setVisibility("hidden");
    await flush();
    expect(port.calls).toEqual([{ state: "drained" }, { state: "saturated" }]);

    control.dispose();
  });

  it("dispose 后不再监听", async () => {
    const documentTarget = createFakeDocument("visible");
    const port = createPort();
    const control = createClientFlowControl({ port, documentTarget });

    control.dispose();
    documentTarget.setVisibility("hidden");
    await flush();
    expect(port.calls).toEqual([]);
  });
});
