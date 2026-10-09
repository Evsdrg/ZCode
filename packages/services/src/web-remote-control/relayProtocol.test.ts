import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRelayPairingQrUrl,
  calculateRelayProof,
  computeRelayFrameChecksum,
  createRelayPassHash,
  decodeRelayRpcFrameData,
  encodeRelayRpcFrames,
  isRelayBridgePayload,
  resolveRelayWsUrl,
} from "./relayProtocol.js";

describe("relay protocol", () => {
  it("calculateRelayProof 与官方客户端算法一致（PoC 实测通过的公式）", () => {
    const passHash = createHash("sha256").update("password").digest("base64");
    const nonce = "test-nonce";
    const sid = "test-device-sid";
    const expected = createHmac("sha256", passHash)
      .update(`${nonce}|device|${sid}`)
      .digest("base64url");
    expect(calculateRelayProof(passHash, nonce, "device", sid)).toBe(expected);
  });

  it("createRelayPassHash 是 sha256 base64", () => {
    expect(createRelayPassHash("abc")).toBe(createHash("sha256").update("abc").digest("base64"));
  });

  it("buildRelayPairingQrUrl 产出官方手机页 URL，含全部配对参数", () => {
    const url = new URL(
      buildRelayPairingQrUrl({
        deviceSid: "d_sid",
        passHash: "hash==",
        timestamp: 123,
        deviceMid: "mid-1",
        deviceName: "test-host",
        appVersion: "3.14.3",
      }),
    );
    expect(url.origin).toBe("https://zcode.z.ai");
    expect(url.pathname).toBe("/remote/v4");
    expect(url.searchParams.get("sid")).toBe("d_sid");
    expect(url.searchParams.get("hash")).toBe("hash==");
    expect(url.searchParams.get("t")).toBe("123");
    expect(url.searchParams.get("mid")).toBe("mid-1");
    expect(url.searchParams.get("name")).toBe("test-host");
    expect(url.searchParams.get("app_version")).toBe("3.14.3");
  });

  it("buildRelayPairingQrUrl 省略空的可选参数", () => {
    const url = new URL(
      buildRelayPairingQrUrl({
        deviceSid: "d_sid",
        passHash: "h",
        deviceMid: "m",
      }),
    );
    expect(url.searchParams.has("name")).toBe(false);
    expect(url.searchParams.has("app_version")).toBe(false);
  });

  it("resolveRelayWsUrl 支持环境变量覆盖与默认值", () => {
    expect(resolveRelayWsUrl({})).toBe("wss://zcode.z.ai/ws");
    expect(
      resolveRelayWsUrl({ ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "wss://example.com/ws" }),
    ).toBe("wss://example.com/ws");
    expect(resolveRelayWsUrl({ ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "  " })).toBe(
      "wss://zcode.z.ai/ws",
    );
  });
});

describe("relay bridge frame codec", () => {
  const identity = { bridgeSessionId: "bs-1", bridgeGeneration: 1, recoveryId: "r-1" };
  const payload = new TextEncoder().encode('{"jsonrpc":"2.0"}');

  it("encode：单片帧携带手机端 strict schema 要求的全部字段", () => {
    const frames = encodeRelayRpcFrames(identity, { messageSeq: 3, firstSeq: 7, bytes: payload });
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame).toMatchObject({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bs-1",
      bridgeGeneration: 1,
      recoveryId: "r-1",
      seq: 7,
      messageSeq: 3,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: payload.byteLength,
    });
    expect(frame.checksum.algorithm).toBe("crc32");
    expect(frame.checksum.value).toMatch(/^[0-9a-f]{8}$/);
  });

  it("CRC32 与官方算法一致（标准测试向量 123456789 → cbf43926）", () => {
    expect(computeRelayFrameChecksum(new TextEncoder().encode("123456789")).value).toBe("cbf43926");
  });

  it("encode → decode 往返保持字节一致", () => {
    const frame = encodeRelayRpcFrames(identity, {
      messageSeq: 1,
      firstSeq: 1,
      bytes: payload,
    })[0]!;
    const decoded = decodeRelayRpcFrameData(frame);
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!.buffer).toString("utf8")).toBe('{"jsonrpc":"2.0"}');
  });

  it("isRelayBridgePayload 只认 rpc-frame / rpc-frame-ack", () => {
    expect(isRelayBridgePayload({ zcode_type: "rpc-frame" })).toBe(true);
    expect(isRelayBridgePayload({ zcode_type: "rpc-frame-ack" })).toBe(true);
    expect(isRelayBridgePayload({ zcode_type: "workspace-list-updated" })).toBe(false);
    expect(isRelayBridgePayload(null)).toBe(false);
    expect(isRelayBridgePayload("data")).toBe(false);
  });

  it("decode 拒绝空数据", () => {
    expect(decodeRelayRpcFrameData({ dataBase64: "" })).toBeNull();
  });
});
