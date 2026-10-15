// `document.execCommand("copy")` 兜底实现。
//
// 为什么需要：私有部署的 WebUI 以 HTTP 访问非 localhost 地址时不是浏览器安全上下文，
// `navigator.clipboard` 为 undefined。`execCommand("copy")` 已废弃，但仍是该环境下唯一可用的
// 文本写入路径。
//
// 前提（实测）：依赖「粘性激活」——页面被用户交互过即可，不必在事件处理器内同步调用；
// UI 中所有复制入口都由用户点击触发，天然满足。全新未交互页面会返回 false。
//
// 单独成文件：只被 clipboard.ts 的门控分支引用，门控为 false 时可被摇树移除。
export function writeTextViaExecCommand(text: string): boolean {
  // 记录当前焦点，兜底结束后恢复，避免插入 textarea 抢走用户正在输入的控件焦点。
  const activeElement = document.activeElement as HTMLElement | null;
  const holder = document.createElement("textarea");
  holder.value = text;
  // 离屏且不可交互，避免可见跳动与滚动位置变化。
  holder.setAttribute("readonly", "");
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.left = "-9999px";
  holder.style.opacity = "0";
  document.body.appendChild(holder);
  try {
    holder.select();
    holder.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    // 异常路径同样要清理，不能在 DOM 里留残留节点。
    holder.remove();
    activeElement?.focus?.();
  }
}
