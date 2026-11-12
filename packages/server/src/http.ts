/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { resolveServerOsUser } from "@zcode/shared/node";
import * as nodePath from "node:path";
import { basename, extname, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { TopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IBotsService,
  IProviderProvisioningTargetService,
  IFileService,
} from "@zcode/services";
import {
  botProviders,
  formatLogPrefix,
  serverRemoteInfoOutputSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import {
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import {
  SERVER_MEDIA_PREVIEW_ROUTE,
  parseMediaByteRange,
  type MediaPreviewLeaseStore,
} from "@zcode/services/node";
import { createHostCapabilityStore } from "./hostCapability.js";
import { startWebSocketHeartbeat } from "./webSocketHeartbeat.js";
import {
  STATIC_ASSET_COMPRESSION_MIN_BYTES,
  compressStaticAsset,
  selectStaticAssetEncoding,
} from "./staticAssetCompression.js";
import {
  ZCodeEndpointProxyError,
  type createZCodeEndpointProxy,
} from "./zcodeEndpointProxy.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const loggedServer = new LoggingChannelServer(rawServer, log);
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(peer ? peer.wrapAgent(agentService) : agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  // 浏览器 /ws 是唯一没有应用层保活的长连接：空闲期（模型静默思考、长工具执行）可能被
  // 中间有状态设备掐断，半开连接 TCP 感知不到。用 WS Ping/Pong 保活 + 判定半死连接。
  // 只给 web-remote-replayable（浏览器）加；desktop-continuous（/ws/host）保持原行为。
  const heartbeat =
    clientMode === "web-remote-replayable"
      ? startWebSocketHeartbeat({
          socket: ws,
          onTimeout: (idleMs) => log("ws heartbeat timeout, terminating", idleMs),
        })
      : undefined;
  socket.onClose(() => {
    heartbeat?.dispose();
    peer?.dispose();
    reverseClient?.dispose();
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

export interface HttpServerOptions {
  topicResourcePeers?: TopicResourcePeers;
  serverId?: string;
  virtualProjects?: boolean;
  migrationFailedPathCount?: number;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
  /** 自部署：本进程注册了 host-native 平台服务，server-info.capabilities 据此声明能力。 */
  hostNative?: boolean;
  /**
   * 自部署：浏览器侧发往 ZCode endpoint 的固定路径反代。
   * 普通浏览器没有 Electron main 的 net.fetch，直接连 zcode.z.ai 会被 Origin 白名单 403。
   */
  zcodeEndpointProxy?: ReturnType<typeof createZCodeEndpointProxy>;
  /**
   * 自部署：本地媒体预览的路径授权表。提供后启用 `/api/media/preview` 路由，
   * 让 `IMediaPreviewService.prepare()` 返回 `local-url`（支持 Range），
   * 而不是 8MB 上限的 base64 内联。缺省则不注册该路由（桌面 Host 走 Electron 协议）。
   */
  mediaPreviewLeaseStore?: MediaPreviewLeaseStore;
  /**
   * 自部署：日志导出服务。提供后启用 `/api/logs/export`：服务端打包 zip 并直接作为
   * 下载响应回给浏览器（桌面端用 Electron shell 打开文件管理器，浏览器只能用下载）。
   */
  logExportService?: {
    export(): Promise<{
      success: boolean;
      fileName?: string;
      bytes?: Uint8Array;
      format?: "zip" | "directory";
      path?: string;
      error?: string;
    }>;
  };
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveHttpServerId(options: HttpServerOptions = {}): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return serverRemoteInfoOutputSchema.parse({
    serverId: resolveHttpServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    // 宿主进程平台：自部署 WebUI 据此判定本机桌面能力（浏览器 UA 无法反映宿主）。
    hostPlatform: process.platform,
    workspaces: resolveServerWorkspaces(options),
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: resolveServerOsUser(), hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      ...(options.virtualProjects ? { virtualProjects: true } : {}),
      processResourceTelemetry: true,
      ...(options.hostNative ? { hostNative: true as const } : {}),
      ...(options.logExportService ? { logExport: true as const } : {}),
      remoteConversationTelemetry: true,
    },
  });
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    authorization.slice("Bearer ".length).trim() === token
  ) {
    return true;
  }
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

// 盘符路径（"Z:/x"、"Z:\x"、"Z:x"）在 Windows 的 path.resolve 下会被当作绝对/盘符相对
// 路径解析到另一块盘（含 subst 虚拟盘与映射的网络盘），一律拒绝，不做静态资源解析。
const DRIVE_QUALIFIED_PATH_PATTERN = /^[a-zA-Z]:/;

export function isPathDriveQualified(pathname: string): boolean {
  return DRIVE_QUALIFIED_PATH_PATTERN.test(pathname);
}

// pathApi 可注入便于跨平台测试。Windows 跨盘时 path.relative 返回的是绝对路径（如
// "Z:\marker.txt"），不以 ".." 开头，曾因此被误判为「在静态根内」导致越盘读取；
// relative 结果为绝对路径的一律视为越界，posix 语义不受影响。
export function isInsideDirectory(
  root: string,
  candidate: string,
  pathApi: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const diff = pathApi.relative(root, candidate);
  if (pathApi.isAbsolute(diff)) return false;
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${pathApi.sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  // 盘符路径必须在 resolve 之前拦截（含 %3A 解码后的形式），否则 Windows 上会解析到
  // 静态根所在盘之外的路径；直接 404，也不进入 SPA fallback。
  if (isPathDriveQualified(relativePath)) {
    return null;
  }
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 自部署本地媒体预览：浏览器直接 <video>/<audio> 请求这个同源路由（带部署鉴权 Cookie）。
  // 授权只认 mediaPreviewLeaseStore 中已登记的规范化绝对路径——URL 里的 path 不构成授权。
  // 支持单区间 Range：音视频 seek / MP4 moov 位于 mdat 之后时的元数据探测都依赖 206。
  if (options.mediaPreviewLeaseStore) {
    const leaseStore = options.mediaPreviewLeaseStore;
    app.get(SERVER_MEDIA_PREVIEW_ROUTE, async (c) => {
      const requestedPath = new URL(c.req.url).searchParams.get("path");
      if (!requestedPath) {
        return c.json({ error: "Missing media path" }, 400);
      }
      const resolved = await leaseStore.resolve(requestedPath);
      if (!resolved) {
        return c.json({ error: "Media preview not authorized" }, 404);
      }
      const fileService = services.getOptional(IFileService);
      if (!fileService) {
        return c.json({ error: "File service unavailable" }, 503);
      }
      const size = resolved.size;
      const range = parseMediaByteRange(c.req.header("range"), size);
      if (range === "invalid") {
        return c.body(null, 416, { "Content-Range": `bytes */${size}` });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, size - 1);
      const length = size === 0 ? 0 : end - start + 1;
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": "inline",
        "Content-Length": String(length),
        // 媒体类型在 authorize 时由调用方（prepare 内已知格式）写入，避免重复推断。
        "Content-Type": resolved.mediaType,
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      if (c.req.method === "HEAD" || length === 0) {
        return c.body(null, range ? 206 : 200, headers);
      }
      // fileService.readFileRange 是服务层公开接口：不直接碰文件系统，也能兼容远端 Host。
      // 必须分块流式返回：浏览器首次请求常是无 Range 的全量请求，一次 readFileRange 读 512MB
      // 会直接摋爆 server 内存；按 1MB 块边读边写，背压由流控接管。
      const chunkBytes = 1024 * 1024;
      let offset = start;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          const requestedLength = Math.min(chunkBytes, end - offset + 1);
          try {
            const chunk = await fileService.readFileRange({
              path: resolved.canonicalPath,
              offset,
              length: requestedLength,
            });
            if (chunk.length === 0) {
              controller.close();
              return;
            }
            // 拷贝到独立 buffer：readFileRange 返回 Uint8Array<ArrayBufferLike>，
            // 且底层可能复用池，直接入流会在下一块覆盖时读到脏数据。
            controller.enqueue(new Uint8Array(chunk));
            offset += chunk.length;
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return c.body(stream, range ? 206 : 200, headers);
    });
  }

  // 自部署日志导出：与桌面端同一套收集 / 脱敏 / 打包逻辑，但产物以附件下载返回。
  // 目录回退（zip 写入失败）无法作为单文件下载，返回 500 让调用方看到真实原因，
  // 而不是给浏览器一个看似成功的空响应。
  if (options.logExportService) {
    const logExportService = options.logExportService;
    app.get("/api/logs/export", async (c) => {
      const result = await logExportService.export();
      if (!result.success) {
        return c.json({ error: result.error ?? "Log export failed" }, 500);
      }
      if (result.format !== "zip" || !result.bytes) {
        return c.json(
          {
            error: "Log export produced a directory instead of a zip archive",
            ...(result.path ? { path: result.path } : {}),
          },
          500,
        );
      }
      return c.body(new Uint8Array(result.bytes), 200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${result.fileName ?? "zcode-logs.zip"}"`,
        "Content-Length": String(result.bytes.byteLength),
        "Content-Type": "application/zip",
      });
    });
  }

  // 浏览器侧的固定路径反代（OAuth token 交换 / help 配置）。
  // 自部署 Web 没有 Electron main 的 net.fetch：浏览器直连 zcode.z.ai 会被 Origin 白名单
  // 直接 403（实测同一 URL 无 Origin 200、带部署站 Origin 403），且 CORS 预检也不会过。
  // 这里只接受白名单路径，具体校验在 zcodeEndpointProxy 内部。
  const zcodeEndpointProxy = options.zcodeEndpointProxy;
  if (zcodeEndpointProxy) {
    const handleProxy = async (c: Context) => {
      const url = new URL(c.req.url);
      const method = c.req.method === "POST" ? "POST" : c.req.method === "GET" ? "GET" : null;
      if (!method) {
        return c.json({ error: "Method Not Allowed" }, 405);
      }
      let body: string | undefined;
      if (method === "POST") {
        body = await c.req.text().catch(() => "");
      }
      try {
        const result = await zcodeEndpointProxy({
          method,
          path: url.pathname,
          search: url.search,
          ...(body !== undefined ? { body } : {}),
        });
        return new Response(result.body, {
          status: result.status,
          headers: {
            "Content-Type": result.contentType,
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        if (error instanceof ZCodeEndpointProxyError) {
          const status =
            error.reason === "path_not_allowed"
              ? 404
              : error.reason === "invalid_request"
                ? 400
                : 502;
          return c.json({ error: error.message, reason: error.reason }, status);
        }
        return c.json({ error: "ZCode endpoint proxy failed" }, 502);
      }
    };
    app.post("/api/v1/oauth/token", handleProxy);
    app.get("/api/v1/client/configs", handleProxy);
  }

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(
        ws.raw as WebSocket,
        services,
        "desktop-continuous",
        options.workspaceIdentityMapper,
        options.topicResourcePeers,
      );
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // Bug 原因：旧 `/api/connect-remote` + `/ws/remote/:id` 会在 Server 内另起临时 stdio
  // runtime，绕过 R3 的 Window Host → Source Server attachment 主链；两个入口必须一起不可达。

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      const fileBody = await readFile(filePath);
      const cacheControl = filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable";
      const contentType = staticContentType(filePath);

      // 自部署 WebUI 首屏以未压缩形式传输 9.47MB（主包 6.42MB）。
      // Hono 的 c.body 不做内容协商压缩，这里显式选择编码；
      // 压缩失败时回退原始字节，绝不让静态资源返回 5xx。
      const encoding = selectStaticAssetEncoding(c.req.header("accept-encoding"), filePath);
      if (encoding && fileBody.byteLength >= STATIC_ASSET_COMPRESSION_MIN_BYTES) {
        const fileStat = await stat(filePath);
        const cacheKey = `${filePath}:${fileStat.mtimeMs}:${fileStat.size}`;
        try {
          const compressed = await compressStaticAsset(fileBody, encoding, cacheKey);
          return c.body(compressed, 200, {
            "Cache-Control": cacheControl,
            "Content-Type": contentType,
            "Content-Encoding": encoding,
            Vary: "Accept-Encoding",
          });
        } catch {
          // 压缩失败时按未压缩返回，保持可用性优先。
        }
      }

      return c.body(fileBody, 200, {
        "Cache-Control": cacheControl,
        "Content-Type": contentType,
        Vary: "Accept-Encoding",
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
