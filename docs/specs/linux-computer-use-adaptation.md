# Linux 桌面（Wayland + KDE6）Computer Use 适配

状态：设计草案（未实施；阶段 0 决议已定稿，见 §5 / §11）
范围：`packages/ui` 设置页电脑控制分区；`packages/shared` CUA 权限类型与协议；
`packages/services` CUA 权限/能力后端装配；`packages/desktop` 或本机 Host 的 Linux producer。
目标环境：**Wayland + KDE Plasma 6**（本机 AOSC OS 14 / Linux 7.1 / kwin_wayland 6.7.5）。

## 1. 背景与问题

现状：Computer Use（CUA）在 Linux 桌面**结构性不可用**，且是代码里写死的，不是运行时缺依赖：

| 层         | 证据                                                                                                                                                                                                                                         | 现状                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 可用性判定 | `packages/ui/src/settings/computerUseAvailability.ts` 的 `resolveComputerUseAvailability`：`isMacDesktop → local-macos(supported:true)`、`isWindowsDesktop → local-windows(supported:true)`、**其余桌面一律 `local-linux(supported:false)`** | Linux 被硬判为不支持    |
| 设置页     | `ComputerUseSection.tsx:693-697` 走 `settings.computerUse.unsupported.linuxDescription`（「暂不支持 Linux 桌面环境」）                                                                                                                       | 只渲染一句不可用提示    |
| 权限服务   | `packages/services/src/node.ts:2021` `getStatus` 首行 `if (process.platform !== "darwin" && !== "win32") return { available:false, reason:"...only macOS and Windows." }`                                                                    | Linux 直接短路          |
| 权限类型   | `packages/shared/src/cuaAccessibilitySettings.ts` `CuaPermissionKind = "accessibility" \| "screen_recording"`（mac 语义）                                                                                                                    | 无 Linux 概念           |
| 协议       | `packages/shared/src/zcode-protocol-v4/cuaPermission.ts` `platform: z.literal("darwin")`                                                                                                                                                     | 线上 schema 只认 darwin |
| 平台门     | `packages/ui/src/lib/cuaPlatform.ts` 只有 `supportsLocalMacCuaPermissionOnboarding` / `supportsLocalWindowsCuaEntry`                                                                                                                         | 无 Linux 门             |

而**权限检测与授权 UI、状态缓存、事件驱动刷新这一整套在 Linux 上完全可复用**——它们是平台无关的，缺的只是「Linux 的权限种类」和「Linux 的能力后端」。

前提约定：**权限模型只按 ZCode 自己那套（fail-closed + 受信身份），不引入 codex 的配置模型。**

## 2. 本机能力实测基线（设计依据，非文档推断）

全部为本机实测（详见本轮调研记录）。**目标环境本身就是 Wayland+KDE6，因此做的是 Wayland 原生适配**，
而不是把 X11 时代的手段（uinput）当正路、把 portal 授权当摩擦。

| 能力                    | 本机实测结果                                                                                                                                                                                                                                                                                                                             | Wayland 契合度                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **抓屏**                | xdg-desktop-portal `ScreenCast`（v5，`AvailableSourceTypes=7` 含**单窗口**、`AvailableCursorModes=7`、`OpenPipeWireRemote` 返回 PipeWire fd）→ 走 PipeWire 帧；`restore_token` 持久授权可用（`PermissionStore[screencast]` 已有 2 条持久授权条目）                                                                                       | ⭐ 协议内正规路径                            |
| **输入注入**            | xdg-desktop-portal `RemoteDesktop`（v2，`AvailableDeviceTypes=7` = 键盘+指针+触摸）：`NotifyPointerMotion(Absolute)` / `NotifyPointerButton` / `NotifyPointerAxis` / `NotifyKeyboardKeycode` / `NotifyKeyboardKeysym` / `NotifyTouch*`，以及 **`ConnectToEIS` 返回 EIS fd**；本机已具备 `libei/libeis/liboeffis` 运行库 **+ 开发头文件** | ⭐ 协议内正规路径                            |
| **读 UI 树**            | AT-SPI2（`at-spi2-core 2.58.2`，bus `unix:path=/run/user/1000/at-spi/bus_0`）；实测：`org.a11y.Status.IsEnabled=false` 时 `dolphin/konsole` 树不可见，临时置 true 后 `dolphin/VirtualBox/konsole` 树可读                                                                                                                                 | ✅ 唯一可行（Wayland 未把 a11y 纳入 portal） |
| **窗口枚举/激活**       | KWin DBus：`org.kde.KWin` `/KWin` `queryWindowInfo` / `getWindowInfo(uuid)`；`/Scripting` 可 `loadScript`                                                                                                                                                                                                                                | ✅ KDE 原生，仅窗口管理，**不能注入事件**    |
| 直调 KWin `ScreenShot2` | 实测 `org.kde.KWin.ScreenShot2.Error.NoAuthorized`（仅 KDE 受信进程如 spectacle 可调）                                                                                                                                                                                                                                                   | ✗ 不走                                       |
| `/dev/uinput`           | 实测可建虚拟设备并注入按键（ESC 关闭了弹窗），需 `/dev/uinput` 写权限                                                                                                                                                                                                                                                                    | ⚠️ 仅作 fallback（内核层，绕过协议栈）       |
| xdotool                 | 只能操作 Xwayland（X11 客户端），**控不了 Wayland 原生窗口**                                                                                                                                                                                                                                                                             | ✗ 不作主路径                                 |

结论：**Linux producer 必须拼三套后端**（portal ScreenCast + portal RemoteDesktop + AT-SPI2），
uinput 仅备用；不存在像 mac AX/CG、win UIA/WGC 那样的单一系统统一 API。

## 3. 核心机制：一次授权长期信任（mega-authorization / restore_token）

ZCode CUA 有**两层**授权，Linux 适配必须分别映射，不能混为一谈：

### 第 1 层：OS 系统权限层（宿主机原生权限）

- mac 对应 TCC（辅助功能 + 屏幕录制），**一次授予、系统层长期有效**，撤销前一直有效。
- **Linux 对应 KDE portal 的 RemoteDesktop 单 session 授权**（实测 2026-10-25，xdg-desktop-portal 1.22.1 + xdg-desktop-portal-kde 6.7.5）：
  - **单个 RemoteDesktop session 同时承载抓屏与输入注入**。`RemoteDesktopSession` 继承 `ScreenCastSession`；`ScreenCast.SelectSources` 作用在该 session 上会置 `screenSharingEnabled=true`，`RemoteDesktop.Start` 的返回里带 `streams`。**不要建 ScreenCast + RemoteDesktop 两个独立 session**——那样既不共享授权，也拿不到可持久化的 token（实测：纯 ScreenCast session 的对话框无「允许恢复」选项、不返回 restore_token）。
  - 真正实现「一次授权、长期信任」有两条正交途径，**我们两者都用**：
    1. **KDE mega-authorization（首选的免交互机制）**：KDE portal 私有的 `kde-authorized` 权限表。命中即 `isAppMegaAuthorized()` 直接跳过所有对话框与通知。源码注释明写适用于 **headless 与用户不在机器前的场景**，正是 systemd 后端形态。
       - 写入：`PermissionStore.SetPermission(table="kde-authorized", create=true, id="remote-desktop", app=<app_id>, permissions=["yes"])`（D-Bus `org.freedesktop.impl.portal.PermissionStore`）。
       - 实测：写入后 PoC **两次连续运行均 0 秒完成、完全无弹框**（抓屏 fd + 注入 F1x 均成功）。
       - 这是**配置态的一次性授权**：由安装脚本/管理员写一次，之后永久生效；撤销即删除该行（实测 `Delete("kde-authorized","remote-desktop")` 可复原）。
    2. **restore_token（跨会话复用，兜底/兼容其它 portal）**：`persist_mode=2` 时 `RemoteDesktop.Start` 返回 `restore_token`；**下次把它传给 `RemoteDesktop.SelectDevices`**（不是 SelectSources、不是 restore_data）。前端 1.22.1 `remote_desktop_select_devices_options={types,restore_token,persist_mode}` 会把 token 桥接成后端 `restore_data`。仅在设备类型/屏幕不变时静默恢复；屏幕几何变化会失效并重新询问——与用户观察的“除非屏幕本身改变”一致。
  - portal 授权按**发起应用的 `app_id`** 记录，持久化在 D-Bus 权限库（本机 `PermissionStore` 已有持久条目为证）。
  - **命名复用现有语义（已定稿）**：不新造 `screen_cast` / `remote_desktop`，而是复用已有的 `CuaPermissionKind = "accessibility" | "screen_recording"`，语义映射为：
    - `screen_recording` ⇄ portal 抓屏（ScreenCast 源）
    - `accessibility` ⇄ portal 输入注入（RemoteDesktop 设备）
  - 这样做的代价是：`accessibility` 在 mac 指「辅助功能」，在 Linux 实指「输入注入」——语义略有偏移；收益是 UI 层（`computerUseAvailability` / `ComputerUseSection` / 双权限行 / `isCuaPermissionTccGranted` 等）无需为 Linux 新增枚举分支，且线上 `cuaRequestAccessStatusSchema` 的字段名（`accessibility` / `screenRecording`）原样复用，只需放宽 `platform` 字面量。
  - `restore_token`（单个，随 RemoteDesktop session）与 mega-auth 记录都由 main/Host 侧持有/维护（存于应用配置目录，与工作区无关——同 mac 的 TCC 归属 Helper bundle 而非 workspace）。

### 第 2 层：ZCode 应用 permission（每次工具调用过闸门）

- 与平台无关，**原样复用** `PermissionService`（`packages/zcode-cli/packages/core/src/permission/service.ts`）与
  `buildProtocolPermissionOptions`（`permission-options.ts`）：
  - `allow_once`（单次）/ `allow_project`（「Always allow Computer Use in this project」，写 SQLite `project permission`，跨会话持久）/
    `allow_session`（仅内存）/ `deny`；
  - `user-once` 表示每次必问。
- CUA 走「项目级持久」档，落盘点为 `sessionStore.saveProjectPermission`（`sqlite-session-store.ts`）。
- 该项目级规则的防仿冒：`matchesRuleScope` 只在工具条目携带宿主验证过的 `official_cua` 能力组时才匹配
  `OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME`——Linux producer 也必须挂同一 `permissionCapabilityGroup`，否则持久授权无法命中。

**一句话：不是「单次授权永久信任」，而是 OS 权限层一次性（mega-authorization 一次配置 / restore_token 一次确认）+ 应用 permission 层默认逐次确认、可显式升级为项目级持久。**

## 4. 状态所有者与事件顺序

### 4.1 所有者（唯一真相）

| 状态                                  | 唯一所有者                                                             | 说明                                           |
| ------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| portal 授权是否已建立 & restore_token | main/Host（Linux producer 的 permission 模块）                         | 进程内持有 + 持久化到配置目录；UI 不缓存第二份 |
| 权限展示态                            | `packages/ui/src/lib/cuaPermissionStatusStore.ts`（每 workspace 一槽） | 复用现有缓存，新增 Linux 分支                  |
| 应用 permission 规则（allow_project） | `sessionStore`（SQLite `project permission`）                          | 复用，不改                                     |
| 插件总开关                            | 现有 `isCuaEnabledForContext`                                          | 复用，不改                                     |

