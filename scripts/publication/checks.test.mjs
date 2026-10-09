import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicationText } from "./checks.mjs";

test("detect private keys, access tokens and JWT without returning matched values", () => {
  const key = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
  const token = "gh" + "p_" + "A".repeat(32);
  const jwt = "ey" + "J" + "A".repeat(20) + "." + "B".repeat(30) + "." + "C".repeat(30);
  const findings = inspectPublicationText("fixture.txt", [key, token, jwt].join("\n"));
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ["private-key", "access-token", "jwt"],
  );
  assert.ok(!JSON.stringify(findings).includes(token));
});

test("reject runtime artifacts but preserve product specs, tests and upstream declarations", () => {
  for (const path of [
    ".local/deploy/private.md",
    ".zcode/v2/state.json",
    "test-results/page.png",
    "packages/web/dist/index.js",
    "credentials.json",
    "capture.har",
    "example.sqlite",
  ]) {
    assert.ok(inspectPublicationText(path, "").length > 0, path);
  }
  for (const path of [
    "docs/specs/attachments.md",
    "src/attachment.test.ts",
    ".agents/skills/example/SKILL.md",
    "packages/desktop/src/shared/example.d.ts",
  ]) {
    assert.deepEqual(inspectPublicationText(path, ""), [], path);
  }
});

test("secret assignment catches real-looking values but permits explicit fixtures", () => {
  const value = "Q".repeat(28);
  const results = inspectPublicationText("config.ts", `apiKey: '${value}'`);
  assert.equal(results[0].kind, "secret-literal");
  assert.deepEqual(
    inspectPublicationText("fixture.ts", "apiKey: 'test-fixture-value-not-a-secret'"),
    [],
  );
});
