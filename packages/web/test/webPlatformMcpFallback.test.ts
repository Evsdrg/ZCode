import { describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: renderMock }),
}));

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => children,
  Root: () => null,
  ZCodeIntlProvider: ({ children }: { children: unknown }) => children,
  generateMobileDeviceFingerprint: vi.fn(() => "test-mobile-fingerprint"),
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

async function importCreateWebPlatform() {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: vi.fn() } },
    getElementById: vi.fn(() => ({ nodeType: 1 })),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    matchMedia: () => ({ matches: false }),
    location: new URL("https://zcode.z.ai/"),
  });
  vi.stubGlobal("navigator", { language: "zh-CN" });
  const { createWebPlatform } = await import("../src/main.js");
  return createWebPlatform;
}

describe("createWebPlatform MCP 目录服务回退", () => {
  it("无 desktop attachment 且未注入回退时保持上游行为：静默空列表", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const platform = createWebPlatform();

    await expect(platform.loadMcpFromUserDirectory?.({ workspacePath: "/ws" })).resolves.toEqual({
      servers: [],
    });
    await expect(platform.saveMcpToUserDirectory?.({ action: "upsert" } as never)).resolves.toEqual(
      {
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      },
    );
  });

  it("注入 mcpDirectoryService 后读取与保存都走 server 回退", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const loadMcpFromUserDirectory = vi.fn(() =>
      Promise.resolve({
        servers: [
          {
            source: "user",
            scope: "user",
            name: "pdf-rag",
            config: { type: "http", url: "http://10.126.126.1:8100/mcp" },
          },
        ],
      }),
    );
    const saveMcpToUserDirectory = vi.fn(() => Promise.resolve({ success: true }));
    const platform = createWebPlatform({
      mcpDirectoryService: {
        loadMcpFromUserDirectory: loadMcpFromUserDirectory as never,
        saveMcpToUserDirectory: saveMcpToUserDirectory as never,
      },
    });

    await expect(platform.loadMcpFromUserDirectory?.({ workspacePath: "/ws" })).resolves.toEqual({
      servers: [
        {
          source: "user",
          scope: "user",
          name: "pdf-rag",
          config: { type: "http", url: "http://10.126.126.1:8100/mcp" },
        },
      ],
    });
    await expect(
      platform.saveMcpToUserDirectory?.({ action: "delete", name: "x" } as never),
    ).resolves.toEqual({ success: true });
    expect(loadMcpFromUserDirectory).toHaveBeenCalledWith({ workspacePath: "/ws" });
    expect(saveMcpToUserDirectory).toHaveBeenCalledWith({ action: "delete", name: "x" });
  });
});
