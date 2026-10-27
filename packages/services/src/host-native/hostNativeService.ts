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
import type { IHostNativeService, HostNativeOpenResult } from "./contract.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { materializeWorkflowArtifactFile } from "./workflowArtifactFile.js";
import { openInEditor, openInFileManager } from "./openTarget.js";
import { getCachedInstalledEditors, getInstalledEditors } from "./editors.js";
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
      // 传了文件路径时按扩展名扩展文档/媒体应用，这条分支不走缓存（扩展名组合不受限）。
      return filePath
        ? getInstalledEditorsImpl(filePath, env)
        : getCachedInstalledEditors(env);
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
