import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Checksum, sha256Hex } from "@zcode/shared";
// 直接测纯 JS 实现：它是私有部署在非安全上下文下的兜底，必须与标准 SHA-256 逐字节一致
// （服务端 commit 用声明的 checksum 比对实际内容，不一致即拒绝）。
import { sha256HexPure } from "@zcode/shared/browserSha256Fallback";

/** Node 原生实现作为基准。 */
function reference(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(length: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    // 简单可复现的伪随机填充，避免全零导致的分块边界盲区。
    bytes[index] = (index * 31 + seed * 7 + (index >> 8)) & 0xff;
  }
  return bytes;
}

describe("sha256HexPure", () => {
  it("matches Node createHash for the empty input", () => {
    expect(sha256HexPure(new Uint8Array(0))).toBe(reference(new Uint8Array(0)));
  });

  it("matches Node createHash for a single byte", () => {
    expect(sha256HexPure(new Uint8Array([0x61]))).toBe(reference(new Uint8Array([0x61])));
  });

  it("matches the known FIPS vector for 'abc'", () => {
    expect(sha256HexPure(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Node createHash across padding and block boundaries", () => {
    // 55/56 是单块 padding 的分界；63/64/65 覆盖跨块；再补几个更大的尺寸。
    for (const length of [1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000]) {
      const bytes = bytesOf(length, length);
      expect(sha256HexPure(bytes), `length=${length}`).toBe(reference(bytes));
    }
  });

  it("matches Node createHash for a large multi-block input", () => {
    const bytes = bytesOf(1024 * 1024, 9);
    expect(sha256HexPure(bytes)).toBe(reference(bytes));
  });

  it("matches Node createHash for the 55/56 marker-length boundary", () => {
    // 55 字节时 padding 恰好把长度字段塞进首块末尾；56 字节时首块放不下长度字段。
    for (const length of [55, 56]) {
      const bytes = bytesOf(length, 3);
      expect(sha256HexPure(bytes)).toBe(reference(bytes));
    }
  });
});

describe("sha256Hex / sha256Checksum", () => {
  it("prefers WebCrypto when available and agrees with the reference", async () => {
    // happy-dom 提供 crypto.subtle，此处验证门控开启前的优先路径仍产出一致摘要。
    const bytes = bytesOf(2048, 1);
    expect(await sha256Hex(bytes)).toBe(reference(bytes));
    expect(await sha256Checksum(bytes)).toBe(`sha256:${reference(bytes)}`);
  });
});
