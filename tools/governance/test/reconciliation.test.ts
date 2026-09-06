/**
 * Historical reconciliation tests (ARCH-WF-002, Issues #12 and #100).
 *
 * Proves the mechanism's safety properties on a CAD-PARITY-011-shaped base
 * record (merged before its recorded approval, merge recorded under an
 * unauthorized role):
 *
 *  - a DECIDED, ACR-sanctioned, architect-role reconciliation activates
 *    exactly the three enumerated waivers, with explicit [RECONCILED]
 *    annotations in the report (never silent);
 *  - a STAGED reconciliation never waives anything — the failures stay
 *    visible until the Architect decides;
 *  - tamper evidence: editing the historical record after staging breaks
 *    the verbatim citations and deactivates the reconciliation;
 *  - narrowness: unenumerated violations, other work items, implementer
 *    decisions, pre-dating decisions, unapproved ACRs, unlisted work items,
 *    non-merged records and missing evidence all fail;
 *  - VERIFIED evidence gating is never waivable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReconciliationRegistry, reconciliationViolationKey } from "../src/reconciliation.js";
import { collectReconcilableViolations, validateWorkItem } from "../src/rules.js";
import { loadWorkflowStates } from "../src/loaders.js";
import { REPO_ROOT, makeContext, baseVerifiedRecord } from "./helpers.js";
import type {
  ActiveReconciliation,
  AcrRecord,
  ReconciliationRecord,
  WorkItemRecord,
} from "../src/types.js";

/**
 * A merged-before-recorded-approval record — the same defect shape as the
 * real CAD-PARITY-011 ledger.
 */
function defectiveMergedRecord(): WorkItemRecord {
  const record = baseVerifiedRecord();
  record.id = "TEST-011";
  record.state = "MERGED";
  record.acr = undefined;
  // Drop the verify transition; the record ends at MERGED.
  record.transitions = record.transitions.filter((t) => t.to !== "VERIFIED");
  // The defect: approval recorded (06:00) AFTER the merge (05:58), and the
  // merge recorded under the architect role.
  const approved = record.transitions.find((t) => t.to === "APPROVED")!;
  approved.at = "2026-01-01T06:00:00Z";
  record.decisions![0]!.decided_at = "2026-01-01T06:00:00Z";
  const merged = record.transitions.find((t) => t.to === "MERGED")!;
  merged.at = "2026-01-01T05:58:00Z";
  merged.actor = "architect-a";
  merged.role = "architect";
  return record;
}

function approvedAcr(): AcrRecord {
  return structuredClone({
    id: "ACR-010",
    title: "Reconciliation pathway fixture ACR",
    status: "APPROVED",
    requested_by: "requester-a",
    requested_at: "2026-01-01T07:00:00Z",
    problem: "Fixture problem statement long enough for the schema.",
    evidence: ["fixture evidence"],
    impact: "Fixture impact statement long enough for the schema.",
    alternatives: ["do nothing — rejected."],
    recommendation: "Fixture recommendation long enough for the schema.",
    migration_plan: "Fixture migration plan long enough for the schema.",
    compatibility: "Fixture compatibility statement long enough for the schema.",
    security_impact: "Fixture security impact statement long enough for the schema.",
    affected_requirements: ["FLOW-001"],
    affected_work_items: ["TEST-011"],
    architecture_version_from: "1.1",
    architecture_version_to: "1.1",
    authorized_paths: [],
    review: {
      reviewed_by: "architect-a",
      role: "architect",
      reviewed_at: "2026-01-01T07:10:00Z",
      verdict: "endorsed",
      rationale: "endorsed",
    },
    approval: {
      approved_by: "owner-a",
      role: "product-owner",
      approved_at: "2026-01-01T07:20:00Z",
      decision: "approved",
      rationale: "approved",
    },
  });
}

