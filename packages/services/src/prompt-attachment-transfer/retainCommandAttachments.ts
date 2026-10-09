import { commandPayloadSchemas, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { PromptAttachmentRetentionPort } from "./promptAttachmentTransfer.js";

export async function retainCommandAttachments(
  retention: PromptAttachmentRetentionPort,
  workspace: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
  envelope: CommandEnvelope,
): Promise<void> {
  const attachments =
    envelope.type === "sendText"
      ? commandPayloadSchemas.sendText.parse(envelope.payload).attachments
      : envelope.type === "editUserQuery"
        ? commandPayloadSchemas.editUserQuery.parse(envelope.payload).attachments
        : envelope.type === "createSession"
          ? commandPayloadSchemas.createSession.parse(envelope.payload).firstInput?.attachments
          : undefined;
  if (!attachments?.length) return;
  // 发送前持久保留，覆盖CLI已接受但ACK/adopt尚未返回的窗口，不能靠TTL猜测引用是否已使用。
  await retention.retainForSend({
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    sessionId: envelope.sessionId ?? "",
    attachments,
  });
}
