// 剪贴板读取统一入口。
//
// 与写入（clipboard.ts）对称：`navigator.clipboard.readText` 只在浏览器安全上下文可用，
// 私有部署的 WebUI 以 HTTP 访问非 localhost 地址时 `navigator.clipboard` 为 undefined。
//
// 与写入的关键区别：**读取没有 execCommand 等价降级**。浏览器不允许脚本用
// `execCommand("paste")` 读系统剪贴板（这是刻意的安全边界，无法绕过）。因此这里不做兜底，
// 只做两件事：
//   1. 用存在性检查代替直接调用，避免 `undefined.readText()` 抛 TypeError；
//   2. 返回 null 明确表达「读不到」，让调用方走自己的原生路径（如 DOM paste 事件的
//      `clipboardData`，那是同步 API，非安全上下文下可用）。
//
// 终端粘贴正是靠这条约定工作的：readClipboardText 返回 null 时，不再 preventDefault，
// 浏览器原生 paste 事件会带着 clipboardData 交给 xterm 处理。

/** 读取失败或环境不支持时返回 null；调用方据此回退到原生 paste 路径。 */
export async function readClipboardText(): Promise<string | null> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.readText) {
    return null;
  }
  try {
    return await clipboard.readText();
  } catch {
    // 权限被拒、非聚焦文档等都可能抛错；一律按「读不到」处理，由调用方回退。
    return null;
  }
}

/** 当前环境能否异步读取剪贴板（决定是否还要手动 paste）。 */
export function canReadClipboard(): boolean {
  return typeof globalThis.navigator?.clipboard?.readText === "function";
}
