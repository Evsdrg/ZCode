import { describe, expect, it } from "vitest";

import { hostNativeModule } from "./module.js";
import { exampleOpenPdfWithSystemApp } from "./contract.example.js";
import { IHostNativeService, type IHostNativeService as IHostNativeServiceType } from "./index.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("host-native contract", () => {
  it("declares its module manifest", () => {
    expect(hostNativeModule.id).toBe("host-native");
    expect(hostNativeModule.requires).toContain("shared");
  });

  it("channel name 与 ServiceChannels.HostNative 一致", () => {
    expect(IHostNativeService.channelName).toBe("host-native");
  });

  it("标准示例：没有可用 PDF 查看器时显式失败", async () => {
    const service: IHostNativeServiceType = {
      openInFileManager: async () => ({ success: true }),
      openInEditor: async () => ({ success: true }),
      getInstalledEditors: async () => [],
      createTempTextAttachment: async () => {
        throw new Error("not used");
      },
      materializeWorkflowArtifactFile: async () => ({ localPath: "" }),
      listSSHConfigAliases: async () => [],
      isDockerAvailable: async () => false,
      listDockerContainers: async () => [],
    };

    await expect(exampleOpenPdfWithSystemApp(service, "/tmp/a.pdf")).resolves.toEqual({
      opened: false,
      error: "no_installed_pdf_viewer",
    });
  });

  it("标准示例：优先选 okular，打开失败时把错误向上传递", async () => {
    const service: IHostNativeServiceType = {
      openInFileManager: async () => ({ success: true }),
      openInEditor: async () => ({ success: false, error: "application is not installed" }),
      getInstalledEditors: async () => [
        { id: "evince", name: "Evince", iconDataUrl: "" },
        { id: "okular", name: "Okular", iconDataUrl: "" },
      ],
      createTempTextAttachment: async () => {
        throw new Error("not used");
      },
      materializeWorkflowArtifactFile: async () => ({ localPath: "" }),
      listSSHConfigAliases: async () => [],
      isDockerAvailable: async () => false,
      listDockerContainers: async () => [],
    };

    await expect(exampleOpenPdfWithSystemApp(service, "/tmp/a.pdf")).resolves.toEqual({
      opened: false,
      error: "application is not installed",
    });
  });
});
