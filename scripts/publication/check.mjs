import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectPublicationFile, inspectPublicationText } from "./checks.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const base = option("--base") ?? "origin/main";
const historyBase = option("--history-base");
async function git(...params) {
  return (await exec("git", params, { maxBuffer: 64 * 1024 * 1024 })).stdout;
}
const names = (value) => value.split("\0").filter(Boolean);
const tracked = names(await git("ls-files", "-z"));
const fresh = names(await git("ls-files", "--others", "--exclude-standard", "-z"));
const changed = names(await git("diff", "--name-only", "--diff-filter=ACMR", "-z", base));
const candidates = new Set([...changed, ...fresh]);
const findings = [];
for (const file of tracked) findings.push(...inspectPublicationText(file, ""));
for (const file of candidates) {
  try {
    findings.push(...(await inspectPublicationFile(file)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
let commitCount = 0;
if (historyBase) {
  const commits = (await git("rev-list", "--reverse", `${historyBase}..HEAD`))
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    commitCount++;
    const files = names(
      await git(
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "--diff-filter=ACMR",
        "-r",
        "-z",
        commit,
      ),
    );
    for (const file of files) {
      const text = await git("show", `${commit}:${file}`);
      findings.push(
        ...inspectPublicationText(file, text).map((finding) => ({
          ...finding,
          commit: commit.slice(0, 12),
        })),
      );
    }
    findings.push(
      ...inspectPublicationText(
        "commit-message",
        await git("show", "-s", "--format=%B", commit),
      ).map((finding) => ({ ...finding, commit: commit.slice(0, 12) })),
    );
  }
}
const unique = new Map(findings.map((finding) => [JSON.stringify(finding), finding]));
for (const finding of unique.values()) process.stderr.write(`${JSON.stringify(finding)}\n`);
if (unique.size) {
  process.stderr.write(
    `[publication] failed: ${unique.size} findings; values intentionally omitted\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[publication] OK: ${tracked.length} tracked paths, ${candidates.size} candidate files, ${commitCount} new commits\n`,
  );
}
