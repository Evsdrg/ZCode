import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * 工作区 Automations 不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 所以桌面顶栏只剩空拖拽区；这里让工作区入口复用设置页的同一套面包屑合同。
 */
export function AutomationsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Bugfix：原来整个块（拖拽区 + 面包屑）被 isDesktop 绑死，自部署浏览器形态下
            Automations 主视图连面包屑都没有，用户无法从编辑页返回。
            拖拽区 [app-region:drag] 确实是桌面窗口语义，但面包屑是导航语义，两者必须解耦：
            桌面保留「拖拽区高度 + 面包屑」，浏览器只渲染面包屑。
            详见 docs/specs/selfhost-browser-capability-gates.md。 */}
        {isDesktop ? (
          <div
            className="h-12 shrink-0 [app-region:drag]"
            data-testid="automations-main-drag-region"
          >
            <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
          </div>
        ) : (
          <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
        )}
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
