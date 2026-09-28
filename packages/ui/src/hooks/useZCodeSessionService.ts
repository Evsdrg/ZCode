import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 与 useZCodeAgentService 同因：hook 不能放在三元分支里，否则 workspacePath 由空变有值时
  // hook 数量突变，React 依赖比较会读到 undefined 而抛错。改为无条件调用后择一。
  const contextServices = useServices();
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeSessionService;
}
