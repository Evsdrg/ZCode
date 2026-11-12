/**
 * media-preview 模块公开入口。
 *
 * 只导出契约与工厂；`mediaPreviewLeaseStore` / `mediaPreviewRange` / `mediaPreviewUrl` 的
 * 实现细节由 `contract.ts` 统一收口，调用方不应绕过它直接依赖具体文件。
 */
export {
  SERVER_MEDIA_PREVIEW_ROUTE,
  buildServerMediaPreviewUrl,
  parseMediaByteRange,
  type MediaByteRange,
  type MediaPreviewLeaseStore,
} from "./contract.js";
export { createMediaPreviewLeaseStore } from "./mediaPreviewLeaseStore.js";
