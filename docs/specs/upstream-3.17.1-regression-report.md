# 3.17.1 合并回归报告（Web 部署形态）

- 日期：2026-10-31
- 合并提交：`c3e78de5`（`merge/upstream-3.17.1` → `selfhost/maintained`）
- 上游基线：`a60ba6a7`（`v3.17.1`，2026-10-29）
- 上一基线：`3c5b2276`（3.16.2）
- 推送：`29361c52..c3e78de5  selfhost/maintained -> selfhost/maintained`（fork `Evsdrg/ZCode`）

## 1. 验收策略的修正

首轮按上游习惯跑了 `packages/desktop/test/e2e`（WDIO + Electron + Xvfb），
投入后发现这是**形态错配**：

- 该套 harness 通过 `appBinaryPath` 启动 Electron 二进制，驱动必须匹配
  Electron 内置 Chromium（44.7.0 → 152.0.7977.130），`@wdio/local-runner`
  的 `autoXvfb` 默认开启。
- 我们的交付形态是 **Web**（`zcode-web-local` + 浏览器），Electron 只是行为基线。
- 失败用例全部是 Electron 窗口尺寸敏感断言。例如 `UP-02` 期望设置页 sidebar
  268px，实际 68px —— 源码是 `grid-cols-[68px...] lg:grid-cols-[268px...]`，
  断点取决于 Electron 窗口宽度（`DEFAULT_DESKTOP_WINDOW_WIDTH = 1200`，
  受 Xvfb 可用工作区约束），与 Web 渲染无关。

因此 **Electron E2E 不作为本 fork 的验收门槛**，改为以 Web 形态的端到端验证为主。
`smoke.test.ts` 在 Node 24.14.0 下通过（1 passing），仅作桌面端启动链路的旁证。

### 环境注意

- 必须使用 **Node 24.14.0**。Node 26 下 `engines` 不匹配，WebDriver session 创建
  直接失败（`UND_ERR_INVALID_ARG`）。
- chromedriver 从 `npmmirror.com/mirrors/electron/44.7.0/` 获取（39MB，直连）；
  GitHub Releases 走 7897 代理会超时。

## 2. Web 形态端到端验证

隔离实例：`127.0.0.1:13930`，`ZCODE_WEB_STATIC_ROOT` 指向合并后构建的
`packages/web/dist`，数据目录为生产快照的独立副本。

### 2.1 设置页全分区

17 个导航分区全部可打开并渲染控件：

| 分区 | 控件数（input/switch） | 分区 | 控件数 |
|---|---:|---|---:|
| 常规 | 19 | 插件 | 30 |
| 外观 | 5 | MCP 服务器 | 3 |
| 模型设置 | 3 | 技能 | 14 |
| 浏览器控制 | 3 | 命令 | 2 |
| 电脑控制 | 3 | 钩子 | 2 |
| 键盘快捷键 | 2 | 使用统计 | 1 |
| 个性化 | 1 | 项目 | 15 |
| 记忆 | 2 | 归档管理 | 3 |
| 子智能体 | 2 | | |

上游 3.17.1 新增的「个性化」分区正常出现，`settings-personalization`
用例 7/7 通过（含 100KB 上限阻断、草稿跨分区存活）。

### 2.2 任务与会话

`task-list`、`task-item-*`、`session-pane`、`composer` 均正常渲染；
点击历史任务后会话正文完整显示（数千字内容、工具卡片、复制/赞/踩/分叉按钮）。

### 2.3 附件上传（回归 `PRIVATE_DEPLOYMENT` 关键路径）

| 步骤 | 结果 |
|---|---|
| `getUploadCapabilities` | OK 0.2ms |
| `beginUpload` | OK 6.4ms |
| `uploadChunk` | OK 1.0ms |
| `commitUpload` | OK 1.9ms |
| 落盘 SHA-256 | `ec01ea2d...cc46`，与源文件**逐字节一致** |

UI 显示 `smoke2.zip | ZIP`，无「上传失败」提示。

### 2.4 三处自部署修复复验

**① 数据存储路径（`dataBaseDir`）**

```
点「选择文件夹」→ 目录浏览器打开（列出 公共/模板/视频/下载/...）
→ 点「文档」→ 点「选择此目录」
→ 只读输入框由 /home/cepvor 变为 /home/cepvor/文档
→ 对应「保存」按钮 disabled 由 true 变 false
```

**② 代码预览设置**

| 操作 | `--diffs-font-size` |
|---|---|
| 默认 | `12px` |
| 设为 16 | `16px` |
| 设为 18 | `18px` |
| 改回 12 | `12px` |

写入 `localStorage["zcode-code-preview-settings"]` 的 JSON 结构完整
（`lightTheme`/`darkTheme`/`showLineNumbers`/`wrapLongLines`/`fontSizePx`）。

**③ 托管浏览器证书策略**

开关在自部署形态下可见（`canConfigureManagedBrowserCertificates` 为 true），
切换后 `setting.json` 的 `embeddedBrowserAllowInsecureCertificates` 在
`true`/`false` 间正确切换，文案为「修改后对新开的浏览器会话生效」。

## 3. 事故与恢复

### 3.1 误杀生产服务（26 分钟）

清理隔离实例时使用 `pkill -f "packages/server/dist/entry-http.js"`，
模式串同时匹配到生产进程，`zcode-web-local` 于 23:00:51 停止，23:27:44 手动恢复。
恢复后 `active`、PID 185458、API 401/200、静态 200。

已写入长期约束：禁止 `pkill -f`，必须用 `pgrep` + `/proc/<pid>/cmdline` 确认后 `kill <pid>`。

