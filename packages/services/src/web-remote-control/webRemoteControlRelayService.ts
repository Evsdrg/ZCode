import { hostname } from "node:os";
import { WebSocket } from "ws";
import { ZCODE_VERSION } from "@zcode/shared";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { ISettingService } from "../setting/setting.js";
import type { PersistedWorkspaceSessionEntry } from "@zcode/shared";
import { basename } from "node:path";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ServiceCollection } from "../collection.js";
import {
  buildRelayPairingQrUrl,
  createRelayDeviceCredential,
  resolveRelayWsUrl,
  type RelayDeviceCredential,
} from "./relayProtocol.js";
import {
  RelayDeviceTransport,
  type RelayDeviceTransportState,
  type RelayWebSocketCtor,
} from "./relayDeviceTransport.js";
import { createRelayBridgeChannel, type RelayBridgeChannel } from "./relayBridgeChannel.js";
import {
  projectRelayTaskView,
  type RelayTaskView,
  type RelayWorkspaceView,
} from "./relayControlProtocol.js";
import {
  createRelayWorkspaceSource,
  type RelayWorkspaceSourcePort,
} from "./relayWorkspaceSource.js";
import type {
  IWebRemoteControlRelayService,
  WebRemoteControlRelayState,
  WebRemoteControlRelayStatus,
} from "./webRemoteControlRelay.js";

/**
 * 官方中转远程控制服务实现。
 *
 * 状态唯一所有者：本实例持有 transport、bridge 与持久化意图（enabled + 设备凭证）。
 * UI 经 RPC 读取投影（getStatus/getPairingInfo）并发命令（setEnabled/resetPairing）。
 * 凭据含 passHash，整体经 credentialService 加密落盘；server 重启按 enabled 自动重连，
 * 复用同一 deviceSid，二维码不变。
 */

const STATE_STORAGE_KEY = "web-remote-control:relay-device-state";

interface PersistedRelayState {
  enabled: boolean;
  credential: RelayDeviceCredential;
}

export interface CreateWebRemoteControlRelayServiceOptions {
  credentialService: ICredentialService;
  /** 数据面在 paired 时才挂载；注册链求值期 services 尚未建好，必须经 getter 注入。 */
  resolveServices: () => ServiceCollection;
  relayWsUrl?: string;
  deviceName?: string;
  appVersion?: string;
  webSocketCtor?: RelayWebSocketCtor;
}

