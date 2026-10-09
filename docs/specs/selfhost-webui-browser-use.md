# 自部署 WebUI：托管 Chromium 与 Firefox Browser Use

状态：单/双引擎均已实现，真实浏览器、已安装 SDK 和部署后的 Agent 操作链路已验收。Chromium 默认行为保留。
适用形态：`zcode --web` / `entry-http`；Desktop IAB 和 CLI 自身的托管浏览器不变。

## 目标与边界

Browser Use 通过 Agent 的 `interaction/browserList` / `interaction/browserExecute` 反向请求，由 Host 执行。Server 执行器使用公开的 `playwright-core` API，不依赖 WebUI，不跨包引用 CLI adapter。

支持 **Playwright 配套 Firefox**，既保留 Chromium / Firefox 单引擎，又允许显式配置双引擎供 AI 选择。不接入普通系统 Firefox 的 BiDi 实验通道，不接管用户 profile、扩展、已有登录状态或用户标签页；不增加第二条控制协议，不修改闭源 Agent 制品。

## 配置规则

| 配置                                       | 规则                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `ZCODE_SERVER_BROWSER_USE=headless`        | 显式启用；未设置或其它值保持不注册执行器                                      |
| `ZCODE_SERVER_BROWSER_ENGINE`              | `chromium`（缺省）、`firefox` 或 `both`；启用时其它非空值拒绝启动，不静默回退 |
| `ZCODE_SERVER_BROWSER_EXECUTABLE`          | 旧单路径配置；单引擎仍适用，双引擎时仅用于 Chromium，避免把同一路径交给两引擎 |
| `ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE` | Chromium 专用绝对路径，优先于旧路径                                           |
| `ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE`  | Firefox 专用绝对路径；单 Firefox 模式优先于旧路径，双模式不继承旧路径         |
| 浏览器版本                                 | 使用仓库锁定的 Playwright 和对应制品；不使用 `npx playwright@latest` 独立更新 |

Chromium 保留既有 `--no-sandbox` / `--disable-dev-shm-usage` 参数；Firefox 不接收这些参数。两者均懒启动、headless。缺少配套制品时 discovery 返回空，执行返回 `backend_unavailable`，不切换到另一引擎。

## 协议兼容

现有开源及闭源 Agent 的 backend type 只有 `iab | extension | cdp`。首版沿用 `type: "cdp"` 作为旧线协议的兼容分类，**不代表 Firefox 使用 CDP**。实际控制是 Playwright 配套 Firefox 协议；不调用 `connectOverCDP`、`newCDPSession` 或 BiDi 内部接口。

- Chromium 保留 `server-headless-chromium` ID 和原名称。
- Firefox 使用 `server-headless-firefox` ID、`ZCode Server Headless Firefox` 名称。
- metadata 明示 `engine`、`driver: playwright`、`launchMode: managed`、`headless: true`；只包含非敏感字符串。
- 能力通过既有 `apiSupportOverrides` 声明。保留无用户 tab、历史、下载、文件选择器和 Locator.evaluate 的限制，不因引擎切换宣称完整 SDK 支持。
- 结果 metadata 同样使用兼容 type 和所选 browser ID；不新增 strict schema 字段。

## 唯一所有者及事件顺序

执行器实例拥有一个浏览器进程、启动 Promise、generation 和各 scope 的 Context/tab 注册表。Agent / UI 不保存第二套浏览器事实。无持久 profile 或浏览器状态恢复；页面状态仅在当前 Host 进程内存在。

```text
Agent discovery → Host 转发 → 执行器（唯一 owner）
                              └─ 合并同一启动 → 所选引擎 → descriptor
Agent command   → Host 转发 → 校验 browser ID / generation
                              → scope Context 创建 Promise 去重
                              → Playwright 命令 → 既有结构化结果
浏览器断连      → owner 清当前实例/Context → generation 增加
Host shutdown   → owner 关闭 admission → 等待在途启动/Context → 回收全部资源
```

隔离 key 为工作区身份 key（`workspaceIdentity?.trim() || workspaceKey`）、`remoteSessionId` 和 `sessionId` 的元组；`workspacePath` 仅用于文件/展示语义。不按 sessionId 单独复用 Context。并发的同 scope 请求只创建一个 Context，不同工作区或远端 session 不共享 cookie/tab。

- `browserId` 若提供，必须等于所选引擎的 ID；不把另一个引擎的请求误路由。
- `browserGeneration` 若提供，必须匹配当前代次；创建 Context 及命令完成后也检查代次，旧对象不漂移到新浏览器。
- 同 scope Context 创建在途请求去重；失败后清除 Promise，允许显式重试。
- 断连回调只处理它所属的当前实例，不得清理后续新实例。
- `shutdown()` 幂等并关闭后续 admission，等待迟到的启动/Context，不能遗漏子进程。shutdown 期间返回 `backend_unavailable`，不重新启动。
- 保留按 turn 复用 Context 的行为；`turnEnded` 不销毁整个 Context，单 tab close 仅关闭该 tab。
- Desktop continuous 与 Web/mobile replayable 都透传同一命令，不增加命令重放、恢复队列或自动执行失败动作。

## 多浏览器路由与 AI 选择

`both` 模式创建两个既有执行器。路由层只拥有固定 ID→执行器映射及自身关闭标志，不保存 Context、tab、generation 或会话选择。每个引擎仍是自身浏览器事实的唯一所有者；不新增“当前浏览器”全局状态。

```text
AI list → router → 并行 discovery Chromium / Firefox → 按 Chromium、Firefox 顺序返回成功者
AI get(实际 ID) → SDK 携带 ID / generation → router 精确匹配 → 对应 engine owner
shutdown → router 关闭 admission → 两个 owner 同时关闭 → 等待所有结果
```

