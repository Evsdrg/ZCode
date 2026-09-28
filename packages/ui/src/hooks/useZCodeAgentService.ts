import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 原实现把 hook 写在三元分支里（有 workspacePath 走 useWorkspaceServices，无则 useServices）。
  // workspacePath 会从「首帧 undefined」变为「workspace 加载完成后的路径」，同一次挂载内切换
  // 分支会让 hook 数量与类型突变：React 的 hook 指针错位，随后在依赖比较里读到 undefined，
  // 抛 "can't access property 'length', t is undefined"。这里无条件调用两个 hook 再择一，
  // 两种情形各自保持原有语义。
  const contextServices = useServices();
  const workspaceServices = useWorkspaceServices(
    workspacePath ?? null,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeAgentService;
}
