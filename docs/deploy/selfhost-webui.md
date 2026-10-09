# 自部署 WebUI：部署边界与更新

状态：现行；本文件只描述通用部署方式，不包含实际主机、账号、网络地址或凭据。

## 拓扑与所有者

```text
浏览器 ─ HTTPS/认证 ─ edge-proxy
                      ├─ 本地静态WebUI产物
                      └─ API/WebSocket代理 ─ SSH反向隧道 ─ 本机Host
                                                        ├─ services/SQLite/附件
                                                        └─ Agent app-server --stdio
```

- edge-proxy：部署方维护的反代，不属于本仓库；负责TLS、认证、静态资源和转发，不保存任务/会话业务状态。
- 本机Host：`packages/server/dist/entry-http.js`，负责服务装配与Agent生命周期。
- Agent：独立协议后端。可以通过 `ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON` 接入部署方安装的兼容Agent；本fork不分发闭源制品。
- 静态WebUI与Agent的版本独立；界面里的WebUI版本不是Agent版本。
- 真正的文件操作、任务索引和附件落盘发生在Agent所在环境，不在edge-proxy。

使用反向隧道是为了支持Host位于NAT之后或没有允许入站的网络。虚拟组网能ping通，不代表任意TCP端口可达；应以实际TCP连接测试决定是否可省略隧道，而不能仅凭网络名称判断。

## 配置

只在部署机配置环境变量，不把真实值提交Git：

| 变量                                | 用途                                 |
| ----------------------------------- | ------------------------------------ |
| `PORT`                              | Host监听端口，默认3030               |
| `ZCODE_SERVER_HOST`                 | 监听地址；避免不必要的公网暴露       |
| `ZCODE_SERVER_AUTH_TOKEN`           | Host API/WS认证令牌                  |
| `ZCODE_SERVER_WORKSPACE`            | 初始本机工作区                       |
| `ZCODE_WEB_STATIC_ROOT`             | 可选静态根；分离部署时不设置         |
| `ZCODE_AGENT_SERVER_COMMAND`        | Agent启动程序                        |
| `ZCODE_AGENT_SERVER_ARGS_JSON`      | Agent参数JSON数组                    |
| `ZCODE_SERVER_BROWSER_USE=headless` | 显式开启托管Chromium；默认不启动     |
| `ZCODE_SERVER_BROWSER_EXECUTABLE`   | 可选的已安装Chromium绝对路径         |
| `ZCODE_DATA_BASE_DIR`               | 隔离数据根；其中保存`.zcode`运行状态 |

`IPromptAttachmentTransferService`通用上传在entry-http启用，完整文件保存在Host数据根的`.zcode/attachments/prompt-files`，单文件<=20MiB，原始字节不写入Git。

## 安全边界

- Host保留局域网Web模式的query-token/cookie认证方式；公网部署应在反代统一加认证，检查HTTP和WebSocket upgrade不能绕过。
- `edge-proxy.mjs`、认证失败限流、TLS证书、systemd单元和更新服务由部署方提供，不要误认为源码中存在这些实现。
- 生产Web构建不输出sourcemap。静态目录仅同步生产dist，不同步仓库、配置文件或数据根。
- 若公开部署保留 `/updates` 或 `/api/updater`，必须经过认证与TLS。更新权限取决于部署方的updater实现；本fork不新增或移除这些入口。
- 配对链接包含远控凭证，不写入日志、文档或issue；重置配对撤销旧链接。
- 托管浏览器能访问Host可达的网络，包括本机服务；必须理解这一信任边界再启用。

## 构建和发布

从仓库根执行，Node与pnpm使用`mise.toml`规定版本：

```bash
ZCODE_ENV=production pnpm --filter @zcode/server build
ZCODE_ENV=production pnpm --filter @zcode/web build
```

同机部署可由Host服务`ZCODE_WEB_STATIC_ROOT`提供静态资源。分离部署可将静态产物同步到edge-proxy的专用目录：

```bash
# DEPLOY_SSH、WEB_ROOT由部署环境提供；不要将真实值写回文档。
rsync -a --delete --exclude='*.map' packages/web/dist/ "$DEPLOY_SSH:$WEB_ROOT/"
```

同步前备份现有产物，确认目标是专用静态目录。rsync排除项也会被`--delete`保护，历史`.map`应在核实目标后单独清理。若反代缓存资源，按其实际缓存策略更新，不假定重启是唯一办法。

Host源码改动需要重建并重启Host；静态UI改动需要重新发布静态产物。Agent制品更新是另一项操作，不能用WebUI版本推断Agent是否更新。

**不要让运行在Host内的Agent重启自身宿主。** 在独立终端按实际systemd单元手工重启；Git发布不会修改运行中的服务。

## 不重启主服务的验收

- 用临时目录及`ZCODE_DATA_BASE_DIR`启动独立实例，监听localhost上的备用端口。
- 使用合成任务、附件和测试配置；不得复制真实凭据到副本。若确需复制数据快照，副本启动前去除`credentials.json`，防止共享relay设备身份互踢。
- 使用相同生产Web产物经localhost反代验收，检查任务列表、归档、附件校验与恢复。
- 退出独立实例后清理只属于本次验收的文件；不要按宽泛进程名停止主服务。

## Git边界

公共维护决策见`docs/maintenance/selfhost-fork.md`。真实部署地址、私有拓扑、日志、抓包和手工迁移记录保存于被忽略的`.local/`或`docs/local/`，不随源码发布。外部服务配置、数据库中的一次性修正及闭源Agent换装不属于可移植源码补丁。
