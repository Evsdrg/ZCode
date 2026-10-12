# 自部署 WebUI 前台/后台投递流控

状态：已实施（本地构建与隔离验收通过；线上需同步静态资源并重启Host生效）
适用：自部署 entry-http 的浏览器 `/ws` 链路。桌面 MessagePort 路径、远端工作区、移动 relay 的既有语义不变。

## 背景与问题

浏览器 → edge-proxy → SSH 隧道 → 本机 Host → stdio → 闭源 CLI。浏览器关闭时，Host 的
`socket.onClose` 会 `dispose()` 连接 scope，向 CLI 发送 `closed` 并退订，投递自然停止；
重连只取尾部快照。但“页面仍打开、用户已离开”（切标签、锁屏、切后台）时 `/ws` 不断，
订阅持续有效，CLI 会持续把会话增量帧推过隧道，白耗流量。

闭源 CLI 已实现连接级流控 `v4/connection/flow`（`saturated`/`drained`/`closed`）：
`saturated` 加入 `pausedConnections` 并清 flush 定时器，之后 `scheduleFlush`/`flushIndex`/
`flushConfig` 全部跳过该连接；`drained` 恢复并 flush。桌面端经 MessagePort sideband 驱动它，
浏览器链路从未接线。

## 产品规则

- 浏览器页面转为隐藏（`document.visibilityState === "hidden"`）时，把**本连接**置为
  `saturated`；恢复可见时置回 `drained`。
- 只影响投递调度，不改变订阅语义：订阅仍在，`hasSubscribers` 为真，resident 回收判定不会
  因隐藏而回收会话；正在跑的轮次不受影响。
- 隐藏期间 CLI 侧订阅缓冲有界（`subscriberBufferMaxOps=500`/`subscriberBufferMaxBytes=1MiB`）；
  溢出后退化为快照，恢复时只拿尾部窗口（`snapshotTailWindowRows=60`），即“只看结果”。
- 客户端只能上报 `saturated`/`drained`，不能上报 `closed`（生命周期归连接所有权）。方法始终
  作用于调用者自己的连接，不接受 connectionId。
- 不新增 HTTP 路由、不改闭源 CLI、不动 V4 帧格式。

## 所有者与接口

- 连接 scope（`createZCodeAgentConnectionScope`）是流控唯一所有者；`setTransportFlowState`
  已存在并驱动 CLI。
- `IZCodeAgentService` 增加 `setClientFlowStateV4(params)`：params 仅
  `{ state: "saturated" | "drained" }`，运行时 zod 校验。
- scope 覆写把该调用转成 `enqueueTransportFlowState(state)`，与 `dispose()` 的 `closed` 走同一条
  串行链，保证 SAT→DRN→closed 提交顺序。
- base 实现（未经 scope 的直连）抛 `fault.connection.flowControlScopeRequired`，避免绕过
  per-connection 所有权。
- 浏览器经既有 `zcode-agent` channel 调用；`packages/web` 在 `visibilitychange` 上驱动，桌面不
  接线（桌面已有 sideband）。

## 顺序与崩溃边界

```text
页面隐藏 → setClientFlowStateV4(saturated) → scope 存 currentTransportFlowState
                                              ↓ 每个 owned route 转发 SAT
                                           CLI pausedConnections（跳过打帧）
页面可见 → setClientFlowStateV4(drained)   → 转发 DRN → CLI flushConnection（溢出则快照）
连接关闭 → dispose() → closed（清定时器/附件，退订）
```

- 订阅建立晚于 SAT：`rememberAfterSubscribe` 的 `syncCurrentFlowForEntry` 会补发 SAT，不依赖
  下一个 high-water edge。
- 流控 RPC 失败不改变本地订阅；下次可见性变化重试。控制 RPC 失败不阻断 `closed` 清理。

## 安全与失败

- 方法不接受 connectionId/workspace 参数，scope 用自身连接身份转发，浏览器无法影响其他连接。
- `closed` 不可由客户端触发；`flowClosed` 后 SAT/DRN 被忽略。
- 失败只降级为“继续投递”，不破坏订阅与会话。

## 验收

1. 页面隐藏后，隧道上不再出现该会话的增量帧；CLI 侧连接进入 paused。
2. 恢复可见后，按需收到快照或增量；隐藏超过缓冲上限时恢复为快照。
3. 隐藏期间正在跑的轮次不被回收；恢复后结果完整。
4. 客户端传 `closed` 或未知 state 被拒绝；无 scope 的 base 调用被拒绝。
5. 桌面 MessagePort 路径与移动 relay 语义不变；浏览器关闭仍走 `closed`。
6. 重复同态调用幂等；`dispose` 后 SAT/DRN 被忽略。

验证：scope 流控单测（services）、web visibilitychange 单测（web）；执行 pnpm typecheck、
pnpm lint、架构检查与目标包测试。不得为验收重启 zcode-web-local 宿主；隔离实例副本必须去掉
credentials.json。
