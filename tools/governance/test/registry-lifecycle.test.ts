/**
 * Registry lifecycle-transition authorization tests (ARCH-WF-002 remediation,
 * Issue #12 — the Architect's CHANGES REQUESTED ruling on PR #101).
 *
 * Proves the finite bootstrap/lifecycle rule that breaks the circular ACR
 * authorization:
 *   - ACR lifecycle transitions are narrowly authorized (single-gate edges
 *     and monotone compositions, each gate instrument role-correct and newly
 *     added, changed keys exactly {status} + instruments);
 *   - the reconciliation decision (STAGED → DECIDED) is narrowly authorized;
 *   - ORDINARY MODIFICATIONS to existing ACR/reconciliation records remain
 *     blocked (the ruling's explicit required proof): prose amendments,
 *     authorized_paths edits, evidence/citation changes, instrument
 *     replacement, key removal, id changes, deletions, status jumps,
 *     backwards moves, role violations;
 *   - the check fails closed when the before/after content cannot be read;
 *   - the real manifest declares the lifecycle kinds for both registries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isLegalRegistryLifecycleTransition } from "../src/registry-lifecycle.js";
import {
  checkProtectedPathsWithRouting,
  protectedPathsCheckResult,
  type RecordPairReader,
} from "../src/protected-paths.js";
import { loadProtectedPaths } from "../src/loaders.js";
import { REPO_ROOT } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const ACR_PROPOSED: Record<string, unknown> = {
  id: "ACR-004",
  title: "A test proposal",
  status: "PROPOSED",
  requested_by: "pectoraux",
  requested_at: "2026-08-30T19:00:00Z",
  problem: "A problem.",
  evidence: ["evidence one"],
  impact: "An impact.",
  alternatives: ["alternative one"],
  recommendation: "A recommendation.",
  migration_plan: "A plan.",
  compatibility: "Compatibility.",
  security_impact: "Impact.",
  affected_requirements: ["FLOW-001"],
  affected_work_items: ["ARCH-WF-002"],
  architecture_version_from: "1.1",
  architecture_version_to: "1.1",
  authorized_paths: ["governance/schemas/x.schema.json"],
};

function acrVariant(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...ACR_PROPOSED, ...overrides };
}

const REVIEW = {
  reviewed_by: "pectoraux",
  role: "architect",
  reviewed_at: "2026-08-30T20:00:00Z",
  verdict: "endorsed",
  rationale: "Sound.",
};
const APPROVAL = {
  approved_by: "pectoraux",
  role: "product-owner",
  approved_at: "2026-08-30T21:00:00Z",
  decision: "approved",
  rationale: "Authorized.",
};
const IMPLEMENTATION = {
  work_item: "ARCH-WF-002",
  references: { pr: 101, commit: "8fb0736" },
};

const REC_STAGED: Record<string, unknown> = {
  id: "REC-TEST-001",
  work_item: "TEST-001",
  status: "STAGED",
  problem: "A staged problem.",
  defects: [],
  evidence: [],
  acr: "ACR-004",
};

const DECISION_FIELDS = {
  decided_by: "pectoraux",
  role: "architect",
  decided_at: "2026-08-30T22:00:00Z",
  rationale: "The physical history supports the reconciliation.",
  remediation: "The item may proceed to VERIFIED through the normal path.",
};

const acr = isLegalRegistryLifecycleTransition.bind(null, "acr");
const rec = isLegalRegistryLifecycleTransition.bind(null, "reconciliation");

// ---------------------------------------------------------------------------
// ACR lifecycle edges: authorized.
// ---------------------------------------------------------------------------

test("acr: PROPOSED → ENDORSED (architect review) is authorized", () => {
  const after = acrVariant({ status: "ENDORSED", review: REVIEW });
  const outcome = acr(ACR_PROPOSED, after);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.edge, "PROPOSED → ENDORSED");
  assert.deepEqual(outcome.instruments, ["review"]);
});

test("acr: ENDORSED → APPROVED (product-owner approval) is authorized", () => {
  const before = acrVariant({ status: "ENDORSED", review: REVIEW });
  const after = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const outcome = acr(before, after);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.instruments, ["approval"]);
});

test("acr: APPROVED → IMPLEMENTED (implementation linkage) is authorized", () => {
  const before = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const after = acrVariant({
    status: "IMPLEMENTED",
    review: REVIEW,
    approval: APPROVAL,
    implementation: IMPLEMENTATION,
  });
  const outcome = acr(before, after);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.instruments, ["implementation"]);
});

test("acr: PROPOSED → REJECTED via architect rejection is authorized", () => {
  const after = acrVariant({
    status: "REJECTED",
    review: { ...REVIEW, verdict: "rejected" },
  });
  assert.equal(acr(ACR_PROPOSED, after).ok, true);
});

test("acr: ENDORSED → REJECTED via product-owner rejection is authorized", () => {
  const before = acrVariant({ status: "ENDORSED", review: REVIEW });
  const after = acrVariant({
    status: "REJECTED",
    review: REVIEW,
    approval: { ...APPROVAL, decision: "rejected" },
  });
  assert.equal(acr(before, after).ok, true);
});

test("acr: composed PROPOSED → APPROVED (both gates in one change) is authorized — the documented Architect act on ACR-003", () => {
  const after = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const outcome = acr(ACR_PROPOSED, after);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.edge, "PROPOSED → APPROVED");
  assert.deepEqual(outcome.instruments, ["approval", "review"]);
});

test("acr: composed PROPOSED → IMPLEMENTED (all three instruments) is authorized", () => {
  const after = acrVariant({
    status: "IMPLEMENTED",
    review: REVIEW,
    approval: APPROVAL,
    implementation: IMPLEMENTATION,
  });
  assert.equal(acr(ACR_PROPOSED, after).ok, true);
});

test("acr: composed ENDORSED → IMPLEMENTED is authorized", () => {
  const before = acrVariant({ status: "ENDORSED", review: REVIEW });
  const after = acrVariant({
    status: "IMPLEMENTED",
    review: REVIEW,
    approval: APPROVAL,
    implementation: IMPLEMENTATION,
  });
  assert.equal(acr(before, after).ok, true);
});

// ---------------------------------------------------------------------------
// ACR: status jumps and illegal edges are blocked.
// ---------------------------------------------------------------------------

test("acr: PROPOSED → APPROVED without the architect review (missing gate) is blocked", () => {
  const after = acrVariant({ status: "APPROVED", approval: APPROVAL });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("acr: PROPOSED → IMPLEMENTED skipping the gates is blocked", () => {
  const after = acrVariant({ status: "IMPLEMENTED", implementation: IMPLEMENTATION });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("acr: backwards APPROVED → ENDORSED is blocked", () => {
  const before = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const after = acrVariant({ status: "ENDORSED", review: REVIEW });
  assert.equal(acr(before, after).ok, false);
});

test("acr: an ENDORSED verdict recorded while status stays PROPOSED is not a transition", () => {
  // Adding the review object without advancing the status is an ordinary edit.
  const after = acrVariant({ review: REVIEW });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

// ---------------------------------------------------------------------------
// THE RULING'S REQUIRED PROOF: ordinary modifications to existing records
// remain blocked.
// ---------------------------------------------------------------------------

test("BLOCKED (required proof): editing an ACR's authorized_paths without a lifecycle transition", () => {
  const after = acrVariant({
    authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
  });
  const outcome = acr(ACR_PROPOSED, after);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /ordinary modification/);
  assert.match(outcome.reason!, /authorized_paths/);
});

test("BLOCKED (required proof): smuggling an authorized_paths expansion inside a legal transition is blocked", () => {
  const after = acrVariant({
    status: "APPROVED",
    review: REVIEW,
    approval: APPROVAL,
    authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
  });
  const outcome = acr(ACR_PROPOSED, after);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /ordinary modification/);
  assert.match(outcome.reason!, /authorized_paths/);
});

test("BLOCKED (required proof): prose amendment of an existing ACR (title/problem) is blocked", () => {
  const after = acrVariant({ title: "A retitled proposal", problem: "A different problem." });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("BLOCKED (required proof): evidence/provenance edits to an existing ACR are blocked", () => {
  const after = acrVariant({ evidence: ["evidence one", "evidence two"], provenance: "amended" });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("BLOCKED (required proof): removing fields from an existing ACR is blocked", () => {
  const after = acrVariant({});
  delete (after as Partial<Record<string, unknown>>)["alternatives"];
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("BLOCKED (required proof): changing a record's id is blocked", () => {
  const after = acrVariant({ id: "ACR-005" });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("BLOCKED (required proof): replacing an already-recorded approval is blocked", () => {
  const before = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const after = acrVariant({
    status: "APPROVED",
    review: REVIEW,
    approval: { ...APPROVAL, approved_at: "2026-08-30T23:00:00Z", rationale: "Re-signed." },
  });
  assert.equal(acr(before, after).ok, false);
});

test("BLOCKED: gate instruments with the wrong authorizing role are blocked", () => {
  // review recorded under the product-owner role.
  assert.equal(acr(ACR_PROPOSED, acrVariant({ status: "ENDORSED", review: { ...REVIEW, role: "product-owner" } })).ok, false);
  // approval recorded under the architect role.
  assert.equal(acr(ACR_PROPOSED, acrVariant({ status: "APPROVED", review: REVIEW, approval: { ...APPROVAL, role: "architect" } })).ok, false);
});

test("BLOCKED: ENDORSED status with a rejecting review verdict is blocked", () => {
  const after = acrVariant({ status: "ENDORSED", review: { ...REVIEW, verdict: "rejected" } });
  assert.equal(acr(ACR_PROPOSED, after).ok, false);
});

test("BLOCKED: malformed records (non-objects, missing status) fail closed", () => {
  assert.equal(acr("not a record", ACR_PROPOSED).ok, false);
  assert.equal(acr(ACR_PROPOSED, null).ok, false);
  assert.equal(acr({ id: "ACR-004" }, { id: "ACR-004", status: "ENDORSED" }).ok, false);
});

// ---------------------------------------------------------------------------
// Reconciliation decisions.
// ---------------------------------------------------------------------------

test("reconciliation: STAGED → DECIDED with exactly the decision fields is authorized", () => {
  const after = { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS };
  const outcome = rec(REC_STAGED, after);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.edge, "STAGED → DECIDED");
  assert.deepEqual(outcome.instruments, ["decided_at", "decided_by", "rationale", "remediation", "role"]);
});

test("BLOCKED (required proof): the reconciliation decision cannot smuggle edits to the facts", () => {
  const after = {
    ...REC_STAGED,
    status: "DECIDED",
    ...DECISION_FIELDS,
    problem: "A rewritten problem.",
  };
  const outcome = rec(REC_STAGED, after);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /ordinary modification/);
});

test("BLOCKED (required proof): editing a staged reconciliation's citations/evidence/acr is blocked", () => {
  const after = { ...REC_STAGED, evidence: ["new evidence"], acr: "ACR-999" };
  assert.equal(rec(REC_STAGED, after).ok, false);
});

test("BLOCKED (required proof): a DECIDED reconciliation cannot be reverted to STAGED", () => {
  const before = { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS };
  assert.equal(rec(before, REC_STAGED).ok, false);
});

test("BLOCKED (required proof): a decided reconciliation's rationale cannot be amended afterwards", () => {
  const before = { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS };
  const after = { ...before, rationale: "An amended rationale." };
  assert.equal(rec(before, after).ok, false);
});

test("BLOCKED: the reconciliation decision under the wrong role is blocked", () => {
  const after = { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS, role: "product-owner" };
  assert.equal(rec(REC_STAGED, after).ok, false);
});

test("BLOCKED: a partial decision (missing decision fields) is blocked", () => {
  const after = { ...REC_STAGED, status: "DECIDED", decided_by: "pectoraux" };
  assert.equal(rec(REC_STAGED, after).ok, false);
});

test("BLOCKED: changing a reconciliation's work_item identity is blocked", () => {
  const after = { ...REC_STAGED, work_item: "TEST-002" };
  assert.equal(rec(REC_STAGED, after).ok, false);
});

// ---------------------------------------------------------------------------
// Integration with the protected-path check.
// ---------------------------------------------------------------------------

/** A minimal manifest with the two lifecycle-managed registry patterns. */
const LIFECYCLE_MANIFEST = {
  architecture_version: "1.1",
  patterns: [
    {
      pattern: "governance/acr/**",
      reason: "ACR registry",
      additions: "allowed" as const,
      lifecycle: "acr" as const,
    },
    {
      pattern: "governance/reconciliations/**",
      reason: "Reconciliation registry",
      additions: "allowed" as const,
      lifecycle: "reconciliation" as const,
    },
  ],
};

