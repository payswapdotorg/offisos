/**
 * Protected-path tests.
 *
 * Proves: pattern matching works for exact paths and directory-tree globs;
 * the real manifest detects changes to frozen architecture artifacts; the
 * failure message routes to the Architecture Change Request process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProtectedPaths,
  globToRegex,
  matchProtectedPath,
  protectedPathsCheckResult,
} from "../src/protected-paths.js";
import { loadProtectedPaths } from "../src/loaders.js";
import { REPO_ROOT } from "./helpers.js";

test("exact patterns match only the exact path", () => {
  const regex = globToRegex("spec/architecture.md");
  assert.ok(regex.test("spec/architecture.md"));
  assert.ok(!regex.test("spec/architecture.md.bak"));
  assert.ok(!regex.test("docs/spec/architecture.md"));
  assert.ok(!regex.test("spec/architecture-lock.md"));
});

test("directory-tree globs match nested paths only under the tree", () => {
  const regex = globToRegex("spec/adr/**");
  assert.ok(regex.test("spec/adr/001-modular-monolith.md"));
  assert.ok(regex.test("spec/adr/nested/deep/decision.md"));
  assert.ok(!regex.test("spec/adrenaline/file.md"));
  assert.ok(!regex.test("spec/adr"));
  assert.ok(!regex.test("other/adr/001.md"));
});

test("single-star globs do not cross directory boundaries", () => {
  const regex = globToRegex("tools/*");
  assert.ok(regex.test("tools/cli.ts"));
  assert.ok(!regex.test("tools/governance/cli.ts"));
});

test("the real manifest flags frozen architecture artifacts", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    [
      "spec/architecture.md",
      "spec/architecture-lock.md",
      "spec/adr/001-modular-monolith.md",
      "tools/governance/src/cli.ts",
      "governance/work-items/ARCH-WF-001.json",
      "spec/requirements.md", // tracked by spec but NOT in the protected manifest
    ],
    manifest,
  );
  const violatedPaths = violations.map((v) => v.path).sort();
  assert.deepEqual(violatedPaths, [
    "spec/adr/001-modular-monolith.md",
    "spec/architecture-lock.md",
    "spec/architecture.md",
  ].sort());
});

test("ordinary implementation changes pass the protected check", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const violations = checkProtectedPaths(
    ["tools/governance/src/rules.ts", "governance/work-items/RESEARCH-CAD-001.json", "package.json"],
    manifest,
  );
  assert.deepEqual(violations, []);
});

test("a protected change fails with ACR routing guidance", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const result = protectedPathsCheckResult(["spec/architecture-lock.md"], manifest);
  assert.equal(result.status, "fail");
  const message = (result.details ?? []).join(" ");
  assert.ok(message.includes("Architecture Change Request"), "must route to the ACR process");
});

test("check-protected reads changed paths from a paths file", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const dir = mkdtempSync(join(tmpdir(), "offisos-paths-"));
  const pathsFile = join(dir, "changed.txt");
  writeFileSync(pathsFile, "README.md\nspec/adr/002-provider-independent-ai.md\n\n  \n");
  const changed = readPathsFile(pathsFile);
  const violations = checkProtectedPaths(changed, manifest);
  assert.deepEqual(violations.map((v) => v.path), ["spec/adr/002-provider-independent-ai.md"]);
  rmSync(dir, { recursive: true, force: true });
});

function readPathsFile(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}