### 4.2 授权建立时序（主动授权按钮触发）

```
[用户] 设置页点「授权电脑控制」
   │
   ▼
[UI] ComputerUseSection → platform.requestCuaPermissionOnboarding()（新增，Linux 分支）
   │  operationId（renderer 生成，单次）
   ▼
[main/Host Linux producer] setupRemoteDesktopSession()
   │  1) RemoteDesktop.CreateSession（**单个 session**）
   │  2) RemoteDesktop.SelectDevices(types=keyboard|pointer, persist_mode=2, restore_token?)
   │  3) ScreenCast.SelectSources(同一 session, types=MONITOR, cursor_mode)  → 置 screenSharingEnabled
   │  4) RemoteDesktop.Start  ──┐  mega-auth 命中则 0 秒免弹框；否则首次弹 RemoteDesktopDialog
   │                             │  返回 { streams, devices, persist_mode, restore_token }
   │  5) 保存返回的 restore_token 到配置目录（供下次 SelectDevices 复用）
   │  6) （installation-time，管理员一次性）SetPermission("kde-authorized","remote-desktop",app_id,["yes"]) 落 mega-auth
   │  7) 可选：一次显式截图探针（includeFunctionalProbes 语义）
   ▼
[main/Host] 返回 { grantedKinds, grantOwner(=app_id), restoreTokens 已存 }
   │
   ▼
[UI] refresh()（事件驱动，与 Focus 刷新同路）→ store 更新展示态 → 按钮变「已授权」
```

- 顺序约束：**先 ScreenCast 后 RemoteDesktop**（注入需知道目标 stream / 屏几何）。
- 幂等：同一 `operationId` 只建一次会话；已有有效 restore_token 时直接恢复、不弹框。
- 失败即 fail-closed：任一步被拒 → 对应 `CuaPermissionKind` 保持未授权，CUA 工具不可用。

### 4.3 权限查询时序（getStatus）

沿用现有事件驱动模型（挂载 / 窗口重获焦点 / 显式 refresh），**不新增轮询**。
Linux 侧 `getStatus` 不再首行短路，改为：

1. 插件总开关检查（复用 `shouldUseCuaPermissionService`）；
2. 检查 `kde-authorized` mega-auth 是否已配置（是 → 直接视为 OS 层已授权）；
3. 否则检查本地是否持有有效 restore_token 且会话可恢复；
4. 若需要探针（`options.includeFunctionalProbes` 显式意图）且探针开关允许 → 做**一次**抓屏探针；
5. 返回 `CuaPermissionStatus`，把 `accessibility/screenRecording` 两字段替换为 Linux 语义（见 §3）。

## 5. app_id / 受信身份（Linux 特有难点，已定稿）

- portal 按发起进程的 **`app_id`** 识别授权主体。**从终端或裸进程启动时 `app_id` 可能为空**，会导致 restore_token 无法稳定绑定、每次重建会话都像"新应用"授权。
- mac 用 Helper 代码签名 + TCC 绑定；Linux **没有等价统一物**。这是 Linux 权限模型的核心工程点。
- **已定稿方案（按部署形态分治）**：让 Linux CUA producer 以**稳定的应用身份**常驻，使 portal 看到的 `app_id` 恒定。

### 5.1 桌面安装形态 → 固定 `.desktop`

- 由 `.desktop` 文件启动的应用，systemd 会以 `app-<launcher>-<AppID>-<rand>.scope` 形式起进程，portal 从 unit 名解出 desktop id 作为 `app_id`（前提：对应 `<AppID>.desktop` 存在）。
- 本机已有 `/usr/share/applications/zcode.desktop`（`Exec=/opt/ZCode/zcode %U`），若从其启动则 `app_id` 即 `zcode`。
- CUA producer 若作为该 desktop 应用的一部分启动，直接沿用此身份，无需额外注册。

### 5.2 分离式前后端（systemd user 单元，我们当前的部署）→ 必须显式 `Registry.Register`

- 本机形态：`zcode-web-local.service`。
- ⚠️ **实测更正（前一版有误）**：portal 对 host 应用从 cgroup 的 user unit 名推断 app_id，但**仅当 unit 名以 `app-` 开头**（systemd 桌面启动约定 `app-<launcher>-<AppID>-<rand>.scope`）时才解析；`zcode-web-local.service` **不以 `app-` 开头 → app_id 解析为「空串 `''`」**（**不是**上一个版本写的 unit 名）。实测：`app-...scope` → 解析出 id；`zcode-web-local.service` / 普通 service → `app ''`。
- 更严格的约束：即使 unit 以 `app-` 开头，解析出 id 后**还必须存在同名 `<app_id>.desktop`**（`g_desktop_app_info_new` 找不到即回退空串）。
- 因此 systemd 形态**必须显式 `Registry.Register(stable_id)`**。本机确认 portal 暴露 `org.freedesktop.host.portal.Registry`（v1，`Register(sa{sv})`）。
- ✅ **实测结论（2026-10-25，隔离环境，多组对照实验）**：`Registry.Register` 注册的 id **就是** portal 之后用于 RemoteDesktop 会话的 app_id，**完全覆盖 cgroup 解析**，且**后端 mega-auth 也精确按它匹配**。证据链：
  1. dbus-monitor 抓到前端→后端 `RemoteDesktop.Start` 的 app_id 参数 = **Register 的 id**（`string "com.zcode.AgentCuaTest"`），而非 cgroup 解析的 `com.zcode.cuaY`。
  2. cgroup 解析 `com.zcode.cuaY` + Register `com.zcode.AgentCuaTest` + mega-auth 只授 `AgentCuaTest` → **0.1s 免弹框**（证明用 Register id，不是 cgroup id）。
  3. mega-auth 未授该 id（Register 成功）→ **仍弹框超时**（证明 Register 本身不免弹框，免弹框唯一原因是 mega-auth 命中）。
  4. 真实 user **service** unit（非 `app-`，最贴近生产 `zcode-web-local.service`）+ Register + mega-auth → **0.1s 免弹框**。
  5. cgroup id 自身写 mega-auth（不 Register）→ 0.1s 免弹框，且后端收到的 app_id 就是该 cgroup id（证实后台确实按收到的 app_id 查 mega-auth）。
- **推翻前一版错误判断**：曾写「Register 只改 portal 会话 app_id、不覆盖后端 mega-auth」，实为当时 app_id 未对齐/未写 mega-auth 所致，已被上述实验推翻。
- ⚠️ Register 前置条件：**必须先存在 `<stable_id>.desktop`**（`~/.local/share/applications/`），否则报 `App info not found for '<id>'`。producer 安装时须一并落地。
- 结论：systemd 分离式部署可做到**一次 mega-auth 授权 → 永久 0 秒免弹框**（headless 友好），前提是：Register 的 stable_id = mega-auth 写入的 app_id，且同名 `.desktop` 存在。
- 对齐 ZCode 既有「受信 Helper」概念：
  - ZCode 受信 Helper ⇄ `Registry.Register` 声明的稳定 `app_id` + mega-auth（kde-authorized）+ restore_token
  - ZCode fail-closed ⇄ portal 未授权即不可用（查询 PermissionStore / 会话状态）
  - 不引入 codex 的配置模型。

### 5.3 两种形态的共同约束

- `app_id` 与 mega-auth / restore_token 强绑定：`app_id` 一变，旧记录失效。因此 **stable-id 一旦发布不得更改**，否则需重新授权。
- 授权记录落在 D-Bus 权限库（本机 `PermissionStore` 已有持久条目为证），按 `app_id` 索引。
- **kde-authorized mega-auth 建议在安装时一次性写入**（管理员脚本），是 headless/systemd 场景免交互的官方机制；普通交互安装则走首次弹框 + restore_token。

## 6. UI：主动请求授权按钮（本次不实现，先记录）

原因：Wayland 授权**首次必然弹一次系统弹窗**（实测：RemoteDesktopDialog）。因此不像 mac 那样能"静默探测后自动提示"，需要一个**用户主动触发**的授权入口。
注意：若安装时已写入 mega-auth（`kde-authorized`），首次也可 0 秒免弹框（实测）；但那是管理员/安装阶段动作，**面向普通用户的默认路径仍需按钮**。

设计要点（落到 `ComputerUseSection.tsx` 由 `unsupported.linuxDescription` 分支改造而来）：

- Linux 可用时，替换「暂不支持」提示卡，展示：
  - 两个权限行：`screen_recording`（抓屏）/ `accessibility`（输入注入）的当前状态（已授权 / 未授权 / 需要重新授权）；
  - **「授权电脑控制」按钮** → 调 `platform.requestCuaPermissionOnboarding()`（Linux 分支）；
  - 「重新授权」入口（restore_token 失效时）；
  - 授权返回后的恢复链复用现有 `cuaPermissionAction.ts` / `waitForAccessibilityNotStale` 的等价逻辑。
- 文案明确「首次授权会弹出系统对话框，请允许」，中英双语必须同时补齐（`AGENTS.md` 国际化要求）。
- 按钮触发的是 OS 层授权（portal），**不是**应用 permission；应用层的 allow_once/allow_project 仍在每次工具调用时由 `PermissionDialog` 处理。

## 7. 能力后端映射（Linux producer 实现契约）

| ZCode CUA 能力                 | Linux 实现路径                                                      | 备注                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `getScreenshot` / 帧           | RemoteDesktop session → PipeWire → 像素                             | 帧契约复用 `frame-contract`，注意 stride/format 归一；**用同一 RemoteDesktop session 的流**，不单开 ScreenCast session                |
| 读 UI 树 / `elements()`        | AT-SPI2（a11y bus；Python `gi.repository.Atspi` 或 D-Bus）          | 实测 Qt/KDE 覆盖优秀（dolphin **741** 元素、VirtualBox **877**）；**AT-SPI SCREEN extents 是逻辑点**；GTK 视环境而定；Electron/自绘差 |
| `click` / 坐标点击             | RemoteDesktop `NotifyPointerMotionAbsolute` + `NotifyPointerButton` | **注入坐标 = 逻辑空间**（实测超逻辑宽报 `Invalid position`）；元素 extents(逻辑) 直接注入；帧像素(物理) 需 ÷DPR                       |
| `typeText` / `pressKey`        | RemoteDesktop `NotifyKeyboardKeysym` / `NotifyKeyboardKeycode`      | keysym 映射到 XKB keysym                                                                                                              |
| 窗口枚举 / `app_ref.window_id` | KWin `queryWindowInfo` + 单窗口源                                   | 窗口激活可辅以 `/Scripting`                                                                                                           |
| 授权/恢复                      | mega-auth（`kde-authorized`）+ restore_token（SelectDevices）       | 见 §3；mega-auth 优先                                                                                                                 |
| 抓帧失败 / portal 不可用降级   | `/dev/uinput`（注入）+ 一次性抓屏 backend                           | **仅 fallback**，默认不启用                                                                                                           |

