# 自部署 fork：改动分类与维护

目标：在官方源码基线上维护可用的自部署 WebUI，不把本机运维状态、闭源制品或开发过程写入公共Git。

## 分类结论

“适合补丁”指可独立cherry-pick或用`git format-patch`导出的源码提交；不表示改构建后的bundle。源码提交是唯一事实源，不把同一份修改再复制为常驻应用补丁。

### 适合独立补丁的小修复

| 改动                    | 当前源码落点                                                                            | 移植边界                                             |
| ----------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| React条件hook修复       | `packages/ui/src/hooks/useZCode{Agent,Session,Task}Service.ts`                          | 无条件调用hook，保留workspace身份路由                |
| 高亮加载失败重试        | `packages/ui/src/lib/shikiHighlighter.ts`                                               | rejected promise不永久留缓存                         |
| 浏览器套餐页降级        | `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx`及i18n                    | 不尝试在浏览器执行Electron webview/preload           |
| WebUI版本展示           | `settingsPageHelpers.tsx`、test-ids及i18n                                               | WebUI版本与Agent版本独立                             |
| WebSocket保活、页面重连 | `server/src/webSocketHeartbeat.ts`、`web/src/connectionResilience.ts`                   | 仅Web replayable链路，不改Desktop continuous语义     |
| 前台/后台投递流控       | `services/src/zcode-agent/zcodeAgentConnectionScope.ts`、`web/src/clientFlowControl.ts` | 复用CLI既有`saturated`/`drained`，只驱动不新增帧语义 |
| HTTP入口优雅关闭        | `packages/server/src/entry-http.ts`                                                     | 依赖公开的services资源释放接口                       |
| 任务列表并发请求合并    | `packages/ui/src/lib/taskListMembershipSets.ts`                                         | service实例+scope在途合并，不缓存新结果              |
| 图片测高稳定            | `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`                                       | 局部展示优化，首次解码仍可能改高度                   |
| 生产sourcemap关闭       | `packages/web/vite.config.ts`                                                           | 只影响生产静态构建                                   |
| 轻量发行跳过TUI资产     | `scripts/zcode-distribution/assets.mjs`                                                 | 显式`ZCODE_DIST_SKIP_TUI=1`，完整发行不传            |
| 时间线布局抖动修复      | `packages/ui/src/v4/messageLayerMask.ts`、`ConversationTimeline.tsx`                    | 只重排mask计算的读写顺序，不改滚动锚定状态机         |
| 协议事件字段兼容        | `packages/shared/src/zcode-protocol/index.ts`及services兼容测试                         | 只补齐闭源CLI新增的可选字段，不放松既有必填校验      |
| Web通知权限申请         | `packages/web/src/webTaskNotification.ts`、`shared/src/platform.ts`                     | 平台能力走`IPlatformService`可选方法，桌面不接线     |
| webview可用性判定       | `packages/ui/src/browser-use/BrowserViewportSurface.tsx`                                | 浏览器无`webview`元素时降级，不启用Electron专有路径  |

这些提交可单独导出审查；涉及测试/依赖的补丁需带同组文件，不只复制一段diff。

### 保持源码直接维护的结构改动

| 改动                                | 原因                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| 自部署能力门控                      | 改的是平台能力与产品策略，保留settings/helper/测试的同一语义，不用构建期文本替换 |
| Host服务装配、accessor、RPC channel | 是跨包公开契约及启动顺序，需与新增服务一起维护                                   |
| 全工作区任务视图与本地Controller    | 涉及持久任务身份、分页、失效通知和分组；上游变更时必须重新审查                   |
| taskIndexRepo尾斜杠key归一          | 持久化兼容边界，不应在发布时额外脚本偷偷改数据库                                 |
| 附件传输接口与发送前持久保留        | 有崩溃窗口、所有权和引用恢复契约，需要源码、spec、测试共同维护                   |
| 定时/闲时任务调度下沉               | 桌面与 server 共用同一调度核心，跨包契约与派发顺序必须一致维护                   |
| 依赖清单与pnpm-lock.yaml            | 保留正常包管理链路，不打node_modules或压缩bundle补丁                             |

### 新增内容

