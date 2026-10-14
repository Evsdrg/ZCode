import {
  AutomationRepo,
  AutomationScheduler,
  createServerHostServices,
  createServiceLogger,
  createTopicResourcePeers,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
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
  const browserConfig = resolveHeadlessBrowserConfig(process.env);
  const browserExecutor = browserConfig
    ? createConfiguredBrowserExecutor(browserConfig)
    : undefined;
  // topic resource 中继：上游在自部署入口建立 peers 并注入服务集合与 HTTP 层。
  const topicResourcePeers = createTopicResourcePeers();
<<<<<<< HEAD
  const serverId = resolveHttpServerId();
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
      // 自部署形态的服务开关（fork）：relay 远控、全工作区任务视图、窗口 Controller、
      // 附件持久上传与托管浏览器执行器。
      selfHostOptions: {
        webRemoteControlRelay: true,
        taskListAllWorkspaces: true,
        windowController: true,
        arbitraryFileUploads: true,
        ...(browserExecutor ? { browserControlExecutor: browserExecutor } : {}),
      },
    });
=======

  // 定时任务 / 闲时任务调度：桌面形态由 Electron main fork 的 scheduler 进程承担；
  // 自部署 server 没有该进程，改为在本进程内起 AutomationScheduler，并直接派发给本进程
  // 任务域（复用与桌面同一份调度核心，见 docs/specs/selfhost-server-cron-scheduler.md）。
  const automationRepo = new AutomationRepo();
  const offPeakRepo = new OffPeakTaskRepo();
  // 派发运行时依赖 ServiceCollection；它晚于 createLocalServices 返回，用前向引用在调用期解析。
  // 「立即运行」只会发生在服务集合装配完成之后。
  let dispatchRuntime: ReturnType<typeof createServerAutomationDispatchRuntime> | undefined;

  const services = createLocalServices({
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    webRemoteControlRelay: true,
    // 自部署语义：WebUI 可见本机全部工作区的任务（含「不在项目中工作」），
    // 而非仅 ZCODE_SERVER_WORKSPACE 单工作区切片。
    taskListAllWorkspaces: true,
    // 桌面 Host 自带窗口 Controller；自部署 server 缺它会让 WebUI 的时间线/置顶/归档/
    // 命令面板等全局任务列表（useGlobalTaskList）恒空——侧栏「任务」分区看不到会话任务。
    windowController: true,
    arbitraryFileUploads: true,
    // 「立即运行」在自部署形态下由本进程直接派发；缺失该 dispatcher 会让 runAutomationNow 抛错。
    onAutomationManualRunRequested: (params) => {
      if (!dispatchRuntime) {
        return Promise.reject(new Error("Automation dispatch runtime is not initialized."));
      }
      return dispatchRuntime.dispatchManualRun(params);
    },
    ...(browserExecutor ? { browserControlExecutor: browserExecutor } : {}),
  });
>>>>>>> de8b8f77 (feat(scheduler): 自部署 server 接入定时/闲时任务调度)

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
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
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