**AT-SPI 可访问性开关（`org.a11y.Status.IsEnabled`，阶段 2 实测修正）**：

- 实测：**已在运行的 Qt/GTK 应用，无论 `IsEnabled` 开/关，AT-SPI 树内容完全相同**（dolphin 恒 741、clash-verge 恒 63）——即树上是否有内容不取决于运行时 `IsEnabled`，而取决于**应用启动时**是否构建了 a11y 桥。
- Qt 应用：`IsEnabled=false` 时仍构建桥（日志 `Read ...toolkit-accessibility`）；且环境设 `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` 可强制所有新 Qt 应用无条件构建桥（可靠性最高）。
- GTK 应用：是否随 `IsEnabled` 构建桥有版本差异，GTK3/4 一般需要 `GTK_MODULES=gail:atk-bridge`；Electron 需 `--force-renderer-accessibility`。
- **部署建议**：CUA producer 的「OS 层授权」步骤中**显式设 `IsEnabled=true` + `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`** 并常驻；这是最低成本的可靠性保障（开销是全局 a11y 树构建），仍尊重「按需开启」作为后续设置项；producer 退出时**恢复原有 `IsEnabled` 值**（fail-closed 且不污染系统）。

## 8. 不变量

1. **权限模型只按 ZCode 现有两套语义**：OS 层（Linux=portal mega-auth / restore_token）+ 应用 permission 层（复用，不改）；不引入 codex 配置项。
2. **平台代码能力开关优先，绝不按 UA 猜**：Linux 门用 capability（`typeof platform.requestCuaPermissionOnboarding === "function"` 与 producer 存在性）判定，
   与 mac/win 现有的 capability 门一致；不能用 `navigator.userAgent` 推断 Linux。
3. **fail-closed**：任一层授权缺失，CUA 工具一律不可用；不得为可用性放宽。
4. **单一真相**：权限展示态只在 `cuaPermissionStatusStore`；restore_token 只在 main/Host；不在 UI 另起缓存。
5. **cua-ui a11y bus 授权状态与 workspace 解耦**：OS 授权（restore_token / IsEnabled）是本机属性，不属于某个 workspace（同 TCC 语义）。
6. **不追求 Wayland 下的 X11 兼容路径**：xdotool/Xwayland 不作主路径；uinput 只作 fallback。
7. **持久授权必须绑定受信身份**：应用层用 `official_cua` 能力组防仿冒（沿用）；OS 层用稳定 `app_id`（桌面形态=`zcode.desktop`；systemd 形态=`Registry.Register` 的 stable-id=`com.zcode.Agent`）。
8. **单 session 原则**：抓屏与注入用**同一个 RemoteDesktop session**，不得拆成两个独立 session。
9. **`CuaPermissionKind` 不新增枚举**：复用 `accessibility` / `screen_recording`，仅做语义映射；线上 schema 只放宽 `platform` 字面量。
10. **AT-SPI `IsEnabled` 默认常开、可切按需**：默认常开保证开箱可用；按需模式作为后续设置项，不得因切换改变 fail-closed 语义。
11. **坐标唯一基准（阶段 2.5 实测修正）**：AT-SPI extents = **逻辑点**；portal `Notify*Absolute` 注入 = **逻辑空间**（实测传 >逻辑宽 的值报 `Invalid position`）；portal 抓帧 = **物理像素** = 逻辑 × DPR。因此：**元素 extents(逻辑) 直接注入、无需缩放**；只有用**帧像素**做坐标时要先 ÷DPR 转回逻辑。

## 9. 验收场景（设计目标，其中 PoC 部分已实测）

1. Linux 桌面设置页不再显示「暂不支持」，而是展示 `screen_recording`（抓屏）/ `accessibility`（输入注入）两行 + 「授权电脑控制」按钮。
2. 点「授权电脑控制」→ 首次弹一次 portal 对话框（或已配 mega-auth 则免弹）；允许后按钮变「已授权」，restore_token 落盘。
3. 重启 ZCode / 重新进入设置页 → 用 restore_token 或 mega-auth 恢复，**不再弹框**（符合「一次性授权」）。
4. 授权后 CUA 工具可：截图（整屏/单窗口）、读 UI 树、坐标点击、键盘输入、枚举窗口。（✅ PoC 已证：抓屏 PipeWire fd + 键盘注入 NotifyKeyboardKeysym；✅ 阶段2已证：AT-SPI 读完整 UI 树 741 元素 + 逻辑→物理坐标映射）
5. 撤销授权（PermissionStore 无条目 / IsEnabled 关）→ `getStatus` 如实返回未授权，工具不可用（fail-closed），提示重新授权。
6. 应用 permission 层：首次调用工具仍弹 `PermissionDialog`（allow_once / allow_project / deny），选 allow_project 后该项目内免再问（SQLite 持久）。
7. 应用层项目持久授权不能被子类/第三方 MCP 冒用（`official_cua` 能力组校验）。
8. 中英双语齐全，无缺 key。

## 10. 分阶段落地（阶段 1 PoC 部分已完成）

- **阶段 0（本文档）**：设计定稿。已确认——(a) `CuaPermissionKind` 复用 `accessibility` / `screen_recording` 语义映射；(b) 受信身份按形态分治：桌面用 `zcode.desktop`、systemd 用 `Registry.Register` 稳定 id=`com.zcode.Agent`；(c) AT-SPI `IsEnabled` 默认常开、预留按需切换项。
- **阶段 1（能力 PoC）— 已实测通过（2026-10-25，本机 AOSC/KDE6）**：
  - ✅ 单 RemoteDesktop session：`CreateSession → SelectDevices → ScreenCast.SelectSources → Start` 全 response=0。
  - ✅ 抓屏：`OpenPipeWireRemote` 返回有效 PipeWire fd（流 node HDMI-A-1，物理 3072×1728 / 逻辑 1536×864 @2x）。
  - ✅ 输入注入：`NotifyKeyboardKeysym` 成功。
  - ✅ 免弹框：写入 `kde-authorized` mega-auth 后，连续两次运行 **0 秒完成、完全无弹框**。
  - ✅ restore_token：`persist_mode=2` 时 Start 返回 restore_token（下次传 SelectDevices）。
  - ⚠️ 已澄清（见 §5.2）：从 Pi bridge / systemd 启动的进程**可以通过 `Registry.Register` 让 mega-auth 命中**（实测 0.1s 免弹框）；此前不命中是 Register 未落地或缺 `.desktop` 所致。
- **阶段 2（AT-SPI 读树）— 已实测完成（2026-10-25，本机 KDE6）**：
  - ✅ 读树途径：`at-spi2-core 2.58.2` + Python `gi.repository.Atspi`（`Atspi.init()` → `get_desktop(0)` 遍历）可用；a11y bus 在 `/run/user/1000/at-spi/bus_0`（`org.a11y.Bus.GetAddress`）。pyatspi2 未装，但 GIR Atspi 够用。
  - ✅ 投影契约：`AXElement = { index, kind(title=role_name), title(get_name), value(text/value iface), actions(action_iface names[]) }`，`kind`=AT-SPI `role_name`。
  - ✅ 字段完整度实测：dolphin(741) `kind` 741/741、`actions` 522/741、`extents` 595/741、`title` 570/741；VirtualBox(877) 同样可映射。
  - ⚠️ **坐标闭环（阶段 2.5 修正）**：阶段 2 曾记「×2 / DPR=2」——**错误**。阶段 2.5 实测本机 DPR=**1.25**，桌面对话逻辑 **3072×1728**、抓帧物理 **3840×2160**（=逻辑×1.25）；且 portal 注入坐标是**逻辑空间**（传 3600 报 `Invalid position`）。故「元素 extents(逻辑) → 注入」**直接可用、不需要缩放**。阶段 2 的 ×2 结论作废。
  - ✅ `IsEnabled` 开/关对已运行 Qt/GTK 应用的树**无影响**（见 §7 末），部署应设 `IsEnabled=true` + `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`。
  - ⚠️ 局限：Qt 大量 filler 无语义（可保留作容器，或投影时对无 title/无 action 的容器压缩）；`getAXState()` 的文本树格式与 macOS `kind/title/value/actions` 渲染需在 producer 里自实现（ZCode 契约的 state 文本是 producer 产出）。
- **阶段 2.5（Linux producer 原型）— 已跑通（2026-10-25，本机 KDE6）**：见 §12。
- **阶段 3（接线）**：`resolveComputerUseAvailability` 增 `local-linux(supported:true)`；`getStatus` 去 Unix 短路并接 Linux producer；
  `cuaPlatform.ts` 增 capability 门；协议 `platform` 从 `z.literal("darwin")` 放宽为 `"darwin" | "linux"`（保持向后兼容）。
- **阶段 4（UI）**：设置页授权按钮 + 双权限行 + 授权返回恢复链（§6）。
- **阶段 5（降级）**：uinput fallback + 抓屏失败兜底。

## 11. 开放问题

已拍板（阶段 0 结论）：

- ✅ `CuaPermissionKind` 复用 `accessibility` / `screen_recording` 语义映射（见 §3）。
- ✅ 受信身份按形态分治：桌面 `zcode.desktop`、systemd `Registry.Register` 稳定 id（见 §5）。
- ✅ AT-SPI `IsEnabled` 默认常开，预留按需切换项（见 §7 末）。
- ✅ stable-id 取值：`com.zcode.Agent`。

阶段 1 新发现、待后续处理：

1. ✅ **mega-auth 与 Registry 的关系（已实测澄清）**：`Registry.Register` 的 id **就是** portal 用于 RemoteDesktop 会话的 app_id，**且后端 mega-auth 精确按它匹配**（dbus-monitor 实证 + 多组隔离对照实验）。systemd 部署可做到一次 mega-auth → 永久 0 秒免弹框。实现前提：Register 的 stable_id == mega-auth 写入的 app_id，且同名 `<stable_id>.desktop` 存在。
2. **⚠️ 安全决策点（产品级，未定）**：自动写入 mega-auth（`kde-authorized`）= 安装后即可**完全控制桌面而无需任何确认**，实质是预设全权信任。两种选择：
   - (a) **安装时自动写入** —— headless/无人值守最方便，但默认全权信任、安全面最大；不推荐作默认。
   - (b) **用户主动授权**（推荐，与 §6 的「授权电脑控制」按钮一致）：用户在设置页点按钮 → 首次弹一次 portal 框并勾选「下次不再询问」→ 由**用户确认**后写入 mega-auth 或保存 restore_token；之后永久免弹框。符合用户明确要求的「主动请求授权」。
