# 自部署 Web 端的 platform 能力下沉（host-native platform 服务）

状态：已实施（P1–P5 完成；P6 选择框不在范围）
范围：`packages/services`（新增 `host-native` 服务）+ `packages/web`（`createWebPlatform` 接入）+ `packages/server`（装配）。

## 背景

`IPlatformService` 是 Electron 主进程能力的投影。自部署 WebUI 复用了同一套 `packages/ui`，
但 `createWebPlatform` 只能给出失败桩，于是出现两类问题：

1. **点击必然失败**（已修，见 `selfhost-web-platform-capability-gates.md`）：入口按能力隐藏。
2. **本可真实可用却完全缺失**：自部署 server 与用户在同一台机器、同一 Unix 用户、同一图形会话，
   很多「桌面能力」其实只是**本机操作**，与 Electron 无关。

实测自部署 server 进程环境：

```
DISPLAY=:0
WAYLAND_DISPLAY=wayland-0
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
XDG_SESSION_TYPE=wayland
XDG_SESSION_DESKTOP=KDE
```

即 server 进程**本身就在用户的桌面会话里**，可以调用 `xdg-open` / `gio` / `kdialog` / 桌面应用。

## 安全基线（本方案的前提）

Web 端**已经**具备的能力：

| 能力 | 现状 |
| --- | --- |
| 任意 shell 执行 | `ITerminalService`（`node-pty`）注册在 `ServiceCollection`，`exposeOnChannelServer` 全量暴露 |
| 任意路径文件读取 | `IFileService.readTextFile` / `readFileRange` / `readdir` / `stat`，无路径白名单 |
| 鉴权 | `ZCODE_SERVER_AUTH_TOKEN` 设置后 `/api/*` 与 `/ws` 全部校验 |

因此新增「打开文件管理器 / 打开编辑器」**不实质扩大攻击面**：能连上该端口的一方已经能执行任意命令。
真正的边界是鉴权与网络暴露（默认监听回环地址，需要时由部署方显式绑定到内网地址，不直接暴露公网）。

**本方案不引入任何新的信任边界**，也不放宽已有的鉴权。

## 设计

### 服务：`IHostNativeService`

新增 `packages/services/src/host-native/`：

```ts
export interface IHostNativeService {
  /** 用系统文件管理器打开路径（目录或文件所在目录）。 */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
  /** 用指定编辑器打开路径。 */
  openInEditor(editorId: string, path: string, options?: OpenInEditorOptions): Promise<{ success: boolean; error?: string }>;
  /** 列出本机已安装的编辑器（含图标 data URL）。 */
  getInstalledEditors(filePath?: string): Promise<EditorInfo[]>;
  /** 写入一份临时文本附件，返回宿主本地绝对路径。 */
  createTempTextAttachment(payload: CreateTempTextAttachmentRequest): Promise<CreateTempTextAttachmentResult>;
  /** 把工作流产物字节落成宿主本机副本。 */
  materializeWorkflowArtifactFile(payload: MaterializeWorkflowArtifactFileRequest): Promise<MaterializeWorkflowArtifactFileResult>;
  /** 本机 SSH config 别名。 */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;
  /** 本机 Docker 探测。 */
  isDockerAvailable(): Promise<boolean>;
  listDockerContainers(): Promise<DockerContainerInfo[]>;
}
```

频道名：`ServiceChannels.HostNative = "host-native"`。

### 为什么不直接复用 `packages/desktop/src/main/*`

`exportLogs.ts`（1246 行）只有 2 行 Electron；`openInEditor.ts`（462 行）只有 3 行；`editors.ts`（698 行）
有 8 处。这些文件在 `packages/desktop`，而 `packages/services` 不能反向依赖 `packages/desktop`
（架构策略 `architecture-policy.yaml` 中 `services` 是被依赖方）。

因此**在 services 层重写等价实现**，而不是跨层搬文件：

