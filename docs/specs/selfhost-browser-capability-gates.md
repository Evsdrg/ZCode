# 自部署浏览器形态的能力门控（self-host browser capability gates）

状态：已实施（分支 `selfhost/browser-client-fixes`）
范围：`packages/ui` 内由 `isDesktop` prop 门控的入口与设置分区。

## 背景

`isDesktop` 是一个**硬编码 prop**，不是平台探测结果：

- `packages/desktop/src/renderer/src/main.tsx` 渲染 `<Root isDesktop ...>`；
- `packages/web/src/main.tsx` 的 `<Root>` **不传**该 prop，因此浏览器形态全程为 `undefined`。

自部署形态（`zcode --web`）的实际拓扑是：`bin/zcode.mjs --web` → `runner.mjs serve()`
spawn 本机 `node server/entry-http.js` → `createLocalServices()` → `createHttpServer(services, ...)`。
服务端进程与用户在同一台机器上，`homedir()`、`.claude`、`.zcode` 等本机路径均可由服务端直接读取。
因此「web ⇒ 无本机能力」这个隐含假设在自部署形态下**不成立**，一部分门控过严。

## 行为规则

| 能力                                         | desktop  | 自部署浏览器         | 判定依据                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot 配置（`bots.*`，机器人管理）             | 可用     | **可用**             | `IBotsService` 已在 `services/src/node.ts` 注册；`entry-http.ts` 未传 `serviceAuthorityMode` ⇒ `isDesktopAttachedRemote === false` ⇒ `runStartupBackgroundTasks === true`，telegram / weixin / feishu 三个长连接 runtime 会启动；`POST /api/bots/:provider[/:botId]` 已挂载 |
| IM 渠道入口（微信 / 飞书 / Lark / Telegram） | 可点击   | **可点击**           | 产品定义：这些渠道**就是 bot**，不是远控。它们点击后打开 `BotsDialog` 并按 `entryProvider` 预选渠道，走的是 bot 配置能力                                                                                                                                                    |
| 移动端远控（直接访问 webUI 的专门通道）      | 专用通道 | **不在本版本范围**   | 远控与 bot 是两个概念：远控是经官方或自建方法让另一台设备直接访问 webUI；微信/飞书/TG 均属 bot。当前检出的开源代码里不存在远控 UI 入口（见下），本分支不做处理                                                                                                              |
| Memory catalog viewer                        | 可用     | **可用**             | `MemorySettingsViewer` 零 platform 依赖，纯走 `memoryService.listProjectMemories()`；`IMemoryService` 在 `services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts` 均已注册                                                                          |
| Claude 原生历史迁移                          | 可用     | **关闭（所有形态）** | 产品决策：完全不使用 Claude。设置分区整体隐藏                                                                                                                                                                                                                               |
| Automations 主视图面包屑                     | 可用     | **可用**             | 面包屑不依赖桌面能力；只有拖拽区 `[app-region:drag]` 需要 desktop                                                                                                                                                                                                           |

### 术语边界（澄清后）

- **远控**：经官方或自建方法，**直接访问一个 webUI**。该功能有专门通道，与 bot 无关。
- **bot 渠道**：微信、飞书、Lark、Telegram、webhook、discord、wecom。`webRemoteControl.botChannel.*` 下的入口全部属于 bot，不属于远控。

### 远控入口的结论

当前检出的开源代码中**不存在**远控 UI 入口：

- `webRemoteControl.*` 只出现在 `WorkspaceWebRemoteControlTrigger.tsx` 与 `WebRemoteControlDialog.tsx`；
- `WebRemoteControlDialog` 内容 100% 是 bot（4 个渠道卡片 + 「机器人管理」），无 URL / 二维码 / 配对码；
- desktop 侧没有生成手机访问地址的代码。

远控的基础设施在 desktop host 上确实存在（`web-remote-replayable` 链路、`AttachServicePort`、
`Root.tsx` 提到的「手机 Web 远控配对/加载页」），但**官方开源版本与闭源版本并非完全一致**，
远控入口属于闭源侧实现。因此本分支不为远控新增或调整任何门控：
不为一个不存在于本版本的入口写死代码，避免开源侧凭空多出一层无法验证的行为。