3. 单窗口 vs 整屏抓取的默认源类型；**多屏与 HiDPI 坐标映射已实测（阶段 2.5）：注入=逻辑空间、元素extents=逻辑直接可用、帧像素=物理需÷DPR；多屏叠加当前仅单屏验证，多屏输出偏移待补**。
4. Linux 下 portal 不可用（非 KDE / 无 portal 的桌面）时是否声明"仅 uinput 降级模式"，以及降级模式的安全边界。
5. `restore_token` 在屏幕几何变化后失效重问（与 RustDesk “除非屏幕改变”一致）；需在 UX 上说明。
6. **隔离验证方法（存档备查）**：验证 app_id/mega-auth 全部在隔离环境完成——独立 app_id `com.zcode.AgentCuaTest` / `com.zcode.cuaX/Y` / `com.zcode.NotAuthed` + 独立 `systemd-run --scope`/`--unit` 模拟 cgroup + 临时 `~/.local/share/applications/*.desktop` + 临时打开 portal `G_MESSAGES_DEBUG=all` 观察 `Adding XdpAppInfo ... app '<id>'`。**全程零弹框观测**（只做 `CreateSession` 不 `Start` 即可读 app_id）；测完后已删除全部 mega-auth 条目、desktop、debug drop-in 并重启 portal。生产 `com.zcode.Agent` 及 AT-SPI 状态未被触碰。

阶段 2 新发现、待后续处理：7. **producer 契约落点（已核清源码）**：Linux 需要的只是一个 **producer**——按 broker 私有 socket 协议（行分隔 JSON `{id,token,method,input}`）收发，返回 MCP `CallToolResult`（`content` 文本树 + `structuredContent{state_id, elements[]}` + `_meta` app-associations）。三段 broker/bridge/SDK **平台无关可原样复用**；只需换掉 producer 内部实现（mac=AXUIElement / win=UIA / **linux=AT-SPI + portal**）。不实现 `computer-use-client.mjs`（它是通用 SDK）。8. **getAXState() 文本树格式需 producer 自实现**：ZCode 契约的树文本（缩进、`kind title value actions` 渲染、diff、`showing A-B of N items`）由 producer 产出，非 AT-SPI 原生；macOS 那份在闭源 Helper 里，Linux 需照契约自写渲染器。`elements()` 表格则直接来自 `structuredContent.elements`（即 AXElement[]）。9. **AT-SPI 到 AXElement 的语义差**：`kind` 取 AT-SPI `role_name`（小写带空格，如 `push button`/`menu item`）会与 macOS 的 `AXButton`/`AXMenuItem` 不同；若模型/skill 依赖 `kind` 字面，需做一层归一映射（待定是否必须）。10. **filler/容器噪声**：Qt 树中 `filler`/`separator` 占多数（dolphin 741 里 filler 42、separator 39；menu item 445 多为 popup 子项）。producer 可选择在 `elements()` 全量保留（模型可过滤）而 `getAXState()` 只渲染有语义节点，以减少上下文。11. **静态 app_id 与 helper 区**：AT-SPI producer 是一个常驻的 Linux 原生进程（Node/Go/Python 均可），以 `Registry.Register("com.zcode.Agent")` 声明的身份运行（需同名 `.desktop`）。它同时是 portal RemoteDesktop 与 AT-SPI 的发起方，地位等同 macOS 的 Helper。

## 12. 阶段 2.5：Linux producer 原型（已跑通）

**产物**：`/tmp/cua-linux-producer/producer.py`（原型，未入库）。Python 栈：`gi.repository.Atspi`（读树）+ `dbus`/`GLib`（portal）+ `Gst`（PipeWire 取帧）+ `PIL`（PNG）。

**架构（对应 §11.7 的 producer 契约）**：

```
broker(socket) → producer.py（GLib/selectors 单线程）→ dispatch(method)
  ├─ list_apps / list_windows / get_app_state   → AT-SPI 读树 → AXElement[]
  ├─ get_app_state(+include_screenshot)          → portal 抓帧 → base64 PNG（image+image_ref 在 text 前）
  ├─ left_click / type / key / scroll            → portal NotifyPointer*/NotifyKeyboard*
  └─ request_access                              → portal ensure()（首次可能弹框）
```

协议形状：请求 `{id?,method,params?}`、响应 `{id,ok,result|error}`（与 `broker.d.ts` 的 BrokerRequest/BrokerResponse 一致）。

**实测结果（本机 KDE6 / x86_64 / DPR 1.25）**：

| 项                                     | 结果                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `list_apps`                            | ✅ 返回 22 个 app（含 `_meta` items 关联）                                                |
| `get_app_state(dolphin)`               | ✅ 741 elements、522 可交互、`state_id` 生成、文本树渲染                                  |
| `get_app_state(+include_screenshot)`   | ✅ 有效 PNG 6190170 bytes、3840×2160、取帧 ~0.9–1.7s；`content` 顺序 image→image_ref→tree |
| `left_click`（帧物理坐标 (1920,1250)） | ✅ producer ÷1.25 → 逻辑 (1536,1000)；KWin `cursorPos` 精确 (1536,1000)                   |
| `key`/`type`（如 Shift_L）             | ✅ `NotifyKeyboardKeysym` 注入成功                                                        |
| `request_access`                       | ✅ portal ensure() 建立 session（register+select+start+openpipewire）                     |
| 未知方法                               | ✅ fail-closed 返回 `isError:true`                                                        |

**授权（免弹框）**：`host.portal.Registry.Register(app_id)` + 写入 KDE `kde-authorized`/`remote-desktop`/`app_id=["yes"]` 后，`Start` code=0 **免弹框**（隔离用什么 `com.zcode.CuaProbe` 验证）。权限集实际存储在 KDE 后端 `~/.local/share/kde-backend-permissions*`（PermissionStore D-Bus 对象 `/org/freedesktop/impl/portal/PermissionStore` 回读为空但文件有记录，说明 KDE 后端持久化在文件而非该对象）。

**关键坑（已入代码）**：

1. **单线程必须**：portal 走 GLib 主循环 + D-Bus 信号；与 socket 多线程混用会卡死。原型用 `selectors` 单线程事件循环驱动。
2. **`Registry.Register` 与 mega-auth 是两条腿**：Register 只改 portal 会话 app_id；免弹框靠 mega-auth 按该 app_id 命中。两者 id 必须一致，且 require `<app_id>.desktop` 存在。
3. **响应可能很大**（截图 base64 数 MB）：读完请求后要**恢复阻塞**再 sendall，否则 `EAGAIN`。

**未做/后续**：`type` 仅 ASCII keysym（非 ASCII 需 keymap）；`left_click_drag`/`set_value`/`select_text`/`perform_action`/`paste` 未实现；多屏坐标偏移未处理；`frame-contract` 的 image_ref 权威只是文本占位，未做官方帧完整性签名。

**前置结论（阶段 2.5 时的假设，阶段 6 已纠正）**：当时以为 `@zcode/zcode-cua` 是 placeholder 包、Linux 落地要「用真实现重新打包它」。**阶段 6 实测证明这个假设不对**——真正运行的是闭源 agent 自带的 `node-repl-host`（它有真实 BrokerClient），`@zcode/zcode-cua` 的桩只影响开源构建。见 §13。

## 13. 阶段 6：实际接入路径与落地进展（2026-10-25，已纠正阶段 2.5 假设）

### 13.1 关键发现：整条 CUA 链只差「一个平台判断」

实测确认（非推断）：

- **实际运行的是闭源 agent 自带的 `node-repl-host`**（`~/.zcode/server/agents/glm/packages/node-repl-host/dist/mcp/server.js`，5.07MB，`"not available in this build"` 出现 0 次）——它有**完整真实实现**。
- 它的 `createComputerUseRuntime` 是一个 **`BrokerClient`**：连 `ZCODE_CUA_PERMISSION_BROKER_SOCKET`，把 `list_apps`/`get_app_state`/`left_click`… 转发给后端 **permission broker Helper**。真正执行引擎在 Helper（mac 原生 app / win 安装包 runtime），Linux 分支 `ensureStandaloneHelperLaunched` 直接 return。
- **唯一堵点**：`packages/services/src/node.ts` 的 `resolveSpawnEnv` 只在 `darwin || win32` 时给 agent 注入 `ZCODE_CUA_PERMISSION_BROKER_SOCKET`。Linux 不注入 ⇒ BrokerClient 无 socket ⇒ CUA 不挂。

因此 Linux 只缺两样：① 一个 Linux 版 broker Helper（监听 socket、执行工具）；② 把 `node.ts` 的平台判断加上 linux + 起停这个 Helper。**闭源 agent、node-repl-host、broker/bridge、UI 都不用动。**

### 13.2 broker 线协议（从闭源 bundle 挖出，PermissionBrokerClient 侧，IPC_VERSION=3）

NDJSON over unix socket：

1. 首帧 `{"id":0,"method":"authenticate","params":{"clientApiVersion":3}}` → `{"id":0,"ok":true}`
2. 业务 `{"id":N,"method":"<m>","params":{...}}` → `{"id":N,"ok":true,"result":...}` 或 `{"id":N,"ok":false,"error":{"message","code","details"}}`
3. 必须应答 `broker_info`（Helper 启动看门狗 claim 探针）
4. peer 校验：socket 文件 uid==euid 且非 world-writable（同用户创建即通过）
5. 真实 method：`list_applications`（裸数组）、`capture_app`（`get_app_state` 底层）、`list_windows`、`screenshot`、`application_info`、`element_at_point`，及动作方法

### 13.3 已完成（阶段 6 步 1-2）

- ✅ **Rust Helper**：`packages/zcode-cua/linux-helper/`（`cargo build --release`，8MB 单二进制，零运行时依赖）。已实现 `authenticate`/`broker_info`/`ping`/`list_applications`/`capture_app`（AT-SPI 读树）。实测：7 个真实 app；`capture_app(dolphin)` 701 元素、`plasmashell` 911 元素、DPR=1.25 逻辑坐标、中文正确。
- ✅ **服务端接线**：`packages/services/src/cua-permission-broker/linuxCuaHelper.ts`（惰性单例 spawn + ping 探活 + 退出清理 + 稳定 socket `/tmp/zcode-cua-linux-helper-<uid>.sock`），`node.ts` 的 `resolveSpawnEnv` 在 `linux && cuaPluginEnabled` 时注入 helper socket，dispose 时停 helper。
- ✅ 类型检查 `tsc -p packages/services --noEmit` 通过；`pnpm --filter @zcode/server build` 产物 5.4MB bundle、含新逻辑、无裸 import 污染。
- ✅ 用真实 Node `net` 客户端精确对拍协议（auth → broker_info → list_applications 裸数组 7 项 → capture_app 701 elements 520ms）。

### 13.4 待完成

- ~~补 `list_windows` / `application_info` / `element_at_point`；动作方法（`left_click`/`type`/`key`/`set_value`/`perform_action`/`scroll`/`paste`）~~ → **见 13.5（元素级动作已完成；坐标/全局输入注入待阶段 4）**
- 抓屏（ScreenCast→PipeWire→PNG）与坐标/全局输入注入（RemoteDesktop，需 portal 授权）。
- `getStatus`/`computerUseAvailability`/`cuaPlatform`/协议 `platform` literal 的 Linux 分支与 UI 授权按钮。

## 14. 阶段 6 步 3：元素级 a11y 动作（2026-10-25，已完成）

### 14.1 关键架构发现：动作分两类，只有一类需要 portal

从闭源 `node-repl-host/dist/mcp/server.js` 反查出每个工具的底层 broker method：

