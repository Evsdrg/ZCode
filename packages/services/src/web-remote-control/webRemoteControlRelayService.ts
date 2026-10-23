import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ZCODE_VERSION,
  buildWebRemoteControlExternalQrUrl,
  resolveWebRemoteControlRelayWsUrl,
  type PersistedWorkspaceSessionEntry,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { ISettingService } from "../setting/setting.js";
import { basename } from "node:path";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ServiceCollection } from "../collection.js";
import {
  createTelemetryAuthorizationLoader,
  createTelemetryUserIdLoader,
} from "../telemetry/telemetryAccountLoaders.js";
// transport 使用下沉自桌面官方 V2 的实现（3.16.2）：握手改为账号 JWT 换 token，
// 配对状态由 pair_status 驱动；协议与重连/心跳状态机保持官方原样。
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportState,
  type WebRemoteControlRelaySocketCtor,
} from "./relayDeviceTransportV2.js";
import { createWebRemoteControlV2Http } from "./relayDeviceHttpV2.js";
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
 * 官方中转远程控制服务实现（V2）。
 *
 * 状态唯一所有者：本实例持有 transport、bridge 与持久化意图（enabled + deviceMid）。
 * V2 鉴权：复用桌面同款只读账号入口（telemetryAccountLoaders）读取 z.ai 登录 JWT，
 * 经官方 HTTP register/token 换取 deviceSid 与一次性 WS token；不再使用 V1 passHash 配对。
 * deviceSid 官方存在 AppSettings.webRemoteControlRelayV2Device；enabled/deviceMid 由
 * credentialService 持久化（沿用旧 key，自动迁移旧 deviceMid，二维码随新 sid 更新）。
 */

const STATE_STORAGE_KEY = "web-remote-control:relay-device-state";
const DEFAULT_REMOTE_URL = "https://zcode.z.ai/remote/v4";

interface PersistedRelayState {
  enabled: boolean;
  deviceMid: string;
}

export interface CreateWebRemoteControlRelayServiceOptions {
  credentialService: ICredentialService;
  /** 数据面在 paired 时才挂载；注册链求值期 services 尚未建好，必须经 getter 注入。 */
  resolveServices: () => ServiceCollection;
  relayWsUrl?: string;
  /** 官方手机端入口（二维码 baseUrl）；缺省用官方默认。 */
  remoteUrl?: string;
  deviceName?: string;
  appVersion?: string;
  webSocketCtor?: WebRemoteControlRelaySocketCtor;
  /** 测试注入 HTTP fetch；缺省用 Node fetch（官方 http 客户端同约定）。 */
  httpFetcher?: typeof fetch;
}

