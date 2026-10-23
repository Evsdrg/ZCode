# 自部署 WebUI：部署边界与更新

状态：现行；本文件只描述通用部署方式，不包含实际主机、账号、网络地址或凭据。

## 拓扑与所有者

```text
浏览器 ─ HTTP 直连虚拟组网地址:3030 ─ 本机Host
                                        ├─ 静态WebUI产物（ZCODE_WEB_STATIC_ROOT）
                                        ├─ services/SQLite/附件
                                        └─ Agent app-server --stdio
```

- 本机Host：`packages/server/dist/entry-http.js`，负责服务装配、静态资源与Agent生命周期。
- Agent：独立协议后端。可以通过 `ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON` 接入部署方安装的兼容Agent；本fork不分发闭源制品。
- 静态WebUI与Agent的版本独立；界面里的WebUI版本不是Agent版本。
- 真正的文件操作、任务索引和附件落盘发生在Agent所在环境。

### 纯本地部署（推荐形态）

Host 本身可同时提供静态 WebUI 与 `/api/*`、`/ws/*`：设 `ZCODE_WEB_STATIC_ROOT` 指向
`packages/web/dist`，浏览器直接访问 Host 的监听地址（如虚拟组网地址 `:3030`）即可，无需
外层反代。此时**本机 dist 是唯一生效的前端产物**，更新前端必须重建该目录。

鉴权用 Host 自身机制：首次访问带 `?token=<ZCODE_SERVER_AUTH_TOKEN>` 会种下
`zcode_lite_token` cookie，之后 `/api` 与 `/ws` 靠 cookie 通过校验；长连接升级不接受
URL 查询参数（避免长期凭据进入历史/Referer/日志）。

### 分离部署（可选）

也可让外层反代提供 TLS/Basic 与静态资源，只把动态请求转到 Host：

```text
浏览器 ─ HTTPS/认证 ─ edge-proxy ─┬─ 静态WebUI产物（部署方维护）
                                  └─ /api、/ws 反代 ──┬─ 主：直连虚拟组网地址 ─ 本机Host
                                                      └─ 备：SSH反向隧道    ─┘
```

此形态下动态请求可做**双路径热备**：以直连虚拟组网地址为主，SSH反向隧道为备。反代周期探测
直连可达性，连续失败即降级到隧道、连续成功即回主，并在日志记录状态迁移（`path-transition ...
reason=degraded|recovered`）；任一变化都不中断服务。仅幂等请求（GET/HEAD）在失败时自动换路重试，
非幂等请求（POST 等）不换路，避免重复提交。上游首字节响应设超时，半死连接快速失败而非无限挂起。

保留隧道的理由（分离部署时）：

- 隧道由Host侧**主动出站**建立，不要求Host可被入站访问，天然适配NAT之后的部署；
- 隧道是**已建立的长连接**，在组网新连接的路径出问题时仍可承载流量；
- 只绑定回环地址的辅助服务（如本机更新服务）无法被直连，只能经隧道暴露。

不要因为“虚拟组网能ping通”就删除隧道：能ping通不代表任意TCP端口可稳定入站，且两条路径在组网
层同源——组网整体抖动时二者一起受影响，真正的兜底是超时快返与隧道自身重连。以实际TCP连接与
长连接稳定性测试决定取舍，而不能仅凭网络名称判断。

外层反代不属于本仓库。纯本地部署不需要它；采用分离部署时，其 TLS、认证、限流、静态缓存与
双路径探针都由部署方实现和维护。

## 配置

只在部署机配置环境变量，不把真实值提交Git：

| 变量                                       | 用途                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `PORT`                                     | Host监听端口，默认3030                                      |
| `ZCODE_SERVER_HOST`                        | 监听地址；避免不必要的公网暴露                              |
| `ZCODE_SERVER_AUTH_TOKEN`                  | Host API/WS认证令牌                                         |
| `ZCODE_SERVER_WORKSPACE`                   | 初始本机工作区                                              |
| `ZCODE_WEB_STATIC_ROOT`                    | 静态根；纯本地部署指向`packages/web/dist`，分离部署时不设置 |
| `ZCODE_AGENT_SERVER_COMMAND`               | Agent启动程序                                               |
| `ZCODE_AGENT_SERVER_ARGS_JSON`             | Agent参数JSON数组                                           |
| `ZCODE_SERVER_BROWSER_USE=headless`        | 显式开启托管浏览器；默认不启动                              |
| `ZCODE_SERVER_BROWSER_ENGINE`              | `chromium`（默认）、`firefox` 或 `both`                     |
| `ZCODE_SERVER_BROWSER_EXECUTABLE`          | 旧单路径；双模式仅交给 Chromium                             |
| `ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE` | Chromium 专用绝对路径，优先于旧路径                         |
| `ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE`  | Firefox 专用绝对路径，双模式不继承旧路径                    |
| `ZCODE_DATA_BASE_DIR`                      | 隔离数据根；其中保存`.zcode`运行状态                        |

