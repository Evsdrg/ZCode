import { randomUUID } from "node:crypto";
import { VSBuffer, ChannelServer, LoggingChannelServer } from "@zcode/rpc";
import { RelayRpcProtocol } from "./relayRpcProtocol.js";
import { ServiceCollection } from "../collection.js";
import { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { createZCodeAgentConnectionScope } from "../zcode-agent/zcodeAgentConnectionScope.js";
import { IProviderProvisioningTargetService } from "../model-provider/providerProvisioning.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  decodeRelayRpcFrameData,
  encodeRelayRpcFrames,
  type RelayBridgeIdentity,
} from "./relayProtocol.js";
import { resolveRelayWorkspaceKey } from "./relayControlProtocol.js";
import type { RelayWorkspaceView } from "./relayControlProtocol.js";
import { createRelayControlRouter, type RelayControlMessage } from "./relayControlRouter.js";
import type { RelayWorkspaceSource } from "./relayWorkspaceSource.js";

/**
 * relay 数据/控制面桥。
 *
 * 控制面路由官方手机页的全部 zcode_type 控制消息：bootstrap 与 workspace-list
 * 从本地投影应答；workspace-bridge-open 时才挂载 ChannelServer（桥会话 identity
 * 由手机端生成并回显）；platform-request 明确不支持。数据面 rpc-frame 经
 * 直通协议接入 service collection——与浏览器直连 `/ws`（web-remote-replayable）
 * 同一服务面与安全边界（ProviderProvisioningTarget 同样覆写拒绝）。
 */

export interface RelayBridgeChannelOptions {
  services: ServiceCollection;
  sendFrame: (payload: unknown) => boolean;
  workspace: RelayWorkspaceView;
  source: RelayWorkspaceSource;
  logger: ServiceLogger;
  onDegraded?: (reasonCode: string) => void;
}

interface ActiveBridge {
  identity: RelayBridgeIdentity;
  /** 本桥绑定的工作区（多工作区：每次 bridge-open 可指向不同项目）。 */
  workspace: RelayWorkspaceView;
  protocol: RelayRpcProtocol;
  /** 日志包装层（LoggingChannelServer 只透传 registerChannel/ready，没有 dispose）。 */
  server: ChannelServer;
  /** 未包装的原始 ChannelServer：释放必须走它，否则 dispose 未定义会抛错。 */
  rawServer: ChannelServer;
  connectionScope: ReturnType<typeof createZCodeAgentConnectionScope> | undefined;
  /** 物理帧序号（分片各自占用）与逻辑消息序号（每条消息 +1）。 */
  outboundSeq: number;
  outboundMessageSeq: number;
  inboundSeqSeen: Set<number>;
  /** 入站分片重组：messageSeq → 已到分片。 */
  inboundFragments: Map<number, Map<number, Uint8Array>>;
  /** 发送 ChannelServer 的 Initialize 握手帧（deferInit 模式下的显式触发点）。 */
  ready(): void;
}

export interface RelayBridgeChannel {
  /** relay data 帧 payload 入口；控制消息即时应答，rpc-frame 进入数据面。 */
  routePayload(payload: unknown): void;
  dispose(): void;
}

