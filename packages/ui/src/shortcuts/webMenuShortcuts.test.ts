import { describe, expect, it } from "vitest";
import {
  WEB_CONFIGURABLE_MENU_COMMAND_IDS,
  isMenuChannelUnavailable,
  isWebConfigurableMenuCommand,
} from "@/shortcuts/webMenuShortcuts.js";
import { checkShortcutBindingConflict } from "@/shortcuts/conflicts.js";

describe("webMenuShortcuts", () => {
  it("只把 newTask / openWorkspace 列为 Web 可配置 menu 命令", () => {
    expect([...WEB_CONFIGURABLE_MENU_COMMAND_IDS].sort()).toEqual(["newTask", "openWorkspace"]);
  });

  it("isWebConfigurableMenuCommand 只对 menu 通道 + 白名单命令返回 true", () => {
    expect(isWebConfigurableMenuCommand("newTask", "menu")).toBe(true);
    expect(isWebConfigurableMenuCommand("openWorkspace", "menu")).toBe(true);
    expect(isWebConfigurableMenuCommand("closeActiveContext", "menu")).toBe(false);
    expect(isWebConfigurableMenuCommand("zoomIn", "menu")).toBe(false);
    // window 通道不属于 menu 通道，恒 false。
    expect(isWebConfigurableMenuCommand("newTask", "window")).toBe(false);
  });

  it("isMenuChannelUnavailable：Web 下仅 4 条不可配置的 menu 命令置灰", () => {
    // Web（isDesktop=false）：白名单内可改键，不置灰。
    expect(isMenuChannelUnavailable("newTask", "menu", false)).toBe(false);
    expect(isMenuChannelUnavailable("openWorkspace", "menu", false)).toBe(false);
    // Web：其余 menu 命令置灰。
    expect(isMenuChannelUnavailable("closeActiveContext", "menu", false)).toBe(true);
    expect(isMenuChannelUnavailable("zoomIn", "menu", false)).toBe(true);
    expect(isMenuChannelUnavailable("zoomOut", "menu", false)).toBe(true);
    expect(isMenuChannelUnavailable("resetZoom", "menu", false)).toBe(true);
    // window 命令永不被 menu 规则置灰。
    expect(isMenuChannelUnavailable("findInTask", "window", false)).toBe(false);
    // 桌面端 menu 通道由 main 注册 accelerator，全部可改。
    expect(isMenuChannelUnavailable("closeActiveContext", "menu", true)).toBe(false);
    expect(isMenuChannelUnavailable("newTask", "menu", true)).toBe(false);
  });
});

describe("checkShortcutBindingConflict：Web menu 保留键", () => {
  it("不可配置的 menu 命令默认键仍按 reserved 拒绝抢绑", () => {
    // 把 findInTask 绑到 Ctrl+W（closeActiveContext 的默认键）应被判为 reserved。
    const conflict = checkShortcutBindingConflict("findInTask", "CmdOrCtrl+w", undefined, {
      menuChannelReserved: true,
      platformInfo: { isApple: false } as never,
    });
    expect(conflict?.kind).toBe("reserved");
  });

  it("可配置的 menu 命令（newTask）默认键退化为普通占用，允许二次确认抢绑", () => {
    // 把 findInTask 绑到 Ctrl+N（newTask 的默认键）应判为 occupied 而非 reserved。
    const conflict = checkShortcutBindingConflict("findInTask", "CmdOrCtrl+n", undefined, {
      menuChannelReserved: true,
      platformInfo: { isApple: false } as never,
    });
    expect(conflict?.kind).toBe("occupied");
    expect(conflict?.ownerCommandId).toBe("newTask");
  });
});