`IPromptAttachmentTransferService`通用上传在entry-http启用，完整文件保存在Host数据根的`.zcode/attachments/prompt-files`，单文件<=20MiB，原始字节不写入Git。

## 闭源 Agent 与开源 server 的版本兼容

server（开源）与 Agent（闭源制品）版本独立演进。zcode-protocol 的会话事件 schema 是
`.strict()`：上游只以**新增可选字段**的方式演进（如 readOnly、sideEffectScope、
executionStartedAt），旧 Agent 的"少字段"负载可被新 schema 接受；反方向（新 Agent 旧
server）才可能因未知字段被丢弃——升级时应**先/同时升 server**。createSession 等命令的
新参数对旧 CLI 的严格解析由 server 侧降级重试兜底。2026-10-24 已在隔离实例验证
3.16.2 server + 3.15.3 Agent 的 initialize 握手正常（无凭据目录下 Agent 保持
provider_not_ready 休眠，属预期）；完整回合事件流未在隔离环境覆盖，随实际升级验证。

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

discovery 不启动浏览器进程：只要 Host 未关闭且该引擎的可执行文件存在，就返回描述符；真实启动推迟到第一次执行命令。可执行文件缺失的引擎不出现在列表中，一侧不可用不阻断另一侧；指定不可用引擎的命令返回 `backend_unavailable`，不改发另一侧。运行中的 Host 不热切换配置，仍由独立终端重启后生效。

托管浏览器按需回收：某个会话 10 分钟没有命令即关闭其标签页与 cookie；全部会话回收后再闲置 5 分钟，浏览器进程退出，下一条命令自动重启。回收后旧页面与登录状态不保留。日志关键字为 `idle session reclaimed`、`idle browser closed`。规则见 `docs/specs/selfhost-webui-browser-idle-reclaim.md`。

## 安全边界

- Host保留局域网Web模式的query-token/cookie认证方式。纯本地部署靠该机制即可；公网或分离部署应在反代统一加认证与TLS，并检查HTTP和WebSocket upgrade不能绕过。
- `edge-proxy.mjs`、认证失败限流、TLS证书、systemd单元和更新服务由部署方提供，不要误认为源码中存在这些实现。纯本地部署不存在反代，只有Host与其systemd单元。
- 生产Web构建不输出sourcemap。静态目录仅同步生产dist，不同步仓库、配置文件或数据根。
- 若公开部署保留 `/updates` 或 `/api/updater`，必须经过认证与TLS。更新权限取决于部署方的updater实现；本fork不新增或移除这些入口。注意 `/updates` 页面通常由部署方反代内嵌，停用反代即随之下线；`/api/updater` 由 Host 所在环境的本机更新服务提供。
- 配对链接包含远控凭证，不写入日志、文档或issue；重置配对撤销旧链接。
- 托管浏览器能访问Host可达的网络，包括本机服务；必须理解这一信任边界再启用。

## 构建和发布

从仓库根执行，Node与pnpm使用`mise.toml`规定版本：

```bash
ZCODE_ENV=production pnpm --filter @zcode/server build
# 纯本地/内网部署：WebUI 以 HTTP 访问非 localhost 地址时不是浏览器安全上下文，
# crypto.subtle 不可用会让附件上传失败。ZCODE_PRIVATE_DEPLOYMENT=1 才启用纯 JS
# SHA-256 兜底；不加该变量则线上/公网构建不包含兜底分支（编译期摇树）。
ZCODE_ENV=production ZCODE_PRIVATE_DEPLOYMENT=1 pnpm --filter @zcode/web build
```

