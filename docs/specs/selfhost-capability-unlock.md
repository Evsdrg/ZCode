# 自部署部署形态的能力解锁（self-host capability unlock）

状态：调研完成，分阶段实施
范围：`packages/web/src/main.tsx` 的 `createWebPlatform` 与 `packages/server`、`packages/services` 的 host-side 能力。
关联：`selfhost-web-platform-capability-gates.md`（能力判定必须用显式标志）、`selfhost-host-native-platform-service.md`（server 与用户同机同会话）。

## 背景

`IPlatformService` 共 138 个成员，`createWebPlatform` 未实现 66 个。这些缺口的**性质并不相同**，
不能一律按「浏览器做不到」处理。按物理约束分四类：

| 类别 | 含义 | 例子 |
| --- | --- | --- |
| **A. 服务端可真实实现** | 能力所需的 OS 资源在 server 进程里就有（同一 uid、同一图形会话、同一 D-Bus） | 文件选择框、保存文件、打开文件管理器 |
| **B. 语义不适用** | 浏览器形态下该概念本身不存在 | 窗口缩放、窗口控制按钮、托盘、多窗口 `syncWindowTabs` |
| **C. 需要跨进程/跨端架构** | 依赖 Electron 的 renderer 私有能力或另一台设备 | `printPageToPdf`（需 `webContents.printToPDF`）、`pluginSandbox`、`browserView*` |
| **D. 上游可变** | 与产品策略/云端有关，非部署形态决定 | 自动更新、OAuth、更新提示 |