| 能力 | 新实现 | 复用已有 |
| --- | --- | --- |
| `openInFileManager` | `xdg-open` / `gio open` | — |
| `openInEditor` | 编辑器表 + `execFile`/`spawn` | `fileApplications.ts` 的 Linux app 定义逻辑（重写为 services 侧） |
| `getInstalledEditors` | 扫描 `$PATH` + `/usr/share/applications/*.desktop` 的 `Icon=` | — |
| `createTempTextAttachment` | 原 `tempTextAttachment.ts`（52 行，**0 Electron**） | 直接搬逻辑 |
| `materializeWorkflowArtifactFile` | 原 `workflowArtifactFile.ts`（136 行，**0 Electron**） | 直接搬逻辑 |
| `listSSHConfigAliases` | — | `services/src/system/sshConfigAlias.ts` 已在同层 |
| `isDockerAvailable` / `listDockerContainers` | — | 需要把 `@zcode/server/remote/docker-detect.ts` 的探测逻辑下沉（或 services 侧重写 `docker ps` 调用） |

**仅自部署注册**：`createLocalServices` 增加 `options.hostNative?: boolean`，只有 `entry-http.ts` 传 true。
桌面 Host 不注册——桌面有自己的 `registerPlatformIpcHandlers`，两条路径不重叠，避免行为分歧。

### Web 侧接入

`createWebPlatform` 增加可选 `hostNativeService?: Pick<IHostNativeService, ...>`：

- 提供时，`openInFileManager` / `openInEditor` / `getInstalledEditors` / `createTempTextAttachment` /
  `materializeWorkflowArtifactFile` / `listSSHConfigAliases` / `isDockerAvailable` / `listDockerContainers`
  转发到该服务；
- 未提供时保持现有失败桩/缺席语义（手机远控等形态）。

`canOpenLocalFiles` 从硬编码 `false` 改为：`hostNativeService !== undefined`。
这样依赖该标志的入口（上一轮刚隐藏的那些）会**自动重新出现**，无需再改 UI。

## 不变量

1. **桌面行为零变化**：`createLocalServices({ hostNative: false })`（默认）不注册服务，桌面走原 IPC。
2. **不新增信任边界**：不引入新的鉴权/授权模型；沿用 server 已有的 token 鉴权与网络边界。
3. **`canOpenLocalFiles` 仍是唯一能力判据**：本轮只改变它的取值来源，不改变消费方。
4. **失败必须显式**：`openInEditor` 找不到编辑器或命令不存在时返回 `{success:false, error}`，
   不得静默成功。
5. **不跨层依赖**：`packages/services` 不 import `packages/desktop`。

## 失败语义

| 场景 | 行为 |
| --- | --- |
| `xdg-open` 不存在 | 尝试 `gio open`；都失败返回 `{success:false, error:"no_file_manager"}` |
| 编辑器命令不存在 | 从 `getInstalledEditors` 列表缺席；`openInEditor(不存在的 id)` 返回错误 |
| 无图形会话（`DISPLAY`/`WAYLAND_DISPLAY` 都缺） | `openInFileManager` 返回 `{success:false, error:"no_display"}`（不挂起、不静默） |
| `createTempTextAttachment` 空文本 | 抛错（与原桌面实现一致） |

## 验收场景

1. 自部署 WebUI → 任务「更多」菜单：**重新出现**「在文件管理器中打开」「前往配置」，点击真的打开本机文件管理器。
2. 自部署 WebUI → 粘贴 ≥15KB 文本 → 生成临时文本附件，**不再报「读取失败」**。
3. 自部署 WebUI → 文件预览「打开方式」子菜单：列出本机已装编辑器（`code`、`dolphin` 等）。
4. 自部署 WebUI → 远程连接对话框：SSH config 别名下拉有内容；Docker 选项按真实可用性显示。
5. 桌面 Electron：上述全部行为**不变**（仍走 IPC，不走 host-native 服务）。
6. 手机远控（无 hostNative）：行为回退到当前语义（入口隐藏）。

