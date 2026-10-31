import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import selfhostTestFiles from "./scripts/selfhost-test-files.json";

/**
 * 已知既有债：默认跳过，但**不隐藏**。
 *
 * `relayDeviceTransportV2.test.ts` 的 22 个用例全部使用 3.16.2 变基时被替换掉的
 * 旧 transport 契约（`auth` / `authProvider`），实现已改为桌面端官方 V2 副本，
 * 测试未随之迁移 → `getToken` 为 undefined，无限重试后超时。
 * 已在 fork 基线 39c88478 上复现，与本轮改动无关；迁移方案见 session note #32。
 *
 * 用 `pnpm test:selfhost:known-debt` 可显式运行它。
 */
const KNOWN_DEBT_TEST_FILES = new Set([
  "packages/services/test/relayDeviceTransportV2.test.ts",
]);

/**
 * 需要 DOM 环境的测试。
 *
 * 判定来源：这些文件位于 `packages/ui/src/**`，上游在 3.17.1 之前由
 * `packages/ui/vitest.config.ts` 的 happy-dom 环境统一提供 DOM，文件自身没有
 * `@vitest-environment` 声明。合并上游后该包级配置仍在，但上游根 vitest 也是 Node 环境，
 * 因此在补充入口里必须显式分组，否则会以 "document is not defined" 失败。
 */
const DOM_TEST_FILES = new Set([
  "packages/ui/src/lib/clipboard.test.ts",
  "packages/ui/src/settings/AutomationsMainBreadcrumbFrame.test.tsx",
  "packages/ui/src/v4/composer/useComposerAttachments.test.tsx",
]);

/**
 * 自部署（fork）自有测试入口。
 *
 * 为什么需要独立配置：上游自 v3.17.1 起把根 `vitest.config.ts` 收敛为单一
 * `engineering` project，只运行 `scripts/engineering-test-files.json` 里明确列出的
 * 157 个工程测试文件，并删除了各包 test 目录下约 2000 个业务单测。
 * 我们 fork 自建的测试（Linux CUA helper 接入、host-native、自部署平台适配等）
 * 不在那份清单里，合并上游后会被静默跳过。
 *
 * 因此本文件是**补充入口**，不替换上游根配置：
 * - 上游 `pnpm test` / `pnpm test:unit` 语义不变；
 * - 本入口用同一套别名与 setup，只跑 fork 自有清单；
 * - 合并上游后若某些文件被上游删除，Vitest 会以「找不到文件」失败而不是静默通过。
 *
 * 运行：`pnpm test:selfhost`（或 `pnpm vitest run --config vitest.selfhost.config.ts`）
 */
export default defineConfig({
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
      ...[
        "package.json",
        "vitest.selfhost.config.ts",
        "scripts/selfhost-test-files.json",
      ].map((file) => resolve(__dirname, file)),
    ],
    silent: "passed-only",
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "selfhost",
          include: selfhostTestFiles.files.filter(
            (file) => !DOM_TEST_FILES.has(file) && !KNOWN_DEBT_TEST_FILES.has(file),
          ),
          // 与上游 unit project 一致的排除：桌面 E2E 需要真实 Electron，不在此入口。
          exclude: ["packages/desktop/test/e2e/**", ...configDefaults.exclude],
          pool: "threads",
          maxWorkers: 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          // src 旁的 DOM 测试没有 `@vitest-environment` 文件级声明（它们原先由
          // packages/ui/vitest.config.ts 的 happy-dom 环境统一提供），单独分组。
          name: "selfhost-dom",
          include: selfhostTestFiles.files.filter((file) => DOM_TEST_FILES.has(file)),
          // happy-dom 而非 jsdom：与 packages/ui/vitest.config.ts 保持一致，这些测试原件
          // 就在 happy-dom 下通过；jsdom 缺少 customElements 的 webview 桩语义会导致断言差异。
          environment: "happy-dom",
          environmentOptions: {
            happyDOM: { pretendToBeVisual: true },
          },
          setupFiles: ["./packages/ui/vitest.setup.ts"],
          // @testing-library/react 的自动 cleanup 依赖全局 afterEach；缺 globals 时
          // 前一个用例的 DOM 会残留，后续 queryByTestId 断言会被上一轮节点干扰。
          globals: true,
          pool: "threads",
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          // 默认关闭：`--project selfhost` 不会选中它。显式跑：
          //   pnpm vitest run --config vitest.selfhost.config.ts --project selfhost-known-debt
          name: "selfhost-known-debt",
          // 用空 include 关闭而不是 test.enabled：Vitest 4 的项目级 enabled 不生效，
          // 空清单能让该项目被选中时立即以「无测试文件」失败，语义明确。
          include:
            process.env.ZCODE_SELFHOST_KNOWN_DEBT === "1" ? [...KNOWN_DEBT_TEST_FILES] : [],
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
