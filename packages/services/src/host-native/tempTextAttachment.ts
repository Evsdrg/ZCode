import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
} from "@zcode/shared";
import { getZCodeDataRootDir } from "../paths.js";

const TEMP_TEXT_ATTACHMENT_DIR = "paste-attachments";
const MIME_TYPE = "text/plain" as const;

/**
 * 把粘贴的长文本落成一份宿主本机的临时 .txt，返回绝对路径供 composer 作为附件引用。
 *
 * 自部署形态原先由 `createWebPlatform` 直接 reject（"Temporary text attachments require a
 * desktop host"），导致 WebUI 里粘贴 ≥15 KiB 文本时必然报「读取失败」。该实现与桌面端
 * `packages/desktop/src/main/tempTextAttachment.ts` 行为一致，且不含任何 Electron 依赖。
 */
export async function createTempTextAttachment(
  payload: CreateTempTextAttachmentRequest,
): Promise<CreateTempTextAttachmentResult> {
  if (typeof payload.text !== "string" || payload.text.length === 0) {
    throw new Error("Temporary text attachment content is empty");
  }

  const now = new Date();
  const dateDir = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-");
  const rootDir = join(getZCodeDataRootDir(), "tmp", TEMP_TEXT_ATTACHMENT_DIR, dateDir);
  await mkdir(rootDir, { recursive: true });

  const filename = buildTempTextAttachmentFilename(payload.filename);
  const localPath = join(rootDir, filename);
  const content = Buffer.from(payload.text, "utf8");
  // wx：同名同内容不同请求也各写一份，避免并发粘贴互相覆盖。
  await writeFile(localPath, content, { flag: "wx" });

  return {
    filename,
    localPath,
    mimeType: MIME_TYPE,
    sizeBytes: content.byteLength,
  };
}

function buildTempTextAttachmentFilename(filename: string | undefined): string {
  const rawBase = filename?.trim() || "pasted-text.txt";
  const normalized = rawBase.replaceAll("\0", "-").replace(/[\\/:]/gu, "-");
  const safeName = normalized.endsWith(".txt") ? normalized : `${normalized}.txt`;
  const suffix = randomUUID().slice(0, 8);
  const dotIndex = safeName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${safeName}-${suffix}.txt`;
  }
  return `${safeName.slice(0, dotIndex)}-${suffix}${safeName.slice(dotIndex)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
