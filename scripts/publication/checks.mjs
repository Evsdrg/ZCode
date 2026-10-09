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
  [
    "deployment-identity",
    new RegExp(
      [
        "121\\.89\\.93\\.245",
        "10\\.126\\.126\\.[0-9]+",
        "192\\.168\\.5\\.[0-9]+",
        "/home/" + "cepvor",
        "aosc" + "-usb",
        "aliyun" + "W",
      ].join("|"),
    ),
  ],
];

export function inspectPublicationText(path, text) {
  const findings = [];
  if (privatePath.test(path) || runtimeName.test(basename(path)) || generatedSuffix.test(path)) {
    findings.push({ path, line: 0, kind: "private-or-generated-path" });
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const [kind, pattern] of patterns) {
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

export async function inspectPublicationFile(path) {
  const data = await readFile(path);
  if (data.includes(0)) return inspectPublicationText(path, "");
  return inspectPublicationText(path, data.toString("utf8"));
}
