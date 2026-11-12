# 上游 v3.18.0 合并报告

日期：2026-11-12
分支：`merge/upstream-3.18.0`（基于 `selfhost/maintained` 的 `0019c2b6`）
合并提交：`c55cd30b`
上游提交：`b95ebaff`（`chore: sync ZCode source v3.18.0`，2026-11-10）

## 1. 变更规模

| 项 | 值 |
|---|---|
| 上游变更 | 5099 files / +429,348 −44,745 |
| fork 领先提交 | 71 |
| 冲突文件 | 40 |
| 新增模块（架构） | 73 个 id |

## 2. 冲突解决

### 2.1 保留双方（语义不重叠）

| 文件 | 保留内容 |
|---|---|
| `packages/services/src/node.ts` | fork：`webRemoteControlRelay` / `taskListAllWorkspaces` / `windowController` / `arbitraryFileUploads` / `selfHostOptions`；上游：`onPluginManagementMutated`、`credentialCipherProvider`、`worktreeRemovalGate`、`appControlService` |
| `packages/services/src/session/tasksDatabase/migrations.ts` | 上游 `0007_task_permanent_deletion` + fork `0008_legacy_unique_constraints`（顺序不能颠倒） |
| `packages/shared/src/platform.ts` | fork `requestNotificationPermission` + 上游 `showExtensionNotification` / `onExtensionNotificationClick` |
| `architecture-policy.yaml` | 上游 3.18 的 73 个新模块 + fork 的 16 个自部署模块（分 modules / exceptions 两段） |

### 2.2 取上游（fork 改动属纯格式化或被上游取代）

| 文件 | 原因 |
|---|---|
| `desktopNetworkPolicy.ts` | fork 改动仅 oxfmt 换行；上游重写了 `readCustomCaCertificatesFromPem` 的返回值类型 |
| `desktopRemoteUsageArmsTelemetry.ts` | fork 改动仅 oxfmt 换行 |
| `ConversationTurnGroup.tsx` | **关键决策**：上游 3.18 原生实现了 `assistantHistoryDefaultOpen`（历史回合默认折叠），与 fork `d05fba6e` 的 `historyStepSegments` 功能重复。选上游实现，删除 fork 的 `historyStepSegments.ts` / `.test.ts` 及 `historyStepsGroupingEnabled` 全套设置 |
| `run-windows-e2e-shards.mjs` / `tsconfig.e2e.json` / e2eWorkerIsolation / e2e fixtures | 上游 E2E 基础设施重组 |
| `CodingPlanUpgradeDialog.tsx` / `useCodeCommentContexts.ts` | 上游删除了 `credentialService` prop / 新增 scoped 恢复 |
| `i18n/locales/*.ts` / `protocol.ts` / `validationAppSettings.ts` / `conversationRowContext.ts` | 上游彻底删除 `toolGrouping*` 设置，仅保留 fork 的 `historyStepsGroupingEnabled`（后又因上游原生折叠一并删除） |

### 2.3 取 fork

| 文件 | 内容 |
|---|---|
| `helpAppConfig.ts` | `credentials` 选项（同源反代需带鉴权 cookie），叠加在上游 `redirect: "error"` 之上 |
| `communityUrl.ts` | 自部署 help 配置走同源反代 `/api/v1/client/configs`；注入式 fetch 路径保留旧语义 |
| `BrowserSettingsSection.tsx` | `showCertificateSettings` 能力判定 + `importAvailable`，同时接上游新增的文件树 HTML 打开设置 |
| `SettingsPage.tsx` / `settingsPageHelpers.tsx` / `SessionPane.tsx` | fork 的 `hostPlatform` 传递、`canEditUserInstructions`、`supportsSidePaneFullView`；上游 `MemorySettingsPage` 替换 fork 的 `MemorySettingsSection` |
| `Root.tsx` | fork `CodePreviewSettingsBridge` + 上游 `DataSyncDialogProvider`，`AssistantCodeCommentFeatureProvider` 恢复上游层级 |

## 3. 合并后发现并修复的缺陷

**`exportLogs` 的 electron 动态导入**（commit `9ada1d1e`）

`exportLogs` 下沉到 services 后仍保留 `await import("electron")` 作为默认 `showItemInFolder`。server 的 `entry-http` 是 ESM bundle，该分支执行时 esbuild 会把 npm `electron/index.js`（CJS）内联并在其中执行 `require("child_process")`，运行期抛 `Dynamic require of "child_process" is not supported`，`/api/logs/export` 恒 500。

修复：默认改空操作，桌面 Host 显式注入 `shell.showItemInFolder`。

## 4. 质量门禁

| 项 | 结果 |
|---|---|
| `pnpm install` | +47 packages，node-pty 重建 OK |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 error / 553 warning（上游新增代码带来，均为既有规则） |
| `pnpm architecture:check --changed` | violations 0 |
| `pnpm test:selfhost` | 446 passed / 4 skipped |
| `pnpm test:engineering` | 1019 passed / 8 skipped |
| server bundle | 6,490,413 B，无裸导入 |
| web 入口 | `index-DpvoLlGk.js`，含 `PRIVATE_DEPLOYMENT` fallback |

## 5. 隔离实例验证

独立 `HOME` 目录、隔离端口、生产数据快照（不含 CLI 会话库）。

| 项 | 结果 |
|---|---|
| server-info | 200，version 3.18.0，hostPlatform linux |
| 设置页 18 个分区 | 全部渲染，标题正确 |
| 3.18 新功能 | 「行为与工具」分区存在、「归档管理」有「永久删除」按钮 |
| `/api/media/preview` | 缺参 400、未授权路径 404（预期） |
| `/api/logs/export` | 200 / application/zip / 4.6MB，zip -t 无错，701 文件，about.txt 版本 3.18.0 |

未验证项：本机 keyring 在隔离 HOME 下不可用（生产用系统 Secret Service），因此账号相关的 RPC 在隔离实例里报 credential storage unavailable；这不影响 UI 渲染与路由验证。

## 6. 3.18.0 相对 3.17.2 的能力变化（开源侧）

新增 73 个架构模块，主要方向：

- **扩展体系**：`extension-host`（独立进程）、`extension-host-protocol`、`extension-slots`、`extensions-service`、`plugin-api`、`plugin-host-queries`、`plugin-install-interaction`
- **Session Control / App Control**：`session-control`、`app-control`、`app-control-protocol`、`app-control-navigation`、`cli-session-control-*`
- **Managed Worktree**：`managed-worktree-shared/repo/tasks/ui`
- **语音输入**：`voice-input`、`voice-input-service`
- **设置页搜索**：`settings-search`、`settings-search-existing-row-edit`
- **资源管理器**：`resource-manager`
- **选择评论**：`selection-comment`、`conversation-selection-comment-*`
- **Windows 运行时**：`windows-runtime-host`
- **Web 分享/鉴权**：`web-share-manage`、`web-auth`
- **设计模式**：`browser-design-*`、`design-runtime`、`design-plugin-third-party-resources`
- **其他**：`credential-security`、`context-composition`、`prompt-snapshot`、`task-row-hover`、`voice-input`、`agent-crash-diagnostic`

注意：这些是**开源侧**模块。闭源 3.18.0 的 `extension-host`（1.45MB 独立产物）与我们开源实现不完全等同，需要单独核对。

## 7. 仍未做

- 未合回 `selfhost/maintained`，未推送
- 未部署到生产
- Electron E2E 全量未跑（形态不匹配）
