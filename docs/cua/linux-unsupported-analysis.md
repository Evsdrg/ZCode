# Computer Use 为何不支持 Linux（源码归因）

状态：已核实（分支 `selfhost/maintained`，随上游 3.15.1 合并时补充）
范围：只回答「为什么 Linux 本地桌面不可用」，不提出支持计划。

## 结论

**不是没接开关，而是结构性缺失。** 本仓没有任何 Linux CUA 后端实现：全仓检索 `at-spi` / `atspi` /
`xdotool` / `libatk` / `ibus` 在 `packages/`、`apps/`、`scripts/` 下对 CUA 相关代码零命中，
也没有 `LinuxCuaHelperHost` / `createLinuxCua*` 之类符号。判定链路是逐层 fail closed，
每一层都只认 `darwin` 与 `win32`。

## 分层证据

### 1. 插件层：本仓的 `packages/zcode-cua` 是 fail-closed 占位包

- `packages/zcode-cua/package.json:5` 自述 "This build ships without Computer Use: every
  runtime surface reports unavailable and fails closed."；`:58` 有 `zcodeCuaPlaceholder: true`。
- `broker.js:39-41` 的 `callBrokerMethod()` 直接抛 "Computer Use is not available in this build."。
- `broker-server.js:104-131` 的 `createUnavailableCuaHelperHost()` 让 `start/stop/restart` 全部
  unavailableReject；`:181-192` 的 `resolveCuaHelperInstallRoot()` 返回 `null`、
  `standaloneHelperCandidatePaths()` 返回 `[]`（注释：开源构建不携带 Helper）。
- 真实 producer（`zcode-cua` 上游仓）不在本仓，见 `docs/cua-permission-broker/local-dev-helper-runbook.md:6`。

### 2. Helper 产物层：只有 macOS `.app` 与 Windows runtime 两条链路

macOS 侧的构建/校验概念在 Linux 上无对应物：

- `packages/desktop/electron-builder.config.js:203-216` 的 `assertPackagedCuaHelper()` 首行
  `if (targetPlatform.os !== "darwin" || ...) return;`，只对 macOS 断言
  `Resources/cua-helper/ZCode Computer Use.app` 存在。
- `:709-727` 的 `extraResources` 只在 `darwin` 注入 `cua-helper/`；Linux 分支（`:745-753`）
  只注入 AppImage 图标，无任何 CUA 资产。
- Helper 必须作为独立 `.app` 才能成为 macOS TCC 的独立责任进程，校验依赖
  `codesign --verify --deep --strict`、非 ad-hoc `TeamIdentifier`、`spctl`
  （`docs/cua-permission-broker/cua-helper-installation.md:49-54,117-133`）。
- `packages/desktop/src/main/cuaOsSupport.ts:7` 的 `CUA_MINIMUM_MACOS_VERSION = "12.0"` 与
  Helper 的 `LSMinimumSystemVersion` 联动；`:20` 对非 darwin 直接返回 `not-applicable`。
- `packages/desktop/src/main/desktopCuaHelperInstaller.ts:28-35` 的
  `resolvePackagedCuaHelperAppPath()` 只在 `darwin` 返回路径。

Windows 是另一条独立链路（非 `.app`）：

- `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:81-86` 非 win32 直接抛
  "Windows CUA runtime is only available on win32."