- 两个引擎的 discovery 都通过真实启动确认可用，所以首次 discovery 会尝试启动两者；不宣称仅选中后才启动。失败引擎不返回 descriptor，也不影响另一引擎；后续 discovery 可重试。
- 返回顺序固定 Chromium 在前，兼容 SDK 的默认选择；只有 Firefox 可用时默认是 Firefox。
- 双模式执行必须携带明确 ID 和 generation；缺失、未知 ID 或 stale generation 失败，不按类型或数组位置路由。单模式保留旧接口的可选 ID/代次行为。
- 指定引擎不可用时不得在另一引擎重放动作；同 session 不同引擎的 cookie/tab/ref 隔离。关闭一引擎的 tab 或断连不改变另一引擎的 generation。
- shutdown 幂等且等待两个 owner 全部完成，即使一个失败也先回收另一个；关闭后不重开。

AI 使用已有 `agent.browsers.list()` / `get(id)` 选择。两个兼容 type 都是 `cdp`，因此不得使用 `get("cdp")` 区分引擎。discovery metadata 增加非敏感 `selectionPolicy` 文本，官方 SDK 的 list 保留该字段；它是模型可读建议，**不是 SDK 自动决策或服务端强制切换机制**。无需改闭源 Agent 或插件缓存。

选择规则：用户明确选择优先；继续任务沿用已选 ID；未指定的新任务优先 Chromium（若可用）；Firefox 专项测试、跨引擎验证或有证据的兼容性问题可主动选择 Firefox。普通超时、fresh kernel 或 tab 丢失不触发换引擎。切换后重建页面状态，不共享登录，不重放支付、提交等有副作用动作。显式选择后使用该 browser 的 tabs 接口，不调用重新取默认浏览器的顶层 `agent.browsers.open()`。

## 导航和失败语义

只允许 `http:` / `https:` / 精确 `about:blank` 导航，拒绝其它 scheme。这不是网络沙箱；浏览器仍可访问 Host 可达的本机/私网服务。浏览器制品/profile 不写入 Git。

启动、断连、错误 ID/代次及关闭状态返回 `backend_unavailable`；未覆盖命令返回 `capability_unsupported`；其它执行错误使用既有错误码，不抛到主进程边界。日志使用 `createServiceLogger`，不写入浏览器 profile、凭据或配对链接。

## 首版命令面

沿用现有核心面：导航/回退/前进/刷新、页面状态、结构化快照、PNG 截图、点击/输入/键盘/滚动/选择/勾选、求值、受控 tab 生命周期，以及已实现的 Playwright DOM snapshot / locator / wait 子面。

不扩展录屏、用户 tab 接管、下载、文件选择器等未覆盖 SDK 方法。`getState` 的前进/后退可用性仍是现有保守值，不伪称新增导航历史支持。

## 验收场景与测试

1. 未设置开关不注册；开启但缺省 engine 仍是 Chromium；无效 engine 明确失败。
2. Firefox 只调用 `firefox.launch`，不附带 Chromium 参数；descriptor / result ID / metadata 正确，strict schema 可解析。
3. 浏览器缺失不回退；启动异常可重试；同一启动不重复创建进程。
4. 同 workspace/session 并发只创建一个 Context；相同 sessionId 不同 workspace identity 或 remote session 互相隔离。
5. 错 ID / stale generation 不执行动作；断连后的旧请求不能接管新实例。
6. shutdown 在启动中及 Context 创建中均等待并回收；重复 shutdown 不重复关闭；关闭后 list/execute 不复活浏览器。
7. 真启 Playwright 配套 Firefox，使用只绑定 localhost 的合成 HTTP 页面：导航 → DOM snapshot → role locator 填写/点击 → 状态变化；结构化 ref 动作、求值、截图、前进后退、popup tab 和 Context 隔离通过。
8. 同一真实测试回归 Chromium；Firefox 文件/profile 不依赖真实用户数据。
9. 部署后通过真实 Agent → Host 链路，发现两引擎并按实际 ID 选择，在合成 localhost 页面完成导航、DOM 快照、输入和点击；不使用真实用户数据或复制凭据。
10. 双模式专用路径优先级、旧路径只属于 Chromium、无效/相对路径拒绝；单模式原配置可用。
11. 并行 discovery 顺序稳定；一侧拒绝/空列表不阻断另一侧；显式 ID 精确路由，未知/缺失 ID 或 generation 不执行；没有自动 fallback。
12. 双路由 shutdown 幂等，等待两侧且在单侧失败时仍释放另一侧；在途 discovery 关闭后不发布可用描述符。
13. 已安装 SDK 同时发现两引擎，默认 Chromium，按 ID 明确选择 Firefox/Chromium；相同 workspace/session cookie/tab 相互隔离；选择 metadata 通过 list 可见；new fresh wrapper仍按同ID选回原引擎。

单测放在 `packages/server/src/browser/`；真实浏览器测试使用专用测试入口和显式环境开关，普通 `test` 不要求安装浏览器。生产验证包含 typecheck、lint、architecture、Server build；不重启当前 Host。

当前验证：45 项 Server 单测、4 项真实集成测试通过，包含本机已安装官方 Browser Use SDK 的完整能力文档和 selector 编码。SDK 自动化测试直接接入执行器并校验 JSON/schema，不运行闭源 Agent 或调用模型。部署后另经当前 Agent 会话的 Browser Use 接口验证双引擎 discovery、按 ID 选择、跨调用恢复和合成页面操作；本次合成标签页及临时页面服务已清理。不以此宣称所有 SDK 方法均覆盖或所有模型都会遵循选择建议。
