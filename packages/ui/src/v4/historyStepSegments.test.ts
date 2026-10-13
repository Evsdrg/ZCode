import { describe, expect, it } from "vitest";
import {
  HISTORY_STEPS_COLLAPSE_MIN_STEPS,
  planHistoryStepCollapse,
} from "./historyStepSegments.js";

type Item = { id: string; step: boolean };

const step = (id: string): Item => ({ id, step: true });
const text = (id: string): Item => ({ id, step: false });
const isStep = (item: Item) => item.step;

describe("planHistoryStepCollapse", () => {
  it("步骤数不超过阈值时不折叠", () => {
    const items = [...Array.from({ length: 5 }, (_, i) => step(`s${i}`)), text("t0")];
    const plan = planHistoryStepCollapse(items, isStep);
    expect(plan.kind).toBe("unchanged");
  });

  it("步骤数超过阈值时折叠，只保留文字行可见", () => {
    const items = [
      step("s0"),
      text("t0"),
      ...Array.from({ length: 20 }, (_, i) => step(`s${i + 1}`)),
      text("t1"),
      step("s21"),
    ];
    const plan = planHistoryStepCollapse(items, isStep);
    expect(plan.kind).toBe("collapsed");
    if (plan.kind !== "collapsed") return;
    expect(plan.collapsedCount).toBe(22);
    expect(plan.visibleItems).toEqual([text("t0"), text("t1")]);
  });

  it("阈值可配置", () => {
    const items = [step("a"), step("b"), step("c"), text("t")];
    expect(planHistoryStepCollapse(items, isStep, { minSteps: 2 }).kind).toBe("collapsed");
    expect(planHistoryStepCollapse(items, isStep, { minSteps: 3 }).kind).toBe("unchanged");
  });

  it("enabled 为 false 时不折叠", () => {
    const items = Array.from({ length: 50 }, (_, i) => step(`s${i}`));
    expect(planHistoryStepCollapse(items, isStep, { enabled: false }).kind).toBe("unchanged");
  });

  it("全是文字行时保持原样", () => {
    const items = Array.from({ length: 50 }, (_, i) => text(`t${i}`));
    expect(planHistoryStepCollapse(items, isStep).kind).toBe("unchanged");
  });

  it("恰好等于阈值时不折叠", () => {
    const items = Array.from({ length: HISTORY_STEPS_COLLAPSE_MIN_STEPS }, (_, i) => step(`s${i}`));
    expect(planHistoryStepCollapse(items, isStep).kind).toBe("unchanged");
  });
});
