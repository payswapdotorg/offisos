/**
 * Registry lifecycle-transition authorization tests (ARCH-WF-002 remediation,
 * Issue #12 — the Architect's CHANGES REQUESTED rulings on PR #101).
 *
 * Round 2 (circular ACR authorization) — proves the finite bootstrap/lifecycle
 * rule that breaks the circularity:
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
 *
 * Round 3 (lifecycle bypass at record creation) — proves the CREATION
 * INVARIANT, the ruling's exact required matrix:
 *   - new real ACR with status APPROVED      → BLOCKED
 *   - new real ACR with status IMPLEMENTED   → BLOCKED
 *   - new real reconciliation DECIDED        → BLOCKED
 *   - new real ACR with status PROPOSED      → ALLOWED
 *   - new reconciliation with STAGED         → ALLOWED
 *   - existing record legal lifecycle edge   → ALLOWED
 *   - existing record arbitrary modification → BLOCKED
 * plus the demo-fixture exemption (inert by construction), the fail-closed
 * unreadable-creation case, the preserved general ACR-routing channel for
 * explicitly enumerated out-of-band registrations, and git-level
 * end-to-end replays of the ruling's scenario against the real CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkRegistryAdditionTraversal,
  checkRegistryRecordCreation,
  isLegalRegistryLifecycleTransition,
} from "../src/registry-lifecycle.js";
import {
  checkProtectedPathsWithRouting,
  protectedPathsCheckResult,
  type RecordHistoryReader,
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
const acrCreation = checkRegistryRecordCreation.bind(null, "acr");
const recCreation = checkRegistryRecordCreation.bind(null, "reconciliation");

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

/** A history reader over explicit commit steps (oldest-first). */
function historyWith(
  histories: Record<string, Array<{ commit: string; before?: unknown; after?: unknown }>>,
): RecordHistoryReader {
  return (path) => histories[path];
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

test("integration: a new real ACR addition born PROPOSED is the normal flow (ALLOWED)", () => {
  const path = "governance/acr/ACR-005.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr", // the tree exists; the record does not
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [{ commit: "c0", before: undefined, after: acrVariant({ id: "ACR-005" }) }],
      }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.creations.length, 1);
  assert.equal(outcome.creations[0]!.initialStatus, "PROPOSED");
  assert.equal(outcome.creations[0]!.demo, undefined);
  assert.equal(outcome.creations[0]!.advancedBy, undefined);
});

test("integration: a registry addition with no history reader or empty history fails closed", () => {
  const path = "governance/acr/ACR-005.json";
  // No reader at all:
  const noReader = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
  });
  assert.equal(noReader.violations.length, 1);
  assert.match(noReader.violations[0]!.reason, /fails closed/);
  // Reader present but the history is empty/unreadable:
  const empty = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: { readRecordHistory: historyWith({}) },
  });
  assert.equal(empty.violations.length, 1);
  assert.match(empty.violations[0]!.reason, /fails closed/);
});

// ---------------------------------------------------------------------------
// Round 3 — the CREATION INVARIANT (the ruling's required matrix, unit level).
// ---------------------------------------------------------------------------

test("ALLOWED (required matrix): a new real ACR record born PROPOSED satisfies the creation invariant", () => {
  const outcome = acrCreation(ACR_PROPOSED);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.initialStatus, "PROPOSED");
  assert.equal(outcome.demo, undefined);
});

test("ALLOWED (required matrix): a new reconciliation record born STAGED satisfies the creation invariant", () => {
  const outcome = recCreation(REC_STAGED);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.initialStatus, "STAGED");
  assert.equal(outcome.demo, undefined);
});

test("BLOCKED (required matrix): a new real ACR record born APPROVED is blocked", () => {
  const outcome = acrCreation(acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /must be born at its initial lifecycle status 'PROPOSED'/);
  assert.match(outcome.reason!, /'APPROVED'/);
});

