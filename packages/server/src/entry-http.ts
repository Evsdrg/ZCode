import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
} from "@zcode/services/node";
import { formatLogPrefix } from "@zcode/shared";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";
import { createHeadlessChromiumExecutor } from "./browser/headlessChromiumExecutor.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // Browser Use：自部署形态默认关闭。显式 ZCODE_SERVER_BROWSER_USE=headless 时注册托管
  // headless Chromium 执行器，让 agent 的 interaction/browserExecute 反向请求有真实后端。
  const browserExecutor =
    process.env["ZCODE_SERVER_BROWSER_USE"]?.trim() === "headless"
      ? createHeadlessChromiumExecutor({
          // Playwright 缓存里的浏览器修订会被其它工具升/降级；显式路径固定本机
          // 实际存在的二进制，避免版本漂移导致执行器静默失联。
          executablePath: process.env["ZCODE_SERVER_BROWSER_EXECUTABLE"]?.trim() || undefined,
        })
      : undefined;
  const services = createLocalServices({
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
    ...(browserExecutor ? { browserControlExecutor: browserExecutor } : {}),
  });

  const server = createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  // 优雅关闭：systemd stop/restart 发 SIGTERM。此前没有任何信号处理，进程被默认
  // 处置直接终止——agent 进程树来不及 graceful+force 清理（产生孤儿 zcode-cli）、
  // sqlite 句柄不关闭、Browser Use 的 Chromium 不回收。照 entry-stdio 的同一契约：
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
