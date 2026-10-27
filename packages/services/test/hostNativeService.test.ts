import { describe, expect, it } from "vitest";
import { createHostNativeService } from "../src/host-native/hostNativeService.js";

describe("host-native service 装配", () => {
  const ok = { success: true as const };

  function build(overrides: Parameters<typeof createHostNativeService>[0] = {}) {
    return createHostNativeService({
      openInFileManagerImpl: async () => ok,
      openInEditorImpl: async () => ok,
      getInstalledEditorsImpl: async () => [],
      createTempTextAttachmentImpl: async () => ({
        filename: "x.txt",
        localPath: "/tmp/x.txt",
        mimeType: "text/plain" as const,
        sizeBytes: 1,
      }),
      materializeWorkflowArtifactFileImpl: async () => ({ localPath: "/tmp/a.txt" }),
      listSSHConfigAliasesImpl: async () => [{ alias: "demo" }],
      isDockerAvailableImpl: async () => true,
      listDockerContainersImpl: async () => [
        { id: "x", image: "i", name: "n", state: "running", status: "Up" },
      ],
      ...overrides,
    });
  }

  it("转发 openInFileManager / openInEditor", async () => {
    const service = build();
    expect(await service.openInFileManager("/tmp")).toEqual(ok);
    expect(await service.openInEditor("evince", "/tmp/a.pdf")).toEqual(ok);
  });

  it("openInEditor 拒绝远端目标：server 就是宿主，不能把远端路径当本机路径打开", async () => {
    const service = build();
    const result = await service.openInEditor("evince", "/tmp/a.pdf", {
      remoteTarget: { kind: "ssh", host: "example", username: "root" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("remote target");
  });

  it("转发 docker / ssh 探测", async () => {
    const service = build();
    expect(await service.isDockerAvailable()).toBe(true);
    expect(await service.listSSHConfigAliases()).toEqual([{ alias: "demo" }]);
    expect(await service.listDockerContainers()).toHaveLength(1);
  });

  it("临时附件与产物落地直接透传", async () => {
    const service = build();
    expect((await service.createTempTextAttachment({ text: "hi" })).localPath).toBe("/tmp/x.txt");
    expect(
      (
        await service.materializeWorkflowArtifactFile({
          runId: "r",
          artifactId: "a",
          version: 1,
          fileName: "f.txt",
          bytes: new Uint8Array(),
        })
      ).localPath,
    ).toBe("/tmp/a.txt");
  });
});