test("BLOCKED (required matrix): a new real ACR record born IMPLEMENTED is blocked", () => {
  const outcome = acrCreation(
    acrVariant({ status: "IMPLEMENTED", review: REVIEW, approval: APPROVAL, implementation: IMPLEMENTATION }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /must be born at its initial lifecycle status 'PROPOSED'/);
  assert.match(outcome.reason!, /'IMPLEMENTED'/);
});

test("BLOCKED (required matrix): a new real reconciliation record born DECIDED is blocked", () => {
  const outcome = recCreation({ ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /must be born at its initial lifecycle status 'STAGED'/);
  assert.match(outcome.reason!, /'DECIDED'/);
});

test("BLOCKED: a new real ACR born ENDORSED (mid-lifecycle, gates already recorded) is blocked", () => {
  const outcome = acrCreation(acrVariant({ status: "ENDORSED", review: REVIEW }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /'PROPOSED'/);
});

test("BLOCKED: a new real ACR born REJECTED is blocked — rejection must traverse PROPOSED → REJECTED", () => {
  const outcome = acrCreation(acrVariant({ status: "REJECTED", review: { ...REVIEW, verdict: "rejected" } }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /'PROPOSED'/);
});

test("BLOCKED: a new real record with no readable status fails closed", () => {
  const { status: _status, ...noStatus } = ACR_PROPOSED;
  assert.equal(acrCreation(noStatus).ok, false);
  assert.equal(acrCreation({ ...noStatus, status: "   " }).ok, false);
  assert.equal(acrCreation({ ...noStatus, status: 42 }).ok, false);
});

test("BLOCKED: non-record creation content (strings, null, arrays, undefined) fails closed", () => {
  assert.equal(acrCreation(undefined).ok, false);
  assert.equal(acrCreation("not a record").ok, false);
  assert.equal(acrCreation(null).ok, false);
  assert.equal(acrCreation([ACR_PROPOSED]).ok, false);
});

test("ALLOWED (demo exemption): a demo ACR born IMPLEMENTED (the ACR-901 shape) is exempt and inert", () => {
  const outcome = acrCreation(
    acrVariant({
      id: "ACR-902",
      demo: true,
      status: "IMPLEMENTED",
      review: { ...REVIEW, reviewed_by: "demo-architect" },
      approval: { ...APPROVAL, approved_by: "demo-owner" },
      implementation: { ...IMPLEMENTATION, work_item: "SAMPLE-002" },
    }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.demo, true);
});

test("ALLOWED (demo exemption): a demo reconciliation born DECIDED (the REC-SAMPLE-002 shape) is exempt", () => {
  const outcome = recCreation({ ...REC_STAGED, id: "REC-SAMPLE-003", demo: true, status: "DECIDED", ...DECISION_FIELDS });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.demo, true);
});

test("demo: false is a real record — the creation invariant applies in full", () => {
  const outcome = acrCreation(acrVariant({ demo: false, status: "APPROVED", review: REVIEW, approval: APPROVAL }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /'PROPOSED'/);
});

// ---------------------------------------------------------------------------
// Round 3 — the ADDITION TRAVERSAL (unit level): a creation plus every
// subsequent intra-change step.
// ---------------------------------------------------------------------------

const acrTraversal = checkRegistryAdditionTraversal.bind(null, "acr");
const recTraversal = checkRegistryAdditionTraversal.bind(null, "reconciliation");

test("traversal: a pure creation born at the initial status passes with no steps", () => {
  const outcome = acrTraversal([{ commit: "c0", before: undefined, after: ACR_PROPOSED }]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.initialStatus, "PROPOSED");
  assert.deepEqual(outcome.steps, []);
});

test("traversal: creation at PROPOSED + the composed legal advancement to APPROVED passes (the acts flow)", () => {
  const outcome = acrTraversal([
    { commit: "c0", before: undefined, after: ACR_PROPOSED },
    { commit: "c1", before: ACR_PROPOSED, after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }) },
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.initialStatus, "PROPOSED");
  assert.deepEqual(outcome.steps, [{ edge: "PROPOSED → APPROVED", instruments: ["approval", "review"] }]);
});

test("traversal: a multi-gate lawful traversal (creation → ENDORSED → APPROVED → IMPLEMENTED) passes", () => {
  const endorsed = acrVariant({ status: "ENDORSED", review: REVIEW });
  const approved = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const implemented = acrVariant({ status: "IMPLEMENTED", review: REVIEW, approval: APPROVAL, implementation: IMPLEMENTATION });
  const outcome = acrTraversal([
    { commit: "c0", before: undefined, after: ACR_PROPOSED },
    { commit: "c1", before: ACR_PROPOSED, after: endorsed },
    { commit: "c2", before: endorsed, after: approved },
    { commit: "c3", before: approved, after: implemented },
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.steps?.map((s) => s.edge), ["PROPOSED → ENDORSED", "ENDORSED → APPROVED", "APPROVED → IMPLEMENTED"]);
});

test("traversal BLOCKED: a creation born APPROVED fails with the introduction commit named", () => {
  const outcome = acrTraversal([
    { commit: "abc1234", before: undefined, after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }) },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /must be born at its initial lifecycle status 'PROPOSED'/);
  assert.match(outcome.reason!, /introduced at commit abc1234/);
});

test("traversal BLOCKED: an illegal intra-change step (authorized_paths tamper) fails even when the endpoints compose a legal edge", () => {
  const outcome = acrTraversal([
    { commit: "c0", before: undefined, after: ACR_PROPOSED },
    { commit: "c1", before: ACR_PROPOSED, after: acrVariant({ authorized_paths: ["governance/workflow-states.json"] }) },
    {
      commit: "c2",
      before: acrVariant({ authorized_paths: ["governance/workflow-states.json"] }),
      after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL, authorized_paths: ["governance/workflow-states.json"] }),
    },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /modification at commit c1 \(within the same change\) is not a legal lifecycle transition/);
});

test("traversal BLOCKED: an intra-change deletion is not a transition", () => {
  const outcome = acrTraversal([
    { commit: "c0", before: undefined, after: ACR_PROPOSED },
    { commit: "c1", before: ACR_PROPOSED, after: undefined },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /commit c1/);
});

test("traversal BLOCKED: a backwards intra-change step fails", () => {
  const approved = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
  const outcome = acrTraversal([
    { commit: "c0", before: undefined, after: ACR_PROPOSED },
    { commit: "c1", before: ACR_PROPOSED, after: approved },
    { commit: "c2", before: approved, after: acrVariant({ status: "ENDORSED", review: REVIEW }) },
  ]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /commit c2/);
});

test("traversal BLOCKED: undefined or empty history fails closed; a history with no creation step fails closed", () => {
  assert.equal(acrTraversal(undefined).ok, false);
  assert.match(acrTraversal(undefined).reason!, /fails closed/);
  assert.equal(acrTraversal([]).ok, false);
  // Every step has a "before": not an addition — misuse fails closed.
  const outcome = acrTraversal([{ commit: "c0", before: ACR_PROPOSED, after: acrVariant({ status: "ENDORSED", review: REVIEW }) }]);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason!, /not a registry addition/);
});

test("traversal: the reconciliation acts flow (creation STAGED + legal STAGED → DECIDED) passes; born-DECIDED fails", () => {
  const lawful = recTraversal([
    { commit: "c0", before: undefined, after: REC_STAGED },
    { commit: "c1", before: REC_STAGED, after: { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS } },
  ]);
  assert.equal(lawful.ok, true);
  assert.equal(lawful.initialStatus, "STAGED");
  assert.deepEqual(lawful.steps?.map((s) => s.edge), ["STAGED → DECIDED"]);

  const bypass = recTraversal([
    { commit: "c0", before: undefined, after: { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS } },
  ]);
  assert.equal(bypass.ok, false);
  assert.match(bypass.reason!, /'STAGED'/);
});

test("traversal: a demo fixture created mid-lifecycle passes (exempt); a demo record edited mid-change is still checked", () => {
  const demo = acrVariant({ id: "ACR-902", demo: true, status: "IMPLEMENTED" });
  const outcome = acrTraversal([{ commit: "c0", before: undefined, after: demo }]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.demo, true);

  // Demo records are exempt from the INITIAL-status rule, but a later edit of
  // the new demo record within the same change is still an ordinary
  // modification of a registry record and stays blocked.
  const edited = acrTraversal([
    { commit: "c0", before: undefined, after: demo },
    { commit: "c1", before: demo, after: acrVariant({ id: "ACR-902", demo: true, status: "IMPLEMENTED", title: "Retitled demo" }) },
  ]);
  assert.equal(edited.ok, false);
  assert.match(edited.reason!, /commit c1/);
});

// ---------------------------------------------------------------------------
// Round 3 — the creation invariant through the protected-path check
// (the ruling's matrix at the integration level, including the preserved
// general ACR-routing channel and the existing-record rows).
// ---------------------------------------------------------------------------

test("integration BLOCKED (required matrix): creating a new real ACR born APPROVED is a violation with the creation reason", () => {
  const path = "governance/acr/ACR-004.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [
          {
            commit: "c0",
            before: undefined,
            after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }),
          },
        ],
      }),
    },
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /must be born at its initial lifecycle status 'PROPOSED'/);
  assert.match(outcome.violations[0]!.reason, /introduced at commit c0/);
  assert.equal(outcome.creations.length, 0);
  assert.equal(outcome.lifecycled.length, 0);
});

