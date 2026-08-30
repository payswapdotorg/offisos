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
import { validateWorkItem } from "../src/rules.js";
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
