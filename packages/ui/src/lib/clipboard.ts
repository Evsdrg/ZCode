// 剪贴板写入统一入口。
//
// 为什么需要统一入口：UI 里 25 个文件直接调用 `navigator.clipboard.writeText`，都靠存在性检查
// 静默失败。私有部署的 WebUI 以 HTTP 访问非 localhost 地址时不是浏览器安全上下文，
// `navigator.clipboard` 为 undefined，用户点「复制」没有任何反应。
//
// 门控：只有构建期显式声明为私有部署（`ZCODE_PRIVATE_DEPLOYMENT=1`）时，才允许在
// `navigator.clipboard` 缺失时回退 `execCommand("copy")`。线上 Web 与桌面构建不包含兜底分支
// ——见 docs/specs/selfhost-private-deployment-clipboard-fallback.md。
import { ZCODE_PRIVATE_DEPLOYMENT } from "@zcode/shared";
import { writeTextViaExecCommand } from "./clipboardExecCommandFallback.js";

/** 剪贴板写入失败且无可用降级时抛出。 */
export class ClipboardUnavailableError extends Error {
  constructor() {
    super("navigator.clipboard is unavailable and no fallback is enabled");
    this.name = "ClipboardUnavailableError";
  }
}

/**
 * 写入纯文本到系统剪贴板。成功 resolve，失败 reject。
 *
 * 主路径用 `navigator.clipboard.writeText`；仅在私有部署门控开启且它不可用时走
 * `execCommand` 兜底。兜底返回 false 视为失败，不能当作成功——否则 UI 会展示「已复制」
 * 而实际没写进去。
 */
export async function writeClipboardText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  if (ZCODE_PRIVATE_DEPLOYMENT) {
    // 门控为常量 false 时此分支是死代码，兜底模块随之被摇树移除。
    if (writeTextViaExecCommand(text)) return;
    throw new ClipboardUnavailableError();
  }
  throw new ClipboardUnavailableError();
}