## 不在本次范围

- `selectFile` / `selectDirectory` / `saveFile`：会弹**服务器那台机器**的对话框，对远程访问者无意义。
  需要单独的环境变量开关 + 产品决策，见后续 spec。
- `printPageToPdf`：浏览器 `window.print()` 可用但**返回不了字节**；服务端 headless 重渲需把 DOM
  序列化过去，成本高且与「Web 与 Electron 一致」冲突。
- `captureWindowScreenshot`：Web 无窗口概念。
- `pluginSandbox` / 资源管理器窗口：Electron 专有进程模型。


## 实施记录

### 服务端

- `packages/shared/src/channels.ts`：新增 `ServiceChannels.HostNative = "host-native"`。
- `packages/shared/src/server-remote.ts`：`capabilities.hostNative`（输入/输出两个 schema 同步）。
- `packages/services/src/host-native/contract.ts`：`IHostNativeService` 契约。
- `packages/services/src/host-native/tempTextAttachment.ts`：临时文本附件（对齐桌面端同名实现）。
- `packages/services/src/host-native/workflowArtifactFile.ts`：产物落地（对齐桌面端同名实现）。
- `packages/services/src/host-native/openTarget.ts`：`openInFileManager` / `openInEditor` / `resolveExecutable` / `hasGraphicalSession`。
- `packages/services/src/host-native/editors.ts`：`getInstalledEditors`（XDG `.desktop` 图标解析 + PATH 探测）。
- `packages/services/src/host-native/dockerDetect.ts`：从 `packages/server/src/remote/docker-detect.ts` 下沉。
- `packages/services/src/host-native/hostNativeService.ts`：服务装配（所有 impl 可注入，便于测试）。
- `packages/services/src/node.ts`：`createLocalServices({ hostNative: true })` 时注册该服务。
- `packages/server/src/entry-http.ts`：自部署入口传 `hostNative: true`，并让 `/api/server-info` 声明该能力。
- `packages/server/src/http.ts`：`HttpServerOptions.hostNative` → `capabilities.hostNative`。

### 客户端

- `packages/client/src/remoteServiceAccess.ts`：`hostNativeService?` + `hostNativeAvailable`（仅 `hostNative: true` 时建代理）。
- `packages/client/src/websocket.ts`：`connectViaWebSocket({ hostNative })` 透传。
- `packages/web/src/main.tsx`：
  - `WebHostNativeService`（web 侧形状子集，避免 web 依赖 services 包）；
  - `createWebPlatform({ hostNativeService })` 注入后 `canOpenLocalFiles = true`；
  - `openInFileManager` / `openInEditor` / `getInstalledEditors` / `createTempTextAttachment` /
    `materializeWorkflowArtifactFile` / `listSSHConfigAliases` / `isDockerAvailable` / `listDockerContainers`
    转发到 host-native；
  - `resolveWebBootstrap` 读取 `server-info.capabilities.hostNative`。

### 关键实现约束（实测）

1. **`execFile` 不能用**：文件管理器/编辑器是长期进程，`execFile` 会等退出并缓冲输出，把 RPC 挂死。
   改用 `spawn({ detached: true, stdio: "ignore" })` + 只等 `spawn` 事件 + 3 秒兜底。
2. **`openInFileManager` 完全对齐 Electron `shell.openPath`**：目录 → 打开并进入；文件 → 用默认应用打开该文件。
   早期草稿写成「打开父目录」是错的（那是 `shell.showItemInFolder`，Electron 只在自己的「导出日志」流程里用）。
3. **`openInEditor` 拒绝 `remoteTarget`**：自部署 server 就是宿主，传了远端目标说明调用方误判，
   直接拒绝比误开本机文件安全。`OpenInEditorOptions.pathKind` 不参与判定。
