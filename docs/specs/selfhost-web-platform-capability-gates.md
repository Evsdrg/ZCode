# 自部署 Web 端 platform 能力门控（capability gates）

状态：已实施
范围：`packages/ui` 内依赖 `IPlatformService` 的**能力探测**，与 `packages/web` 的 `createWebPlatform` 实现。

## 背景

`IPlatformService` 把方法分成两类：

- **必需方法**（50 个）：`openInFileManager`、`openInEditor`、`exportLogs`、`executeDesktopCommand` 等。
  TypeScript 要求每个平台实现都提供，因此 `createWebPlatform` 必须给出一个实现——即使浏览器根本没有该能力。
- **可选方法**（87 个）：`saveFile`、`pluginSandbox`、`printPageToPdf` 等。缺失即 `undefined`，
  UI 用 `platform.xxx !== undefined` 判断能力是**正确**的。

缺陷根因：对**必需方法**，`createWebPlatform` 返回的是「明确的失败桩」，例如：

```ts
openInFileManager: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
importChromeBrowserData: () => Promise.resolve({ success: false, error: "chrome_import_not_supported" }),
```

而 UI 侧多处用 `typeof platform.xxx === "function"` 或 `if (!platform.xxx)` 判能力——
对失败桩恒为真，于是渲染出**点击必然失败**的入口。

这类入口比「功能缺失」更糟：用户看到按钮、点了、弹「执行失败」，无法判断是环境限制还是程序 bug。

## 行为规则

**能力判定必须用显式能力标志，不得用必需方法的存在性。**

| 能力                                        | 判定依据                                                                   | 依据类型                           |
| ------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| 本机文件管理器 / 默认应用 / 系统编辑器      | `platform.canOpenLocalFiles === true`                                      | 布尔标志（可选字段，缺失即 false） |
| 文件选择框能返回 agent 可访问的本地绝对路径 | `platform.canSelectFilePath === true`                                      | 布尔标志                           |
| 原生另存为                                  | `platform.saveFile !== undefined`                                          | 可选方法                           |
| 插件 UI 沙箱                                | `platform.pluginSandbox !== undefined`                                     | 可选方法                           |
| PDF 导出                                    | `platform.printPageToPdf !== undefined && platform.saveFile !== undefined` | 可选方法组合                       |
| 内置浏览器 webview                          | `Root.supportsEmbeddedBrowser` prop（由壳层注入）                          | 壳层能力                           |

`canOpenLocalFiles` 目前只有 `desktopPlatform.ts` 设为 `true`；`createWebPlatform` 设为 `false`。

### 本次修复点

