# Web 端补齐非 Electron 路径 + 任务完成经 Bot 推送

状态：已实施（构建与隔离实例验收通过；线上需同步静态资源并重启 Host）
分支：`selfhost/web-parity-bot-push`（从 `selfhost/maintained` 分叉）

## 背景

审计发现 WebUI 中三处"仅适用于 Electron"的功能在自部署 Web 模式下缺失或静默失效，
以及一个产品缺口：用户在 WebUI 发起任务后离开（无外部连接）时无法收到完成提醒。

## 一、通知权限从未请求（真实缺陷）

`packages/web/src/main.tsx` 的 `showTaskNotification` 只检查 `Notification.permission === "granted"`，
全仓无 `requestPermission` 调用，浏览器默认权限为 `"default"` → **任务通知永不触发**，
但设置页「任务通知」开关照常显示可点。

修复：
- 新增 `packages/web/src/webTaskNotification.ts` 纯模块封装展示逻辑（可单测）。
- `IPlatformService` 增加可选 `requestNotificationPermission()`；Web 实现，桌面端无需实现。
- 设置页开启「任务通知」时（天然用户手势）调用 `requestNotificationPermission`。
- `showTaskNotification` 在权限为 `default` 时尝试请求一次，本次不展示，授权后自然生效。

## 二、`<webview>` 裸调（纵深防御）

`BrowserViewportSurface.tsx` 直接渲染 Electron `<webview>` 及其专有方法，
未检查 `customElements.get("webview")`。虽然 Web 下 `supportsEmbeddedBrowser=false`
使该组件不挂载，但缺一层判定属于隐患。

修复：挂载前检查 `customElements.get("webview")` 是否存在，缺失时不渲染 guest。

## 三、`exportLogs` 导出日志（不改）

审计确认 `createHelpMenuActionHandlers(...).exportLogs` 在当前帮助菜单里**没有菜单项**
（`WorkspaceHelpMenuButton.tsx` 只挂了 `openProductDocs`/`openIssueReport` 等），属未接线的
死代码；Web 平台已返回明确错误。没有用户可见入口，**不新增 Host 导出能力**，
避免为不可达路径造设施。

## 四、任务完成经 Bot 推送（最终结论：根因是协议 schema 版本错配）

### 调研纠正

深入代码与实测后，原"缺口三"（Bot 新任务不订阅终态）**不成立**：

- `handleMessage` 的新任务路径**已调用** `watchTaskStream`（`botsService.ts:4936`），
  它就是终态回推订阅者；任务完成会 `sendOutbound` 摘要或兜底"任务已完成。"。
- Bot 轮询在自部署 server 上**是启动的**：`runStartupBackgroundTasks: !isDesktopAttachedRemote`
  （`node.ts:2499`），自部署 server 的 authority mode 为 `undefined` → 值为 true。

### 真实根因（有日志证据）

主实例日志出现"丢弃无效 ZCode Protocol session event"，被丢弃的 `turn.started`
其 `sessionId` **正是微信 Bot 任务**（`sess_1d8c90a7`），时间对齐（任务发出后 1 秒）：

```
type: 'turn.started'
message: 'Unrecognized key: "executionStartedAt"'
sessionId: 'sess_1d8c90a7-...'
```

`zcodeSessionEventSchema` 的 payload 是 `.strict()`，闭源 CLI v3.14.4 新增的字段
未被声明，导致**整条事件被丢弃**，该会话事件链断裂 → 终态回推失效。
同一原因还丢弃了 `tool.updated/started` 的 `readOnly`/`sideEffectScope`。

仓库的 `apps/zcode-cli/packages/contracts` 里这两个字段**已定义**（官方已加），
只是 `packages/shared` 的协议 schema 未同步。

### 修复

在 `packages/shared/src/zcode-protocol/index.ts` 补齐两个 payload 的字段声明：

- `zcodeTurnStartedEventPayloadSchema` 增加 `executionStartedAt: z.number().optional()`。
- `zcodeToolUpdatedEventPayloadSchema` 的 `kind: "started"` 增加
  `readOnly: z.boolean().optional()` 与 `sideEffectScope: z.enum(["none","workspace","git"]).optional()`。

新增回归测试 `packages/services/src/zcode-agent/sessionEventSchemaCompat.test.ts`。

### 回退的改动

放开 Telegram/Webhook 作回推目标**已回退**：闭源 CLI 自身用 schema `Wpe` 校验
`botDeliveryTarget`，其 provider 枚举硬编码 `["feishu","lark","weixin"]`，发
`webhook`/`telegram` 会被 CLI 拒绝（`proto.invalidPayload`）并使整个任务失败。
该配额由闭源 CLI 决定，本仓库无法放开。

### 未处理（需单独决策）

自部署 server **无 cron 调度器**（只在 Electron 主进程启动），定时/自动化任务
不会派发。这与本次"Bot 任务完成回推"是两件事，另行评估。

## 验收

1. Web 端开启「任务通知」后浏览器弹权限框；授权后任务完成能弹通知。
2. Web 端无 `<webview>` 相关报错；缺失标签时不挂载 guest。
3. 会话事件 schema 接受闭源 CLI 的 `executionStartedAt` / `readOnly` / `sideEffectScope`，
   不再丢弃 `turn.started` / `tool.updated`；Bot 任务完成回推恢复。
4. 桌面路径行为不变。

验证：`pnpm typecheck`、`pnpm lint`、架构检查、目标包测试、schema 兼容回归测试。
不得为验收重启 zcode-web-local 宿主。
