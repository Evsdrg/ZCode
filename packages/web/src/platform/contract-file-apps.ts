import type {
  ApplicationIconInfo,
  ApplicationIconRequest,
  FileApplicationInfo,
  FileApplicationTarget,
} from "@zcode/shared";

/**
 * 自部署 server 的「系统文件应用」能力。
 *
 * 为什么单独一个文件：架构规则 `max-public-methods` 按**文件**统计接口方法总数上限 12，
 * 把这些方法并进 `contract.ts` 的 `WebHostNativeService` 会超限。语义上它们也是独立一组：
 * 依赖系统 MIME 关联数据库（`xdg-mime` / GIO），与 openInFileManager 这类「打开路径」不同。
 */
export interface WebHostNativeFileApps {
  /** 用系统默认应用打开本机文件（对齐 Electron `shell.openPath`）。 */
  openExternalFile(path: string): Promise<{ success: boolean; error?: string }>;

  /** 列出能打开该文件的系统应用（含图标）。 */
  getFileApplications(target: FileApplicationTarget): Promise<FileApplicationInfo[]>;

  /** 用指定系统应用打开本机文件；每次重查关联，不信任 renderer 传的应用路径。 */
  openFileWithApplication(
    applicationId: string,
    target: FileApplicationTarget,
  ): Promise<{ success: boolean; error?: string }>;

  /** 按 `.desktop` app id / 显示名解析应用图标；Linux 不支持 macOS/Windows locator。 */
  getApplicationIcon(request: string | ApplicationIconRequest): Promise<ApplicationIconInfo | null>;
}
