import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// packages/web 此前无单测基建。补最小可用环境：Node 环境纯逻辑测试
// （断线重连状态机等不依赖 DOM/CSS 的编排）。
//
// `@` 别名必须指向 packages/ui/src：web 的平台适配会经 @zcode/ui 间接进入 ui 源码，
// ui 包内部使用 `@/...` 形式的自引用（与 packages/ui/tsconfig.json 的 paths 一致）。
// 缺这条别名时，任何 import @zcode/ui 的测试都会以 “Failed to resolve import” 失败。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../ui/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    restoreMocks: true,
  },
});