| 工具                                           | 底层 method                 | 需要 portal？                 |
| ---------------------------------------------- | --------------------------- | ----------------------------- |
| `left_click`（元素目标）/ `perform_action`     | `element_perform_action`    | ❌ 纯 AT-SPI Action.do_action |
| `set_value`（元素目标）                        | `element_set_value`         | ❌ EditableText / Value 接口  |
| `select_text`                                  | `element_select_text`       | ❌ Text.set_selection         |
| `left_click`（坐标）/ `scroll`（坐标）/ `drag` | `click` / `scroll` / `drag` | ✅ 需 RemoteDesktop           |
| `type`（app 级/全局）/ `key` / `paste`         | `type` / `key` / `paste`    | ✅ 需 RemoteDesktop           |

**结论**：模型「观察 → 按元素 index 操作」的主路径（click/perform/set_value/select_text）**零授权即可工作**——它们都是 AT-SPI 语义动作。只有「坐标点击 / 全局键盘 / 滚动 / 拖拽 / 截图」需要 portal。

### 14.2 native token 约定

`capture_app` 为每个 element 填 `native = "<bus_name>|<object_path>"`（AT-SPI 对象在 a11y bus 上的唯一定位）。`element_*` 动作方法据此反查对象并调用对应接口。

### 14.3 已实现并实测（生产 socket）

- ✅ `list_windows`（窗口 index/title/bounds）、`application_info`（app 身份）
- ✅ `element_perform_action`（`AX` 前缀归一：SDK 传 `AXPress`，AT-SPI 实际 `Press`，已做去前缀比对）
- ✅ `element_set_value`（优先 `EditableText.set_text_contents`，退化 `Value.set_current_value`；不可设置时 fail-closed `not_settable` + `action_sent=false`）
- ✅ `element_select_text`（`Text.set_selection`）
- ✅ 坐标/全局输入注入一律 fail-closed `action_unavailable`（待阶段 4）
- ✅ 并发修复：每连接独立线程 + 独立 `AccessibilityConnection`（原单线程串行 accept 会被一条长连接阻塞，实际有多个 node-repl-host 连接）。

### 14.4 已知限制（诚实记录）

- **`element_at_point` 在本机 Wayland+Qt 下 hit-test 不可靠**：`Component.GetAccessibleAtPoint` 对非全屏窗口返回固定对象（`:1.5|/accessible/11`），与真实落点不符。已按窗口面积升序缓解（避免全屏窗口吃掉所有点），但仍不能可靠定位。→ 主路径是元素 index 动作，坐标 hit-test 仅 best-effort。
- `element.value` 投影对多数 Qt 文本元素返回 null（Value 接口仅数值控件，Text 接口未遍历取串）；`editable` 靠 role 启发式。
- `kind` 用 AT-SPI `role_name`（如 `push button`），与 macOS `AXButton` 字面不同；动作名已做 `AX` 前缀归一，但 role 字面若模型依赖需另做映射。

### 14.5 验证

- `cargo build --release` 通过、无警告；安装到 `/usr/local/bin/cua-linux-helper`（旧版备份 `.bak-stage1`）。
- 重启 `zcode-web-local` 后 helper ready；生产 socket 实测：8 app、`capture_app(dolphin)` 735 元素、`element_perform_action(SetFocus/AXPress)`、`element_select_text`、`list_windows`、`application_info` 全部 `ok:true`；`click`（坐标）正确 fail-closed `action_unavailable`。

## 15. 阶段 5：UI 门控与 getStatus Linux 分支（2026-10-25，已完成）

### 15.1 宿主平台贯通（关键：浏览器 UA 不等于宿主）

自部署 WebUI 跑在浏览器里，`isDesktop` 恒 undefined，浏览器 UA 也无法反映宿主进程平台。
而 Linux CUA 后端（Rust Helper）真实跑在**宿主**上。故新增一条宿主平台链路：

```
server 进程 process.platform
  → GET /api/server-info 增加 hostPlatform 字段（shared serverRemoteInfoBaseShape，optional）
  → web main.tsx resolveWebBootstrap 读取 → WebBootstrapResult.hostPlatform
  → <Root hostPlatform=...> → RootInner → settingsLayerProps.hostPlatform → <SettingsPage>
  → createSettingsPageConfig({ isLinuxDesktop: hostPlatform==="linux" })
  → <ComputerUseSection isLinuxDesktop>
```

`hostPlatform` 为 optional：旧 server 不返回时一切保持原样（不误开 CUA）。

### 15.2 判定逻辑（纯函数，已单测）

`resolveComputerUseAvailability` 新增 `isLinuxDesktop` 入参：

- `isLinuxDesktop: true` → `{kind:"local-linux", supported:true}`（承认受支持）
- 远端优先级最高：远端 workspace 即使 `isLinuxDesktop` 也判 remote/unsupported
- 仅 `isDesktop`（无平台细分，Electron Linux 桌面且未细分）→ 仍 `local-linux/unsupported`（保持既有语义，避免回归）

`ComputerUseSection`：`supportsLocalLinuxWorkspace = isLinuxDesktop && isLocalWorkspace`，与 Windows 同构——只展示插件总开关，无 TCC/Helper 权限行（portal 授权由独立「请求授权」按钮负责，见阶段 4/UI 待办）。

### 15.3 服务端 getStatus Linux 分支

`packages/services/src/cua-permission-broker/linuxCuaPermissionStatus.ts`：连 Helper socket 握手
`authenticate` + 调 `permission_status`，取回 `{accessibility, screen_recording, grant_owner, needs_grant}`。

`node.ts` 的 `cuaPermissionService.getStatus` 在 `process.platform==="linux"` 分支：

- 插件未启用 → `available:false`（与 mac/win 一致）
- `ensureLinuxCuaHelper()` 起 Helper，再 `probeLinuxCuaPermissionStatus()`
- 返回 `platform:"linux"`、`accessibility`（AT-SPI，能读树即 granted）、`screenRecording`（portal ScreenCast，阶段 4 前如实 denied）
- Helper 起不来 / 探测失败 → fail-closed

Helper 新增 `permission_status` 应答：`accessibility=granted`（AT-SPI 可用）、`screen_recording=denied` + `needs_grant=true`（portal 授权待阶段 4）。

### 15.4 验证

- `pnpm typecheck` 全通过（tsc -b 所有包 + zcode-cua）。
- `pnpm lint` 0 error（105 warning 全为既有文件）。
- `computerUseAvailability.test.ts` 9 passed（Linux 支持、远端优先、isDesktop-only 保持 unsupported、isComputerUseRemoteOrLinux 边界）。
- `pnpm --filter @zcode/server build` → entry-http.js 5.31MB bundle、含 hostPlatform/linuxCuaPermissionStatus、无裸 import。
- `ZCODE_ENV=production pnpm --filter @zcode/web build` 成功。
- 重启后：`/api/server-info` 返回 `hostPlatform:"linux"`；helper ready；生产 socket `permission_status` 返回 `accessibility:granted, screen_recording:denied, needs_grant:true`。

### 15.5 剩余（阶段 4：portal 抓屏 + 输入注入 + 主动授权按钮）

- Helper 侧用 `ashpd` 接 `ScreenCast`（PipeWire 抓帧）与 `RemoteDesktop`（Notify\* 坐标/键盘注入、ConnectToEIS）。
- 补 `click`/`scroll`/`drag`/`type`/`key`/`paste` 的 portal 实现（当前 fail-closed `action_unavailable`）。
- `permission_status` 改从 portal `PermissionStore`/会话状态读真值；`request_access` 走 portal 授权（一次弹窗 + restore_token 持久化）。
- UI：设置页新增「请求授权」按钮（用户明确要求：主动触发 portal 一次弹窗），并显示 screen_recording 授权状态。

## 16. 阶段 4：portal 输入注入后端（2026-10-25，代码完成，注入待人工授权验证）

### 16.1 实现

新增 `src/portal.rs`（`ashpd 0.13`，features `tokio,remote_desktop,screencast`，与 atspi 的 zbus 5 同版本）：

- **专用线程 + 多线程 runtime 持有 portal 会话**：portal 会话绑定创建它的 tokio reactor，不能跨 runtime await。故起独立线程（`mpsc` 命令串行驱动），与「每连接 current-thread runtime 读树」完全隔离——portal 不可用不影响 a11y。
- 会话建立：`RemoteDesktop::new` → `create_session` → `select_devices(Keyboard|Pointer, persist=ExplicitlyRevoked)` → `start`，`restore_token` 落 `/tmp/zcode-cua-portal-<uid>.token`（一次授权后免弹）。
- 注入：`click`=NotifyPointerMotionAbsolute + NotifyPointerButton(evdev 0x110/111/112)；`scroll`=NotifyPointerAxis；`key`=组合键解析为 keysym 序列；`type`/`paste`=文本转 keysym（仅 ASCII，非 ASCII 需输入法，暂 fail-closed）。
- `request_access`=建立会话（触发一次 portal 弹窗）；`reset_access`=清会话与 token；`permission_status` 的 `screen_recording`/注入授权=是否有活会话。

### 16.2 已验证

- 未授权时：`permission_status` 返回 `screen_recording:denied, needs_grant:true`；`click`/`key`/`type` 一律 fail-closed `action_unavailable`（message 含 `needs_grant`），不误发事件。
- 已授权注入与抓屏的端到端验证**尚未做**——它需要一次人工确认的 portal 授权弹窗，未在自动会话中触发（避免弹窗打扰）。这是本阶段唯一未验证项，需用户点「请求授权」或在交互会话里跑一次。

### 16.3 抓屏（ScreenCast）状态

`ashpd` screencast feature 已引入，但 PipeWire 帧获取（`open_pipe_wire_remote` → 消费 PipeWire node → PNG）尚未接入；`screenshot`/`capture_app+screenshot` 的 `image` 仍为空。后续在 portal.rs 里补 ScreenCast 会话 + PipeWire 读取。

### 16.4 UI 授权按钮（按用户要求，主动触发）

用户明确要求：Wayland 授权需一次弹窗，应在 ZCode 启用该功能时提供「主动请求授权」按钮。设计：设置页 Linux CUA 区加一个按钮，调 helper `request_access`（经 getStatus 侧或新 RPC），显示授权态。此项 UI 未实现，留作下一步。

## 17. 阶段 4 续：UI 主动授权按钮 + requestAccess RPC（2026-10-25）

### 17.1 用户要求

「Wayland 的授权需要一次弹窗，我们应该在 ZCode 中启用这个功能的时候，提供一个主动请求授权的按钮。」

### 17.2 实现

- **协议**：`ICuaPermissionService` 增可选方法 `requestAccess?(workspacePath?, workspaceIdentity?)`。
  RPC 通道是动态转发的（`ProxyChannel.fromService` / `toService`），无需额外注册。
- **服务端**（`node.ts` 的 `cuaPermissionService.requestAccess`）：仅 linux；过插件门控 →
  `ensureLinuxCuaHelper()` → 调 helper 的 `request_access`（超时 120s，等用户在弹窗里操作）。
