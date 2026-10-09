/**
 * 浏览器主连接的断线重连编排。
 *
 * 背景：浏览器 ↔ edge-proxy ↔ 隧道 ↔ Host 的 `/ws` 是唯一没有断线重连的长连接
 * （`onClose: () => {}` 是空处理），一断 UI 静默卡死。RPC 层无法跨连接续传
 * （服务端每次 upgrade 新建会话），因此重连 = 探测可达后整页重载，复用既有 bootstrap
 * 流程干净重建。本模块只负责状态机，副作用（探测/重载/渲染覆盖层）由调用方注入。
 */

/** 退避序列（ms）：前几次快重试，之后收敛到 30s，避免无限快速重连。 */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000, 30000] as const;

export interface ReconnectControllerOptions {
  /** 探测服务可达性；返回 true 即触发 reload。 */
  probe(): Promise<boolean>;
  /** 触发整页重载（重新 bootstrap）。 */
  reload(): void;
  /** 进入重连态时回调（用于渲染可见提示）。 */
  onReconnecting?(): void;
  /** 可注入的 sleep（测试用）。 */
  sleep?(ms: number): Promise<void>;
}

export interface ReconnectController {
  /** 主连接收到非预期 close 时调用；幂等。 */
  notifyClosed(): void;
  /** 页面卸载中调用：之后的 close 不再触发重连。 */
  markShuttingDown(): void;
  dispose(): void;
}

export function createReconnectController(options: ReconnectControllerOptions): ReconnectController {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let reconnecting = false;
  let disposed = false;

  async function loop(): Promise<void> {
    let attempt = 0;
    while (!disposed) {
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
      attempt += 1;
      await sleep(delay);
      if (disposed) return;
      try {
        if (await options.probe()) {
          options.reload();
          return;
        }
      } catch {
        // 探测失败按不可达处理，继续退避重试。
      }
    }
  }

  return {
    notifyClosed() {
      // 卸载中、已销毁、或已进入重连态 → 忽略（重复 close 只重连一次）。
      if (disposed || reconnecting) return;
      reconnecting = true;
      options.onReconnecting?.();
      void loop();
    },
    markShuttingDown() {
      disposed = true;
    },
    dispose() {
      disposed = true;
    },
  };
}
