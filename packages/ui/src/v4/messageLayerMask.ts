/**
 * 消息层 mask 的纯计算。
 *
 * 从 `ConversationTimeline` 抽出，让「读布局 → 算值 → 写样式」三段可分离：
 * 组件先完成所有布局读取，再用这里的纯函数算目标值，最后统一写入。
 * 旧实现把写入夹在两次读取之间，导致每次调用都强制一次同步重排。
 */

/** 与滚动容差同源的贴底判定，避免组件与纯函数各持一份 epsilon。 */
const BOTTOM_ANCHOR_EPSILON_PX = 1;

export interface MessageLayerMaskMetrics {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  /** 消息层相对滚动容器的偏移（`messageLayer.offsetTop`）。 */
  messageLayerOffsetTop: number;
}

/** 遮罩底部透明区高度（px）：dock 的透明 padding 需要消息从这里淡出。 */
export const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
/** 透明区之上的渐变过渡高度（px）。 */
export const COMPOSER_MESSAGE_MASK_FADE_PX = 24;

/**
 * 目标样式值。贴底时只含两个 `none`；离底时含渐变与对齐/尺寸。
 * 可选字段缺席表示「该态不触碰此属性」，写入端据此跳过，避免无谓标脏。
 */
export interface MessageLayerMaskStyle {
  maskImage: string;
  webkitMaskImage: string;
  maskPosition?: string;
  webkitMaskPosition?: string;
  maskSize?: string;
  webkitMaskSize?: string;
}

function isAtBottom(metrics: MessageLayerMaskMetrics): boolean {
  const distance = metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop;
  return distance <= BOTTOM_ANCHOR_EPSILON_PX;
}

export function computeMessageLayerMask(metrics: MessageLayerMaskMetrics): MessageLayerMaskStyle {
  if (isAtBottom(metrics)) {
    // 贴底时消息位于正常文档流末尾，不会经过 sticky composer；保留 mask 只会
    // 无意义地淡出最后一条消息，只有离底滚动时才需要遮罩。
    return { maskImage: "none", webkitMaskImage: "none" };
  }
  const transparentStart = Math.max(
    0,
    metrics.viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
  );
  const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
  const viewportTopInLayer = Math.max(0, metrics.scrollTop - metrics.messageLayerOffsetTop);
  const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;
  return {
    maskImage,
    webkitMaskImage: maskImage,
    maskPosition: `0 ${viewportTopInLayer}px`,
    webkitMaskPosition: `0 ${viewportTopInLayer}px`,
    maskSize: `100% ${metrics.viewportHeight}px`,
    webkitMaskSize: `100% ${metrics.viewportHeight}px`,
  };
}

/** 把样式值写到元素上；逐字段比对，值相同不写，避免把样式标脏。 */
export function applyMessageLayerMaskStyle(
  target: CSSStyleDeclaration,
  style: MessageLayerMaskStyle,
): void {
  if (target.maskImage !== style.maskImage) target.maskImage = style.maskImage;
  if (target.webkitMaskImage !== style.webkitMaskImage) {
    target.webkitMaskImage = style.webkitMaskImage;
  }
  if (style.maskPosition !== undefined && target.maskPosition !== style.maskPosition) {
    target.maskPosition = style.maskPosition;
  }
  if (style.webkitMaskPosition !== undefined && target.webkitMaskPosition !== style.webkitMaskPosition) {
    target.webkitMaskPosition = style.webkitMaskPosition;
  }
  if (style.maskSize !== undefined && target.maskSize !== style.maskSize) {
    target.maskSize = style.maskSize;
  }
  if (style.webkitMaskSize !== undefined && target.webkitMaskSize !== style.webkitMaskSize) {
    target.webkitMaskSize = style.webkitMaskSize;
  }
}
