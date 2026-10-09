import { defineConfig } from "vitest/config";

// packages/services 此前没有单测基建（无 runner）。这里补最小可用环境：
// Node 环境纯逻辑测试；包内 `#src/*` 走 package.json 的 subpath imports，
// vite 解析器原生支持，无需额外 alias。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    restoreMocks: true,
  },
});