function decidedReconciliation(status: "STAGED" | "DECIDED" = "DECIDED"): ReconciliationRecord {
  const base = {
    id: "REC-TEST-011",
    work_item: "TEST-011",
    status,
    problem: "The merge event (05:58:00Z) preceded the recorded approval (06:00:00Z) and was recorded under the architect role.",
    defects: [
      {
        rule: "transition-legality" as const,
        violation: "unauthorized-role" as const,
        transition: 8,
        original: {
          from: "APPROVED",
          to: "MERGED",
          at: "2026-01-01T05:58:00Z",
          actor: "architect-a",
          role: "architect",
        },
        explanation: "The merge was performed by an actor holding product-owner authority but recorded under the architect role.",
      },
      {
        rule: "temporal-ordering" as const,
        violation: "precedes-previous" as const,
        transition: 8,
        original: {
          from: "APPROVED",
          to: "MERGED",
          at: "2026-01-01T05:58:00Z",
          actor: "architect-a",
          role: "architect",
        },
        explanation: "The merge timestamp precedes the recorded approval timestamp.",
      },
      {
        rule: "decisions" as const,
        violation: "no-prior-approved-decision" as const,
        state_entry: "MERGED",
        original: {
          from: "APPROVED",
          to: "MERGED",
          at: "2026-01-01T05:58:00Z",
          actor: "architect-a",
          role: "architect",
        },
        explanation: "No approved decision exists at or before the merge event.",
      },
    ],
    acr: "ACR-010",
  };
  if (status === "STAGED") return base as ReconciliationRecord;
  return {
    ...base,
    evidence: [
      {
        id: "EV-001",
        type: "ci-run",
        description: "Post-merge verification of the merged revision.",
        produced_at: "2026-01-01T06:30:00Z",
        reproducible: true,
        reproduction: "inspect the CI run",
        references: { commit: "abcdef1", pr: 42 },
      },
    ],
    decided_by: "architect-a",
    role: "architect",
    decided_at: "2026-01-01T08:00:00Z",
    rationale: "The approval exists and covers the merged implementation; the defect was a recording-order failure.",
    remediation: "The item may proceed to VERIFIED only through the normal architect-verified path.",
  } as ReconciliationRecord;
}

function runReconciliationValidation(
  reconciliations: ReconciliationRecord[],
  workItems: WorkItemRecord[],
  acrs: AcrRecord[],
) {
  const machine = loadWorkflowStates(REPO_ROOT);
  return {
    outcome: validateReconciliationRegistry(
      reconciliations.map((record) => ({ file: `${record.work_item}.json`, record })),
      {
        machine,
        workItems: new Map(workItems.map((w) => [w.id, w] as const)),
        acrRecords: new Map(acrs.map((a) => [a.id, a] as const)),
      },
    ),
  };
}