test("integration BLOCKED (required matrix): creating a new real reconciliation born DECIDED is a violation", () => {
  const path = "governance/reconciliations/TEST-009.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/reconciliations",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [{ commit: "c0", before: undefined, after: { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS } }],
      }),
    },
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /must be born at its initial lifecycle status 'STAGED'/);
});

test("integration ALLOWED (required matrix): creating a new reconciliation born STAGED is the normal flow", () => {
  const path = "governance/reconciliations/TEST-009.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/reconciliations",
    registryLifecycle: {
      readRecordHistory: historyWith({ [path]: [{ commit: "c0", before: undefined, after: REC_STAGED }] }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.creations.length, 1);
  assert.equal(outcome.creations[0]!.initialStatus, "STAGED");
});

test("integration ALLOWED (demo exemption): a demo fixture addition is reported as an exempt demo creation", () => {
  const path = "governance/acr/ACR-902.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [{ commit: "c0", before: undefined, after: acrVariant({ id: "ACR-902", demo: true, status: "IMPLEMENTED" }) }],
      }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.creations.length, 1);
  assert.equal(outcome.creations[0]!.demo, true);
});

test("integration ALLOWED (the acts flow): a record born PROPOSED and legally advanced within the same change passes, reported as addition + transition", () => {
  // The documented review-time acts flow: ACR-003 is created PROPOSED on the
  // PR branch (c0) and advanced to APPROVED by the Architect's acts commit
  // (c1). From the base branch's perspective the file is NEW, so only the
  // traversal can authorize it: born at the initial status + a legal edge.
  const path = "governance/acr/ACR-003.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [
          { commit: "c0", before: undefined, after: ACR_PROPOSED },
          {
            commit: "c1",
            before: ACR_PROPOSED,
            after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }),
          },
        ],
      }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.creations.length, 1);
  assert.equal(outcome.creations[0]!.initialStatus, "PROPOSED");
  assert.deepEqual(outcome.creations[0]!.advancedBy, ["PROPOSED → APPROVED"]);
  assert.equal(outcome.lifecycled.length, 1);
  assert.equal(outcome.lifecycled[0]!.edge, "PROPOSED → APPROVED");
  assert.deepEqual(outcome.lifecycled[0]!.instruments, ["approval", "review"]);
});

