import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
} from "@zcode/shared";
import { getZCodeDataRootDir } from "../paths.js";

const WORKFLOW_ARTIFACT_DIR = "workflow-artifacts";

/** 与 `artifact.file` 的字节上限同级（dynamic-workflow/src/facade/artifact-caps.ts）。 */
export const WORKFLOW_ARTIFACT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const MAX_SEGMENT_LENGTH = 120;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * dwf 产物「作为文件打开」的宿主副本。
 *
 * 与桌面端 `packages/desktop/src/main/workflowArtifactFile.ts` 行为一致，且不含 Electron 依赖。
 * 落点：`~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>`。
 *
 * **只在路径为空时写**：一版的字节永不变，所以已有的副本要么是同一份字节、要么是用户在外部
 * App 里的编辑——两者都该保留，再次打开还是同一个文件。写法是「临时文件 + link」：link 在目标
 * 已存在时以 EEXIST 失败且不覆盖，于是并发两次点击也只会落下一份完整的文件。
 */
export async function materializeWorkflowArtifactFile(
  payload: MaterializeWorkflowArtifactFileRequest,
): Promise<MaterializeWorkflowArtifactFileResult> {
  const request = parseRequest(payload);
  const dir = join(
    getZCodeDataRootDir(),
    "tmp",
    WORKFLOW_ARTIFACT_DIR,
    identitySegment(request.runId),
    identitySegment(request.artifactId),
    `v${request.version}`,
  );
  const localPath = join(dir, sanitizeFileName(request.fileName, request.artifactId));

  await mkdir(dir, { recursive: true });
  const temporaryPath = join(dir, `.${randomUUID()}.partial`);
  await writeFile(temporaryPath, request.bytes, { flag: "wx" });
  try {
    await link(temporaryPath, localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { localPath };
}

/** 请求来自 RPC 边界，形状与上限在碰磁盘之前再校验一次。 */
function parseRequest(payload: unknown): MaterializeWorkflowArtifactFileRequest {
  const fields = (payload ?? {}) as Partial<
    Record<keyof MaterializeWorkflowArtifactFileRequest, unknown>
  >;
  const { runId, artifactId, version, fileName, bytes } = fields;
  if (
    typeof runId !== "string" ||
    runId.trim().length === 0 ||
    typeof artifactId !== "string" ||
    artifactId.trim().length === 0 ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof fileName !== "string" ||
    !(bytes instanceof Uint8Array)
  ) {
    throw new Error("Workflow artifact file request is invalid");
  }
  if (bytes.byteLength > WORKFLOW_ARTIFACT_FILE_MAX_BYTES) {
    throw new Error(
      `Workflow artifact is too large to open as a file (${bytes.byteLength} bytes, cap ${WORKFLOW_ARTIFACT_FILE_MAX_BYTES})`,
    );
  }
  return { runId, artifactId, version, fileName, bytes };
}

/**
 * run / 产物目录：清洗后的 id 供人读，后缀是**原始** id 的摘要，保证引擎眼里不同的 id 落进不同的目录。
 *
 * 目录名若只是清洗后的 id，macOS / Windows 默认不分大小写（`Report` vs `report`）、清洗会去掉
 * 开头的点（`.notes` vs `notes`），两者都会撞；撞上后同名文件以 EEXIST 命中对方的副本。
 */
function identitySegment(id: string): string {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
  return `${sanitizeSegment(id)}-${digest}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, MAX_SEGMENT_LENGTH);
  return cleaned.length === 0 ? "_" : cleaned;
}

function sanitizeFileName(fileName: string, artifactId: string): string {
  const leaf = fileName.split(/[\\/]/u).at(-1) ?? "";
  let cleaned = leaf
    // oxlint-disable-next-line no-control-regex -- 控制字符正是要替换掉的东西。
    .replace(/[<>:"|?*\u0000-\u001f]/gu, "_")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  if (cleaned.length === 0) cleaned = sanitizeSegment(artifactId);
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH - extension.length) + extension;
  }
  return cleaned;
}