### 后续修正（上游 3.15.1 合并后，官方中转远控）

本 fork 已基于**官方中转**实现自部署手机远控：自部署 server 注册
`webRemoteControlRelayService`，连接事实的所有者是服务端 relay service。

合并上游 3.15.1 后做了两次收敛：

**第一次（已实施）**：上游给 `WebRemoteControlDialog` 新增了官方「手机扫码连接」卡片，
它走 `platform.startWebRemoteControl` 等四个方法，而当时只有 Electron 桌面端实现了原生
链路，Web 平台是永远拒绝的桩——自部署浏览器里开屏必弹
「Web remote control can only be started from desktop」。先按平台能力门控该卡片
（避免渲染一个必然失败的入口）。

**第二次（已实施，取代第一次的门控）**：把官方卡片接通，并删除我们那张中转卡片。
方向是「官方卡片是唯一入口，本 fork 的实现收敛到官方代码」。做法：

- 官方 transport（`webRemoteControlTransport.ts`，791 行）经核实**零 Electron 依赖**
  （BrowserWindow/webContents/utilityProcess/MessagePort 出现次数均为 0），按仓库既有
  desktop → services 下沉模式搬入 `@zcode/services`，替换我们手写的 transport
  （`relayDeviceTransport.ts` 已删除）。官方自带 1354 行测试一并下沉。
- 自部署侧把 relay 服务投影成官方 dialog 期望的 `WebRemoteControlStatus` 契约
  （`relayStatusProjection.ts`），`createWebPlatform` 的四个方法不再拒绝而是转发 relay。
- 因此官方卡片在**桌面与自部署两种形态**都可用，`resolveWebRemoteControlAvailable`
  的判据是「桌面原生链路 **或** 自部署 relay 服务」，不再需要隐藏。
- 我方 `WebRemoteControlRelaySection.tsx` 及其状态投影函数、i18n key 已删除；
  对话框回到上游原布局（扫码卡片 + Bot Channel 卡片两列）。
- 侧栏入口的橙色状态图标（`useWebRemoteControlRelayActive`）保留：它表达「中转远控已开启」，
  与卡片是否渲染无关。

两个待办/限制：

- 只做过静态检查与浏览器端实测（配对 URL 合法、能端到端加载桌面工作区、切换工作区时
  服务端重建 bridgeSessionId）；真机手机未实测。
- `wss://zcode.z.ai/ws` 与 `/remote/v4` 是官方外部服务，源码不在本仓；官方若收紧第三方
  设备接入，两种形态会同时失效，属部署层风险。

## 状态所有者

- **入口可见性的唯一所有者**：各组件自己的 `isDesktop` prop 链（`Root` → `WorkspaceSidebar` → `WorkspaceSidebarFooter`）。本次不引入新的平台探测，也不新增全局状态；门控条件只在消费者本地收窄或放开。
- **Bot 配置数据的唯一所有者**：`IBotsService`（`packages/services/src/bots/botsService.ts`）。UI 不缓存第二份 bot 事实，`BotsDialog` 打开时经 RPC 读取。
- **设置分区可见性的唯一所有者**：`HIDDEN_SETTINGS_SECTIONS`（`packages/ui/src/lib/settingsNavigation.ts`）。分区是否出现在导航里只由这一个集合决定；`resolveSettingsSection` 对隐藏 id 回退 `general`。

## 不变量

1. `isDesktop` 仍是 prop，不得被改成运行时平台猜探；否则 desktop 与浏览器会因同一份代码产生分歧的可见性，且无法在测试里固定。
2. bot 渠道入口与「机器人管理」在自部署形态必须保持可点击：bot 配置能力在该形态真实可用，禁用会造成能力回归。远控是另一个概念，不得借「禁用远控」之名关掉 bot。
3. 关闭 Claude 迁移只隐藏设置分区，不删除 `useClaudeSessionMigration` 与服务端 `claudeNativeSessionImportRepo`：服务端扫描能力可能被其它路径复用，删除会扩大回归面。
4. Automations 面包屑与拖拽区必须解耦：拖拽区是桌面窗口语义，面包屑是导航语义，两者此前被同一个 `isDesktop` 绑死，导致浏览器下面包屑缺失。

