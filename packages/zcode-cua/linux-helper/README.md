# cua-linux-helper

Linux 版 Computer Use **permission broker Helper**。mac/win 各有原生 Helper（mac app / win
安装包 runtime），Linux 没有对应产物；本目录提供一个 Rust 实现，扮演同一角色。

## 它在链路里的位置

```
agent 子进程 (zcode-node-repl-mcp, 闭源)
  └ BrokerClient ──unix socket + NDJSON──▶ cua-linux-helper
       (ZCODE_CUA_PERMISSION_BROKER_SOCKET)   ├ authenticate / broker_info
                                              ├ list_applications / capture_app  (AT-SPI 读树，零授权)
                                              ├ element_*                        (AT-SPI 元素级动作，零授权)
                                              └ click / scroll / key / type / screenshot (portal，需授权)
```

服务端 `packages/services/src/cua-permission-broker/linuxCuaHelper.ts` 在
`process.platform === "linux"` 且 CUA 插件启用时按需 spawn 本二进制，并把其 socket
经 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` 注入 agent 的 spawn env——与 mac/win 完全同构，
区别只是「谁提供 Helper 进程」。

## 线协议（与 PermissionBrokerClient 对齐，CUA_BROKER_IPC_VERSION=3）

NDJSON，每行一条消息：

- 首帧 `{"id":0,"method":"authenticate","params":{"clientApiVersion":3}}` → `{"id":0,"ok":true}`
- 业务 `{"id":N,"method":"<method>","params":{...}}` → `{"id":N,"ok":true,"result":<...>}` 或 `{"id":N,"ok":false,"error":{message,code,details}}`
- 必须应答 `broker_info`（Helper 启动看门狗的 claim 探针）

### 方法清单

| method | 说明 | 依赖 |
|---|---|---|
| `authenticate` / `broker_info` / `ping` | 握手 / 探活 | — |
| `list_applications` | 裸 JSON 数组 `[{name,pid,active,bundle_id,aumid}]` | AT-SPI |
| `capture_app` | `{snapshot_mode,app,window,elements[],content,coordinate_space,coordinate_source,bounds_note}`；`include_screenshot=true` 时额外返回 `screenshot/pointer/display/coordinate_contract` | AT-SPI + KWin 几何校准 + portal ScreenCast（仅截图时）|
| `list_windows` | `{items:[{index,title,bounds,pid,app_name,...}]}` | AT-SPI |
| `application_info` | `{name,pid,...}` | AT-SPI |
| `element_at_point` | 屏幕坐标 → 元素 native token（双坐标空间尝试） | AT-SPI + KWin |
| `element_perform_action` | 元素级动作（`Press`/`SetFocus`/…；自动归一 `AXPress`→`Press`） | AT-SPI |
| `element_set_value` | 设值（EditableText / Value） | AT-SPI |
| `element_select_text` | 选文本（`text_range:[start,end]`） | AT-SPI |
| `move_pointer` | 绝对移动光标 | portal RemoteDesktop |
| `click` | `point{x,y}` + `button`(left/right/middle) + `clicks` | portal RemoteDesktop |
| `scroll` | 坐标滚动：`point{x,y}` + `direction` + `amount`(0-100 → 像素 delta) | portal（权授权）|
| `element_scroll` | 元素滚动：`native` + `direction` + `amount`(0-100 → 滚动条动作次数) | AT-SPI（零授权）|
| `key` | 组合键字符串，如 `ctrl+a` / `return` / `shift+tab` | portal |
| `type` / `paste` | 文本 → keysym 序列（仅 ASCII，非 ASCII fail-closed） | portal |
| `screenshot` | PNG + `{raster_size,logical_size,scale,coordinate_note}` | portal ScreenCast |
| `permission_status` | `{accessibility,screen_recording,grant_owner,needs_grant}` | portal |
| `request_access` | 主动触发 portal 授权（一次弹窗，之后凭 app_id 记忆） | portal |
| `drag` | `start{x,y}` → `end{x,y}` + 可选 `modifiers`(cmd/opt/ctrl/shift；Linux 映射 super/alt/ctrl/shift) | portal |
| `hold_key` | `text` + `duration`(0..30s) + `session_key`；可按 Esc 等长按 | portal |
| `hold_key_to_app` | 同上 + `app_ref{pid}`；Linux 无 pid 定向键盘，先 KWin 前置目标窗口，失败即 fail-closed | portal + KWin |
| `cancel_input_holds` | `session_key`；从另一条 broker 连接打断进行中的 hold | — |
| `reset_access` | 撤销 portal 授权并清 restore_token | portal |

全部 23 个方法均已实现，无 fail-closed 占位。

### 坐标契约（重要）

- `capture_app.elements[].bounds` 是**逻辑像素的屏幕坐标**，可直接作为 `click.point`。
- `capture_app.window.bounds` 与元素 bounds **同坐标系**（也经过 KWin clientGeometry
  校准）。两者必须一致：闭源 `node-repl-host` 的 `visibleElementCenter()` 用
  `window.bounds` 裁剪元素 bounds 判定「元素是否在窗口内」，坐标系混用会让**全部元素
  被判为窗口外**，坐标点击全部失效。
- 若 AT-SPI 报的是窗口局部坐标，helper 会用 KWin `clientGeometry` 自动校准，并在
  响应里标 `coordinate_space: "screen"` / `coordinate_source: "kwin-client-geometry"`；
  校准不了时标 `"atspi-raw"` / `"none"`，此时 bounds **不可直接用于点击**。
- 位置未知（AT-SPI `INT_MIN`）与零尺寸元素的 `bounds` 是 **`[0,0,0,0]`，不是 `null`**：
  闭源 `asElements()` 的 `asBounds2()` 对非 4 数字数组直接 throw，一个 `null` 就会让整次
  `capture_app` 失败、模型连树都拿不到。零宽高在闭源侧天然被当作不可点击。
- **`screenshot` 的像素是物理（raster）像素**，桌面缩放 1.25 时 3072×1728（逻辑）会
  得到 3840×2160 的 PNG。**从截图量出的坐标必须除以 `scale`**。
- `capture_app(include_screenshot=true)` 返回的 `pointer = {x,y,width,height,unit}` 描述
  **裁剪后 raster 对应的屏幕逻辑矩形**（不是光标位置），配合
  `coordinate_contract: "frame_pixel_projection_v1"` 让闭源侧把帧标为 actionable。
- 截图前会临时把目标窗口 `keepAbove` 并激活（Wayland portal 是整屏流，被遮住的区域
  剪出来是遮挡者）；**最小化窗口直接报错**，不会把桌面壁纸当作它的截图返回。

## 构建与安装

```bash
cd packages/zcode-cua/linux-helper
cargo build --release
sudo install -m 0755 target/release/cua-linux-helper /usr/local/bin/cua-linux-helper
```

服务端 `linuxCuaHelper.ts` 按以下顺序查找二进制：
`$ZCODE_CUA_LINUX_HELPER_BIN` → `dirname(process.execPath)/cua-linux-helper` →
`/usr/local/bin/cua-linux-helper` → `/usr/bin/cua-linux-helper`。

环境变量：
- `ZCODE_CUA_LINUX_HELPER_DISABLE=1`：禁用（CUA fail-closed）
- `ZCODE_CUA_LINUX_HELPER_SOCKET`：覆盖 socket 路径（默认 `/tmp/zcode-cua-linux-helper-<uid>.sock`）

**单实例**：helper 启动时对 `<socket>.lock` 取 `flock(LOCK_EX|LOCK_NB)`；已有实例在服务
时新实例立即退出（退出码 0），避免父进程 probe 超时误判造成的进程泄漏。

## 依赖

- AT-SPI2（`at-spi2-core`）——读无障碍树、元素级动作
- `xdg-desktop-portal` + `xdg-desktop-portal-kde`——抓屏（ScreenCast）与输入注入（RemoteDesktop）
- `gst-launch-1.0`（gstreamer，`pipewiresrc`/`videoconvert`/`pngenc`/`filesink`）——抓帧
- KWin（可选）——窗口几何校准与窗口激活；非 KWin 合成器自动降级

## 当前状态

- ✅ AT-SPI：读树、元素级动作、设值、选文本、命中测试
- ✅ portal：抓屏（PNG，带 scale 元信息）、光标移动、点击、滚动、键盘、文本
- ✅ 授权：`request_access` 一次弹窗 + app_id 记忆，`permission_status` 真值化
- ✅ KWin：窗口几何校准、按坐标激活顶层窗口
- ✅ 全部方法已实现并实测通过