export function createRelayBridgeChannel(options: RelayBridgeChannelOptions): RelayBridgeChannel {
  let activeBridge: ActiveBridge | null = null;

  function sendControl(message: Record<string, unknown>): void {
    options.sendFrame(message);
  }

  /**
   * 释放桥。任何失败都只降级、绝不上抛：曾因日志包装层没有 dispose 抛出未捕获
   * TypeError，直接终止 server 主进程（表现为 WebUI 无响应、刷新后会话被停掉）。
   */
  function disposeActiveBridge(): void {
    if (!activeBridge) return;
    const bridge = activeBridge;
    activeBridge = null;
    try {
      bridge.protocol.end();
      void bridge.connectionScope?.dispose();
      bridge.rawServer.dispose();
    } catch (error) {
      options.logger.warn(undefined, "[relay] 释放桥失败（已忽略，不影响主进程）", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function mountBridge(identity: RelayBridgeIdentity, workspace: RelayWorkspaceView): void {
    disposeActiveBridge();
    const protocol = new RelayRpcProtocol();
    // deferInit：ChannelServer 构造即发 Initialize 握手帧，此时手机端的桥协议对象要等
    // 收到 workspace-bridge-ready 才建立，先到的帧会被可选链静默丢弃，因此必须挂载完成后
    // 显式 ready() 再发。LoggingChannelServer 只透传 registerChannel/ready。
    const rawServer = new ChannelServer(protocol, "web-remote-control-relay", 1000, true);
    const bridge: ActiveBridge = {
      identity,
      workspace,
      protocol,
      // 逐条 RPC 调用属高频诊断，按仓库日志规范走 debug（生产不落盘）；
      // 桥的挂载/释放/失败等生命周期事件仍走 info/warn。
      server: new LoggingChannelServer(rawServer, (...args: unknown[]) =>
        options.logger.debug(undefined, "[relay:rpc]", ...args),
      ) as unknown as ChannelServer,
      rawServer,
      connectionScope: undefined,
      outboundSeq: 0,
      outboundMessageSeq: 0,
      inboundSeqSeen: new Set<number>(),
      inboundFragments: new Map(),
      ready() {
        rawServer.ready();
      },
    };
    // 出站：ChannelServer 的序列化字节（无帧头）按需分片封进 rpc-frame。
    // 守卫用 bridge 自身比对：旧桥 dispose 后残余回调不得再发送。
    protocol.outbound = (buffer) => {
      if (activeBridge !== bridge) return;
      bridge.outboundMessageSeq += 1;
      const firstSeq = bridge.outboundSeq + 1;
      const frames = encodeRelayRpcFrames(bridge.identity, {
        messageSeq: bridge.outboundMessageSeq,
        firstSeq,
        bytes: buffer.buffer,
      });
      bridge.outboundSeq = firstSeq + frames.length - 1;
      for (const frame of frames) {
        options.sendFrame(frame);
      }
    };
    const agentService = options.services.getOptional(IZCodeAgentService);
    bridge.connectionScope = agentService
      ? createZCodeAgentConnectionScope(agentService, {
          connectionId: `relay-bridge-${randomUUID()}`,
          clientMode: "web-remote-replayable",
          role: "terminal-client",
        })
      : undefined;
    const overrides = new Map<string, unknown>();
    if (bridge.connectionScope) {
      overrides.set(IZCodeAgentService.channelName, bridge.connectionScope.service);
    }
    // 与 server /ws 相同的边界：replayable 客户端不得获得 Provider Provisioning 写入面。
    if (options.services.getOptional(IProviderProvisioningTargetService)) {
      overrides.set(IProviderProvisioningTargetService.channelName, {
        apply: async () => {
          throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
        },
      });
    }
    options.services.exposeOnChannelServer(bridge.server, overrides);
    activeBridge = bridge;
  }

  async function respondToWorkspaceBridgeOpen(message: RelayControlMessage): Promise<void> {
    const identity: RelayBridgeIdentity = {
      bridgeSessionId: String(message.bridgeSessionId ?? ""),
      bridgeGeneration: Number(message.bridgeGeneration ?? 1),
      recoveryId: String(message.recoveryId ?? ""),
    };
    const requestedKey = String(message.workspaceKey ?? "");
    // 多工作区：按 key 在全量工作区列表中解析（手机端点击任意项目的任务都会开桥）。
    const matched = requestedKey
      ? await options.source.resolveWorkspaceByKey(requestedKey)
      : null;
    const echo = {
      requestId: message.requestId,
      bridgeSessionId: identity.bridgeSessionId,
      ...(message.bridgeGeneration !== undefined
        ? { bridgeGeneration: identity.bridgeGeneration }
        : {}),
      ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
    };
    if (!identity.bridgeSessionId || !matched) {
      const error = matched
        ? "workspace-bridge-open 缺少 bridgeSessionId"
        : "目标工作区不在当前自部署 server 中";
      options.logger.warn(undefined, "[relay] workspace bridge open 拒绝", { error });
      sendControl({
        zcode_type: "workspace-bridge-error",
        ...echo,
        reason: "unsupported-action",
        error,
      });
      return;
    }
    try {
      mountBridge(identity, matched);
      // bridge 字段按手机端 zod schema（cg）：identity 三元组 + kind 判别 + 工作区标识。
      // 多工作区：回显的是 matched（请求解析出的工作区），不是主工作区。
      sendControl({
        zcode_type: "workspace-bridge-ready",
        ...echo,
        bridge: {
          bridgeSessionId: identity.bridgeSessionId,
          ...(message.bridgeGeneration !== undefined
            ? { bridgeGeneration: identity.bridgeGeneration }
            : {}),
          ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
          kind: matched.kind,
          workspaceKey: resolveRelayWorkspaceKey(matched),
          workspacePath: matched.workspacePath,
          ...(message.taskId ? { initialTaskId: String(message.taskId) } : {}),
        },
      });
      // Initialize 握手帧必须在 workspace-bridge-ready 控制消息之后发送：
      // 手机端的桥协议对象（acceptPayload 路由目标）收到 ready 才建立，先到的
      // rpc-frame 会被可选链静默丢弃，ChannelClient 将永远等不到握手（实测卡死）。
      // 同一流上先 ready 后 Initialize，手机端微任务先完成桥建立再处理下一帧。
      activeBridge?.ready();
      options.logger.info(undefined, "[relay] workspace bridge 已就绪", {
        workspaceKey: requestedKey,
        bridgeSessionId: identity.bridgeSessionId,
      });
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);
      sendControl({
        zcode_type: "workspace-bridge-error",
        ...echo,
        reason: "unsupported-action",
        error: message_,
      });
    }
  }

  function handleRpcFrame(message: Record<string, unknown>): void {
    const bridge = activeBridge;
    if (!bridge) {
      options.logger.debug(undefined, "[relay] 无活动桥，丢弃 rpc-frame");
      return;
    }
    if (message.zcode_type === "rpc-frame-ack") return;
    if (message.bridgeSessionId !== bridge.identity.bridgeSessionId) {
      // 手机端重建桥会话：旧 seq 全部作废，等待新的 bridge-open。
      bridge.inboundSeqSeen.clear();
      bridge.inboundFragments.clear();
      options.logger.warn(undefined, "[relay] rpc-frame 的桥会话不匹配，已清空去重窗口");
      return;
    }
    const seq = Number(message.seq ?? 0);
    if (bridge.inboundSeqSeen.has(seq)) {
      sendControl({ zcode_type: "rpc-frame-ack", ...bridge.identity, ackMessageSeq: seq });
      return;
    }
    const bytes = decodeRelayRpcFrameData({ dataBase64: String(message.dataBase64 ?? "") });
    if (!bytes) {
      options.onDegraded?.("remote.rpcFrame.invalidPayload");
      return;
    }
    bridge.inboundSeqSeen.add(seq);
    sendControl({ zcode_type: "rpc-frame-ack", ...bridge.identity, ackMessageSeq: seq });

    const messageSeq = Number(message.messageSeq ?? 0);
    const fragmentCount = Math.max(1, Number(message.fragmentCount ?? 1));
    const fragmentIndex = Math.max(0, Number(message.fragmentIndex ?? 0));
    const messageBytes = Number(message.messageBytes ?? bytes.buffer.byteLength);
    let assembled: Uint8Array | null = null;
    if (fragmentCount === 1) {
      assembled = bytes.buffer;
    } else {
      // 入站分片重组：按 messageSeq 收集，凑齐 fragmentCount 才投递。
      let fragments = bridge.inboundFragments.get(messageSeq);
      if (!fragments) {
        fragments = new Map();
        bridge.inboundFragments.set(messageSeq, fragments);
      }
      fragments.set(fragmentIndex, bytes.buffer);
      if (fragments.size >= fragmentCount) {
        const merged = new Uint8Array(messageBytes);
        let offset = 0;
        for (let index = 0; index < fragmentCount; index += 1) {
          const part = fragments.get(index);
          if (!part) {
            assembled = null;
            break;
          }
          merged.set(part, offset);
          offset += part.byteLength;
        }
        bridge.inboundFragments.delete(messageSeq);
        if (offset === messageBytes) assembled = merged;
      }
    }
    if (assembled && assembled.byteLength === messageBytes) {
      bridge.protocol.fireInbound(VSBuffer.wrap(assembled));
    } else if (fragmentCount === 1) {
      options.logger.warn(undefined, "[relay] 单片帧字节数与 messageBytes 不符，丢弃", {
        actual: assembled?.byteLength,
        expected: messageBytes,
      });
    }
  }

  const router = createRelayControlRouter({
    sendFrame: options.sendFrame,
    source: options.source,
    openBridge: respondToWorkspaceBridgeOpen,
    handleRpcFrame,
    logger: options.logger,
  });

  return {
    routePayload: (payload: unknown) => router.route(payload),
    dispose() {
      try {
        disposeActiveBridge();
      } catch (error) {
        options.logger.warn(undefined, "[relay] 关闭桥失败（已忽略）", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
