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
    // 个性化指令由 server 侧的 settingService 真实实现，与 host-native 无关。
    expect(platform.canEditUserInstructions).toBe(true);
    // 可选方法不实现就不要写桩：UI 的存在性判定必须拿到 undefined。
    expect(platform.importChromeBrowserData).toBeUndefined();
    expect(platform.openExternalFile).toBeUndefined();
    // 日志导出与 host-native 无关，只由 server 的 logExport 能力决定；未声明时入口不渲染。
    expect(platform.canExportLogs).toBeUndefined();
  });

  it("注入 hostNativeService 后按能力声明，且注入项之间互不牵连", () => {
    const hostNative = {
      openInFileManager: async () => ({ success: true }),
      openExternalFile: async () => ({ success: true }),
      getFileApplications: async () => [],
      openFileWithApplication: async () => ({ success: true }),
      getApplicationIcon: async () => null,
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

  // 回归：日志导出的 server 路由（`/api/logs/export`）与 Web 平台实现都存在，但帮助菜单
  // 的入口曾整块包在 isDesktop 里，Web 用户永远看不到。现在由 canExportLogs 显式声明。
  it("server 声明 logExport 时才宣告 canExportLogs，并与其它能力互不牵连", () => {
    const withLogExport = createWebPlatform({ logExport: true });
    expect(withLogExport.canExportLogs).toBe(true);
    // 日志导出不需要 host-native，也不能反过来影响本机文件能力。
    expect(withLogExport.canOpenLocalFiles).toBe(false);
    expect(withLogExport.exportLogs).toBeTypeOf("function");

    const withoutLogExport = createWebPlatform();
    expect(withoutLogExport.canExportLogs).toBeUndefined();
  });

  it("个性化指令能力与托管浏览器、host-native 互不牵连", () => {
    // 三个能力分别对应不同的 server 侧实现，任何一个都不应连带影响其它。
    const platform = createWebPlatform({
      managedBrowserMaintenance: { clearAllData: async () => ({ success: true }) },
    });
    expect(platform.canConfigureManagedBrowserCertificates).toBe(true);
    expect(platform.canEditUserInstructions).toBe(true);
    expect(platform.canOpenLocalFiles).toBe(false);
  });

  it("getSystemLocale 按 navigator.language 归一到 zh-CN / en-US", async () => {
    // 接口注释：桌面端由 main 读系统语言，Web 端可回退到 navigator.language。
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language: "zh-TW" },
      });
      const platform = createWebPlatform();
      await expect(platform.getSystemLocale?.()).resolves.toBe("zh-CN");

      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language: "fr-FR" },
      });
      await expect(createWebPlatform().getSystemLocale?.()).resolves.toBe("en-US");
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("注入 hostNative 后文件应用四个方法存在；未注入时缺席（不是失败桩）", () => {
    const hostNative = {
      openInFileManager: async () => ({ success: true }),
      openExternalFile: async () => ({ success: true }),
      getFileApplications: async () => [],
      openFileWithApplication: async () => ({ success: true }),
      getApplicationIcon: async () => null,
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
    const withHost = createWebPlatform({ hostNativeService: hostNative });
    expect(withHost.openExternalFile).toBeTypeOf("function");
    expect(withHost.getFileApplications).toBeTypeOf("function");
    expect(withHost.openFileWithApplication).toBeTypeOf("function");
    expect(withHost.getApplicationIcon).toBeTypeOf("function");

    // 未注入时必须缺席：UI 用存在性判定能力，失败桩会把它误判为可用。
    const withoutHost = createWebPlatform();
    expect(withoutHost.openExternalFile).toBeUndefined();
    expect(withoutHost.getFileApplications).toBeUndefined();
    expect(withoutHost.openFileWithApplication).toBeUndefined();
    expect(withoutHost.getApplicationIcon).toBeUndefined();
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
