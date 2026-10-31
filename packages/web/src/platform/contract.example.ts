import { createWebPlatform } from "#src/platform/index.js";

export async function saveBrowserFileExample(data: ArrayBuffer) {
  // 此处 success 表示下载已发起，浏览器不提供实际落盘结果。
  return createWebPlatform().saveFile!({ data, suggestedName: "report.pdf" });
}

export function webPlatformWithoutHostNativeIsLimited() {
  const platform = createWebPlatform();
  // 未注入 hostNativeService（手机远控等形态）时，本机文件能力必须缺席而不是提供失败桩。
  return {
    canOpenLocalFiles: platform.canOpenLocalFiles,
    canSelectFilePath: platform.canSelectFilePath,
    canConfigureManagedBrowserCertificates: platform.canConfigureManagedBrowserCertificates,
  };
}
