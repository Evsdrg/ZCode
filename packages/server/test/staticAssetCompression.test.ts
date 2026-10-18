import { afterEach, describe, expect, it } from "vitest";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import {
  STATIC_ASSET_COMPRESSION_MIN_BYTES,
  compressStaticAsset,
  isCompressibleStaticAsset,
  resetStaticAssetCompressionCache,
  selectStaticAssetEncoding,
} from "../src/staticAssetCompression.js";

describe("static asset compression", () => {
  afterEach(() => {
    resetStaticAssetCompressionCache();
  });

  describe("selectStaticAssetEncoding", () => {
    it("picks brotli when both brotli and gzip are acceptable", () => {
      expect(selectStaticAssetEncoding("gzip, deflate, br", "/app/index.js")).toBe("br");
    });

    it("picks gzip when brotli is not advertised", () => {
      expect(selectStaticAssetEncoding("gzip, deflate", "/app/index.js")).toBe("gzip");
    });

    it("accepts the x-gzip alias", () => {
      expect(selectStaticAssetEncoding("x-gzip", "/app/index.css")).toBe("gzip");
    });

    it("returns null when the header is missing", () => {
      expect(selectStaticAssetEncoding(undefined, "/app/index.js")).toBeNull();
    });

    it("returns null for identity-only clients", () => {
      expect(selectStaticAssetEncoding("identity", "/app/index.js")).toBeNull();
    });

    it("honours q=0 as an explicit rejection", () => {
      expect(selectStaticAssetEncoding("gzip;q=0, br", "/app/index.js")).toBe("br");
      expect(selectStaticAssetEncoding("gzip;q=0", "/app/index.js")).toBeNull();
    });

    it("prefers the encoding with the higher quality weight", () => {
      expect(selectStaticAssetEncoding("br;q=0.4, gzip;q=0.9", "/app/index.js")).toBe("gzip");
      expect(selectStaticAssetEncoding("br;q=0.9, gzip;q=0.4", "/app/index.js")).toBe("br");
    });

    it("never compresses already-compressed binaries", () => {
      for (const file of ["/a/logo.png", "/a/font.woff2", "/a/photo.jpg", "/a/archive.zip"]) {
        expect(selectStaticAssetEncoding("gzip, br", file)).toBeNull();
      }
    });

    it("compresses text-like assets", () => {
      for (const file of ["/a/index.js", "/a/style.css", "/a/index.html", "/a/app.json"]) {
        expect(isCompressibleStaticAsset(file)).toBe(true);
      }
    });
  });

  describe("compressStaticAsset", () => {
    const source = new TextEncoder().encode("console.log('zcode');".repeat(200));

    it("round-trips through gzip", async () => {
      const compressed = await compressStaticAsset(source, "gzip", "gzip-key");
      expect(compressed.byteLength).toBeLessThan(source.byteLength);
      expect(new Uint8Array(gunzipSync(compressed))).toEqual(source);
    });

    it("round-trips through brotli", async () => {
      const compressed = await compressStaticAsset(source, "br", "br-key");
      expect(compressed.byteLength).toBeLessThan(source.byteLength);
      expect(new Uint8Array(brotliDecompressSync(compressed))).toEqual(source);
    });

    it("caches by key and encoding", async () => {
      const first = await compressStaticAsset(source, "gzip", "same-key");
      const second = await compressStaticAsset(source, "gzip", "same-key");
      expect(second).toBe(first);
    });

    it("keeps separate cache entries per encoding", async () => {
      const gz = await compressStaticAsset(source, "gzip", "shared-key");
      const br = await compressStaticAsset(source, "br", "shared-key");
      expect(br).not.toBe(gz);
      expect(new Uint8Array(gunzipSync(gz))).toEqual(source);
      expect(new Uint8Array(brotliDecompressSync(br))).toEqual(source);
    });

    it("shares one compression across concurrent callers", async () => {
      const [a, b, c] = await Promise.all([
        compressStaticAsset(source, "gzip", "concurrent"),
        compressStaticAsset(source, "gzip", "concurrent"),
        compressStaticAsset(source, "gzip", "concurrent"),
      ]);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it("exposes a threshold above the smallest useful asset", () => {
      expect(STATIC_ASSET_COMPRESSION_MIN_BYTES).toBeGreaterThanOrEqual(512);
    });
  });
});