| 位置                                                 | 修复前                                                   | 修复后                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TaskActionMenuContent`（任务「更多」菜单）          | 无条件渲染「在文件管理器中打开」/「前往配置」            | 按 `canOpenLocalFiles` 隐藏两项                                                                            |
| `task-context-menu-content`（侧栏右键菜单）          | 同上                                                     | 同上                                                                                                       |
| `WorkspaceFileTree` 的「在文件管理器中打开」         | 已用 `canOpenLocalFiles`（正确，保持不变）               | —                                                                                                          |
| `WorkspaceFileSearchSection` 的「打开文件位置」      | 只判 `loaded.source === "file"`                          | 追加 `canOpenLocalFiles`                                                                                   |
| `SkillsSection` 的「打开文件位置」                   | 无门控                                                   | 按 `canOpenLocalFiles` 隐藏                                                                                |
| `ModelTrajectoryPane` 的「打开源目录」               | 无门控                                                   | 按 `canOpenLocalFiles` 隐藏                                                                                |
| `BrowserSettingsSection` 的「导入登录状态」          | `typeof platform.importChromeBrowserData === "function"` | 改为 `platform.canOpenLocalFiles`（导入需要读本机 Chrome profile）                                         |
| `BrowserSettingsSection` 的 `nativeActionsAvailable` | 两个 `typeof` 组合                                       | 改为 `clearEmbeddedBrowserData !== undefined`（该能力自部署真实可用）                                      |
| `cuaPlatform.supportsLocalWindowsCuaEntry`           | `typeof platform.executeDesktopCommand === "function"`   | 追加 UA 判定已存在；`executeDesktopCommand` 是必需方法，桩使该判断失真 → 改判 `platform.canOpenLocalFiles` |

### 明确不改

- **`isDesktop` prop 链**：仍是壳层注入的硬编码 prop（见 `selfhost-browser-capability-gates.md` 不变量 1），不改运行时探测。
- **`pluginSandbox` / 资源管理器 / 内置浏览器**：属于「Web 形态不具备的 Electron 能力」，本次不新增实现（见「不在本次范围」）。
- **`saveFile`**：Web 端已有图片下载的浏览器原生 fallback（`startBrowserNativeDownload`）；不新增 `saveFile` 以免改变该 fallback 的既有行为。

## 状态所有者

- **能力事实的唯一所有者**：各平台的 `IPlatformService` 实现（`desktopPlatform.ts` 的 `canOpenLocalFiles: true`；`createWebPlatform` 的 `canOpenLocalFiles: false`）。
- **入口可见性的所有者**：各消费组件自身，读取 `platform.canOpenLocalFiles`。不新增全局能力状态，不做运行时平台嗅探。

## 不变量

1. `canOpenLocalFiles` 是**唯一**的本机文件操作能力判据。不得再用 `openInFileManager` / `openInEditor` / `getInstalledEditors` 的存在性判断——它们是必需方法，在 Web 上是失败桩。
2. 桌面行为零变化：`canOpenLocalFiles === true` 时所有入口保持可见。
3. `clearEmbeddedBrowserData` 在自部署（托管浏览器）下真实可用，必须继续显示「清除缓存 / 清除全部」；不得因本次修复一起隐藏。
4. 不引入新的平台嗅探（`navigator.userAgent` 等），除 `cuaPlatform.ts` 已有的 UA + 能力双判。

## 失败语义

- `canOpenLocalFiles` 缺失（`undefined`）按 `false` 处理：隐藏入口，不渲染失败按钮。
- 隐藏而非禁用：这些能力在 Web 形态**永久**不存在，禁用态会给用户「可能有权限问题」的错误暗示。

## 验收场景

1. 自部署 WebUI → 侧栏任务「更多」菜单：**没有**「在文件管理器中打开」「前往配置」。
2. 自部署 WebUI → 设置 → 技能 → 技能详情：**没有**「打开文件位置」。
3. 自部署 WebUI → 设置 → 工作区文件搜索：**没有**「打开文件所在位置」。
4. 自部署 WebUI → 模型轨迹面板：**没有**「打开源目录」。
5. 自部署 WebUI → 设置 → 浏览器控制：**没有**「导入浏览器数据」；**保留**「清除缓存」「清除全部」。
6. Electron 桌面端：上述入口全部保持原样可见可用。
7. 自部署 WebUI → 设置 → 浏览器控制 → 清除缓存 / 清除全部：仍能执行（回归保护）。

## 测试

`packages/ui` 新增纯逻辑测试覆盖能力判定函数（不依赖 DOM / service 装配）：

- `src/lib/platformCapabilities.test.ts`：`canOpenLocalFiles` 为 `true` / `false` / `undefined` 三态；
  确认 `openInFileManager` 是否为失败桩**不影响**判定结果。

组件级回归依赖手工验收（这些组件的依赖图包含 `@zcode/services` 全量装配，纯渲染测试超出本次范围）。

## 不在本次范围

| 能力                            | 为什么不做                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件 UI 沙箱（`pluginSandbox`） | `PluginSandboxPlatformPort` 的 `getOwnerWebContentsId` / `onPorts`（MessagePort）与 Electron webview 强绑定；Web 需改用 iframe + postMessage 并重建 CSP 边界，属新增子系统而非修复 |
| 资源管理器独立窗口              | 数据源 `window.resourceManager` 只在 desktop preload 暴露；Web 需新增 server RPC + 多入口页面                                                                                      |
| 内置浏览器（`<webview>`）       | 浏览器无此标签，不可实现                                                                                                                                                           |
| 桌面窗口控制 / 托盘 / 自动更新  | OS 集成能力，天然属于桌面壳                                                                                                                                                        |
| `createLocalMediaPreviewUrl`    | 需要 `zcode-media://` 自定义协议；Web 端已有分块 `attachmentReadV4` fallback（不走该捷径，行为正确但多一次传输）                                                                   |