test("integration BLOCKED (the smuggle): a record born PROPOSED then tampered within the same change is blocked", () => {
  // The endpoint pair (born PROPOSED at c0, legal-looking APPROVED at c2)
  // composes a legal edge — but the intermediate commit c1 quietly expanded
  // authorized_paths. Only the full traversal catches it.
  const path = "governance/acr/ACR-006.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [
          { commit: "c0", before: undefined, after: ACR_PROPOSED },
          {
            commit: "c1",
            before: ACR_PROPOSED,
            after: acrVariant({ authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"] }),
          },
          {
            commit: "c2",
            before: acrVariant({ authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"] }),
            after: acrVariant({
              status: "APPROVED",
              review: REVIEW,
              approval: APPROVAL,
              authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
            }),
          },
        ],
      }),
    },
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /modification at commit c1 \(within the same change\) is not a legal lifecycle transition/);
  assert.match(outcome.violations[0]!.reason, /authorized_paths/);
});

test("integration BLOCKED: a record created and deleted within the same change is blocked (deletion is not a transition)", () => {
  const path = "governance/acr/ACR-007.json";
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [
          { commit: "c0", before: undefined, after: ACR_PROPOSED },
          { commit: "c1", before: ACR_PROPOSED, after: undefined },
        ],
      }),
    },
  });
  assert.equal(outcome.violations.length, 1);
  assert.match(outcome.violations[0]!.reason, /modification at commit c1 \(within the same change\) is not a legal lifecycle transition/);
});