## 失败语义

- `IMemoryService` 未注册的形态（理论存在）下放开 viewer：`refreshCatalog` 走既有 `catalogError` 分支渲染错误态，不抛未捕获异常。
- Bot 长连接启动失败：由 `botsService` 自身记录，UI 不额外兜底；`BotsDialog` 打开时以服务端返回的状态为准。

## 验收场景

1. `zcode --web` 启动后，workspace 侧栏底部出现「移动端远程控制」入口，点击可打开弹层。
2. 弹层内 4 个渠道卡片（微信 / 飞书 / Lark / Telegram）与「机器人管理」按钮**均可点击**，并打开 `BotsDialog`。
3. `BotsDialog` 内可完成新建 bot、绑定、保存，列表与状态来自服务端 RPC。
4. 设置页 → Memory 分区显示 catalog 列表（不再是「仅本地可用」占位）。
5. 设置页导航中不再出现 Claude 迁移分区；直接以 `#migration` 深链进入时回退到 general。
6. workspace 主视图切到 Automations 时，浏览器下也能看到面包屑（无拖拽区）。
7. desktop 形态行为不变：缩放子菜单、窗口控制、资源管理器、CUA、内置浏览器等桌面专属入口仍只在桌面出现。
8. 远控通道：**不在本版本范围**。开源代码中无远控 UI 入口，本分支不新增门控；若闭源侧入口日后合入，需单独评估其在自部署形态的可见性。

## 测试

`packages/ui` 此前没有任何测试基建（全包 0 个 `*.test.*` / `*.spec.*`，无 runner、无 DOM 环境、
无 `@/` 别名解析）。本次补上最小可用环境：

- `packages/ui/vitest.config.ts`：`@vitejs/plugin-react` + `happy-dom` + `@/* -> ./src/*` 别名
  （与 `packages/ui/tsconfig.json` 的 `paths` 保持一致）；
- `packages/ui/vitest.setup.ts`：声明 React act 环境；
- `packages/ui/package.json`：`test` / `test:watch` script。

覆盖文件：

