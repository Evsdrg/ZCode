# 上游 v3.17.1 同步差异调研（只读，2026-10-31）

本文记录把上游 `3c5b2276..a60ba6a7`（tag `v3.17.1`）与当前 fork 基线对比的结果。**本轮只调研与抽取/测试基建，不做上游合并。**

## 一、上游动作

| 项 | 值 |
| --- | --- |
| 上游提交 | `3c5b2276..a60ba6a7`（单个 `chore: sync ZCode source`） |
| 新标签 | `v3.17.1` |
| 变更规模 | 5231 文件，+216552 / −611504 |
| 闭源端 | 3.16.3 → **3.17.1**（`build-meta.json` 的 `minCompatibleVersion` 也是 3.17.1） |
| Agent 后端 | 0.17.0 → **0.17.1** |

## 二、影响 fork 最大的一处：测试体系重写

上游把根 `vitest.config.ts` 收敛成**单一 `engineering` project**，只跑 `scripts/engineering-test-files.json` 里列出的清单，并**删除了约 1978 个业务单测文件**（`packages/*/test/**` 与 `src/**/*.test.*` 大量消失）。

对本 fork 的后果：我们自建的测试（Linux CUA helper 接入、host-native、自部署平台适配等）**不在上游清单里，合并上游后会被静默跳过**——`vitest run` 会全绿，但一个 fork 测试都没跑。这是最危险的静默退化。

### 应对（第 3 步已落地）

- `scripts/selfhost-test-files.json`：fork 自有测试的显式清单（当前 52 个）。
- `vitest.selfhost.config.ts`：补充入口，与上游根配置同别名/同 setup，单独收集 fork 清单。
  - 三个 project：`selfhost`（Node）、`selfhost-dom`（happy-dom，少数无文件级 `@vitest-environment` 声明的 UI 测试）、`selfhost-known-debt`（默认空 include 关闭，用 `ZCODE_SELFHOST_KNOWN_DEBT=1` 显式开启）。
  - 用空 `include` 关闭而不是 `test.enabled`：Vitest 4 的项目级 `enabled` 不生效。
- `package.json` 新增 `test:selfhost` 与 `test:selfhost:known-debt`。
- 上游 `pnpm test` / `test:unit` 语义不变，本入口是**补充**而非替换。

已知既有债：`packages/services/test/relayDeviceTransportV2.test.ts` 的 22 个用例全部使用 3.16.2 变基时被替换掉的旧 transport 契约，在 fork 基线 `39c88478` 上同样失败，与本轮无关，默认跳过但可显式运行。

## 三、`packages/web/src/platform/`：上游 3.17.1 原生就有

关键发现：上游 3.17.1 **新增了 `packages/web/src/platform/`**，且文件名与我们第 2 步抽取的结果逐字相同（`contract.ts` / `index.ts` / `saveBrowserFile.ts` / `module.ts` / `CONTRACT.md` / `contract.example.ts`）。

这不是巧合式的撞车，而是同一重构方向：上游也在把 `createWebPlatform` 从 `main.tsx` 抽成独立 managed 模块。`module.ts` 两边**逐字节相同**。

### 合并时的冲突面

| 文件 | 状态 |
| --- | --- |
| `module.ts` | 完全相同，无冲突 |
| `saveBrowserFile.ts` | 仅注释位置差异（上游注释在函数内，我们放在 JSDoc） |
| `contract.example.ts` | 我们多一个 `webPlatformWithoutHostNativeIsLimited` 示例 |
| `contract.ts` | 我们多四个自部署接口：`WebHostNativeService` / `WebMcpDirectoryService` / `WebManagedBrowserMaintenance` / `RelayStatusSource` 再导出 |
| `index.ts` | 我们多自部署注入项与 relay 投影逻辑（240 → 431 行） |

上游 `index.ts` 有四个我们**没有**的方法：`getFileApplications`、`openFileWithApplication`（3.17.1 新增的「用指定应用打开文件」能力）、`importChromeBrowserData`、`openExternalFile`（后两者是上游保留了失败桩，我们按「可选方法不写桩」原则删掉了）。

**合并策略**：以上游文件为基底，把我们的自部署注入项（`relayStatusSource` / `managedBrowserMaintenance` / `mcpDirectoryService` / `hostNativeService`）与相应能力标志叠加回去；`getFileApplications` / `openFileWithApplication` 需要新增 host-native 实现（Linux 侧走 `xdg-mime`/`gio` 查询与 `gtk-launch`），是合并后的独立任务。