test("integration: the general channel survives — an approved ACR may explicitly authorize an out-of-band registration", () => {
  // E.g. re-registering an externally-approved proposal: an approved ACR
  // explicitly enumerating the exact creation path still routes it, so the
  // creation invariant is a floor for ordinary PRs, not an absolute bar for
  // explicitly dual-gate-authorized registrations.
  const path = "governance/acr/ACR-005.json";
  const registrar = {
    ...acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }),
    id: "ACR-010",
    authorized_paths: [path],
  };
  const outcome = checkProtectedPathsWithRouting([path], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr",
    acrRouting: {
      registry: new Map([["ACR-010", registrar as never]]),
      citedAcrs: ["ACR-010"],
    },
    registryLifecycle: {
      readRecordHistory: historyWith({
        [path]: [
          {
            commit: "c0",
            before: undefined,
            after: acrVariant({ id: "ACR-005", status: "APPROVED", review: REVIEW, approval: APPROVAL }),
          },
        ],
      }),
    },
  });
  assert.equal(outcome.violations.length, 0);
  assert.equal(outcome.routed.length, 1);
  assert.equal(outcome.routed[0]!.acr, "ACR-010");
  assert.equal(outcome.creations.length, 0);
});

test("integration: the pass report names registry additions explicitly (never silent)", () => {
  const real = "governance/acr/ACR-005.json";
  const demo = "governance/reconciliations/SAMPLE-003.json";
  const result = protectedPathsCheckResult([real, demo], LIFECYCLE_MANIFEST, {
    existsOnBase: (p) => p === "governance/acr" || p === "governance/reconciliations",
    registryLifecycle: {
      readRecordHistory: historyWith({
        [real]: [{ commit: "c0", before: undefined, after: acrVariant({ id: "ACR-005" }) }],
        [demo]: [
          { commit: "c0", before: undefined, after: { ...REC_STAGED, id: "REC-SAMPLE-003", demo: true, status: "DECIDED" } },
        ],
      }),
    },
  });
  assert.equal(result.status, "pass");
  const detail = (result.details ?? []).join("\n");
  assert.match(detail, /REGISTRY ADDITION born at the initial status PROPOSED/);
  assert.match(detail, /REGISTRY ADDITION of a demo fixture/);
  assert.match(detail, /can never route protected-path changes or sanction real reconciliations/);
  assert.match(result.description, /2 registry addition\(s\) under the creation invariant/);
});

