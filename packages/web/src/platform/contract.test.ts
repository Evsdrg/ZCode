// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createWebPlatform } from "#src/platform/index.js";
import { saveBrowserFile } from "#src/platform/saveBrowserFile.js";

describe("web platform boundary", () => {
  it("未注入 host-native 时本机文件能力缺席而非提供失败桩", () => {
    const platform = createWebPlatform();
    expect(platform.canOpenLocalFiles).toBe(false);
    expect(platform.canSelectFilePath).toBe(false);
    expect(platform.canConfigureManagedBrowserCertificates).toBeUndefined();
    // 可选方法不实现就不要写桩：UI 的存在性判定必须拿到 undefined。
    expect(platform.importChromeBrowserData).toBeUndefined();
    expect(platform.openExternalFile).toBeUndefined();
  });

  it("注入 hostNativeService 后按能力声明，且注入项之间互不牵连", () => {
    const hostNative = {
      openInFileManager: async () => ({ success: true }),
      openInEditor: async () => ({ success: true }),
      getInstalledEditors: async () => [],
      createTempTextAttachment: async () => ({
        filename: "a.txt",
        localPath: "/tmp/a.txt",
        mimeType: "text/plain" as const,
        sizeBytes: 1,
      }),
      materializeWorkflowArtifactFile: async () => ({ localPath: "/tmp/a" }),
      listSSHConfigAliases: async () => [],
      isDockerAvailable: async () => false,
      listDockerContainers: async () => [],
    };
    const platform = createWebPlatform({ hostNativeService: hostNative });
    expect(platform.canOpenLocalFiles).toBe(true);
    // 目录选择器仍不声明：那是 server 目录浏览器负责的能力。
    expect(platform.canSelectFilePath).toBe(false);
    // 托管浏览器维护服务未注入，证书能力不声明。
    expect(platform.canConfigureManagedBrowserCertificates).toBeUndefined();
  });

  it("托管浏览器维护服务存在时才声明证书配置能力", () => {
    const platform = createWebPlatform({
      managedBrowserMaintenance: { clearAllData: async () => ({ success: true }) },
    });
    expect(platform.canConfigureManagedBrowserCertificates).toBe(true);
  });

  it("saveFile 在超过 50 MiB 时 fail-closed 返回 file_too_large", async () => {
    const tooLarge = new ArrayBuffer(50 * 1024 * 1024 + 1);
    await expect(
      saveBrowserFile({ data: tooLarge, suggestedName: "big.bin" }),
    ).resolves.toEqual({ success: false, error: "file_too_large" });
  });

  it("saveFile 拒绝非 HTTP(S)/data/blob 来源", async () => {
    await expect(
      saveBrowserFile({ sourceUrl: "file:///etc/passwd", suggestedName: "x" }),
    ).resolves.toEqual({ success: false, error: "save_failed" });
  });
});
