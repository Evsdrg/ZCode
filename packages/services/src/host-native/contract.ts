import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  DockerContainerInfo,
  EditorInfo,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  OpenInEditorOptions,
  SSHConfigAliasOption,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 打开类操作统一返回形状（与 IPlatformService 的同名方法一致）。 */
export interface HostNativeOpenResult {
  success: boolean;
  error?: string;
}

/**
 * 自部署 server 的 host-native 平台能力。
 *
 * 背景：`IPlatformService` 是 Electron 主进程能力的投影，但自部署 server 与用户在同一台机器、
 * 同一个 Unix 用户、同一个图形会话里（`DISPLAY` / `WAYLAND_DISPLAY` / 用户 DBus 均可用），
 * 「打开本机文件管理器」「用本机编辑器打开」这类操作其实**与 Electron 无关**。
 *
 * 因此自部署形态不再返回失败桩，而是由 server 进程直接执行。桌面 Host 不注册该服务，
 * 仍走自己的 `registerPlatformIpcHandlers`——两条路径互不重叠，避免行为分歧。
 *
 * 安全边界：本服务不引入新的信任边界。能访问 server RPC 的一方本来就已经拥有
 * `terminalService`（任意 shell）与 `fileService`（任意路径读取），见
 * docs/specs/selfhost-host-native-platform-service.md。
 */
export interface IHostNativeService {
  /** 用系统文件管理器打开路径（目录本身，或文件所在目录）。 */
  openInFileManager(path: string): Promise<HostNativeOpenResult>;

  /** 用本机已安装的应用/编辑器打开路径。 */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<HostNativeOpenResult>;

  /** 列出本机已安装的编辑器与应用（含图标 data URL）。 */
  getInstalledEditors(filePath?: string): Promise<EditorInfo[]>;

  /** 把文本落成宿主本机的临时附件文件，返回绝对路径。 */
  createTempTextAttachment(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /** 把某版工作流产物的字节落成宿主本机副本（同一版只落一次）。 */
  materializeWorkflowArtifactFile(
    payload: MaterializeWorkflowArtifactFileRequest,
  ): Promise<MaterializeWorkflowArtifactFileResult>;

  /** 本机 `~/.ssh/config` 中定义的别名。 */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** 本机 Docker daemon 是否可用（任何探测失败都算不可用）。 */
  isDockerAvailable(): Promise<boolean>;

  listDockerContainers(options?: { all?: boolean }): Promise<DockerContainerInfo[]>;
}

export const IHostNativeService = createServiceDescriptor<IHostNativeService>(
  ServiceChannels.HostNative,
);
