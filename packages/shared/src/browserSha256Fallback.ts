// 纯 JS SHA-256（FIPS 180-4），供私有部署在非安全上下文下兜底。
//
// 为什么单独成文件：只有 browserDigest 的门控分支会引用它。构建期把
// `ZCODE_PRIVATE_DEPLOYMENT` 常量化为 false 后，该分支连同本模块应被摇树移除，
// 线上 Web 与桌面产物不含此实现。
//
// 正确性要求：产物必须与 WebCrypto / Node `createHash("sha256")` 逐字节一致——服务端
// commit 会用客户端声明的 checksum 比对实际内容，不一致即拒绝。因此这里不做任何近似或
// 截断，只实现标准 SHA-256。
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 返回小写十六进制摘要（无 `sha256:` 前缀）。 */
export function sha256HexPure(bytes: Uint8Array): string {
  const byteLength = bytes.byteLength;
  const bitLength = byteLength * 8;
  // padding：0x80 + 若干 0，使总长 ≡ 56 (mod 64)，末尾 8 字节放原始比特长度（大端）。
  const withMarker = byteLength + 1;
  const padToBlock = (56 - (withMarker % 64) + 64) % 64;
  const padded = new Uint8Array(withMarker + padToBlock + 8);
  padded.set(bytes);
  padded[byteLength] = 0x80;
  const paddedView = new DataView(padded.buffer);
  // 比特长度可能超过 32 位，按大端拆成高/低两段写入。
  paddedView.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x100000000), false);
  paddedView.setUint32(padded.byteLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = paddedView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const prev15 = schedule[index - 15]!;
      const prev2 = schedule[index - 2]!;
      const s0 = rotr(prev15, 7) ^ rotr(prev15, 18) ^ (prev15 >>> 3);
      const s1 = rotr(prev2, 17) ^ rotr(prev2, 19) ^ (prev2 >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + choose + SHA256_K[index]! + schedule[index]!) >>> 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  let hex = "";
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    hex += word.toString(16).padStart(8, "0");
  }
  return hex;
}
