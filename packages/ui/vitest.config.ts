import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// packages/ui 的测试环境。别名必须与 packages/ui/tsconfig.json 的 paths 保持一致
// （@/* -> ./src/*），否则测试里 import "@/lib/settingsNavigation.js" 会解析失败；
// ui 包是 NodeNext ESM，包内导入带 .js 后缀，vite 解析器按同一条规则走。
//
// include 同时覆盖两处测试：fork 自建的 src/**（如按宿主形态门控的纯 UI 决策），
// 以及上游 3.15.1 起新增的 test/**（如 BrowserUseSidePaneContent 等）。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // happy-dom 而非 jsdom：体积更小、启动更快，且足够覆盖本包用到的 DOM 面
    // （customElements、dialog、button 的 disabled 语义）。
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}", "test/**/*.{test,spec}.{ts,tsx}"],
    // React 19 + @testing-library/react 需要显式打开 act 环境，
    // 否则渲染与状态更新会抛 "not wrapped in act" 警告并使断言不稳定。
    environmentOptions: {
      happyDOM: {
        // 让 happy-dom 认出 <webview> 这类自定义元素名，避免解析时被当成未知标签丢弃。
        pretendToBeVisual: true,
      },
    },
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
