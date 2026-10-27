/**
 * host-native 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { IHostNativeService } from "./contract.js";

/**
 * 最常见的一次完整调用：用户在 WebUI 里点「用本机应用打开这个 PDF」。
 *
 * 关键点：
 * - `getInstalledEditors(filePath)` 必须带文件路径：Linux 上不传路径恒为空（与 Electron 一致）。
 * - `openInEditor` 只在扩展名匹配、目标确实是文件、应用已安装时才成功；
 *   任何一步不满足都返回 `{success:false, error}`，**不会**静默成功。
 */
export async function exampleOpenPdfWithSystemApp(
  service: IHostNativeService,
  pdfPath: string,
): Promise<{ opened: boolean; editorId?: string; error?: string }> {
  const editors = await service.getInstalledEditors(pdfPath);
  const preferred = editors.find((editor) => editor.id === "okular") ?? editors[0];
  if (!preferred) {
    return { opened: false, error: "no_installed_pdf_viewer" };
  }

  const result = await service.openInEditor(preferred.id, pdfPath);
  return result.success
    ? { opened: true, editorId: preferred.id }
    : { opened: false, error: result.error };
}