- **官方relay远控模块**：`packages/services/src/web-remote-control/`；UI新增relay区块和状态hook；客户端代理仅在自部署入口暴露。设备凭据经已有Credential服务保存，默认不开远控连接。
- **托管浏览器执行器**：`packages/server/src/browser/`；显式`ZCODE_SERVER_BROWSER_USE=headless`启用；`ZCODE_SERVER_BROWSER_ENGINE=chromium|firefox|both`选择单/双引擎，默认Chromium；双模式通过既有SDK按ID选择。使用Playwright配套制品，依赖外置，不分发本地浏览器缓存。
- **通用文件上传store**：`packages/services/src/prompt-attachment-transfer/arbitraryFileUpload*`；Web普通文件<=20MiB完整落盘，发送前持久保留，既有媒体链路保留。
- **自部署任务列表投影**：`allWorkspacesTaskView`与`localWindowControllerService`。
- **前台/后台投递流控**：`setClientFlowStateV4`（scope 覆写）+ `web/src/clientFlowControl.ts`；页面隐藏时经CLI既有`v4/connection/flow`置`saturated`暂停打帧，可见时`drained`恢复。不改闭源CLI，不新增帧语义。
- **定时/闲时任务调度**：`services/src/session/automationScheduler.ts`（桌面与 server 共用的认领/派发编排/结算核心，派发执行域以端口注入）+ `server/src/automationDispatch.ts`、`offPeakDispatch.ts`。自部署 server 本进程起调度器并注入`onAutomationManualRunRequested`，派发档位用`web-remote-replayable`；桌面 scheduler 进程改为复用同一核心。原先该链路只存在于 Electron 形态，自部署 WebUI 的自动化与「立即运行」不会执行。
- **Web 端非 Electron 路径补齐**：通知权限经`IPlatformService`可选方法申请；`BrowserViewportSurface`按`customElements`判定`webview`可用性；任务完成回推复用已有 Bot 终态订阅。
- **测试基建和回归用例**：services/server/ui/web的Vitest配置、纯逻辑与交互测试。合成数据测试属于交付内容，不是要忽略的开发过程。
- **产品spec、匿名化部署指南、发布检查**：保留可维护决策与验收规则，不提交实际运行日志/抓包/会话摘录。

现有`patches/`是上游的pnpm第三方依赖补丁，由`package.json#pnpm.patchedDependencies`管理，继续保留；与上表的应用源码补丁不是一回事。

### 格式基线（fmt:check）

仓库格式化用`oxfmt`（不是prettier），命令为`pnpm fmt:check`。上游`origin/main`自身提交了若干**不通过**`oxfmt`的文件，且上游没有CI强制这一点，因此`fmt:check`在上游就是长期失败的。本fork已把这些文件补齐格式化，`fmt:check`现全仓通过。

维护注意：

- 上游基线格式修正与fork自有文件的格式化分成独立提交，合并上游时可一眼分辨这层纯格式差异，不与真实改动混淆。
- 格式化差异除空白与尾随逗号外，`oxfmt`还会插入/移除**装饰性圆括号**（如`return (expr)`、`a ? (b) : c`）与调整JSX花括号，均语义等价；验收以`typecheck`/`lint`/测试为准，不要只看`git diff -w`。
- `oxfmt --check`全量扫描在0.41.0下有偶发假阳性；判断某文件是否真的不合格式，应逐文件`oxfmt --check <file>`复检。
- 后续从上游同步时，新引入的上游文件可能再次带来格式债；按同样方式单独成提交补齐即可。

`.oxfmtrc.json` 的 `ignorePatterns` 里有两类**不能格式化**的路径，新增条目前先确认属于哪类：

| 类别                     | 路径                                                                     | 理由                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 第三方文档镜像           | `docs/electron/docs/**`、`docs/webdriverio/docs/**`、`docs/knip/docs/**` | 仓库内明确标注「不属于 ZCode workspace」的上游快照，逐字节保留，不改写                                                      |
| 机器维护的 Markdown 表格 | `docs/testing/conversation-session-docker-automation-plan.md`            | `admit-conversation-e2e-docker.mjs` 按「表头分隔行紧邻 end marker」的契约插入行；`oxfmt` 会填充分隔行并插入空行，把表格打断 |

## 测试环境与入口

- 根 `vitest.config.ts` 的 `unit` project include `packages/*/test/**/*.test.ts`，cwd 是仓库根。上游 3.15.1 起新增的 `packages/ui/test/**` 用 `resolve("packages/ui/src/...")` 读源码文本，**只在仓库根作 cwd 时解析正确**；因此 `packages/ui/vitest.config.ts` 的 include 保持只含 `src/**`，不要把 `test/**` 也加进去，否则 `pnpm --filter @zcode/ui test` 会以 `packages/ui` 为 cwd 全部 ENOENT。
- 根 `vitest.setup.ts` 与 `packages/ui/vitest.setup.ts` 都把 `customElements.get("webview")` 桩成已注册：Electron 的 `<webview>` 是内置特殊标签，规范要求自定义元素名含连字符，`define("webview")` 会抛 `SyntaxError`，jsdom/happy-dom 里该查询恒为 undefined，而 `BrowserViewportSurface` 与 `CodingPlanEmbeddedWebviewDialog` 正是用它决定是否挂载 guest。

