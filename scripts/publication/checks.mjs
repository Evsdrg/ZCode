import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const privatePath =
  /(?:^|\/)(?:\.local|\.zcode|\.claude|\.codex|\.secrets|\.scratch|\.local-notes|test-results|playwright-report|blob-report|node_modules|coverage|dist|dist-release|out|prebuilds|\.e2e-artifacts|\.e2e-network-capture)(?:\/|$)|(?:^|\/)docs\/(?:local|private)\//;
const runtimeName =
  /^(?:credentials(?:\..+)?\.json|auth\.json|agents-state\.json|provider_config\.json|id_rsa|id_ed25519)$/;
const generatedSuffix =
  /\.(?:log|sqlite|sqlite-wal|sqlite-shm|db|pcap|pcapng|har|pem|key|p12|pfx|tsbuildinfo|output|tmp|bak|rej)$/;
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["access-token", /(?:ghp_|github_pat_|sk-proj-|zk-local-mesh-)[A-Za-z0-9_-]{8,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
];

/**
 * 具体部署身份（公网/mesh 地址、主机名、账号）不能写进公开仓库，否则扫描器本身就泄露了它要守护的值。
 * 清单放在被忽略的 `.local/publication-identities.txt`（或环境变量指定的文件），每行一个正则，`#` 开头为注释。
 */
export const DEFAULT_IDENTITY_FILE = ".local/publication-identities.txt";

export function parseIdentityPatterns(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((source) => new RegExp(source));
}

export async function loadIdentityPatterns(
  path = process.env["ZCODE_PUBLICATION_IDENTITY_FILE"] || DEFAULT_IDENTITY_FILE,
) {
  try {
    return parseIdentityPatterns(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** 从 `git diff -U0` 输出中取新文件侧的新增行号；上游原有内容不归本 fork 负责。 */
export function addedLineNumbers(unifiedDiff) {
  const added = new Set();
  let next = 0;
  for (const line of unifiedDiff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.add(next++);
    else if (!line.startsWith("-") && !line.startsWith("\\")) next++;
  }
  return added;
}

/**
 * options.identityPatterns：私有部署身份正则；options.lines：只检查这些行号（缺省全部）。
 */
export function inspectPublicationText(path, text, options = {}) {
  const findings = [];
  if (privatePath.test(path) || runtimeName.test(basename(path)) || generatedSuffix.test(path)) {
    findings.push({ path, line: 0, kind: "private-or-generated-path" });
  }
  const checks = [
    ...patterns,
    ...(options.identityPatterns ?? []).map((pattern) => ["deployment-identity", pattern]),
  ];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (options.lines && !options.lines.has(index + 1)) continue;
    for (const [kind, pattern] of checks) {
      if (pattern.test(line)) findings.push({ path, line: index + 1, kind });
    }
    const match =
      /(?:api[_-]?key|password|auth[_-]?token|secret)\s*[:=]\s*["']([A-Za-z0-9_./+-]{20,})["']/iu.exec(
        line,
      );
    if (match && !/example|fixture|placeholder|test|password|sha256|dummy/iu.test(match[1])) {
      findings.push({ path, line: index + 1, kind: "secret-literal" });
    }
  }
  return findings;
}

export async function inspectPublicationFile(path, options = {}) {
  const data = await readFile(path);
  if (data.includes(0)) return inspectPublicationText(path, "", options);
  return inspectPublicationText(path, data.toString("utf8"), options);
}
