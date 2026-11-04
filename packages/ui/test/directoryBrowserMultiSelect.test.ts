// @vitest-environment jsdom
/**
 * DirectoryBrowser 多选模式。
 *
 * 背景：Web/自部署形态没有原生目录选择框，`selectDirectories` 原先只能回退到
 * 「单选一次 + 反复点浏览」，与桌面端一次多选语义不一致。本用例锁定多选模式：
 * 勾选只改选择、不进入子目录；确认时一次交回全部勾选路径。
 */
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  readdir: vi.fn(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
        if (id === "directoryBrowser.selectPaths") return `add ${values?.count} dirs`;
        if (id === "directoryBrowser.selectPathAria") return `select ${values?.path}`;
        return id;
      },
    },
  }),
}));

import { DirectoryBrowser } from "@/DirectoryBrowser.js";

function makeServices(entries: { name: string; path: string }[]) {
  return {
    fileService: {
      readdir: h.readdir.mockResolvedValue(
        entries.map((entry) => ({ ...entry, type: "directory" })),
      ),
    },
    systemService: { info: async () => ({ homedir: "/home" }) },
  };
}

// jsdom 不实现 Element.scrollTo；DirectoryBrowser 导航成功后会滚动列表到顶部。
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  h.readdir.mockReset();
});

describe("DirectoryBrowser 多选", () => {
  it("勾选目录不进入子目录，确认时交回全部勾选路径", async () => {
    const onSelectPaths = vi.fn();
    const onSelect = vi.fn();

    render(
      createElement(DirectoryBrowser, {
        services: makeServices([
          { name: "a", path: "/home/a" },
          { name: "b", path: "/home/b" },
        ]),
        multiSelect: true,
        showSelectionActions: true,
        onSelect,
        onSelectPaths,
        onCancel: () => {},
      }),
    );

    const checkboxA = await screen.findByLabelText("select /home/a");
    const checkboxB = screen.getByLabelText("select /home/b");

    fireEvent.click(checkboxA);
    fireEvent.click(checkboxB);

    // 勾选不应触发目录导航（readdir 只在初次加载时调用一次）。
    expect(h.readdir).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("directory-browser-confirm"));

    expect(onSelectPaths).toHaveBeenCalledWith(["/home/a", "/home/b"]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("未勾选任何目录时确认回退到当前浏览目录", async () => {
    const onSelectPaths = vi.fn();

    render(
      createElement(DirectoryBrowser, {
        services: makeServices([]),
        multiSelect: true,
        showSelectionActions: true,
        onSelect: () => {},
        onSelectPaths,
        onCancel: () => {},
      }),
    );

    // 初次导航落到 homedir（路径显示在输入框 value 里，不是文本节点）。
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home");
    });
    fireEvent.click(screen.getByTestId("directory-browser-confirm"));

    expect(onSelectPaths).toHaveBeenCalledWith(["/home"]);
  });

  it("单选模式不渲染勾选框且确认仍走 onSelect", async () => {
    const onSelect = vi.fn();
    const onSelectPaths = vi.fn();

    render(
      createElement(DirectoryBrowser, {
        services: makeServices([{ name: "a", path: "/home/a" }]),
        showSelectionActions: true,
        onSelect,
        onSelectPaths,
        onCancel: () => {},
      }),
    );

    await screen.findByText("a");
    expect(screen.queryByLabelText("select /home/a")).toBeNull();

    // 单选模式确认的是「当前浏览目录」，需等初次导航完成且按钮可用（loading 会禁用确认）。
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/home");
      expect((screen.getByTestId("directory-browser-confirm") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByTestId("directory-browser-confirm"));

    expect(onSelect).toHaveBeenCalledWith("/home");
    expect(onSelectPaths).not.toHaveBeenCalled();
  });
});
