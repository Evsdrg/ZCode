import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EditorInfo } from "@zcode/shared";
import {
  LINUX_FILE_APPLICATION_DEFS,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "./openTarget.js";

/**
 * 列出本机已安装的编辑器/应用。
 *
 * **严格镜像 Electron `getInstalledEditors`（Linux）**：
 * - 不传 `filePath` → `getEditorDefsForCurrentPlatform()` 返回的全都带 `fileExtensions`，
 *   而 `getBaseInstalledEditors` 会 `filter(!("fileExtensions" in def))`，所以结果**恒为空**。
 *   这与 Electron 完全一致：Linux 上没有「通用编辑器」概念（`finder`/`explorer` 是 mac/win 的）。
 * - 传 `filePath` → 只列扩展名匹配且已安装的文档/媒体应用（`PreviewPane` 的「打开方式」）。
 *
 * 图标：桌面端用 Electron `app.getFileIcon()`；这里改为解析 `.desktop` 的 `Icon=` 字段，
 * 不依赖 Electron，覆盖 Linux 上绝大多数应用。取不到时返回空串（不因此丢掉一个可用入口）。
 */
export async function getInstalledEditors(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EditorInfo[]> {
  if (!filePath) return [];

  const iconIndex = await readDesktopIconIndex(env);
  const editors: EditorInfo[] = [];
  for (const def of LINUX_FILE_APPLICATION_DEFS) {
    if (!matchesFileApplication(def, filePath)) continue;
    if (!(await resolveFileApplicationPath(def, env))) continue;
    editors.push({
      id: def.id,
      name: def.name,
      iconDataUrl: iconIndex.get(def.id) ?? "",
    });
  }
  return editors;
}

/**
 * 建立「文件应用 id → 图标 data URL」索引。
 *
 * 只做目录扫描与文件读取，不启动任何应用。
 */
async function readDesktopIconIndex(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const dataDirs = xdgDataDirs(env);
  const applicationDirs = dataDirs.map((dir) => join(dir, "applications"));

  for (const def of LINUX_FILE_APPLICATION_DEFS) {
    let found: string | null = null;
    for (const name of desktopFileNamesForId(def.id)) {
      found = await findDesktopEntry(applicationDirs, `${name}.desktop`);
      if (found) break;
    }
    if (!found) continue;
    const iconName = parseDesktopIcon(found);
    if (!iconName) continue;
    const dataUrl = await resolveIconDataUrl(iconName, dataDirs);
    if (dataUrl) index.set(def.id, dataUrl);
  }

  return index;
}

function xdgDataDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(env.XDG_DATA_HOME ? [env.XDG_DATA_HOME] : [join(homedir(), ".local/share")]),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean),
  ];
}

/**
 * 文件应用 id → 候选 .desktop 文件名（不含扩展名）。
 *
 * 同一个应用在不同发行版里的文件名不统一，按顺序逐个找，命中第一个就用。
 */
function desktopFileNamesForId(id: string): readonly string[] {
  switch (id) {
    case "evince":
      return ["org.gnome.Evince", "evince"];
    case "okular":
      return ["org.kde.okular", "okular"];
    case "firefox":
      return ["firefox", "org.mozilla.firefox"];
    case "wps":
      return ["wps", "kingsoft-office", "wps-office"];
    case "wps-presentation":
      return ["wps-presentation", "wpp"];
    case "wps-spreadsheets":
      return ["wps-spreadsheets", "et"];
    case "libreoffice-writer":
      return ["libreoffice-writer", "libreoffice-startcenter"];
    case "libreoffice-impress":
      return ["libreoffice-impress", "libreoffice-startcenter"];
    case "libreoffice-calc":
      return ["libreoffice-calc", "libreoffice-startcenter"];
    case "vlc":
      return ["vlc", "org.videolan.VLC"];
    case "mpv":
      return ["mpv", "io.mpv.Mpv"];
    default:
      return [id];
  }
}

async function findDesktopEntry(
  dirs: readonly string[],
  fileName: string,
): Promise<string | null> {
  for (const dir of dirs) {
    try {
      return await readFile(join(dir, fileName), "utf8");
    } catch {
      // 该目录里没有这个 .desktop，继续找下一个。
    }
  }
  return null;
}

/** 取 `[Desktop Entry]` 段里的 `Icon=` 值。 */
function parseDesktopIcon(content: string): string | null {
  let inDesktopEntry = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || !line.startsWith("Icon=")) continue;
    const value = line.slice("Icon=".length).trim();
    return value || null;
  }
  return null;
}

/**
 * 图标名 → data URL。
 *
 * `.desktop` 的 `Icon=` 可以是绝对路径，也可以是主题图标名。后者按 XDG 图标目录规范查找
 * `<datadir>/icons/hicolor/<size>/apps/<name>.{png,svg,xpm}`。
 */
async function resolveIconDataUrl(
  iconName: string,
  dataDirs: readonly string[],
): Promise<string | null> {
  if (iconName.startsWith("/")) {
    return encodeIconFile(iconName);
  }

  const sizes = ["256x256", "128x128", "64x64", "48x48", "scalable", "32x32"];
  for (const dataDir of dataDirs) {
    for (const size of sizes) {
      for (const ext of ["png", "svg", "xpm"]) {
        const candidate = join(dataDir, "icons", "hicolor", size, "apps", `${iconName}.${ext}`);
        const dataUrl = await encodeIconFile(candidate);
        if (dataUrl) return dataUrl;
      }
    }
  }
  return null;
}

async function encodeIconFile(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    // 上限保护：图标文件不该超过 1 MiB，异常大的文件不塞进 RPC 响应。
    if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) return null;
    const mime = path.endsWith(".svg")
      ? "image/svg+xml"
      : path.endsWith(".xpm")
        ? "image/x-xpixmap"
        : "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
