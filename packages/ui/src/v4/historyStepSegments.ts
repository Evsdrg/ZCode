/**
 * 历史回合步骤聚合的纯逻辑。
 *
 * 背景：一个巨型历史回合可能有上百个工作项，序列高度重复
 * （`终端 → 思考 → 助手文字 → 终端 → …`）。现有 terminal/explore 分组要求相邻同类，
 * 被思考/文字隔断后每项都是孤立单个，从不触发，于是上百个触发器全部渲染。
 *
 * 规则：
 * - **助手文字行始终逐项展示**：它是用户读结论的锚点，且会话查找只索引文字行。
 * - **步骤行**（工具/思考/子代理等）在总数超过阈值时折叠为一个可展开的步骤组。
 * - 展开态渲染**原始全序**，保证与关闭该特性时逐项一致。
 *
 * 只影响渲染，不改变数据、会话查找或滚动锚定语义。
 */

/** 步骤行总数超过它才折叠，避免正常回合被改动。 */
export const HISTORY_STEPS_COLLAPSE_MIN_STEPS = 12;

export type HistoryStepPlan<T> =
  | { kind: "unchanged" }
  | {
      kind: "collapsed";
      /** 折叠态仍逐项渲染的项（文字行，按原序）。 */
      visibleItems: readonly T[];
      /** 折叠进步骤组的步骤数。 */
      collapsedCount: number;
    };

/**
 * 计算历史回合的折叠布局。
 *
 * `isStepItem` 判定步骤行。返回 `unchanged` 时调用方按原样渲染全部项。
 */
export function planHistoryStepCollapse<T>(
  items: readonly T[],
  isStepItem: (item: T) => boolean,
  options?: { minSteps?: number; enabled?: boolean },
): HistoryStepPlan<T> {
  const enabled = options?.enabled ?? true;
  const minSteps = options?.minSteps ?? HISTORY_STEPS_COLLAPSE_MIN_STEPS;
  if (!enabled) return { kind: "unchanged" };

  let stepCount = 0;
  for (const item of items) {
    if (isStepItem(item)) stepCount += 1;
  }
  if (stepCount <= minSteps) return { kind: "unchanged" };

  const visibleItems = items.filter((item) => !isStepItem(item));
  return { kind: "collapsed", visibleItems, collapsedCount: stepCount };
}
