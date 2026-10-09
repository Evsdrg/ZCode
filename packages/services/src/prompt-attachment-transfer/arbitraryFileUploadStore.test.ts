import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARBITRARY_UPLOAD_MAX_CHUNK_BYTES,
  SHA256_EMPTY_HEX,
  operationIdHash,
} from "./arbitraryFileUploadShared.js";
import {
  createArbitraryFileUploadStore,
  type ArbitraryFileUploadStore,
} from "./arbitraryFileUploadStore.js";
import type {
  PromptAttachmentTransferProgress,
  PromptAttachmentUploadBeginParams,
} from "./promptAttachmentTransfer.js";

const WEB_CHUNK_BYTES = 384 * 1024; // Web 实际分片大小
const SESSION_A = "session-aaaa";
const SESSION_B = "session-bbbb";
const WORKSPACE = "/workspace/demo";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "zcode-arbitrary-upload-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const pending = roots.splice(0).map((root) => rm(root, { recursive: true, force: true }));
  await Promise.all(pending);
});

function sha256HexOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function toChunks(data: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

interface BeginOverrides {
  operationId?: string;
  sessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  fileName?: string;
  mime?: string;
  totalBytes?: number;
  totalChunks?: number;
  checksum?: string;
}

function beginParams(
  data: Buffer,
  overrides: BeginOverrides = {},
): PromptAttachmentUploadBeginParams {
  return {
    operationId: `op-${randomBytes(8).toString("hex")}`,
    sessionId: SESSION_A,
    workspacePath: WORKSPACE,
    fileName: "report.bin",
    mime: "application/octet-stream",
    totalBytes: data.length,
    totalChunks: toChunks(data, WEB_CHUNK_BYTES).length,
    checksum: `sha256:${sha256HexOf(data)}`,
    ...overrides,
  };
}

/** 标准上传事务：begin → 顺序 uploadChunk → commit，返回稳定 ref。 */
async function driveUpload(
  store: ArbitraryFileUploadStore,
  data: Buffer,
  overrides: BeginOverrides = {},
  chunkSize = WEB_CHUNK_BYTES,
): Promise<{ ref: string; bytes: number; operationId: string }> {
  const params = beginParams(data, { totalChunks: toChunks(data, chunkSize).length, ...overrides });
  await expect(store.beginUpload(params)).resolves.toEqual({ state: "staging", nextChunkIndex: 0 });
  const chunks = toChunks(data, chunkSize);
  for (const [index, chunk] of chunks.entries()) {
    await expect(
      store.uploadChunk({
        operationId: params.operationId,
        chunkIndex: index,
        dataBase64: chunk.toString("base64"),
      }),
    ).resolves.toEqual({ nextChunkIndex: index + 1 });
  }
  const committed = await store.commitUpload(params.operationId);
  expect(committed.operationId).toBe(params.operationId);
  expect(committed.bytes).toBe(data.length);
  expect(committed.staged).toBe(true);
  return { ref: committed.ref, bytes: committed.bytes, operationId: params.operationId };
}

async function uploadChunks(
  store: ArbitraryFileUploadStore,
  operationId: string,
  data: Buffer,
  chunkSize = WEB_CHUNK_BYTES,
): Promise<void> {
  const chunks = toChunks(data, chunkSize);
  for (const [index, chunk] of chunks.entries()) {
    await store.uploadChunk({
      operationId,
      chunkIndex: index,
      dataBase64: chunk.toString("base64"),
    });
  }
}

async function readManifestOf(root: string, operationId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, operationIdHash(operationId), "manifest.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function attachmentOf(
  ref: string,
  data: Buffer,
  fileName = "report.bin",
  mime = "application/octet-stream",
) {
  return { ref, fileName, mime, bytes: data.length };
}

describe("createArbitraryFileUploadStore（自部署通用文件附件上传存储）", () => {
  it("取消早于begin不会被晚到事务复活，空或超出声明片数拒绝", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    await store.cleanup("op-cancel-first");
    await expect(
      store.beginUpload(beginParams(Buffer.from("x"), { operationId: "op-cancel-first" })),
    ).rejects.toThrow(/清理/);
    await store.beginUpload(beginParams(Buffer.from("x"), { operationId: "op-empty-chunk" }));
    await expect(
      store.uploadChunk({ operationId: "op-empty-chunk", chunkIndex: 0, dataBase64: "" }),
    ).rejects.toThrow(/空分片/);
    await store.uploadChunk({
      operationId: "op-empty-chunk",
      chunkIndex: 0,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    await expect(
      store.uploadChunk({ operationId: "op-empty-chunk", chunkIndex: 1, dataBase64: "eA==" }),
    ).rejects.toThrow(/声明分片数/);
  });

  it("同进程回收过期ready，配额包括正在上传/待发送/已保留文件", async () => {
    const root = await makeRoot();
    let now = 1_700_000_000_000;
    const store = createArbitraryFileUploadStore({
      root,
      now: () => now,
      quota: { readyBytes: 5, retainedBytes: 8 },
    });
    const original = await driveUpload(store, Buffer.from("1234"), { operationId: "quota-one" });
    await expect(
      store.beginUpload(beginParams(Buffer.from("12"), { operationId: "quota-two" })),
    ).rejects.toThrow(/未发送附件/);
    await store.retainForSend({
      workspacePath: WORKSPACE,
      sessionId: SESSION_A,
      attachments: [attachmentOf(original.ref, Buffer.from("1234"))],
    });
    const ready = await driveUpload(store, Buffer.from("5678"), { operationId: "quota-three" });
    await expect(
      store.beginUpload(beginParams(Buffer.from("x"), { operationId: "quota-four" })),
    ).rejects.toThrow(/附件存储配额/);
    now += 25 * 60 * 60 * 1000;
    await store.beginUpload(beginParams(Buffer.from("x"), { operationId: "quota-five" }));
    await expect(stat(ready.ref)).rejects.toThrow();
    expect(await readFile(original.ref, "utf8")).toBe("1234");
  });

  it("0 字节与 1 字节文件允许提交，内容 SHA-256 一致", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });

    await expect(
      store.beginUpload(
        beginParams(Buffer.alloc(0), {
          operationId: "op-empty",
          totalBytes: 0,
          totalChunks: 0,
          checksum: SHA256_EMPTY_HEX,
        }),
      ),
    ).resolves.toEqual({ state: "staging", nextChunkIndex: 0 });
    const emptyCommitted = await store.commitUpload("op-empty");
    expect(emptyCommitted.bytes).toBe(0);
    expect(emptyCommitted.staged).toBe(true);
    expect(sha256HexOf(await readFile(emptyCommitted.ref))).toBe(SHA256_EMPTY_HEX);

    const oneByte = await driveUpload(store, Buffer.from([0x7f]), { operationId: "op-one" });
    expect(await readFile(oneByte.ref)).toEqual(Buffer.from([0x7f]));
  });

  it("二进制 384KiB 分片：磁盘 SHA-256 与输入一致，目录 700/文件 600，ref 位于 hash/content 布局", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(WEB_CHUNK_BYTES * 2 + 137);

    const { ref } = await driveUpload(store, data, {
      operationId: "op-binary",
      fileName: "报告 中文-π.bin",
    });

    expect(sha256HexOf(await readFile(ref))).toBe(sha256HexOf(data));
    expect(ref.endsWith(join("content", "报告 中文-π.bin"))).toBe(true);
    expect((await stat(ref)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ref, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(join(ref, "..", ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, operationIdHash("op-binary")))).mode & 0o777).toBe(0o700);
  });

  it("20 MiB 等于上限允许（512KiB × 40 片），20 MiB+1 在 begin 拒绝且不建目录", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const exact = randomBytes(20 * 1024 * 1024);
    const exactRef = await driveUpload(
      store,
      exact,
      { operationId: "op-exact", fileName: "exact.bin" },
      ARBITRARY_UPLOAD_MAX_CHUNK_BYTES,
    );
    expect(sha256HexOf(await readFile(exactRef.ref))).toBe(sha256HexOf(exact));

    const overflow = Buffer.concat([exact, Buffer.from([1])]);
    const before = await readdir(root);
    await expect(
      store.beginUpload(
        beginParams(overflow, {
          operationId: "op-overflow",
          totalBytes: overflow.length,
          totalChunks: 41,
          checksum: sha256HexOf(overflow),
        }),
      ),
    ).rejects.toThrow(/begin 参数不合法|totalBytes/);
    expect(await readdir(root)).toEqual(before);
  }, 60_000);

  it("分片边界：超过 512KiB 拒绝、越序拒绝、总量越界拒绝、重复同片幂等、同片内容冲突拒绝", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(WEB_CHUNK_BYTES + 100);
    const operationId = "op-chunks";
    await store.beginUpload(beginParams(data, { operationId }));

    await expect(
      store.uploadChunk({
        operationId,
        chunkIndex: 0,
        dataBase64: randomBytes(ARBITRARY_UPLOAD_MAX_CHUNK_BYTES + 1).toString("base64"),
      }),
    ).rejects.toThrow(/512KiB/);
    await expect(
      store.uploadChunk({
        operationId,
        chunkIndex: 1,
        dataBase64: Buffer.from([1]).toString("base64"),
      }),
    ).rejects.toThrow(/按序/);

    const firstChunk = data.subarray(0, WEB_CHUNK_BYTES);
    const conflicting = Buffer.concat([
      firstChunk.subarray(0, -1),
      Buffer.from([firstChunk.at(-1)! ^ 0xff]),
    ]);
    await expect(
      store.uploadChunk({ operationId, chunkIndex: 0, dataBase64: firstChunk.toString("base64") }),
    ).resolves.toEqual({ nextChunkIndex: 1 });
    await expect(
      store.uploadChunk({ operationId, chunkIndex: 0, dataBase64: firstChunk.toString("base64") }),
    ).resolves.toEqual({ nextChunkIndex: 1 });
    await expect(
      store.uploadChunk({ operationId, chunkIndex: 0, dataBase64: conflicting.toString("base64") }),
    ).rejects.toThrow(/不一致/);

    const tail = data.subarray(WEB_CHUNK_BYTES);
    await expect(
      store.uploadChunk({
        operationId,
        chunkIndex: 1,
        dataBase64: Buffer.concat([tail, Buffer.from([1, 2])]).toString("base64"),
      }),
    ).rejects.toThrow(/totalBytes/);
    await expect(
      store.uploadChunk({ operationId, chunkIndex: 1, dataBase64: tail.toString("base64") }),
    ).resolves.toEqual({ nextChunkIndex: 2 });
  });

  it("begin 幂等重放（uploading 阶段返回 nextChunkIndex），参数冲突拒绝；totalChunks 契约 0..64 且不得少于最少片数", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(1_000_000); // ceil(1_000_000/524288) = 2；允许声明 3 片
    const params = beginParams(data, { operationId: "op-replay", totalChunks: 3 });

    await expect(store.beginUpload(params)).resolves.toEqual({
      state: "staging",
      nextChunkIndex: 0,
    });
    await store.uploadChunk({
      operationId: params.operationId,
      chunkIndex: 0,
      dataBase64: data.subarray(0, WEB_CHUNK_BYTES).toString("base64"),
    });
    await expect(store.beginUpload(params)).resolves.toEqual({
      state: "staging",
      nextChunkIndex: 1,
    });
    await expect(
      store.beginUpload({ ...params, checksum: `sha256:${"0".repeat(64)}` }),
    ).rejects.toThrow(/冲突/);
    await expect(store.beginUpload({ ...params, fileName: "other.bin" })).rejects.toThrow(/冲突/);
    await expect(store.beginUpload({ ...params, sessionId: "other-session" })).rejects.toThrow(
      /冲突/,
    );

    await expect(store.beginUpload({ ...params, totalChunks: 1 })).rejects.toThrow();
    await expect(store.beginUpload({ ...params, totalChunks: 65 })).rejects.toThrow();
    await expect(
      store.beginUpload(
        beginParams(Buffer.alloc(0), {
          operationId: "op-zero-bad",
          totalBytes: 0,
          totalChunks: 1,
          checksum: SHA256_EMPTY_HEX,
        }),
      ),
    ).rejects.toThrow();
  });

  it("commit 重新计量：声明 checksum 不符不 ready；.part 被外部改动提交拒绝；成功后重复 commit 幂等返回同路径", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });

    // 声明 checksum 与实际内容不符：提交拒绝，保持 uploading，正文留在 .part
    const bad = randomBytes(500_000);
    const badParams = beginParams(bad, {
      operationId: "op-checksum",
      checksum: `sha256:${"a".repeat(64)}`,
    });
    await store.beginUpload(badParams);
    await uploadChunks(store, badParams.operationId, bad);
    await expect(store.commitUpload(badParams.operationId)).rejects.toThrow(/校验失败/);
    const badHashDir = join(root, operationIdHash(badParams.operationId));
    await expect(stat(join(badHashDir, "content", "report.bin"))).rejects.toThrow();
    expect((await stat(join(badHashDir, ".upload.part"))).size).toBe(bad.length);
    expect((await readManifestOf(root, badParams.operationId)).status).toBe("uploading");
    await store.cancel(badParams.operationId);

    // 分片落盘后被外部篡改：commit 按磁盘字节重新哈希拒绝
    const tampered = randomBytes(400_000);
    const tamperParams = beginParams(tampered, { operationId: "op-tamper" });
    await store.beginUpload(tamperParams);
    await uploadChunks(store, tamperParams.operationId, tampered);
    await appendFile(
      join(root, operationIdHash("op-tamper"), ".upload.part"),
      Buffer.from([1, 2, 3]),
    );
    await expect(store.commitUpload(tamperParams.operationId)).rejects.toThrow(/校验失败/);

    // 干净提交 + 重复提交幂等
    const clean = randomBytes(1_000);
    const cleanRef = await driveUpload(store, clean, { operationId: "op-idem-commit" });
    const replay = await store.commitUpload("op-idem-commit");
    expect(replay.ref).toBe(cleanRef.ref);
    expect(replay.bytes).toBe(clean.length);
  });

  it("校验和契约：接受前端 sha256: 前缀（大小写不敏感），manifest 归一为内部裸 hex", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = Buffer.from("hello checksum");
    const upper = sha256HexOf(data).toUpperCase();
    const { ref } = await driveUpload(store, data, {
      operationId: "op-normalize",
      checksum: `sha256:${upper}`,
    });
    expect(ref).toBeTruthy();
    expect((await readManifestOf(root, "op-normalize")).checksum).toBe(sha256HexOf(data));
    await expect(
      store.beginUpload(beginParams(data, { operationId: "op-bad-checksum", checksum: "md5:abc" })),
    ).rejects.toThrow(/checksum/);
  });

  it("cancel 后 chunk/commit/adopt 拒绝；cleanup 删除未引用内容并拒绝同名 begin；cleanup 幂等且未知 id 为 no-op", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(WEB_CHUNK_BYTES + 40);
    const operationId = "op-cancel";
    await store.beginUpload(beginParams(data, { operationId }));
    await store.uploadChunk({
      operationId,
      chunkIndex: 0,
      dataBase64: data.subarray(0, WEB_CHUNK_BYTES).toString("base64"),
    });
    await store.cancel(operationId);
    await store.cancel(operationId); // 幂等

    await expect(
      store.uploadChunk({
        operationId,
        chunkIndex: 1,
        dataBase64: data.subarray(WEB_CHUNK_BYTES).toString("base64"),
      }),
    ).rejects.toThrow(/晚到分片/);
    await expect(store.commitUpload(operationId)).rejects.toThrow(/已取消/);
    await expect(store.adopt(operationId)).rejects.toThrow(/仅 ready/);
    await expect(store.cancel("missing-op")).rejects.toThrow(/不存在/);

    await store.cleanup(operationId);
    await store.cleanup(operationId);
    await store.cleanup("never-begun-op");
    await expect(readdir(join(root, operationIdHash(operationId)))).rejects.toThrow();
    await expect(store.beginUpload(beginParams(data, { operationId }))).rejects.toThrow(/已被清理/);
  });

  it("retain：ready→retained 持久化；不同 session/workspace/identity/元信息拒绝串用；retain 幂等", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(1_000);
    const { ref } = await driveUpload(store, data, { operationId: "op-isolation" });
    const attachment = attachmentOf(ref, data);

    await expect(
      store.retainForSend({
        sessionId: SESSION_B,
        workspacePath: WORKSPACE,
        attachments: [attachment],
      }),
    ).rejects.toThrow(/绑定不一致/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: "/workspace/other",
        attachments: [attachment],
      }),
    ).rejects.toThrow(/绑定不一致/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        workspaceIdentity: "identity-x",
        attachments: [attachment],
      }),
    ).rejects.toThrow(/绑定不一致/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        attachments: [attachmentOf(ref, data, "renamed.bin")],
      }),
    ).rejects.toThrow(/元信息/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        attachments: [{ ...attachment, bytes: data.length + 1 }],
      }),
    ).rejects.toThrow(/元信息/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        remoteSessionId: "remote-1",
        attachments: [attachment],
      }),
    ).rejects.toThrow(/远端 target/);

    await store.retainForSend({
      sessionId: SESSION_A,
      workspacePath: WORKSPACE,
      attachments: [attachment],
    });
    await store.retainForSend({
      sessionId: SESSION_A,
      workspacePath: WORKSPACE,
      attachments: [attachment],
    });
    const manifest = await readManifestOf(root, "op-isolation");
    expect(manifest.status).toBe("retained");
    expect(typeof manifest.retainedAt).toBe("number");
    expect(manifest.workspaceKey).toBe(WORKSPACE);
  });

  it("外部引用（desktop localPath/CLI artifact）忽略；root 内非 owned 路径拒绝；远端 scope 携带本机路径拒绝", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        attachments: [
          {
            ref: "/home/user/report.pdf",
            fileName: "report.pdf",
            mime: "application/pdf",
            bytes: 10,
          },
          {
            ref: "/opt/cli/artifact.bin",
            fileName: "artifact.bin",
            mime: "application/octet-stream",
            bytes: 3,
          },
        ],
      }),
    ).resolves.toBeUndefined();

    const data = randomBytes(10);
    const { ref } = await driveUpload(store, data, { operationId: "op-unmanaged" });
    const hash = operationIdHash("op-unmanaged");
    const stray = join(root, "stray.txt");
    await writeFile(stray, "not-owned");
    const rejectCase = (refToReject: string, fileName: string) =>
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        attachments: [
          { ref: refToReject, fileName, mime: "application/octet-stream", bytes: data.length },
        ],
      });
    await expect(rejectCase(stray, "stray.txt")).rejects.toThrow(/非 owned/);
    await expect(rejectCase(join(root, hash, "manifest.json"), "manifest.json")).rejects.toThrow(
      /非 owned/,
    );
    await expect(
      rejectCase(join(root, hash, "content", "report.bin.part"), "report.bin.part"),
    ).rejects.toThrow(/manifest 不匹配/);
    await expect(
      store.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        remoteSessionId: "remote-1",
        attachments: [
          { ref, fileName: "report.bin", mime: "application/octet-stream", bytes: data.length },
        ],
      }),
    ).rejects.toThrow(/远端 target/);
  });

  it("begin 拒绝远端与 workspaceIdentity（本轮 local-only），workspaceKey 隔离保留在 manifest", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = Buffer.from("local-only");
    await expect(
      store.beginUpload(
        beginParams(data, { operationId: "op-remote", remoteSessionId: "remote-1" }),
      ),
    ).rejects.toThrow(/远端/);
    await expect(
      store.beginUpload(
        beginParams(data, { operationId: "op-identity", workspaceIdentity: "identity-1" }),
      ),
    ).rejects.toThrow(/workspaceIdentity/);
    const { ref } = await driveUpload(store, data, { operationId: "op-local" });
    expect((await readManifestOf(root, "op-local")).workspaceKey).toBe(WORKSPACE);
    expect(ref.endsWith(join("content", "report.bin"))).toBe(true);
  });

  it("文件名安全：分隔符/穿越/NUL/CRLF/超长拒绝；Unicode、.part、manifest.json 合法名可上传且同名不覆盖", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = Buffer.from("safe-content");

    const badNames = [
      "../escape.txt",
      "a/b.txt",
      "a\\b.txt",
      "..",
      ".",
      "bad\nname.txt",
      "nul\0name.txt",
      "x".repeat(256),
    ];
    for (const [index, fileName] of badNames.entries()) {
      await expect(
        store.beginUpload(beginParams(data, { operationId: `op-bad-name-${index}`, fileName })),
      ).rejects.toThrow();
    }

    const first = await driveUpload(store, Buffer.from("first"), {
      operationId: "op-name-1",
      fileName: "manifest.json",
    });
    const second = await driveUpload(store, Buffer.from("second-longer"), {
      operationId: "op-name-2",
      fileName: "manifest.json",
    });
    expect(first.ref).not.toBe(second.ref);
    expect((await readFile(first.ref)).toString()).toBe("first");
    expect((await readFile(second.ref)).toString()).toBe("second-longer");

    const partRef = await driveUpload(store, Buffer.from("part-file"), {
      operationId: "op-name-3",
      fileName: "archive.tar.part",
    });
    expect((await readFile(partRef.ref)).toString()).toBe("part-file");
  });

  it("符号链接防护：正文链接拒绝提交且不写穿；operation 目录链接拒绝 begin；root 祖先链接 fail closed", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(WEB_CHUNK_BYTES + 30);
    const operationId = "op-symlink";
    await store.beginUpload(beginParams(data, { operationId }));
    await uploadChunks(store, operationId, data);

    const outside = join(await makeRoot(), "outside-target.bin");
    await writeFile(outside, "do-not-touch");
    const finalPath = join(root, operationIdHash(operationId), "content", "report.bin");
    await symlink(outside, finalPath);
    await expect(store.commitUpload(operationId)).rejects.toThrow(/不覆盖/);
    expect((await readFile(outside)).toString()).toBe("do-not-touch");

    await rm(finalPath);
    const committed = await store.commitUpload(operationId);
    expect(sha256HexOf(await readFile(committed.ref))).toBe(sha256HexOf(data));

    const hijackTarget = await makeRoot();
    await symlink(hijackTarget, join(root, operationIdHash("op-hijack")));
    await expect(
      store.beginUpload(beginParams(data, { operationId: "op-hijack" })),
    ).rejects.toThrow(/符号链接/);

    const linkRoot = join(await makeRoot(), "root-link");
    await symlink(await makeRoot(), linkRoot);
    const guarded = createArbitraryFileUploadStore({ root: linkRoot });
    await expect(
      guarded.beginUpload(beginParams(data, { operationId: "op-guarded" })),
    ).rejects.toThrow(/符号链接/);
  });

  it("Host 重建：uploading→canceled 清 .part，ready/ref 稳定，retained 跨 24h 保留，ready>24h 未引用回收", async () => {
    const root = await makeRoot();
    const baseTime = 1_700_000_000_000;
    const storeA = createArbitraryFileUploadStore({ root, now: () => baseTime });

    const retainedData = randomBytes(1_000);
    const retainedRef = await driveUpload(storeA, retainedData, { operationId: "op-retained" });
    await storeA.retainForSend({
      sessionId: SESSION_A,
      workspacePath: WORKSPACE,
      attachments: [attachmentOf(retainedRef.ref, retainedData)],
    });

    const expiredData = randomBytes(1_000);
    const expiredRef = await driveUpload(storeA, expiredData, { operationId: "op-ready-expired" });

    const partial = randomBytes(WEB_CHUNK_BYTES + 50);
    await storeA.beginUpload(beginParams(partial, { operationId: "op-partial" }));
    await storeA.uploadChunk({
      operationId: "op-partial",
      chunkIndex: 0,
      dataBase64: partial.subarray(0, WEB_CHUNK_BYTES).toString("base64"),
    });
    await storeA.disposeAllAndWait();

    const storeB = createArbitraryFileUploadStore({
      root,
      now: () => baseTime + 25 * 60 * 60 * 1000,
    });
    await storeB.recover();

    // uploading → canceled：.part 与半提交正文清除，同名 begin/commit 拒绝
    await expect(storeB.commitUpload("op-partial")).rejects.toThrow(/已取消/);
    await expect(
      storeB.beginUpload(beginParams(partial, { operationId: "op-partial" })),
    ).rejects.toThrow(/已取消/);
    expect((await readManifestOf(root, "op-partial")).status).toBe("canceled");
    await expect(readdir(join(root, operationIdHash("op-partial"), "content"))).resolves.toEqual(
      [],
    );

    // ready>24h 未引用：目录回收 + tombstone，同名 begin 拒绝
    await expect(stat(expiredRef.ref)).rejects.toThrow();
    await expect(
      storeB.beginUpload(beginParams(expiredData, { operationId: "op-ready-expired" })),
    ).rejects.toThrow(/已被清理/);

    // retained：ref 稳定、正文保留、可再次发送/adopt，且 cleanup 拒绝
    expect(sha256HexOf(await readFile(retainedRef.ref))).toBe(sha256HexOf(retainedData));
    const retainedManifest = await readManifestOf(root, "op-retained");
    expect(retainedManifest.status).toBe("retained");
    expect(retainedManifest.ref).toBe(retainedRef.ref);
    await expect(
      storeB.retainForSend({
        sessionId: SESSION_A,
        workspacePath: WORKSPACE,
        attachments: [attachmentOf(retainedRef.ref, retainedData)],
      }),
    ).resolves.toBeUndefined();
    await storeB.adopt("op-retained");
    await expect(storeB.cleanup("op-retained")).rejects.toThrow(/retained/);
    expect(sha256HexOf(await readFile(retainedRef.ref))).toBe(sha256HexOf(retainedData));
  });

  it("容量上限：reserved 暂存总量 >64MiB 拒绝、并发 uploading >16 拒绝，释放后可继续", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const maxFile = 20 * 1024 * 1024;
    const bigBegin = (operationId: string) =>
      store.beginUpload(
        beginParams(Buffer.alloc(0), {
          operationId,
          totalBytes: maxFile,
          totalChunks: 40,
          checksum: SHA256_EMPTY_HEX,
        }),
      );
    await bigBegin("op-cap-0");
    await bigBegin("op-cap-1");
    await bigBegin("op-cap-2");
    await expect(bigBegin("op-cap-3")).rejects.toThrow(/保留上限/);
    await store.cancel("op-cap-0");
    await store.cancel("op-cap-1");
    await store.cancel("op-cap-2");

    const tinyBegin = (operationId: string) =>
      store.beginUpload(
        beginParams(Buffer.alloc(0), {
          operationId,
          totalBytes: 1,
          totalChunks: 1,
          checksum: sha256HexOf(Buffer.from([1])),
        }),
      );
    for (let index = 0; index < 16; index += 1) {
      await tinyBegin(`op-conc-${index}`);
    }
    await expect(tinyBegin("op-conc-16")).rejects.toThrow(/并发上传数/);
    await store.cancel("op-conc-0");
    await expect(tinyBegin("op-conc-17")).resolves.toEqual({ state: "staging", nextChunkIndex: 0 });
  });

  it("adopt：ready→retained 幂等且不改路径；uploading/canceled 拒绝；空 MIME 规范为 application/octet-stream", async () => {
    const root = await makeRoot();
    const store = createArbitraryFileUploadStore({ root });
    const data = randomBytes(100);
    const { ref } = await driveUpload(store, data, { operationId: "op-adopt", mime: "" });
    await store.retainForSend({
      sessionId: SESSION_A,
      workspacePath: WORKSPACE,
      attachments: [attachmentOf(ref, data, "report.bin", "application/octet-stream")],
    });
    expect((await readManifestOf(root, "op-adopt")).mime).toBe("application/octet-stream");

    const adoptData = randomBytes(50);
    const adoptRef = await driveUpload(store, adoptData, { operationId: "op-adopt-2" });
    await store.adopt("op-adopt-2");
    await store.adopt("op-adopt-2");
    const adoptManifest = await readManifestOf(root, "op-adopt-2");
    expect(adoptManifest.status).toBe("retained");
    expect(adoptManifest.ref).toBe(adoptRef.ref);

    await store.beginUpload(
      beginParams(Buffer.alloc(4), {
        operationId: "op-adopt-3",
        checksum: sha256HexOf(Buffer.alloc(4)),
      }),
    );
    await expect(store.adopt("op-adopt-3")).rejects.toThrow(/仅 ready/);
  });

  it("进度回调：uploading 累计字节、complete、canceled；回调抛错不影响事务；dispose 等待在途并拒绝新事务", async () => {
    const root = await makeRoot();
    const progress: PromptAttachmentTransferProgress[] = [];
    const store = createArbitraryFileUploadStore({
      root,
      onProgress: (event) => {
        progress.push(event);
        throw new Error("callback boom");
      },
    });
    const data = randomBytes(WEB_CHUNK_BYTES + 10);
    await driveUpload(store, data, { operationId: "op-progress" });
    expect(progress.map((event) => event.phase)).toEqual(["uploading", "uploading", "complete"]);
    expect(progress[0]?.uploadedBytes).toBe(WEB_CHUNK_BYTES);
    expect(progress[1]?.uploadedBytes).toBe(data.length);
    expect(
      progress.every(
        (event) => event.operationId === "op-progress" && event.totalBytes === data.length,
      ),
    ).toBe(true);

    await store.beginUpload(
      beginParams(Buffer.from("12345"), { operationId: "op-progress-cancel" }),
    );
    await store.cancel("op-progress-cancel");
    expect(progress.at(-1)?.phase).toBe("canceled");
    expect(progress.at(-1)?.operationId).toBe("op-progress-cancel");

    await store.beginUpload(beginParams(Buffer.from("tail"), { operationId: "op-tail" }));
    await store.uploadChunk({
      operationId: "op-tail",
      chunkIndex: 0,
      dataBase64: Buffer.from("tail").toString("base64"),
    });
    const trailing = store.commitUpload("op-tail");
    await store.disposeAllAndWait();
    await expect(trailing).resolves.toBeTruthy();
    await expect(
      store.beginUpload(beginParams(Buffer.from("x"), { operationId: "op-after-dispose" })),
    ).rejects.toThrow(/已释放/);
  });
});
