# request-security-ui

## 存在的意图

zcode-plan 的写操作（领取套餐、Start Plan 模型请求）由阿里云 WAF 前置，缺少验证码证明头
会被拦成 `request has been blocked due to unusual activity`。开源构建此前整条链路是空桩，
自部署用户无法领取套餐、Start Plan 请求也会失败。

本模块只负责 UI 侧的两件事：把验证码 SDK 挂起来、在 agent 请求鉴权材料时把证明回填。
「是否需要校验」「怎么构造头」「错误怎么归类」分别在 `@zcode/shared` 的
`request-security-edition` 与本模块的 `errors.ts` 里。

## 不变量

- **Host 必须常驻**：`RequestSecurityHost` 一旦卸载，正在进行的验证会抛
  `Captcha host container is not mounted.`；`Root` 在应用生命周期内始终渲染它。
- **应答方与 pane 展示解耦**：`RequestSecurityWorkspaceBridge` 按 workspace tab 订阅，
  不随 session pane 是否可见变化。历史上「只随当前 pane 挂载」导致 web 远控新建会话
  无人应答，请求永久 pending、任务卡在「工作中」。
- **一次只跑一个验证**：SDK 的 pending 是全局的，并发验证会互相覆盖；模块内部串行化。
- **不静默放行**：配置缺失或用户未完成校验时返回 `undefined` / `headersApplied: false`，
  绝不发空证明头——空头会被 WAF 判成伪造证明，比缺头更难排查。
- **证明不进日志**：诊断只报「有没有带证明」，`@zcode/shared` 的
  `requestSecuritySensitiveHeaders` 会在网络抓包与日志侧打码。

## 与其它模块的交集

- `@zcode/shared`：配置读取/校验、证明头构造与白名单、错误判定、诊断摘要。
- `@zcode/services`：`codingPlanSubscriptionService.getRequestVerificationConfig()` 提供配置快照；
  `zcodeAgentService.onDynamicWorkspaceProviderRuntimeHeadersRequest()` 提供请求事件，
  `respondProviderRuntimeHeaders()` 回填证明。
- 阿里云 SDK：公开 CDN 脚本，SceneId/region/prefix 全部来自服务端下发，无硬编码密钥。
