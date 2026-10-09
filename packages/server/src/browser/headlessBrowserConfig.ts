import { isAbsolute } from "node:path";

export type HeadlessBrowserEngine = "chromium" | "firefox";

export interface HeadlessBrowserConfig {
  engine: HeadlessBrowserEngine;
  executablePath?: string;
}

export type ManagedBrowserConfig =
  | HeadlessBrowserConfig
  | {
      engines: [HeadlessBrowserConfig, HeadlessBrowserConfig];
    };

function executablePath(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim() || undefined;
  if (value && !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function resolveHeadlessBrowserConfig(
  env: Record<string, string | undefined>,
): ManagedBrowserConfig | undefined {
  if (env["ZCODE_SERVER_BROWSER_USE"]?.trim() !== "headless") return undefined;
  const engine = env["ZCODE_SERVER_BROWSER_ENGINE"]?.trim() || "chromium";
  if (engine !== "chromium" && engine !== "firefox" && engine !== "both") {
    throw new Error("ZCODE_SERVER_BROWSER_ENGINE must be chromium, firefox or both");
  }
  const legacy = executablePath(env, "ZCODE_SERVER_BROWSER_EXECUTABLE");
  const configFor = (selected: HeadlessBrowserEngine): HeadlessBrowserConfig => {
    const name =
      selected === "chromium"
        ? "ZCODE_SERVER_BROWSER_CHROMIUM_EXECUTABLE"
        : "ZCODE_SERVER_BROWSER_FIREFOX_EXECUTABLE";
    const path =
      executablePath(env, name) ??
      (engine === "both" && selected === "firefox" ? undefined : legacy);
    return { engine: selected, ...(path ? { executablePath: path } : {}) };
  };
  return engine === "both"
    ? { engines: [configFor("chromium"), configFor("firefox")] }
    : configFor(engine);
}
