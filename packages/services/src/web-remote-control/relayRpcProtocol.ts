import { Emitter, VSBuffer } from "@zcode/rpc";

/**
 * 无帧头 RPC 协议适配。
 *
 * 官方手机端（3.12.x web 构建）的 ChannelClient 直接收发序列化字节流（tag 格式），
 * 没有我们 SocketProtocol 的 13 字节二进制帧头。帧头首字节会被它的反序列化器误读为
 * String 标签，switch 无匹配分支后静默 return——ChannelClient 永远停在 Uninitialized，
 * UI 一个 RPC 都不会发出（实测即"已配对，正在加载工作区…"卡死）。因此桥内双向都是
 * 纯序列化字节：入站（手机→server）直接喂 ChannelServer，出站原样封进 rpc-frame。
 * 双方 serialize 格式逐字节兼容（body 同为 04 01 06 c8 01 式 tag 流）。
 */
export class RelayRpcProtocol {
  private readonly messageEmitter = new Emitter<VSBuffer>();
  readonly onMessage = this.messageEmitter.event;
  private ended = false;

  fireInbound(buffer: VSBuffer): void {
    if (!this.ended) this.messageEmitter.fire(buffer);
  }

  send(buffer: VSBuffer): void {
    if (this.ended) return;
    this.outbound?.(buffer);
  }

  /** 桥挂载时注入出站方向；dispose 后拒绝继续发送。 */
  outbound: ((buffer: VSBuffer) => void) | null = null;

  end(): void {
    this.ended = true;
  }

  dispose(): void {
    this.ended = true;
    this.messageEmitter.dispose();
  }
}