- **helper**：`request_access` → portal `RemoteDesktop` 会话建立（弹一次系统授权窗）→
  成功后落 `restore_token`；`reset_access` 清会话与 token。
- **UI**（`ComputerUseSection`）：Linux 分区新增一行「屏幕抓取与输入注入授权」，
  显示 `screen_recording` 状态徽章 + 「请求授权」按钮（授权中显示「等待授权…」）。
  accessibility（AT-SPI）不需授权，故不展示。
- **i18n**：zh-CN / en-US 各 6 个 key（label/description/button/requesting/两个 toast）。

### 17.3 诊断改进

helper 的 stderr 原先经 `logger.debug` 转发，而 debug 级在生产环境不落盘，导致 portal
会话步骤日志全丢。改为 `stdio: ["ignore","ignore","inherit"]`——helper 的 stderr 直接进
systemd journal。

### 17.4 实测结论（关键）

portal 调用链**已验证通到系统授权窗**：helper 日志显示

```
[portal] build_session: RemoteDesktop::new
[portal] build_session: create_session
[portal] build_session: select_devices (restore_token=false)
[portal] build_session: start (会弹系统授权窗，等待用户确认)
```

`start` 之后停住等待用户确认；portal-kde 日志在同秒记录到请求（`AtSpiAdaptor::applicationInterface`）。
即：**链路正确，缺的是一次人工确认**。`AvailableDeviceTypes=7`（键盘+指针+触摸全支持）。

⚠️ 由此暴露一个**尚未解决的身份问题**：Rust helper 进程没有注册 `app_id`
（阶段 1 的 Python 原型用过 `Registry.Register("com.zcode.CuaProbe")` + `.desktop` +
KDE `kde-authorized` 才拿到免弹框授权）。当前正式 helper 走的是「每次弹窗」路径，
且身份为空时 KDE 对话框的主体显示可能不明确。这属于阶段 4.5（受信身份）待办。

**端到端注入验证（授权后 click/key/type 真的生效）尚未完成**——需用户在弹窗上点一次确认。

## 18. 阶段 4.5：受信身份 + 抓屏 + KWin 窗口激活（2026-10-25，已完成并端到端验证）

### 18.1 app_id 受信身份（授权持久化的前提）

- `portal.rs` 注册 `APP_ID = "com.zcode.cua-linux-helper"`：`ashpd::register_host_app` + 幂等写入
  `~/.local/share/applications/com.zcode.cua-linux-helper.desktop`（portal 要求非沙箱程序显式注册，
  否则授权对话框无法显示应用身份）。
- 重复注册报 "Connection already associated with an application ID"——按已注册容错。
- 实测：KDE portal 对话框显示「ZCode Computer Use Helper」；**授权一次后凭 app_id 记住**，
  helper 重启 / 会话重建不再弹窗（restore_token KDE 不返回，靠 PermissionStore 的 app 级记忆）。

### 18.2 ScreenCast 接线（与 RemoteDesktop 同一会话）

三个 KDE 特有事实（全部实测）：

1. **ashpd 的 Screencast 必须与 RemoteDesktop 共享同一 D-Bus 连接**
   （`Screencast::with_connection(desktop.connection().clone())`）——独立连接 select_sources 后
   start 不返回 streams。
2. **absolute 指针注入的 stream 参数用 `pipe_wire_node_id`**（KDE 实现里 portal stream id 为 None）。
3. **抓帧必须 `pipewiresrc fd=N path=<node_id>`**——只传 fd 报 `stream error: target not found`。

`start` 返回后 `open_pipe_wire_remote` 拿 fd 存入会话；`screenshot` 方法经
`gst-launch-1.0 pipewiresrc fd=N path=<id> ! videoconvert ! pngenc ! filesink` 子进程抓帧
（零编译期依赖，不链 libpipewire；尝试过 pipewire crate，需要 libspa-sys pkg-config 头文件，
放弃），base64 返回 MCP image content。实测 8.1MB PNG / 3840×2160（物理）——portal stream 的
3072×1728 是逻辑坐标。

官方来源核对（2026-10-25 补，修正此前仅凭实测的表述）：

- **stream 参数 = PipeWire node id**：官方 XML `@stream: The PipeWire stream node the
coordinate is relative to`；KDE remotedesktop.cpp:369 按 nodeId 匹配 ScreencastingStream，
  screencasting.cpp 确证 Start 响应 streams 元组第一元素就是 m_nodeid。ashpd 报 `id: None`
  只因该字段接口 v6 起废弃（官方推荐 pipewire-serial），但 KDE 实现仍按 node id 匹配——
  对 KDE 用 node id 是正确值。
- **pipewiresrc 的目标属性**：gst 官方属性文档里 `path` 已标 deprecated（推荐
  target-object "source name/serial"）。实测 target-object 传 node id 在本机 PipeWire 0.3
  报 target not found（它只接受 name/serial）；path 语义正是 node id 且可靠。故用 path，
  迁移路径：PipeWire 1.x 后改 serial 作 target-object。
- **Screencast 须与 RemoteDesktop 同 session**：官方 XML "Persistent remote desktop screen
  cast sessions can only be handled via the RemoteDesktop interface"——独立连接不返回
  streams 是该设计的直接体现（ashpd 层共享 D-Bus 连接即可）。

### 18.3 Wayland 坐标语义（重大修正，解释此前所有"注入 ok 但无效"）

- **指针注入 = stream 的逻辑坐标空间 + stream 几何偏移**（官方语义，已对照源码）：
  官方规范 org.freedesktop.portal.RemoteDesktop.xml 写明 "(x, y) represents the new pointer
  position in the streams logical coordinate space (see the logical_size stream property)"；
  KDE 实现 waylandintegration.cpp:297 做 `pos + stream->geometry().x/y` 平移。
  本实现只选单个整屏 Monitor stream（position=(0,0)），故等价于全屏逻辑坐标——
  多显示器 / 窗口级 stream 场景需要按 position 平移（尚未支持）。
  此前 click 无效纯粹是**坐标错**：AT-SPI 报的 `CoordType::Screen` 在 KDE Wayland 下是
  **窗口内局部坐标**（kdialog 实际在 (1464,814)，AT-SPI 报 (0,0,200,103)——原点=窗口内容区）。
- **键盘注入 = seat 焦点窗口**（grab_focus 后 type 立即生效的实验佐证）。
- 结论：元素 bounds 投影（`capture_app` 的 bounds）在 KDE Wayland 下是窗口局部坐标，
  不可直接当屏幕坐标用；屏幕绝对坐标只有 KWin（frameGeometry）与 portal 截图可信。

### 18.4 KWin 窗口激活（click 前置）

`kwin.rs`：click(point) 前经 KWin `/Scripting` D-Bus 加载一次性 JS：
按 `workspace.stackingOrder`（z 序，顶层在前）找覆盖该点的最顶层 normalWindow 并
`workspace.activeWindow = target`。语义=**视觉一致**（坐标处看到什么窗口就激活/操作什么窗口；
多窗口遮挡时点击作用于视觉最上层）。激活后焦点落在目标窗口，紧接的 type/key 送达它——
覆盖 agent 典型 click→type 序列。非 KWin 合成器（GNOME 等）无等价接口，静默跳过（尽力而为）。

调试记录：gdbus loadScript 返回 `(15,)`，id 解析曾因 `split_whitespace` 拿到 `15,)` 而
parse 失败静默跳过 start——改为提取首个连续数字串。另注意脚本文件名含 pid 且执行后
unloadScript + 删除，避免同名脚本只加载一次。

### 18.5 permission_status 真值化

`screen_recording` 改为「portal 会话存在」的真实读数（授权后 granted / needs_grant:false）；
`request_access` 自动建会话（已授权时不弹窗）。`ensure(state)`：注入/抓帧命令发现无会话时
自动重建（授权记忆使其零打扰）。

### 18.6 端到端验证矩阵（全部实测通过）

| 能力                       | 结果                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| list_applications          | 10 apps                                                                     |
| capture_app(kdialog)       | 7 元素                                                                      |
| element_set_value → 读回   | ✅ 'FINAL-1'（a11y 写路径闭环）                                             |
| screenshot                 | ✅ 8.1MB PNG（3840×2160）                                                   |
| permission_status          | ✅ granted / needs_grant:false                                              |
| KWin 激活                  | ✅ ZCODE-ACTIVATED（stackingOrder 顶层）                                    |
| click+type（视觉一致目标） | ⚠️ 已被 §19 推翻：motion/keyboard 分段有效，但 button 在 KDE 6.7.5 实际无效 |

### 18.7 已知限制（开放问题）⚠️ 已被第 20 节推翻——下述坐标相关结论错误，保留作调查历史

> **勘误**：本节「AT-SPI Screen 坐标在 KDE Wayland 不可信（窗口局部坐标）」的说法不成立。
> 实测是**应用实现差异**（有的报屏幕坐标、有的报局部坐标），已由 `capture_app` 的
> KWin clientGeometry 逐窗口校准解决。`element_at_point` 也已按同一逻辑做双坐标尝试。
> 见第 20.3 节。

- `element_at_point`：AT-SPI Screen 坐标在 KDE Wayland 不可信（窗口局部坐标）。正确实现需要
  「KWin 真实几何 ↔ AT-SPI 局部坐标」配准（KWin JS callDBus 回报 helper 的 D-Bus 服务，或
  journal 通道），工程量大，留待后续。当前返回 best-effort（可能错位）。
  官方核对新增线索：portal stream 元数据含 `position`（本机 (0,0)）与 `logical_size`
  （3072×1728）——窗口级 stream 时 position 即其在 workspace 的偏移，可作配准的官方数据源。
- type/key 不带坐标/元素目标，无法自动定位焦点窗口——依赖 agent 先 click（激活）再 type。
- 拖拽（drag）/element_scroll/hold_key 未实现（fail-closed）。

## 19. button/axis 注入缺陷调查与官方源码全景核对（2026-10-26）⚠️ 调查过程保留，结论已被第 20 节推翻

### 19.1 触发：全链路「应该工作」但 click 无可观察效果

阶段 4.5 验证时 click 返回 ok 但多次实验观察不到点击效果。按「官方文档与源码优先」
方法论做了全链路核对与运行时观测，结论出乎意料：**D-Bus 与 wl 层全部正常，
button 事件确实到达 KWin，但在 KDE 6.7.5 上不产生效果**。

### 19.2 官方源码核对全景（本轮拉取核对的所有一手来源）

