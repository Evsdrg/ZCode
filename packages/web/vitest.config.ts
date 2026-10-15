import { defineConfig } from "vitest/config";

// packages/web 此前无单测基建。补最小可用环境：Node 环境纯逻辑测试
// （断线重连状态机等不依赖 DOM/CSS 的编排）。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    restoreMocks: true,
  },
});