4. **`getInstalledEditors` 在 Linux 上不传 `filePath` 时恒为空**：
   Electron 的 `getEditorDefsForCurrentPlatform()` 在 Linux 上只返回 `getFileApplicationDefs()`，
   而 `getBaseInstalledEditors` 会 `filter(!("fileExtensions" in def))` 把它们全部滤掉。
   所以 Linux 没有「通用编辑器」概念；`openInEditor` 也只支持按扩展名匹配的文档/媒体应用
   （`evince` / `okular` / `firefox` / `wps*` / `libreoffice-*` / `vlc` / `mpv`）。
   这点必须与 Electron 保持一致，不能自作主张多加 `code` / `dolphin`。
5. **图标缺失返回空串而不是过滤掉该项**：本服务没有 Electron 的通用文件图标兜底，
   宁可少一个图标也不要少一个可用入口。
6. **`.desktop` 文件名不一致**：VS Code 官方包是 `com.microsoft.VSCode.desktop`（Debian 另有 `code.desktop`），
   `desktopFileNamesForId` 按候选列表逐个尝试。

### 验证

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 error / 105 既有 warning |
| 单测 `hostNativeFiles` / `hostNativeOpenTarget` / `hostNativeService` / `hostNativeEditors` | 26 passed |
| 单测 `webPlatformHostNative.test.ts` | 3 passed |
| 生产 `/api/server-info` | `capabilities.hostNative: true` |
| 生产 RPC `host-native.getInstalledEditors`（不传路径） | `[]`（与 Electron Linux 一致）；0.1ms |
| 生产 RPC `host-native.getInstalledEditors("/tmp/x.pdf")` | 列出本机已装的 pdf 应用 |
| 生产 RPC `host-native.listSSHConfigAliases` | 1 条（`winpc`） |
| 生产 RPC `host-native.createTempTextAttachment` | 700 B，落盘路径正确 |
| 生产 RPC `host-native.openInEditor("rm -rf /")` | `unknown editor`（不做命令拼接） |
| 生产 RPC `host-native.openInEditor("evince", "/no/such.pdf")` | `unsupported file application target` |
| 真实浏览器长文本粘贴 16000 字符 | 附件「粘贴文本 · 1 行」正常生成，服务端 0.6ms，落盘 16000 B |
| `host-native.isDockerAvailable` | `false`（本机 docker 命令在但 daemon 不可用，符合预期） |

7. **`openInEditor` 的校验顺序与错误串镜像 Electron**：
   `unknown editor: <id>` → `unsupported file application target`（远端目标 / 目录 / 非绝对路径 /
   扩展名不匹配 / 目标不是文件）→ `application is not installed`。
8. **`openInEditor` 不接受任意命令**：`editorId` 必须命中定义表，杜绝 RPC 边界上的命令注入。

GUI 打开（`openInFileManager` / `openInEditor` 的成功分支）**未在用户桌面上实际触发**，
避免弹出窗口干扰正在进行的会议：已核对前置条件（`xdg-open` / `gio` / `dolphin` / `code` 均存在、
server 进程带 `DISPLAY`/`WAYLAND_DISPLAY`、`hasGraphicalSession()` 为真），
并在独立进程里跑通了同一份实现的选择逻辑。首次真实点击会在下一次用户操作时自然验证。


## 架构治理

本模块按 `architecture:adopt` 登记为 managed 模块（`architecture-policy.yaml`）：

```
- id: host-native
  roots: [packages/services/src/host-native]
  managed: true
  requires: [services, shared]
  publicEntrypoints:
    - packages/services/src/host-native/index.ts
    - packages/services/src/host-native/contract.ts
  layers: { adapters: . }
```

五件套齐全：`module.ts` / `contract.ts` / `contract.example.ts` / `contract.test.ts` / `CONTRACT.md`。
`packages/services/src/node.ts` 只从 `./host-native/index.js` 公开入口导入，不深导入 adapters 实现。

`pnpm architecture:check --changed` 结果：`violations: 0`。
