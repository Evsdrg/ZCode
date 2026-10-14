# 自部署 server 的定时任务调度

状态：已实施
适用：`packages/server` 的 `entry-http`（自部署 WebUI 后端）。桌面 Host、远端工作区、移动 relay 的既有派发语义不变。

## 背景与问题

定时任务（automation）与闲时任务（off-peak）的派发链在桌面形态下是这样分层的：

```text
scheduler 进程 --cron-dispatch-request--> desktop main --HostMessageTypes.CronRun--> Desktop Host
                                                                                     └─ dispatchCronRun() → createTask/sendPrompt
```

其中「scheduler 进程」只由 Electron main 通过 `electronUtilityProcess.fork` 拉起
（`packages/desktop/src/main/desktopCronScheduler.ts:61`，唯一调用点在 `main/index.ts:1965`）。
自部署 server 走 `createLocalServices` 装配，没有 utilityProcess、没有 main 的消息转发，也没有
`dispatchCronRun` 的本地等价物。结果是：

- WebUI 能创建 automation、能点「立即运行」，但没有任何组件轮询 `automations` 表，
  到期行永远不被认领、不派发。
- 「立即运行」依赖注入的 `onAutomationManualRunRequested`；server 装配未传该 option，
  `zcodeAgentService.runAutomationNow` 直接抛 `Automation immediate dispatcher is unavailable.`。
- off-peak 同样经 scheduler 的 `offpeak-dispatch-request` 派发，同样全断。

当前 C 端损失为零（`automations`/`off_peak_tasks`/`automation_runs` 三表均为 0），但 WebUI 里
这两片 UI 完整可交互，存在「看得见、点了没用」的预期违背。

## 产品规则

- 自部署 server 必须在**本进程内**承担 scheduler 的职责：轮询 `tasks-index.sqlite` 的
  `automations`、`automation_runs`(manual)、`off_peak_tasks`，事务认领到期项，并直接派发给
  本进程的 `IZCodeTaskService`。
- 语义与桌面 scheduler 对齐：20s 轮询；misfire 5 分钟宽限；一次性任务错过即终态；失败按
  transient/permanent 分流退避；manual run 受 single-flight claim 保护。
- 派发用 `clientMode: "web-remote-replayable"`：自部署 server 是常驻后端，没有桌面那种
  MessagePort 连续投递通道，投递档位必须是可重放快照语义。
- 「立即运行」在 server 形态下可用：`runAutomationNow` 走注入的本地派发器，不依赖 scheduler 进程。
- 不改闭源 CLI、不改 V4 帧格式、不新增对外 HTTP 路由。

## 所有者与接口

- **表所有者不变**：`AutomationRepo` / `OffPeakTaskRepo`（`packages/services/src/session/`）仍是
  `tasks-index.sqlite` 的唯一属主。认领靠 `BEGIN IMMEDIATE` 事务，天然跨进程互斥——即便桌面
  与 server 同时运行共库，也不会重复派发。
- **新增调度器**：`packages/services/src/session/automationScheduler.ts`，构造参数显式注入
  `{ automationRepo, offPeakRepo?, dispatchAutomation, dispatchOffPeak?, logger, clientMode, now? }`。
  它只做「轮询 + 认领 + 组装请求 + 结算」，不碰 UI / agent runtime。派发函数是注入的端口，
  由 host 域（desktop）或 server 域（`entry-http`）提供。
- **新增共享派发核心**：把桌面 host 现有的纯逻辑模块下沉到
  `packages/services/src/session/`，桌面侧改为 re-export，避免双份实现漂移：
  - `automationRunLifecycle.ts` ← `desktop/src/host/cronRunLifecycle.ts`（纯逻辑，无 Electron 依赖）
  - `automationSubmissionModelSelection.ts` ← `desktop/src/host/automationModelSelection.ts`
  - `automationBotDelivery.ts` ← `desktop/src/host/cronBotDelivery.ts`
  - `offPeakDispatchPlan.ts` ← `desktop/src/host/offPeakDispatchPlan.ts`
