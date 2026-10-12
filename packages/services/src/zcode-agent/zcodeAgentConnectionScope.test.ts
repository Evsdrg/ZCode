import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "./zcodeAgentConnectionScope.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";

/**
 * 浏览器自报前台/后台档位（setClientFlowStateV4）的 scope 契约：
 * 只作用于本连接、只接受 saturated/drained、与 dispose 的 closed 串行。
 * 流控按 route（订阅/附件）转发，无 route 时只记本地态，订阅 ACK 后补发。
 */

const WORKSPACE: ZCodeAgentWorkspaceTarget = { workspacePath: "/workspace/project" };

function createBaseDouble() {
  const flowCalls: Array<{ connectionId: string; state: string }> = [];
  const subscribeCalls: Array<Record<string, unknown>> = [];
  let subscriptionSeq = 0;

  const base = {
    setConnectionFlowStateV4: vi.fn(async (params: Record<string, unknown>) => {
      // 真实 base 从 trusted carrier 读 connectionId；scope 只应经该字段注入。
      const trusted = readTrustedZCodeAgentV4Connection(params);
      flowCalls.push({
        connectionId: trusted?.connectionId ?? "undefined",
        state: String(params.state),
      });
    }),
    subscribeConversationV4: vi.fn(async (params: Record<string, unknown>) => {
      subscribeCalls.push(params);
      subscriptionSeq += 1;
      return {
        ack: {
          subscriptionId: `sub-${subscriptionSeq}`,
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      };
    }),
    unsubscribeConversationV4: vi.fn(async () => {}),
    onDynamicConversationFrame: vi.fn(() => new Emitter<unknown>().event),
    onAgentRuntimeLifecycle: undefined,
    onAgentRuntimeRestarted: undefined,
  } as unknown as IZCodeAgentService;

  return { base, flowCalls, subscribeCalls };
}

function createScope(base: IZCodeAgentService) {
  return createZCodeAgentConnectionScope(base, {
    connectionId: "conn-test",
    clientMode: "web-remote-replayable",
    role: "terminal-client",
  });
}

async function handshakeAndSubscribe(service: IZCodeAgentService): Promise<void> {
  await service.helloConversationV4();
  await service.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    clientId: "client-1",
    appVersion: "test",
  });
  await service.subscribeConversationV4({ ...WORKSPACE, sessionId: "sess-1" });
}

describe("setClientFlowStateV4（浏览器自报档位）", () => {
  it("有订阅时 saturated/drained 转发到 CLI，connectionId 由 scope 注入", async () => {
    const { base, flowCalls } = createBaseDouble();
    const scope = createScope(base);
    await handshakeAndSubscribe(scope.service);

    await scope.service.setClientFlowStateV4({ state: "saturated" });
    await scope.service.setClientFlowStateV4({ state: "drained" });

    expect(flowCalls).toEqual([
      { connectionId: "conn-test", state: "saturated" },
      { connectionId: "conn-test", state: "drained" },
    ]);
    await scope.dispose();
  });

  it("拒绝 closed 与未知 state", async () => {
    const { base, flowCalls } = createBaseDouble();
    const scope = createScope(base);
    await handshakeAndSubscribe(scope.service);

    await expect(
      scope.service.setClientFlowStateV4({ state: "closed" } as never),
    ).rejects.toThrow();
    await expect(scope.service.setClientFlowStateV4({ state: "bogus" } as never)).rejects.toThrow();
    expect(flowCalls).toEqual([]);
    await scope.dispose();
  });

  it("订阅建立晚于 saturated 时补发 SAT（不依赖下一个 high-water edge）", async () => {
    const { base, flowCalls, subscribeCalls } = createBaseDouble();
    const scope = createScope(base);

    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "client-1",
      appVersion: "test",
    });
    // 先置后台：此时无 route，只记本地态。
    await scope.service.setClientFlowStateV4({ state: "saturated" });
    expect(flowCalls).toEqual([]);

    // 订阅 ACK 后补发 SAT。
    await scope.service.subscribeConversationV4({ ...WORKSPACE, sessionId: "sess-1" });
    expect(subscribeCalls).toHaveLength(1);
    expect(flowCalls).toEqual([{ connectionId: "conn-test", state: "saturated" }]);
    await scope.dispose();
  });

  it("dispose 后 closed 排在已入队的 SAT 之后，且之后拒绝新档位", async () => {
    const { base, flowCalls } = createBaseDouble();
    const scope = createScope(base);
    await handshakeAndSubscribe(scope.service);

    await scope.service.setClientFlowStateV4({ state: "saturated" });
    await scope.dispose();

    expect(flowCalls.map((call) => call.state)).toEqual(["saturated", "closed"]);
    await expect(scope.service.setClientFlowStateV4({ state: "drained" })).rejects.toThrow();
  });
});