### 3.2 隔离实例污染生产 `setting.json`

**根因**：`packages/services/src/setting/settingService.ts:236` 的
`resolveUserHomeDir()` 只认 `ZCODE_DESKTOP_HOME_DIR` / `HOME` / `USERPROFILE`，
**完全不读 `ZCODE_DATA_BASE_DIR`**。隔离实例只设了后者，导致：

- `setting.json` 写入真实 `~/.zcode/v2/`
- `~/.zcode/cli/plugins` 插件缓存同步写入真实目录（813 个文件）

**污染范围（已逐字段核对）**：仅 `setting.json` 的两个纯 UI 状态字段
`lastActiveTabIndex`（6→0）与 `lastActiveWorkspace`
（`/opt/helloworld/agentTmp` → `.../zcode-merge-3171`）；49 个字段中其余全部一致，
配置项无一变化。

**恢复**：用生产服务自身在 23:31:11 写入 journald 的完整 JSON 作为权威来源，
恢复两个字段至 `lastActiveTabIndex=6` / `lastActiveWorkspace=/opt/helloworld/agentTmp`，
与污染前快照及生产日志双重核对一致。污染版本备份于
`/tmp/setting.json.polluted-20261031-2352xx`。

**插件缓存**：`~/.zcode/cli/plugins` 的 813 次写入是同一份官方 marketplace 数据的
重新同步（内容一致），仅 mtime 变化，无内容破坏。

**修正后的隔离方式**：同时设置 `HOME`、`ZCODE_DESKTOP_HOME_DIR`、`USERPROFILE`
指向隔离目录。修正后复测：证书开关、代码字号、附件上传全部只写隔离目录，
生产 `setting.json` mtime 保持 23:53:12 不再变化。

已写入长期约束。

## 4. 结论

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 error / 93 warning |
| `architecture:check --changed` | violations 0 |
| `pnpm test:selfhost` | 48 files / 312 passed / 4 skipped |
| `pnpm test:engineering` | 157 files / 961 passed / 8 skipped |
| server bundle | 5.64 MB，无 `from "@zcode/services/node"` 裸导入 |
| web 构建 | 两个编译常量齐全，入口 `index-BH8WGDy7.js` |
| WebUI 端到端 | 设置 17 分区 / 任务 / 会话 / 附件 / 三处修复全部通过 |

合并已推送至 `fork/selfhost/maintained`，`HEAD == fork/selfhost/maintained`，工作区 CLEAN。

### 未做 / 受限项

- **Electron E2E 未全量跑**：形态不匹配，仅 `smoke` 单例通过。那批宽度/间距断言
  在 Electron 窗口下有其意义，但与本 fork 的 Web 交付无关。
- **生产服务未重启**：`zcode-web-local` 仍运行 3.16.2 的构建产物
  （`packages/server/dist/entry-http.js` 时间 21:38:31）。上线 3.17.1 需要
  重建 server/web 并重启，属于破坏性操作，需单独确认。
- **`relayDeviceTransportV2.test.ts` 22 个用例仍红**：3.16.2 变基遗留的既有债，
  与本次合并无关（已在 fork 基线 `39c88478` 复现）。

## 5. 生产上线记录

保持验证策略（Web 形态）完成验收后，3.17.1 已上线到本机生产实例。

| 项 | 上线前 | 上线后 |
|---|---|---|
| `server-info.version` | 3.16.2 | **3.17.1** |
| `hostPlatform` | linux | linux |
| server bundle | 5,696,749 B / `bd8d3c76` | 6,009,555 B / `04a75f6a` |
| web 入口 chunk | `index-DYjqFjIU.js` | `index-BH8WGDy7.js` |
| `zcode-web-local` | active, PID 185458 | active, PID 211958, NRestarts=0 |

### 上线前置

- 依赖：`pnpm install --no-frozen-lockfile`（7.8s），补齐上游新增的 workspace 包 `@zcode/e2e-report`
- 数据库备份：`/opt/helloworld/agentTmp/zcode-backups/tasks-index-pre-3171-20261101-000348.sqlite`
- 设置备份：同目录 `setting-pre-3171-20261101-000348.json`
- 产物备份：`/opt/helloworld/agentTmp/zcode-backups/dist-pre-3171-20261101-000417/`

### 上线后验证（生产实例，非隔离）

| 检查 | 结果 |
|---|---|
| `/api/server-info` 无 token | 401 |
| `/api/server-info` 带 token | 200，`version: 3.17.1` |
| 静态首页 | 200，入口 `index-BH8WGDy7.js` |
| 设置页导航 | 17 个分区全部渲染（含「个性化」） |
| 历史任务打开 | `session-pane` + `composer` 正常，正文 3039 字符 |
| **附件上传** | 四步 RPC 全 OK，落盘 SHA-256 `6ab4bfc6...4465` 与源文件一致 |
| 数据存储路径 | 目录浏览器可打开（已取消，未改动生产配置） |
| 代码预览设置 | `--diffs-font-size` = `12px`，输入框显示 12 |
| CUA helper | socket 正常，`accessibility=granted` / `screen_recording=denied` |
| 任务库完整性 | 266 条任务全部 `host_id='local'`，`remote:%` 残留 0 |
| 子进程 | 12 个 `zcode-cli` 预热进程全部重建 |

### 说明

- 测试期间浏览器切换工作区导致 `setting.json` 的 `lastActiveWorkspace` /
  `lastActiveTabIndex` 变动，已在收尾时恢复为测试前值
  （`/opt/helloworld/agentTmp` / `6`）。
- 测试上传的附件已删除。
- `pi-bridge.service` 不在本机 systemd 中（`not-found`），非本次操作影响。