| 文件                                                   | 覆盖点                                                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/settingsNavigation.test.ts`                   | `migration` 分区已关闭、`resolveSettingsSection` 回退 `general`、`plugins -> plugin` 历史映射保留、其余分区未被误关、既有隐藏分区未被误开                                   |
| `src/settings/AutomationsMainBreadcrumbFrame.test.tsx` | 桌面保留拖拽区且面包屑在其中；浏览器不渲染拖拽区**但仍渲染面包屑**（本次修复核心）；两种形态都渲染 children                                                                 |
| `src/botsUi.test.ts`                                   | 四个远控渠道仍是 bot provider 且已实现、未实现渠道不被伪装、region tag、`resolveBotProviderEntry` 选/建两条路径、颗粒度过滤、`buildCurrentWorkspaceId` 的 identity 优先规则 |

未覆盖：`WorkspaceSidebarFooter` 的 bot 入口放开、`SettingsPage` 的 memory viewer 放开。
这两个组件的依赖图包含 `@zcode/services` 全量装配，渲染测试需要先为 ui 包建立
service stub 体系，超出本次范围；其行为已由上述纯逻辑测试与手工验收场景覆盖。

## 不在本次范围

- `isMacDesktop` / `isWindowsDesktop` / `isLinuxDesktop` / `isDesktopRuntime` / `isDesktopAttachedRemote` 的门控未做调整。
- CUA 的**能力判定**（哪些平台真的能跑电脑控制）保持原状：只有 macOS 与 Windows 本地桌面可用，Linux、远端 workspace、普通 Web 与手机远控均不可用。本 fork 不新增也不放宽这层判定。
- `packages/services/src/plugins/pluginsService.ts` 已 retired（`capability.supported: false`），而 `CONTEXT.md` 仍描述完整插件商店词汇表——属既有文档偏离，另行处理。

## 后续修正（上游 3.15.1 合并时）

`computerUse` 设置分区原在 `HIDDEN_SETTINGS_SECTIONS` 中（继承自上游 3.14.3，非本 fork 的产品决策），合并上游 3.15.1 时采纳了上游的改动：**移出隐藏列表**。分区可见性与能力判定是两件事：

- 分区可见性：所有桌面形态（含 Linux）都显示该分区；不可用环境由 `ComputerUseSection` 渲染「当前环境暂不支持」提示卡并区分 Linux 与远端文案，而不是让分区消失——直接不渲染会让设置页只剩标题，被误认为加载失败。
- 能力判定：仍只有 macOS / Windows 本地桌面为 `supported: true`，见 `resolveComputerUseAvailability`。macOS 另有版本地板 12.0 与 TCC 双权限（Accessibility / Screen Recording）；Windows 只复用 zcode-cua 插件总开关，不读 TCC 与 Helper 状态。
- 自部署浏览器不传 `isDesktop`，`showComputerUse` 为 false，该分区在 WebUI 里依旧不出现，本次改动对自部署形态零影响。

## 2026-10-24 复查（3.16.2 同步后）

上游 3.16.2 重构后逐项复核，本轮修复：

1. **记忆详情查看器**：`SettingsPage` 的 `projectMemoryViewerAvailable` 在变基时回退为
   `Boolean(isDesktop)`，自部署再次显示「记忆详情仅支持本地桌面端查看」。已恢复为不按
   宿主门控（MemorySettingsViewer 纯走 memoryService，读取 host 所在机器数据）。
2. **浏览器数据清理**：`BrowserSettingsSection` 原以 `isDesktop` 一刀切隐藏清理/导入。
   改为按平台能力判定：Web 平台新增 `clearEmbeddedBrowserData`（服务端
   `IManagedBrowserMaintenanceService.clearAllData` 关闭全部托管浏览器会话与进程，
   context 销毁即数据清除）；Chrome profile 导入仍按方法存在性仅桌面显示。
3. **任务写面（归档失败根因）**：3.16.2 侧栏的置顶/归档/删除/未读/重命名改经
   `window-controller.mutateTask` 下发；本地 Controller 的显式拒绝导致归档报
   「not implemented」。已实现完整映射转交任务服务（open/resume 为导航意图返回 null）。
4. **工作区记忆开关**：确认开关与持久化链路正常（此前「打不开」发生在 3.16.2 同步
   初期的错误装配期间）。职业引导弹窗的跳过语义会写保守默认值（memory 关），
   属产品行为非缺陷。

已知未决：设置页 MCP 列表不显示用户级（`~/.zcode/cli/config.json`）服务器
（如 pdf-rag），但 Agent 会话实际已加载可用（工具面正常）；商店加载链路在浏览器侧
的失败点待查。

### 2026-10-24 MCP 设置页展示修复

根因（已确认）：`mcpStore.resolveMcpDirectoryService` 对无 `workspaceIdentity` 的本地
workspace 恒返回 null（桌面语义：本地走 platform 路径以执行旧 common MCP 迁移），
于是读取落在 `createWebPlatform.loadMcpFromUserDirectory`；该实现在 desktop attachment
（`platformProxy`）缺席时返回 `{servers: []}` 静默假成功。server 端 `IMcpSyncService`
channel 本身已随 ServiceCollection 自动暴露（`exposeOnChannelServer`，无白名单限制），
自部署 server 直接调用该 RPC 能返回 pdf-rag——断点只在浏览器 platform 层。

修复：`createWebPlatform` 新增可选 `mcpDirectoryService`（IMcpSyncService 形状子集），
自部署 bootstrap 注入 `services.mcpSyncService`；`platformProxy` 缺席时
load/save MCP 目录操作回退该服务，两者都缺席才保持原静默行为。桌面 attachment 场景
（手机远控等 proxy 存在的形态）不受影响；旧 common MCP 的 localStorage 迁移分支保持
桌面语义不变。测试 `packages/web/test/webPlatformMcpFallback.test.ts` 覆盖回退与
原行为两条路径。生效需重建 web 静态产物；保存（增删改 user-scope MCP）同样经此回退
落到 server 端 `~/.zcode/cli/config.json`。
