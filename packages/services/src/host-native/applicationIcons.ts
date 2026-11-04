import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ApplicationIconInfo, ApplicationIconRequest } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("host-native-icons");

/**
 * Linux 图标解析。
 *
 * 语义边界：
 * - Electron 的 `normalizedRequest()` 只接受 `darwin-bundle-id` 与两个 Windows locator，
 *   **Linux 的 `getApplicationIcon` 恒返回 null**。自部署场景下 UI 的真实需求是按
 *   `.desktop` 的 app id / 显示名找图标，本模块提供这一能力；结构化 locator 仍返回 null，
 *   不猜测 macOS/Windows 语义。
 * - `file-apps` 的应用图标同理：Electron Linux 用 `app.getFileIcon(可执行文件)`，我们改为
 *   解析 `.desktop` 的 `Icon=`（主题图标名或绝对路径），更贴合 Linux 惯例且不依赖 Electron。
 *
 * 查找顺序与 XDG 图标主题规范一致：`Icon=` 是绝对路径则直接读；否则按
 * `<datadir>/icons/<theme>/<size>/apps/<name>.{png,svg,xpm}` 逐个尝试，主题按
 * `index.theme` 的 `Inherits` 链回退，最后兜底 `hicolor`。
 */

const ICON_SIZES = ["256x256", "128x128", "96x96", "64x64", "48x48", "scalable", "32x32"] as const;
const ICON_EXTENSIONS = ["png", "svg", "xpm"] as const;
const MAX_ICON_BYTES = 1024 * 1024;

export interface IconLookupOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** 便于测试注入。 */
  readFileImpl?: typeof readFile;
  listDirectoryImpl?: typeof readdir;
}

function xdgDataDirs(env: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const dataHome = env["XDG_DATA_HOME"]?.trim() || join(homeDirectory, ".local", "share");
  const systemDirs = (env["XDG_DATA_DIRS"]?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [dataHome, ...systemDirs];
}

function applicationDirs(env: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  // 与 `editors.ts` / XDG 一致：用户目录优先，命中即用。
  const dataHome = env["XDG_DATA_HOME"]?.trim() || join(homeDirectory, ".local", "share");
  const systemDirs = (env["XDG_DATA_DIRS"]?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [dataHome, ...systemDirs].map((dir) => join(dir, "applications"));
}

/** 从 `.desktop` 内容读 `Icon=`。只在 `[Desktop Entry]` 段内匹配。 */
export function parseDesktopEntryIcon(content: string): string | null {
  let inDesktopEntry = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || line.startsWith("#")) continue;
    if (!line.startsWith("Icon=")) continue;
    const value = line.slice("Icon=".length).trim();
    return value || null;
  }
  return null;
}

async function encodeIconFile(
  path: string,
  readFileImpl: typeof readFile,
): Promise<string | null> {
  try {
    const bytes = await readFileImpl(path);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
    const mime = path.endsWith(".svg")
      ? "image/svg+xml"
      : path.endsWith(".xpm")
        ? "image/x-xpixmap"
        : "image/png";
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * 读取图标主题的 `Inherits` 链。
 *
 * 不读会导致只装 Papirus 之类的主题时（图标不在 hicolor）全部取不到图，
 * 这是自部署形态下实际会遇到的情况（本机 `Theme=Papirus-Dark`）。
 */
async function resolveThemeChain(
  theme: string,
  dataDirs: readonly string[],
  readFileImpl: typeof readFile,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = theme;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    let inherited: string | undefined;
    for (const dataDir of dataDirs) {
      try {
        const content = await readFileImpl(join(dataDir, "icons", current, "index.theme"), "utf8");
        const match = /^Inherits=(.*)$/m.exec(content);
        inherited = match?.[1]
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)[0];
        break;
      } catch {
        // 该 datadir 没有这个主题，继续找下一个。
      }
    }
    current = inherited;
  }
  return chain;
}

