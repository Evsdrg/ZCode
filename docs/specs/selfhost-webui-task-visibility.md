# 自部署 WebUI 任务可见性：全工作区视图

状态：已实施
适用形态：`zcode --web` / `entry-http` 自部署；desktop 不受影响。

## 背景

自部署 server 是单工作区模型（`ZCODE_SERVER_WORKSPACE` 钉死主工作区），而任务索引里的
任务分布在多个 workspace_key（各项目目录、`remote:ssh` 身份变体、「不在项目中工作」的
default 草稿工作区）。按主工作区scope查询会隐藏其他工作区任务；初始项目仅有归档任务时，侧栏可能出现常驻空项目。

## 行为规则

- `createLocalServices` 新增选项 `taskListAllWorkspaces?: boolean`；自部署 `entry-http`
  **默认开启**（desktop host 不传，行为不变）。
- 开启后任务列表方法（`listTasks`/`listPinnedTasks`/`listArchivedTasks`/
  `listDeletedTaskIds`/`listTaskList`）的 workspace scope 替换为「任务索引里有未删除
  任务的 distinct workspace_path 全集」；结果按 taskId 去重。
- 展示归一：返回任务的 `workspace_path` 去尾斜杠（`/workspace/project/` 变体并入
  project 分组）；`workspaceIdentity` 保留（远程身份会话的打开路由不受影响）。
- 非 workspace 参数（`provider`、`kind`、`sortBy`、pinned/archived 语义）保持原样。

## 失败语义（全工作区视图）

- 任一工作区的列表查询失败：该工作区按空集降级，不上抛（沿袭 relay 桥事故确立的
  「可选能力不上抛」不变量）。
- 任务索引为空：scopes 回退为主工作区自身。

## 窗口 Controller（`windowController`）

侧栏「项目」分区走 `useWorkspaceTaskLists` 的直连读（`listTasks` 等），而**全局任务列表**
（`useGlobalTaskList`：侧栏「任务」分区 / 时间线视图 / 置顶 / 归档 / 命令面板 / Header 计数）
统一读窗口级 `IWindowControllerService.listTaskList`。该服务过去只由桌面 Host 注册
（`packages/desktop/src/host`），自部署 server 从不注册——channel 不存在，客户端每次调用都
超时降级为空列表，表现为侧栏「任务」分区恒显「还没有任务」，而项目分区正常。

- `createLocalServices` 新增选项 `windowController?: boolean`；自部署 `entry-http` **默认开启**
  （desktop host 不传，行为不变）。
- 实现：`createLocalWindowControllerService`（`packages/services/src/window-controller/`）——
  `listTaskList` 直读**未扩张**的任务服务（保留 query 的 `workspaceScopes`/`kind` 与
  `total`/`hasMore` 分页语义），并补齐手机端 schema 需要的 `sourceAvailability`/`liveStatus`。
- **失效帧（必须）**：客户端 registry 只靠 Controller 帧失效查询缓存并 bump revision；
  桌面端推逐行 delta，自部署没有 sessions-index 实时投影、产不出 delta。因此本服务在
  `listTaskList` 时对涉及的 workspace 惰性订阅 `onDynamicWorkspaceEvent`，收到
  `workspace_task_list_changed` 即向 tasks-index 订阅推送**空快照帧**（协议要求快照从 seq 0
  起、`logEpoch` 与帧一致）——registry 收到快照清空查询缓存并 bump revision，`useGlobalTaskList`
  随之重拉。缺失该帧的后果（已实测）：归档/置顶 RPC 成功、tasks-index 已落库，但时间线列表
  永远停留旧数据，表现为「无法归档」。写入面（`mutateTask` 等）UI 不经此路径（侧栏
  pin/archive/delete 直连 `zcodeTaskService`），保留显式 unsupported。

## 状态所有者

- 全工作区视图：`allWorkspacesTaskView` 包装（唯一）。只覆盖 5 个列表方法；其余成员经
  Proxy 透传 base（bind this=base）。`listPinnedTaskIds` 本就是全局无 scope，不在覆盖面内。
- 窗口 Controller：`localWindowControllerService`（server 形态）；任务事实仍归 tasks-index。

## 验收场景

1. WebUI 侧栏出现全部有任务的项目分组。
2. 「不在项目中工作」的 default 草稿任务可见，且出现在侧栏「任务」分区。
3. project 分组包含其名下未归档任务（含当前会话），不再显示为空。
4. desktop 形态不受影响（不传开关）。
5. 自部署 WebUI 的置顶/归档/命令面板等全局列表不再恒空（Controller 已注册）。
