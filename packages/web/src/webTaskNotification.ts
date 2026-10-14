/**
 * 浏览器任务的桌面通知封装。
 *
 * 问题：Web 端 `showTaskNotification` 只检查 `Notification.permission === "granted"`，
 * 全仓从未调用 `requestPermission`，浏览器默认权限是 `"default"`，导致任务通知永远不触发。
 *
 * 策略：
 * - 权限已授权 → 直接展示。
 * - 权限为 `default`（用户尚未决定）→ 请求一次；浏览器要求用户手势，无手势时请求可能被忽略，
 *   此时本次不展示，等下一次权限变为 granted 后自然生效。
 * - 权限 `denied` → 不再请求，避免反复打扰。
 * - 页面聚焦时不打扰（与桌面端窗口聚焦抑制一致）。
 *
 * 只依赖注入的 `Notification` 构造器与 `document`，便于单测。
 */

export interface NotificationLike {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): object;
}

export interface WebTaskNotificationPorts {
  /** 浏览器 Notification 构造器；缺失（非浏览器环境）时为 undefined。 */
  notification: NotificationLike | undefined;
  /** 当前文档是否聚焦；聚焦时不打扰。 */
  hasFocus(): boolean;
  /** 展示后回调（用于播放提示音等增强体验）。 */
  onShown?(): void;
}

export interface WebTaskNotificationState {
  /** 已发起过权限请求，避免重复请求。 */
  requested: boolean;
}

export function createWebTaskNotificationState(): WebTaskNotificationState {
  return { requested: false };
}

/**
 * 展示一条任务通知。返回是否实际展示了通知。
 *
 * `state` 跨调用共享，用于记录"已请求过权限"，避免每次通知都重复请求。
 */
export function showWebTaskNotification(
  notification: WebTaskNotificationPorts,
  payload: { title: string; body: string },
  state: WebTaskNotificationState,
): boolean {
  const Ctor = notification.notification;
  if (!Ctor) {
    return false;
  }
  // 页面聚焦说明用户正在看，不需要打扰（与桌面端窗口聚焦抑制一致）。
  if (notification.hasFocus()) {
    return false;
  }

  const permission = Ctor.permission;
  if (permission === "denied") {
    return false;
  }
  if (permission === "default") {
    // 浏览器要求用户手势才弹权限框；这里发起一次请求，本次不展示。
    // 授权后的下一次通知会走 granted 分支正常展示。
    if (!state.requested) {
      state.requested = true;
      void Ctor.requestPermission().catch(() => {
        // 请求失败（如无用户手势被忽略）静默忽略，不影响主流程。
      });
    }
    return false;
  }

  try {
    new Ctor(payload.title, { body: payload.body, silent: true });
    notification.onShown?.();
    return true;
  } catch {
    // 通知不可用时静默忽略，避免打断主流程。
    return false;
  }
}
