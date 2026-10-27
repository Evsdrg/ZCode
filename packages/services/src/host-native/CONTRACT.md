# host-native

## 意图

自部署 server 与用户**同一台机器、同一个 Unix 用户、同一个图形会话**（`DISPLAY` / `WAYLAND_DISPLAY` /
用户 DBus 均可用）。因此 `IPlatformService` 里一批「桌面能力」其实与 Electron 无关，只是被 IPC
投影掩盖了。本模块把这些能力下沉成一个服务，由 `createLocalServices({ hostNative: true })` 注册，
`createWebPlatform` 转发，从而让自部署 WebUI 获得与 Electron 等价的行为。

## 不变量

1. **桌面行为零变化**：桌面 Host 不传 `hostNative`，不注册本服务，仍走 `registerPlatformIpcHandlers`。
2. **不新增信任边界**：能访问 server RPC 的一方本就有 `terminalService`（任意 shell）与
   `fileService`（任意路径读取）。本模块不引入新的鉴权/授权模型。
3. **语义必须与 Electron 完全一致**（用户硬约束）：
   - `openInFileManager` 对齐 `shell.openPath`：目录进目录，文件用默认应用打开该文件。
   - `openInEditor` / `getInstalledEditors` 对齐 `openInEditor.ts` / `editors.ts` 的 Linux 分支：
     Linux 的 `getEditorDefsForCurrentPlatform()` 只返回带 `fileExtensions` 的 file application，
     而 `getBaseInstalledEditors` 会过滤它们，所以**不传 filePath 时列表恒为空**；
     `openInEditor` 只支持文档/媒体应用（`evince`/`okular`/`firefox`/`wps*`/`libreoffice-*`/`vlc`/`mpv`）。
4. **失败必须显式**：任何一步不满足都返回 `{success:false, error}`，不得静默成功。
5. **不跨层**：本模块不 import `packages/desktop`。GUI 打开必须用 `spawn({detached,stdio:"ignore"})`，
   不能用 `execFile`（会等 GUI 进程退出并把 RPC 挂死）。

## 与其它模块的交集

- `services`：通过 `createLocalServices` 注册（`packages/services/src/node.ts` 的 `hostNative` 开关）。
- `shared`：`ServiceChannels.HostNative`、`server-remote` 的 `capabilities.hostNative`、
  `@zcode/shared` 的 `EditorInfo` / `CreateTempTextAttachment*` / `MaterializeWorkflowArtifactFile*` /
  `SSHConfigAliasOption` / `DockerContainerInfo` 类型。
- `server`：`entry-http.ts` 传 `hostNative: true`；`http.ts` 把能力写进 `/api/server-info`。
- `client` / `web`：`RemoteServiceAccess` 建代理，`createWebPlatform` 转发，`canOpenLocalFiles` 据此为 true。

详细设计与验证记录见 `docs/specs/selfhost-host-native-platform-service.md`。
