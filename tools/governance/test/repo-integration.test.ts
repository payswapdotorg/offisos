/**
 * Repository integration tests.
 *
 * Proves: the actual repository's validation failures are EXACTLY the
 * failures expected from its own declared work-item states and historical
 * records (derived independently of the validator); a corrupted record
 * makes the whole validation fail with an attributable check id; the
 * CLI exits non-zero on violations and on protected-path changes.
 *
 * Dependency-gate semantics (updated per the RESEARCH-CAD-004 DEC-001
 * directive, PR #21 comment 5406944101): real work items may sit in
 * execution states while declared dependencies are MERGED but not yet
 * VERIFIED. That condition is a genuine, attributable validator failure
 * and MUST be reported — the dependency rule is not weakened here.
 *
 * ARCH-WF-002 historical-defect semantics: an already-merged work item
 * whose immutable ledger contains one of the three reconcilable defect
 * classes (unauthorized merge role, merge timestamp preceding the recorded
 * approval, no approved decision at or before the merge) produces exactly
 * those attributable failures UNTIL an Architect-decided reconciliation
 * (governance/reconciliations/) waives them. The expected failure set below
 * is recomputed DIRECTLY from the raw records and reconciliation files, so
 * the test passes both while the CAD-PARITY-011 reconciliation is STAGED
 * (three known failures — intentionally preserved) and after it is DECIDED
 * (failures cleared by the active waivers). A weakened validator that
 * stopped reporting an unreconciled defect — or one that waived it without
 * a DECIDED reconciliation — fails these assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Whether a DECIDED reconciliation record exists for the work item. */
function hasDecidedReconciliation(workItemId: string): boolean {
  const path = join(REPO_ROOT, "governance", "reconciliations", `${workItemId}.json`);
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, "utf8")).status === "DECIDED";
  } catch {
    return false;
  }
}

/**
 * Independently derive the unreconciled historical-defect failures the
 * repository SHOULD report: for every MERGED/VERIFIED work item lacking a
 * DECIDED reconciliation, the reconcilable defect classes present in its
 * raw ledger (plain JSON re-derivation, independent of the validator).
 */
function expectedHistoricalDefectFailures(): Map<string, string[]> {
  const machine = loadWorkflowStates(REPO_ROOT);
  const mergeActors = machine.transitions.find((t) => t.from === "APPROVED" && t.to === "MERGED")?.actors ?? [];
  const loaded = loadWorkItems(REPO_ROOT);
  const expected = new Map<string, string[]>();
  for (const { record } of loaded) {
    if (record.state !== "MERGED" && record.state !== "VERIFIED") continue;
    if (hasDecidedReconciliation(record.id)) continue;
    const failures: string[] = [];
    const decisions = record.decisions ?? [];
    for (const [index, transition] of record.transitions.entries()) {
      if (transition.to === "MERGED" && mergeActors.length > 0 && !mergeActors.includes(transition.role)) {
        failures.push("transition-legality");
      }
      if (index > 0 && Date.parse(transition.at) < Date.parse(record.transitions[index - 1]!.at)) {
        failures.push("temporal-ordering");
      }
    }
    const mergeEntry = [...record.transitions].reverse().find((t) => t.to === "MERGED");
    if (mergeEntry !== undefined) {
      const hasPriorApproved = decisions.some(
        (d) => d.status === "approved" && Date.parse(d.decided_at) <= Date.parse(mergeEntry.at),
      );
      if (!hasPriorApproved) {
        failures.push("decisions");
      }
    }
    if (failures.length > 0) {
      for (const rule of failures) {
        expected.set(`work-item/${record.id}/${rule}`, []);
      }
    }
  }
  return expected;
}

