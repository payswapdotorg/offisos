/**
 * Repository integration tests.
 *
 * Proves: the actual repository's validation failures are EXACTLY the
 * dependency-gate failures expected from its own declared work-item
 * states (derived independently of the validator); a corrupted record
 * makes the whole validation fail with an attributable check id; the
 * CLI exits non-zero on violations and on protected-path changes.
 *
 * Dependency-gate semantics (updated per the RESEARCH-CAD-004 DEC-001
 * directive, PR #21 comment 5406944101): real work items may sit in
 * execution states while declared dependencies are MERGED but not yet
 * VERIFIED. That condition is a genuine, attributable validator failure
 * and MUST be reported — the dependency rule is not weakened here.
 *
 * How these tests keep the rule enforced: the expected failure set is
 * recomputed DIRECTLY from the work-item records and their dependency
 * states (not from validator output). A weakened validator (one that
 * stopped reporting a real violation) would produce fewer failures than
 * expected and FAIL these tests; an over-reporting validator would
 * produce unexpected failures and also FAIL them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateRepository } from "../src/validate.js";
import { loadWorkItems, loadWorkflowStates } from "../src/loaders.js";
import { executionStates } from "../src/state-machine.js";
import { REPO_ROOT } from "./helpers.js";

/**
 * Independently derive the dependency-gate failures the repository
 * SHOULD report: for every non-demo work item in an execution state,
 * every declared dependency that does not resolve to a VERIFIED record.
 *
 * Returns check id -> un-VERIFIED (or unresolved) dependency names.
 */
function expectedDependencyGateFailures(): Map<string, string[]> {
  const machine = loadWorkflowStates(REPO_ROOT);
  const execution = executionStates(machine);
  const loaded = loadWorkItems(REPO_ROOT);
  const registry = new Map(
    loaded
      .filter((l) => l.record.demo !== true)
      .map((l) => [l.record.id, l.record] as const),
  );
  const expected = new Map<string, string[]>();
  for (const { record } of loaded) {
    if (record.demo === true) continue;
    if (!execution.has(record.state)) continue;
    const unverified = record.dependencies.filter((dep) => {
      const depRecord = registry.get(dep);
      return depRecord === undefined || depRecord.state !== "VERIFIED";
    });
    if (unverified.length > 0) {
      expected.set(`work-item/${record.id}/dependencies`, unverified);
    }
  }
  return expected;
}

test("the real repository's failures are exactly the expected dependency-gate failures", () => {
  const { report, exitCode } = validateRepository(REPO_ROOT);
  const expected = expectedDependencyGateFailures();
  const failed = report.checks.filter((c) => c.status === "fail");
  // The dependency gate stays enforced in BOTH directions: a weakened
  // validator (missing expected failures) and an over-reporting one
  // (unexpected failures) both fail this assertion.
  assert.deepEqual(
    [...new Set(failed.map((c) => c.id))].sort(),
    [...expected.keys()].sort(),
    `unexpected validator outcome; expected exactly [${[...expected.keys()].join(", ")}]`,
  );
  // Each expected dependency-gate failure must reference the exact
  // un-VERIFIED dependency names (attributable messages).
  for (const check of failed) {
    const expectedDeps = expected.get(check.id) ?? [];
    for (const dep of expectedDeps) {
      assert.ok(
        (check.details ?? []).some((d) => d.includes(`'${dep}'`)),
        `failure details for ${check.id} must reference dependency '${dep}'`,
      );
    }
  }
  assert.equal(exitCode, expected.size > 0 ? 1 : 0);
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

test("CLI validate exits with the dependency-gate-derived code on the real repository", () => {
  const expected = expectedDependencyGateFailures();
  const result = runCli(["validate", "--root", REPO_ROOT], REPO_ROOT);
  // Exit code 0 only when no dependency-gate failures are expected; 1
  // while genuine (attributable) dependency-gate failures exist. The
  // validator's non-zero exit is preserved, not bypassed.
  assert.equal(
    result.status,
    expected.size > 0 ? 1 : 0,
    `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
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
