import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
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
 * `xdg-open` 是 Linux 桌面标准入口；`gio open` 是 GLib 的等价实现（在缺 xdg-utils 的精简
 * 发行版上仍在）。两者都失败才返回错误。子进程 `detached` + `stdio: "ignore"`：文件管理器是
 * 长期运行的 GUI 进程，不能被 server 的输出缓冲或父进程生命周期绑住。
 */
export async function openInFileManager(
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostNativeOpenResult> {
  const target = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!target) return { success: false, error: "empty path" };
  if (!hasGraphicalSession(env)) return { success: false, error: "no_display" };

  // 文件用 `gio open` 交给默认应用；目录/未知路径则定位到该位置。
  const statResult = await stat(target).catch(() => null);
  const candidates: ReadonlyArray<readonly [string, readonly string[]]> = statResult?.isDirectory()
    ? [
        ["xdg-open", [target]],
        ["gio", ["open", target]],
      ]
    : [
        ["xdg-open", [parentDirectoryOf(target)]],
        ["gio", ["open", parentDirectoryOf(target)]],
      ];

  for (const [command, args] of candidates) {
    if (await trySpawn(command, [...args], env)) return { success: true };
  }
  return { success: false, error: "no_file_manager" };
}

/**
 * 用指定应用打开路径。
 *
 * `editorId` 必须来自 {@link EDITOR_LAUNCH_DEFS}，由本服务维护 id → 命令的映射，
 * 不接受调用方传入任意命令（RPC 边界不做命令拼接）。
 */
export async function openInEditor(
  editorId: string,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostNativeOpenResult> {
  const target = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!target) return { success: false, error: "empty path" };
  if (!hasGraphicalSession(env)) return { success: false, error: "no_display" };

  const def = EDITOR_LAUNCH_DEFS[editorId];
  if (!def) return { success: false, error: `unknown editor: ${editorId}` };

  const executable = await resolveExecutable(def.executable, env);
  if (!executable) return { success: false, error: "application is not installed" };

  const exists = await stat(target).catch(() => null);
  if (!exists) return { success: false, error: "path_not_found" };

  const ok = await trySpawn(
    executable,
    [...(def.launchArgs ?? []), target],
    env,
  );
  return ok ? { success: true } : { success: false, error: "launch_failed" };
}

export interface EditorLaunchDef {
  executable: string;
  launchArgs?: readonly string[];
  /**
   * 能消费的文件扩展名。缺省表示「编辑器」——任何文件都能开；
   * 有值时表示「文档/媒体应用」——只在 `getInstalledEditors(filePath)` 传了匹配扩展名时才列出。
   */
  fileExtensions?: readonly string[];
}

/**
 * id → 可执行命令。与 `packages/desktop/src/main/fileApplications.ts` 的 Linux 列表对齐，
 * 但只保留「打开一个路径」这一层语义，不需要 macOS/Windows 的 bundle/注册表解析。
 */
export const EDITOR_LAUNCH_DEFS: Readonly<Record<string, EditorLaunchDef>> = {
  // 文件管理器
  dolphin: { executable: "dolphin" },
  nautilus: { executable: "nautilus" },
  thunar: { executable: "thunar" },
  nemo: { executable: "nemo" },
  // 代码编辑器
  vscode: { executable: "code" },
  "vscode-insiders": { executable: "code-insiders" },
  cursor: { executable: "cursor" },
  zed: { executable: "zed" },
  // 文档应用
  evince: { executable: "evince", fileExtensions: ["pdf", "ps", "eps", "djvu"] },
  okular: { executable: "okular", fileExtensions: ["pdf", "ps", "djvu", "epub", "chm"] },
  "libreoffice-writer": {
    executable: "libreoffice",
    launchArgs: ["--writer"],
    fileExtensions: ["doc", "docx", "odt", "rtf", "txt"],
  },
  "libreoffice-impress": {
    executable: "libreoffice",
    launchArgs: ["--impress"],
    fileExtensions: ["ppt", "pptx", "odp"],
  },
  "libreoffice-calc": {
    executable: "libreoffice",
    launchArgs: ["--calc"],
    fileExtensions: ["xls", "xlsx", "ods", "csv"],
  },
  // 媒体
  vlc: { executable: "vlc", fileExtensions: ["mp3", "mp4", "mkv", "avi", "mov", "flac", "wav"] },
  mpv: { executable: "mpv", fileExtensions: ["mp3", "mp4", "mkv", "avi", "mov", "flac", "wav"] },
  firefox: { executable: "firefox", fileExtensions: ["html", "htm", "svg"] },
};

/** 显示名（`EditorInfo.name`）。 */
export const EDITOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  dolphin: "Dolphin",
  nautilus: "Files",
  thunar: "Thunar",
  nemo: "Nemo",
  vscode: "Visual Studio Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  zed: "Zed",
  evince: "Document Viewer",
  okular: "Okular",
  "libreoffice-writer": "LibreOffice Writer",
  "libreoffice-impress": "LibreOffice Impress",
  "libreoffice-calc": "LibreOffice Calc",
  vlc: "VLC",
  mpv: "mpv",
  firefox: "Firefox",
};

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

function parentDirectoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
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
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env,
      });
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
