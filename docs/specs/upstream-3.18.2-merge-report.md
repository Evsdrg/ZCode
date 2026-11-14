# 上游 3.18.2 合并记录

## 范围与基线

- fork 基线：`5f7266736602e664a64a370bec9b35548b0117e3`（3.18.0）。
- 合入 `c5904686`（3.18.1）、`fec97590`（3.18.2），目标分支 `selfhost/maintained`。
- 用户批准代码合并与推送，未批准部署；本次不升级闭源客户端、不重启生产服务。
- **执行偏差**：前一轮构建直接覆盖了生产正在使用的 `packages/web/dist`，新版静态前端已被提供；`packages/server/dist` 也已更新，但运行中 server 未重载。不能将本次描述为“生产完全未变”。

## 合并处理

只有两个文本冲突，均为双方独立追加内容：

| 文件                       | 处理                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `.gitignore`               | 保留 fork 的 Rust helper/socket 忽略项与上游的 NSIS 生成目录忽略项 |
| `architecture-policy.yaml` | 保留 fork 四个受管模块与上游 `cli-memory-diagnostics` 模块         |

上游将 `packages/services/src/feedback/feedbackLogArchive.ts` 纳入
`cli-memory-diagnostics` 的公开入口。fork 的 `log-export` 已有对该文件的依赖，
因此同步补齐 `architecture-policy.yaml`、`packages/services/src/log-export/module.ts`
和该模块 `CONTRACT.md`，不复制实现，不改变日志导出的数据归属。

## fork 保留核对

- Linux CUA helper、permission broker、托管浏览器、Web platform、host-native、媒体预览
  与 Web menu 快捷键目录相对 fork 基线无改动。
- `App.tsx` 的闲时通知、完整视图、PPTX 自动预览解门控均保留。
- `SettingsPage.tsx` 的 `hostPlatform`、个性化能力、证书策略文案与通知权限接线保留。
- `useComposerVoiceInput.ts` 的 `createUuid()` 保留，并接入上游权限引导。
- `shared/platform.ts` 的 fork capability flags、`node.ts` 的自部署装配与新增
  `loadStartPlanMaterial` 并存。
- HTTP 场景的 UUID 与 SHA-256 fallback 保留。

### 修正前期评估

1. `side-pane-full-view/enterRequest.ts` 的删除与全部源码引用一起自动合并，未产生预想的
   import 断裂；不应恢复上游已移除的事件通道。fork 完整视图功能保留。
2. `enablePrivateFileKeyFallback` 仅由 Linux Desktop Main 开启，Server/CLI 不开启。
   此次合并不替换或迁移自部署现有的 `credential-secret`。
3. Start Plan 的 `zai_cn` 家族修复不等于已修复此前的 WAF `3012`；本次没有执行真实账号
   登录、套餐领取或模型计费请求，不能据此宣称那些问题解决。
4. 3.18.1 的语音改动是已有功能的权限引导增强，不是首次新增语音输入。

## 验证

Node `24.14.0`，pnpm `10.33.2`。

| 检查                                | 结果                                                |
| ----------------------------------- | --------------------------------------------------- |
| `pnpm typecheck`                    | exit 0                                              |
| `pnpm lint`                         | exit 0，553 warnings / 0 errors                     |
| `pnpm architecture:check --changed` | 0 violations                                        |
| `pnpm test:selfhost`                | 63 文件通过、3 跳过；447 用例通过、4 跳过           |
| `pnpm test:engineering`             | 167 文件通过、2 跳过；1031 用例通过、10 跳过        |
| `pnpm check:e2e-remote-targets`     | exit 0                                              |
| `pnpm docs:stale-phrases:check`     | exit 0                                              |
| `pnpm db:schema:check`              | exit 0                                              |
| `pnpm test:architecture`            | exit 0                                              |
| server / web 构建                   | 均成功；server 无顶层 `from "@zcode/services/node"` |
| `git diff --check`（暂存与未暂存）  | 通过                                                |

### React Hooks 专项核对

用仅启用 Hooks 两条规则、无 ignorePatterns 的独立配置扫描本次变更的 29 个 UI 源文件，
包括根 lint 排除的 `components/ai-elements/reasoning.tsx`。使用同一 Oxlint 1.60.0 对照：

| 树                   | 文件数 | Hooks 诊断数 |
| -------------------- | -----: | -----------: |
| fork 基线 `5f726673` |     28 |           37 |
| 上游 `fec97590`      |     29 |           35 |
| 合并工作树           |     29 |           35 |

按文件、规则、消息及重复次数比较：合并相对两棵基线都没有新增诊断。
人工复核新闭包输入：`startPlanFamilyDomain` 已进入导航 memo 依赖；
`voiceInput.permissionGuide` 已进入 composer memo 依赖；fork 的 `isDesktop`、
`hostPlatformProp` 依赖保持对应实际读取；已删除完整视图事件订阅的依赖一并移除。
35 条存量诊断没有被禁用，也不声称已修复。

### 隔离浏览器冒烟

- 仅监听 loopback 的独立实例；单独设置 `HOME`、`USERPROFILE`、`ZCODE_DESKTOP_HOME_DIR`
  与 XDG 目录，使用一次性私有密钥与独立 browser session。
- 空白数据目录，不复制生产账号、凭据、任务或自动化配置；通过“暂时跳过”进入 UI。
- `server-info` 返回 3.18.2 / linux，无鉴权 401、有鉴权 200。
- 17 个设置分区可打开并显示对应标题，浏览器 page errors 为空；个性化编辑器与键盘
  快捷键入口保留。这只验证渲染与基本路由，不代表各业务操作全部执行成功。
- 未打开电脑控制分区，以免隔离实例连接生产 helper；未执行 CUA 授权、输入注入、
  官方账号登录、Start Plan 领取、模型请求或真实任务删除。
- 在浏览器中临时移除 `crypto`，直接调用本次产物导出的 checksum：`abc` 的 SHA-256
  与标准值一致，随后恢复环境。此项是产物级 fallback 验证，不冒充一次真实图片上传。
- 浏览器已关闭；按启动时记录的 PID、经 HOME 校验后 SIGTERM 清理隔离 server，端口释放。

## 部署边界与未完成事项

本轮复核时，生产 `server-info.version` 仍为 3.18.0，生产服务的 PID 与启动时间未变，
但首页已提供构建后的 `index-B5MHpYiB.js`（3.18.2 前端）。这一事实已向用户说明。
发现后停止对生产产物目录的写入；不擅自重启或回退。

找到的旧产物备份早于合并前最后一次归档删除修复，尚不能认定为精确回退源。
恢复生产静态前端需用户确认，并以合并前提交 `5f726673` 在隔离目录重建或找到经核对的
完整产物备份；不得用更早备份默默丢掉已上线修复。

后续所有“只构建、不部署”操作必须把输出放到独立目录或 worktree，不能使用生产
`ZCODE_WEB_STATIC_ROOT` 指向的目录。server 磁盘产物同样不得被无关重启意外启用。
