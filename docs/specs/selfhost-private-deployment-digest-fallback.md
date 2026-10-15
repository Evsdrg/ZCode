# 私有部署下的浏览器安全上下文降级

状态：已实施
适用：`packages/web`（自部署 WebUI）与 `packages/ui`、`packages/shared` 的浏览器侧代码。桌面 Electron renderer 与线上 Web 行为不变。

## 背景与问题

自部署 WebUI 从「公网 HTTPS 入口」改为「浏览器直连 Host 的 HTTP 地址」后，附件上传失效。
根因是**浏览器安全上下文**：`http://10.126.126.42:3030` 不是安全上下文，而 `http://localhost` /
`http://127.0.0.1` 是。实测：

| 地址                    | `isSecureContext` | `crypto.subtle` | `crypto.randomUUID` |
| ----------------------- | ----------------- | --------------- | ------------------- |
| `http://<mesh-ip>:3030` | false             | undefined       | undefined           |
| `http://127.0.0.1:3030` | true              | 可用            | 可用                |

非安全上下文下 `crypto.subtle` 为 `undefined`，而附件上传必须用它算 SHA-256 校验和：

- `packages/ui/src/v4/attachmentUploadTransaction.ts` 显式抛 `fault.attachment.checksumUnavailable`；
- `packages/ui/src/v4/composer/arbitraryFileUpload.ts` 直接抛 `TypeError: ... reading 'digest'`；
- `packages/ui/src/lib/pptxElementReference.ts` 的 `sha256Fingerprint` 同样失败。

上传校验和是服务端**强校验**项：`attachmentBegin` 会把 checksum 下发到 CLI，服务端 commit 时比对
实际内容，不符即 `checksum-mismatch` 拒绝。因此降级实现必须与 WebCrypto 的 SHA-256 **字节级一致**，
不能是近似或弱化摘要。

## 产品规则

- **门控必须编译期确定**：只在明确构建为「私有/非公网部署」时启用降级分支；线上 Web 与桌面构建
  不得包含该分支（避免在公网环境误用非 WebCrypto 实现）。
- 门控维度是新增的**部署形态**，不是 `ZCODE_ENV`（test/production）。理由：`ZCODE_ENV` 描述后端
  环境，与「是否私有部署」正交；线上 Web 也可能是 test 后端。
- 启用降级时：`crypto.subtle` 可用则仍优先用它；仅在缺失时才走纯 JS 实现。即降级是**兜底**，
  不是替换。
- 降级实现只覆盖 SHA-256 摘要这一项能力，不改变上传协议、分片、大小上限与错误语义。
- 未启用门控时行为与现状完全一致（缺失 `crypto.subtle` 仍按原样报错）。

## 所有者与接口

- **编译常量**：`__ZCODE_PRIVATE_DEPLOYMENT__: boolean`，沿用仓库既有 `declare const` + `typeof`
  检查模式（见 `packages/shared/src/env.ts`）。缺省（未注入）视为 `false`。
- **读取入口**：`packages/shared/src/env.ts` 导出 `ZCODE_PRIVATE_DEPLOYMENT`，供 ui/shared 消费。
  与 `ZCODE_ENV` 一样是模块级常量，构建期被 define 替换。
- **摘要入口**：`packages/shared/src/browserDigest.ts` 导出
  `sha256Hex(bytes: Uint8Array): Promise<string>`，内部按门控选择 WebCrypto 或纯 JS 实现。
  三个调用点改为调用它，不再各自访问 `crypto.subtle`。
- **纯 JS 实现**：同文件内的 SHA-256（FIPS 180-4）。仅在该文件被门控分支引用时才进入产物；
  define 为 `false` 时纯 JS 实现应被摇树移除。

## 构建与注入

- `packages/web/vite.config.ts` 从 `ZCODE_PRIVATE_DEPLOYMENT=1` 环境变量解析并注入
  `__ZCODE_PRIVATE_DEPLOYMENT__`。自部署构建命令显式携带该变量。
- `packages/desktop` 不注入（缺省 false），桌面保持 WebCrypto 路径。
- 文档记录：私有部署构建需带 `ZCODE_PRIVATE_DEPLOYMENT=1`，否则 HTTP 访问下上传仍失败。

## 顺序与失败语义

```text
附件上传 → sha256Hex(bytes)
            ├─ 门控关闭：直接 crypto.subtle.digest（现状）
            └─ 门控开启：crypto.subtle 存在？→ 用它
                          └ 缺失 → 纯 JS SHA-256
           → checksum 字符串（sha256:<64 hex>）→ attachmentBegin → ... → commit 服务端比对
```

- 纯 JS 实现必须同步产出与 WebCrypto 相同的小写 hex，前缀 `sha256:` 由调用方拼装。
- 实现不得吞掉异常：门控关闭且 `crypto.subtle` 缺失时仍抛原错误，保持可诊断。

## 安全与边界

- 门控是编译期开关，运行时不可绕过；公网/线上构建不包含纯 JS 分支。
- 纯 JS SHA-256 用于内容校验和，不用于签名、密钥派生或任何密码学安全用途；它不引入新的信任面
  （摘要值本就由客户端声明、服务端比对）。
- 不改闭源 CLI、不改 V4 帧格式、不新增对外 HTTP 路由。

## 验收

1. 私有部署构建（带门控）在 `http://<mesh-ip>:3030` 下可上传图片/普通文件，服务端 commit 通过
   （不出现 `checksum-mismatch`）。
2. 同一构建在 `crypto.subtle` 可用时（如 localhost）仍走 WebCrypto，摘要一致。
3. 纯 JS 实现与 WebCrypto 对同一输入产出相同 hex：用 Node `createHash("sha256")` 作基准，
   覆盖空输入、单字节、跨越分块边界的长度（55/56/63/64/65、1MiB）等边界。
4. 未带门控的构建（线上 Web、桌面）行为不变：`crypto.subtle` 缺失时仍按原样报错。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check` 通过；ui/shared 目标测试通过。

验证：新增 shared 侧 sha256 一致性单测（对 Node createHash 基准）；在私有部署构建下用浏览器
实际拖入图片验证上传链路。不重启 `zcode-web-local` 宿主；隔离实例副本须去除 `credentials.json`。
