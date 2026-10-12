/**
 * 浏览器页面可见性 → 连接投递档位。
 *
 * 背景：浏览器 ↔ edge-proxy ↔ 隧道 ↔ Host 的 `/ws` 在页面隐藏（切标签、锁屏、切后台）时
 * 仍保持连接，订阅持续有效，CLI 会继续把会话增量帧推过隧道。闭源 CLI 已实现连接级流控
 * `v4/connection/flow`（saturated 暂停打帧 / drained 恢复），桌面端经 MessagePort sideband
 * 驱动它，浏览器链路从未接线。本模块把 `visibilitychange` 接到 scope 的
 * `setClientFlowStateV4`：隐藏置 saturated，可见置 drained。
 *
 * 只影响投递调度，不改订阅语义：订阅仍在，resident 回收判定不会因隐藏而回收会话。
 */

/** 仅需 document 的可见性读取与监听面，便于注入 fake 测试。 */
export interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** 只依赖最小服务面：调用方注入 agentService，避免本模块耦合完整 accessor。 */
export interface ClientFlowStatePort {
  setClientFlowStateV4(params: { state: "saturated" | "drained" }): Promise<void>;
}

export interface ClientFlowControlOptions {
  port: ClientFlowStatePort;
  documentTarget: VisibilityDocument;
  /** 失败只降级为继续投递，不打断页面；用于诊断。 */
  onError?(error: unknown): void;
}

export interface ClientFlowControl {
  /** 立即按当前可见性同步一次（挂载时调用，覆盖“加载即隐藏”的初始态）。 */
  sync(): void;
  dispose(): void;
}

/**
 * 幂等：只在档位真正变化时发 RPC。隐藏期间重复的 visibilitychange 不重复上报；
 * 失败不回滚本地档位记忆，下一次可见性变化会重试。
 */
export function createClientFlowControl(options: ClientFlowControlOptions): ClientFlowControl {
  const { port, documentTarget } = options;
  let lastState: "saturated" | "drained" | null = null;
  let disposed = false;

  const desiredState = (): "saturated" | "drained" =>
    documentTarget.visibilityState === "hidden" ? "saturated" : "drained";

  const apply = (): void => {
    if (disposed) return;
    const state = desiredState();
    if (state === lastState) return;
    lastState = state;
    void port.setClientFlowStateV4({ state }).catch((error: unknown) => {
      // 上报失败不能让页面报错；清掉记忆，下次可见性变化重试。
      lastState = null;
      options.onError?.(error);
    });
  };

  documentTarget.addEventListener("visibilitychange", apply);

  return {
    sync: apply,
    dispose() {
      if (disposed) return;
      disposed = true;
      documentTarget.removeEventListener("visibilitychange", apply);
    },
  };
}