test("the real repository's failures are exactly the expected dependency-gate and unreconciled historical-defect failures", () => {
  const { report, exitCode } = validateRepository(REPO_ROOT);
  const expected = new Map([...expectedDependencyGateFailures(), ...expectedHistoricalDefectFailures()]);
  const failed = report.checks.filter((c) => c.status === "fail");
  // Both gates stay enforced in BOTH directions: a weakened validator
  // (missing expected failures) and an over-reporting one (unexpected
  // failures) both fail this assertion.
  assert.deepEqual(
    [...new Set(failed.map((c) => c.id))].sort(),
    [...expected.keys()].sort(),
    `unexpected validator outcome; expected exactly [${[...expected.keys()].join(", ")}]`,
  );
  // Each expected dependency-gate failure must reference the exact
  // un-VERIFIED dependency names (attributable messages).
  for (const check of failed) {
    const expectedDeps = expectedDependencyGateFailures().get(check.id) ?? [];
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
  assert.equal(sampleChecks.length, 12); // schema + 10 lifecycle rule checks + revision binding
  assert.ok(sampleChecks.every((c) => c.status === "pass"));
});

test("the ARCH-WF-002 registries are present and coherent (ACR-003, the staged P011 reconciliation, the decided demo)", () => {
  const { report } = validateRepository(REPO_ROOT);
  const byId = new Map(report.checks.map((c) => [c.id, c] as const));

  // ACR-003: the real reconciliation-pathway ACR — lifecycle-valid in either
  // PROPOSED (submission) or approved/implemented states.
  const acr003Lifecycle = byId.get("acr/ACR-003/lifecycle");
  assert.ok(acr003Lifecycle !== undefined, "ACR-003 must be registered");
  assert.equal(acr003Lifecycle.status, "pass");

  // The staged P011 reconciliation: facts and citations complete in both the
  // STAGED (submission — waivers inactive) and DECIDED (architect-approved)
  // states; the citation check reads the raw immutable ledger either way.
  const p011ReconciliationCitations = byId.get("reconciliation/CAD-PARITY-011/citations");
  assert.ok(p011ReconciliationCitations !== undefined, "the P011 reconciliation must exist");
  assert.equal(p011ReconciliationCitations.status, "pass", "all three citations must match the immutable ledger verbatim");
  const p011ReconciliationRecord = byId.get("reconciliation/CAD-PARITY-011/record")!;
  assert.equal(p011ReconciliationRecord.status, "pass");

  // The always-green demo pair: a DECIDED reconciliation with active waivers
  // (SAMPLE-002) and a fully-implemented demo ACR (ACR-901).
  assert.equal(byId.get("acr/ACR-901/lifecycle")!.status, "pass");
  assert.equal(byId.get("reconciliation/SAMPLE-002/record")!.status, "pass");
  assert.equal(byId.get("reconciliation/SAMPLE-002/citations")!.status, "pass");
  const activeWaivers = byId.get("reconciliation/active-waivers")!;
  assert.equal(activeWaivers.status, "pass");
  assert.ok(activeWaivers.description.includes("REC-SAMPLE-002"), "the demo reconciliation must be the active one at this head");
  const sampleLegality = byId.get("work-item/SAMPLE-002/transition-legality")!;
  assert.equal(sampleLegality.status, "pass");
  assert.ok((sampleLegality.details ?? []).join(" ").includes("[RECONCILED]"), "the demo waiver must be explicit, not silent");

  // The real work item's own ACR linkage is registered.
  const archWf002 = JSON.parse(readFileSync(join(REPO_ROOT, "governance", "work-items", "ARCH-WF-002.json"), "utf8"));
  assert.equal(archWf002.acr, "ACR-003", "ARCH-WF-002 must declare the ACR its protected-path change routes through");
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

test("CLI validate exits with the expected code on the real repository", () => {
  const expected = new Map([...expectedDependencyGateFailures(), ...expectedHistoricalDefectFailures()]);
  const result = runCli(["validate", "--root", REPO_ROOT], REPO_ROOT);
  // Exit code 0 only when no dependency-gate or unreconciled historical
  // failures are expected; 1 while genuine (attributable) failures exist.
  // The validator's non-zero exit is preserved, not bypassed.
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
