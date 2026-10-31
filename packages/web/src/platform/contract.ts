import type {
  RendererTelemetryEventPayload,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import type { RelayStatusSource } from "@zcode/ui";

export type { RelayStatusSource };

export interface WebRemoteControlPlatformProxy {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]>;
}

/**
 * 自部署 server 侧 host-native 平台服务在 web 侧的**形状子集**。
 *
 * web 包不依赖 `@zcode/services`（那是服务端包），因此这里按需声明用到的签名，
 * 由 bootstrap 从 server accessor 取到后注入。未提供的宿主（手机远控等形态）
 * 保持 `undefined`，`createWebPlatform` 回落到原有失败桩/缺席语义。
 */
export interface WebHostNativeService {
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
  openInEditor(editorId: string, path: string): Promise<{ success: boolean; error?: string }>;
  getInstalledEditors(filePath?: string): Promise<
    Array<{ id: string; name: string; iconDataUrl: string }>
  >;
  createTempTextAttachment(payload: {
    text: string;
    filename?: string;
  }): Promise<{ filename: string; localPath: string; mimeType: "text/plain"; sizeBytes: number }>;
  materializeWorkflowArtifactFile(payload: {
    runId: string;
    artifactId: string;
    version: number;
    fileName: string;
    bytes: Uint8Array;
  }): Promise<{ localPath: string }>;
  listSSHConfigAliases(): Promise<
    Array<{
      alias: string;
      host?: string;
      port?: number;
      username?: string;
      privateKeyPath?: string;
      source?: string;
    }>
  >;
  isDockerAvailable(): Promise<boolean>;
  listDockerContainers(): Promise<
    Array<{ id: string; image: string; name: string; state: string; status: string }>
  >;
}

/** 自部署：server 侧 MCP 目录服务（IMcpSyncService 形状子集）。 */
export interface WebMcpDirectoryService {
  loadMcpFromUserDirectory(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
}

/** 自部署：托管浏览器数据清理服务。 */
export interface WebManagedBrowserMaintenance {
  clearAllData(): Promise<{ success: boolean; error?: string }>;
}
