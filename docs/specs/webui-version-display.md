# Web UI 版本号展示

状态：已实施
范围：`packages/ui` 设置页 → 通用分区；`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`。

## 背景

自部署形态（`zcode --web`，浏览器 + 本机 host）下，用户无法从界面得知当前跑的是哪个版本。
排障时需要分别登录服务器与本机查进程，成本高。`/api/server-info` 已返回 `version`，
但那是接口，不是给人看的。

## 行为

在设置页 → 通用（General）分区末尾新增一行，展示当前 Web UI 版本号。

- 值来源：`ZCODE_VERSION`（`packages/shared/src/version.ts`），由各 bundler 通过
  `define` 注入 `__ZCODE_VERSION__`，取根目录 `package.json` 的 `version`；
  非构建环境回退 `"0.0.0-dev"`。
- 与 `/api/server-info` 的 `version` 字段**同源同值**，因此界面上看到的版本即接口报告的版本。
- 该行只读，无可交互控件。

## 术语边界（重要）

标的是 **Web UI 版本**，不等同于 Agent 后端版本：

- Web UI / HTTP 服务层：开源构建产物（`packages/server/dist/entry-http.js` + `packages/web/dist`），
  版本即 `ZCODE_VERSION`。
- Agent 协议后端：官方闭源组件（`/opt/ZCode/resources/glm/zcode.cjs app-server --stdio`），
  自带独立版本（如 `v0.13.3+464dc03681ff`），由官方 updater 管理，
  与 `ZCODE_VERSION` 不是一套版本线。

因此文案必须写明「Web UI」，不能只写「版本」，否则排障时会误导为后端版本。

## 状态所有者

- **版本号的唯一所有者**：`packages/shared/src/version.ts` 的 `ZCODE_VERSION` 常量。
  UI 不缓存、不推导第二份版本；设置页只读取该常量渲染。
- 没有服务端往返：不为此新增 RPC，也不读 `/api/server-info`（避免多一条真相源）。

## 不变量

1. 版本行必须复用既有 `SettingsGroupCard` + `SettingsRow`，不新造组件、不引入新样式体系。
2. 两个语言包必须同时补齐 key，不得只加一侧（`AGENTS.md`：兼顾桌面与手机 Web 的国际化）。
3. 不得把该行做成可点击入口或跳转（如「检查更新」），自部署形态没有对应的更新通道；
   桌面端的自动更新入口仍由既有桌面专属逻辑负责。
4. 文案不得暗示这是 Agent 后端版本。

## 验收场景

1. 打开设置页 → 通用分区，末尾出现「Web UI 版本」行，值为构建时的 `package.json` version
   （当前为 `3.14.3`）。
2. 同一版本号与 `GET /api/server-info` 的 `version` 一致。
3. 切换中/英文，行标签与说明随之切换，无缺失 key。
4. 桌面端与手机 Web 下该行均可见、可读，不依赖 `isDesktop`。
5. 该行无点击行为，不产生任何请求。
