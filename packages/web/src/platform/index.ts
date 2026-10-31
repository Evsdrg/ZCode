import {
  mobilePluginDiscoveryTelemetrySchema,
  sessionCreateTelemetrySchema,
  type IPlatformService,
  type RemoteTarget,
  type WebRemoteControlContext,
  type WebRemoteControlStartOperationResult,
  type WebRemoteControlStatus,
} from "@zcode/shared";
import {
  mapRelayStateToStatusKind,
  playTaskNotificationSound,
  projectRelayStatusToWebRemoteControlStatus,
} from "@zcode/ui";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "#src/communityUrl.js";
import { createWebTaskNotificationState, showWebTaskNotification } from "#src/webTaskNotification.js";
import type {
  RelayStatusSource,
  WebHostNativeService,
  WebManagedBrowserMaintenance,
  WebMcpDirectoryService,
  WebRemoteControlPlatformProxy,
} from "#src/platform/contract.js";
import { saveBrowserFile } from "#src/platform/saveBrowserFile.js";

export type {
  RelayStatusSource,
  WebHostNativeService,
  WebManagedBrowserMaintenance,
  WebMcpDirectoryService,
  WebRemoteControlPlatformProxy,
} from "#src/platform/contract.js";
export { saveBrowserFile } from "#src/platform/saveBrowserFile.js";

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

/**
 * 把自部署 server 的 relay 服务投影成官方 dialog 期望的 status 契约。
 *
 * 官方 dialog 的 platform 方法只有 Electron 桌面实现了原生链路；自部署侧用
 * IWebRemoteControlRelayService 连同一个 zcode.z.ai 中转，字段与枚举名不同，
 * 故经 projectRelayStatusToWebRemoteControlStatus 做纯投影（映射规则与单测在该模块）。
 */
async function buildRelayWebRemoteControlStatus(
  source: RelayStatusSource,
  context: WebRemoteControlContext,
): Promise<WebRemoteControlStatus> {
  const [relayStatus, pairing] = await Promise.all([source.getStatus(), source.getPairingInfo()]);
  return projectRelayStatusToWebRemoteControlStatus({
    relayStatus,
    pairing,
    workspacePath: context.workspacePath,
    ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
    ...(pairing?.deviceSid ? { windowControlSessionId: pairing.deviceSid } : {}),
  });
}

/**
 * start 的返回契约比 status 更严（`status` 只允许 running|connecting|active，
 * 且 sessionId/qrUrl/connectUrl 必填）。relay 刚开启时可能仍在 connecting，
 * 此时按官方语义回 `running`（等待手机扫码）并带上二维码。
 */
async function buildRelayWebRemoteControlStartResult(
  source: RelayStatusSource,
  context: WebRemoteControlContext,
): Promise<WebRemoteControlStartOperationResult> {
  const [relayStatus, pairing] = await Promise.all([source.getStatus(), source.getPairingInfo()]);
  const kind = mapRelayStateToStatusKind(relayStatus.state);
  // idle/error 不该出现在 start 之后；退回 running 以免把错误态塞进 start 结果。
  const status = kind === "active" ? "active" : kind === "starting" ? "connecting" : "running";
  if (!pairing) {
    throw new Error(
      relayStatus.errorMessage ?? "Web remote control relay is not ready to pair yet",
    );
  }
  return {
    status,
    sessionId: pairing.deviceSid,
    windowControlSessionId: pairing.deviceSid,
    qrUrl: pairing.qrUrl,
    connectUrl: pairing.qrUrl,
    workspacePath: context.workspacePath,
    ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
  };
}

