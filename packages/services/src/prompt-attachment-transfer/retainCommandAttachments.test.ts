import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { retainCommandAttachments } from "./retainCommandAttachments.js";

const attachment = {
  ref: "/owned/file.binpkg",
  fileName: "file.binpkg",
  mime: "application/octet-stream",
  bytes: 4,
};
const target = { workspacePath: "/workspace" };
function command(type: "sendText" | "editUserQuery" | "createSession", payload: unknown) {
  return { type, sessionId: "session-1", payload } as CommandEnvelope;
}

describe("retainCommandAttachments", () => {
  it("在转发前保留sendText和editUserQuery的附件", async () => {
    const retainForSend = vi.fn(async () => {});
    for (const type of ["sendText", "editUserQuery"] as const) {
      const payload =
        type === "sendText"
          ? { text: "inspect", attachments: [attachment] }
          : {
              target: { rowId: 1, entityId: "row-1" },
              newText: "inspect",
              attachments: [attachment],
            };
      await retainCommandAttachments({ retainForSend }, target, command(type, payload));
    }
    expect(retainForSend).toHaveBeenCalledTimes(2);
    expect(retainForSend).toHaveBeenCalledWith({
      ...target,
      sessionId: "session-1",
      attachments: [attachment],
    });
  });

  it("保留失败不能被吞掉，否则发送后可能误清文件", async () => {
    const retainForSend = vi.fn(async () => {
      throw new Error("scope mismatch");
    });
    await expect(
      retainCommandAttachments(
        { retainForSend },
        target,
        command("sendText", { text: "inspect", attachments: [attachment] }),
      ),
    ).rejects.toThrow("scope mismatch");
  });

  it("新会话首发附件和远端身份透传，其他命令不接管", async () => {
    const retainForSend = vi.fn(async () => {});
    await retainCommandAttachments(
      { retainForSend },
      { ...target, workspaceIdentity: "remote:scope", remoteSessionId: "remote-session" },
      command("createSession", {
        workspaceId: "workspace",
        firstInput: { text: "inspect", attachments: [attachment] },
      }),
    );
    expect(retainForSend).toHaveBeenCalledWith({
      ...target,
      workspaceIdentity: "remote:scope",
      remoteSessionId: "remote-session",
      sessionId: "session-1",
      attachments: [attachment],
    });
  });

  it("发送上下文中的envelope/clientMode不能泄入严格的retention参数", async () => {
    const retainForSend = vi.fn(async () => {});
    const context = { ...target, clientMode: "web-remote-replayable", envelope: {} };
    await retainCommandAttachments(
      { retainForSend },
      context,
      command("sendText", { text: "inspect", attachments: [attachment] }),
    );
    expect(retainForSend).toHaveBeenCalledWith({
      ...target,
      sessionId: "session-1",
      attachments: [attachment],
    });
  });

  it("无附件不写入持久所有权", async () => {
    const retainForSend = vi.fn(async () => {});
    await retainCommandAttachments(
      { retainForSend },
      target,
      command("sendText", { text: "hello" }),
    );
    await retainCommandAttachments(
      { retainForSend },
      target,
      command("createSession", { workspaceId: "workspace" }),
    );
    expect(retainForSend).not.toHaveBeenCalled();
  });
});