test("integration: the round-3 ruling matrix in one pass — creations blocked/allowed, existing-record edges preserved", () => {
  // The ruling's seven required rows, exercised against one manifest in one place.
  const matrix: Array<{ row: string; path: string; run: () => boolean }> = [
    {
      row: "new real ACR with status APPROVED → BLOCKED",
      path: "governance/acr/N1.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/acr/N1.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: (p) => p === "governance/acr",
          registryLifecycle: {
            readRecordHistory: historyWith({
              "governance/acr/N1.json": [
                { commit: "c0", before: undefined, after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }) },
              ],
            }),
          },
        }).violations.length === 1,
    },
    {
      row: "new real ACR with status IMPLEMENTED → BLOCKED",
      path: "governance/acr/N2.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/acr/N2.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: (p) => p === "governance/acr",
          registryLifecycle: {
            readRecordHistory: historyWith({
              "governance/acr/N2.json": [
                {
                  commit: "c0",
                  before: undefined,
                  after: acrVariant({ status: "IMPLEMENTED", review: REVIEW, approval: APPROVAL, implementation: IMPLEMENTATION }),
                },
              ],
            }),
          },
        }).violations.length === 1,
    },
    {
      row: "new real reconciliation DECIDED → BLOCKED",
      path: "governance/reconciliations/N3.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/reconciliations/N3.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: (p) => p === "governance/reconciliations",
          registryLifecycle: {
            readRecordHistory: historyWith({
              "governance/reconciliations/N3.json": [
                { commit: "c0", before: undefined, after: { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS } },
              ],
            }),
          },
        }).violations.length === 1,
    },
    {
      row: "new real ACR with status PROPOSED → ALLOWED",
      path: "governance/acr/N4.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/acr/N4.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: (p) => p === "governance/acr",
          registryLifecycle: {
            readRecordHistory: historyWith({
              "governance/acr/N4.json": [{ commit: "c0", before: undefined, after: acrVariant({ id: "ACR-004" }) }],
            }),
          },
        }).creations.length === 1,
    },
    {
      row: "new reconciliation with STAGED → ALLOWED",
      path: "governance/reconciliations/N5.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/reconciliations/N5.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: (p) => p === "governance/reconciliations",
          registryLifecycle: {
            readRecordHistory: historyWith({
              "governance/reconciliations/N5.json": [{ commit: "c0", before: undefined, after: REC_STAGED }],
            }),
          },
        }).creations.length === 1,
    },
    {
      row: "existing record legal lifecycle edge → ALLOWED",
      path: "governance/acr/E1.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/acr/E1.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: () => true,
          registryLifecycle: {
            readRecordPair: readerWith({
              "governance/acr/E1.json": {
                before: ACR_PROPOSED,
                after: acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL }),
              },
            }),
          },
        }).lifecycled.length === 1,
    },
    {
      row: "existing record arbitrary modification → BLOCKED",
      path: "governance/acr/E2.json",
      run: () =>
        checkProtectedPathsWithRouting(["governance/acr/E2.json"], LIFECYCLE_MANIFEST, {
          existsOnBase: () => true,
          registryLifecycle: {
            readRecordPair: readerWith({
              "governance/acr/E2.json": {
                before: ACR_PROPOSED,
                after: acrVariant({ authorized_paths: ["governance/workflow-states.json"] }),
              },
            }),
          },
        }).violations.length === 1,
    },
  ];
  for (const { row, run } of matrix) {
    assert.equal(run(), true, `matrix row failed: ${row}`);
  }
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

// ---------------------------------------------------------------------------
// Round 3 — git end-to-end: the creation invariant against the real CLI,
// replaying the ruling's exact scenario. The lifecycle-transition guard never
// sees a before/after pair for a newly created record (the file did not exist
// on the base), so ONLY the creation check at the protected-path boundary can
// enforce that a real record traverses PROPOSED → ENDORSED → APPROVED →
// IMPLEMENTED (or STAGED → DECIDED) rather than being born mid-lifecycle.
// ---------------------------------------------------------------------------

