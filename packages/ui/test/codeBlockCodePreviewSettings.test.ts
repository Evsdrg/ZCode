// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { CodePreviewSettingsContext } from "@/lib/codePreviewSettings.js";

// CodeViewer 会把设置翻译成 DOM 属性，这里只观察传参，不真的渲染 @pierre/diffs。
const seen: Array<Record<string, unknown>> = [];
vi.mock("@/components/ui/code-viewer.js", () => ({
  CodeViewer: (props: Record<string, unknown>) => {
    seen.push(props);
    return createElement("div", { "data-code-viewer": true });
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ai-elements/mermaid-block.js", () => ({
  MermaidBlock: () => createElement("div"),
}));
vi.mock("@/components/ai-elements/diagram-preview-dialog.js", () => ({
  DiagramPreviewDialog: () => null,
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/mermaidRenderBudget.js", () => ({
  getCurrentMermaidDocumentVisibility: () => "visible",
  resolveMermaidAutoRenderDecision: () => ({ shouldRender: false, reason: "test", metrics: {} }),
}));
vi.mock("@/lib/mermaidLanguage.js", () => ({
  isMermaidLanguage: () => false,
  shouldRenderMermaidCodeBlock: () => false,
}));

import { CodeBlock } from "@/components/ai-elements/code-block.js";

function renderBlock(element: ReturnType<typeof createElement>, state: CodePreviewSettings) {
  return render(
    createElement(CodePreviewSettingsContext.Provider, { value: state }, element),
  );
}

describe("CodeBlock 接入代码预览设置", () => {
  afterEach(() => {
    cleanup();
    seen.length = 0;
  });

  it("未显式传参时沿用 store 里的行号/字号/换行设置", () => {
    renderBlock(
      createElement(CodeBlock, { code: "const a = 1", language: "typescript" }),
      { ...DEFAULT_CODE_PREVIEW_SETTINGS, showLineNumbers: true, wrapLongLines: true, fontSizePx: 18 },
    );
    expect(seen.at(-1)).toMatchObject({
      showLineNumbers: true,
      wrapLongLines: true,
      fontSizePx: 18,
    });
  });

  it("显式 props 仍优先于 store 设置", () => {
    renderBlock(
      createElement(CodeBlock, {
        code: "x",
        language: "text",
        showLineNumbers: false,
        wrapLongLines: false,
        fontSizePx: 11,
      }),
      { ...DEFAULT_CODE_PREVIEW_SETTINGS, showLineNumbers: true, wrapLongLines: true, fontSizePx: 20 },
    );
    expect(seen.at(-1)).toMatchObject({
      showLineNumbers: false,
      wrapLongLines: false,
      fontSizePx: 11,
    });
  });

  it("深色应用主题取 darkTheme，浅色取 lightTheme", () => {
    const settings: CodePreviewSettings = {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      lightTheme: "github-light",
      darkTheme: "github-dark",
    };
    renderBlock(
      createElement(CodeBlock, { code: "x", language: "text", appTheme: "dark" }),
      settings,
    );
    expect(seen.at(-1)?.theme).toBe("github-dark");
    cleanup();
    renderBlock(
      createElement(CodeBlock, { code: "x", language: "text", appTheme: "light" }),
      settings,
    );
    expect(seen.at(-1)?.theme).toBe("github-light");
  });

  it("无 Context Provider 时回退默认值而不是抛错", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(CodeBlock, { code: "x", language: "text" }),
      ),
    ).not.toThrow();
  });
});
