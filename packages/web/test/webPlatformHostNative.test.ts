// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

/**
 * 自部署 WebUI 的 host-native 能力接入。
 *
 * 断言点：注入 hostNativeService 时 `canOpenLocalFiles` 变 true 且各方法真实转发；
 * 未注入（手机远控等）时保持原有失败桩语义。
 *
 * 用动态 import：`main.tsx` 会拉入 xterm 等浏览器 bundle，而 vitest 是 node 环境，
 * 这些模块在顶层读 `self`。这里先补齐最小浏览器全局，再加载模块。
 */
type WebPlatformFactory = typeof import("../src/main.js")["createWebPlatform"];
let createWebPlatform: WebPlatformFactory;

beforeAll(async () => {
  // jsdom 默认 about:blank 无可用 localStorage；main.tsx 顶层会读主题偏好，先补一个内存实现。
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
  // main.tsx 顶层会 createRoot(document.getElementById("root"))；jsdom 的默认文档是空的。
  const rootElement = document.createElement("div");
  rootElement.id = "root";
  document.body.appendChild(rootElement);
  ({ createWebPlatform } = await import("../src/main.js"));
});

describe("createWebPlatform host-native 接入", () => {
  const calls: string[] = [];

  const hostNativeService = {
    async openInFileManager(path: string) {
      calls.push(`openInFileManager:${path}`);
      return { success: true };
    },
    async openInEditor(editorId: string, path: string) {
      calls.push(`openInEditor:${editorId}:${path}`);
      return { success: true };
    },
    async getInstalledEditors() {
      return [{ id: "dolphin", name: "Dolphin", iconDataUrl: "" }];
    },
    async createTempTextAttachment() {
      return {
        filename: "pasted-text.txt",
        localPath: "/home/u/.zcode/tmp/pasted-text.txt",
        mimeType: "text/plain" as const,
        sizeBytes: 3,
      };
    },
    async materializeWorkflowArtifactFile() {
      return { localPath: "/home/u/.zcode/tmp/artifact.txt" };
    },
    async listSSHConfigAliases() {
      return [{ alias: "demo" }];
    },
    async isDockerAvailable() {
      return true;
    },
    async listDockerContainers() {
      return [{ id: "x", image: "i", name: "n", state: "running", status: "Up" }];
    },
  };

  it("无 hostNativeService：canOpenLocalFiles=false，调用走失败桩", async () => {
    const platform = createWebPlatform();
    expect(platform.canOpenLocalFiles).toBe(false);
    expect(await platform.openInFileManager("/tmp")).toEqual({
      success: false,
      error: "Not supported in web mode",
    });
    expect(await platform.getInstalledEditors()).toEqual([]);
    expect(platform.materializeWorkflowArtifactFile).toBeUndefined();
  });

  it("有 hostNativeService：canOpenLocalFiles=true 且真实转发", async () => {
    calls.length = 0;
    const platform = createWebPlatform({ hostNativeService });

    expect(platform.canOpenLocalFiles).toBe(true);
    expect(await platform.openInFileManager("/tmp")).toEqual({ success: true });
    expect(await platform.openInEditor("dolphin", "/tmp")).toEqual({ success: true });
    expect(await platform.getInstalledEditors()).toHaveLength(1);
    expect(await platform.isDockerAvailable()).toBe(true);
    expect(await platform.listDockerContainers()).toHaveLength(1);
    expect(await platform.listSSHConfigAliases()).toEqual([{ alias: "demo" }]);
    expect(await platform.materializeWorkflowArtifactFile?.({} as never)).toEqual({
      localPath: "/home/u/.zcode/tmp/artifact.txt",
    });
    expect(calls).toEqual(["openInFileManager:/tmp", "openInEditor:dolphin:/tmp"]);
  });

  it("有 hostNativeService：长文本附件真的走 server，不再 reject", async () => {
    const platform = createWebPlatform({ hostNativeService });
    const result = await platform.createTempTextAttachment?.({ text: "hello" });
    expect(result?.localPath).toBe("/home/u/.zcode/tmp/pasted-text.txt");
  });
});
