import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ArbitraryFileUploadError,
  arbitraryUploadManifestSchema,
  operationIdHash,
  type ArbitraryUploadManifest,
} from "./arbitraryFileUploadShared.js";

/**
 * 通用文件附件上传的文件系统助手。
 *
 * 目录布局（避免任何合法文件名与元数据碰撞）：
 *   <root>/<hash>/manifest.json          持久 manifest（元数据，无正文）
 *   <root>/<hash>/content/<basename>     提交后的稳定正文（0600）
 *   <root>/<hash>/.upload.part           事务暂存（0600）
 *   <root>/.tombstones/<hash>            cleanup/canceled 后拒绝同名 begin 的墓碑
 *
 * 全部异步 IO；目录 0700、文件 0600；拒绝符号链接与 root 逃逸。
 */

export const MANIFEST_FILE_NAME = "manifest.json";
export const CONTENT_DIR_NAME = "content";
export const TOMBSTONE_DIR_NAME = ".tombstones";
const OPERATION_DIR_NAME_PATTERN = /^[0-9a-f]{64}$/;

export function isOperationDirName(name: string): boolean {
  return OPERATION_DIR_NAME_PATTERN.test(name);
}

export function operationDirPath(root: string, operationId: string): string {
  return join(root, operationIdHash(operationId));
}

export function contentDirPath(operationDir: string): string {
  return join(operationDir, CONTENT_DIR_NAME);
}

export function manifestFilePath(operationDir: string): string {
  return join(operationDir, MANIFEST_FILE_NAME);
}

export function partFilePath(operationDir: string, _fileName: string): string {
  return join(operationDir, ".upload.part");
}

export function finalFilePath(operationDir: string, fileName: string): string {
  return join(contentDirPath(operationDir), fileName);
}

export type ManagedRefClassification =
  | { kind: "outside" }
  | { kind: "unmanaged" }
  | { kind: "owned"; hash: string; finalPath: string };

/**
 * ref 相对存储 root 的分类：
 * - outside：root 之外（桌面原生 localPath、CLI artifact 等），本 store 忽略；
 * - unmanaged：root 内但不是 owned 的 <hash>/content/<basename> 结构（含 manifest、
 *   .part、更深层嵌套等），按规范必须拒绝；
 * - owned：结构匹配，再以 manifest.ref 精确比对为准。basename 不做扩展名限制
 *   （"x.part"、"manifest.json" 都是合法上传文件名，由 content/ 布局避免碰撞）。
 */
export function classifyManagedRef(root: string, ref: string): ManagedRefClassification {
  const resolvedRoot = resolve(root);
  const resolved = resolve(ref);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { kind: "outside" };
  }
  const segments = rel.split(sep);
  if (segments.length !== 3) {
    return { kind: "unmanaged" };
  }
  const [hash, scope, fileName] = segments as [string, string, string];
  if (!isOperationDirName(hash) || scope !== CONTENT_DIR_NAME || fileName.length === 0) {
    return { kind: "unmanaged" };
  }
  return { kind: "owned", hash, finalPath: resolved };
}

/**
 * 路径必须指向真实目录：lstat 拒绝符号链接，realpath 校验全部祖先无符号链接成分。
 * realpath 是权威检查（lstat 只覆盖叶子）。
 */
export async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new ArbitraryFileUploadError("io", `路径不是真实目录（疑似符号链接）: ${path}`);
  }
  const real = await realpath(path);
  if (real !== resolve(path)) {
    throw new ArbitraryFileUploadError("io", `目录路径含符号链接祖先成分: ${path}`);
  }
}

/**
 * 确保目录存在且私有：权限 0700 只收紧本目录（不 chmod 祖先），
 * 符号链接（含祖先成分）一律拒绝。
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await assertRealDirectory(path);
  const finalInfo = (await lstat(path))!;
  if ((finalInfo.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
  }
}

/**
 * 创建 operation 目录（hash/、hash/content/ 均 0700）并为该 operation 预创建空 .part
 * （O_EXCL，不跟随链接）。0 字节文件也依赖这个空 .part 完成提交。
 * 已存在时仅接受“空的真实目录”（begin 中途崩溃残留，自愈重建），其余拒绝。
 */