function checkIds(record: WorkItemRecord, active?: Map<string, ActiveReconciliation>) {
  const ctx = makeContext([record]);
  if (active !== undefined) ctx.activeReconciliations = active;
  const results = validateWorkItem(record, ctx);
  return new Map(results.map((r) => [r.id.replace(/^work-item\/[^/]+\//, ""), r] as const));
}

test("a DECIDED reconciliation activates exactly the three enumerated waivers with annotations", () => {
  const record = defectiveMergedRecord();
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  assert.deepEqual(outcome.checks.filter((c) => c.status === "fail"), []);
  assert.equal(outcome.active.size, 1);
  const active = outcome.active.get("TEST-011")!;
  assert.equal(active.waivedKeys.size, 3);

  const checks = checkIds(record, outcome.active);
  for (const rule of ["transition-legality", "temporal-ordering", "decisions"]) {
    const check = checks.get(rule)!;
    assert.equal(check.status, "pass", `${rule} should pass under the active reconciliation`);
    const detail = (check.details ?? []).join(" ");
    assert.ok(detail.includes("[RECONCILED]"), `${rule} must carry the explicit annotation`);
    assert.ok(detail.includes("REC-TEST-011"), `${rule} must name the reconciliation`);
    assert.ok(check.description.includes("reconciled by REC-TEST-011"), `${rule} description must mention it`);
  }
});

test("without the reconciliation the same record fails the three rules", () => {
  const checks = checkIds(defectiveMergedRecord());
  for (const rule of ["transition-legality", "temporal-ordering", "decisions"]) {
    assert.equal(checks.get(rule)!.status, "fail", `${rule} must fail on the raw defective record`);
  }
});

test("a STAGED reconciliation never waives anything", () => {
  const record = defectiveMergedRecord();
  const { outcome } = runReconciliationValidation([decidedReconciliation("STAGED")], [record], [approvedAcr()]);
  assert.deepEqual(outcome.checks.filter((c) => c.status === "fail"), []);
  assert.equal(outcome.active.size, 0, "a staged reconciliation must not activate waivers");
  const checks = checkIds(record, outcome.active);
  for (const rule of ["transition-legality", "temporal-ordering", "decisions"]) {
    assert.equal(checks.get(rule)!.status, "fail", `${rule} must stay failed while staged`);
  }
});

test("tamper evidence: editing the historical record breaks the citations and deactivates waivers", () => {
  const record = defectiveMergedRecord();
  // Stage against the true facts, then tamper with the historical transition.
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  assert.equal(outcome.active.size, 1);

  const tampered = structuredClone(record);
  const merged = tampered.transitions.find((t) => t.to === "MERGED")!;
  merged.role = "product-owner"; // rewritten history
  const { outcome: tamperedOutcome } = runReconciliationValidation([decidedReconciliation()], [tampered], [approvedAcr()]);
  const citationFailures = tamperedOutcome.checks.filter(
    (c) => c.status === "fail" && c.id.includes("/citations"),
  );
  assert.ok(citationFailures.length > 0, "tampered history must fail citation integrity");
  assert.equal(tamperedOutcome.active.size, 0, "a broken reconciliation must never activate waivers");
  const checks = checkIds(tampered, tamperedOutcome.active);
  // The remaining historical violations (temporal inversion, missing prior
  // decision) must still fail: the tampered record lost its waivers.
  assert.equal(checks.get("temporal-ordering")!.status, "fail");
  assert.equal(checks.get("decisions")!.status, "fail");
});

test("narrowness: the reconciliation waives only the enumerated keys", () => {
  const record = defectiveMergedRecord();
  // Add an UNRECONCILABLE violation: a broken transition chain.
  record.transitions.push({
    from: "MERGED",
    to: "IMPLEMENTING",
    at: "2026-01-01T09:00:00Z",
    actor: "x",
    role: "implementer",
    reason: "illegal jump",
  });
  record.state = "IMPLEMENTING";
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  const checks = checkIds(record, outcome.active);
  assert.equal(checks.get("transition-legality")!.status, "fail", "unenumerated violations must still fail");
  assert.ok(
    (checks.get("transition-legality")!.details ?? []).some((d) => d.includes("not a legal transition")),
  );
});

test("an implementer-role reconciliation decision is rejected", () => {
  const record = defectiveMergedRecord();
  const reconciliation = decidedReconciliation();
  reconciliation.role = "implementer";
  const { outcome } = runReconciliationValidation([reconciliation], [record], [approvedAcr()]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("only the architect may decide"))),
  );
  assert.equal(outcome.active.size, 0);
});

test("a reconciliation decided before its cited events is rejected", () => {
  const record = defectiveMergedRecord();
  const reconciliation = decidedReconciliation();
  reconciliation.decided_at = "2026-01-01T05:00:00Z"; // before the merge (05:58)
  const { outcome } = runReconciliationValidation([reconciliation], [record], [approvedAcr()]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("predates defect"))),
  );
  assert.equal(outcome.active.size, 0);
});

test("a reconciliation decided before its ACR approval is rejected", () => {
  const record = defectiveMergedRecord();
  const reconciliation = decidedReconciliation();
  reconciliation.decided_at = "2026-01-01T07:15:00Z"; // before the ACR approval (07:20)
  const { outcome } = runReconciliationValidation([reconciliation], [record], [approvedAcr()]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("predates the sanctioning ACR approval"))),
  );
  assert.equal(outcome.active.size, 0);
});

test("a reconciliation under a PROPOSED ACR cannot be decided", () => {
  const record = defectiveMergedRecord();
  const acr = approvedAcr();
  acr.status = "PROPOSED";
  acr.review = undefined;
  acr.approval = undefined;
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [acr]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("can only be DECIDED under an APPROVED or IMPLEMENTED ACR"))),
  );
  assert.equal(outcome.active.size, 0);
});

test("the sanctioning ACR must list the reconciled work item", () => {
  const record = defectiveMergedRecord();
  const acr = approvedAcr();
  acr.affected_work_items = ["TEST-999"];
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [acr]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("does not list 'TEST-011'"))),
  );
});