export function createWebPlatform(options?: {
  externalWebRemoteControlProxy?: WebRemoteControlPlatformProxy;
  /** 自部署 server 注册的官方中转远控服务；未注册（如桌面 host）时为 undefined。 */
  relayStatusSource?: RelayStatusSource;
  /** 自部署：托管浏览器数据清理服务；桌面/未开启托管浏览器的 host 不提供。 */
  managedBrowserMaintenance?: WebManagedBrowserMaintenance;
  /**
   * 自部署：server 侧 MCP 目录服务。
   * desktop attachment 缺席时作为 loadMcpFromUserDirectory/saveMcpToUserDirectory 的
   * 回退——本地 workspace 在 mcpStore 里恒走 platform 路径（resolveMcpDirectoryService
   * 对无 identity 的 workspace 返回 null），没有回退时设置页会把用户级 MCP 静默显示成空。
   */
  mcpDirectoryService?: WebMcpDirectoryService;
  /**
   * 自部署：server 侧 host-native 平台服务。
   *
   * 自部署 server 与用户同机同会话，「打开本机文件管理器 / 用本机编辑器打开 / 临时文本附件 /
   * 产物落地」这类操作与 Electron 无关，可真实执行。未提供时（手机远控等形态）保持原有
   * 失败桩/缺席语义。
   */
  hostNativeService?: WebHostNativeService;
}): IPlatformService {
  const platformProxy = options?.externalWebRemoteControlProxy;
  const relayStatusSource = options?.relayStatusSource;
  const managedBrowserMaintenance = options?.managedBrowserMaintenance;
  const mcpDirectoryService = options?.mcpDirectoryService;
  const hostNativeService = options?.hostNativeService;
  /** 有 host-native 服务时才真正具备「打开本机文件」的能力。 */
  const canOpenHostNativeFiles = hostNativeService !== undefined;
  // 官方契约里 start/getStatus 都要回填目标 workspace（对话框靠它判定「同一目标」）。
  // 桌面端按窗口持有 target；这里按「最后一次 start 收到的 context」记录，
  // getStatus 用它投影，语义与桌面按窗口一致（自部署是 server 级单实例）。
  let webRemoteControlTarget: WebRemoteControlContext | null = null;
  // 跨调用的通知权限请求状态：避免每次任务通知都重复请求权限。
  const webTaskNotificationState = createWebTaskNotificationState();

  return {
    canSelectFilePath: false,
    // 自部署：server 就是宿主，可真的打开本机文件/编辑器；手机远控等无 host-native 形态仍为 false。
    canOpenLocalFiles: canOpenHostNativeFiles,
    // 自部署托管浏览器在 UI 侧能否配证书策略：server 注册了托管浏览器维护服务（clearAllData）
    // 即说明存在托管浏览器。手机远控/无托管浏览器形态不声明，设置项不展示。
    ...(managedBrowserMaintenance
      ? { canConfigureManagedBrowserCertificates: true }
      : {}),
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: (payload) => {
      if (platformProxy) {
        return platformProxy.requestPlatformMethod("createTempTextAttachment", payload);
      }
      // 自部署：server 进程直接写本机临时目录，语义与桌面端一致（原先恒 reject，
      // 导致 WebUI 粘贴 ≥15 KiB 文本必然报「读取失败」）。
      if (hostNativeService) {
        return hostNativeService.createTempTextAttachment(payload);
      }
      return Promise.reject(new Error("Temporary text attachments require a desktop host"));
    },
    // 可选方法：只有自部署 host-native 形态提供，手机远控/普通 Web 缺席即不出入口。
    ...(hostNativeService
      ? {
          materializeWorkflowArtifactFile: (payload: {
            runId: string;
            artifactId: string;
            version: number;
            fileName: string;
            bytes: Uint8Array;
          }) => hostNativeService.materializeWorkflowArtifactFile(payload),
        }
      : {}),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // Bugfix: Web 远程控制模式虽然复用了 web UI，但它背后其实挂着 desktop。
    // 之前这里仍然走普通 web 的 `/api/connect-remote`，既不能命中 desktop main，
    // 也拿不到 remote session 的 MessagePort，结果看起来像"支持"，实际必然失败。
    // 先显式拒绝，避免用户沿着错误链路继续排查；后续如果要支持，需要单独补 remote session 注入协议。
    async connectRemote(
      options: RemoteTarget,
      _requestId?: string,
      _context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      },
    ) {
      if (platformProxy) {
        return {
          success: false,
          error: `Remote connect is not supported in Web remote control mode yet: ${options.kind}`,
        };
      }

      // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
      // 之前这里虽然能打开 ?remote=<id> 新标签页，但远程 WebSocket 只暴露部分 service，
      // 与 Root/RemoteServiceAccess 需要的完整 accessor 不匹配，最终会在项目向导或首屏卡住。
      return {
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      };
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // Web 端不作为 Web 远程控制的发起端，保留空实现以兼容统一接口。
    // 原生远控的发起端只有 Electron 桌面；自部署 server 侧不具备该能力，因此这三个方法
    // 把自部署实际拥有的「官方中转远控」服务（IWebRemoteControlRelayService，经 relay 连
    // 同一个 zcode.z.ai 中转）投影成官方 dialog 期望的契约，让同一张卡片可直接使用。
    // 未注册 relay 服务时（桌面 host / 未开启）退回 idle，卡片按"不可用"呈现。
    startWebRemoteControl: async (context) => {
      const source = relayStatusSource;
      if (!source) {
        return Promise.reject(new Error("Web remote control can only be started from desktop"));
      }
      // 记下目标 workspace：后续 getStatus 用它回填，保证对话框判定为「同一目标」。
      webRemoteControlTarget = context;
      // 与官方一致：start 即开启中转远控。
      await source.setEnabled(true);
      return buildRelayWebRemoteControlStartResult(source, context);
    },
    stopWebRemoteControl: async () => {
      await relayStatusSource?.setEnabled(false);
    },
    getWebRemoteControlStatus: async () => {
      const source = relayStatusSource;
      if (!source) {
        return { status: "idle" } satisfies WebRemoteControlStatus;
      }
      // 未 start 过时无目标上下文，退回空 workspacePath（对话框会据此触发一次 start）。
      return buildRelayWebRemoteControlStatus(
        source,
        webRemoteControlTarget ?? { workspacePath: "" },
      );
    },
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("isDockerAvailable")
        : (hostNativeService?.isDockerAvailable() ?? Promise.resolve(false)),
    listWSLDistros: () =>
      platformProxy ? platformProxy.requestPlatformMethod("listWSLDistros") : Promise.resolve([]),
    listDockerContainers: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listDockerContainers")
        : (hostNativeService?.listDockerContainers() ?? Promise.resolve([])),
    listSSHConfigAliases: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listSSHConfigAliases")
        : (hostNativeService?.listSSHConfigAliases() ?? Promise.resolve([])),
    loadMcpFromUserDirectory: (payload) => {
      if (platformProxy) {
        return platformProxy.requestPlatformMethod("loadMcpFromUserDirectory", payload);
      }
      // 自部署无 desktop attachment：回退 server RPC，不静默假装空列表。
      return mcpDirectoryService
        ? mcpDirectoryService.loadMcpFromUserDirectory(payload)
        : Promise.resolve({ servers: [] });
    },
    saveMcpToUserDirectory: (payload) => {
      if (platformProxy) {
        return platformProxy.requestPlatformMethod("saveMcpToUserDirectory", payload);
      }
      return mcpDirectoryService
        ? mcpDirectoryService
            .saveMcpToUserDirectory(payload)
            .then(() => ({ success: true as const }))
        : Promise.resolve({
            success: false,
            error: "MCP native directory management requires a desktop attachment",
          });
    },
    migrateLegacyCommonMcp: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("migrateLegacyCommonMcp", payload)
        : Promise.resolve({
            servers: {},
            totalCount: 0,
            importedCount: 0,
            skippedCount: 0,
          }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    // 手机远控（platformProxy）不转发该方法：WebRemoteControlPlatformMethodResultMap 里没有它，
    // 说明远控协议本来就不提供本机文件管理能力；自部署形态才走 host-native。
    openInFileManager: (path) =>
      platformProxy
        ? Promise.resolve({ success: false, error: "Not supported in web mode" })
        : (hostNativeService?.openInFileManager(path) ??
          Promise.resolve({ success: false, error: "Not supported in web mode" })),
    // 原因：openExternalFile 也是**可选**方法（接口注释：普通 Web 平台返回 unsupported，缺席即不支持）。
    // 提供失败桩会让 `platform.openExternalFile !== undefined` / 真值判断误以为能力存在，
    // 使 OpenSplitButton 的「用默认应用打开」与外部链接分支走到必然失败的路径。
    // 删除后这些分支自然回退到 openExternal（浏览器新标签）。
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async (event) => {
      // 手机只开放 session_create 和插件发现事件；管理结果仍由 Desktop Host 唯一上报。
      const parsed = sessionCreateTelemetrySchema
        .or(mobilePluginDiscoveryTelemetrySchema)
        .safeParse(event);
      if (parsed.success) platformProxy?.reportTelemetryEvent?.(parsed.data);
    },
    reportArmsCustomEvent: () => Promise.resolve(),
    // 自部署「清理浏览器数据」：托管浏览器没有桌面 Chrome profile，语义是关闭全部
    // 会话与浏览器进程（context 销毁即清除 cookie/存储），下次命令按需重启。
    clearEmbeddedBrowserData: async () => {
      try {
        return (
          (await managedBrowserMaintenance?.clearAllData()) ?? {
            success: false,
            error: "managed browser maintenance is unavailable",
          }
        );
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    showTaskNotification: (payload) => {
      showWebTaskNotification(
        {
          notification:
            typeof window.Notification === "undefined" ? undefined : window.Notification,
          hasFocus: () => document.hasFocus(),
          onShown: () => {
            void playTaskNotificationSound();
          },
        },
        payload,
        webTaskNotificationState,
      );
    },
    requestNotificationPermission: async () => {
      const Ctor = typeof window.Notification === "undefined" ? undefined : window.Notification;
      if (!Ctor) return false;
      if (Ctor.permission === "granted") return true;
      if (Ctor.permission === "denied") return false;
      try {
        // 必须在用户手势中调用（如设置页开启通知开关），否则浏览器会忽略请求。
        const result = await Ctor.requestPermission();
        return result === "granted";
      } catch {
        return false;
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    // 原因：importChromeBrowserData 是 IPlatformService 的**可选**方法，按接口约定「缺席即不支持」。
    // 之前这里提供了恒返回 chrome_import_not_supported 的失败桩，使 UI 的
    // `typeof platform.importChromeBrowserData === "function"` 能力判定恒为真，
    // 浏览器里会渲染一个点了必然失败的「导入浏览器数据」按钮。可选方法不实现就不要写桩。
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: (filePath?: string) =>
      platformProxy
        ? Promise.resolve([])
        : (hostNativeService?.getInstalledEditors(filePath) ?? Promise.resolve([])),
    openInEditor: (editorId, path) =>
      platformProxy
        ? Promise.resolve({ success: false, error: "Not supported in web mode" })
        : (hostNativeService?.openInEditor(editorId, path) ??
          Promise.resolve({ success: false, error: "Not supported in web mode" })),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    // 自部署「另存为」：Web 端把字节交给浏览器下载（见 saveBrowserFile 的语义说明）。
    // 桌面端由 Electron main 走原生另存为对话框，两者共用同一契约。
    saveFile: saveBrowserFile,
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}
