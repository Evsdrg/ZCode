import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { EditorInfo } from "@zcode/shared";
import {
  EDITOR_DISPLAY_NAMES,
  EDITOR_LAUNCH_DEFS,
  resolveExecutable,
} from "./openTarget.js";

/**
 * 列出本机已安装、且本服务能打开的编辑器/应用。
 *
 * 与桌面端 `packages/desktop/src/main/editors.ts` 的差别：桌面端用 `app.getFileIcon()` 取图标，
 * 这里改为解析 `.desktop` 文件的 `Icon=` 字段。这样既不依赖 Electron，也能覆盖 Linux 上
 * 绝大多数应用。
 *
 * 语义对齐：`filePath` 缺省时只列「编辑器」（任何文件都能开）；传了 `filePath` 时，
 * 额外列入扩展名匹配的文档/媒体应用——与桌面端「可选文件路径只扩展文件菜单」一致。
 *
 * 只列「定义表里存在 + PATH 里能找到可执行文件」的项，保证列出来的每一项都能真的打开。
 */
export async function getInstalledEditors(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EditorInfo[]> {
  const extension = filePath ? extname(filePath).replace(/^\./u, "").toLowerCase() : "";
  const desktopIconIndex = await readDesktopIconIndex(env);
  const editors: EditorInfo[] = [];

  for (const [id, def] of Object.entries(EDITOR_LAUNCH_DEFS)) {
    if (def.fileExtensions) {
      // 文档/媒体应用：只有明确请求了匹配扩展名的文件时才出现。
      if (!extension || !def.fileExtensions.includes(extension)) continue;
    }
    if (!(await resolveExecutable(def.executable, env))) continue;
    editors.push({
      id,
      name: EDITOR_DISPLAY_NAMES[id] ?? id,
      iconDataUrl: desktopIconIndex.get(id) ?? "",
    });
  }

  return editors;
}

/**
 * 建立「图标 data URL」索引。
 *
 * 只做目录扫描与文件读取，不启动任何应用。图标缺失时该字段为空串——消费方按需降级，
 * 但不会因为缺图标而丢掉一个可用入口（本服务没有 Electron 的通用文件图标兜底）。
 */
async function readDesktopIconIndex(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const dataDirs = xdgDataDirs(env);
  const applicationDirs = dataDirs.map((dir) => join(dir, "applications"));

  for (const id of Object.keys(EDITOR_LAUNCH_DEFS)) {
    let found: string | null = null;
    for (const name of desktopFileNamesForId(id)) {
      found = await findDesktopEntry(applicationDirs, `${name}.desktop`);
      if (found) break;
    }
    if (!found) continue;
    const iconName = parseDesktopIcon(found);
    if (!iconName) continue;
    const dataUrl = await resolveIconDataUrl(iconName, dataDirs);
    if (dataUrl) index.set(id, dataUrl);
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
 * 编辑器 id → 候选 .desktop 文件名（不含扩展名）。
 *
 * 同一个应用在不同发行版里的 .desktop 文件名不统一（VS Code 官方包用反向域名
 * `com.microsoft.VSCode.desktop`，Debian 另有 `code.desktop`），因此按顺序逐个找，
 * 命中第一个就用。
 */
function desktopFileNamesForId(id: string): readonly string[] {
  switch (id) {
    case "vscode":
      return ["com.microsoft.VSCode", "code", "visual-studio-code"];
    case "vscode-insiders":
      return ["com.microsoft.VSCodeInsiders", "code-insiders"];
    case "cursor":
      return ["cursor", "CoCursor"];
    case "dolphin":
      return ["org.kde.dolphin", "dolphin"];
    case "nautilus":
      return ["org.gnome.Nautilus", "nautilus"];
    case "evince":
      return ["org.gnome.Evince", "evince"];
    case "okular":
      return ["org.kde.okular", "okular"];
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

/** 目录扫描结果缓存（应用安装状态在进程生命周期内不变）。 */
let cachedEditors: Promise<EditorInfo[]> | null = null;

export function getCachedInstalledEditors(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EditorInfo[]> {
  cachedEditors ??= getInstalledEditors(undefined, env).catch((error) => {
    // 探测失败不能永久缓存：下一次调用应重试（例如 PATH 在服务重启后才补齐）。
    cachedEditors = null;
    throw error;
  });
  return cachedEditors;
}

/** 仅供测试：清空缓存。 */
export function resetInstalledEditorsCache(): void {
  cachedEditors = null;
}
