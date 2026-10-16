# 自部署 WebUI 的官方中转远程控制（relay remote control）

状态：实施中（控制面产品级；数据面实验性，真机 E2E 为验收门槛）
适用范围：`zcode --web` / `entry-http` 自部署形态；desktop host 不注册本服务。

## 背景

官方 Electron 客户端的手机远控链路为：

```
手机浏览器（官方页 https://zcode.z.ai/remote/v4）
  ⇄ 官方中转 relay（wss://zcode.z.ai/ws）⇄ 桌面 Main/Host ⇄ 窗口 Local Host
```

relay 的设备注册对第三方开放（已实测）：`device_mid`/`passHash` 完全本地自生成，
无账号 OAuth、无客户端签名；鉴权为 HMAC 挑战响应
`HMAC-SHA256(passHash).update("${nonce}|device|${deviceSid}")`。
配对凭证经二维码带外传递：
`https://zcode.z.ai/remote/v4?sid=&hash=&t=&mid=&name=&app_version=`。
控制端（terminal 角色）是官方托管的 web 构建，**不挑设备**：手机扫码与把同一链接复制
到桌面浏览器直接打开是等价的连接方式；UI 同时提供二维码、「复制链接」与「浏览器打开」。

本 spec 定义把该链路的「被控端」接入自部署 server：`packages/services` 新增
`IWebRemoteControlRelayService`，把官方手机页经 relay 发来的 v4 RPC 帧（`rpc-frame`，
`dataBase64` 承载 ChannelSocket 原始帧）派发到本地 service collection——与浏览器直连
`/ws`（`web-remote-replayable`）同一服务面。

## 行为规则

服务层（relay service）不变；**UI 入口已收敛到官方卡片**：原先自建一张「官方中转远程控制」
卡片，现已删除，改用上游 3.15.1 的官方「手机扫码连接」卡片——官方 transport 已下沉到
`@zcode/services`（详见 `selfhost-browser-capability-gates.md` 的「后续修正」）。
下表描述服务层能力，不再对应独立卡片。

| 能力      | 自部署浏览器形态     | 说明                                                                                                 |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| UI 入口   | 官方卡片（两种形态） | `createWebPlatform` 把 relay 投影进官方四个 platform 方法；判据见 `resolveWebRemoteControlAvailable` |
| 开启/关闭 | 用户显式开关         | 默认关闭；开启后持久化，server 重启自动重连                                                          |
| 二维码    | waiting 态展示       | URL 由服务端构造，经投影回填官方 status 的 qrUrl/connectUrl                                          |
| 重置配对  | 可用                 | 官方「刷新二维码」映射到 `resetPairing()`，旧手机立即失效（relay 侧 AUTH_FAILED）                    |

## 状态所有者

**唯一所有者：`WebRemoteControlRelayService`**（`packages/services/src/web-remote-control/`）。
连接、注册/鉴权、配对状态机、心跳、重连、凭据全部由它持有。UI 只读 `getStatus()` /
`getPairingInfo()` 投影并发命令（`setEnabled` / `resetPairing`），不缓存第二份事实。

开关与凭据统一经 `ICredentialService` 加密持久化（key `web-remote-control:relay-device-state`，
JSON：`{ enabled, credential: { deviceMid, deviceSid?, passHash } }`），不在普通settings中另存开关。

## 事件顺序

```
setEnabled(true)
  → 持久化 enabled
  → ensure credential（无则本地生成；deviceSid 经 register 获得）
  → connect(relay)
      open → device_register_init（无持久 sid）/ auth_init
           → auth_challenge → auth_response → auth_ack(pair_status)
      pair_status = "waiting"   → UI 展示二维码，进入心跳（pair_status_query/ack + watchdog）
      pair_status = "matched"   → 挂载数据面 bridge（见下），继续心跳
      断线（非 stop 触发）       → 退避重连（复用持久 sid；AUTH_INVALID 时重注册一次）
setEnabled(false) → 持久化 → dispose（清心跳/重连定时器、关 socket、卸载数据面）
resetPairing()    → 删除凭据 → enabled 时立即重连走 register 流程
```

幂等边界：`setEnabled` 在状态不变时为 no-op；重复 `matched`（同 socket 重放）不重复挂载
bridge；`stop` 后在途重连定时器必须清除，不得复活连接。

## 数据面（实验性）

matched 后，relay `data` 帧 payload 为 v4 桥帧。本服务实现最小桥：

```
手机 → relay → {type:"data", payload:{zcode_type:"rpc-frame", seq, dataBase64, ...}}
  → base64 decode → 分片组装 → RelayRpcProtocol → ChannelServer
      （纯序列化tag字节，不使用SocketProtocol的13字节帧头；
        services.exposeOnChannelServer，clientMode="web-remote-replayable"，
        ProviderProvisioningTarget 按 http.ts 同款覆写拒绝）
  ← ChannelServer 输出 → 封 rpc-frame（bridgeSessionId/generation/recoveryId/seq/dataBase64）
  ← rpc-frame-ack 回发（seq 确认）
```