test("reconciliation applies only to already-merged records", () => {
  const record = defectiveMergedRecord();
  record.state = "PR_OPEN";
  record.transitions = record.transitions.filter((t) => !(t.from === "IMPLEMENTING" && t.to === "PR_OPEN"));
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("only to already-merged historical records"))),
  );
});

test("a DECIDED reconciliation must rest on qualifying evidence", () => {
  const record = defectiveMergedRecord();
  const reconciliation = decidedReconciliation();
  reconciliation.evidence = [
    {
      id: "EV-001",
      type: "screenshot",
      description: "A screenshot never qualifies.",
      produced_at: "2026-01-01T06:30:00Z",
      reproducible: false,
      references: {},
    },
  ];
  const { outcome } = runReconciliationValidation([reconciliation], [record], [approvedAcr()]);
  assert.ok(
    outcome.checks.some((c) => c.status === "fail" && (c.details ?? []).some((d) => d.includes("revision-bound evidence"))),
  );
  assert.equal(outcome.active.size, 0);
});

test("stale citations that reference non-existent violations are rejected", () => {
  const record = baseVerifiedRecord(); // healthy record, no violations
  record.id = "TEST-011";
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  const citationFailures = outcome.checks.filter((c) => c.status === "fail" && c.id.includes("/citations"));
  assert.ok(citationFailures.length > 0, "citing a violation that does not exist must fail");
  assert.equal(outcome.active.size, 0);
});

test("VERIFIED evidence gating is never waivable", () => {
  // A reconciled record that reaches VERIFIED without qualifying evidence
  // must still fail the evidence check — reconciliation waives nothing there.
  const record = defectiveMergedRecord();
  record.evidence = [];
  record.decisions = [];
  record.transitions.push({
    from: "MERGED",
    to: "VERIFIED",
    at: "2026-01-01T10:00:00Z",
    actor: "architect-a",
    role: "architect",
    reason: "verified",
    references: { decision: "DEC-001", evidence: [] },
  });
  record.state = "VERIFIED";
  const { outcome } = runReconciliationValidation([decidedReconciliation()], [record], [approvedAcr()]);
  const checks = checkIds(record, outcome.active);
  assert.equal(checks.get("evidence")!.status, "fail", "VERIFIED evidence gating must hold regardless of reconciliation");
});

test("reconciliation violation keys are stable and narrow", () => {
  assert.equal(
    reconciliationViolationKey({ rule: "transition-legality", violation: "unauthorized-role", transition: 8 }),
    "transition-legality/t8/unauthorized-role",
  );
  assert.equal(
    reconciliationViolationKey({ rule: "temporal-ordering", violation: "precedes-previous", transition: 8 }),
    "temporal-ordering/t8/precedes-previous",
  );
  assert.equal(
    reconciliationViolationKey({ rule: "decisions", violation: "no-prior-approved-decision", state_entry: "MERGED" }),
    "decisions/entry:MERGED/no-prior-approved-decision",
  );
});

// ----------------------------------------------------------------------
// GOV-001 (Issue #16): the reconcilable decisions-entry key must also be
// emitted when the last prior decision exists but is non-approved. The
// fixtures below are deterministic and cover the required matrix: no prior
// decisions, prior changes_requested, prior approved, and a real
// ACR-sanctioned reconciliation over the prior-non-approved case.
// ----------------------------------------------------------------------

/**
 * A record whose only ledger defects are the CC009-shaped pair: the physical
 * merge (05:58) preceded the recorded approval (06:00), so transition #12
 * inverts the temporal order and, at the immutable merge timestamp, the last
 * prior decision is DEC-001 (changes_requested) — a prior NON-approved
 * decision. Everything else is legal: the first changes_requested review was
 * remediated through a legal return to IMPLEMENTING, and the approval
 * transition cites the later approved decision.
 */
