import { describe, expect, it } from "vitest";
import {
  resolveRelayTriggerIconClass,
  resolveWebRemoteControlAvailable,
} from "@/webRemoteControlRelayUi.js";

describe("webRemoteControlRelayUi 官方卡片可用性", () => {
  // 「手机扫码连接」卡片走官方四个 platform 方法。桌面端由 Electron preload 提供原生链路；
  // 自部署端由 server 注册的 relay 服务投影进这四个方法（同一 zcode.z.ai 中转）。
  it("桌面 preload 注入了原生链路能力时可用", () => {
    expect(
      resolveWebRemoteControlAvailable({
        platform: { openCuaPermissionOnboarding: async () => ({ success: true }) },
        relayService: undefined,
      }),
    ).toBe(true);
  });

  it("自部署注册了 relay 服务时可用（无需桌面能力）", () => {
    expect(
      resolveWebRemoteControlAvailable({
        platform: {},
        relayService: {} as never,
      }),
    ).toBe(true);
  });

  it("两者都不存在时不可用（避免必然失败的启动）", () => {
    expect(resolveWebRemoteControlAvailable({ platform: {}, relayService: undefined })).toBe(false);
    expect(resolveWebRemoteControlAvailable({ platform: undefined, relayService: null })).toBe(
      false,
    );
    expect(resolveWebRemoteControlAvailable({ platform: null, relayService: null })).toBe(false);
  });
});

describe("webRemoteControlRelayUi 侧栏入口图标", () => {
  it("开启中为 amber，未开启为默认色", () => {
    expect(resolveRelayTriggerIconClass(true)).toBe("text-amber-500");
    expect(resolveRelayTriggerIconClass(false)).toBe("text-foreground-subtle");
  });
});
