import { describe, expect, it } from "vitest";
import type { WebRemoteControlRelayStatus } from "@zcode/services";
import {
  resolveWebRemoteControlAvailable,
  resolveRelayPrimaryAction,
  resolveRelaySectionVisible,
  resolveRelayTriggerIconClass,
  resolveRelayStateLabelId,
  resolveRelayStatusTone,
  shouldRenderRelayQrCode,
} from "@/webRemoteControlRelayUi.js";

function status(partial: Partial<WebRemoteControlRelayStatus>): WebRemoteControlRelayStatus {
  return { enabled: true, state: "connecting", ...partial };
}

describe("webRemoteControlRelayUi 可见性", () => {
  it("服务未注册（desktop host）时区块隐藏", () => {
    expect(resolveRelaySectionVisible(undefined)).toBe(false);
    expect(resolveRelaySectionVisible(null)).toBe(false);
  });

  it("服务已注册（自部署形态）时区块可见", () => {
    expect(resolveRelaySectionVisible({} as never)).toBe(true);
  });
});

describe("webRemoteControlRelayUi 状态投影", () => {
  it("未开启与各运行态映射到对应文案 key", () => {
    expect(resolveRelayStateLabelId(null)).toBe("webRemoteControl.relay.state.disabled");
    expect(resolveRelayStateLabelId(status({ enabled: false, state: "disabled" }))).toBe(
      "webRemoteControl.relay.state.disabled",
    );
    expect(resolveRelayStateLabelId(status({ state: "connecting" }))).toBe(
      "webRemoteControl.relay.state.connecting",
    );
    expect(resolveRelayStateLabelId(status({ state: "waiting" }))).toBe(
      "webRemoteControl.relay.state.waiting",
    );
    expect(resolveRelayStateLabelId(status({ state: "paired" }))).toBe(
      "webRemoteControl.relay.state.paired",
    );
    expect(resolveRelayStateLabelId(status({ state: "error" }))).toBe(
      "webRemoteControl.relay.state.error",
    );
  });

  it("状态色：paired/waiting 为 success，error 为 danger，connecting 为 loading", () => {
    expect(resolveRelayStatusTone(status({ state: "paired" }))).toBe("success");
    expect(resolveRelayStatusTone(status({ state: "waiting" }))).toBe("success");
    expect(resolveRelayStatusTone(status({ state: "error" }))).toBe("danger");
    expect(resolveRelayStatusTone(status({ state: "connecting" }))).toBe("loading");
    expect(resolveRelayStatusTone(null)).toBe("neutral");
  });

  it("主操作：未开启→enable，error→retry，其余已开启态→disable", () => {
    expect(resolveRelayPrimaryAction(null)).toBe("enable");
    expect(resolveRelayPrimaryAction(status({ enabled: false, state: "disabled" }))).toBe("enable");
    expect(resolveRelayPrimaryAction(status({ state: "error" }))).toBe("retry");
    expect(resolveRelayPrimaryAction(status({ state: "waiting" }))).toBe("disable");
    expect(resolveRelayPrimaryAction(status({ state: "paired" }))).toBe("disable");
    expect(resolveRelayPrimaryAction(status({ state: "connecting" }))).toBe("disable");
  });

  it("二维码只在 waiting/paired 展示；disabled/connecting/error 不展示", () => {
    expect(shouldRenderRelayQrCode(status({ state: "waiting" }))).toBe(true);
    expect(shouldRenderRelayQrCode(status({ state: "paired" }))).toBe(true);
    expect(shouldRenderRelayQrCode(status({ state: "connecting" }))).toBe(false);
    expect(shouldRenderRelayQrCode(status({ state: "error" }))).toBe(false);
    expect(shouldRenderRelayQrCode(status({ enabled: false, state: "disabled" }))).toBe(false);
    expect(shouldRenderRelayQrCode(null)).toBe(false);
  });
});

describe("webRemoteControlRelayUi 侧栏入口图标", () => {
  it("开启中为 amber，未开启为默认色", () => {
    expect(resolveRelayTriggerIconClass(true)).toBe("text-amber-500");
    expect(resolveRelayTriggerIconClass(false)).toBe("text-foreground-subtle");
  });
});

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