export async function createOperationDir(operationDir: string, fileName: string): Promise<void> {
  try {
    await mkdir(operationDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw error;
    }
    const info = await lstat(operationDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArbitraryFileUploadError("io", "operation 目录被符号链接/非常规文件占用");
    }
    const entries = await readdir(operationDir);
    if (entries.length > 0) {
      throw new ArbitraryFileUploadError("conflict", "operation 目录已存在且非空，拒绝复用");
    }
    await rm(operationDir, { recursive: true });
    await mkdir(operationDir, { recursive: false, mode: 0o700 });
  }
  await ensurePrivateDir(operationDir);
  await ensurePrivateDir(contentDirPath(operationDir));
  const handle = await open(partFilePath(operationDir, fileName), "ax", 0o600);
  await handle.close();
}

/**
 * manifest 原子持久化：随机临时文件名 + O_EXCL（wx，不跟随已存在符号链接）写 0600，
 * 再同目录 rename；写前校验 operation 目录非符号链接，目标 manifest 若被链接替换则拒绝。
 * 调用方必须持有串行事务，并遵守“先落盘成功、后更新内存投影”的顺序。
 */
export async function writeManifestAtomic(
  operationDir: string,
  manifest: ArbitraryUploadManifest,
): Promise<void> {
  await assertRealDirectory(operationDir);
  const target = manifestFilePath(operationDir);
  const targetInfo = await lstat(target).catch(() => null);
  if (targetInfo?.isSymbolicLink()) {
    throw new ArbitraryFileUploadError("io", "manifest 已被符号链接替换");
  }
  const payload = JSON.stringify(manifest);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(tmp, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        continue; // 随机名碰撞：换名重试
      }
      throw error;
    }
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
  throw new ArbitraryFileUploadError("io", "manifest 临时文件创建失败");
}

/** 读取并 runtime 校验 manifest；缺失/损坏返回 null（调用方保守处理，不误删）。 */
export async function readManifest(operationDir: string): Promise<ArbitraryUploadManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestFilePath(operationDir), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = arbitraryUploadManifestSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** 流式哈希整个文件，返回字节数与全量原字节 SHA-256（不信任客户端 size 声明）。 */
export async function hashFileContents(path: string): Promise<{ bytes: number; checksum: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    stream.destroy();
  }
  return { bytes, checksum: hash.digest("hex") };
}

/**
 * 分片追加只允许落在已确认偏移：.part 必须已存在（begin 预创建）且为常规文件，
 * 长度与已确认字节一致，追加经 append 模式句柄完成。
 */
export async function appendChunkVerified(
  partPath: string,
  data: Buffer,
  expectedOffset: number,
): Promise<void> {
  await assertRealDirectory(dirname(partPath));
  const info = await lstat(partPath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new ArbitraryFileUploadError("io", ".part 缺失或被符号链接/非常规文件替换");
  }
  const size = (await stat(partPath)).size;
  if (size !== expectedOffset) {
    throw new ArbitraryFileUploadError(
      "conflict",
      ".part 长度与已确认字节不一致（疑似被外部改动）",
    );
  }
  const handle = await open(partPath, "a", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 删除 operation 目录内容并写入 tombstone：仅供 owner 的 cleanup/TTL 回收调用。 */
export async function removeOperationContent(root: string, hash: string): Promise<void> {
  await rm(join(root, hash), { recursive: true, force: true });
  await writeOperationTombstone(root, hash);
}

/** cleanup/canceled 后的墓碑：同 operationId 的 begin 永久拒绝（UI 需换新 id 重试）。 */
export async function writeOperationTombstone(root: string, hash: string): Promise<void> {
  const tombstoneDir = join(root, TOMBSTONE_DIR_NAME);
  await ensurePrivateDir(tombstoneDir);
  await writeFile(join(tombstoneDir, hash), "", { encoding: "utf8", mode: 0o600 });
}