/** Minimal temp repo with the REAL manifest and one existing PROPOSED ACR. */
function initLifecycleGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "offisos-creation-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync("mkdir -p governance/acr governance/reconciliations", { cwd: dir });
  cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "governance", "protected-paths.json"));
  writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(ACR_PROPOSED, null, 2)}\n`);
  execSync("git add -A && git commit -qm base", { cwd: dir });
  return dir;
}

test("git end-to-end (round 3): creating a NEW real ACR born APPROVED (review + approval included) is BLOCKED", () => {
  const dir = initLifecycleGitRepo();
  try {
    // The ruling's exact example: governance/acr/ACR-005.json born APPROVED
    // with the gate instruments already recorded.
    const bornApproved = acrVariant({
      id: "ACR-005",
      status: "APPROVED",
      review: REVIEW,
      approval: APPROVAL,
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-005.json"), `${JSON.stringify(bornApproved, null, 2)}\n`);
    execSync("git add -A && git commit -qm create-born-approved", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 1, "a new real ACR born APPROVED must be a violation");
    assert.match(result.stdout, /ACR-005\.json/);
    assert.match(result.stdout, /must be born at its initial lifecycle status 'PROPOSED'/);
    assert.match(result.stdout, /'APPROVED'/);
    assert.match(result.stdout, /bypasses the review\/approval gates/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end (round 3): a new real ACR born IMPLEMENTED and a new real reconciliation born DECIDED are both BLOCKED", () => {
  const dir = initLifecycleGitRepo();
  try {
    const bornImplemented = acrVariant({
      id: "ACR-005",
      status: "IMPLEMENTED",
      review: REVIEW,
      approval: APPROVAL,
      implementation: IMPLEMENTATION,
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-005.json"), `${JSON.stringify(bornImplemented, null, 2)}\n`);
    const bornDecided = { ...REC_STAGED, status: "DECIDED", ...DECISION_FIELDS };
    writeFileSync(join(dir, "governance", "reconciliations", "TEST-001.json"), `${JSON.stringify(bornDecided, null, 2)}\n`);
    execSync("git add -A && git commit -qm create-mid-lifecycle", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 1, "both mid-lifecycle creations must be violations");
    assert.match(result.stdout, /ACR-005\.json.*must be born at its initial lifecycle status 'PROPOSED'/s);
    assert.match(result.stdout, /TEST-001\.json.*must be born at its initial lifecycle status 'STAGED'/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end (round 3): creating a NEW real ACR born PROPOSED and a NEW reconciliation born STAGED pass and are reported explicitly", () => {
  const dir = initLifecycleGitRepo();
  try {
    const bornProposed = acrVariant({ id: "ACR-005" });
    writeFileSync(join(dir, "governance", "acr", "ACR-005.json"), `${JSON.stringify(bornProposed, null, 2)}\n`);
    writeFileSync(join(dir, "governance", "reconciliations", "TEST-001.json"), `${JSON.stringify(REC_STAGED, null, 2)}\n`);
    execSync("git add -A && git commit -qm create-initial-states", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}`);
    assert.match(result.stdout, /REGISTRY ADDITION born at the initial status PROPOSED/);
    assert.match(result.stdout, /REGISTRY ADDITION born at the initial status STAGED/);
    assert.match(result.stdout, /later lifecycle states are reachable only through the narrowly checked legal transitions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end (round 3): a demo fixture born IMPLEMENTED (the ACR-901 reproducible-example flow) passes as an exempt demo addition", () => {
  const dir = initLifecycleGitRepo();
  try {
    const demo = acrVariant({
      id: "ACR-902",
      demo: true,
      status: "IMPLEMENTED",
      review: { ...REVIEW, reviewed_by: "demo-architect" },
      approval: { ...APPROVAL, approved_by: "demo-owner" },
      implementation: { ...IMPLEMENTATION, work_item: "SAMPLE-002" },
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-902.json"), `${JSON.stringify(demo, null, 2)}\n`);
    execSync("git add -A && git commit -qm create-demo", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~1", "--root", dir], dir);
    assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}`);
    assert.match(result.stdout, /REGISTRY ADDITION of a demo fixture/);
    assert.match(result.stdout, /demo records can never route protected-path changes or sanction real reconciliations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end (round 3, the acts flow): a NEW record born PROPOSED then legally advanced to APPROVED passes the full-range check", () => {
  // The documented review-time acts flow: the record is introduced at its
  // initial status in one commit and advanced by a legal lifecycle transition
  // in a later commit of the SAME change. Checked against the full range
  // (base = before the introduction), exactly how the governance CI sees a PR.
  const dir = mkdtempSync(join(tmpdir(), "offisos-acts-"));
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    execSync("mkdir -p governance/acr", { cwd: dir });
    cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "governance", "protected-paths.json"));
    execSync("git add -A && git commit -qm base", { cwd: dir });

    // Commit 1: the proposal is born PROPOSED.
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(ACR_PROPOSED, null, 2)}\n`);
    execSync("git add -A && git commit -qm propose", { cwd: dir });

    // Commit 2 (the acts commit): the legal composed advancement to APPROVED.
    const approved = acrVariant({ status: "APPROVED", review: REVIEW, approval: APPROVAL });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(approved, null, 2)}\n`);
    execSync("git add -A && git commit -qm approve", { cwd: dir });

    // The full-range check (both commits at once) passes: born PROPOSED +
    // legal transition, both reported explicitly.
    const result = runGovernanceCli(["check-protected", "--base", "HEAD~2", "--root", dir], dir);
    assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}`);
    assert.match(result.stdout, /REGISTRY ADDITION born at the initial status PROPOSED/);
    assert.match(result.stdout, /advanced within this change by legal transition\(s\): PROPOSED → APPROVED/);
    assert.match(result.stdout, /REGISTRY LIFECYCLE transition PROPOSED → APPROVED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git end-to-end (round 3, the smuggle): born PROPOSED, tampered, then legally advanced is BLOCKED by the traversal", () => {
  // The endpoint pair (PROPOSED at HEAD~2, APPROVED at HEAD) composes a legal
  // edge — only the full per-commit traversal catches the intermediate
  // authorized_paths expansion.
  const dir = mkdtempSync(join(tmpdir(), "offisos-smuggle-"));
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    execSync("mkdir -p governance/acr", { cwd: dir });
    cpSync(join(REPO_ROOT, "governance", "protected-paths.json"), join(dir, "governance", "protected-paths.json"));
    execSync("git add -A && git commit -qm base", { cwd: dir });

    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(ACR_PROPOSED, null, 2)}\n`);
    execSync("git add -A && git commit -qm propose", { cwd: dir });

    const tampered = acrVariant({
      authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(tampered, null, 2)}\n`);
    execSync("git add -A && git commit -qm tamper", { cwd: dir });

    const approved = acrVariant({
      status: "APPROVED",
      review: REVIEW,
      approval: APPROVAL,
      authorized_paths: ["governance/schemas/x.schema.json", "governance/workflow-states.json"],
    });
    writeFileSync(join(dir, "governance", "acr", "ACR-004.json"), `${JSON.stringify(approved, null, 2)}\n`);
    execSync("git add -A && git commit -qm approve", { cwd: dir });

    const result = runGovernanceCli(["check-protected", "--base", "HEAD~3", "--root", dir], dir);
    assert.equal(result.status, 1, "the smuggled authorized_paths expansion must stay a violation");
    assert.match(result.stdout, /is not a legal lifecycle transition/);
    assert.match(result.stdout, /authorized_paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