function readerWith(pairs: Record<string, { before?: unknown; after?: unknown }>): RecordPairReader {
  return (path) => pairs[path];
}

test("integration: a legal ACR lifecycle modification is waived and reported explicitly", () => {
  const path = "governance/acr/ACR-004.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true, // the record exists on the base: a modification
    registryLifecycle: {
      readRecordPair: readerWith({
        [path]: { before: ACR_PROPOSED, after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }) },
      }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.lifecycled.length, 1);
  assert.equal(outcome.lifecycled[0]!.edge, "PROPOSED → APPROVED");
});

test("integration: an ordinary modification of an existing ACR record stays a violation with a precise reason", () => {
  const path = "governance/acr/ACR-004.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    registryLifecycle: {
      readRecordPair: readerWith({
        [path]: {
          before: ACR_PROPOSED,
          after: acrVariant({ authorized_paths: ["governance/workflow-states.json"] }),
        },
      }),
    },
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /ordinary modification/);
  assert.equal(outcome.lifecycled.length, 0);
});

test("integration: a legal reconciliation decision modification is waived; deletions are not", () => {
  const path = "governance/reconciliations/TEST-001.json";
  const legal = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    registryLifecycle: {
      readRecordPair: readerWith({
        [path]: { before: REC_STAGED, after: { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS } },
      }),
    },
  });
  assert.equal(legal.violations.length, 0);
  assert.equal(legal.lifecycled.length, 1);
  assert.equal(legal.lifecycled[0]!.edge, "STAGED → DECIDED");

  // Deletion: after is unreadable → violation (deletion is not a lifecycle transition).
  const deletion = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    registryLifecycle: { readRecordPair: readerWith({ [path]: { before: REC_STAGED } }) },
  });
  assert.equal(deletion.violations.length, 1);
  assert.match(deletion.violations[0]!.reason, /deletions of registry records are not lifecycle transitions/);
});

