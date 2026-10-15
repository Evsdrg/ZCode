# 私有部署下的剪贴板写入降级

状态：已实施
适用：`packages/ui` 浏览器侧代码。桌面 Electron renderer 与线上 HTTPS Web 行为不变。

## 背景与问题

与附件上传同源：自部署 WebUI 改为浏览器直连 HTTP 地址后不是安全上下文，`navigator.clipboard`
为 `undefined`。UI 中 25 个文件、共 38 处调用 `navigator.clipboard.writeText`，全部靠存在性检查
静默失败——用户点「复制」没有任何反应，也没有报错。

浏览器实测（`http://<内网 IP>:<端口>`，`isSecureContext: false`）：

- `navigator.clipboard` → `undefined`；
- `document.execCommand("copy")` → 在**页面已被用户交互过**时返回 `true`，且内容可被真实粘贴
  读回（实测写入 `VERIFY-CLIP-9X7` 后 Ctrl+V 得到同值）；
- 全新页面、无任何交互时 `execCommand("copy")` 返回 `false`（`navigator.userActivation` 全 false）。

即 `execCommand` 路径依赖**粘性激活**（sticky activation），而非必须在事件处理器内同步调用；
实测在 `await` 之后调用仍成功。UI 中所有复制入口都由用户点击触发，天然满足该前提。

## 产品规则

- **门控复用私有部署编译常量**：只有构建期声明为私有部署（`ZCODE_PRIVATE_DEPLOYMENT=1`）时，
  才允许在 `navigator.clipboard` 缺失时回退到 `execCommand("copy")`。线上 Web 与桌面构建不包含
  该分支。
- 有 `navigator.clipboard` 时始终优先用它；`execCommand` 只是兜底。
- 门控关闭且 `navigator.clipboard` 缺失时，保持现状语义：调用方原有的存在性检查/失败处理不变，
  不抛新异常。
- 写入覆盖**纯文本**（`writeText`）；调用方 25 个文件改为调用统一入口。

## 读取（`readText`）：无法降级，但可用原生路径

**读取没有 `execCommand` 等价降级**——浏览器刻意禁止脚本用 `execCommand("paste")` 读系统剪贴板，
无法绕过。但 `navigator.clipboard.readText` 不可用**不等于粘贴不可用**：`paste` 事件上的
`clipboardData` 是同步 API，非安全上下文下**照常可用**。

实测（`http://<内网 IP>:<端口>`）：`isSecureContext=false`、`typeof navigator.clipboard === "undefined"`，
而构造的 `ClipboardEvent` 上 `clipboardData.getData("text/plain")` 能正常读到内容。

终端粘贴（`packages/ui/src/terminal/TerminalSession.tsx`）**曾因此完全失效**，根因是它自己
把可用的路径堵死了：

```text
Ctrl+V keydown → preventDefault() + stopPropagation()   ← 杀掉浏览器原生 paste
              → navigator.clipboard.readText()          ← undefined，抛 TypeError
```

两个 Ctrl+V handler 之所以 `preventDefault`，是为了避免「手动 paste 一次 + 原生 paste 一次」
重复写入；但该设计以 `navigator.clipboard` 可用为前提，在私有部署下前提不成立，结果是两头落空。

修复（`packages/ui/src/lib/clipboardRead.ts`）：

- `canReadClipboard()` / `readClipboardText()`：存在性检查 + 失败返回 `null`，不用 `undefined.readText()` 抛错。
- 两个 Ctrl+V handler 改为**仅当 `canReadClipboard()` 为真时才 `preventDefault` 并手动 paste**；
  否则直接放行，由 xterm 自己的原生 `paste` 监听（读 `clipboardData`）处理。
- 上下文菜单的「粘贴」明确降级为不可用（记 debug 日志）——它没有键盘事件可放行，
  而浏览器不提供任何脚本读取途径。键盘 Ctrl+V 仍可用。

验收：在真实浏览器终端里派发带 `clipboardData` 的 `paste` 事件 → 文本进入命令行，
且 `defaultPrevented=false`（证明未被拦截）。

**读取路径上的平台边界**：`execCommand("copy")` 受 sticky activation 约束（页面须被交互过），
而原生 paste 路径由用户的 Ctrl+V 手势天然满足该约束。

## 所有者与接口

- **统一入口**：`packages/ui/src/lib/clipboard.ts` 导出
  `writeClipboardText(text: string): Promise<void>`（成功 resolve，失败 reject）。
  内部按门控选择 `navigator.clipboard.writeText` 或 `execCommand("copy")` 兜底。
- 调用方（25 个文件）改为调用该入口，删除各自的 `navigator.clipboard?.writeText` 直连与
  重复的存在性检查；保留各自的成功/失败副作用（toast、日志、`setCopied` 状态等）。
- 兜底实现放在独立模块 `packages/ui/src/lib/clipboardExecCommandFallback.ts`，
  由门控分支引用；门控为 false 时可被摇树移除。

## 顺序与失败语义

```text
用户点击「复制」→ writeClipboardText(text)
                    ├─ navigator.clipboard 存在 → await writeText（现状，权限失败会 reject）
                    └─ 缺失且门控开启 → execCommand 兜底
                          ├─ 创建离屏 textarea，写入并 select
                          ├─ execCommand("copy") 返回 true → resolve
                          └─ 返回 false / 抛错 → 清理节点后 reject
                    └─ 缺失且门控关闭 → reject（调用方按原有方式处理）
```

- 兜底必须清理临时 DOM 节点（含异常路径），不留残留。
- 兜底返回 `false` 视为失败并 reject，不能把 `false` 当成功——否则 UI 会展示"已复制"却
  实际没写进去。
- 兜底只写纯文本，不改选区、不聚焦原元素之外的可见控件；插入的 textarea 应离屏且不可见，
  调用后恢复焦点（若之前有焦点元素）。

## 安全与边界

- 门控是编译期开关，运行时不可绕过；线上/公网构建不含 `execCommand` 分支。
- `execCommand` 已废弃但仍是当前浏览器在非安全上下文下唯一可用的写入路径；仅作兜底，
  不改变主路径。
- 不改 Electron 侧剪贴板实现，不新增对外接口。

## 验收

1. 私有部署构建在 `http://<mesh-ip>:3030` 下，点击各「复制」入口后内容确实进入剪贴板
   （用真实粘贴读回校验），且无残留 DOM 节点。
2. `navigator.clipboard` 可用（如 localhost）时仍走 WebCrypto 同级的主路径。
3. 门控关闭的构建（线上 Web、桌面）行为不变：`navigator.clipboard` 缺失时调用方保持原有失败处理。
4. 兜底在 `execCommand` 返回 false 时 reject；调用方不展示成功态。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check`、`pnpm fmt:check` 通过；ui 测试通过。

验证：ui 侧单测覆盖主路径/兜底/失败三分支；浏览器在私有部署构建下实测某复制入口并用
粘贴读回。不重启 `zcode-web-local` 宿主；隔离实例副本须去除 `credentials.json`。
