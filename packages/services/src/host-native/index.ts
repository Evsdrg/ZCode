/**
 * host-native 模块公开入口。
 *
 * 只导出契约与装配工厂；实现细节（openTarget / editors / dockerDetect / tempTextAttachment /
 * workflowArtifactFile）是 adapters 层内部件，调用方不应直接 import。
 */
export {
  IHostNativeService,
  type IHostNativeService as IHostNativeServiceType,
  type HostNativeOpenResult,
} from "./contract.js";
export { createHostNativeService, type CreateHostNativeServiceOptions } from "./hostNativeService.js";
