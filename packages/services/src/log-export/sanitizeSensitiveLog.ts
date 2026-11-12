/**
 * 日志脱敏：把日志文本里的凭据替换成 ***REDACTED***。
 *
 * 从 desktop 的 exportLogs.ts 抽出。判定方式是「按值形态 + 键名族 + 白名单例外」的组合，
 * 不是固定键名清单：键名含 password/secret/token/auth 等子串即脱敏，再放行
 * input_tokens / max_tokens / author 这类普通字段，避免把排障需要的上下文也抹掉。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const REDACTED_PLACEHOLDER = "***REDACTED***";

// 从而覆盖自定义命名（如 db_password、my_secret、x-conn-string 等）而不必逐个精确列举。
// 注意：`token` / `auth` 等是宽松子串，配合下方白名单排除误伤项（如 input_tokens、author）。
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// 白名单：命中敏感子串但实际并非密钥的常见键名，避免脱掉排障需要的上下文。
// 不能把任意 "*_tokens" 都白名单化，否则 access_tokens/session_tokens 会被原样导出；
// max_tokens/budget_tokens 是模型输出与思考预算，不是凭据，需保留用于判断 provider 请求是否撞限；
// 因此这里只放行明确的 LLM token 计数/预算字段，以及 author/authority 这类含 "auth" 的普通词。
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX =
  /^(?:public(?:_|-)?key|keywords?|tokenizer|token(?:_|-)?count|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|accepted(?:_|-)?prediction|rejected(?:_|-)?prediction|tool(?:_|-)?use(?:_|-)?prompt)(?:_|-)?tokens|author(?:s|ity|ed)?)$/i;

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// 以下正则先宽松捕获“键名 + 值”，再由 isSensitiveKeyName 决定是否脱敏，
// 这样键名黑名单不再是硬编码列表，而是“敏感族 + 通配 + 白名单例外”。
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// 按“值形态”脱敏：连接串 scheme://user:pass@host 里的凭据部分，
// 不依赖键名即可覆盖 postgres/mysql/mongodb/redis/amqp 等数据库连接信息。保留 scheme 与 host 便于排障。
// 用户名段允许为空以覆盖 redis://:password@host；口令段贪婪匹配到最后一个 @（host 段不含 @），
// 这样口令里含裸 @（如 P@ssw0rd）也能整段脱敏，不残留片段。
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

function redactValue(rawValue: string): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

function sanitizeSensitiveLogContent(rawContent: string): string {
  // 导出日志不能按文件原样拷贝：会把用户配置和协议日志里的 token/apiKey 一并带出。
  // 线上排障需要“保留文件结构和上下文”，但不应该泄露密钥本体；
  // 这里在导出阶段统一对常见敏感值做脱敏，字段和日志行仍完整保留，支持继续定位问题。
  // 键名不再是硬编码黑名单，而是“敏感键名族 + 子串通配 + 白名单例外”（isSensitiveKeyName），
  // 并叠加按值形态的连接串脱敏，以覆盖数据库连接串等自定义命名的敏感信息。
  return redactConnectionStringCredentials(rawContent)
    .replace(
      JSON_STYLE_SENSITIVE_VALUE_REGEX,
      (match, quote: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${quote}${keyName}${quote}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}

function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // CJK 文本里会出现“单个码元低字节刚好是 0”的情况（如 U+4E00），
  // 直接统计 `0x00 + ASCII` 配对会把这些离散噪声误判成另一端字节序。
  // 这里改为统计“连续 ASCII-零字节 run”，只把成段英文 token（api key/header）作为有效信号。
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

export function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // CJK 占比高的 UTF-16 无 BOM 文本，空字节比例可能很低，
  // 仅靠 null-ratio 会被误判为“非文本”并走原样复制，导致敏感字段漏脱敏。
  // 这里增加“ASCII-零字节对”兜底检测（例如 `OPENAI_API_KEY=\r\n`），覆盖真实日志中的混合文本场景。
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // 无 BOM 且不含空字节的 UTF-16 文本，在纯 CJK 内容里经常出现。
    // 这类样本 UTF-8 fatal decode 会失败；此时按 UTF-8 处理会产生乱码并漏掉敏感字段匹配。
    // 兜底策略：UTF-8 合法则按 UTF-8，非法且无法识别成 UTF-16 时才视为二进制。
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}

export async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}