function priorNonApprovedMergedRecord(): WorkItemRecord {
  const record = baseVerifiedRecord();
  record.id = "TEST-012";
  record.state = "MERGED";
  record.acr = undefined;
  const review = record.transitions.find((t) => t.to === "ARCHITECT_REVIEW")!;
  review.at = "2026-01-01T05:00:00Z";
  const approvedTransition = record.transitions.find((t) => t.to === "APPROVED")!;
  approvedTransition.at = "2026-01-01T06:00:00Z";
  // The approval transition must cite the later approved decision (DEC-002),
  // not the remediated changes_requested decision (DEC-001).
  approvedTransition.references = { decision: "DEC-002" };
  const merged = record.transitions.find((t) => t.to === "MERGED")!;
  merged.at = "2026-01-01T05:58:00Z";
  // Drop the verify transition; the record ends at MERGED.
  record.transitions = record.transitions.filter((t) => t.to !== "VERIFIED");
  // Insert the remediation loop between the first review and the approval:
  // ARCHITECT_REVIEW -> IMPLEMENTING -> PR_OPEN -> VERIFYING -> ARCHITECT_REVIEW.
  const remediationLoop: WorkItemRecord["transitions"] = [
    {
      from: "ARCHITECT_REVIEW",
      to: "IMPLEMENTING",
      at: "2026-01-01T05:30:00Z",
      actor: "architect-a",
      role: "architect",
      reason: "changes requested on first review",
      failure_reason: "evidence gaps",
    },
    {
      from: "IMPLEMENTING",
      to: "PR_OPEN",
      at: "2026-01-01T05:45:00Z",
      actor: "implementer-a",
      role: "implementer",
      reason: "remediation submitted",
      references: { pr: 43 },
    },
    {
      from: "PR_OPEN",
      to: "VERIFYING",
      at: "2026-01-01T05:50:00Z",
      actor: "implementer-a",
      role: "implementer",
      reason: "remediation verification",
    },
    {
      from: "VERIFYING",
      to: "ARCHITECT_REVIEW",
      at: "2026-01-01T05:55:00Z",
      actor: "ci",
      role: "automation",
      reason: "remediation evidence complete",
      references: { evidence: ["EV-001"] },
    },
  ];
  const insertAt = record.transitions.findIndex((t) => t.to === "APPROVED");
  record.transitions.splice(insertAt, 0, ...remediationLoop);
  record.decisions = [
    {
      id: "DEC-001",
      status: "changes_requested",
      decided_at: "2026-01-01T05:00:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "changes requested",
      remediation_required: "fix the evidence gaps",
      evidence_refs: ["EV-001"],
    },
    {
      id: "DEC-002",
      status: "approved",
      decided_at: "2026-01-01T06:00:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "approved after remediation",
      evidence_refs: ["EV-001"],
    },
  ];
  return record;
}

function nonApprovedSanctioningAcr(): AcrRecord {
  const acr = approvedAcr();
  acr.id = "ACR-012";
  acr.affected_work_items = ["TEST-012"];
  return acr;
}

/** The transition #12 facts, verbatim, for citation integrity. */
function mergeTransitionFacts() {
  return {
    from: "APPROVED",
    to: "MERGED",
    at: "2026-01-01T05:58:00Z",
    actor: "owner",
    role: "product-owner",
  };
}

function nonApprovedDecidedReconciliation(): ReconciliationRecord {
  const original = mergeTransitionFacts();
  return {
    id: "REC-TEST-012",
    work_item: "TEST-012",
    status: "DECIDED",
    problem:
      "The physical merge (05:58:00Z) preceded the recorded approval decision (06:00:00Z); at the immutable merge timestamp the last prior decision is DEC-001 (changes_requested).",
    defects: [
      {
        rule: "temporal-ordering",
        violation: "precedes-previous",
        transition: 12,
        original,
        explanation: "The merge timestamp precedes the recorded approval timestamp.",
      },
      {
        rule: "decisions",
        violation: "no-prior-approved-decision",
        state_entry: "MERGED",
        original,
        explanation: "At the immutable merge timestamp, no approved decision had yet been recorded.",
      },
    ],
    evidence: [
      {
        id: "EV-001",
        type: "ci-run",
        description: "Post-merge verification of the merged revision.",
        produced_at: "2026-01-01T06:30:00Z",
        reproducible: true,
        reproduction: "inspect the CI run",
        references: { commit: "abcdef1", pr: 43 },
      },
    ],
    acr: "ACR-012",
    decided_by: "architect-a",
    role: "architect",
    decided_at: "2026-01-01T08:00:00Z",
    rationale: "The approval exists and covers the merged implementation; the defect was a recording-order failure.",
    remediation: "The item may proceed to VERIFIED only through the normal architect-verified path.",
  } as ReconciliationRecord;
}

