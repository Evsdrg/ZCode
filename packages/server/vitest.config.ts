import { defineConfig } from "vitest/config";

// packages/server 此前无单测基建。补最小可用环境：Node 环境纯逻辑测试
// （WebSocket 心跳等不依赖真实网络的控制流）。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    restoreMocks: true,
  },
});
