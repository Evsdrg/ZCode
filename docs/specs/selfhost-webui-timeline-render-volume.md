# 历史回合步骤聚合（可设置）

状态：已实施（本地构建与探针复测通过；线上需同步静态资源）
分支：`research/timeline-render-volume`（从 `selfhost/maintained` 分叉）
前置：`docs/specs/selfhost-webui-timeline-layout-thrash.md`（布局抖动，已修）

## 背景与实测

打开会话时主线程阻塞约 430–500ms，trace 显示 436ms 落在 React 调度器（一次性渲染量）。
DOM 从 1033 涨到 5311 节点 / 478 SVG，虚拟列表只挂载 9 行。

**单一行占全部节点的一半**：一个巨型回合有 2636 节点 / 177 个工作项，序列高度重复：

```text
▸ 终端  ▸ 思考  [助手文字]  ▸ 终端  ▸ 思考  [助手文字]  …（循环约 50 次）
```

- 116 个折叠触发器（52 终端 + 42 思考 + 编辑/写入/读取等），全部 `state=closed`，但触发器
  外壳（图标 SVG + 标签 + 摘要 + chevron + Radix 包裹，约 14 节点/项）全部渲染。
- 61 个助手文字行（完整展开）。
- 现有终端分组要求**相邻同类**才合并，被"思考/文字"隔断后每项都是孤立单个，从不触发。

## 产品规则

- **运行中回合与最后一段保持现状**：用户需要实时看到 AI 正在做什么、随时打断，不能折叠。
- **历史回合**（非运行中、非最后一段）的连续工具/思考步骤默认聚合为可展开的步骤组；
  助手文字行不参与聚合，仍逐行展示。
- 提供设置项让用户选择是否启用该聚合；关闭时回到当前逐项渲染的样式。
- 聚合只改变历史回合的展示，不改变数据、不改变会话查找、不改变滚动锚定语义。

## 所有者与接口

- 设置项 `historyStepsGroupingEnabled` 落在 `packages/shared` 的 app settings schema，
  经 `sharedSettings` → `SessionPane` → `ConversationRowRenderContext` 流到渲染层，
  与既有 `toolGrouping*Enabled` 同族。
- 渲染层在 `ConversationAssistantWorkItems` 内，按"非文本工作行连续段"切分：
  短段（≤ 阈值）保持逐项；长段折叠为一个步骤组触发器 + 按需展开的内容。

## 顺序与崩溃边界

```text
设置变更 → sharedSettings → SessionPane 读 → rowContext → 渲染层分段
折叠组触发器 → 展开才挂载组内项（与 reasoning 收起延迟卸载同族）
```

- 折叠不改变 `unit.assistantWorkRows` 数据，仅影响渲染。
- 会话查找只索引 `visibleUserInputs` + `assistantTextRows`，不含工具/思考行，
  因此折叠工具步骤不影响 Ctrl+F 命中。

## 验收

1. 打开巨型回合时 DOM 节点数与 React 渲染耗时显著下降（历史回合折叠生效）。
2. 运行中回合、最后一段、助手文字行行为不变；展开折叠组后内容与折叠前逐项一致。
3. 设置项开关即时生效，关闭后回到逐项渲染。
4. 会话查找（Ctrl+F）在折叠状态下仍能命中助手文字；滚动锚定、turn navigator 无回归。

验证：分段纯函数单测；`pnpm typecheck`、`pnpm lint`、架构检查、`@zcode/ui` 测试；
隔离代理 + 探针复测打开会话的 DOM 节点数与长任务。不得为验收重启 zcode-web-local 宿主。

## 实测结果（A/B，同一巨型回合）

| 指标 | 折叠前 | 折叠后 | 变化 |
| --- | --- | --- | --- |
| 总 DOM 节点 | 5310 | 2538 | −52% |
| SVG 图标 | 478 | 200 | −58% |
| 巨型行节点 | 2636 | 340 | −87% |
| 最长主线程任务 | 220ms | 129ms | −41% |

展开验证：点击折叠触发器后 DOM 恢复到 5060、巨型行恢复到 2636，与折叠前逐项一致。

## 实现说明

- 折叠阈值 `HISTORY_STEPS_COLLAPSE_MIN_STEPS = 12`（步骤行超过才折叠，正常回合不受影响）。
- 折叠态 = 助手文字行逐项 + 一个「N 个步骤」触发器；展开态渲染原始全序。
- 仅在非运行中回合启用（`!unit.isRunning` / `!stageTailIsRunning`）。
- 实测中该巨型回合走的是 `ConversationBackgroundResultWork` 的 `assistantHistoryRows`
  路径（`flex flex-col gap-2` 包裹），三处非 history 调用点均已接线。

