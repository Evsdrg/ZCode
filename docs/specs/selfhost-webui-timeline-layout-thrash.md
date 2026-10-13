# 时间线打开会话的布局抖动修复

状态：已实施（本地构建与探针复测通过；线上需同步静态资源）
适用：`packages/ui/src/v4/ConversationTimeline.tsx` 的消息层 mask 与 turn navigator 视口同步。

## 背景与实测

2026-10-12 实测（隔离代理 + 注入探针 + Chrome trace）显示：空闲、滚动、流式输出都不卡，
**只有打开/切换会话时主线程被阻塞 242–566ms（最长 428ms）**，最大帧间隔 217–450ms。
同期 WS 帧派发合计仅 23–25ms，说明瓶颈不在传输，而在 React commit 阶段的强制同步布局：
一次打开的 `Blink.ForcedStyleAndLayout` 触发 7205 次 / 211ms，布局读取 API 合计 1527 次。

## 根因

`syncTurnNavigatorViewport` 的调用顺序是「先写后读」：

1. 先调 `syncMessageLayerMask`，它**写** `messageLayer.style.maskImage/maskPosition/maskSize`；
2. 紧接着**读** `element.getBoundingClientRect()`，并对每个 `[data-row-id]` 逐个读 rect。

写入使样式失效，随后的读强制同步重排（layout thrashing）。该方法被高频路径调用：
`handleScroll`（每次 scroll）、内容变化 layout effect（`rowCount`/`totalSize` 每次变化）、
`scrollToBottom`、恢复滚动记忆、turn navigator 定位、前插补偿。

会话打开时时间线处于 `following`（贴底），mask 恒为 `none`，但每次调用仍重复写同样的
`maskImage="none"`，把样式标脏，再被紧接着的 rect 读取强制重排——这是打开会话卡顿的主因。

## 修复

保持 mask 最终状态与 turn navigator 语义不变，只改读写顺序与冗余写入：

1. **读阶段先行**：`syncTurnNavigatorViewport` 先完成全部布局读取（scrollTop/clientHeight/
   scrollHeight、容器与行 rect），再应用 mask 样式。
2. **跳过冗余写入**：mask 计算值（含贴底时仅 `maskImage/webkitMaskImage = "none"`）与上次
   实际写入一致时不写，避免把样式标脏。贴底时不触碰 `maskPosition/maskSize`，与既有行为一致。
3. mask 计算抽为纯函数，写入集中在读阶段之后，便于单测覆盖。

不改动：滚动锚定状态机、`following` 判定、虚拟化配置、`headerSlotHeight` 反馈环、
`shouldAdjustScrollPositionOnItemSizeChange` 语义。

## 验收

1. 打开/切换会话时 `Blink.ForcedStyleAndLayout` 次数与主线程长任务显著下降，无新的长任务。
2. 贴底跟随、离底遮罩淡出、turn navigator active 高亮、滚动记忆恢复行为不变。
3. 空闲/滚动/流式路径无回归。

验证：`ConversationTimeline` mask 纯函数单测；`pnpm typecheck`、`pnpm lint`、架构检查与
`@zcode/ui` 测试；隔离代理 + 探针复测打开会话的长任务与强制布局计数。不得为验收重启
zcode-web-local 宿主。
