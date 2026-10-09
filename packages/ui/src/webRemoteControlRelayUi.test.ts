import { describe, expect, it } from "vitest";
import type { WebRemoteControlRelayStatus } from "@zcode/services";
import {
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
