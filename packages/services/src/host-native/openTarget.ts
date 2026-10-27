import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { HostNativeOpenResult } from "./contract.js";

const logger = createServiceLogger("host-native-files");

/**
 * 图形会话探测。
 *
 * 自部署 server 是**用户在桌面会话里**启动的 user 服务，正常携带 DISPLAY 或 WAYLAND_DISPLAY。
 * 若两者都缺（例如以 system 服务或纯 headless 方式运行），GUI 调用要么挂起、要么静默无效，
 * 因此这里直接 fail-closed 返回明确错误，而不是让调用方等一个永远不返回的子进程。
 */
export function hasGraphicalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["WAYLAND_DISPLAY"]?.trim() || env["DISPLAY"]?.trim());
}

/**
 * 用系统文件管理器打开路径。
 *
 * **语义必须与 Electron `shell.openPath` 完全一致**（用户硬约束：自部署 Web 与 Electron 行为一致）：
 * - 目录 → 打开文件管理器并进入该目录；
 * - 文件 → 用系统默认应用打开该文件（不是打开父目录！）。
 *
 * Linux 上 `xdg-open` 就是这套语义的标准入口；`gio open` 是 GLib 的等价实现（缺 xdg-utils 的
 * 精简发行版上仍在）。两者都失败才返回错误。
 *
 * 子进程 `detached` + `stdio: "ignore"`：文件管理器/默认应用是长期运行的 GUI 进程，
 * 不能被 server 的输出缓冲或父进程生命周期绑住。
 */
export async function openInFileManager(
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostNativeOpenResult> {
  const target = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!target) return { success: false, error: "empty path" };
  if (!hasGraphicalSession(env)) return { success: false, error: "no_display" };

  for (const [command, args] of [
    ["xdg-open", [target]],
    ["gio", ["open", target]],
  ] as const) {
    if (await trySpawn(command, [...args], env)) return { success: true };
  }
  return { success: false, error: "no_file_manager" };
}

/**
 * 「文件应用」定义 —— 严格镜像 `packages/desktop/src/main/fileApplications.ts` 的 Linux 列表。
 *
 * 为什么只有这些：Electron 的 `getEditorDefsForCurrentPlatform()` 在 Linux 上**只**返回
 * `getFileApplicationDefs()`，而 `getInstalledEditors()` 会过滤掉所有带 `fileExtensions` 的项。
 * 因此 **Electron Linux 的编辑器列表恒为空**，`openInEditor` 也只支持按文件类型匹配的文档/媒体应用。
 * 本服务保持同一语义，不额外提供「用 code 打开目录」这类 Electron 没有的能力。
 */
export interface FileApplicationDef {
  id: string;
  name: string;
  /** 与 Electron 一致：`/usr/bin/<executable>`，实际解析时再走 PATH。 */
  appPath: string;
  executableNames: readonly string[];
  fileExtensions: readonly string[];
  launchArgs?: readonly string[];
}

const OFFICE = ["docx", "pptx", "xlsx"] as const;
const MEDIA = ["mp3", "mp4"] as const;

function linux(
  id: string,
  name: string,
  executable: string,
  fileExtensions: readonly string[],
  launchArgs?: readonly string[],
): FileApplicationDef {
  return {
    id,
    name,
    appPath: `/usr/bin/${executable}`,
    executableNames: [executable],
    fileExtensions,
    ...(launchArgs ? { launchArgs } : {}),
  };
}

export const LINUX_FILE_APPLICATION_DEFS: readonly FileApplicationDef[] = [
  linux("evince", "Evince", "evince", ["pdf"]),
  linux("okular", "Okular", "okular", ["pdf"]),
  linux("firefox", "Firefox", "firefox", ["pdf"]),
  linux("wps", "WPS Office", "wps", ["docx"]),
  linux("wps-presentation", "WPS Presentation", "wpp", ["pptx"]),
  linux("wps-spreadsheets", "WPS Spreadsheets", "et", ["xlsx"]),
  linux("libreoffice-writer", "LibreOffice Writer", "libreoffice", ["docx"], ["--writer"]),
  linux("libreoffice-impress", "LibreOffice Impress", "libreoffice", ["pptx"], ["--impress"]),
  linux("libreoffice-calc", "LibreOffice Calc", "libreoffice", ["xlsx"], ["--calc"]),
  linux("vlc", "VLC", "vlc", MEDIA),
  linux("mpv", "mpv", "mpv", MEDIA),
];