- **server 侧派发器**：`packages/server/src/automationDispatch.ts`，实现
  `dispatchAutomation(request)` / `dispatchOffPeak(request)`，直接取本进程
  `IZCodeTaskService`/`IBotsService`/`IModelSelectionService`，复用上述共享核心。它取代桌面的
  `dispatchCronRun`，但语义等价（模型身份固定、bot 订阅先于 prompt、终态订阅、未读标记）。

## 顺序与崩溃边界

```text
server 启动 → createLocalServices → 起 AutomationScheduler(20s)
                ↓ tick
        automationRepo.claimDue/claimManualRuns/offPeakRepo.claimDue   （BEGIN IMMEDIATE 认领）
                ↓ 组装 request
        dispatchAutomation → resolveSubmissionModelSelection（固定 run 级选择）
                ↓ 先订阅
        watchAutomationRun（bot 终态回推）+ onDynamicTaskTerminalOutcome（run 结算）
                ↓ 再派发
        createTask/resumeTask → sendPrompt(clientMode=web-remote-replayable)
                ↓ 终态
        markRunOutcome / markDispatched / releaseManualClaim
```

- **认领先于派发**：run 台账 `claimed` 先落库再派发；派发失败走 `markDispatchFailed`。
- **订阅先于 prompt**：bot 订阅与终态订阅在 `sendPrompt` 之前完成，避免快速任务先完成、
  后注册 listener 而漏回推/漏结算。
- **幂等**：所有结算用 `run_id` 为主键的 upsert；`markTerminal`/`markRunning` 对非 queued 行
  返回 false 时丢弃迟到回写。
- **崩溃恢复**：认领有 `CLAIM_STALE_MS` 兜底；server 重启时把残留 `running` 的 off-peak 置回
  `queued`（`recoverInterrupted`），与桌面 scheduler 启动同款。
- **退出**：SIGTERM 走既有 `disposeServiceResourcesAndWait`，scheduler 先停轮询、释放在途认领、
  关库。

## 安全与失败

- 派发只在 server 本进程内进行，不引入回环 RPC 或跨进程信任边界。
- 与桌面共库时靠 sqlite 事务互斥，不需要额外选主；同时运行只会多耗一次空轮询。
- 模型/凭证类确定性错误按 permanent 落库，不无限退避。
- 日志用 `createServiceLogger("automation-scheduler")`，`info` 记生命周期与结算，`warn` 记可恢复
  失败，不写凭据。

## 验收

1. WebUI 新建一条 `* * * * *`（每分钟）automation：一分钟后 `automation_runs` 出现一条
   `trigger=schedule` 且 `dispatch_status=dispatched`，对应 task 被创建且收到 prompt。
2. WebUI 点「立即运行」：`automation_runs` 出现 `trigger=manual` 行，任务实际执行；
   连点第二次返回 `duplicate`，不产生第二条 run。
3. 配了 bot 回推的 automation 完成后，bot 收到终态推送（复用上一轮修复的
   `executionStartedAt`/`readOnly` schema 链路）。
4. 停 server 期间错过窗口的任务，重启后按 misfire 记 skipped 不补跑；一次性任务终态化。
5. server 与桌面同时运行时，同一条 automation 只被派发一次。
6. 桌面形态行为不变：`desktopCronScheduler` 仍经 utilityProcess + CronRun 派发，共享模块
   re-export 后所有桌面路径的单测仍通过。

验证：`packages/services` 新增 scheduler 纯逻辑单测；`packages/server` 派发器单测（用临时
`ZCODE_DATA_BASE_DIR` + 隔离 sqlite）；执行 `pnpm typecheck`、`pnpm lint`、架构检查。
不得为验收重启 `zcode-web-local` 宿主；隔离实例副本必须去掉 `credentials.json`。
