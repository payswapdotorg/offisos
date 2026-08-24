/**
 * Evidence gating tests — the core LOCK-004 control.
 *
 * Proves: VERIFIED is impossible with only screenshots, narrative claims,
 * demos or implementation-status evidence; evidence must be reproducible and
 * revision-bound; VERIFIED requires an approved Architect decision bound to
 * the transition history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseVerifiedRecord, makeContext, failingCheckIds } from "./helpers.js";
import type { WorkItemRecord } from "../src/types.js";

function withOnlyEvidenceType(record: WorkItemRecord, type: string): WorkItemRecord {
  record.evidence = [
    {
      id: "EV-001",
      type,
      description: "evidence under test",
      produced_at: "2026-01-01T05:00:00Z",
      reproducible: false,
      references: {},
    },
  ];
  return record;
}

for (const insufficient of ["screenshot", "narrative-claim", "demo", "implementation-status"]) {
  test(`VERIFIED is rejected when the only evidence is a ${insufficient}`, () => {
    const ctx = makeContext();
    const record = withOnlyEvidenceType(baseVerifiedRecord(), insufficient);
    const failing = failingCheckIds(record, ctx);
    assert.ok(failing.includes("TEST-001/evidence"), `expected evidence failure, got: ${failing.join(", ")}`);
  });
}

test("VERIFIED is rejected when accepted evidence is not reproducible", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.evidence![0]!.reproducible = false;
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/evidence"));
});

test("VERIFIED is rejected when accepted evidence is not revision-bound", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.evidence![0]!.references = {};
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/evidence"));
});

test("VERIFIED is rejected when no architect decision exists", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.decisions = [];
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"), `expected decision failure, got: ${failing.join(", ")}`);
});

test("VERIFIED is rejected when the decision cited by the verify transition is not approved", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.decisions![0]!.status = "rejected";
  record.decisions![0]!.remediation_required = "redo everything";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"));
});

test("MERGED is rejected when the last prior decision is not approved", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.state = "MERGED";
  record.transitions = record.transitions.slice(0, 8); // up to APPROVED -> MERGED
  record.decisions![0]!.status = "changes_requested";
  record.decisions![0]!.remediation_required = "fix evidence";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"), `expected decision failure, got: ${failing.join(", ")}`);
});

test("the verify transition must cite qualifying evidence", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  // Downgrade the cited evidence to a screenshot while keeping the record
  // otherwise intact: the verify transition now cites non-qualifying evidence.
  record.evidence![0]!.type = "screenshot";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/evidence"));
});

test("decisions must reference existing evidence", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.decisions![0]!.evidence_refs = ["EV-999"];
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/decisions"));
});

test("duplicate evidence ids are rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.evidence!.push(structuredClone(record.evidence![0]!));
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/evidence"));
});
