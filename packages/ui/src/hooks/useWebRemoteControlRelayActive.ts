import { useEffect, useState } from "react";
import { useOptionalServices } from "./useServices.js";

const ACTIVE_POLL_INTERVAL_MS = 5000;

/**
 * 官方中转远控是否已开启（侧栏入口图标的橙色指示）。
 * 连接事实的所有者是服务端 relay service；这里只做低频轮询投影，
 * desktop host 未注册该服务时恒为 false、不发请求。
 */
export function useWebRemoteControlRelayActive(): boolean {
  const services = useOptionalServices();
  const service = services?.webRemoteControlRelayService;
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!service) {
      setActive(false);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await service.getStatus();
        if (!cancelled) setActive(status.enabled);
      } catch {
        // 轮询失败保持上一态；服务端才是事实所有者，UI 不据此报错。
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), ACTIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service]);

  return active;
}
