# 自部署回到 Electron Local Host 语义

状态：实现中（2026-10-24）
适用分支：`selfhost/maintained`
背景：3.16.2 变基（`c82e3a0c` / 上游 sync `0a1fc56d`）后，自部署 WebUI 无法发消息，报
`project.host-offline` / `project.remote-project-required`。

## 1. Feature Summary / Impact Brief

| Field            | Value                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 自部署 WebUI **只是把 Electron 的 WebUI 拆出来在浏览器跑**，依赖 Electron 的组件接线修好即可；服务与数据语义必须与 Electron 完全一致，不做「独立 Server Core」那一套远端身份 |
| Capability       | 发消息、项目/任务读写、WebUI 任务列表                                                                                                                                        |
| Change layer     | `commit-effect`（入口装配）、`persistence`（任务/项目 host 归属）                                                                                                            |
| Primary seeds    | `packages/server/src/entry-http.ts`、`tasks-index.sqlite`                                                                                                                    |
| Out of scope     | 手机扫码远控、独立 Server Core（source-server）部署、多机 controller/remote 拓扑                                                                                             |

### 1.1 事实（Fact）

1. **v3.14.3 / v3.15.1**（本 fork 的起点与上一版）的 `entry-http.ts` 用的是
   `createLocalServices({...})`，**不传 `projectStorageHostId`** ⇒ 宿主身份取 `local`，与 Electron
   Local Host 完全一致。当时 `tasks` 表**没有 `host_id` 列**（见升级前备份库），任务天然属于 `local`。
2. **上游 3.16.x sync（`0a1fc56d`）** 把入口改为 `createServerHostServices({ sourceServerId, ... })`，
   随后本 fork 变基 `c82e3a0c` 沿用了它。
3. `createServerHostServices`（`packages/services/src/node.ts`）第一件事就是
   `projectStorageHostId = remoteHostIdFromWorkspaceIdentity(buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }))`
   ⇒ `remote:server:<serverid>`，并 `migrateApplicationStorage(..., projectStorageHostId)`。
4. `initializeLegacyTaskIdentity`（`legacy-tasks.ts`）对 `host_id IS NULL` 的旧任务使用
   `ensureHost(db, workspace_key, ownerHostId)`，`ownerHostId` 非空时**强制写成该 host**。
   ⇒ 升级时全部 87 条任务的 `host_id` 被写成 `remote:server:integraaosc`（库中实测：tasks 87 / projects 13 全为该值）。
5. 发消息路径 `project-workspace-navigation`：`hostId !== "local"` 时进入远端分支，要求
   `host.target && readConnectionOwner(hostId) && connectionStatus === "online"`，否则
   `project.host-offline`；而 `resolveProjectHostService` / `readConnectionOwner` **只在 desktop host 装配**，
   自部署 server 没有 ⇒ 必然失败。`assertRemoteTaskDirectories` 另有
   `project.remote-project-required`（`hosts` 表该行 `target_json` 为 NULL，不是可连接主机）。
6. 升级前后任务数据**内容一致**：87 条、task_id 集合完全相同，无新增、无丢失（升级后发不出请求，未产生新任务）。
   升级前的备份库 `/home/cepvor/.zcode/backup/tasks_index-1792782323732-*/tables.sqlite` 是升级前一刻的快照，
   无 `host_id` 列。
7. `settings.json.lastWorkspaceSession` 恰有 13 条 `kind=local, workspacePurpose=project`，与当前 13 个项目一一对应。

### 1.2 推断（Inference）

- 我们不需要、也不应保留 source-server（`remote:server:*`）身份。它是上游为「独立 Server Core +
  手机/远控 replayable 连接」设计的；本 fork 的目标是「Electron Local Host 换个前端」。
- 回到 `createLocalServices`（`projectStorageHostId = local`）后，`readTree` 用
  `ownerHostId ?? "local"` 过滤；只要把 `tasks.host_id` / `projects.host_id` 归一为 `local`，
  发消息、项目、任务列表全部走本机分支，与 Electron 一致。
