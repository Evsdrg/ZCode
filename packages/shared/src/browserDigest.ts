// 浏览器侧 SHA-256 摘要入口。
//
// 为什么需要统一入口：附件上传（attachmentUploadTransaction / arbitraryFileUpload）与 PPTX 元素
// 引用都直接访问 `crypto.subtle`。自部署 WebUI 常以 HTTP 访问内网/组网地址，该地址不是安全上下文，
// `crypto.subtle` 为 undefined，导致上传直接失败。
//
// 门控：只有在构建期显式声明为私有部署（`ZCODE_PRIVATE_DEPLOYMENT=1`）时，才允许在
// `crypto.subtle` 缺失时回退到纯 JS 实现。线上 Web 与桌面构建不包含该分支——见
// docs/specs/selfhost-private-deployment-digest-fallback.md。
//
// 正确性：服务端 commit 会比对声明的 checksum 与实际内容，不符即拒绝。因此两条路径必须
// 产出相同摘要；纯 JS 实现以 Node `createHash("sha256")` 为基准做单测。
import { ZCODE_PRIVATE_DEPLOYMENT } from "./env.js";
import { sha256HexPure } from "./browserSha256Fallback.js";

/** 非安全上下文且未启用私有部署门控时抛出，保持原有可诊断语义。 */
export class DigestUnavailableError extends Error {
  constructor() {
    super("crypto.subtle is unavailable and the private-deployment fallback is not enabled");
    this.name = "DigestUnavailableError";
  }
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 返回小写十六进制 SHA-256（无前缀）。门控开启且 WebCrypto 缺失时走纯 JS 实现。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // BufferSource 要求 ArrayBuffer；复制也避免调用期间底层 view 被复用。
    return toHex(await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  }
  if (ZCODE_PRIVATE_DEPLOYMENT) {
    // 门控为常量 false 时此分支是死代码，sha256HexPure 随之被摇树移除，不进线上产物。
    return sha256HexPure(bytes);
  }
  throw new DigestUnavailableError();
}

/** 便捷包装：返回带 `sha256:` 前缀的校验和字符串。 */
export async function sha256Checksum(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}
