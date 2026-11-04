import type {
  ApplicationIconInfo,
  ApplicationIconRequest,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  DockerContainerInfo,
  EditorInfo,
  FileApplicationInfo,
  FileApplicationTarget,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  OpenInEditorOptions,
  SSHConfigAliasOption,
} from "@zcode/shared";
import type { IHostNativeService, HostNativeOpenResult } from "./contract.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { materializeWorkflowArtifactFile } from "./workflowArtifactFile.js";
import { openExternalFile, openInEditor, openInFileManager } from "./openTarget.js";
import { getInstalledEditors } from "./editors.js";
import { getApplicationIcon, resolveIconDataUrl } from "./applicationIcons.js";
import { createFileApplicationService } from "./file-apps/index.js";
import { listSSHConfigAliasesFromLocalConfig } from "../system/sshConfigAlias.js";
import {
  isDockerAvailable as probeDockerAvailable,
  listDockerContainers as probeDockerContainers,
} from "./dockerDetect.js";

export interface CreateHostNativeServiceOptions {
  env?: NodeJS.ProcessEnv;
  /** 便于测试注入。 */
  openInFileManagerImpl?: typeof openInFileManager;
  openInEditorImpl?: typeof openInEditor;
  openExternalFileImpl?: typeof openExternalFile;
  getApplicationIconImpl?: typeof getApplicationIcon;
  getInstalledEditorsImpl?: typeof getInstalledEditors;
  createTempTextAttachmentImpl?: typeof createTempTextAttachment;
  materializeWorkflowArtifactFileImpl?: typeof materializeWorkflowArtifactFile;
  listSSHConfigAliasesImpl?: typeof listSSHConfigAliasesFromLocalConfig;
  isDockerAvailableImpl?: typeof probeDockerAvailable;
  listDockerContainersImpl?: typeof probeDockerContainers;
}

/**
 * 自部署 server 的 host-native 平台能力实现。
 *
 * 全部方法都在 server 进程内直接执行本机操作，不经过 Electron IPC、不启动桌面应用的主进程。
 * 语义与桌面端对应能力保持一致（见 docs/specs/selfhost-host-native-platform-service.md）。
 */
export function createHostNativeService(
  options: CreateHostNativeServiceOptions = {},
): IHostNativeService {
  const env = options.env ?? process.env;
  const openInFileManagerImpl = options.openInFileManagerImpl ?? openInFileManager;
  const openInEditorImpl = options.openInEditorImpl ?? openInEditor;
  const openExternalFileImpl = options.openExternalFileImpl ?? openExternalFile;
  const getApplicationIconImpl = options.getApplicationIconImpl ?? getApplicationIcon;
  // 文件应用服务无持久状态，进程内复用同一实例即可（内部按调用重查系统关联）。
  // 图标：`.desktop` 的 `Icon=` 可能是主题图标名，必须走 XDG 主题链解析；
  // 旧实现只把绝对路径当作可读图标，会让非 hicolor 主题（如 Papirus）下的应用全部丢图标。
  const fileApplicationService = createFileApplicationService({
    getIcon: (_id, iconPath) => resolveIconDataUrl(iconPath, { env }),
  });
  const getInstalledEditorsImpl = options.getInstalledEditorsImpl ?? getInstalledEditors;
  const createTempTextAttachmentImpl =
    options.createTempTextAttachmentImpl ?? createTempTextAttachment;
  const materializeWorkflowArtifactFileImpl =
    options.materializeWorkflowArtifactFileImpl ?? materializeWorkflowArtifactFile;
  const listSSHConfigAliasesImpl =
    options.listSSHConfigAliasesImpl ?? listSSHConfigAliasesFromLocalConfig;
  const isDockerAvailableImpl = options.isDockerAvailableImpl ?? probeDockerAvailable;
  const listDockerContainersImpl = options.listDockerContainersImpl ?? probeDockerContainers;

  return {
    openInFileManager(path: string): Promise<HostNativeOpenResult> {
      return openInFileManagerImpl(path, env);
    },

    openExternalFile(path: string): Promise<HostNativeOpenResult> {
      return openExternalFileImpl(path, env);
    },

    getFileApplications(target: FileApplicationTarget): Promise<FileApplicationInfo[]> {
      return fileApplicationService.getFileApplications(target);
    },

    openFileWithApplication(
      applicationId: string,
      target: FileApplicationTarget,
    ): Promise<HostNativeOpenResult> {
      return fileApplicationService.openFileWithApplication(applicationId, target);
    },

    getApplicationIcon(
      request: string | ApplicationIconRequest,
    ): Promise<ApplicationIconInfo | null> {
      return getApplicationIconImpl(request, { env });
    },

    openInEditor(
      editorId: string,
      path: string,
      _options?: OpenInEditorOptions,
    ): Promise<HostNativeOpenResult> {
      // 自部署形态没有「远端目标」：server 就是宿主，路径就是本机路径。
      // 调用方传了 remoteTarget 说明它以为这是远程工作区，此时直接拒绝比误开本机文件安全。
      if (_options?.remoteTarget) {
        return Promise.resolve({
          success: false,
          error: "remote target is not supported by host-native platform",
        });
      }
      return openInEditorImpl(editorId, path, env);
    },

    getInstalledEditors(filePath?: string): Promise<EditorInfo[]> {
      // 语义与 Electron 一致：不传路径时返回空（Linux 无通用编辑器），传路径时按扩展名匹配。
      return getInstalledEditorsImpl(filePath, env);
    },

    createTempTextAttachment(
      payload: CreateTempTextAttachmentRequest,
    ): Promise<CreateTempTextAttachmentResult> {
      return createTempTextAttachmentImpl(payload);
    },

    materializeWorkflowArtifactFile(
      payload: MaterializeWorkflowArtifactFileRequest,
    ): Promise<MaterializeWorkflowArtifactFileResult> {
      return materializeWorkflowArtifactFileImpl(payload);
    },

    listSSHConfigAliases(): Promise<SSHConfigAliasOption[]> {
      return listSSHConfigAliasesImpl();
    },

    isDockerAvailable(): Promise<boolean> {
      return isDockerAvailableImpl();
    },

    listDockerContainers(request?: { all?: boolean }): Promise<DockerContainerInfo[]> {
      return listDockerContainersImpl(request);
    },
  };
}
