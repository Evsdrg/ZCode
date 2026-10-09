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

| 变量                                       | 用途                                     |
| ------------------------------------------ | ---------------------------------------- |
| `PORT`                                     | Host监听端口，默认3030                   |
| `ZCODE_SERVER_HOST`                        | 监听地址；避免不必要的公网暴露           |
| `ZCODE_SERVER_AUTH_TOKEN`                  | Host API/WS认证令牌                      |
| `ZCODE_SERVER_WORKSPACE`                   | 初始本机工作区                           |
| `ZCODE_WEB_STATIC_ROOT`                    | 可选静态根；分离部署时不设置             |
| `ZCODE_AGENT_SERVER_COMMAND`               | Agent启动程序                            |
| `ZCODE_AGENT_SERVER_ARGS_JSON`             | Agent参数JSON数组                        |
| `ZCODE_SERVER_BROWSER_USE=headless`        | 显式开启托管浏览器；默认不启动           |
| `ZCODE_SERVER_BROWSER_ENGINE`              | `chromium`（默认）、`firefox` 或 `both`  |
| `ZCODE_SERVER_BROWSER_EXECUTABLE`          | 旧单路径；双模式仅交给 Chromium          |
| `ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE` | Chromium 专用绝对路径，优先于旧路径      |
| `ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE`  | Firefox 专用绝对路径，双模式不继承旧路径 |
| `ZCODE_DATA_BASE_DIR`                      | 隔离数据根；其中保存`.zcode`运行状态     |

`IPromptAttachmentTransferService`通用上传在entry-http启用，完整文件保存在Host数据根的`.zcode/attachments/prompt-files`，单文件<=20MiB，原始字节不写入Git。

## 托管 Firefox

Firefox 使用仓库锁定版本的 Playwright 配套制品，不使用普通系统 Firefox，也不接管用户 profile。先从仓库根安装对应浏览器；禁止安装过程回收其它运行中浏览器的缓存：

```bash
PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm --filter @zcode/server exec playwright-core install firefox
```

在 Host 的部署环境中配置：

```bash
ZCODE_SERVER_BROWSER_USE=headless
ZCODE_SERVER_BROWSER_ENGINE=firefox
```

若原部署固定了 `ZCODE_SERVER_BROWSER_EXECUTABLE` 为 Chromium，必须移除该变量以使用配套默认路径，或改为已安装的 Playwright Firefox 路径。不能只改 engine 而保留 Chromium 路径。缺省 engine 仍是 Chromium；无效值拒绝启动；Firefox 缺失或启动失败不会回退另一引擎。

浏览器本体不随 fork 分发，系统库依赖由部署方维护。Playwright 不正式支持的发行版可能使用 fallback 制品，应通过真实集成测试确认，不能仅凭下载成功宣称可用。

```bash
ZCODE_BROWSER_INTEGRATION=1 pnpm --filter @zcode/server test:browser
```

该测试运行 Chromium 和 Firefox；可用 `ZCODE_TEST_CHROMIUM_EXECUTABLE` / `ZCODE_TEST_FIREFOX_EXECUTABLE` 指定配套路径。另设 `ZCODE_TEST_BROWSER_CLIENT_MODULE` 为本机已安装的 Browser Use 插件 `scripts/browser-client.mjs` 绝对路径，可验收真实 SDK 的双引擎 discovery、默认/显式 ID 选择、role locator、状态隔离和截图；插件不在仓库时该项跳过。这是 SDK/Host 集成验收，不是模型驱动的闭源 Agent 端到端验收。

配置在 Host 下次启动时生效。无需重新发布 WebUI；由独立终端执行 Host 重启，不让运行中的 Agent 自行重启宿主。

## 双引擎与 AI 选择

将 `ZCODE_SERVER_BROWSER_ENGINE` 设为 `both`，Host 同时提供两个托管引擎。为两个引擎分别配置兼容制品路径（可省略以使用配套默认路径）：

```bash
ZCODE_SERVER_BROWSER_USE=headless
ZCODE_SERVER_BROWSER_ENGINE=both
ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE=/path/to/playwright/chromium
ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE=/path/to/playwright/firefox
```

旧 `ZCODE_SERVER_BROWSER_EXECUTABLE` 在双模式只属于 Chromium，专用 Chromium 路径优先于它；Firefox 不继承旧路径。若旧路径之前指向 Firefox，应移除或改用专用变量。

AI 在 Browser Use 初始化后先调用 `agent.browsers.list()`，只从真实返回的 ID 中选择，再调用 `agent.browsers.get(id)`；当前 ID 分别为 `server-headless-chromium`、`server-headless-firefox`。两个引擎的兼容 type 都是 `cdp`，不要用 `get("cdp")` 区分。选择后使用该 browser 的 tabs 接口，不调用会重新选择默认引擎的顶层 `agent.browsers.open()`。

列表 metadata 中的 `selectionPolicy` 是模型可读建议：用户指定优先，继续任务保持原 ID，新任务未指定优先 Chromium；Firefox 专项或跨引擎验证可明确选 Firefox。它不是 SDK 内置自动决策，也不保证模型总会遵守。普通超时或 fresh kernel 不应触发换引擎；切换不共享登录/标签页，不自动重放有副作用操作。

首次 discovery 会尝试启动两者以确认可用，所以双模式可能同时占用两个浏览器的资源。一侧不可用不阻断另一侧；指定不可用引擎的命令失败，不改发另一侧。运行中的 Host 不热切换配置，仍由独立终端重启后生效。

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