| 层              | 来源                                                                       | 核对结果                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| portal 接口定义 | flatpak/xdg-desktop-portal `data/org.freedesktop.portal.RemoteDesktop.xml` | `NotifyPointerButton(button, state)`：button=Linux evdev code（BTN_LEFT=0x110=272），state=1 press/0 release；`NotifyPointerAxis(dx,dy)`=smooth 设备 motion 向量语义，无符号约定文档                                                   |
| portal 参考测试 | 同仓库 `tests/test_remotedesktop.py`                                       | 调用形状 `(session, {}, button, state)` 与 ashpd 一致                                                                                                                                                                                  |
| broker（中转）  | flatpak/xdg-desktop-portal `src/remote-desktop.c`                          | 所有 Notify\* 均 fire-and-forget 转发给 impl，**Ok 返回≠impl 处理**；button handler 无额外过滤                                                                                                                                         |
| impl（KDE）     | KDE/xdg-desktop-portal-kde **v6.7.5 tag**（与本机同版本）                  | `NotifyPointerButton→requestPointerButtonPress(quint32)→m_fakeInput->button(linuxButton,…)` 原样透传，无 Qt 枚举映射；与 master 一致                                                                                                   |
| KWin 协议后端   | KDE/kwin **v6.7.5 tag** `src/backends/fakeinput/fakeinputbackend.cpp`      | button 处理：authenticate 守卫 + pressedButtons 状态机（press 查重入/release 查不存在）+ `buttonToQtMouseButton`（`src/mousebuttons.cpp`：**BTN_LEFT→Qt::LeftButton 映射明确存在**）；与 master diff 仅 keysym 细节，button 路径零差异 |
| wl 协议         | wayland.xml（本机 /usr/share）+ KWin `org_kde_kwin_fake_input` v6          | axis 无方向符号文档；fake-input 协议声明「Regular clients must not use」，KWin 不对普通客户端广播（实测直连 bind 失败）——portal 是唯一合法通道                                                                                         |
| GNOME 对照      | GNOME/mutter RemoteDesktop 实现                                            | discrete 版官方源码写死 `steps>0 → CLUTTER_SCROLL_DOWN`（正=向下）；mutter 走 libinput 虚拟设备注入（与 KDE fake-input 完全不同路径）                                                                                                  |
| ashpd 0.13.13   | 本机 cargo registry 源码                                                   | `notify_pointer_button(session, button, state, options)` D-Bus 参数序与 XML 一致；KeyState Pressed=1/Released=0 与规范一致                                                                                                             |

### 19.3 运行时观测（决定性证据）

1. **dbus-monitor**：helper 的 click → broker → portal-kde 的 `NotifyPointerButton`
   调用**确实发出且到达**（同批 NotifyPointerMotionAbsolute/NotifyKeyboardKeysym 均到达）。
2. **WAYLAND_DEBUG=1 重启 portal-kde**（临时 override，事后已撤销）抓到 wl 层流量：
   ```
   -> org_kde_kwin_fake_input#50.authenticate("xdg-desktop-portal-kde", "Remote desktop session input")
   -> org_kde_kwin_fake_input#50.pointer_motion_absolute(1527.0, 890.0)
   -> org_kde_kwin_fake_input#50.button(272, 1)
   -> org_kde_kwin_fake_input#50.button(272, 0)
   -> org_kde_kwin_fake_input#50.keyboard_keysym(97, 1/0)
   ```
   **button(272) press/release 成对发出**，与 motion/keysym 同一连接、同一 FakeInput 对象。
3. **效果分化**（同连接！）：
   - `pointer_motion_absolute` ✅ 生效（KWin `workspace.cursorPos` 精确等于注入坐标）
   - `keyboard_keysym` ✅ 生效（AT-SPI SetFocus 聚焦后 type，输入框值读回一致，多次复现）
   - `button` ❌ 无效——**决定性实验**：点击 kdialog 标题栏关闭按钮（窗口装饰由 KWin
     直接处理，不经应用；button 生效则窗口必关）→ 窗口不关。首次点击（portal-kde
     重启后、全新 FakeInput device、pressedButtons 必为空）同样无效。
   - `axis`（continuous 与 discrete 均试）❌ 无可观察效果（测试时光标在可滚动区域上，
     目标窗口经 KWin 确认在前台）。

### 19.4 已排除的假设（全部有证据）

| 假设                                                            | 排除证据                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| button 编码错（应传 Qt 值 1 而非 evdev 272）                    | KWin `mousebuttons.cpp` 明确映射 BTN_LEFT(272)→Qt::LeftButton；且 portal XML 规定 evdev 编码  |
| portal-kde 版本差异（6.7.5 用旧 KWayland Qt::MouseButton 接口） | 拉 v6.7.5 tag 源码核对：与 master 相同的 quint32 透传；二进制符号含 QtWayland fake-input 类   |
| D-Bus/wl 层丢包                                                 | dbus-monitor + WAYLAND_DEBUG 双重观测，请求全部到达                                           |
| pressedButtons 状态机残留（历史未配对 press）                   | portal-kde 重启后**首次** click 即无效                                                        |
| 坐标错位/窗口遮挡/焦点不对                                      | 决定性实验点的是**标题栏关闭按钮**（KWin 装饰区、窗口经 KWin 脚本确认 active 且在最前）仍无效 |
| ashpd 参数序/序列化错                                           | ashpd 源码与官方 XML 逐参核对一致；keysym 同封装方式生效                                      |
| KWin 6.7.5 与 master 的 fakeinput 差异                          | v6.7.5 tag diff：button 路径零差异                                                            |

### 19.5 结论与 workaround ⚠️ 已被第 20 节推翻（button/axis 实际正常，是误判）

> **勘误**：本节「fake-input 的 button/axis 到达 KWin 后不产生效果」的结论错误。
> 真实原因是**测试窗口被 RustDesk 全屏窗口遮挡** + **截图裁剪用了过期窗口坐标**。
> 已用 kcalc 连续点击「七/八/九」得到 99→997→9978→99789 的决定性验证。见第 20.1 节。
> 下表「坐标级点击 ❌」「滚动 ❌」两行作废。

**结论**：在本机（KDE Plasma 6.7.5 / KWin 6.7.5 / xdg-desktop-portal-kde 6.7.5）上，
fake-input 的 button/axis 事件到达 KWin 后不产生效果，而同一设备同一连接的
motion_absolute/keyboard_keysym 正常。静态源码核对未发现缺陷，根因未定位
（疑 KWin 运行时问题，待上游 bug 报告/修复或 KWin 升级后复测）。KDE Bugzilla
检索（fake input / remote desktop / portal click）未找到已报告的相同问题。

**对 CUA 能力面的实际影响有限**，因为主交互路径不依赖 button 注入：

| 操作       | 主路径                                                                     | 状态                                                                                         |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 点击元素   | `element_perform_action`（AT-SPI AXPress/Press，D-Bus 直达，不经输入注入） | ✅ 已验证（FINAL-1 实验）                                                                    |
| 输入文本   | AT-SPI SetFocus/grab_focus 聚焦 + `keyboard_keysym` 注入                   | ✅ 已验证（TODAY-1/FINAL-1）                                                                 |
| 设值       | `element_set_value`（AT-SPI EditableText/Value）                           | ✅ 已验证                                                                                    |
| 移动光标   | `pointer_motion_absolute`                                                  | ✅ 已验证（cursorPos 精确）                                                                  |
| 激活窗口   | KWin scripting（stackingOrder 顶层）                                       | ✅ 已验证（ZCODE-ACTIVATED）                                                                 |
| 抓屏       | ScreenCast + PipeWire（gst-launch）                                        | ✅ 已验证（3840×2160 PNG）                                                                   |
| 坐标级点击 | portal button                                                              | ~~❌ 本机失效~~ **✅ 已验证正常**（99→997→9978→99789，见 20.1） |
| 滚动       | portal axis discrete                                                       | ~~❌ 本机失效~~ **✅ 已验证正常**（截图对比 2586px 变化，见 20.6） |

**工程决定**：

- `click`/`scroll` 保留现实现（协议正确、其它合成器/未来 KWin 版本可用），不做本机
  特判——button 无效是环境缺陷而非协议错误；spec 如实记录。
- agent 工作流应优先走元素级动作（这也正是 mac/win CUA 的推荐路径，坐标点击是兜底）。

### 19.6 坐标空间勘误（capture_app 契约）⚠️ 结论已修正，见第 20.3 节

> **勘误**：本节「AT-SPI Screen extents 实为窗口 client 区局部坐标」是**部分应用的**
> 行为，不是 KDE Wayland 的普遍规律。腾讯会议/VirtualBox 报真实屏幕坐标。
> 已改为逐窗口校合并如实标注 `coordinate_space` / `coordinate_source`。见第 20.3 节。

本轮同时确证：**KDE Wayland 的 AT-SPI `CoordType.Screen` extents 实为窗口 client 区
局部坐标**（kdialog/konsole/plasmashell 面板元素均以 (0,0) 或面板局部原点报告；
KWin 真实几何 (1464,814) 对照 AT-SPI (0,0)）。因此：

- `capture_app` 结果新增 `"coordinate_space": "window-local"` 字段如实声明；
- agent 若需按 bounds 换算屏幕点击坐标，须叠加窗口真实屏幕位置（KWin clientGeometry）；
- 完整修复（helper 内经 KWin 几何配准把 bounds 转成屏幕坐标）与 `element_at_point`
  配准是同一件事，留待后续（见 18.7）。

### 19.7 本轮方法论教训

1. **「返回 ok」≠「生效」**：portal 全链 fire-and-forget，每层都可能在下游静默丢弃。
   验证注入类能力必须设计**有确定性可观察效果**的实验（如点标题栏关闭按钮）。
2. **对照组污染**：多个同名测试窗口（kdialog×2 重叠）导致读回错误对象，浪费两轮。
   测试载体必须唯一且可判别（caption 带唯一 token）。
3. **版本核对**：对照源码必须拉**与本机同版本的 tag**（v6.7.5），master 可能已变。
4. `pkill -f` 会匹配到执行命令的 shell 自身 cmdline（本轮再次踩中，exit 143）；
   `pkill -x` 对 >15 字符进程名因 comm 截断而失效。一律 `pgrep -af | grep -v pgrep`
   人工过滤后按 pid 杀。

## 20. 坐标点击与坐标空间：最终结论（2026-10-26，推翻第 18.7 / 19.5 / 19.6 节）

本节修正前文 8.7 / 16 节的多处错误判断。所有结论均经官方源码 + 可复现实验确认。

### 20.1 坐标点击本身完全正常（此前「失效」是误判）

错误的排除过程：
1. 以为 button 编码错 → KWin `mousebuttons.cpp` 的 `buttonToQtMouseButton()` 明确把
   `BTN_LEFT(272)` 映射为 `Qt::LeftButton`；portal XML 也定义了 evdev 编码。
2. 以为 portal-kde 版本差异 → 拉 `xdg-desktop-portal-kde` v6.7.5 tag 与 master 对比，
   button/motion/axis 路径零差异；`FakeInput` 用 Qt 生成的
   `QtWayland::org_kde_kwin_fake_input`，参数为 `quint32 linuxButton`，直通。
3. 以为 KWin 事件过滤器吞事件 → 逐一核对 `EisInputCaptureFilter`（需 activeCapture，
   本机无）、`MouseKeysPlugin`（只处理键盘）、`EffectsFilter`（m_grabbedMouseEffects 为空）。
4. 以为 D-Bus/wl 丢包 → dbus-monitor + WAYLAND_DEBUG 证明请求全部到达并发出。

**真正的两次误判原因**：
- 第一次：目标窗口（kcalc）被 **RustDesk 全屏窗口完全覆盖**；`activate_window_at`
  按「视觉一致」语义正确激活了 RustDesk，点击自然打到 RustDesk 上。