void OFFICE;

/** 与 `matchesFileApplication` 一致：按扩展名匹配（大小写不敏感）。 */
export function matchesFileApplication(def: FileApplicationDef, filePath?: string): boolean {
  const leaf = filePath?.replace(/\\/g, "/") ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot < 0) return false;
  const extension = leaf.slice(dot + 1).toLowerCase();
  return def.fileExtensions.includes(extension);
}

/**
 * 用指定应用打开路径。
 *
 * 严格镜像 Electron `packages/desktop/src/main/openInEditor.ts` 的 fileApp 分支：
 * 1. `editorId` 必须命中定义表（否则 `unknown editor: <id>`）；
 * 2. `remoteTarget` / `pathKind === "directory"` / 非绝对路径 / 扩展名不匹配 → `unsupported file application target`；
 * 3. 目标必须是一个真实存在的**文件**（不是目录）；
 * 4. 应用必须已安装（PATH 或 `/usr/bin` 里可执行）；
 * 5. 用 `spawn({detached, stdio:"ignore"})` 启动，只等 spawn 不等退出。
 */
export async function openInEditor(
  editorId: string,
  rawPath: string,
  options: { remoteTarget?: unknown; pathKind?: "file" | "directory" } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostNativeOpenResult> {
  const path = typeof rawPath === "string" ? rawPath : "";
  const def = LINUX_FILE_APPLICATION_DEFS.find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  // 文档应用只能消费本机匹配类型的文件，不能把远端路径当成本机路径打开。
  if (
    options.remoteTarget ||
    options.pathKind === "directory" ||
    !isAbsolute(path) ||
    !matchesFileApplication(def, path)
  ) {
    return { success: false, error: "unsupported file application target" };
  }

  // renderer 的 pathKind 不能证明文件存在；异步 stat 避免阻塞。
  if (!(await stat(path).catch(() => null))?.isFile()) {
    return { success: false, error: "unsupported file application target" };
  }

  const applicationPath = await resolveFileApplicationPath(def, env);
  if (!applicationPath) return { success: false, error: "application is not installed" };
  if (!hasGraphicalSession(env)) return { success: false, error: "no_display" };

  try {
    await spawnDetached(applicationPath, [...(def.launchArgs ?? []), path], env);
    return { success: true };
  } catch (error) {
    logger.warn(undefined, "openInEditor launch failed", {
      editorId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 解析文件应用的可执行文件路径。
 *
 * 与 Electron `resolveFileApplicationPath` 的 Linux 分支一致：先看 `def.appPath`（`/usr/bin/x`），
 * 再在整个 PATH 里找 `executableNames`。
 */
export async function resolveFileApplicationPath(
  def: FileApplicationDef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates = [def.appPath];
  for (const root of (env.PATH ?? "").split(":")) {
    if (!root) continue;
    for (const name of def.executableNames) candidates.push(join(root, name));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** 在 PATH 里解析可执行文件（也接受绝对路径）。 */
export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (command.includes("/")) {
    return (await isExecutable(command)) ? command : null;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动一个 GUI 子进程并只等待「成功 spawn」，不等待退出。
 *
 * 为什么不能 `execFile`：文件管理器、编辑器是长期运行的进程，`execFile` 会缓冲输出并等到
 * 进程退出，直接把 RPC 调用挂死。
 */
function spawnDetached(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: false });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

/** 同 {@link spawnDetached}，但把结果收敛成布尔，供 `openInFileManager` 做多候选回退。 */
function trySpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", env });
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
      child.once("error", (error) => {
        logger.warn(undefined, "GUI launch failed", {
          command,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(false);
      });
      // 兜底：极端环境下 spawn 事件可能不触发（例如 seccomp 拦截），不能让 RPC 永久挂起。
      const timer = setTimeout(() => finish(false), 3_000);
      timer.unref?.();
    } catch (error) {
      logger.warn(undefined, "GUI launch threw", {
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      finish(false);
    }
  });
}