/** 当前桌面图标主题；无显式设置时按 hicolor 处理。 */
async function currentIconTheme(
  env: NodeJS.ProcessEnv,
  readFileImpl: typeof readFile,
): Promise<string> {
  const explicit = env["ZCODE_ICON_THEME"]?.trim();
  if (explicit) return explicit;
  // KDE / GTK 都把当前主题写在各自配置里；不引入新依赖，读不到就走 hicolor。
  const home = env["HOME"]?.trim() || homedir();
  try {
    const kdeglobals = await readFileImpl(join(home, ".config", "kdeglobals"), "utf8");
    const match = /^\[Icons\]\s*$(.*?)(?=^\[|$)/ms.exec(kdeglobals);
    const theme = match?.[1] ? /^Theme=(.+)$/m.exec(match[1])?.[1]?.trim() : undefined;
    if (theme) return theme;
  } catch {
    // 没有 kdeglobals，继续尝试 GTK。
  }
  try {
    const settings = await readFileImpl(
      join(home, ".config", "gtk-3.0", "settings.ini"),
      "utf8",
    );
    const theme = /^gtk-icon-theme-name=(.+)$/m.exec(settings)?.[1]?.trim();
    if (theme) return theme;
  } catch {
    // 没有 GTK 配置，回退 hicolor。
  }
  return "hicolor";
}

/**
 * 图标名 → data URL。
 *
 * `iconName` 可以是绝对路径（`.desktop` 里直接写死的图标文件），也可以是主题图标名。
 */
export async function resolveIconDataUrl(
  iconName: string,
  options: IconLookupOptions = {},
): Promise<string | null> {
  const name = iconName.trim();
  if (!name) return null;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const readFileImpl = options.readFileImpl ?? readFile;
  const dataDirs = xdgDataDirs(env, homeDirectory);

  if (isAbsolute(name)) return encodeIconFile(name, readFileImpl);

  const theme = await currentIconTheme(env, readFileImpl);
  const themes = await resolveThemeChain(theme, dataDirs, readFileImpl);
  // hicolor 永远兜底：主题链可能不含它，但按规范它是最后的回退点。
  const candidates = [...new Set([...themes, "hicolor"])];
  for (const themeName of candidates) {
    for (const dataDir of dataDirs) {
      for (const size of ICON_SIZES) {
        for (const ext of ICON_EXTENSIONS) {
          const candidate = join(
            dataDir,
            "icons",
            themeName,
            size,
            "apps",
            `${name}.${ext}`,
          );
          const dataUrl = await encodeIconFile(candidate, readFileImpl);
          if (dataUrl) return dataUrl;
        }
      }
    }
  }
  return null;
}

/** 按 `.desktop` 文件名（app id）读 `Icon=` 并解析成 data URL。 */
export async function resolveDesktopEntryIcon(
  appId: string,
  options: IconLookupOptions = {},
): Promise<string | null> {
  // app id 会拼进 `${appId}.desktop`；带路径分隔符或 .. 会变成路径穿越，必须拒绝。
  const safeAppId = appId.trim();
  if (!safeAppId || safeAppId.includes("/") || safeAppId.includes("\\") || safeAppId.includes("..")) {
    return null;
  }
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const readFileImpl = options.readFileImpl ?? readFile;
  const listDirectoryImpl = options.listDirectoryImpl ?? readdir;

  for (const dir of applicationDirs(env, homeDirectory)) {
    let entries: string[];
    try {
      entries = await listDirectoryImpl(dir);
    } catch {
      continue;
    }
    const fileName = entries.find(
      (entry) =>
        entry === `${safeAppId}.desktop` ||
        entry.toLowerCase() === `${safeAppId.toLowerCase()}.desktop`,
    );
    if (!fileName) continue;
    try {
      const content = await readFileImpl(join(dir, fileName), "utf8");
      const iconName = parseDesktopEntryIcon(content);
      if (!iconName) continue;
      const dataUrl = await resolveIconDataUrl(iconName, options);
      if (dataUrl) return dataUrl;
    } catch (error) {
      logger.warn(undefined, "read desktop entry failed", {
        path: join(dir, fileName),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/**
 * `IPlatformService.getApplicationIcon` 的 Linux 实现。
 *
 * 只接受字符串（app id 或显示名）；结构化 locator 返回 null，与 Electron 的非
 * darwin/win32 分支一致。
 */
export async function getApplicationIcon(
  request: string | ApplicationIconRequest,
  options: IconLookupOptions = {},
): Promise<ApplicationIconInfo | null> {
  if (typeof request !== "string") return null;
  const key = request.trim();
  if (!key || key.includes("\0") || key.includes("/")) return null;
  const iconDataUrl = await resolveDesktopEntryIcon(key, options);
  return iconDataUrl ? { iconDataUrl } : null;
}
