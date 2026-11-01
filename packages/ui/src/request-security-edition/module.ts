/**
 * request-security-ui 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const requestSecurityUiModule = {
  id: "request-security-ui",
  requires: ["services", "shared", "ui"],
  provides: ["request-security-ui"],
  publicEntrypoints: ["index.tsx", "contract.ts"],
} as const;
