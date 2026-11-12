/**
 * 媒体预览的 HTTP Range 解析（服务端）。
 *
 * 语义与桌面端 `remoteMediaPreviewProxyHelpers.parseRange` 保持一致：
 * - 只接受单区间 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；
 * - 多区间、非 bytes 单位、空区间、越界起点、end < start 一律视为非法（调用方回 416）；
 * - 无 Range 头返回 undefined（调用方回 200 全量）。
 *
 * 音视频元素依赖 Range 做 seek 与元数据探测：缺少 206/Content-Range 时，moov 位于
 * mdat 之后的 MP4 会被判为不可播放，长视频也无法拖动进度。
 */
export type MediaByteRange = { start: number; end: number };

export function parseMediaByteRange(
  value: string | undefined,
  size: number,
): MediaByteRange | undefined | "invalid" {
  if (!value) return undefined;
  if (!value.startsWith("bytes=") || value.slice("bytes=".length).includes(",")) {
    return "invalid";
  }
  const [startValue, endValue] = value.slice("bytes=".length).split("-", 2);
  if (!startValue && !endValue) return "invalid";
  if (size === 0) return "invalid";
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}
