import { describe, expect, it, vi } from "vitest";
import {
  createWebTaskNotificationState,
  showWebTaskNotification,
  type NotificationLike,
} from "./webTaskNotification.js";

function createNotificationDouble(permission: NotificationPermission) {
  const constructed: Array<{ title: string; options?: NotificationOptions }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, options?: NotificationOptions) {
      constructed.push({ title, options });
    }
  }
  return {
    Ctor: FakeNotification as unknown as NotificationLike,
    constructed,
    requestPermission,
  };
}

const payload = { title: "任务已完成", body: "body" };

describe("showWebTaskNotification", () => {
  it("权限已授予且页面失焦时展示通知并回调 onShown", () => {
    const { Ctor, constructed } = createNotificationDouble("granted");
    const onShown = vi.fn();
    const shown = showWebTaskNotification(
      { notification: Ctor, hasFocus: () => false, onShown },
      payload,
      createWebTaskNotificationState(),
    );
    expect(shown).toBe(true);
    expect(constructed).toEqual([{ title: "任务已完成", options: { body: "body", silent: true } }]);
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it("页面聚焦时不打扰", () => {
    const { Ctor, constructed } = createNotificationDouble("granted");
    const shown = showWebTaskNotification(
      { notification: Ctor, hasFocus: () => true },
      payload,
      createWebTaskNotificationState(),
    );
    expect(shown).toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it("权限为 default 时请求一次且本次不展示；重复调用不重复请求", () => {
    const { Ctor, constructed, requestPermission } = createNotificationDouble("default");
    const state = createWebTaskNotificationState();
    const ports = { notification: Ctor, hasFocus: () => false };

    expect(showWebTaskNotification(ports, payload, state)).toBe(false);
    expect(showWebTaskNotification(ports, payload, state)).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveLength(0);
  });

  it("权限被拒时不再请求也不展示", () => {
    const { Ctor, constructed, requestPermission } = createNotificationDouble("denied");
    const shown = showWebTaskNotification(
      { notification: Ctor, hasFocus: () => false },
      payload,
      createWebTaskNotificationState(),
    );
    expect(shown).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0);
  });

  it("无 Notification 构造器时安全返回", () => {
    const shown = showWebTaskNotification(
      { notification: undefined, hasFocus: () => false },
      payload,
      createWebTaskNotificationState(),
    );
    expect(shown).toBe(false);
  });

  it("构造抛错时静默返回 false，不打断主流程", () => {
    class ThrowingNotification {
      static permission = "granted" as NotificationPermission;
      static requestPermission = async () => "granted" as NotificationPermission;
      constructor() {
        throw new Error("blocked");
      }
    }
    const shown = showWebTaskNotification(
      { notification: ThrowingNotification as unknown as NotificationLike, hasFocus: () => false },
      payload,
      createWebTaskNotificationState(),
    );
    expect(shown).toBe(false);
  });
});