test("integration: without a before/after reader the modification fails closed (strict mode)", () => {
  const path = "governance/acr/ACR-004.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    // no registryLifecycle reader: cannot verify → violation
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /fails closed/);
});

test("integration: registry additions under lifecycle patterns stay the normal flow", () => {
  const outcome = checkProtectedPathsWithRouting(["governance/acr/ACR-005.json"], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr", // the tree exists; the record does not
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.lifecycled.length, 0);
});

test("integration: the pass report names the registry lifecycle transitions explicitly (never silent)", () => {
  const path = "governance/acr/ACR-004.json";
  const result = protectedPathsCheckResult([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    registryLifecycle: {
      readRecordPair: readerWith({
        [path]: { before: ACR_PROPOSED, after: acrVariant({ status: "ENDORSED", review: REVIEW }) },
      }),
    },
  });
  assert.equal(result.status, "pass");
  const detail = (result.details ?? []).join("\n");
  assert.match(detail, /REGISTRY LIFECYCLE transition PROPOSED → ENDORSED/);
  assert.match(detail, /arbitrary edits to existing registry records remain protected/);
});

test("integration: an ACR can still route a registry-record change it explicitly enumerates (the general channel stays)", () => {
  const path = "governance/acr/ACR-004.json";
  const approvedAcr = {
    ...acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }),
    id: "ACR-010",
    authorized_paths: [path],
  };
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: () => true,
    acrRouting: {
      registry: new Map([["ACR-010", approvedAcr as never]]),
      citedAcrs: ["ACR-010"],
    },
    // The modification is NOT a legal lifecycle transition (prose edit)...
    registryLifecycle: {
      readRecordPair: readerWith({
        [path]: { before: ACR_PROPOSED, after: acrVariant({ title: "Retitled" }) },
      }),
    },
  });
  // ...but the approved ACR explicitly enumerates the exact path → ROUTED.
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.routed.length, 1);
  assert.equal(outcome.routed[0]!.acr, "ACR-010");
});

