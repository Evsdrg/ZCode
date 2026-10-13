# 时间线打开会话渲染量研究（进行中）

状态：研究中。分支 `research/timeline-render-volume`，从 `selfhost/maintained` 分叉。
上一轮已修复布局抖动（`docs/specs/selfhost-webui-timeline-layout-thrash.md`），但打开会话的整体卡顿仍在。

## 已确认的瓶颈

打开会话时主线程被阻塞约 430–500ms，trace 显示其中 **436ms 落在 React 调度器
（workLoop）**，即一次性渲染的组件量，而非布局抖动。

DOM 规模实测（打开 `LLM技术演进调研` 会话，虚拟列表只挂载 9 行）：

| 指标 | 打开前 | 打开后 |
| --- | --- | --- |
| DOM 节点 | 1033 | **5311** |
| SVG | — | **478** |
| button | — | 230 |
| `<code>` | — | 94 |

**单一行占了全部节点的一半**：第 8 行（"批量抓取缺失的37篇论文"终端工具输出）有
**2636 节点 / 240 SVG**，其余 8 行合计约 1400 节点。

该行内部构成：

- **116 个 `chevron-right`**：可折叠触发器
- **42 个 `brain`**：思考区块图标，按钮文本均为"思考 · 持续了几秒"
- **52 个 `square-terminal`**：终端工具调用图标
- 65 个 `<code>` 块、71 个 button

即一个助手回合里约 58 个"思考/工具"区块，每个都渲染触发器（图标 + chevron + 文本）。

## 已排除的项

- **reasoning 收起态不渲染正文**：`reasoning.tsx:117` 的 `shouldRenderContent` 初值为
  `isOpen`，收起时不挂载 children（且 Radix 收起动画后延迟卸载）。所以 42 个 brain 只是触发器。
- **布局抖动**：上一轮已修，强制布局尖峰从 89.5ms 收敛到 32–38ms；本轮 trace 中
  `Layout`/`Paint` 占比很小，不是本轮主因。
- **WS 传输**：单次打开 1.4–1.9MB，但派发仅 23–25ms。

## 待验证的优化方向

1. **工具调用/思考触发器复用**：同一回合内 116 个 chevron、42 个 brain、52 个 terminal
   图标是重复的独立组件实例。可考虑共享图标组件或用 CSS/SVG sprite 减少节点。
2. **单回合内的区块默认折叠**：58 个区块的触发器本身就要 58 个按钮 + 图标；若历史回合默认
   折叠成"N 个步骤"聚合行，可大幅减少首屏节点。
3. **巨型工具输出分页/截断**：那一行的 65 个 code 块来自一次终端命令的完整输出；首屏可只渲染
   头部若干行，其余按需展开。
4. **首屏分批渲染**：先渲染最近若干行纯文本，稳定后再补工具卡片与高亮。

## 复现方法

同 `webui-perf-measured-hotspot` 记忆：`/tmp/perf-proxy.mjs` 起本地静态 + `/api` + `/ws`
反代（上游必须写 `10.126.126.42:3030`），`AGENT_BROWSER_INIT_SCRIPTS` 注入 `/tmp/perf-probe.js`；
打开 `LLM技术演进调研` 会话（sidebar 里 innerText 最短的匹配项），用 `document.querySelectorAll`
统计节点分布。