export function createWebRemoteControlRelayService(
  options: CreateWebRemoteControlRelayServiceOptions,
): IWebRemoteControlRelayService {
  const logger = createServiceLogger("web-remote-control");
  const relayWsUrl = options.relayWsUrl ?? resolveRelayWsUrl();
  const deviceName = options.deviceName ?? hostname();
  const appVersion = options.appVersion ?? ZCODE_VERSION;
  const webSocketCtor: RelayWebSocketCtor =
    options.webSocketCtor ??
    ((url, wsOptions) =>
      new WebSocket(url, wsOptions) as unknown as ReturnType<RelayWebSocketCtor>);

  let persisted: PersistedRelayState | null = null;
  let readyPromise: Promise<void> | null = null;
  let transport: RelayDeviceTransport | null = null;
  let bridge: RelayBridgeChannel | null = null;
  let runtimeState: WebRemoteControlRelayState = "disabled";
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let authRetryUsed = false;

  async function ensureReady(): Promise<PersistedRelayState | null> {
    if (!readyPromise) {
      readyPromise = (async () => {
        const raw = await options.credentialService.load(STATE_STORAGE_KEY);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as PersistedRelayState;
          if (
            parsed &&
            typeof parsed.enabled === "boolean" &&
            parsed.credential &&
            typeof parsed.credential.deviceMid === "string" &&
            typeof parsed.credential.passHash === "string"
          ) {
            persisted = parsed;
          }
        } catch {
          logger.warn(undefined, "[relay] 持久化状态损坏，忽略并按首次使用处理");
        }
      })();
    }
    await readyPromise;
    return persisted;
  }

  async function persist(next: PersistedRelayState): Promise<void> {
    persisted = next;
    await options.credentialService.save(STATE_STORAGE_KEY, JSON.stringify(next));
  }

  function mapTransportState(state: RelayDeviceTransportState): WebRemoteControlRelayState {
    switch (state) {
      case "waiting_terminal":
        return "waiting";
      case "paired":
        return "paired";
      case "error":
        return "error";
      case "idle":
        return persisted?.enabled ? "connecting" : "disabled";
      default:
        return "connecting";
    }
  }

  function applyRuntimeState(state: WebRemoteControlRelayState): void {
    runtimeState = state;
    if (state !== "error") {
      errorCode = undefined;
      errorMessage = undefined;
    }
  }

  function resolvePrimaryWorkspace(): RelayWorkspaceView {
    const workspacePath = process.env.ZCODE_SERVER_WORKSPACE?.trim() || process.cwd();
    return {
      workspacePath,
      kind: "local",
      connectionState: "connected",
      label: basename(workspacePath) || workspacePath,
    };
  }

  /** 手机端工作区列表：持久化的全部本地项目 + 当前 server 工作区（去重，主工作区在前）。 */
  function buildWorkspaceViews(
    persisted: PersistedWorkspaceSessionEntry[] | undefined,
  ): RelayWorkspaceView[] {
    const views: RelayWorkspaceView[] = [];
    const seen = new Set<string>();
    const push = (workspacePath: string, purpose?: string) => {
      const trimmed = workspacePath.trim();
      if (!trimmed) return;
      // 手机端 workspaceKey = workspacePath；conversation 用途的默认草稿工作区不暴露。
      if (purpose === "conversation" || seen.has(trimmed)) return;
      seen.add(trimmed);
      views.push({
        workspacePath: trimmed,
        kind: "local",
        connectionState: "connected",
        label: basename(trimmed) || trimmed,
      });
    };
    push(resolvePrimaryWorkspace().workspacePath, "project");
    for (const entry of persisted ?? []) {
      if (entry.kind !== "local") continue;
      push(entry.workspacePath, entry.workspacePurpose);
    }
    return views;
  }

  function createWorkspaceSourcePort(): RelayWorkspaceSourcePort | undefined {
    const services = options.resolveServices();
    const taskService = services.getOptional(IZCodeTaskService);
    if (!taskService) return undefined;
    return {
      async listWorkspaces(): Promise<RelayWorkspaceView[]> {
        const settingService = services.getOptional(ISettingService);
        if (!settingService) return [resolvePrimaryWorkspace()];
        try {
          const settings = await settingService.get();
          return buildWorkspaceViews(settings.lastWorkspaceSession);
        } catch {
          return [resolvePrimaryWorkspace()];
        }
      },
      async listTasks(workspaces: RelayWorkspaceView[]): Promise<RelayTaskView[]> {
        let pinnedIds: Set<string> | undefined;
        try {
          pinnedIds = new Set(await taskService.listPinnedTaskIds());
        } catch {
          pinnedIds = undefined;
        }
        // 手机端任务列表跨工作区展示：按工作区 scopes 聚合查询（active 时间线）。
        const result = await taskService.listTaskList({
          kind: "active",
          sortBy: "updated",
          workspaceScopes: workspaces.map((w) => ({ workspacePath: w.workspacePath })),
          limit: 200,
        });
        return result.items.map((meta) =>
          projectRelayTaskView(meta, {
            pinned: pinnedIds?.has(meta.taskId),
            workspaceLabel: basename(meta.workspacePath) || meta.workspacePath,
          }),
        );
      },
    };
  }

  function mountBridge(): void {
    if (bridge) return;
    bridge = createRelayBridgeChannel({
      services: options.resolveServices(),
      sendFrame: (payload) => transport?.sendPayload(payload) ?? false,
      workspace: resolvePrimaryWorkspace(),
      source: createRelayWorkspaceSource({
        primaryWorkspace: resolvePrimaryWorkspace(),
        port: createWorkspaceSourcePort(),
        windowControlSessionId: persisted?.credential.deviceSid ?? deviceName,
        logger,
      }),
      logger,
      onDegraded: (reasonCode) => {
        logger.warn(undefined, "[relay] 数据面降级，断开桥", { reasonCode });
        unmountBridge();
      },
    });
    logger.info(undefined, "[relay] 桥已挂载（手机端已配对，等待 bootstrap）");
  }

  function unmountBridge(): void {
    bridge?.dispose();
    bridge = null;
  }

  function startTransport(credential: RelayDeviceCredential): void {
    transport?.dispose();
    unmountBridge();
    authRetryUsed = false;
    applyRuntimeState("connecting");
    transport = new RelayDeviceTransport({
      relayWsUrl,
      deviceMid: credential.deviceMid,
      credential,
      meta: { platform: process.platform, version: appVersion, name: deviceName },
      logger,
      webSocketCtor,
      onStateChange: (state) => {
        const next = mapTransportState(state);
        // 桥的挂载/卸载是可选功能，异常只降级不冒泡：这里由 socket 事件驱动，
        // 未捕获异常会终止 server 主进程（曾实测：日志包装层缺 dispose 导致整个 WebUI 挂掉）。
        try {
          if (state === "waiting_terminal") unmountBridge();
          if (state === "paired") mountBridge();
        } catch (error) {
          logger.warn(undefined, "[relay] 桥状态切换失败（已忽略，不影响主进程）", {
            state,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        applyRuntimeState(next);
      },
      onPayload: (payload) => {
        if (!bridge) return;
        bridge.routePayload(payload);
      },
      onRegisteredAuth: (next) => {
        if (!persisted) return;
        void persist({ ...persisted, credential: next }).catch((error: unknown) => {
          logger.warn(undefined, "[relay] 凭据持久化失败", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
      onTerminalError: (code, message) => {
        // 持久 deviceSid 失效（服务器清理等）时丢弃 sid 重注册一次；再失败进入 error 态。
        if (code === "AUTH_FAILED" && persisted?.credential.deviceSid && !authRetryUsed) {
          authRetryUsed = true;
          logger.warn(undefined, "[relay] 持久凭据被拒，丢弃 deviceSid 重新注册");
          void handleResetCredential();
          return;
        }
        errorCode = code;
        errorMessage = message;
        applyRuntimeState("error");
        transport?.dispose();
        transport = null;
        unmountBridge();
      },
    });
    transport.start();
  }

  async function handleResetCredential(): Promise<void> {
    const current = await ensureReady();
    const fresh = createRelayDeviceCredential();
    await persist({
      enabled: current?.enabled ?? true,
      credential: fresh,
    });
    if (persisted?.enabled) startTransport(fresh);
    else applyRuntimeState("disabled");
  }

  const service: IWebRemoteControlRelayService = {
    async getStatus(): Promise<WebRemoteControlRelayStatus> {
      const current = await ensureReady();
      if (!current?.enabled) {
        return { enabled: false, state: "disabled" };
      }
      return {
        enabled: true,
        state: runtimeState,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };
    },

    async getPairingInfo() {
      const current = await ensureReady();
      if (!current?.enabled) return null;
      const sid = current.credential.deviceSid;
      if (!sid) return null;
      return {
        qrUrl: buildRelayPairingQrUrl({
          deviceSid: sid,
          passHash: current.credential.passHash,
          deviceMid: current.credential.deviceMid,
          deviceName,
          appVersion,
        }),
        deviceName,
      };
    },

    async setEnabled(enabled: boolean): Promise<WebRemoteControlRelayStatus> {
      const current = await ensureReady();
      if (enabled) {
        if (current?.enabled && transport) {
          return service.getStatus();
        }
        const credential = current?.credential ?? createRelayDeviceCredential();
        await persist({ enabled: true, credential });
        startTransport(credential);
        logger.info(undefined, "[relay] 官方中转远控已开启", { relayWsUrl });
      } else {
        if (current && current.enabled) {
          await persist({ ...current, enabled: false });
        }
        transport?.dispose();
        transport = null;
        unmountBridge();
        applyRuntimeState("disabled");
        logger.info(undefined, "[relay] 官方中转远控已关闭");
      }
      return service.getStatus();
    },

    async resetPairing(): Promise<WebRemoteControlRelayStatus> {
      await handleResetCredential();
      return service.getStatus();
    },
  };

  // server 重启后按持久化意图自动恢复连接；不阻塞服务注册本身。
  void ensureReady()
    .then((current) => {
      if (current?.enabled) startTransport(current.credential);
    })
    .catch((error: unknown) => {
      logger.warn(undefined, "[relay] 启动恢复失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  return service;
}