export function createWebRemoteControlRelayService(
  options: CreateWebRemoteControlRelayServiceOptions,
): IWebRemoteControlRelayService {
  const logger = createServiceLogger("web-remote-control");
  // transport 下沉自桌面，其 logger 契约是 (message, ...args)；ServiceLogger 是
  // (traceId, message, ...args)。这里补一层适配，避免改动官方 transport 的调用点。
  const transportLogger = {
    info: (...args: unknown[]) => logger.info(undefined, ...args),
    warn: (...args: unknown[]) => logger.warn(undefined, ...args),
    error: (...args: unknown[]) => logger.error(undefined, ...args),
  };
  const relayWsUrl = options.relayWsUrl ?? resolveWebRemoteControlRelayWsUrl();
  const remoteUrl = options.remoteUrl ?? DEFAULT_REMOTE_URL;
  const endpointOrigin = new URL(remoteUrl).origin;
  const deviceName = options.deviceName ?? hostname();
  const appVersion = options.appVersion ?? ZCODE_VERSION;
  const http = createWebRemoteControlV2Http(endpointOrigin, options.httpFetcher ?? fetch);
  // 与桌面同款：只读账号入口，不触发 host OAuth 登出；JWT 换 WS token 由官方 HTTP 完成。
  const loadUserId = createTelemetryUserIdLoader(options.credentialService);
  const loadAuthorization = createTelemetryAuthorizationLoader(options.credentialService);

  let persisted: PersistedRelayState | null = null;
  let readyPromise: Promise<void> | null = null;
  let transport: WebRemoteControlDeviceTransport | null = null;
  let bridge: RelayBridgeChannel | null = null;
  let runtimeState: WebRemoteControlRelayState = "disabled";
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let currentDeviceSid: string | undefined;

  async function ensureReady(): Promise<PersistedRelayState | null> {
    if (!readyPromise) {
      readyPromise = (async () => {
        const raw = await options.credentialService.load(STATE_STORAGE_KEY);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as
            | (PersistedRelayState & { credential?: { deviceMid?: string } })
            | null;
          // 迁移：V1 持久化里 deviceMid 在 credential 内；enabled/deviceMid 语义不变。
          const deviceMid = parsed?.deviceMid ?? parsed?.credential?.deviceMid;
          if (parsed && typeof parsed.enabled === "boolean" && deviceMid) {
            persisted = { enabled: parsed.enabled, deviceMid };
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

  /** V2 官方存储位：AppSettings.webRemoteControlRelayV2Device（与桌面同字段，可互通）。 */
  async function loadStoredDeviceSid(): Promise<string | undefined> {
    const services = options.resolveServices();
    const settingService = services.getOptional(ISettingService);
    if (!settingService) return undefined;
    try {
      return (await settingService.get()).webRemoteControlRelayV2Device?.deviceSid;
    } catch {
      return undefined;
    }
  }

  async function saveStoredDeviceSid(deviceSid: string): Promise<void> {
    const services = options.resolveServices();
    const settingService = services.getOptional(ISettingService);
    if (!settingService) return;
    try {
      // 官方 schema 要求 userId/endpointOrigin（换账号/换环境时便于失效清理）。
      const { userId } = await requireLogin();
      await settingService.update({
        webRemoteControlRelayV2Device: { deviceSid, userId, endpointOrigin },
      });
    } catch (error) {
      logger.warn(undefined, "[relay] deviceSid 持久化失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 登录态读取：无登录时抛 auth-required，由 transport 记为终态错误。 */
  async function requireLogin(): Promise<{ userId: string; jwt: string }> {
    const userId = await loadUserId();
    const authorization = await loadAuthorization(userId);
    const jwt = authorization?.slice("Bearer ".length);
    if (!userId || !jwt) {
      throw new Error("relay auth-required: z.ai account login is required");
    }
    return { userId, jwt };
  }

  function mapTransportState(
    state: WebRemoteControlDeviceTransportState,
  ): WebRemoteControlRelayState {
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
      // 桥的 sendFrame 声明为 unknown（它对消息形状保持通用）；实际发出的都是
      // WebRemoteControlAppPayload 联合内的控制消息与 rpc-frame，故在此边界收窄。
      sendFrame: (payload) =>
        transport?.sendPayload(payload as WebRemoteControlAppPayload) ?? false,
      workspace: resolvePrimaryWorkspace(),
      source: createRelayWorkspaceSource({
        primaryWorkspace: resolvePrimaryWorkspace(),
        port: createWorkspaceSourcePort(),
        windowControlSessionId: currentDeviceSid ?? deviceName,
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

  function startTransport(deviceMid: string): void {
    transport?.dispose();
    unmountBridge();
    applyRuntimeState("connecting");
    transport = new WebRemoteControlDeviceTransport({
      relayWsUrl,
      deviceMid,
      meta: { platform: process.platform, version: appVersion, name: deviceName },
      logger: transportLogger,
      ...(options.webSocketCtor ? { socketCtor: options.webSocketCtor } : {}),
      // V2 鉴权：官方 HTTP 用当前登录 JWT 换一次性 WS token（15s 超时与重试由 http 层负责）。
      getToken: async (signal) => {
        const { jwt } = await requireLogin();
        const token = await http.token(jwt, signal);
        return token;
      },
      // 注册/复用 deviceSid：AUTH_FAILED 时 transport 以 forceRegistration 再调用，
      // 这里丢弃旧 sid 重新注册并落盘，语义对齐桌面 manager。
      resolveDeviceSid: async (signal, forceRegistration) => {
        if (!forceRegistration) {
          const stored = currentDeviceSid ?? (await loadStoredDeviceSid());
          if (stored) {
            currentDeviceSid = stored;
            return stored;
          }
        } else if (currentDeviceSid) {
          try {
            const { jwt } = await requireLogin();
            await http.delete(currentDeviceSid, jwt, signal);
          } catch {
            // 删除失败不阻塞重注册；服务端按 KICKED/AUTH_FAILED 收口旧 sid。
          }
        }
        const { jwt } = await requireLogin();
        const sid = await http.register(deviceMid, jwt, signal);
        currentDeviceSid = sid;
        await saveStoredDeviceSid(sid);
        return sid;
      },
      onStateChange: (state) => {
        const next = mapTransportState(state);
        // 桥的挂载/卸载是可选功能，异常只降级不冒泡：这里由 socket 事件驱动，
        // 未捕获异常会终止 server 主进程（曾实测：日志包装层缺 dispose 导致整个 WebUI 挂掉）。
        try {
          if (state === "waiting_terminal" || state === "kicked") unmountBridge();
          if (state === "paired") mountBridge();
        } catch (error) {
          logger.warn(undefined, "[relay] 桥状态切换失败（已忽略，不影响主进程）", {
            state,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        applyRuntimeState(next);
      },
      onPayload: (payload: WebRemoteControlAppPayload) => {
        if (!bridge) return;
        bridge.routePayload(payload);
      },
      // transport 会在 onPayload 之前拦下 rpc-frame / rpc-frame-ack（数据面），
      // 转交同一个桥处理并返回 true 表示已消费；未挂桥时返回 false 让它走丢帧路径。
      onRawTransportPayload: (payload) => {
        if (!bridge) return false;
        bridge.routePayload(payload);
        return true;
      },
      onError: (error) => {
        errorCode = error.message.includes("auth-required") ? "auth_required" : "relay_error";
        errorMessage = error.message;
        applyRuntimeState("error");
        transport?.dispose();
        transport = null;
        unmountBridge();
      },
    });
    transport.start();
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
      const sid = currentDeviceSid ?? (await loadStoredDeviceSid());
      if (!sid) return null;
      // V2 二维码：官方手机页 URL + sid/mid/name/app_version（不再携带 hash/t 凭据）。
      return {
        qrUrl: buildWebRemoteControlExternalQrUrl({
          baseUrl: remoteUrl,
          deviceSid: sid,
          deviceMid: current.deviceMid,
          deviceName,
          appVersion,
        }),
        deviceName,
        deviceSid: sid,
      };
    },

    async setEnabled(enabled: boolean): Promise<WebRemoteControlRelayStatus> {
      const current = await ensureReady();
      if (enabled) {
        if (current?.enabled && transport) {
          return service.getStatus();
        }
        // deviceMid 必须跨会话稳定（服务端按 mid 识别设备）；旧状态没有时生成并落盘。
        const deviceMid = current?.deviceMid ?? `zcode-server-${randomUUID()}`;
        await persist({ enabled: true, deviceMid });
        startTransport(deviceMid);
        logger.info(undefined, "[relay] 官方中转远控已开启（V2）", { relayWsUrl });
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
      // V2 语义：作废当前 deviceSid 并强制重注册，旧二维码随 sid 失效。
      const current = await ensureReady();
      const deviceMid = current?.deviceMid ?? `zcode-server-${randomUUID()}`;
      await persist({ enabled: current?.enabled ?? true, deviceMid });
      if (currentDeviceSid) {
        try {
          const { jwt } = await requireLogin();
          await http.delete(currentDeviceSid, jwt, AbortSignal.timeout(15_000));
        } catch {
          // 删除失败同样由服务端按 AUTH_FAILED 收口；不阻塞本地重置。
        }
      }
      currentDeviceSid = undefined;
      if (persisted?.enabled) startTransport(deviceMid);
      else applyRuntimeState("disabled");
      return service.getStatus();
    },
  };

  // server 重启后按持久化意图自动恢复连接；不阻塞服务注册本身。
  void ensureReady()
    .then((current) => {
      if (current?.enabled) startTransport(current.deviceMid);
    })
    .catch((error: unknown) => {
      logger.warn(undefined, "[relay] 启动恢复失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  return service;
}
