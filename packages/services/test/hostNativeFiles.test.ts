import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { createTempTextAttachment } from "../src/host-native/tempTextAttachment.js";
import {
  materializeWorkflowArtifactFile,
  WORKFLOW_ARTIFACT_FILE_MAX_BYTES,
} from "../src/host-native/workflowArtifactFile.js";

describe("host-native temp text attachment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-host-native-temp-"));
    setDataBaseDir(root);
  });

  afterEach(async () => {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });

  it("把文本落成 .txt 并返回绝对路径与字节数", async () => {
    const text = "长文本内容".repeat(100);
    const result = await createTempTextAttachment({ text });

    expect(result.mimeType).toBe("text/plain");
    expect(result.filename.endsWith(".txt")).toBe(true);
    expect(result.localPath.startsWith(root)).toBe(true);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(await readFile(result.localPath, "utf8")).toBe(text);
  });

  it("保留调用方给的文件名（补 .txt 扩展名并加去重后缀）", async () => {
    const result = await createTempTextAttachment({ text: "hello", filename: "notes.md" });
    expect(result.filename.startsWith("notes.md-")).toBe(true);
    expect(result.filename.endsWith(".txt")).toBe(true);
  });

  it("两次相同请求不会互相覆盖", async () => {
    const a = await createTempTextAttachment({ text: "same" });
    const b = await createTempTextAttachment({ text: "same" });
    expect(a.localPath).not.toBe(b.localPath);
  });

  it("空文本抛错", async () => {
    await expect(createTempTextAttachment({ text: "" })).rejects.toThrow(/empty/i);
  });
});

describe("host-native workflow artifact file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-host-native-artifact-"));
    setDataBaseDir(root);
  });

  afterEach(async () => {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });

  const payload = {
    runId: "dwfrun-abc",
    artifactId: "report",
    version: 1,
    fileName: "report.txt",
    bytes: new TextEncoder().encode("hello artifact"),
  };

  it("落成文件并可读回", async () => {
    const { localPath } = await materializeWorkflowArtifactFile(payload);
    expect(localPath.endsWith("report.txt")).toBe(true);
    expect(await readFile(localPath, "utf8")).toBe("hello artifact");
  });

  it("同一版重复落地保留首次内容（外部编辑不被覆盖）", async () => {
    const { localPath } = await materializeWorkflowArtifactFile(payload);
    await materializeWorkflowArtifactFile({
      ...payload,
      bytes: new TextEncoder().encode("second write"),
    });
    expect(await readFile(localPath, "utf8")).toBe("hello artifact");
  });

  it("不同版本落进不同目录", async () => {
    const v1 = await materializeWorkflowArtifactFile(payload);
    const v2 = await materializeWorkflowArtifactFile({ ...payload, version: 2 });
    expect(v1.localPath).not.toBe(v2.localPath);
    expect(v2.localPath).toContain("/v2/");
  });

  it("清洗文件名：去掉路径分隔符与危险字符", async () => {
    const { localPath } = await materializeWorkflowArtifactFile({
      ...payload,
      fileName: "../../etc/pa:sswd.txt",
    });
    // `:` 被替换成 `_`，`../` 只保留最后一段文件名。
    expect(localPath.endsWith("pa_sswd.txt")).toBe(true);
    expect(localPath.includes("/etc/")).toBe(false);
    expect((await stat(localPath)).isFile()).toBe(true);
  });

  it("超过字节上限抛错", async () => {
    await expect(
      materializeWorkflowArtifactFile({
        ...payload,
        bytes: new Uint8Array(WORKFLOW_ARTIFACT_FILE_MAX_BYTES + 1),
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("非法请求形状抛错", async () => {
    await expect(
      materializeWorkflowArtifactFile({ ...payload, version: 0 } as never),
    ).rejects.toThrow(/invalid/i);
  });
});
