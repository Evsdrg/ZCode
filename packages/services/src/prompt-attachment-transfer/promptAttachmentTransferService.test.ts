import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalPromptAttachmentTransferService } from "./promptAttachmentTransferService.js";
import { retainCommandAttachments } from "./retainCommandAttachments.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-upload-service-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Host通用附件服务接线", () => {
  it("默认关闭且桌面原生路径不创建存储、不被cleanup删除", async () => {
    const service = createLocalPromptAttachmentTransferService();
    expect((await service.getUploadCapabilities!()).arbitraryFiles).toBe(false);
    await expect(service.beginUpload!({} as never)).rejects.toThrow("uploadUnsupported");
    expect(
      await service.stage({
        operationId: "native",
        sessionId: "s",
        workspacePath: "/ws",
        localPath: "/source",
        fileName: "source",
        mime: "text/plain",
        sizeBytes: 8,
      }),
    ).toMatchObject({ ref: "/source", staged: false });
    await service.cleanup("native");
    await service.disposeAllAndWait();
  });

  it("createSession没有sessionId的既有媒体/桌面路径附件不被新增保留门禁拒绝", async () => {
    const service = createLocalPromptAttachmentTransferService({ uploadRoot: root });
    for (const ref of ["zcode-artifact://image", "/native/photo.png"]) {
      await expect(
        retainCommandAttachments(service, { workspacePath: "/ws" }, {
          type: "createSession",
          sessionId: null,
          payload: {
            workspaceId: "workspace",
            firstInput: {
              text: "inspect",
              attachments: [{ ref, fileName: "photo.png", mime: "image/png", bytes: 4 }],
            },
          },
        } as never),
      ).resolves.toBeUndefined();
    }
    await expect(
      retainCommandAttachments(service, { workspacePath: "/ws" }, {
        type: "createSession",
        sessionId: null,
        payload: {
          workspaceId: "workspace",
          firstInput: {
            text: "inspect",
            attachments: [
              {
                ref: join(root, "unowned"),
                fileName: "file",
                mime: "application/octet-stream",
                bytes: 4,
              },
            ],
          },
        },
      } as never),
    ).rejects.toThrow();
    await service.disposeAllAndWait();
  });

  it("浏览器upload经service落盘，发送前retain后重建保留路径和字节", async () => {
    const bytes = Buffer.from([0, 255, 80, 75]);
    let service = createLocalPromptAttachmentTransferService({ uploadRoot: root });
    expect((await service.getUploadCapabilities!()).arbitraryFiles).toBe(true);
    const base = {
      operationId: "op-service",
      sessionId: "session",
      workspacePath: "/ws",
      fileName: "fixture.binpkg",
      mime: "application/octet-stream",
      totalBytes: bytes.length,
      totalChunks: 1,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    await service.beginUpload!(base);
    await service.uploadChunk!({
      operationId: base.operationId,
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    });
    const ref = await service.commitUpload!(base.operationId);
    const attachment = { ref: ref.ref, bytes: ref.bytes, fileName: base.fileName, mime: base.mime };
    await retainCommandAttachments(service, { workspacePath: "/ws" }, {
      type: "sendText",
      sessionId: "session",
      payload: { text: "inspect", attachments: [attachment] },
    } as never);
    await service.disposeAllAndWait();
    service = createLocalPromptAttachmentTransferService({ uploadRoot: root });
    // ACK尚未回UI也已持久保留：cleanup不能破坏该文件，随后adopt仍幂等。
    await service.cleanup(base.operationId).catch(() => {});
    await service.adopt(base.operationId);
    expect(await readFile(ref.ref)).toEqual(bytes);
    const replay = await service.beginUpload!(base);
    expect(replay).toMatchObject({ state: "committed", ref: ref.ref });
    await service.disposeAllAndWait();
  });
});