test("GOV-001: the raw collector emits the stable decisions-entry key when the last prior decision is non-approved", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  const violations = collectReconcilableViolations(priorNonApprovedMergedRecord(), machine);
  const key = "decisions/entry:MERGED/no-prior-approved-decision";
  assert.ok(violations.has(key), `the stable key must be emitted for a prior non-approved decision: ${key}`);
  const message = violations.get(key)!;
  assert.ok(message.includes("changes_requested"), "the message must name the non-approved status");
  assert.ok(message.includes("'DEC-001'"), "the message must identify the offending decision");
});

test("GOV-001: the raw collector still emits the same stable key when no prior decision exists", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  const violations = collectReconcilableViolations(defectiveMergedRecord(), machine);
  assert.ok(violations.has("decisions/entry:MERGED/no-prior-approved-decision"));
});

test("GOV-001: the raw collector stays silent when the last prior decision satisfies the entry requirement", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  const violations = collectReconcilableViolations(baseVerifiedRecord(), machine);
  for (const key of violations.keys()) {
    assert.ok(!key.startsWith("decisions/entry:"), `no decisions-entry key should be emitted, found '${key}'`);
  }
});

test("GOV-001: a non-approved last prior decision still fails the decisions rule without an active reconciliation", () => {
  const checks = checkIds(priorNonApprovedMergedRecord());
  const decisions = checks.get("decisions")!;
  assert.equal(decisions.status, "fail", "the strict decision validator must keep rejecting the raw record");
  const detail = (decisions.details ?? []).join(" ");
  assert.ok(detail.includes("'DEC-001'"), "the failure must identify the non-approved decision");
  assert.ok(detail.includes("changes_requested"), "the failure must name the non-approved status");
});

test("GOV-001: an ACR-sanctioned reconciliation waives exactly the prior-non-approved decisions-entry key", () => {
  const record = priorNonApprovedMergedRecord();
  const { outcome } = runReconciliationValidation(
    [nonApprovedDecidedReconciliation()],
    [record],
    [nonApprovedSanctioningAcr()],
  );
  assert.deepEqual(outcome.checks.filter((c) => c.status === "fail"), []);
  assert.equal(outcome.active.size, 1);
  const active = outcome.active.get("TEST-012")!;
  assert.deepEqual(
    [...active.waivedKeys].sort(),
    ["decisions/entry:MERGED/no-prior-approved-decision", "temporal-ordering/t12/precedes-previous"],
  );

  const checks = checkIds(record, outcome.active);
  const decisions = checks.get("decisions")!;
  assert.equal(decisions.status, "pass", "the decisions rule must pass under the active reconciliation");
  const detail = (decisions.details ?? []).join(" ");
  assert.ok(detail.includes("[RECONCILED]"), "the waiver must be explicitly annotated, never silent");
  assert.ok(detail.includes("REC-TEST-012"), "the annotation must name the reconciliation");
  assert.equal(checks.get("temporal-ordering")!.status, "pass");
  assert.equal(checks.get("transition-legality")!.status, "pass");
});

test("GOV-001: the waiver never suppresses unrelated decision violations", () => {
  const record = priorNonApprovedMergedRecord();
  // An unrelated decision violation: DEC-002 references unknown evidence.
  record.decisions![1]!.evidence_refs = ["EV-999"];
  const { outcome } = runReconciliationValidation(
    [nonApprovedDecidedReconciliation()],
    [record],
    [nonApprovedSanctioningAcr()],
  );
  assert.equal(outcome.active.size, 1, "the unrelated violation must not deactivate the reconciliation");
  const checks = checkIds(record, outcome.active);
  const decisions = checks.get("decisions")!;
  assert.equal(decisions.status, "fail", "unrelated decision violations must still fail");
  const detail = (decisions.details ?? []).join(" ");
  assert.ok(detail.includes("unknown evidence 'EV-999'"), "the unrelated violation must be reported");
  assert.ok(detail.includes("[RECONCILED]"), "the waived entry stays explicitly annotated");
  assert.ok(detail.includes("REC-TEST-012"), "the annotation must name the reconciliation");
});
