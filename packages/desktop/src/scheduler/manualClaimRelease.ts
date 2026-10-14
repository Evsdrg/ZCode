// manual claim 释放逻辑已下沉到 @zcode/services/node，桌面与自部署 server 共用一份实现。
// 这里仅做转出，保持桌面 Host 既有导入路径不变。
export {
  releaseManualClaimForSettledRun,
  settleManualClaimForDispatchResult,
  type ManualClaimReleaseRepo,
  type ManualClaimReleaseParams,
} from "@zcode/services/node";
