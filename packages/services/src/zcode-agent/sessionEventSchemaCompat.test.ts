/**
 * 回归：会话事件 schema 必须容忍闭源 CLI 随版本新增的可选字段。
 *
 * `zcodeSessionEventSchema` 的 payload 是 `.strict()`，缺声明的字段会让**整条事件**
 * 被判为无效并丢弃（见 zcodeAgentService 的"丢弃无效 ZCode Protocol session event"）。
 * 实测 v3.14.4 的 `turn.started` 带 `executionStartedAt`、`tool.updated/started` 带
 * `readOnly`/`sideEffectScope`，旧 schema 会丢弃它们，导致该会话事件链断裂、
 * Bot 终态回推失效。此处锁定这两个字段已被接受。
 */
import { describe, expect, it } from "vitest";
import { zcodeSessionEventSchema } from "@zcode/shared";

const env = (type: string, payload: unknown) => ({
  type,
  eventId: "e1",
  sessionId: "s1",
  seq: 1,
  traceId: "t1",
  timestamp: Date.now(),
  payload,
});

describe("session event schema 兼容闭源 CLI 新字段", () => {
  it("turn.started 接受 executionStartedAt", () => {
    const r = zcodeSessionEventSchema.safeParse(
      env("turn.started", { turnNumber: 0, input: "hi", executionStartedAt: 1791961000000 }),
    );
    expect(r.success, JSON.stringify(r.success ? "" : r.error.issues)).toBe(true);
  });

  it("tool.updated started 接受 readOnly/sideEffectScope", () => {
    const r = zcodeSessionEventSchema.safeParse(
      env("tool.updated", {
        kind: "started",
        toolCallId: "tc1",
        startedAt: new Date().toISOString(),
        readOnly: true,
        sideEffectScope: "none",
      }),
    );
    expect(r.success, JSON.stringify(r.success ? "" : r.error.issues)).toBe(true);
  });
});