`ZCODE_PRIVATE_DEPLOYMENT` 只在构建期生效，运行时不可切换。仅当 WebUI 通过 HTTP（非
`https`、非 `localhost`/`127.0.0.1`）访问时才需要它；用 HTTPS 或本机 localhost 访问时
不必设置，走原生 WebCrypto。详见 `docs/specs/selfhost-private-deployment-digest-fallback.md`。

> **警告：重建 Web 产物时漏掉 `ZCODE_PRIVATE_DEPLOYMENT=1` 会静默破坏自部署功能。**
> 该变量是编译期常量，漏加时产物不含兜底分支，且**没有任何构建报错**——表现为能打开页面、
> 能对话，但发图片必失败（`crypto.subtle is unavailable...`）、复制按钮无反应。
> 自部署形态下这条命令应当总是带上该变量。验证产物是否含兜底：
> `grep -c 1779033703 packages/web/dist/assets/*.js` 应大于 0（纯 JS SHA-256 的初始
> 哈希 h0；用函数名 grep 会因 minify 改名而漏检）。

Host 提供静态资源时按请求的 `Accept-Encoding` 返回 brotli/gzip 压缩结果（≥1KB 的文本类资源，结果按文件 mtime 缓存），无需额外配置；外层反代若自行压缩，应避免对已压缩响应重复处理。详见 `docs/specs/selfhost-webui-static-asset-compression.md`。

同机部署可由Host服务`ZCODE_WEB_STATIC_ROOT`提供静态资源（纯本地部署即此形态，无需外层反代）。分离部署可将静态产物同步到edge-proxy的专用目录：

```bash
# DEPLOY_SSH、WEB_ROOT由部署环境提供；不要将真实值写回文档。
rsync -a --delete --exclude='*.map' packages/web/dist/ "$DEPLOY_SSH:$WEB_ROOT/"
```

同步前备份现有产物，确认目标是专用静态目录。rsync排除项也会被`--delete`保护，历史`.map`应在核实目标后单独清理。若反代缓存资源，按其实际缓存策略更新，不假定重启是唯一办法。

Host源码改动需要重建并重启Host；静态UI改动需要重新发布静态产物。Agent制品更新是另一项操作，不能用WebUI版本推断Agent是否更新。

**不要让运行在Host内的Agent重启自身宿主。** 在独立终端按实际systemd单元手工重启；Git发布不会修改运行中的服务。

### 动态链路运维（仅分离部署：双路径热备）

纯本地部署没有这一层；以下只适用于使用外层反代的分离部署。反代的路径选择与健康由它自身维护，部署方按需接入以下开关（具体实现不属于本仓库）：

- 只读健康端点（在反代认证之后）：返回当前 `active` 路径、两条路径最近探测结果、迁移计数与最后一次迁移原因。
- 强制路径环境变量：可临时固定走直连或隧道，用于排障与回滚，无需改代码；排障后恢复自动模式。
- 日志关键字：状态迁移记为 `path-transition ... from=... to=... reason=degraded|recovered`，每次探测记为 `path-status active=... direct=... tunnel=...`。监测只需 grep 这两个前缀。

切换/回滚应做成**单脚本原子操作**：脚本自带预检、备份、原子替换、重启与健康校验，失败自动回滚；由调用方脱离交互会话后台运行，结果落日志文件。原因：重启该入口会中断正在使用它的浏览器会话，多步手工操作中途失败会留下半完成状态。

## 不重启主服务的验收

- 用临时目录及`ZCODE_DATA_BASE_DIR`启动独立实例，监听localhost上的备用端口。
- 使用合成任务、附件和测试配置；不得复制真实凭据到副本。若确需复制数据快照，副本启动前去除`credentials.json`，防止共享relay设备身份互踢。
- 使用相同生产Web产物经localhost反代验收，检查任务列表、归档、附件校验与恢复。
- 退出独立实例后清理只属于本次验收的文件；不要按宽泛进程名停止主服务。

## Git边界

公共维护决策见`docs/maintenance/selfhost-fork.md`。真实部署地址、私有拓扑、日志、抓包和手工迁移记录保存于被忽略的`.local/`或`docs/local/`，不随源码发布。外部服务配置、数据库中的一次性修正及闭源Agent换装不属于可移植源码补丁。
