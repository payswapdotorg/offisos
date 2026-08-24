/**
 * Repository integration tests.
 *
 * Proves: the actual repository (state machine, registries, work-item
 * records) passes full validation; a corrupted record makes the whole
 * validation fail with an attributable check id; the CLI exits non-zero on
 * violations and on protected-path changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateRepository } from "../src/validate.js";
import { REPO_ROOT } from "./helpers.js";

test("the real repository passes full governance validation", () => {
  const { report, exitCode } = validateRepository(REPO_ROOT);
  const failed = report.checks.filter((c) => c.status === "fail");
  assert.deepEqual(
    failed.map((c) => `${c.id}: ${c.details?.join("; ")}`),
    [],
  );
  assert.equal(exitCode, 0);
  assert.ok(report.checks.length >= 30, "expected a substantial check suite");
});

test("the sample fixture demonstrates a full VERIFIED traceability chain", () => {
  const { report } = validateRepository(REPO_ROOT);
  const sampleChecks = report.checks.filter((c) => c.id.startsWith("work-item/SAMPLE-001/"));
  assert.equal(sampleChecks.length, 11); // schema + 10 lifecycle rule checks
  assert.ok(sampleChecks.every((c) => c.status === "pass"));
});

function copyRepoToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "offisos-repo-"));
  cpSync(join(REPO_ROOT, "governance"), join(dir, "governance"), { recursive: true });
  cpSync(join(REPO_ROOT, "spec"), join(dir, "spec"), { recursive: true });
  return dir;
}

test("a broken transition chain fails validation with an attributable check id", () => {
  const dir = copyRepoToTemp();
  const recordPath = join(dir, "governance", "work-items", "ARCH-WF-001.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.state = "READY"; // disagrees with the recorded history
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const { report, exitCode } = validateRepository(dir);
  assert.equal(exitCode, 1);
  const failed = report.checks.filter((c) => c.status === "fail");
  assert.ok(failed.some((c) => c.id === "work-item/ARCH-WF-001/transition-chain"));
  rmSync(dir, { recursive: true, force: true });
});

test("a VERIFIED record without evidence fails validation", () => {
  const dir = copyRepoToTemp();
  const recordPath = join(dir, "governance", "work-items", "ARCH-WF-001.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  // Forge an unsupported jump straight to VERIFIED with no evidence.
  record.state = "VERIFIED";
  record.transitions.push({
    from: "IMPLEMENTING",
    to: "VERIFIED",
    at: "2026-08-24T20:00:00Z",
    actor: "z-ai-implementation-agent",
    role: "implementer",
    reason: "implemented, therefore done",
    references: {},
  });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const { report, exitCode } = validateRepository(dir);
  assert.equal(exitCode, 1);
  const failedIds = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.ok(failedIds.includes("work-item/ARCH-WF-001/transition-legality"), `illegal transition must be caught, got: ${failedIds.join(", ")}`);
  rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(REPO_ROOT, "tools", "governance", "src", "cli.ts"), ...args],
    { cwd, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("CLI validate exits 0 on the real repository", () => {
  const result = runCli(["validate", "--root", REPO_ROOT], REPO_ROOT);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("Summary:"));
});

test("CLI check-protected exits 1 when a frozen artifact is changed", () => {
  const pathsFile = join(tmpdir(), `offisos-protected-${Date.now()}.txt`);
  writeFileSync(pathsFile, "spec/architecture-lock.md\n");
  const result = runCli(["check-protected", "--paths-file", pathsFile, "--root", REPO_ROOT], REPO_ROOT);
  rmSync(pathsFile, { force: true });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("Architecture Change Request"));
});

test("CLI check-protected exits 0 for ordinary changes", () => {
  const pathsFile = join(tmpdir(), `offisos-protected-ok-${Date.now()}.txt`);
  writeFileSync(pathsFile, "tools/governance/src/rules.ts\ngovernance/work-items/ARCH-WF-001.json\n");
  const result = runCli(["check-protected", "--paths-file", pathsFile, "--root", REPO_ROOT], REPO_ROOT);
  rmSync(pathsFile, { force: true });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
});
