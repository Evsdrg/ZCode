# 自部署 WebUI 启用 Browser Use（headless Chromium 执行器）

状态：实施中（首版覆盖核心命令面）
适用形态：`zcode --web` / `entry-http` 自部署；desktop 走自己的 IAB 执行器，不受影响。

## 背景

Browser Use 的调用链是**反向请求**：agent（CLI 后端）经 broker 发出
`interaction/browserExecute`，由 **App/Host 进程**执行真实浏览器。桌面客户端注册了 IAB 执行器
（`browserControlMainBridge`），而自部署 server 的 `createLocalServices` 未传
`browserControlExecutor`，故 `agent.browsers.list()` 返回 `[]`、execute 返回
`backend_unavailable`——即自部署形态下该能力不可用（已实测确认）。

本 spec 定义在**自部署 server 内**实现一个托管 headless Chromium 执行器，注入
`createLocalServices({ browserControlExecutor })`，使自部署形态获得该能力。

**依赖结论（回答"依赖 webui/server/cli"）**：依赖 **CLI 后端（发起反向请求）+ server 进程（执行）**；
**不依赖 webUI**。webUI 只是 server 的浏览器客户端，与本能力无关。

## 复用的边界

- CLI 已有实现（`apps/zcode-cli/packages/adapters/src/browser/`）**不可复用**：
  `packages/*` 未链接 `apps/zcode-cli` 包（pnpm workspace 未声明跨包依赖，实测不可解析），
  且该方向违反既有依赖方向。
- 因此 server 侧用 `playwright-core`（已在仓库中使用，desktop 依赖它）**独立实现**等价执行器，
  方法语义对齐 CLI 托管后端，不建立反向依赖。

## 行为规则

| 项                 | 规则                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端类型           | `cdp`（headless Chromium）；`name: "ZCode Server Headless Chromium"`                                                                                                                                                                                                                        |
| 启用开关           | 环境变量 `ZCODE_SERVER_BROWSER_USE=headless`；未设置则**不注册执行器**（默认关闭，与现状一致）                                                                                                                                                                                              |
| 进程模型           | 懒启动：首次用到时启动一个 Chromium；按 session 建独立 BrowserContext；随 server 关闭释放                                                                                                                                                                                                   |
| 安全边界（选项 a） | 沿用 CLI headless 的收紧：`BrowserUser.openTabs`/`BrowserUser.history`/`PlaywrightAPI.waitForEvent`/`PlaywrightDownload.path`/`PlaywrightFileChooser.setFiles`/`PlaywrightLocator.downloadMedia`/`PlaywrightLocator.evaluate`/`CUAAPI.downloadMedia`/`DomCUAAPI.downloadMedia` 全部 `false` |
| 导航白名单         | 仅 `http:` / `https:` / 精确 `about:blank`；其它 scheme 拒绝（对齐 `isAllowedManagedBrowserUrl`）                                                                                                                                                                                           |

## 状态所有者

**执行器实例**（server 进程内单例）持有：Chromium 进程、按 sessionId 的 BrowserContext/tab 注册表、
generation。UI/agent 不持有浏览器事实，只经反向请求读写。

## 事件顺序与生命周期

```
list() → 懒启动 Chromium（若未启动）→ 返回 [cdp descriptor]（单后端）
execute(command)
  → 解析/创建该 sessionId 的 context 与 tab
  → 由 Playwright 执行命令 → 返回 BrowserCommandResult
当前按session复用context；关闭单tab只回收该tab，turnEnded不销毁context
server关闭或Chromium断连 → 关闭context/tab并清注册表
```

幂等：重复 list 不重复启动；同 session 复用 context；关闭后重来按新 context 处理。

## 失败语义

- Chromium 启动失败（缺可执行文件）：`list()` 返回 `[]`（不伪装可用），execute 返回
  `backend_unavailable`；错误写入服务日志。
- 命令执行异常：返回 `BrowserCommandResult` 的失败分支（对齐既有错误码），不抛到进程边界。
- 任何执行器异常**不得上抛**（沿用在 relay 桥事故中确立的不变量：可选能力不得拖垮主进程）。

## 首版命令覆盖（明确边界）

覆盖核心面：`navigate/back/forward/reload/getState/snapshot/screenshot/click/fill/type/press/
scroll/hover/select/check/evaluate`、tab生命周期（`list/newTab/activateTab/close`）、
`capabilities`、`playwright`子面（`domSnapshot/evaluate/locator.*/waitForLoadState/waitForURL`）。
未列出的SDK方法按实现返回unsupported，不以SDK文档的完整方法集合声称覆盖。

暂不覆盖（明确声明，非静默降级）：`recording*`（托管后端本就不提供）、`cua*` 坐标法、
`drag`、`getDialog/handleDialog`、`claimTab/listUserTabs`（无用户 tab 概念，descriptor 已置 false）。

## 验收场景

1. 设置 `ZCODE_SERVER_BROWSER_USE=headless` 启动 server 后，`agent.browsers.list()` 返回一个 `cdp` 后端。
2. 通过 `js` 工具 `agent.browsers.getDefault()` → `tabs.new()` → `goto` 一个http页面 →
   `playwright.domSnapshot()` 返回可定位的树；`click` 后再快照可见状态变化。
3. 不设置开关时，`list()` 仍返回 `[]`、execute 仍 `backend_unavailable`（零行为变化）。
4. 非 http/https 目标被拒。
5. server 关闭时 Chromium 进程被回收，无残留进程。

## 测试

- 执行器：单测覆盖 URL 白名单、descriptor 收紧项、命令分派（注入 fake Playwright 避免真启浏览器）。
- 端到端：真启 Chromium 打开本地页面，断言 snapshot 含预期元素、click 生效（集成测试，标记为需浏览器）。
