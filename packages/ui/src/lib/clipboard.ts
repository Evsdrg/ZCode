// 剪贴板写入统一入口：集中「clipboard 是否可用」的判断与失败语义。
// 各调用点不再自行做存在性检查，避免静默失败被分散在各处。
/** 剪贴板写入失败时抛出。 */
export class ClipboardUnavailableError extends Error {
  constructor() {
    super("navigator.clipboard is unavailable");
    this.name = "ClipboardUnavailableError";
  }
}

/**
 * 写入纯文本到系统剪贴板。成功 resolve，失败 reject。
 *
 * 主路径用 `navigator.clipboard.writeText`；不存在时统一抛
 * `ClipboardUnavailableError`，由调用方按原有失败语义处理。
 */
export async function writeClipboardText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  throw new ClipboardUnavailableError();
}
