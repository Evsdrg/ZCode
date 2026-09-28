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

| 能力 | desktop | 自部署浏览器 | 判定依据 |
| --- | --- | --- | --- |
| Bot 配置（`bots.*`，机器人管理） | 可用 | **可用** | `IBotsService` 已在 `services/src/node.ts` 注册；`entry-http.ts` 未传 `serviceAuthorityMode` ⇒ `isDesktopAttachedRemote === false` ⇒ `runStartupBackgroundTasks === true`，telegram / weixin / feishu 三个长连接 runtime 会启动；`POST /api/bots/:provider[/:botId]` 已挂载 |
| IM 渠道入口（微信 / 飞书 / Lark / Telegram） | 可点击 | **可点击** | 产品定义：这些渠道**就是 bot**，不是远控。它们点击后打开 `BotsDialog` 并按 `entryProvider` 预选渠道，走的是 bot 配置能力 |
| 移动端远控（直接访问 webUI 的专门通道） | 专用通道 | **不在本版本范围** | 远控与 bot 是两个概念：远控是经官方或自建方法让另一台设备直接访问 webUI；微信/飞书/TG 均属 bot。当前检出的开源代码里不存在远控 UI 入口（见下），本分支不做处理 |
| Memory catalog viewer | 可用 | **可用** | `MemorySettingsViewer` 零 platform 依赖，纯走 `memoryService.listProjectMemories()`；`IMemoryService` 在 `services/src/node.ts` 与 `desktop/src/host/remoteWorkspaceServiceCollection.ts` 均已注册 |
| Claude 原生历史迁移 | 可用 | **关闭（所有形态）** | 产品决策：完全不使用 Claude。设置分区整体隐藏 |
| Automations 主视图面包屑 | 可用 | **可用** | 面包屑不依赖桌面能力；只有拖拽区 `[app-region:drag]` 需要 desktop |

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

## 不在本次范围

- `isMacDesktop` / `isWindowsDesktop` / `isLinuxDesktop` / `isDesktopRuntime` / `isDesktopAttachedRemote` 的门控未做调整。
- CUA、BrowserView、全局快捷键、桌面更新等确属桌面专属的门控保持原状。
- `packages/services/src/plugins/pluginsService.ts` 已 retired（`capability.supported: false`），而 `CONTEXT.md` 仍描述完整插件商店词汇表——属既有文档偏离，另行处理。
