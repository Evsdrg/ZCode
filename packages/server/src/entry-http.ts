import {
  AutomationRepo,
  AutomationScheduler,
  createLocalServices,
  createServiceLogger,
  createSettingServiceWithMigrations,
  createTopicResourcePeers,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
  migrateApplicationStorage,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import { formatLogPrefix } from "@zcode/shared";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";
import { createConfiguredBrowserExecutor } from "./browser/managedBrowserRouter.js";
import { resolveHeadlessBrowserConfig } from "./browser/headlessBrowserConfig.js";
import { createServerAutomationDispatchRuntime } from "./automationDispatch.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // 设置权威实例先建：托管浏览器需要在每个 Playwright Context 上读取「允许不安全证书」
  // （桌面端由 Electron main 装到 Session，自部署没有 Electron）。与 Desktop Host 一致，
  // 显式注入同一个 settingService 并把迁移钩子一并透传，避免出现两套写队列分叉。
  const {
    service: settingService,
    prepareLegacyAccountConnections,
    setWorkspaceProjection,
  } = createSettingServiceWithMigrations();
  const resolveIgnoreHTTPSErrors = async (): Promise<boolean> =>
    (await settingService.get()).embeddedBrowserAllowInsecureCertificates === true;
  const browserConfig = resolveHeadlessBrowserConfig(process.env);
  const browserExecutor = browserConfig
    ? createConfiguredBrowserExecutor(browserConfig, undefined, { resolveIgnoreHTTPSErrors })
    : undefined;
  // topic resource 中继：上游在自部署入口建立 peers 并注入服务集合与 HTTP 层。
  const topicResourcePeers = createTopicResourcePeers();
  // 定时任务 / 闲时任务调度：桌面形态由 Electron main fork 的 scheduler 进程承担；
  // 自部署 server 没有该进程，改为在本进程内起 AutomationScheduler，并直接派发给本进程
  // 任务域（复用与桌面同一份调度核心，见 docs/specs/selfhost-server-cron-scheduler.md）。
  const automationRepo = new AutomationRepo();
  const offPeakRepo = new OffPeakTaskRepo();
  // 派发运行时依赖 ServiceCollection；它晚于 createLocalServices 返回，用前向引用在
  // 调用期解析。「立即运行」只会发生在服务集合装配完成之后。
  let dispatchRuntime: ReturnType<typeof createServerAutomationDispatchRuntime> | undefined;

  const serverId = resolveHttpServerId();
  // 先串行预热迁移：AutomationRepo / OffPeakTaskRepo / TaskIndexRepo 各自懒加载时，会分别用独立
  // 连接对同一个 tasks-index.sqlite 跑迁移（含备份，持写锁数秒）；若被 AutomationScheduler 与其它
  // service 同时触发，后到者会撞 busy_timeout 报 `database is locked`，启动失败。上游
  // createServerHostServices 内部就是这么先 migrateApplicationStorage 再装配的。这里走 local 语义
  //（hostId 省略），与 Electron Local Host 一致；迁移完成后各 repo 的 ensureReady 会直接快速返回。
  await migrateApplicationStorage(await settingService.get());
  // 自部署 WebUI 只是把 Electron 的 WebUI 拆到浏览器：服务与数据语义必须与 Electron Local Host
  // 完全一致。这里沿用 v3.14.3/v3.15.1 的 createLocalServices（宿主身份 = local），
  // 不采用上游 3.16 的 createServerHostServices（它把 projectStorageHostId 设为
  // remote:server:<id>，导致任务/项目归到远端 host、发消息报 project.host-offline）。
  // fork 需要的服务开关照常透传。
  const services = createLocalServices({
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    settingService,
    setWorkspaceProjection,
    prepareLegacyAccountConnections,
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    // 自部署形态的服务开关（fork）：relay 远控、全工作区任务视图、窗口 Controller、
    // 附件持久上传、托管浏览器执行器与手动调度派发。
    webRemoteControlRelay: true,
    // 自部署语义：WebUI 可见本机全部工作区的任务（含「不在项目中工作」）。
    taskListAllWorkspaces: true,
    // 桌面 Host 自带窗口 Controller；自部署缺它会让全局任务列表（useGlobalTaskList）恒空。
    windowController: true,
    arbitraryFileUploads: true,
    // 自部署 server 与用户同机同会话：「打开本机文件管理器 / 用本机编辑器打开 / 临时文本附件 /
    // 产物落地」与 Electron 无关，由本进程直接执行（见 docs/specs/selfhost-host-native-platform-service.md）。
    hostNative: true,
    // 「立即运行」在自部署形态下由本进程直接派发；缺失该 dispatcher 会让 runAutomationNow 抛错。
    onAutomationManualRunRequested: (params) => {
      if (!dispatchRuntime) {
        return Promise.reject(new Error("Automation dispatch runtime is not initialized."));
      }
      return dispatchRuntime.dispatchManualRun(params);
    },
    ...(browserExecutor ? { browserControlExecutor: browserExecutor } : {}),
  });

  const automationSchedulerLogger = createServiceLogger("automation-scheduler");
  dispatchRuntime = createServerAutomationDispatchRuntime({
    services,
    automationRepo,
    offPeakRepo,
    logger: {
      info: (message) => automationSchedulerLogger.info(undefined, message),
      warn: (message, error) => automationSchedulerLogger.warn(undefined, message, error),
      error: (message, error) => automationSchedulerLogger.error(undefined, message, error),
    },
  });
  const automationScheduler = new AutomationScheduler({
    automationRepo,
    offPeakRepo,
    recoverInterruptedOnStart: true,
    log: (level, message) => automationSchedulerLogger[level](undefined, message),
    dispatch: dispatchRuntime.port,
  });
  await automationScheduler.start();

  const server = createHttpServer(services, port, {
    serverId,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    // 本进程已注册 host-native 服务（见上方 createLocalServices 的 hostNative: true）。
    hostNative: true,
  });

  // 优雅关闭：systemd stop/restart 发 SIGTERM。此前没有任何信号处理，进程被默认
  // 处置直接终止——agent 进程树来不及 graceful+force 清理（产生孤儿 zcode-cli）、
  // sqlite 句柄不关闭、托管浏览器不回收。照 entry-stdio 的同一契约：
  // 先停止接新连接，再等 disposeServiceResourcesAndWait 完成异步回收，最后退出。
  let shuttingDown = false;
  const log = (...args: unknown[]) =>
    console.error(formatLogPrefix("zcode-server:http", process.pid), ...args);
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    server.close(() => log("http server closed"));
    // 兜底：清理超过 20s 未完成则硬退（systemd 的 SIGKILL 更晚且更粗暴）。
    const forceTimer = setTimeout(() => {
      log("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 20_000);
    void (async () => {
      // 先停调度轮询并释放本进程在途认领，避免下次启动等 CLAIM_STALE 才回收。
      await automationScheduler.dispose();
      dispatchRuntime?.dispose();
      await disposeServiceResourcesAndWait(services);
      await browserExecutor?.shutdown().catch(() => {});
      clearTimeout(forceTimer);
      log("shutdown complete");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
