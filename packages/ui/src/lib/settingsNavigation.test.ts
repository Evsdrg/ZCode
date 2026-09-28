import { describe, expect, it } from "vitest";
import {
  isSettingsSectionEnabled,
  resolveSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";

// 覆盖本次「按自部署浏览器形态放开能力门控」中唯一由 settingsNavigation 持有的决策：
// Claude 原生历史迁移分区整体关闭。行为契约见
// docs/specs/selfhost-browser-capability-gates.md。
//
// 这里只通过公开函数断言，不 import 未导出的 HIDDEN_SETTINGS_SECTIONS：
// 分区可见性的唯一所有者就是 isSettingsSectionEnabled / resolveSettingsSection，
// 测试应当锁住契约而非内部集合的形状。
describe("settingsNavigation 分区可见性", () => {
  it("migration 分区已关闭", () => {
    expect(isSettingsSectionEnabled("migration")).toBe(false);
  });

  it("resolveSettingsSection 对已关闭的 migration 回退到 general", () => {
    expect(resolveSettingsSection("migration")).toBe("general");
  });

  it("resolveSettingsSection 支持自定义回退目标", () => {
    expect(resolveSettingsSection("migration", "general")).toBe("general");
  });

  it("仍保持 plugins -> plugin 的历史 id 迁移", () => {
    expect(resolveSettingsSection("plugins")).toBe("plugin");
  });

  // 关闭 migration 是一次收窄，不能顺手关掉别的分区。
  it("未受影响的分区仍然启用", () => {
    const stillEnabled: SettingsSectionId[] = [
      "general",
      "appearance",
      "browser",
      "modelProvider",
      "memory",
      "plugin",
      "mcp",
      "skill",
      "usage",
      "subagents",
      "commands",
      "hooks",
      "shortcuts",
    ];
    for (const section of stillEnabled) {
      expect(isSettingsSectionEnabled(section), `${section} 应保持启用`).toBe(true);
      expect(resolveSettingsSection(section), `${section} 应解析为自身`).toBe(section);
    }
  });

  it("既有隐藏分区未被误开", () => {
    expect(isSettingsSectionEnabled("automations")).toBe(false);
    expect(isSettingsSectionEnabled("plugins")).toBe(false);
    expect(isSettingsSectionEnabled("workspaceFileSearch")).toBe(false);
    expect(isSettingsSectionEnabled("computerUse")).toBe(false);
  });
});
