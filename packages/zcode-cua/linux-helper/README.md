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
| `capture_app` | `{snapshot_mode,app,window,elements[],content,coordinate_space,coordinate_source,bounds_note}` | AT-SPI + KWin 几何校准 |
| `list_windows` | `{items:[{index,title,bounds,pid,app_name,...}]}` | AT-SPI |
| `application_info` | `{name,pid,...}` | AT-SPI |
| `element_at_point` | 屏幕坐标 → 元素 native token（双坐标空间尝试） | AT-SPI + KWin |
| `element_perform_action` | 元素级动作（`Press`/`SetFocus`/…；自动归一 `AXPress`→`Press`） | AT-SPI |
| `element_set_value` | 设值（EditableText / Value） | AT-SPI |
| `element_select_text` | 选文本（`text_range:[start,end]`） | AT-SPI |
| `move_pointer` | 绝对移动光标 | portal RemoteDesktop |
| `click` | `point{x,y}` + `button`(left/right/middle) + `clicks` | portal RemoteDesktop |
| `scroll` | `direction`(up/down/left/right) + `amount`(0-100，按 10 折算步数) | portal（discrete） |
| `key` | 组合键字符串，如 `ctrl+a` / `return` / `shift+tab` | portal |
| `type` / `paste` | 文本 → keysym 序列（仅 ASCII，非 ASCII fail-closed） | portal |
| `screenshot` | PNG + `{raster_size,logical_size,scale,coordinate_note}` | portal ScreenCast |
| `permission_status` | `{accessibility,screen_recording,grant_owner,needs_grant}` | portal |
| `request_access` | 主动触发 portal 授权（一次弹窗，之后凭 app_id 记忆） | portal |
| `reset_access` | 撤销授权并清 restore_token | portal |

未实现（fail-closed `action_unavailable`）：`drag`、`element_scroll`、`hold_key`、`hold_key_to_app`。

### 坐标契约（重要）

- `capture_app.elements[].bounds` 是**逻辑像素的屏幕坐标**，可直接作为 `click.point`。
- 若 AT-SPI 报的是窗口局部坐标，helper 会用 KWin `clientGeometry` 自动校准，并在
  响应里标 `coordinate_space: "screen"` / `coordinate_source: "kwin-client-geometry"`；
  校准不了时标 `"atspi-raw"` / `"none"`，此时 bounds **不可直接用于点击**。
- `INT_MIN`（位置未知）与零尺寸元素的 `bounds` 为 `null`。
- **`screenshot` 的像素是物理（raster）像素**，桌面缩放 1.25 时 3072×1728（逻辑）会
  得到 3840×2160 的 PNG。**从截图量出的坐标必须除以 `scale`**。

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
- ⏳ `drag` / `element_scroll` / `hold_key` / `hold_key_to_app` 未实现（fail-closed）
