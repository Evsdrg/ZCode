import type { EmbeddedBrowserDataClearResult } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 自部署托管浏览器的数据维护面。
 *
 * 浏览器数据（cookie/localStorage/缓存）随 Playwright context 存在于浏览器进程；
 * server 形态没有桌面 Chrome profile 可导入，「清理」的等价语义是关闭全部会话与
 * 浏览器进程（context 销毁即数据清除），下次命令按需重启干净的浏览器。
 */
export interface IManagedBrowserMaintenanceService {
  clearAllData(): Promise<EmbeddedBrowserDataClearResult>;
}

export const IManagedBrowserMaintenanceService =
  createServiceDescriptor<IManagedBrowserMaintenanceService>("managed-browser-maintenance");