## 不进入公共Git的改动

以下是外部部署状态，不是本fork的源码功能：

- systemd user/system服务、SSH反向隧道实例、EasyTier地址/配置、TLS证书、edge-proxy实例及实际账号。
- 官方闭源Agent换装、下载制品/解包结果/备份；本fork只保存公开协议适配源码。
- 真实任务索引、credentials、provider选择、relay设备配对信息、附件、浏览器profile、模型IO、会话与子agent输出。
- 现场任务key一次性迁移和服务清理；源码预防逻辑可以发布，实际数据库不能发布。
- 临时探针、截图、录屏、QA原始输出、开发笔记；统一放`.local/`、`docs/local/`等忽略位置。

内置子智能体切换模型的核验没有新增源码功能；配置与执行日志属于运行状态，不加入发布提交。

## 当前明确限制

- relay数据面是兼容适配，ACK/重放/拥塞不是官方桌面实现的完整替代；上游网页变化可能要求更新。
- 全工作区任务服务和relay共享列表服务，但relay工作区列表只暴露可开桥的项目集合。列表外工作区任务的远控打开仍需单独校验，不声称完整覆盖。
- 本地Controller当前是列表投影兼容层，通过失效快照触发重查，不是完整的实时Controller。没有实时overlay时持久running不解释为当前在跑；部分写方法显式unsupported。
- Browser Use支持托管Chromium和Playwright配套Firefox，不支持普通系统Firefox或日常profile接管；部分SDK方法未覆盖，只能宣称实际实现的命令面。Firefox的`cdp`类型是旧协议兼容分类，不代表底层使用CDP。
- 通用文件上传仅支持自部署本机工作区；每文件20MiB、最多8个附件。已发送文件不TTL清理，默认全部文件配额2GiB，Host装配可调。
- 未发送附件草稿存在浏览器内存，刷新后可能需重选；已发送路径跨Host重建保留。
- 定时/闲时任务调度在自部署server内是**本进程**执行：进程退出即停止轮询；在途认领靠`CLAIM_STALE`兜底回收，重启时把残留running的闲时任务置回queued。派发档位固定`web-remote-replayable`，与桌面的`desktop-continuous`不是同一投递语义。
- 本仓库不包含公网反代/updater的源码实现；不能把部署层安全措施写成仓库自带功能。动态链路的高可用（如双路径热备）属部署方实现，不在源码内。

## 升级与补丁导出

发布分支为`selfhost/maintained`，从官方`origin/main`当前基线构造，不包含旧本地运维文档提交。fork的`main`保持不变，原本地工作分支只留作历史备份，不要`push --all`。

```bash
# 后续从上游更新：先审查diff，再合并，不直接套用旧bundle补丁。
git fetch origin
git diff selfhost/maintained..origin/main -- packages/services packages/server packages/ui packages/web

# 导出单个可移植提交；文件进入忽略目录，避免重复跟踪。
mkdir -p .local/patch-exports
git format-patch -1 <commit> --output-directory .local/patch-exports
```

功能提交按依赖顺序排列：发布卫生、测试/依赖、浏览器兼容与版本、连接韧性、relay、浏览器执行器、任务视图、通用附件、Host装配、时间线性能、协议字段兼容与Web对齐、定时任务调度。装配提交最后接入，独立模块提交可以先审查；应用整个功能时包含关联测试/依赖/装配。格式化提交（上游基线、fork自有）与功能提交分离。

## 提交前检查

```bash
pnpm publish:check
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm --filter @zcode/services test
pnpm --filter @zcode/server test
pnpm --filter @zcode/ui test
pnpm --filter @zcode/web test
```

`publish:check`只打印问题类型和位置，不打印疑似秘密值；它不是完整的凭据识别器，必须配合人工检查。公共`.env.example`、空的环境占位文件、架构skill和测试源码继续跟踪。上游已跟踪且被源码引用的类型声明/生成文件不擅自删除，但新的构建输出不再加入索引。

部署不会随Git推送自动发生。静态UI需重新同步dist；Host需重建并由独立终端重启。运行在Host内的Agent不得重启自己的宿主。
