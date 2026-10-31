# Web 平台适配

`createWebPlatform` 是普通 Web、手机远控与自部署 WebUI 共用的 `IPlatformService` 实现。

## 形态判定

平台服务通过**注入项是否存在**判定当前形态，不靠环境探测：

| 注入项 | 含义 | 缺席时语义 |
| --- | --- | --- |
| `externalWebRemoteControlProxy` | 手机远控（背后挂着 desktop Host） | 普通 Web / 自部署 |
| `relayStatusSource` | 自部署 server 注册的官方中转远控服务 | 远控卡片按「不可用」呈现 |
| `managedBrowserMaintenance` | 自部署托管浏览器数据清理 | `clearEmbeddedBrowserData` 返回错误 |
| `mcpDirectoryService` | 自部署 server 侧 MCP 目录服务 | MCP 列表回退空数组 |
| `hostNativeService` | 自部署 host-native（同机同会话） | 本机文件/编辑器能力缺席 |

## 能力标志

UI 侧一律读显式能力标志，**不得**用「可选方法是否存在」反推能力：

- `canSelectFilePath`：Web 恒 `false`（`selectDirectory`/`selectFile` 恒返回空）。
  `DataBaseDirControl` 据此回退到服务端 `DirectoryBrowser`。
- `canOpenLocalFiles`：仅在注入 `hostNativeService` 时为 `true`。
  缺席时不提供失败桩，让「用默认应用打开」「OpenSplitButton」等分支自然回退到浏览器新标签。
- `canConfigureManagedBrowserCertificates`：仅在注册了托管浏览器维护服务时声明。
  桌面端由 Electron main 装到 Session，自部署由 server 在每个 Playwright Context 上
  设 `ignoreHTTPSErrors`。

## `saveFile` 语义

Web 端 `saveFile` 把字节交给浏览器下载：

- 接收原始 `ArrayBuffer` 或 URL 读取结果，最多 50 MiB，允许空文件。
- URL 内容按流读取并检查实际字节数；异常停止读取。只接受 HTTP、HTTPS、data、blob 来源。
- 下载文件名清理路径与非法字符；触发后移除临时链接并回收 Blob URL（40s 有界保留）。
- `success` 只表示已交付给浏览器下载，**不表示用户已确认或文件已落盘**；取消无法被页面可靠观察。
- 桌面端同一方法走原生另存为对话框，`success` 表示已写入文件。

## 边界

- 本模块不持有工作区、任务、session 或 stream 状态；远控连接、事件与 owner 语义保持不变。
- `createWebPlatform` 只做接口适配；重业务逻辑（relay 状态投影、通知、MCP 回退）各自委托给
  既有模块（`@zcode/ui` 的投影纯函数、`webTaskNotification`、注入的服务）。
