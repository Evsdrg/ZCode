import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import { useComposerAttachments } from "./useComposerAttachments.js";
import type { AttachmentPutFn } from "./attachmentUpload.js";

vi.stubGlobal("crypto", webcrypto);

function Harness({
  service,
  attachmentPut,
}: {
  service: IPromptAttachmentTransferService;
  attachmentPut: AttachmentPutFn;
}) {
  return (
    <ServiceProvider services={{ promptAttachmentTransferService: service } as never}>
      <PlatformProvider
        platform={{ canSelectFilePath: false, getPathForFile: () => null } as never}
      >
        <ZCodeIntlProvider initialLocale="zh-CN">
          <Composer attachmentPut={attachmentPut} />
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}

function Composer({ attachmentPut }: { attachmentPut: AttachmentPutFn }) {
  const api = useComposerAttachments({
    workspacePath: "/ws",
    scopeId: "upload-test",
    attachmentSessionId: "session-1",
    attachmentPut,
    listenAddToChatEvents: false,
  });
  return (
    <>
      <input
        aria-label="附件文件"
        type="file"
        multiple
        ref={api.attachmentInputRef}
        onChange={api.handleAttachmentInputChange}
      />
      {api.attachments.map((item) => (
        <div key={item.id}>
          <span>
            {item.filename}: {item.uploadStatus}
            {item.uploadError ? `: ${item.uploadError}` : ""}
          </span>
          <button onClick={() => api.removeAttachment(item.id)}>移除 {item.filename}</button>
          <button onClick={() => api.retryAttachment(item.id)}>重试 {item.filename}</button>
        </div>
      ))}
      <button
        onClick={() => {
          void api
            .adoptSentAttachments(api.attachments.map((item) => item.id))
            .then(() => api.clearAttachments());
        }}
      >
        发送确认
      </button>
    </>
  );
}

function port() {
  const service: IPromptAttachmentTransferService = {
    getUploadCapabilities: vi.fn(async () => ({
      arbitraryFiles: true,
      maxBytes: 20 * 1024 * 1024,
    })),
    beginUpload: vi.fn(async () => ({ state: "staging" as const, nextChunkIndex: 0 })),
    uploadChunk: vi.fn(async (params) => ({ nextChunkIndex: params.chunkIndex + 1 })),
    commitUpload: vi.fn(async (operationId) => ({
      operationId,
      ref: "/owned/probe.binpkg",
      bytes: 4,
      staged: true,
    })),
    stage: vi.fn(),
    adopt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    onDynamicProgress: () => () => ({ dispose() {} }),
  };
  return service;
}
function file(name = "probe.binpkg", type = "") {
  const f = new File([new Uint8Array([0, 255, 42, 80])], name, { type });
  Object.defineProperty(f, "arrayBuffer", {
    value: async () => new Uint8Array([0, 255, 42, 80]).buffer,
  });
  return f;
}

beforeEach(() => {
  useComposerAttachmentUploadStore.setState({ scopes: {} });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => act(() => useComposerAttachmentUploadStore.setState({ scopes: {} })));

describe("Composer普通文件上传交互", () => {
  it("文件选择到ready并发送确认后adopt，不走CLI文本化上传", async () => {
    const service = port();
    const attachmentPut = vi.fn();
    render(<Harness service={service} attachmentPut={attachmentPut} />);
    fireEvent.change(screen.getByLabelText("附件文件"), { target: { files: [file()] } });
    await waitFor(() => expect(screen.getByText("probe.binpkg: ready")).toBeTruthy());
    expect(attachmentPut).not.toHaveBeenCalled();
    const item = Object.values(useComposerAttachmentUploadStore.getState().scopes).flat()[0]!;
    expect(item.attachmentRef?.ref).toBe("/owned/probe.binpkg");
    expect(item.localPath).toBeUndefined();
    expect(item.staged).toBe(true);
    fireEvent.click(screen.getByText("发送确认"));
    await waitFor(() => expect(service.adopt).toHaveBeenCalledWith(item.operationId));
    expect(service.cleanup).not.toHaveBeenCalled();
    expect(Object.values(useComposerAttachmentUploadStore.getState().scopes).flat()).toHaveLength(
      0,
    );
  });

  it("移除ready附件只取消自己的operation", async () => {
    const service = port();
    render(<Harness service={service} attachmentPut={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("附件文件"), { target: { files: [file()] } });
    await waitFor(() => expect(screen.getByText("probe.binpkg: ready")).toBeTruthy());
    const item = Object.values(useComposerAttachmentUploadStore.getState().scopes).flat()[0]!;
    fireEvent.click(screen.getByText("移除 probe.binpkg"));
    expect(service.cancel).toHaveBeenCalledWith(item.operationId);
  });

  it("媒体继续走既有CLI上传且不调用Host普通文件事务", async () => {
    const service = port();
    const attachmentPut = vi.fn(async () => ({ ref: "zcode-artifact://image-fixture" }));
    render(<Harness service={service} attachmentPut={attachmentPut} />);
    fireEvent.change(screen.getByLabelText("附件文件"), {
      target: { files: [file("image.png", "image/png")] },
    });
    await waitFor(() => expect(screen.getByText("image.png: ready")).toBeTruthy());
    expect(service.beginUpload).not.toHaveBeenCalled();
    expect(attachmentPut).toHaveBeenCalledTimes(1);
  });

  it("能力关闭的旧Host仍能按已有文本链路发送", async () => {
    const service = port();
    service.getUploadCapabilities = vi.fn(async () => ({
      arbitraryFiles: false,
      maxBytes: 20 * 1024 * 1024,
    }));
    const attachmentPut = vi.fn(async () => ({ ref: "zcode-artifact://text-fixture" }));
    render(<Harness service={service} attachmentPut={attachmentPut} />);
    fireEvent.change(screen.getByLabelText("附件文件"), {
      target: { files: [file("sample.txt", "text/plain")] },
    });
    await waitFor(() => expect(screen.getByText("sample.txt: ready")).toBeTruthy());
    expect(service.beginUpload).not.toHaveBeenCalled();
    expect(attachmentPut).toHaveBeenCalledTimes(1);
  });

  it("超过20MiB显示本地化错误且不begin；重试使用新operation", async () => {
    const service = port();
    render(<Harness service={service} attachmentPut={vi.fn()} />);
    const oversized = file();
    Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("附件文件"), { target: { files: [oversized] } });
    await waitFor(() =>
      expect(screen.getByText(/probe.binpkg: failed: 文件附件不能超过 20 MiB/)).toBeTruthy(),
    );
    expect(service.beginUpload).not.toHaveBeenCalled();
    const old = Object.values(useComposerAttachmentUploadStore.getState().scopes).flat()[0]!
      .operationId;
    await act(async () => fireEvent.click(screen.getByText("重试 probe.binpkg")));
    await waitFor(() =>
      expect(screen.getByText(/probe.binpkg: failed: 文件附件不能超过 20 MiB/)).toBeTruthy(),
    );
    const next = Object.values(useComposerAttachmentUploadStore.getState().scopes).flat()[0]!
      .operationId;
    expect(next).not.toBe(old);
    expect(service.cleanup).toHaveBeenCalledWith(old);
  });
});
