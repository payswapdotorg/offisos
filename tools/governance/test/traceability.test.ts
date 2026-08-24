/**
 * Traceability and lifecycle-integrity tests.
 *
 * Proves: requirements and dependencies resolve against repository-backed
 * registries; execution is blocked until dependencies are VERIFIED;
 * rejections require a documented return to IMPLEMENTING before
 * re-approval; transition history must be contiguous and time-ordered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseVerifiedRecord, makeContext, failingCheckIds } from "./helpers.js";
import type { WorkItemRecord } from "../src/types.js";

function assignedRecord(dependencies: string[]): WorkItemRecord {
  return {
    ...baseVerifiedRecord(),
    id: "TEST-010",
    issue: 43,
    dependencies,
    state: "ASSIGNED",
    transitions: baseVerifiedRecord().transitions.slice(0, 2),
    evidence: [],
    decisions: [],
  };
}

function dependencyRecord(id: string, state: string): WorkItemRecord {
  const record = baseVerifiedRecord();
  record.id = id;
  record.issue = 44;
  record.state = state;
  if (state === "VERIFIED") return record;
  record.transitions = [];
  record.evidence = [];
  record.decisions = [];
  return record;
}

test("requirements must resolve in spec/requirements.md", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.requirements = ["FLOW-001", "FLOW-999"];
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/requirements"));
});

test("dependencies must resolve to registered work items", () => {
  const ctx = makeContext();
  const record = assignedRecord(["NOPE-001"]);
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-010/dependencies"));
});

test("execution is blocked until dependencies are VERIFIED", () => {
  const readyDep = dependencyRecord("DEP-001", "READY");
  const blocked = failingCheckIds(assignedRecord(["DEP-001"]), makeContext([readyDep]));
  assert.ok(blocked.includes("TEST-010/dependencies"), `expected dependency gate failure, got: ${blocked.join(", ")}`);
});

test("execution proceeds when dependencies are VERIFIED", () => {
  const verifiedDep = dependencyRecord("DEP-001", "VERIFIED");
  const failing = failingCheckIds(assignedRecord(["DEP-001"]), makeContext([verifiedDep]));
  assert.ok(!failing.includes("TEST-010/dependencies"), `unexpected failure: ${failing.join(", ")}`);
});

test("rejected decisions must be followed by a return to IMPLEMENTING before re-approval", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  // Architect requested changes at 05:30 (before approval at 06:00) but the
  // implementer never returned to IMPLEMENTING: the later approval must not count.
  record.decisions = [
    {
      id: "DEC-000",
      status: "changes_requested",
      decided_at: "2026-01-01T05:30:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "insufficient evidence",
      evidence_refs: ["EV-001"],
      remediation_required: "add benchmark evidence",
    },
    {
      id: "DEC-001",
      status: "approved",
      decided_at: "2026-01-01T06:00:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "approved",
      evidence_refs: ["EV-001"],
    },
  ];
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"), `expected re-verification enforcement, got: ${failing.join(", ")}`);
});

test("rejection followed by a documented return to IMPLEMENTING is accepted", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  // Architect requested changes; the work returned to IMPLEMENTING and was
  // re-submitted before the approval.
  record.transitions.splice(6, 0, {
    from: "ARCHITECT_REVIEW",
    to: "IMPLEMENTING",
    at: "2026-01-01T05:30:00Z",
    actor: "architect-a",
    role: "architect",
    reason: "changes requested",
    failure_reason: "insufficient evidence",
  });
  record.transitions.splice(7, 0, {
    from: "IMPLEMENTING",
    to: "PR_OPEN",
    at: "2026-01-01T05:40:00Z",
    actor: "implementer-a",
    role: "implementer",
    reason: "re-opened pr with fixes",
    references: { pr: 42 },
  });
  record.transitions.splice(8, 0, {
    from: "PR_OPEN",
    to: "VERIFYING",
    at: "2026-01-01T05:50:00Z",
    actor: "implementer-a",
    role: "implementer",
    reason: "re-submitted",
  });
  record.transitions.splice(9, 0, {
    from: "VERIFYING",
    to: "ARCHITECT_REVIEW",
    at: "2026-01-01T05:55:00Z",
    actor: "ci",
    role: "automation",
    reason: "evidence complete again",
    references: { evidence: ["EV-001"] },
  });
  record.decisions = [
    {
      id: "DEC-000",
      status: "changes_requested",
      decided_at: "2026-01-01T05:30:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "insufficient evidence",
      evidence_refs: ["EV-001"],
      remediation_required: "add benchmark evidence",
    },
    {
      id: "DEC-001",
      status: "approved",
      decided_at: "2026-01-01T06:00:00Z",
      decided_by: "architect-a",
      role: "architect",
      rationale: "approved after remediation",
      evidence_refs: ["EV-001"],
    },
  ];
  assert.deepEqual(failingCheckIds(record, ctx), []);
});

test("timestamp regression in the transition history is rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.transitions[4]!.at = "2026-01-02T00:00:00Z"; // after the transitions that follow it
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/temporal-ordering"));
});

test("non-contiguous transition history is rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  (record.transitions[5] as { from: string }).from = "IMPLEMENTING"; // wrong predecessor
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-chain"));
});

test("state field disagreeing with the last transition is rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.state = "MERGED";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-chain"));
});

test("approval cited by a transition must predate that transition", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.decisions![0]!.decided_at = "2026-01-01T07:30:00Z"; // after ARCHITECT_REVIEW -> APPROVED at 06:00
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"), `expected decision-order failure, got: ${failing.join(", ")}`);
});

test("unknown architecture version is rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.architecture_version = "9.9";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/architecture-version"));
});
