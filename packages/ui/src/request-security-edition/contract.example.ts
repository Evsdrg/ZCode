/**
 * request-security-ui 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { RequestSecurityUiContract } from "./contract.js";

/**
 * 在应用根部挂载验证码宿主与 workspace 应答方。
 *
 * 顺序无关，但两者必须同时存在：只有 Host 没有 Bridge 时不会有人应答请求，
 * 只有 Bridge 没有 Host 时 SDK 找不到挂载点会直接抛错。
 */
export function exampleRequestSecurityUi(
  contract: RequestSecurityUiContract,
  workspaceTabs: Parameters<
    RequestSecurityUiContract["RequestSecurityWorkspaceBridge"]
  >[0]["workspaceTabs"],
): void {
  void contract.RequestSecurityHost();
  void contract.RequestSecurityWorkspaceBridge({ workspaceTabs });
}