- 第二次：截图裁剪用了**过期的窗口坐标**（KWin 之后移动了 kcalc），裁错了区域。

**最终验证**（kcalc，置于最顶层）：连续点击「七」「八」「九」，显示区从 `99` 依次变为
`997` → `9978` → `99789`。**坐标点击、motion_absolute、button 全链路正常。**

### 20.2 显示缩放（DPR）是必须处理的真实差异

本机：KWin 逻辑尺寸 `3072×1728`，`devicePixelRatio = 1.25`，portal ScreenCast 上报
`size = (3072, 1728)`（逻辑），而抓帧 PNG 为 `3840×2160`（物理/raster）。

**因此：从截图量出的像素坐标必须除以 `scale` 才是逻辑坐标**（注入、AT-SPI bounds、
KWin 几何全部是逻辑坐标）。`screenshot` 方法现在返回：

```json
{"raster_size":[3840,2160], "logical_size":[3072,1728], "scale":1.25,
 "coordinate_note":"screenshot pixels are physical (raster) pixels; divide by `scale` ..."}
```

### 20.3 AT-SPI 坐标不是「一律局部」也不是「一律屏幕」，须逐窗口校准

实测（同一时刻对比 KWin `clientGeometry`）：

| 应用 | AT-SPI 窗口 extents | KWin clientGeometry | 性质 |
|---|---|---|---|
| 腾讯会议 | (1203,639,722,482) | (1203,639,722,482) | 真实屏幕坐标 |
| VirtualBox | (837,346,1536,864) | (836.8,345.6,1536,864) | 真实屏幕坐标（≈client） |
| rustdesk | (0,0,300,490) | (1414,634,300,490) | 局部坐标（原点 0,0） |
| phone-cam-manager | (0,0,820,720) | (779,794,820,720) | 局部坐标 |
| kcalc | (0,0,640,480) | (1477,697,640,480) | 局部坐标 |

并且**同一应用内也可能混用**（wemeetapp 有元素报 (0.2,0.2) 也有报 (1828,640)）。
另外 AT-SPI 用 `INT_MIN` 表示「位置未知」，这类元素的 bounds 必须置 null。

**实现**：`capture_app` 按 **pid + 尺寸匹配** 找到对应 KWin 窗口，用
`offset = kwin.client_origin − atspi_window_origin` 平移所有元素 bounds；
尺寸不匹配则不做校正，并在响应里标 `coordinate_space: "atspi-raw"` /
`coordinate_source: "none"`，让调用方知道 bounds 不可直接用于点击。
校正成功时标 `coordinate_space: "screen"` / `coordinate_source: "kwin-client-geometry"`。

### 20.4 AT-SPI 调用必须有超时（否则 capture 会挂死）

部分应用的 accessible 节点永不回 D-Bus（实测 rustdesk 的应用根节点）。**无超时会
让整次 capture_app 挂 100s+**。已给所有 AT-SPI 调用加 1.5s 超时（`timed()`），
超时元素跳过而非中断整棵树。同时 `journalctl` 调用加 `timeout 2` 硬兜底（它在
systemd service cgroup 里曾阻塞 110s）。

### 20.5 Helper 单实例保护

`ensureLinuxCuaHelper` 原先在 spawn 前 `rm(socketPath)`。若 `probeHelperSocket`
因 500ms 超时误判，会删掉仍在服务的旧 helper 的 socket 再起新的，导致 helper 泄漏
（实测同时存在两个进程）。修复：父进程不再删 socket；helper 自身用
`flock(<socket>.lock, LOCK_EX|LOCK_NB)` 做单实例保护，抢不到锁直接退出（退出码 0）。
已验证：第二个实例立即退出且不影响第一个。

### 20.6 滚动（axis）同样正常

针对第 19.5 节「axis 无效」的结论，用 KWrite（200 行文本）复测：

- 点击文本区聚焦 → `scroll(direction=down, amount=30)` ×3 → 截图对比文本区
  **2586 个像素发生变化**（对照组 PageDown 仅 45px）；
- 目视确认：起始行从 `LINE 003` 变为 `LINE 005`，滚动真实生效。

`scroll` 现用 `NotifyPointerAxisDiscrete`（整数步进，与真实滚轮一致），
`amount` 按 `round(amount/10)` 换算为步数并 clamp 到 1..10。

**注意**：不要用 AT-SPI 的 `text` 元素 `value` 判断滚动位置——它返回的是整个文档的
缓存内容（长度上限 4096），不随视口移动。判断可见内容变化必须用截图对比。

### 20.7 窗口遮蔽的正确语义

`activate_window_at(x, y)` 按 `stackingOrder`（顶→底）激活「视觉上覆盖该点」的最顶层
窗口——这是正确行为。**若目标元素被其他窗口遮挡，坐标点击必然打到遮挡窗口**；
调用方应先用 `capture_app` 拿到元素 bounds 并确认目标窗口可见，或改用元素级动作
（`element_perform_action` / `element_set_value`，走 AT-SPI D-Bus，不依赖坐标与焦点）。

## 21. 补齐 drag / element_scroll / hold_key / cancel_input_holds

第 20 节之后仍 fail-closed 的四个方法在本节补齐。契约全部来自闭源
`zcode-node-repl-host/dist/mcp/server.js` 的实际调用点（不是推测）：

| 方法 | params | 调用点 |
|---|---|---|
| `drag` | `{start:{x,y}, end:{x,y}, modifiers, app_ref?, frame_provenance?}` | `leftClickDragTool` 114254-114275 |
| `element_scroll` | `{native, direction, amount}` | `scrollTool` 114122-114132（仅 `strategy!=="event"` 且有 native 时） |
| `hold_key` | `{text, duration, session_key}` | 114943-114955 |
| `hold_key_to_app` | 同上 + `{app_ref, strategy?}` | 同上（`hasAppRef` 时） |
| `cancel_input_holds` | `{session_key}` | `callBrokerControl`（**另一条 broker 连接**，2s 超时） |

### 21.1 `element_scroll`：走 AT-SPI 滚动条动作

Qt/KDE **不实现 `Component.ScrollTo`**（实测对所有层都返回
`atspi_error: No such object path`）。可行路径是**滚动条动作**：在目标元素所在滚动容器内
找 `scroll bar` 兄弟节点，调用其 `Increase` / `Decrease`：

- 目标元素自身可能就是 scroll bar；否则向上最多找 4 层，逐层检查子节点角色；
- 朝向用 `extents` 判定（高 > 宽 = 竖直），`direction=up/down` 用竖直条、`left/right` 用水平条；
- `amount`(0..100) → 动作重复次数 `clamp(round(amount/10), 1, 10)`。

实测（KWrite 200 行）：6 次 `Increase` 使文本区产生 1911 像素变化。

### 21.2 `drag`：portal 按下 → 分步移动 → 抬起

`NotifyPointerMotionAbsolute` 到起点 → `NotifyPointerButton(BTN_LEFT, Pressed)` →
12 步插值移动（每步 16ms）→ `Released`。修饰键（mac 命名 cmd/opt/ctrl/shift）
映射为 keysym（super/alt/ctrl/shift），全程按住、结束倒序释放。

实测：拖 KWrite 标题栏 (1564,640)→(1200,500)，窗口从 (1554,786) 移动到 (1101,594)，
位移方向与量级完全一致。

### 21.3 `hold_key` 与 `cancel_input_holds`：跨连接取消

`hold_key` 按下 keysym → 分片等待（每 50ms 检查取消标志）→ 释放。
`cancel_input_holds` 来自**另一条 broker 连接**（BrokerClient 每次 `call` 都新建
`PermissionBrokerClient`），因此用 `static AtomicBool` 做跨线程/跨连接通信，
helper 的「每连接独立线程」模型正好支持。

实测：10 秒 hold 在 1.5 秒时被另一连接取消，立即返回 `cancelled`（<0.05s）。

### 21.4 `hold_key_to_app`：Linux 无 pid 定向键盘

Wayland 的 `keyboard_keysym` 只送 **seat 焦点窗口**，没有 per-app 定向通道。
等价实现 = 先用 KWin 脚本按 pid 把目标窗口提到前台，再注入；无法前置则
**fail-closed**（绝不把按键发给错误窗口）。

实测：不存在的 pid 正确返回 `no window for pid 999999`；真实 pid 连续 3 次成功。

### 21.5 `scroll` 的真实语义：像素级 delta（重要修正）

第 20.6 节说「用 `NotifyPointerAxisDiscrete`，amount 按 round(amount/10) 换算步数」——
**这个结论是错的**，本轮实测推翻。

根因在 KWin `src/wayland/pointer.cpp::PointerInterface::sendAxis`：

```cpp
if (deltaV120) {
    updateAccumulators(...);          // 高精度滚轮（120 基准）
} else {
    valueAxisLowRes = delta;          // ← fakeinput 永远走这里
}
...
} else {
    // Finger or continuous scroll
    d->send_axis(resource, timestamp, orientation, wl_fixed_from_double(delta));
}
```

`fakeinputbackend.cpp` 恒传 `deltaV120 = 0`，因此 KWin 把 axis 当作
**finger/continuous scroll 的像素级 delta**，而不是滚轮格数。
`steps=3` 只等于 3 像素——肉眼完全不可见，这才是「axis 无效」的真正原因
（第 19.5 节的「KWin 缺陷」结论已在第 20 节撤回，本节补上机制解释）。

修复：`amount`(0..100) → 像素 delta `amount * 40`（amount=10 ≈ 400px）。
实测 amount=44 → 文本区 6406 像素变化，反向 3942 像素变化。

### 21.6 KWin 脚本读回的三个坑

1. **fixed marker + journal 时间窗 = 读到上一次的输出**。`journalctl --since @t` 是
   全局的，同进程/前进程的同名 marker 会串。修复：marker 带 `pid + nanos` nonce。
2. **`start` 是异步的**，固定 `sleep(200ms)` 在高负载下会漏读。修复：最多轮询 2 秒
   （150ms 起，每 200ms 一次），出现 marker 立即返回。
3. **`unloadScript` 传的是脚本 id**（不是路径），且必须在读完之后调用。

`activate_window_at` 同时从「fire-and-forget 返回 Some(true)」改为读回真实结果
（`ACTIVATED`/`WASACTIVE`/`NOTFOUND`），使 `click` 的窗口激活可验证。

### 21.7 验证矩阵

全部 23 个方法在真实生产 socket 上逐项通过（kwrite / plasmashell / krunner 真实应用）：

```
authenticate ✅  broker_info ✅  list_applications ✅(5 apps)  capture_app ✅(663 elements)
list_windows ✅(20)  application_info ✅  element_at_point ✅  element_perform_action ✅
element_set_value ✅  element_select_text ✅  move_pointer ✅  click ✅
scroll ✅  element_scroll ✅  drag ✅  key ✅  type ✅  hold_key ✅
hold_key_to_app ✅  cancel_input_holds ✅  screenshot ✅  permission_status ✅
ping ✅  未知方法正确 fail-closed ✅
```
