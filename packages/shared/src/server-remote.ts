import { z } from "zod";
import { compatibilityManifestSchema } from "./source-server/compatibility.js";

export const SERVER_REMOTE_PROTOCOL_VERSION = 1;

const serverRemoteWorkspaceInfoShape = {
  path: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  workspaceIdentity: z.string().trim().min(1).optional(),
};

/** 客户端 wire 解析忽略同 protocolVersion 下新增的 optional 字段。 */
export const serverRemoteWorkspaceInfoSchema = z.object(serverRemoteWorkspaceInfoShape);

/** Server 构造自身出参时使用 strict schema，避免意外泄漏字段。 */
export const serverRemoteWorkspaceInfoOutputSchema = z
  .object(serverRemoteWorkspaceInfoShape)
  .strict();

const serverRemoteInfoBaseShape = {
  serverId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.boolean(),
  // 宿主进程所在平台（process.platform）。自部署 WebUI 用它判定本机是否 Linux
  // 等桌面平台，从而决定 Computer Use 等本机能力的可见性（浏览器 UA 无法反映宿主）。
  hostPlatform: z.string().optional(),
};

export const serverRemoteInfoSchema = z.object({
  ...serverRemoteInfoBaseShape,
  workspaces: z.array(serverRemoteWorkspaceInfoSchema),
  compatibility: compatibilityManifestSchema.strip().optional(),
  migration: z.object({ failedPathCount: z.number().int().nonnegative() }).optional(),
  identity: z
    .object({
      osUser: z.string().trim().min(1),
      hostname: z.string().trim().min(1),
    })
    .optional(),
  capabilities: z.object({
    desktopContinuous: z.literal(true),
    websocketRpc: z.literal(true),
    virtualProjects: z.literal(true).optional(),
    // 旧 Server 缺少新增 dynamic event，必须先声明能力再订阅，避免异常打进对端读循环。
    processResourceTelemetry: z.boolean().optional(),
    /** 自部署 server 注册了 host-native 平台服务（见 serverRemoteInfoOutputSchema 同名字段）。 */
    hostNative: z.literal(true).optional(),
  }),
});

export const serverRemoteInfoOutputSchema = z
  .object({
    ...serverRemoteInfoBaseShape,
    workspaces: z.array(serverRemoteWorkspaceInfoOutputSchema),
    compatibility: compatibilityManifestSchema.optional(),
    migration: z.object({ failedPathCount: z.number().int().nonnegative() }).strict().optional(),
    identity: z
      .object({
        osUser: z.string().trim().min(1),
        hostname: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        desktopContinuous: z.literal(true),
        websocketRpc: z.literal(true),
        virtualProjects: z.literal(true).optional(),
        // 输入和严格输出保持同一能力合同，否则新 Server 会在监听前被自身 schema 拒绝。
        processResourceTelemetry: z.boolean().optional(),
        /**
         * 自部署 server 注册了 host-native 平台服务（本机文件管理器/编辑器/临时附件/产物落地）。
         * Web 端据此决定是否为 `createWebPlatform` 注入 host-native 实现；
         * 未声明时（旧 server / 手机远控）保持原有失败桩语义。
         */
        hostNative: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();

export const serverRemoteAnonymousInfoSchema = z.object({
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.literal(true),
  compatibility: compatibilityManifestSchema.strip().optional(),
});

export type ServerRemoteWorkspaceInfo = z.infer<typeof serverRemoteWorkspaceInfoSchema>;

export type ServerRemoteInfo = z.infer<typeof serverRemoteInfoSchema>;

export type ServerRemoteAnonymousInfo = z.infer<typeof serverRemoteAnonymousInfoSchema>;

export const serverRemoteHostCapabilitySchema = z
  .object({
    capability: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ServerRemoteHostCapability = z.infer<typeof serverRemoteHostCapabilitySchema>;
