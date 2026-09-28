import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";

// 覆盖本次改动第 4 项：Automations 主视图的拖拽区与面包屑解耦。
// 修复前两者被同一个 isDesktop 绑死，自部署浏览器形态下面包屑整块缺失，
// 用户无法从编辑页返回。行为契约见
// docs/specs/selfhost-browser-capability-gates.md。
//
// 注意：SettingsHeaderBreadcrumb 在 items.length < 2 时返回 null，而 frame 的
// items 由子页面经 SettingsBreadcrumbReporter 上报填充。因此这里必须放一个
// reporter，否则测到的是「无子页面」的空态，而非本次修复的结构。
describe("AutomationsMainBreadcrumbFrame", () => {
  const ariaLabel = "Automations 面包屑";

  function renderFrame(isDesktop: boolean) {
    return render(
      <AutomationsMainBreadcrumbFrame
        ariaLabel={ariaLabel}
        isDesktop={isDesktop}
        sectionLabel="定时任务"
      >
        <SettingsBreadcrumbReporter items={[{ label: "某个自动化" }]} />
        <div data-testid="automations-body">body</div>
      </AutomationsMainBreadcrumbFrame>,
    );
  }

  it("桌面形态保留拖拽区，且面包屑在拖拽区内", () => {
    renderFrame(true);

    const dragRegion = screen.getByTestId("automations-main-drag-region");
    expect(dragRegion).toBeTruthy();
    // 面包屑必须仍在拖拽区里：桌面顶栏的面包屑与拖拽是同一块区域。
    expect(dragRegion.contains(screen.getByLabelText(ariaLabel))).toBe(true);
  });

  it("浏览器形态不渲染拖拽区", () => {
    renderFrame(false);

    expect(screen.queryByTestId("automations-main-drag-region")).toBeNull();
  });

  // 本次修复的核心：面包屑与拖拽区解耦后，浏览器形态仍要看到面包屑。
  it("浏览器形态仍渲染面包屑", () => {
    renderFrame(false);

    expect(screen.getByLabelText(ariaLabel)).toBeTruthy();
  });

  it("两种形态都渲染 children", () => {
    for (const isDesktop of [true, false]) {
      const { unmount } = renderFrame(isDesktop);
      expect(screen.getByTestId("automations-body")).toBeTruthy();
      unmount();
    }
  });
});
