import { describe, expect, it } from "vitest";
import {
  COMPOSER_MESSAGE_MASK_FADE_PX,
  COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
  applyMessageLayerMaskStyle,
  computeMessageLayerMask,
} from "./messageLayerMask.js";

const base = { viewportHeight: 600, messageLayerOffsetTop: 0 };

describe("computeMessageLayerMask", () => {
  it("贴底时只返回 maskImage 的 none，不触碰对齐/尺寸", () => {
    const style = computeMessageLayerMask({
      ...base,
      scrollTop: 400,
      contentHeight: 1000, // 1000 - 600 - 400 = 0 → 贴底
    });
    expect(style).toEqual({ maskImage: "none", webkitMaskImage: "none" });
    expect(style.maskPosition).toBeUndefined();
    expect(style.maskSize).toBeUndefined();
  });

  it("离底时给出渐变与对齐值", () => {
    const style = computeMessageLayerMask({
      ...base,
      scrollTop: 0,
      contentHeight: 5000,
    });
    const transparentStart = 600 - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX;
    const opaqueEnd = transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX;
    expect(style.maskImage).toBe(
      `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`,
    );
    expect(style.maskPosition).toBe("0 0px");
    expect(style.maskSize).toBe("100% 600px");
  });

  it("离底且已滚动时 maskPosition 对齐到视口顶部", () => {
    const style = computeMessageLayerMask({
      ...base,
      scrollTop: 250,
      contentHeight: 5000,
    });
    expect(style.maskPosition).toBe("0 250px");
  });

  it("messageLayer 偏移大于 scrollTop 时钳到 0", () => {
    const style = computeMessageLayerMask({
      ...base,
      messageLayerOffsetTop: 400,
      scrollTop: 100,
      contentHeight: 5000,
    });
    expect(style.maskPosition).toBe("0 0px");
  });

  it("视口很矮时透明起点与渐变终点不为负", () => {
    const style = computeMessageLayerMask({
      viewportHeight: 40,
      messageLayerOffsetTop: 0,
      scrollTop: 0,
      contentHeight: 5000,
    });
    expect(style.maskSize).toBe("100% 40px");
    expect(style.maskImage).toContain("black 0px");
    expect(style.maskImage).not.toContain("black -");
  });
});

/** 记录写入次数的假 CSSStyleDeclaration。 */
function createStyleDouble(initial: Record<string, string> = {}) {
  const writes: string[] = [];
  const store: Record<string, string> = { maskImage: "", webkitMaskImage: "", ...initial };
  const style = new Proxy(store, {
    set(target, prop, value) {
      writes.push(String(prop));
      target[prop as string] = String(value);
      return true;
    },
  }) as unknown as CSSStyleDeclaration;
  return { style, writes };
}

describe("applyMessageLayerMaskStyle", () => {
  it("值相同不写，避免把样式标脏", () => {
    const { style, writes } = createStyleDouble({ maskImage: "none", webkitMaskImage: "none" });
    applyMessageLayerMaskStyle(style, { maskImage: "none", webkitMaskImage: "none" });
    expect(writes).toEqual([]);
  });

  it("贴底态不写对齐/尺寸字段", () => {
    const { style, writes } = createStyleDouble({
      maskImage: "linear-gradient(x)",
      webkitMaskImage: "linear-gradient(x)",
    });
    applyMessageLayerMaskStyle(style, { maskImage: "none", webkitMaskImage: "none" });
    expect(writes).toEqual(["maskImage", "webkitMaskImage"]);
  });

  it("离底态写入全部字段", () => {
    const { style, writes } = createStyleDouble();
    applyMessageLayerMaskStyle(style, {
      maskImage: "g",
      webkitMaskImage: "g",
      maskPosition: "0 10px",
      webkitMaskPosition: "0 10px",
      maskSize: "100% 600px",
      webkitMaskSize: "100% 600px",
    });
    expect(writes.sort()).toEqual(
      [
        "maskImage",
        "maskPosition",
        "maskSize",
        "webkitMaskImage",
        "webkitMaskPosition",
        "webkitMaskSize",
      ].sort(),
    );
  });
});