`architecture-policy.yaml` 里的 `web-platform` 模块登记上游也会有，合并时按上游为准。

## 四、闭源端 3.17.1 的 CUA 协议：**没有破坏性变更**

对比 `3.16.3` 与 `3.17.1` 的 deb 内 `app.asar` 与 `glm/zcode.cjs`：

### 4.1 Broker 方法清单：43 个，逐项相同

`chunk-53SIT7PA.js`（broker 客户端常量）**md5 完全相同**（`0770f53a...`）。方法数组两版都是同一份 43 项，包括我们已实现的 `broker_info`、`capture_app`、`element_*`、`drag`、`hold_key`、`cancel_input_holds` 等。

### 4.2 握手协议：未变

```js
authenticate params: { clientApiVersion: CUA_BROKER_IPC_VERSION, ...authenticateParams }
CUA_BROKER_IPC_VERSION = 3   // 两版相同
业务帧: { id, method, params } → { id, ok, result } / { id, ok:false, error }
```

`node-repl-host` 的 `BrokerClient.call` 源码两版**逐字相同**。

### 4.3 真正变化的三处（都不影响我们的 helper）

**① `capture_app` / 元素 bounds 校验无变化**：`asElements`/`asBounds2` 的严格 4 数字校验两版一致——我们此前修的 `bounds: null → [0,0,0,0]` 兜底在 3.17.1 下依然必要。

**② SDK 层 `left_click_drag` 新增 `strategy` 透传**（`computer-use-client.mjs`）：

```diff
 left_click_drag({from_target, to, modifiers?="", strategy?="auto", app_ref?, return_state?})
+ ...(options?.strategy ? { strategy: options.strategy } : {}),
```

`node-repl-host` 的 drag handler 也新增 `strategy: args.strategy ?? "auto"` 透传。**我们 helper 的 `drag` 不读 `strategy`**——但 Linux 的 drag 本来就是「前台 raw」（没有 macOS 的后台级 / Windows 的 PostMessage 级），`auto` 与 `event` 在 Linux 上语义等价，因此**不需要改**。若将来 Linux 加了后台拖拽级，才需要读取该字段。

**③ `elements()` 的 `tree_shown_to_model` 从 `false` 改成 `true`**（SDK 内部行为修正：元素表回给模型写的 JS，属于「模型可见」，应记入位移台账）。这是 SDK 对 `get_app_state` 的调用参数变化，我们 helper 不消费该字段（它只影响 producer 侧的记账语义，不影响树内容），**无需改**。

### 4.4 新增但不属于 broker 协议的部分

- `ZCODE_OFFICIAL_ENDPOINT` / `ZCODE_OFFICIAL_ENDPOINT_TOKEN` 两个环境变量：0.17.1 新增的**官方端点直连凭据**，由 desktop main 起本地 loopback 代理后注入。与我们自部署链路无关（我们不设这两个变量，agent 走原有 provider 配置）。
- `HELPER_GHOST_CURSOR_OVERLAY_ARG = "--ghost-cursor-overlay"`：macOS/Windows 产品链的虚拟光标 overlay，**Linux helper 不需要**（我们本来就是真实指针）。
- `node-repl-host` 新增 browser-broker-proxy（`zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse` 两个 `_meta` 键）：用于会话特性统计（`recordSessionFeature`），不改变 CUA 调用协议。
- 新增 `zcode-site-plugin`（官方插件），与 CUA 无关。

## 五、合并上游前需要重新决策的点

1. **`entry-http.ts` 的 local host 语义**：上游 3.17.1 的 `packages/server/src/entry-http.ts` 若仍用 `createServerHostServices`，我们的 `createLocalServices` 补丁必须重新应用（见 `selfhost-local-host-semantics.md`）。
2. **`shouldUseCuaPermissionService` 的 Linux 分支**：上游仍是 `darwin || win32`，我们的 Linux 放行需重新应用。
3. **`resolveSpawnEnv` 的 Linux 分支**：上游 `node.ts` 仍然只有 darwin/win32 做 helper 注入（`2389` 行附近），我们的 Linux 分支需重新应用。
4. **`node.ts` 结构变化很大**（+87/−26 关键 hunk，涉及 project-data-port、data-sync、provider-provisioning-status 等新服务），重放补丁时要重新定位。
5. **测试体系**：合并后必须先跑 `pnpm test:selfhost`，确认 52 个 fork 测试一个不少。
