# 上游 3.17.1 合并与闭源协议比对

本文记录把 `zai-org/ZCode` 的 `v3.17.1`（`a60ba6a7`）合入本 fork 时的实测结果，
以及闭源客户端 3.16.3 / 3.17.1 与开源版本在 CUA 协议上的一致性核对。

## 1. 版本事实

| 项 | 值 |
|---|---|
| 上游 tag | `v3.17.1`（`a60ba6a7`，2026-10-29） |
| 上一基线 | `3c5b2276`（3.16.2） |
| 变更规模 | 5231 文件，+216552 / −611504 |
| 本机已装闭源桌面端 | `3.16.3-8992` |
| CDN 上的闭源桌面端 | `3.17.1-9553`（`linux-x64` deb 206,815,460 B，2026-10-29 14:26 GMT） |
| 官方 manifest 指向 | 仍是 `3.16.3`（`releaseDate 2026-10-23T03:02:01.660Z`） |

**注意**：3.17.1 的 `linux-x64` 产物已上传 CDN（deb 与 AppImage 均 HTTP 200），
但 `zcode.z.ai/api/v1/releases/electron/manifest` 尚未指向它，`darwin-arm64` /
`win32-x64` 的 3.17.1 产物也不存在。判定为**灰度或未完成发布**，不能作为稳定升级目标。

## 2. 闭源 CUA 协议与开源版本的逐字节比对

比对对象是 `packages/zcode-cua-plugin/scripts/computer-use-client.mjs`
（CUA SDK，模型侧工具定义与 broker 调用参数都由它构造）。

| 对比 | 结果 |
|---|---|
| 闭源 3.16.3 vs 开源 3.16.2 | **逐字节完全一致**（1202 行，diff 为空） |
| 闭源 3.17.1 vs 开源 3.17.1 | **逐字节完全一致**（1210 行，diff 为空） |
| 开源 3.16.2 vs 开源 3.17.1 | 8 行差异，见下 |

结论：**闭源客户端的 CUA 插件 SDK 直接取自同一份开源源码**，不存在私有分支。
因此开源 3.17.1 的 CUA 变更就是闭源 3.17.1 的实际行为。

### 2.1 3.17.1 的 CUA SDK 变更（影响本 fork 的 Helper）

1. **`drag` 增加 `strategy` 透传**

   ```js
   ...(options?.modifiers ? { modifiers: options.modifiers } : {}),
   ...(options?.strategy ? { strategy: options.strategy } : {}),
   ```

   `DragOptions` 早已声明 `strategy`，broker 的 `drag` handler 也早已按
   `strategy === "event"` 走前台 `SendInput`，但 SDK 此前只透传 `modifiers`，
   导致前台拖拽从 SDK 层不可达。

2. **`elements()` 的 `tree_shown_to_model` 由 `false` 改为 `true`**

   这是位移台账（element index ledger）的记账修正。`elements()` 的返回值
   包含 `index` 的元素表，模型直接拿它当点击参数，因此构成「模型可见」。
   旧值 `false` 会让台账只保留更旧的树，模型用新索引点旧树比对，
   产生 `element_index_shifted` 假阳性，真位移反而拦不住。

3. **移除 `greater: ">"` 键别名**

   输出 `>` 从未通过工具层白名单，是端到端死路径。

三项都不改变 helper 的 IPC 协议，只改变 SDK 传给 broker 的参数取值。
**对我们的 Linux Helper 无破坏性影响**，但 `strategy` 透传意味着
`drag` 现在可能收到 `strategy: "event"`；helper 应能接受并忽略未知字段
（当前实现按对象解构，未知字段天然被忽略，符合预期）。

### 2.2 broker IPC 协议未变

| 项 | 3.16.3 | 3.17.1 |
|---|---|---|
| `CUA_BROKER_IPC_VERSION` | 3 | 3 |
| 首帧 | `authenticate` + `clientApiVersion` | 同 |
| 帧格式 | NDJSON `{id, method, params}` | 同 |
| `PermissionBrokerClient` 字段 | 6 处 `authenticateParams` | 同 |
| helper 方法名集合 | 8 个 | 8 个（0 增 0 删） |

`PermissionBrokerClient` 的实现（socket 属主校验、`world-writable` 拒绝、
`requestId` 单调递增、取消语义）两个版本完全一致。

