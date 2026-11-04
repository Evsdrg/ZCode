# 上游 v3.17.2 合并预演报告

日期：2026-11-04
分支：`rehearsal/upstream-3.17.2`
合并提交：`3ad9ffbb`
上游：`a60ba6a7..a9fe401e`（单 squash 提交 `chore: sync ZCode source v3.17.2`）

## 1. 规模

| 项 | 值 |
|---|---|
| 变更文件 | 203 |
| 新增/删除 | +9635 / −1472 |
| 上游新 tag | 无 |
| 冲突 | **6 处**，每处 1 个块 |

目录分布：apps/zcode-cli 66、packages/desktop 56、packages/ui 31、docs 24、
packages/services 10、packages/shared 6、其他 10。

## 2. 冲突解决

| # | 文件 | 处理 | 理由 |
|---|---|---|---|
| 1 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | **双方保留，串行** | 上游 `resolveLegacyRemoteSessionWorkspace` 只处理 `!session.workspaceID` 的 WSL 形态并要求落盘校验；我们的降级处理 `workspaceID` 已存在但被写成 `remote:ssh:` 本机路径的形态。条件互斥。 |
| 2 | `packages/ui/src/v4/SessionPane.tsx` | **合并 import** | 保留我们的 `writeClipboardText`（`074260a0` 私有部署非安全上下文降级，HTTP 下 `navigator.clipboard` 不可用）；加上游的 `registerPluginUiPaneSession` / `useOpenPluginUi`。 |
| 3 | `packages/ui/src/embeddedBrowserHelpers.ts` | 取上游 | 新增 `zcode-html:` 本机 HTML 预览协议白名单。 |
| 4 | `packages/desktop/src/main/unreadBadge.ts` | 取上游 | 托盘角标已移除，注释改为「任务栏 overlay 使用」。 |
| 5 | `docs/claude-code-marketplace-plugin-compat.md` | 取上游 | 插件 `hooks` / `agents` 行为更新。 |
| 6 | `docs/coding-plan/zcode-official-server-mcp-auth-spec.md` | 取上游 | 新增设置探测回归段。 |

### 冲突 1 的关键判断

上游的 `resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory)`：

```ts
// 只接受 wsl 形态，且要求 session 原本没有 workspaceID
return !session.workspaceID && session.directory === directory
  ? resolveLegacyRemoteWorkspace(context, directory)
  : null;
```

我们的分支处理的是「`workspaceID` 存在，但值是本机路径被误写成远端身份」，
两者判定条件不重叠。合并后顺序：先尝试上游的 WSL 修复，再走我们的 SSH 降级。

## 3. 验证结果

| 项 | 结果 |
|---|---|
| `pnpm install` | 完成，+51 −237，node-pty 重建 OK |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **0 error / 98 warning**（3.17.1 时为 97，+1 来自上游） |
| `pnpm architecture:check --changed` | **violations 0** |
| `pnpm test:selfhost` | **396 passed / 4 skipped** |
| `pnpm test:engineering` | **963 passed / 8 skipped** |
| server bundle | 6,032,131 B，无 `from "@zcode/services/node"` 裸导入 |
| web 入口 | `index-Cl49ryE-.js` |

### 隔离实例冒烟（127.0.0.1:13932，生产数据快照）

| 项 | 结果 |
|---|---|
| `/api/server-info` | 无 token 401 / 有 token 200，`version: 3.17.2`，`hostPlatform: linux` |
| 首页 | 200 |
| 反代 `client/configs` | 200，真实 `feedback_url` |
| 反代 `oauth/token` | 500 + `code:2007`（上游业务响应，非 404） |
| 浏览器渲染 | 标题正确，设置页 **16/16 分区全渲染** |
| API 4xx/5xx | 0 |
| console error | 0 |

## 4. 3.17.2 实际内容 vs 闭源发行日志

闭源日志共 47 条，开源树中：

| 类别 | 数量 | 占比 |
|---|---|---|
| ✅ 可验证实现 | 18 | 38% |
| ⚠️ 语义偏差 | 5 | 11% |
| ❌ 完全无实现 | 24 | 51% |

### 开源可获得的（按价值排序）

**安全相关（高价值）**
- 本机 HTML 预览访问范围限制（`browser-local-preview` 模块，151 行 + CONTRACT）
- 自定义命令 `!` shell 块改为交接给模型 Bash 工具（删除 255 行直接执行）
- 子代理 `permissionModeRestrictOnly`（插件声明只能收紧父会话权限）
- 计划模式 `optionsPolicy` 覆盖 + 草稿权限 receipt 复用

**数据一致性（高价值）**
- `forked_from_task_id` 父事实优先归属
- `repairRemoteTaskOwnership()` 循环补 NULL
- 会话草稿失效与 `admitTaskIdentity`

**体验（中价值）**
- MCP 失败诊断 22 条建议文案 + stderr 脱敏（512 字符、VT 控制符剥离、敏感 key 前缀匹配）
- 文档查看器按 pane 隔离（`pluginUiPaneSession`）
- 文件管理器定位（`OpenSplitButton` + `revealFileInFileManager`）
- 预览卡整卡点击

**桌面端（低价值，我们不自建安装包）**
- macOS 全透明图标回退 `NSWorkspace`
- Windows `Path.GetFullPath` 路径规范化
- 打包依赖按 `os`/`cpu` 裁剪

### 闭源独有（开源无法获得）

Sites 一键部署、插件批量更新、图片标注、未读任务筛选、批量项目管理、
远程数据同步、远程设备列表/停止重启、MCP 配置 UI、多会话光标、
工作流配额自动续、错峰套餐不自动续费、无进展自动结束、微信推送、
Windows 遮挡恢复、删除项目后新建任务、Kimi K3.1 Pro / MiniMax M3.1 Flash 模型配置。

## 5. 建议

**可以合并**。冲突可控（6 处，4 处取上游），全部质量门禁通过，隔离实例冒烟正常。

合并后需要：
1. 重新构建 server + web 产物
2. 重启 `zcode-web-local`
3. 验证生产（API、设置页、反代、CUA）

待确认项：
- `pnpm-lock.yaml` 删除了 `@napi-rs/wasm-runtime@1.1.3`，需确认本地无依赖
- 上游 `architecture-policy.yaml` 的 upstream-snapshot 更新可能与我们的 selfhost 例外条目有交互（checks 已通过，但需人工确认条目仍在）
