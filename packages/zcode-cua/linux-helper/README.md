# cua-linux-helper

Linux 版 Computer Use **permission broker Helper**。mac/win 各有原生 Helper（mac app / win
安装包 runtime），Linux 没有对应产物；本目录提供一个 Rust 实现，扮演同一角色。

## 它在链路里的位置

```
agent 子进程 (zcode-node-repl-mcp, 闭源)
  └ BrokerClient ──unix socket + NDJSON──▶ cua-linux-helper
       (ZCODE_CUA_PERMISSION_BROKER_SOCKET)   ├ authenticate / broker_info
                                              ├ list_applications / capture_app (AT-SPI 读树)
                                              └ 后续：click/type/screenshot (xdg-desktop-portal)
```

服务端 `packages/services/src/cua-permission-broker/linuxCuaHelper.ts` 在
`process.platform === "linux"` 且 CUA 插件启用时按需 spawn 本二进制，并把其 socket
经 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` 注入 agent 的 spawn env——与 mac/win 完全同构，
区别只是「谁提供 Helper 进程」。

## 线协议（与 PermissionBrokerClient 对齐，CUA_BROKER_IPC_VERSION=3）

NDJSON，每行一条消息：

- 首帧 `{"id":0,"method":"authenticate","params":{"clientApiVersion":3}}` → `{"id":0,"ok":true}`
- 业务 `{"id":N,"method":"<method>","params":{...}}` → `{"id":N,"ok":true,"result":<...>}` 或 `{"id":N,"ok":false,"error":"..."}`
- 必须应答 `broker_info`（Helper 启动看门狗的 claim 探针）

已实现方法：

| method | 说明 |
|---|---|
| `authenticate` / `broker_info` / `ping` | 握手/探活 |
| `list_applications` | 返回**裸 JSON 数组** `[{name,pid,active,bundle_id,aumid}]` |
| `capture_app` | 返回 `{snapshot_mode,app,window,elements[],content}`（AT-SPI 读树） |
| `list_windows` | 占位（后续补） |

`capture_app` 的 `elements[]` 每项字段对齐 node-repl-host 的 `asElements`：
`role,kind,title,value,bounds([x,y,w,h] 全局逻辑坐标),enabled,editable,actions,focused,default_action,pressable,has_menu,native,owner_pid,depth`。

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

## 依赖

- AT-SPI2（`at-spi2-core`，读无障碍树）
- 后续抓屏/注入需要 `xdg-desktop-portal` + `xdg-desktop-portal-kde`（Wayland）

## 当前状态

- ✅ `list_applications` / `capture_app`（只读，零授权，纯 AT-SPI）
- ⏳ 抓屏（ScreenCast）、输入注入（RemoteDesktop）、click/type 等动作：待实现（需 portal 授权）