- 升级前备份库是最干净的恢复基线（未受 3.16 迁移污染）。

### 1.3 未知 / 延后（Deferred）

- 28 条历史任务带 `workspace_identity = remote:ssh:10.126.126.42:22:...`（8–9 月通过 SSH 远端产生的会话）。
  它们会被 `hostForWorkspace` 归到对应的 `remote:ssh:*` host，在 local 语义下即「无法在本机继续的旧远端会话」，
  不影响本机发消息。是否清理这批历史记录另行评估，本次不动。
- 手机扫码远控等真正需要 source-server 语义的能力不在本 fork 范围。

## 2. Product Contract

### 2.1 用户可见合同

1. 自部署 WebUI（浏览器打开 `zcode --web` 后端）与 Electron 桌面端**行为一致**：
   新建任务、发消息、项目列表、任务列表、任务详情都可正常使用。
2. 任务与项目归属为**本机**（`local`），不出现「host-offline」「remote-project-required」。
3. 历史任务在升级后仍可见、可打开（`host_id` 归一为 `local`）。

### 2.2 不变量（Invariants）

- **不得**为修复此问题而给自部署 server 造「指向自己的远程连接」或注册假 online owner；
  那是绕道，违反「与 Electron 一致」。
- 数据迁移必须**保任务事实**（task_id、会话关联、标题、时间戳、分组），只改 `host_id` 归属。
- 迁移前必须备份 `tasks-index.sqlite`。

## 3. 实现方案（A：回到 Electron Local Host 语义）

### 3.1 代码

`packages/server/src/entry-http.ts`：

- `createServerHostServices({ sourceServerId, ... })` → `createLocalServices({ ... })`
- 保留 fork 需要的开关：`topicResourceRelayChannel`、`webRemoteControlRelay: true`、
  `taskListAllWorkspaces: true`、`windowController: true`、`arbitraryFileUploads: true`、
  `browserControlExecutor`、`onAutomationManualRunRequested`。
- **不传** `projectStorageHostId`（⇒ `local`）。不传 `sourceServerWorkspaceService`（用默认无状态实现）。
- `createHttpServer` 不再传 `workspaceIdentityMapper`（那是 source-server 专用），
  `virtualProjects` 保持不变。

### 3.2 数据

采用 **A1：从升级前备份恢复 + 重新迁移到 local**

1. 停 `zcode-web-local`（避免半迁移）。
2. 备份当前库到 `/tmp`。
3. 用备份库替换 `~/.zcode/v2/tasks-index.sqlite`（同时删除 `-wal`/`-shm`）。
4. 起服务，新代码以 `local` 语义跑迁移：13 个项目从 `lastWorkspaceSession` 重建，
   87 条任务 `host_id='local'`，`task_group*` 不变。

> A1 之所以安全：升级前后任务集合完全相同，备份库就是升级前一刻的状态；
> `local` 语义下迁移不丢任务事实，且不产生 `remote:server:integraaosc` 残留 host。

## 4. 验收场景

| #   | 场景                                                                              | 期望                                                                                      |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | 打开 WebUI，看到项目/任务列表                                                     | 13 个项目、87 条历史任务可见                                                              |
| 2   | 在已有项目里新建任务并发送一条消息                                                | 成功，无 `host-offline` / `remote-project-required`                                       |
| 3   | `project.readTree` / `task-groups.read` / `zcode-agent.sendConversationCommandV4` | 全部 OK                                                                                   |
| 4   | 库检查                                                                            | `tasks.host_id` 与 `projects.host_id` 全为 `local`；`hosts` 表无 `remote:server:*` 悬空行 |
| 5   | 重启服务                                                                          | 幂等，不重复迁移、不报错                                                                  |

## 5. 风险与回滚

- 风险：`createLocalServices` 路径缺少 3.16 新增的 `sourceServerWorkspaceService` 相关功能
  （仅影响真正跨机 controller/remote 场景，本 fork 不用）。
- 回滚：保留当前 3.16 库与产物备份；回滚即还原库 + 回退 `entry-http.ts` 并重建。