- `docs/cua/windows-source-development.md:257-270`：Windows 走 `\\.\pipe\`、UIA、WGC 截图、
  `CF_UNICODETEXT` 剪贴板、`SendInput`。

### 3. 运行时 API 层：macOS 依赖 TCC / AX / CGWindowList，且有显式平台早退

- `packages/desktop/src/main/cuaAccessibilitySettings.ts:2-6` 依赖
  `AXIsProcessTrustedWithOptions{prompt:true}` 与 `CGRequestScreenCaptureAccess`。
- `:503-509` 的 `openCuaPermissionOnboarding()` 对非 darwin 返回
  "ZCode Computer Use permissions are only available on macOS."
- `:597-598` 的拖拽 prepare 同样 `if (platform !== "darwin")` 早退。
- `packages/desktop/src/main/desktopCuaPermissionIpc.ts:457-474` 的浮窗只在
  `process.platform === "darwin"` 创建；`cuaPermissionPanelPositioner.ts:40` 的吸附依赖
  `CGWindowList`。
- `docs/cua-permission-broker/zcode-cua-permission-broker.md:24-31`：Helper 用
  `SecCodeCheckValidity` 校验 launcher 签名、`getpeereid` + `LOCAL_PEERPID` 做 peer 校验，
  均为 macOS 专属。

### 4. 服务层：`darwin || win32` 是硬门，且没有第三分支

- `packages/services/src/node.ts:738-750` `shouldEnableDefaultCuaProductHelper()`：
  `return platform === "darwin" || platform === "win32";`
- `:773-779` `shouldUseCuaPermissionService()`：同样 `(darwin || win32) && opts.cuaEnabled`。
- `:1853-1858` `getStatus()`：非这两个平台返回
  `{ available: false, reason: "CUA permissions are only available on macOS and Windows." }`。
- `:1022-1090` `createDefaultCuaProductHelper()`：`darwin` → macOS host，`else` → Windows host，
  **没有 linux 分支**（Linux 已在上一行被 `shouldEnableDefaultCuaProductHelper` 拦下）。
- `:2191-2198` agent spawn env 注入 broker 凭据同样只覆盖 `darwin || win32`。

### 5. UI 层：`local-linux` → `supported: false`，但分区可见

- `packages/ui/src/settings/computerUseAvailability.ts:55-58`：`!isDesktop` → web；
  mac → supported；windows → supported；**其余本地桌面 → `local-linux` + `supported: false`**。
- `packages/ui/src/settings/ComputerUseSection.tsx:683-701`：不可用时渲染提示卡，
  `availability.kind === "local-linux"` 用 `settings.computerUse.unsupported.linuxDescription`。
  注释说明理由：直接 `return null` 会让设置页只剩标题，被误认为加载失败。
- `packages/ui/src/lib/cuaPlatform.ts:3-6` 注释总结：macOS 才有 TCC / 授权引导 / Helper 状态轮询；
  Windows 只复用插件总开关；**Linux、普通 Web 和手机远控不展示电脑控制设置的能力**。
- 中文案 `packages/ui/src/i18n/locales/zh-CN.ts:7026-7027`：「Computer Use 暂不支持 Linux
  桌面环境。请切换到本机 macOS 或 Windows 工作区。」

## 能力矩阵（源码确认）

| 环境                             | 分区可见 | 能力可用 | 说明                                            |
| -------------------------------- | -------- | -------- | ----------------------------------------------- |
| macOS 本地桌面                   | 是       | 是       | 完整：TCC 双权限 + Helper 状态 + 版本地板 12.0  |
| Windows 本地桌面                 | 是       | 是       | 仅 zcode-cua 插件总开关，不读 TCC / Helper 状态 |
| Linux 本地桌面                   | 是       | **否**   | 渲染不支持提示卡                                |
| 远端 SSH / WSL / Docker / Server | 是       | 否       | 渲染远端提示卡                                  |
| 普通 Web / 手机远控              | 否       | 否       | `showComputerUse` 为 false，分区不出现          |

macOS 额外限制：低于 12.0 时 Helper 被 LaunchServices `-10825` 拒启，整卡替换为升级提示；
输入框常驻入口默认隐藏（`computerUseComposerEntryHidden !== false` 才算展示）；
插件关闭时只留总开关，权限配置整块隐藏。

## 未确认部分

1. 上游 producer 仓（`zcode-cua`）内部是否存在未启用的 Linux SystemSurface 抽象，本仓无法核实。
   `docs/superpowers/plans/2026-07-28-windows-cua-development-runtime.md:242` 出现过
   `linux -> createLinuxNodeSystemSurface`，`docs/superpowers/specs/2026-07-29-windows-cua-native-clipboard-design.md`
   也提到「macOS/Linux 现有 SystemSurface」，但这些文档同时把 Linux 列为「不变 / out of scope」，
   不能据此断定产品侧 Linux 可用。
2. `docs/cua/2026-08-25-cua-permission-error-passthrough.md:24` 的 `permission_denied` 承载
   "Linux input" 错误语义、`docs/cua/cua-tool-app-identity-summary.md:44,192` 提到 `linux-exe:`
   locator 与 Linux `bundle_id` 可为空——说明协议/数据面曾为 Linux 预留字段，但本仓无对应后端，
   无法确认是「预留」还是「曾实现后移除」。
3. `docs/cua/2026-08-27-computer-use-unsupported-environment-ui-spec.md:42` 声称新增了
   `local-linux` 分支测试，但本仓 `packages/ui` 未找到引用 `resolveComputerUseAvailability` 的测试，
   该验收项是否落地无法确认。

## 若未来要支持 Linux 需要补的部分

按分层看，缺的不止一个开关：需要 Linux 的 Helper 产物与安装/校验链路（替代 `.app` + codesign +
TCC 的授权模型）、系统层的输入与截图实现（AT-SPI / 对应截图 API，替代 AX 与 CGWindowList）、
`createDefaultCuaProductHelper` 的第三分支、`shouldEnableDefaultCuaProductHelper` 与
`shouldUseCuaPermissionService` 放宽、以及 UI 侧 `local-linux` 的能力判定与文案。
这些跨 producer 与本仓两侧，不属于格式或门控调整范围。
