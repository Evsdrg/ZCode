import { describe, expect, it } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { TID_SETTINGS_WEB_UI_VERSION_VALUE } from "@zcode/shared/test-ids";
import { ZCODE_VERSION } from "@zcode/shared";

// 覆盖 docs/specs/webui-version-display.md 的不变量。
// 这里刻意不做整棵 GeneralSectionContent 的渲染测试：该组件依赖 useZCodeIntl()
// 与数十个必填 prop，为一行只读文本拉起整套 provider 的收益低于成本。
// 改为直接锁住这条契约真正需要保证的东西：双语 key 齐全、措辞不含糊、
// testId 稳定、版本常量可解析。
describe("Web UI 版本展示契约", () => {
  const LOCALES = [
    { name: "zh-CN", messages: zhCN },
    { name: "en-US", messages: enUS },
  ] as const;

  it("testId 合同稳定", () => {
    expect(TID_SETTINGS_WEB_UI_VERSION_VALUE).toBe("settings-web-ui-version-value");
  });

  it("ZCODE_VERSION 可解析（测试环境未注入 define，回退开发占位）", () => {
    // shared/src/version.ts 在非构建环境没有 __ZCODE_VERSION__，回退 "0.0.0-dev"。
    // 真实 web build 由 vite define 注入根 package.json 的 version。
    expect(typeof ZCODE_VERSION).toBe("string");
    expect(ZCODE_VERSION.length).toBeGreaterThan(0);
  });

  for (const { name, messages } of LOCALES) {
    describe(`${name}`, () => {
      it("版本行标签与说明 key 齐全", () => {
        expect(messages["settings.webUiVersion"], "标签缺失").toBeTruthy();
        expect(messages["settings.webUiVersionDescription"], "说明缺失").toBeTruthy();
      });

      // 措辞必须点名 Web UI：Agent 后端是官方闭源组件，版本线独立，
      // 只写「版本」会让排障时把两者混为一谈。
      it("标签点名 Web UI，不含糊为「版本」", () => {
        expect(messages["settings.webUiVersion"]).toMatch(/Web UI/i);
      });

      it("说明区分了 Web UI 与 Agent 后端", () => {
        const description = messages["settings.webUiVersionDescription"] ?? "";
        expect(description).toMatch(/Web UI/i);
        expect(description).toMatch(/Agent/i);
      });
    });
  }
});