**关键事实（实测）**：`zcode-web-local.service` 的进程环境包含
`DISPLAY=:0`、`WAYLAND_DISPLAY=wayland-0`、`XDG_CURRENT_DESKTOP=KDE`、
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`、`XDG_RUNTIME_DIR=/run/user/1000`。
即 server 进程**就在用户的图形会话里**，与 Electron main 的处境相同。因此 A 类缺口是
「没接线」，不是「做不到」。

## 已实施（本次）

### 1. `dataBaseDir` 目录选择（A 类 → 已修）

- 缺陷：`platform.selectDirectory` 在 Web 恒返回 `null`，而输入框 `readOnly`。
  「选择文件夹」点了无反应，数据目录迁移在自部署形态完全不可用。
- 修复：`DataBaseDirControl` 按 `platform.canSelectFilePath` 分流——`false` 时回退到
  内嵌 `DirectoryBrowser`（走 `fileService.readdir` 的 server RPC，浏览的是宿主真实目录）。
- 保留原安全约束：仍只接受真实存在的目录，不允许手输任意字符串。

### 2. `codePreviewSettings` 未被 `CodeBlock` 消费（A 类 → 已修）

- 缺陷：`CodeBlock` 把 `showLineNumbers=false` / `wrapLongLines=false` / `fontSizePx=14` 硬编码为
  props 默认值，而 store 默认是 `true` / `false` / `12`。全仓 25 个调用点只有 2 个显式传参，
  工具输出、MCP 结果、轨迹面板等主要路径完全不响应设置。
- 修复：`CodeBlock` 内部用 `useZCodeStoreWithDefault` 读 `codePreviewSettings`，
  显式 props 仍优先；`theme` 未指定时按 `appTheme`/DOM 深色类选择 `lightTheme`/`darkTheme`。

### 3. 托管浏览器证书策略（A 类 → 已修）

- 缺陷：`embeddedBrowserAllowInsecureCertificates` 的唯一消费方是
  `desktop/src/main/desktopNetworkPolicy.ts`（Electron `Session`）。自部署的托管浏览器是
  server 侧的 Playwright，**没有任何地方读这个 setting**，而设置项又被 `isDesktop` 门控隐藏。
  结果：访问自签名/过期证书的内网站点直接失败且无配置入口。
- 修复：
  - `HeadlessBrowserRuntimeOptions.resolveIgnoreHTTPSErrors`，在**每次** `newContext()` 时读取；
    读失败 fail-closed 回退严格校验。
  - `entry-http.ts` 从同一个权威 `settingService`（`createSettingServiceWithMigrations`）读取；
    同时把该实例与 `prepareLegacyAccountConnections` / `setWorkspaceProjection` 注入
    `createLocalServices`，避免出现两套设置写队列。
  - `IPlatformService.canConfigureManagedBrowserCertificates` 显式能力标志；
    桌面 `true`，自部署在注册了托管浏览器维护服务时 `true`，其余形态缺席。

## 可解锁清单（尚未实施）

### 阶段 1：A 类缺口，改动集中在 `createWebPlatform` + 一个 server 侧小模块

| 能力 | 现状 | 可行实现 | 代价 |
| --- | --- | --- | --- |
| `selectDirectory` / `selectFiles` | 恒 `null` / `[]` | **xdg-desktop-portal `FileChooser.OpenFile`**（`directory: true` 选目录、`multiple: true` 选多文件）。本机 portal 版本 4，支持这两项。已在 server 进程环境下只读验证 portal 可用。 | 中：需要处理异步 `Response` signal、parent_window、`restore_token`。**注意**：这会弹系统原生对话框，与「AI 不干扰用户」冲突，需在 AI 自动操作时避开。 |
| `saveFile` | 缺席（`pptx-preview-viewer` 的「导出 PDF」因此不可用） | portal `FileChooser.SaveFile` 拿目标路径 + `writeFile`。 | 中：同上。 |
| `openExternalFile` | 缺席（「用默认应用打开」回退到浏览器新标签） | `xdg-open` / `gio open`。`hostNative.openInFileManager` 已是这个实现，可直接复用。 | **低**：只需在 `createWebPlatform` 里接上。 |
| `exportLogs` | 恒 `{success:false,"Not supported in web mode"}` | `exportLogs` 主体是纯 Node（`yazl` + `node:fs`），只有 `shell.showItemInFolder` 依赖 Electron，已有依赖注入点。搬到 server 侧即可，产物通过 `/api` 下载。 | 低-中：需要在 `http.ts` 加一个 `GET /api/logs/export` 或写进 `~/.zcode/exports` 后用 `hostNative.openInFileManager` 定位。 |
| `printPageToPdf` | 缺席 | **不可直接搬**：Electron 的 `webContents.printToPDF` 无对应 API。可行替代是 server 侧 Playwright `page.pdf()`（已装 `playwright-core`，Chromium 可执行文件现成）。但 PPTX 预览的 DOM 在**浏览器**里，server 拿不到。若要做，需要浏览器把渲染后的 HTML 发给 server 再打印，语义会漂移。 | **高，不建议**。 |
| `getApplicationIcon` | 缺席 | 从 `.desktop` 的 `Icon=` 读图标文件并转 data URL。 | 低。 |
| `requestNotificationPermission` | 有（`Notification` API） | 已有，无需改。 | — |

### 阶段 2：B 类，建议显式标注而非实现

| 能力 | 结论 |
| --- | --- |
| `getDesktopZoomLevel` / `onDesktopZoomLevelChanged` | 浏览器有原生缩放（Ctrl+±），与 Electron 的 `webContents.setZoomLevel` 语义不同。**保持 absent**，让头像菜单不显示缩放入口。 |
| `getCloseToTrayCapability` | 无托盘概念。**保持 absent**。 |
| `syncWindowTabs` / `syncWindowUnreadCount` / `syncActiveTaskSession` | 无多窗口。当前是 no-op，符合语义。 |
| `getDesktopWindowChromeState` / `onWindowControlsOverlay*` | 自绘标题栏专属。**保持 absent**。 |
| `onNewTab` / `onFocusTab` / `onCloseActiveContextRequest` / `onOpenWorkspacePath` | 由浏览器自身标签页接管。当前 no-op 正确。 |
| `activateOrSetWorkspace` | 无多窗口激活。当前 `{activated:false}` 正确。 |

### 阶段 3：C 类，需要单项评估

| 能力 | 结论 |
| --- | --- |
| `pluginSandbox` | 需要 Electron 的 `webview` + 独立 partition + 自定义 protocol。浏览器可用 **sandboxed iframe + `srcdoc`** 近似，但丢失 `partition` 隔离与 `zcode-media` 协议。**改动大、安全边界变化，不建议在没有明确需求时做。** |
| `browserView*`（22 个方法） | 这是 Electron 内嵌浏览器的 `<webview>` guest 管理。自部署已有**托管 headless 浏览器**（server 侧 Playwright），是另一套语义：agent 操作 vs 用户可视。要做「用户能看到的内嵌浏览器」需 server 侧 VNC/截图流，**不建议**。 |
| `printPageToPdf` | 见阶段 1，不建议。 |
| `captureWindowScreenshot` | 无窗口可截。可用 `html2canvas` 截 DOM，或 `getDisplayMedia` 截屏（需授权）。当前返回 `null`，反馈表单无图，可接受。 |

### 阶段 4：D 类，明确不在本 fork 范围

| 能力 | 结论 |
| --- | --- |
| 自动更新（`getUpdateState` / `downloadUpdate` / `quitAndInstallUpdate` 等 8 个） | Electron 更新器专属。自部署有独立的 `zcode-updater.service`（:3032），但那是 **Agent 二进制**更新器，与 WebUI 无关。若要做 WebUI 自更新，应在部署脚本层做，不进 `IPlatformService`。 |
| OAuth（`registerOAuthState` / `onOAuthCallback` / `onPaymentCallback`） | Web 走标准 OAuth 回调 URL，`onOAuthCallback` 的 deep-link 语义不适用。当前 no-op 正确。 |
| `requestSourceSettingsAttachment` / `bindRemoteWorkspaceSessionContext` | Source Server 专属。自部署走 local，不需要。 |
| `notifyWebRemoteControlAuthStateChanged` / `onWebRemoteControlStatusChanged` | 手机远控专属（`platformProxy` 存在时才有意义）。当前 `getWebRemoteControlStatus` 已接 relay service，状态变更靠轮询/重查，够用。 |
| `getRendererActionTraceConfig` / `reportRendererActionTraceBatch` / `reportLocalTtftBatch` / `reportRendererHeapSample` | 桌面遥测专用。自部署已有 `reportTelemetryEvent`，这些是细粒度性能采样，**可做但收益低**。 |
| `getSystemLocale` / `onApplicationLocaleChanged` / `setApplicationLocale` | Web 用 `navigator.language` + `ZCodeIntlProvider`，当前路径正确。 |

## 状态所有者

- `createWebPlatform`：唯一决定「Web 形态有哪些 platform 能力」的地方。
- `serverInfo.capabilities`：唯一决定「server 端有哪些能力」的地方（`hostNative` 已有先例）。
- `IPlatformService` 的显式能力标志（`canOpenLocalFiles` / `canSelectFilePath` /
  `canConfigureManagedBrowserCertificates`）：UI 侧**唯一**允许的能力判定依据。
- **禁止**用「必需方法是否存在」判能力——所有平台都必须实现必需方法，失败桩会让判定恒真。

## 不变量

1. 任何新增能力都必须有对应的显式能力标志或可选方法缺席语义，不得引入「恒失败桩 + UI 存在性判定」。
2. 自部署新增能力不得改变 Desktop 行为：所有新分支都以 `options` 注入存在与否为条件。
3. 涉及设置读取的能力必须复用同一个 `settingService` 实例，不得新建第二个（会导致写队列分叉与
   `database is locked`）。
4. 会弹系统对话框或在用户桌面产生可见效果的能力（文件选择、保存、截图），AI 自动调用时必须显式
   经过用户确认；不得成为 agent 工具的隐式副作用。

## 失败语义

| 场景 | 行为 |
| --- | --- |
| server 不在图形会话（无 `DISPLAY` / `WAYLAND_DISPLAY`） | `canOpenLocalFiles` 仍为 `true`（它是「能打开」，不是「一定能成功」），调用返回 `no_display` 错误 |
| portal 不可用 | 文件选择能力按缺席处理（`canSelectFilePath=false`），UI 回退服务端目录浏览器 |
| 证书设置读取失败 | 托管浏览器 fail-closed 按严格校验启动，不阻断浏览器本身 |

## 验收场景

1. 自部署 WebUI 设置页「数据存储路径」：点「选择文件夹」→ 弹出服务端目录浏览器 → 选目录 → 保存按钮可用。
2. 自部署 WebUI「外观 → 代码预览」改字号为 20：工具输出的代码块立即变 20px（不是 14px）。
3. 自部署 WebUI「浏览器控制 → 安全」：开关存在；开启后访问自签名 HTTPS 站点不报证书错误；关闭后报错。
4. 桌面端以上三项行为完全不变。

## 测试

- `packages/server/test/managedBrowserCertificatePolicy.test.ts`：4 用例（关闭/开启/读取失败/未注入）。
- `packages/ui/test/codeBlockCodePreviewSettings.test.ts`：4 用例（store 生效/显式 props 优先/主题选择/无 Provider 兜底）。
- `packages/ui/test/dataBaseDirControlWebFallback.test.ts`：3 用例（桌面走原生/Web 走服务端浏览器/无平台不崩）。
- `packages/ui/test/browserSettingsSection.test.ts`：新增 2 用例（能力声明时展示/未声明时按 isDesktop）。

## 不在本次范围

- 阶段 1 的文件选择框与日志导出（需新 portal 客户端 + HTTP 路由，属独立工作单元）。
- `pluginSandbox` 的 iframe 替代方案。
- 任何 Electron 更新器能力。