// ---------------------------------------------------------------------------
// The real manifest.
// ---------------------------------------------------------------------------

test("the real manifest declares the lifecycle kinds for both registries", () => {
  const manifest = loadProtectedPaths(REPO_ROOT);
  const acrPattern = manifest.patterns.find((p) => p.pattern === "governance/acr/**");
  const recPattern = manifest.patterns.find((p) => p.pattern === "governance/reconciliations/**");
  assert.equal(acrPattern?.lifecycle, "acr");
  assert.equal(acrPattern?.additions, "allowed");
  assert.equal(recPattern?.lifecycle, "reconciliation");
  assert.equal(recPattern?.additions, "allowed");
});

// ---------------------------------------------------------------------------
// End-to-end at the git level: the real CLI against a real (temp) git repo —
// the scenario of the Architect's ruling, replayed: an existing PROPOSED ACR
// is advanced to APPROVED (the act that previously deadlocked), and an
// ordinary edit to the same record stays blocked.
// ---------------------------------------------------------------------------

import { execSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runGovernanceCli(args: string[], root: string): { status: number | null; stdout: string } {
  // Node runs from REPO_ROOT so tsx resolves; the CLI's --root points its git
  // operations at the temp repository.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(REPO_ROOT, "tools", "governance", "src", "cli.ts"), ...args],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return { status: result.status, stdout: `${result.stdout}\n${result.stderr}` };
}

test("git end-to-end: advancing an existing PROPOSED ACR to APPROVED passes check-protected as a REGISTRY LIFECYCLE transition", () => {
  const dir = mkdtempSync(join(tmpdir(), "offisos-lifecycle-"));
  try {
    // A minimal repo with the REAL manifest and a PROPOSED ACR record.
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "protected-paths.json.tmp"));
    execSync("mkdir -p governance/acr", { cwd: dir });
    cpSync(join(dir, "protected-paths.json.tmp"), join(dir, "governance", "protected-paths.json"));
    rmSync(join(dir, "protected-paths.json.tmp"));
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(ACR_PROPOSED, null, 2)}\n`);
    execSync("git add -A && git commit -qm base", { cwd: dir });

    // The Architect/Product-Owner act: PROPOSED → APPROVED (composed, both gates).
    const approved = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(approved, null, 2)}\n`);
    execSync("git add -A && git commit -qm approve", { cwd: dir });

    // The previously-deadlocking check now passes, with the transition explicit.
    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}`);
    assert.match(result.stdout, /REGISTRY LIFECYCLE transition PROPOSED → APPROVED/);
    assert.match(result.stdout, /arbitrary edits to existing registry records remain protected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end: an ordinary edit to the existing ACR record stays a violation at the git level", () => {
  const dir = mkdtempSync(join(tmpdir(), "offisos-lifecycle-"));
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    execSync("mkdir -p governance/acr", { cwd: dir });
    cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "governance", "protected-paths.json"));
    const approved = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(approved, null, 2)}\n`);
    execSync("git add -A && git commit -qm base", { cwd: dir });

    // An ordinary edit: expanding authorized_paths of an existing record.
    const tampered = acrVariant({
      status: "APPROVED",
      review: REVIEW,
      approval: APPROVAL,
      authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(tampered, null, 2)}\n`);
    execSync("git add -A && git commit -qm tamper", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 1, "the ordinary edit must stay a violation");
    assert.match(result.stdout, /ordinary modification/);
    assert.match(result.stdout, /authorized_paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end: deleting an existing ACR record stays a violation (deletion is not a lifecycle transition)", () => {
  const dir = mkdtempSync(join(tmpdir(), "offisos-lifecycle-"));
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    execSync("mkdir -p governance/acr", { cwd: dir });
    cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "governance", "protected-paths.json"));
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(ACR_PROPOSED, null, 2)}\n`);
    execSync("git add -A && git commit -qm base", { cwd: dir });
    execSync("git rm -q governance/acr/ACR-004.json && git commit -qm delete", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 1, "deleting a registry record must stay a violation");
    assert.match(result.stdout, /deletions of registry records are not lifecycle transitions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
