# 自部署记忆页 scope 标签反解

日期：2026-10-24。状态：已实现。

## 背景

记忆页的工作区下拉来自 `memoryService.listProjectMemories()`，scope 目录名
`~/.zcode/cli/memories/projects/<slug>-<hash16>`，label 只取 slug 部分。生成算法
（`apps/zcode-cli/packages/core/src/memory/project-root.ts`，闭源 agent 同算法）：

- `keySource = workspaceIdentity?.trim() || normpath(workspacePath)`
- `hash = sha256(keySource)[:16]`
- `slug = identity ? "project" : sanitize(basename(path))`（小写、非 `[a-z0-9._-]` 折为 `-`、≤48 字符、空则 `project`）

因此 identity 工作区的 scope 恒显示 `project`。自部署实例的三个 `project-*` 是
2026-09 闭源桌面 SSH 远程身份（`remote:ssh:…:cepvor:<路径>`）留下的，页面上无法区分。

## 官方做法（3.16.2 上游，`packages/ui/src/settings/MemorySettingsSection.tsx`）

服务端同样只回 slug。UI 在 `SettingsPage.tsx` 收集 `recentProjects` + 当前 workspaceTabs
的路径叶子名，用与 CLI 逐字符相同的 `normalizeWorkspaceDisplayName` 归一化成 slug，建
`slug → 叶子名` 映射覆盖 catalog label（同 slug 歧义时放弃映射），并按 recentProjects 排序。

结论：官方只覆盖"路径 slug 可从 recentProjects 还原"的 scope；identity scope（slug 恒为
`project`）官方也无解，桌面端同样显示多个 `project`。fork UI 已同步该机制且在工作
（本地 scope 均显示真名），无需重复实现。

## 自部署增强：服务端 hash 反查

在服务端用已知工作区集合反推 scope 目录名，命中则 label 直接给真名；UI 零改动，
且天然覆盖 identity scope（官方能力的超集）。

### 数据流与所有者

```
TaskIndexRepo（只读新增 listDistinctWorkspaceIdentities / 复用 listDistinctWorkspacePaths）
   └─ node.ts 装配闭包 listKnownWorkspaces：合并 paths + identities
        └─ memoryService（新可选端口 listKnownWorkspaces）
             ├─ 对每个候选按 project-root.ts 同算法算 scope 目录名 → 真名
             └─ listProjectMemories：label = 反查命中 ? 真名 : 原 slug 逻辑
```

- 唯一写者不变：本次纯读路径增强，不写任何库。
- 依赖方向：memoryService 不 import 仓库/设置实现，经端口注入候选；候选源
  （tasks 表 distinct 值）本身是事实镜像，非组织态。
- identity → label 的解析在 memoryService 内做：identity 形如
  `remote:ssh:<host>:<port>:<user>:<绝对路径>`，取首个 `/` 起的路径段叶子名；
  解析不出路径则回退原 slug 逻辑。

### 验收场景

1. 本地路径 scope：label 与现状（上游 UI 映射结果）一致，不回归。
2. identity scope：`project-35684314e517a27a`（远程 ESPIDF）显示 `ESPIDF`。
3. 无候选源（桌面旧装配、测试默认）：行为与现状完全一致。
4. UI 侧 slug 映射仍生效：反查 label 与 UI 叶子名不一致时以反查为准（服务端已给真名，
   UI 的 `displayNameBySlug.get(slug)` 匹配不到 slug，回退 `workspace.label` 即反查结果）。
5. 冲突：两个候选算出同一 scope 目录名（keySource 相同）时结果必然一致，无需仲裁；
   反查 label 与磁盘 scope 无关，scope 缺失也不报错。

### 边界

- 反查只在 `listProjectMemories()` 执行时进行，不缓存跨请求状态（列表本身每请求重读磁盘）。
- 闭源 agent 未来若改 keySource 算法，反查失配只是回退现状显示，不会错标
  （hash 不同 → Map 不命中 → 原 slug）。
