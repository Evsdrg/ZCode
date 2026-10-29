/**
 * 代码预览设置的类型与默认值。
 *
 * 独立的中立模块：若定义在 zustand store（@/store/index.ts）里，
 * 纯展示组件（ai-elements / ToolCallBlocks）为了拿类型和默认值就要依赖 store。
 * store 只做 re-export，展示组件改为 props 传入 + 本模块默认值兜底。
 */
import { createContext, useContext } from "react";
import type { BundledTheme } from "shiki";

export interface CodePreviewSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};

/**
 * 展示层注入通道（不引入 store 依赖）。
 *
 * 为什么需要它：`CodeBlock` 等 ai-elements 展示组件按上面的约束**不得**直接依赖
 * zustand store，但「外观 → 代码预览」的行号 / 换行 / 字号 / 主题需要覆盖全仓
 * 25 个 `CodeBlock` 调用点，逐个传 props 既不现实也容易漏。
 *
 * 折中：唯一持有 store 的宿主（`Root`）把设置写进这个 Context，展示组件只读
 * Context，无 Provider 时回退 `DEFAULT_CODE_PREVIEW_SETTINGS`（与纯展示单测的
 * 既有假设一致）。这样展示组件既不 import store，又能拿到运行时设置。
 */
export const CodePreviewSettingsContext = createContext<CodePreviewSettings>(
  DEFAULT_CODE_PREVIEW_SETTINGS,
);

export function useCodePreviewSettings(): CodePreviewSettings {
  return useContext(CodePreviewSettingsContext);
}
