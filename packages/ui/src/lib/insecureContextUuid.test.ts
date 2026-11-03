// HTTP 非安全上下文回归：自部署 WebUI 常以 http://<内网/组网地址>:<port> 访问，
// 这种 origin 不是 secure context，浏览器只暴露 crypto.getRandomValues，
// crypto.randomUUID 与 crypto.subtle 都不存在。
//
// 历史事故：3.17.1 同步时 createCommandEnvelope 新增 `sess_${crypto.randomUUID()}`，
// 使所有 createSession 在发送前抛 TypeError，用户侧只看到「草稿会话创建失败，请重试」，
// 且服务端日志里一条 sendConversationCommandV4 都没有（命令从未离开浏览器）。
//
// 本用例把全局 crypto 替换成「只有 getRandomValues」的非安全上下文形态，
// 锁定 createUuid() 与所有依赖它的入口在这种环境下仍能产出合法 ID。
import { afterEach, describe, expect, it, vi } from "vitest";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 非安全上下文的最小 crypto：只有 getRandomValues，没有 randomUUID / subtle。 */
function installInsecureContextCrypto(): { getRandomValues: (bytes: Uint8Array) => Uint8Array } {
  const stub = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array && "byteLength" in array) {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < view.length; index += 1) {
          view[index] = (index * 37 + 11) & 0xff;
        }
      }
      return array;
    },
  };
  vi.stubGlobal("crypto", stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("非安全上下文（HTTP 自部署）下的 UUID 生成", () => {
  it("确认测试桩确实不具备 randomUUID / subtle", () => {
    installInsecureContextCrypto();
    expect(typeof (globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBe("undefined");
    expect(typeof (globalThis.crypto as { subtle?: unknown }).subtle).toBe("undefined");
    expect(typeof globalThis.crypto.getRandomValues).toBe("function");
  });

  it("createUuid 在只有 getRandomValues 时仍产出合法 UUID v4", async () => {
    installInsecureContextCrypto();
    const { createUuid } = await import("@zcode/shared");
    const id = createUuid();
    expect(id).toMatch(UUID_V4_PATTERN);
  });

  it("createUuid 多次调用产出不同值（随机位来自 getRandomValues）", async () => {
    // 每次调用使用不同的填充序列，模拟真实 getRandomValues 的随机性；
    // 固定填充会让两次调用得到同一串，无法验证「真的读了随机源」。
    let call = 0;
    vi.stubGlobal("crypto", {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        call += 1;
        if (array) {
          const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          for (let index = 0; index < view.length; index += 1) {
            view[index] = (index * 37 + call * 101) & 0xff;
          }
        }
        return array;
      },
    });
    const { createUuid } = await import("@zcode/shared");
    expect(createUuid()).not.toBe(createUuid());
  });

  it("createCommandEnvelope(createSession) 能生成 sess_ 前缀的会话 ID", async () => {
    installInsecureContextCrypto();
    const { createCommandEnvelope } = await import("@/v4/commandFactory.js");
    const envelope = createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/tmp/workspace" },
    });
    const payload = envelope.payload as { sessionId?: string };
    expect(payload.sessionId).toMatch(/^sess_/);
    expect(payload.sessionId?.slice("sess_".length)).toMatch(UUID_V4_PATTERN);
  });

  it("createCommandEnvelope 保留调用方已显式给出的 sessionId（重试不换 ID）", async () => {
    installInsecureContextCrypto();
    const { createCommandEnvelope } = await import("@/v4/commandFactory.js");
    const envelope = createCommandEnvelope({
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/tmp/workspace", sessionId: "sess_fixed" },
    });
    expect((envelope.payload as { sessionId?: string }).sessionId).toBe("sess_fixed");
  });

  it("ensurePendingTaskDraft 在非安全上下文下能落盘 draftId", async () => {
    installInsecureContextCrypto();
    // getStorage() 读的是 window.localStorage（不是 globalThis.localStorage），
    // 因此这里要把桩挂到 window 上。
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    vi.stubGlobal("window", { ...globalThis.window, localStorage: storage });
    const { ensurePendingTaskDraft } = await import("@/v4/composer/composerDraftStore.js");
    const scope = { clientNamespace: "ns", hostId: "local", projectId: null };
    const draft = ensurePendingTaskDraft(scope);
    expect(draft.draftId).toMatch(UUID_V4_PATTERN);
    // 二次调用应复用同一条记录，而不是每次重建。
    expect(ensurePendingTaskDraft(scope).draftId).toBe(draft.draftId);
  });
});