### 2.3 `node-repl-host` 内部有重要变更，但不越过 helper 边界

3.17.1 引入了 **call ledger**（`apps/zcode-cli/packages/node-repl-host/src/call-ledger/`）：
`cua-broker.ts` 从「全进程共用一个 token」改为「每次调用由账本签发 token」，
并补齐 subagent 拒绝、应用身份回写。

```js
// 3.17.1
const entry = ledger.resolve(payload.token);
if (!entry) throw new Error("Computer Use broker request is not authorized");
```

这一层是 **node_repl cell → cua-broker** 之间的鉴权，位于 helper 的**上游**。
helper 只面对 `PermissionBrokerClient.call()`，看不到 token 机制的变化。

## 3. fork 补丁在 3.17.1 下的存续性

| fork 补丁 | 3.17.1 上游是否已修 | 结论 |
|---|---|---|
| `entry-http.ts` 用 `createLocalServices` 而非 `createServerHostServices` | ❌ 上游仍是 `createServerHostServices` | **补丁仍必需** |
| `createLocalServices` 的串行 `migrateApplicationStorage` 预热 | — | 保留 |
| `web/src/platform/` 独立模块与 `createWebPlatform` | 上游也新增了同名模块（`createWebPlatform` 已存在） | **已对齐，无冲突** |
| `packages/zcode-cua/linux-helper/`（Rust） | 上游无 Linux producer | **补丁仍必需** |
| `browserSha256Fallback` / `PRIVATE_DEPLOYMENT` | 上游无 | **补丁仍必需** |
| `vitest.selfhost.config.ts` 自部署测试入口 | 上游测试体系改为 `engineering`，无 selfhost 概念 | **补丁仍必需** |

其中 `web/src/platform/` 是意外收获：我们在 3.16.2 时抽出的模块结构
与上游 3.17.1 的 `packages/web/src/platform/` 布局**完全一致**
（`index.ts` / `contract.ts` / `module.ts` / `saveBrowserFile.ts` / `CONTRACT.md`），
合并时只做文件级重叠，无结构性冲突。

## 4. 合并结果验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | 0 error / 93 warning（较 3.16.2 的 105 有减少） |
| `pnpm architecture:check --changed` | violations 0 |
| `pnpm test:selfhost` | 48 files / 312 passed / 4 skipped |
| `pnpm test:engineering`（上游新测试体系） | 157 files / 961 passed / 8 skipped |
| `pnpm --filter @zcode/server build` | `entry-http.js` 5.64 MB，无裸导入 |

### 4.1 合并中修复的两个真实缺陷

**① `localWindowControllerService.listTaskList` 未处理 `"host"` 联合类型**

上游 3.17.1 把 `ZCodeTaskListQuery.workspaceScopes` 从
`ZCodeTaskListWorkspaceScope[]` 放宽为 `...[] | "host"`（`"host"` 表示
由存储 owner 决定全部范围）。我们的自部署 Controller 实现直接
`for (const scope of params.workspaceScopes)`，遇到 `"host"` 会把字符串当数组遍历
——TypeScript 报错，运行时则会静默只订阅三个字符。

修复：仅当是数组时才建立 workspace 事件订阅，`"host"` 直接透传给
`taskService.listTaskList`（自部署的 taskService 本身就是存储 owner）。

**② `packages/shared/package.json` 的 `exports` 出现重复键**

三路合并把 fork 独有的四个 export（`gen-ui` / `testing/fake-relay-v2` /
`request-security` / `web-remote-relay`）保留了两次。JSON 解析不报错
（后者覆盖前者，值相同），但 esbuild 会警告 `duplicate-object-key`，
且属于真实的合并事故。已删除重复段。

## 5. 结论

1. **闭源 3.17.1 的 CUA 行为等于开源 3.17.1**，不存在需要单独跟进的私有协议。
2. **broker IPC 协议在两个版本间完全稳定**（版本号仍为 3），Linux Helper 无需改动。
3. **3.17.1 的 CUA 变更集中在 SDK 参数层**（`drag.strategy`、`tree_shown_to_model`），
   不触及 helper 契约。
4. **上游仍未修复自部署 WebUI 的 host 语义问题**，`createLocalServices` 补丁继续保留。
5. **闭源桌面端 3.17.1 已在 CDN 就绪但未进 manifest**，不建议现在升级；
   等 manifest 切换后再评估。