**手机端接收侧有 zod 严格校验（实测确认）**：所有入站 payload 经
`mg.safeParse`（官方 web 构建内 `ete` 函数），校验失败**静默丢弃**（不报错、不留痕）。
必填字段以官方 schema 为准：workspaces 项必含 `label`；tasks 项必含
`workspaceLabel`/`workspaceKind`/`createdAt`/`updatedAt`；bootstrap result 无
`desktopAppVersion` 字段（多带即失败）；`workspace-bridge-ready` 的 `bridge` 对象
必含 identity 三元组 + `kind` 判别。任何字段增减都必须先对照手机端 schema。

已知未覆盖（标注实验性的原因，真机 E2E 后逐项确认或补齐）：

- 手机页启动序列可能依赖 `workspace-list-updated` / `platform-response` 等业务桥消息
  （官方桌面侧由窗口 Host 推送）；第一版不推送，手机页如卡在工作区选择即为该项缺失。
- 发送侧批次水标/饱和降级、ack 重放窗口为简化实现（单帧直发 + seq 跟踪）。
- 契约版本差：手机页为官方最新 web 构建，server 为本仓库版本，方法集合可能不一致。

## 交付语义边界

```
桌面 renderer：desktop-continuous ── 实时流 ──┐
                                              ├─ 同一 service collection 与 owner
手机（经 relay）：web-remote-replayable ── 恢复语义 ─┘
```

手机侧链路必须保持 `web-remote-replayable`（恢复/回放语义），不得因桥接改写
clientMode；`IZCodeAgentService` 的 connectionScope role 为 `terminal-client`，
与浏览器直连 `/ws` 一致。

## 不变量（事故记录）

**relay 桥的任何异常都不得上抛到进程边界。** 事故：日志包装层
（`LoggingChannelServer`）只透传 `registerChannel`/`ready`，没有 `dispose`；
桥释放时调用 `bridge.server.dispose()` 抛出未捕获 `TypeError`，**直接终止 server
主进程**——表现为「WebUI 频繁无响应、刷新后会话被停掉」，现场日志只有一行
`bridge.server.dispose is not a function`。正确做法：释放走未包装的原始
`ChannelServer`；`routePayload` / `dispose` / socket 状态回调全部包错误隔离，
失败只降级并 `warn`。relay 是可选功能，不得影响主进程与其它会话。

## 失败语义

- relay 不可达/超时：状态置 `error`（`network`），按退避重连；不影响 server 其他功能。
- `AUTH_FAILED`（持久 sid 失效）：丢弃持久凭据重注册一次；再失败置 `error`（`auth`）。
- `KICKED`（同 mid 新连接顶号）：断开重连（官方语义）。
- 心跳 ack watchdog 超时：视为半死连接，主动断开走重连。
- 数据面帧格式异常：置 degraded 并断开 bridge（对齐官方 `remote.rpcFrame.*` 语义），
  控制面连接保留。

## 隐私与合规文案（UI 必须展示）

- 中转流量经过官方服务器 `zcode.z.ai`，与官方桌面远控同信任模型；
- 设备凭证在本地生成并加密存储，官方服务器不持有明文密码；
- relay 为官方资源，接入策略可由官方单侧调整。

## 验收场景

以下 1-4 已在浏览器端实测通过（用桌面二维码在浏览器打开配对链接，端到端加载到桌面工作区
与会话内容；切换工作区时服务端重建 bridgeSessionId）。真机手机未实测。

1. 自部署 WebUI 打开「移动端远程控制」→ 官方「手机扫码连接」卡片在**自部署与桌面两种形态**
   都可用（`resolveWebRemoteControlAvailable`）；不再有独立的「官方中转远程控制」区块。
2. 开启 → 状态 waiting → 出现二维码与「复制链接」；手机扫码**或**桌面浏览器打开配对链接
   → 状态 paired。
3. 控制端页面可加载并与本地 server 交换 RPC 帧（数据面最小验证；如卡在工作区选择，按
   「数据面未覆盖项」记录）。
4. 关闭 → 控制端立即失效；重启 server（enabled 持久化）→ 自动回 waiting 且配对链接不变
   （凭据复用）。
5. 重置配对 → 旧链接失效（AUTH_FAILED），新链接可用。
6. 断网恢复 → 自动重连并回到 paired（控制端在线时）。

## 测试

- `relayProtocol.test.ts`：challenge proof、QR URL 构造、rpc-frame 封装/解包纯逻辑。
- `webRemoteControlRelayService.test.ts`：状态机（fake transport）——开启幂等、
  waiting→matched→数据面挂载一次、stop 清理定时器、AUTH_FAILED 重注册一次。
- UI：状态→文案/可见性映射纯逻辑测试（延续 `botsUi.test.ts` 模式）。
