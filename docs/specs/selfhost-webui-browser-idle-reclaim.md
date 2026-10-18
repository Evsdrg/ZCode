# 托管浏览器空闲会话回收

状态：已实施
适用：`packages/server/src/browser/`（`HeadlessBrowserRuntime` / executor）。桌面 IAB、CLI 自身托管后端不变。

## 背景与实测

2026-10-18 验证的两个问题（fork 引入 server 托管形态后的缺口；桌面有窗口生命周期、
CLI 有进程退出兜底，唯独长驻 server 两者皆无）：

1. **discovery 拉进程**：`list()` 调 `ensureBrowser()`，任何
   `agent.browsers.list()` 探测（WebUI 重连即触发）都会启动两台 headless 浏览器
   （Chromium + Firefox 全家进程 ~600MB RSS），此后即使零命令也永久驻留。
   实测：服务 19:25 重启 → 19:26:14 两个引擎 "managed browser started"，
   之后无任何浏览器命令。
2. **会话永不回收**：`#sessions` Map 只增不减（断连才清）；CLI 后端有
   `turnEnded`/`closeSession`/`close()` 三级回收，server 侧协议无
   `interaction/browserClose` 通路，executor 的 `turnEnded` 也是空操作。

## 产品规则

- **空闲会话回收**：每个 scope session 记 `lastUsedAt`（任何 `execute` 刷新）；
  定时扫描，空闲超过 `IDLE_SESSION_TIMEOUT_MS`（10 分钟）的 session 关闭
  （`trackClose` 路径，同断连清理）并从 Map 删除。
- **浏览器进程回收**：所有 session 清空后，若浏览器空闲超过
  `IDLE_BROWSER_CLOSE_DELAY_MS`（5 分钟，从最后一个 session 关闭起算），关闭浏览器
  进程；下次 `ensureBrowser()` 按需透明重启。**空闲关闭不 bump generation**：此时所有
  session 已回收，没有旧 Context/tab 可漂移到新进程（旧 tabId 自然报 unavailable），
  bump 只会让模型缓存的 browser wrapper 无故 stale。断连路径仍照常 bump。
- **discovery 不拉进程**：`list()` 不再调 `ensureBrowser()`，只做廉价判断后返回
  descriptor：runtime 未关闭，且浏览器可执行文件存在且可执行（显式配置路径，或
  Playwright 缺省安装路径）。任一不满足返回空，保持「缺失引擎不出现在发现结果」
  「关闭后 list 不复活」的既有语义。真实启动推迟到第一次 `execute`；可执行文件
  存在但启动失败时由 execute 返回 `backend_unavailable`，下次可重试。
- **在途命令保护**：扫描只在「无进行中 execute」的 session 上回收；正在执行的
  session 顺延到下一轮。浏览器关闭等待在途命令与关闭中的 session（复用
  `shutdown()` 的等待语义，但不置 `#disposed`）。
- **不自动处理 JS 对话框**：空闲回收关闭 session 时弹窗随 context 一起销毁，
  不需要额外处理（`context.close()` 会带走挂起 dialog）。
- 关闭动作幂等：重复触发同一 session 的回收不重复关闭；`shutdown()` 后扫描器停止。

## 所有者与事件顺序

全部状态由 `HeadlessBrowserRuntime` 独占（沿用现状），不新增跨模块状态：

```text
execute(scope)      → sessionFor() 创建/复用 → 记 lastUsedAt（执行前置）
空闲扫描（每 60s）   → session 空闲 >10min 且无在途命令 → trackClose + Map 删除
                    → 最后一个 session 关闭完成 → 记 browserIdleSince
                    → browserIdleSince >5min → 关闭浏览器进程（等在途命令）
下一次 execute       → ensureBrowser() 重启进程（generation +1）→ 新 session
```

- 回收只影响**空闲**资源；正在使用的 tab/页面不受影响（有在途命令即顺延）。
- 会话复用语义不变：10 分钟内的连续命令仍复用同一 Context（cookie/tab 保留）。
- 定时器随 runtime 生命周期：`shutdown()` 清定时器，不留悬挂句柄。

## 边界与不变量

- 不改协议、不改闭源 Agent、不碰 CLI adapter。
- `list()` 返回的 generation 仍是当前值；进程未启动时返回 generation 1，
  首次 execute 启动后、空闲关闭再重启后 generation 都不变，SDK 的 get(id) 不受影响。
  只有断连（进程意外退出）才 +1，SDK 的 stale 检测路径不变。
- 回收关闭失败（如浏览器已死）不抛出：`trackClose` 已 `.catch(() => {})`。
- 时间参数集中在 runtime 模块顶部常量，带测试覆盖的构造覆盖点（注入时钟）。

## 验收场景

1. `list()` 不启动浏览器进程（无 "managed browser started" 日志、无子进程）；
   可执行文件缺失或 runtime 已 shutdown 时返回空。
2. `execute` 正常启动并复用 session；10 分钟内第二次 execute 不重建 Context。
3. 空闲超过阈值的 session 被关闭；对应 Context 的 tab 全部销毁。
4. 全部 session 回收后再过 5 分钟，浏览器进程退出。
5. 浏览器进程被回收后，下一次 `execute` 自动重启并可正常执行命令。
6. 在途命令的 session 不被回收；扫描器在 shutdown 后停止。
7. 既有全部单测与双引擎集成测试无回归。

验证：新增 `headlessBrowserLifecycle.test.ts` 用例（fake playwright + 注入时钟）；
真实浏览器验证回收后重启路径；`pnpm typecheck` / `lint` / `architecture` / `fmt`。
