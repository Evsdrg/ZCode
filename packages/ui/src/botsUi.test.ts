import { describe, expect, it } from "vitest";
import {
  BOT_PROVIDERS,
  buildCurrentWorkspaceId,
  getBotProviderRegionTagLabelId,
  getBotReplyGranularitiesForProvider,
  resolveBotProviderEntry,
  type BotProviderEntryId,
} from "@/botsUi.js";

// 锁定「微信 / 飞书 / Lark / Telegram 属于 bot，不属于远控」这一术语边界。
// 用户澄清后写入 docs/specs/selfhost-browser-capability-gates.md：
// 远控是「直接访问一个 webUI」的专门通道，而 webRemoteControl.botChannel.*
// 下的四个渠道全部是 bot。这四条断言是那次澄清的回归保护——
// 若将来有人把某个渠道从 BOT_PROVIDERS 移走，说明它被当成了远控入口。
describe("botsUi provider 目录", () => {
  const REMOTE_CONTROL_CHANNELS: BotProviderEntryId[] = ["weixin", "feishu", "lark", "telegram"];

  it("远控弹层列出的四个渠道都在 bot provider 目录中", () => {
    const providerIds = BOT_PROVIDERS.map((entry) => entry.id);
    for (const provider of REMOTE_CONTROL_CHANNELS) {
      expect(providerIds, `${provider} 应仍是 bot provider`).toContain(provider);
    }
  });

  it("四个渠道均为已实现状态（可在自部署浏览器形态配置）", () => {
    for (const provider of REMOTE_CONTROL_CHANNELS) {
      const entry = BOT_PROVIDERS.find((candidate) => candidate.id === provider);
      expect(entry, `${provider} 应存在于目录`).toBeDefined();
      expect(entry?.implemented, `${provider} 应已实现`).toBe(true);
    }
  });

  it("未实现的渠道被明确标记，不会伪装成可用入口", () => {
    const unimplemented = BOT_PROVIDERS.filter((entry) => !entry.implemented).map(
      (entry) => entry.id,
    );
    expect(unimplemented).toEqual(["dingding", "discord", "wecom"]);
  });
});

describe("botsUi region tag", () => {
  it("lark 与 feishu 带区域标签", () => {
    expect(getBotProviderRegionTagLabelId("lark")).toBe("login.oauth.regionTag.zai");
    expect(getBotProviderRegionTagLabelId("feishu")).toBe("login.oauth.regionTag.bigmodel");
  });

  it("其余渠道不带区域标签", () => {
    for (const provider of ["weixin", "telegram", "webhook"] as const) {
      expect(getBotProviderRegionTagLabelId(provider)).toBeNull();
    }
  });
});

describe("resolveBotProviderEntry", () => {
  const bots = [
    { id: "bot-1", provider: "telegram" },
    { id: "bot-2", provider: "feishu" },
  ] as Parameters<typeof resolveBotProviderEntry>[0];

  it("已存在该 provider 的 bot 时选中它", () => {
    expect(resolveBotProviderEntry(bots, "feishu")).toEqual({
      mode: "select",
      botId: "bot-2",
    });
  });

  it("不存在时走创建路径", () => {
    expect(resolveBotProviderEntry(bots, "weixin")).toEqual({
      mode: "create",
      provider: "weixin",
    });
  });
});

describe("getBotReplyGranularitiesForProvider", () => {
  it("只返回该 provider 支持的颗粒度", () => {
    const granularities = getBotReplyGranularitiesForProvider("telegram");
    expect(granularities.length).toBeGreaterThan(0);
    for (const granularity of granularities) {
      expect(granularity.labelId.startsWith("bots.replyGranularity.")).toBe(true);
    }
  });
});

describe("buildCurrentWorkspaceId", () => {
  it("identity 优先，与 workspaceIdentity ?? workspacePath 的规则一致", () => {
    expect(buildCurrentWorkspaceId("/repo", "id-1")).toBe("id-1");
    expect(buildCurrentWorkspaceId("/repo")).toBe("/repo");
    // 空白 identity 视作未提供，避免把空串当成稳定 key。
    expect(buildCurrentWorkspaceId("/repo", "   ")).toBe("/repo");
  });
});
