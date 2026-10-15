// 闲时任务派发结果结算逻辑已下沉到 @zcode/services/node，桌面与自部署 server 共用一份实现。
// 这里仅做转出，保持桌面 Host 既有导入路径不变。
export {
  settleOffPeakDispatchResult,
  OFF_PEAK_DISPATCH_RETRY_BASE_MS,
  OFF_PEAK_DISPATCH_RETRY_CAP_MS,
  type OffPeakDispatchSettlementDeps,
  type OffPeakDispatchResult,
} from "@zcode/services/node";
