// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  platform: null as Record<string, unknown> | null,
  services: null as Record<string, unknown> | null,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => h.platform,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => h.services,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        ({
          "settings.dataBaseDirPlaceholder": "默认：用户主目录",
          "settings.dataBaseDirBrowse": "选择文件夹",
          "settings.dataBaseDirSave": "保存",
        })[id] ?? id,
    },
  }),
}));
vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: ({ onSelect }: { onSelect: (path: string) => void }) =>
    createElement(
      "button",
      { "data-testid": "fake-directory-browser", onClick: () => onSelect("/data/new") },
      "browse",
    ),
}));

import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";

const baseProps = {
  dataBaseDir: "",
  defaultHomeDir: "/home/u",
  onDataBaseDirChange: vi.fn(async () => {}),
};

describe("DataBaseDirControl 平台能力分流", () => {
  afterEach(() => {
    cleanup();
    h.platform = null;
    h.services = null;
  });

  it("桌面形态（canSelectFilePath=true）仍走系统目录框回调", async () => {
    const onSelectDataBaseDir = vi.fn(async () => "/picked");
    h.platform = { canSelectFilePath: true };
    h.services = {};
    render(
      createElement(DataBaseDirControl, {
        ...baseProps,
        onSelectDataBaseDir,
      }),
    );
    fireEvent.click(screen.getByText("选择文件夹"));
    expect(onSelectDataBaseDir).toHaveBeenCalledTimes(1);
    // 桌面不回退服务端目录浏览器
    expect(screen.queryByTestId("fake-directory-browser")).toBeNull();
  });

  it("Web 形态（canSelectFilePath=false）回退到服务端目录浏览器，选中后填入草稿", async () => {
    const onSelectDataBaseDir = vi.fn(async () => null);
    h.platform = { canSelectFilePath: false };
    h.services = {};
    render(
      createElement(DataBaseDirControl, {
        ...baseProps,
        onSelectDataBaseDir,
      }),
    );
    fireEvent.click(screen.getByText("选择文件夹"));
    // 不再调用恒返回 null 的原生选择器
    expect(onSelectDataBaseDir).not.toHaveBeenCalled();
    const browser = screen.getByTestId("fake-directory-browser");
    fireEvent.click(browser);
    expect((screen.getByTestId("settings-data-base-dir-input") as HTMLInputElement).value).toBe(
      "/data/new",
    );
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(false);
  });

  it("缺少平台注入时（纯展示单测）不抛错且保持只读输入", () => {
    h.platform = null;
    h.services = null;
    expect(() =>
      render(createElement(DataBaseDirControl, { ...baseProps, onSelectDataBaseDir: vi.fn() })),
    ).not.toThrow();
    expect(
      (screen.getByTestId("settings-data-base-dir-input") as HTMLInputElement).readOnly,
    ).toBe(true);
  });
});
