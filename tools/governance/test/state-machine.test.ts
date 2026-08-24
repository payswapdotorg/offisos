/**
 * State machine enforcement tests.
 *
 * Proves: the canonical definition is internally sound, illegal transitions
 * are rejected, transition ownership is enforced, and failure-path
 * transitions carry a failure reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStateMachineDefinition, findTransitionDef } from "../src/state-machine.js";
import { loadWorkflowStates } from "../src/loaders.js";
import { baseVerifiedRecord, makeContext, REPO_ROOT, failingCheckIds } from "./helpers.js";

test("canonical workflow-states.json passes all definition-integrity checks", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  const results = validateStateMachineDefinition(machine);
  for (const result of results) {
    assert.equal(result.status, "pass", `${result.id}: ${result.details?.join("; ")}`);
  }
});

test("state machine contains the frozen lifecycle states", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  const expected = [
    "DRAFT", "READY", "ASSIGNED", "IMPLEMENTING", "PR_OPEN", "VERIFYING",
    "ARCHITECT_REVIEW", "APPROVED", "MERGED", "VERIFIED",
    "IMPLEMENTATION_BLOCKED", "ARCHITECTURE_CHANGE_REQUEST",
  ];
  for (const state of expected) {
    assert.ok(state in machine.states, `state '${state}' must be defined`);
  }
  assert.equal(machine.initial_state, "DRAFT");
  assert.equal(machine.states["VERIFIED"]!.terminal, true);
});

test("illegal transitions are not defined in the machine", () => {
  const machine = loadWorkflowStates(REPO_ROOT);
  assert.equal(findTransitionDef(machine, "DRAFT", "IMPLEMENTING"), undefined, "DRAFT -> IMPLEMENTING skips states");
  assert.equal(findTransitionDef(machine, "DRAFT", "VERIFIED"), undefined, "DRAFT -> VERIFIED skips everything");
  assert.equal(findTransitionDef(machine, "READY", "PR_OPEN"), undefined, "READY -> PR_OPEN skips assignment");
  assert.equal(findTransitionDef(machine, "IMPLEMENTING", "APPROVED"), undefined, "IMPLEMENTING -> APPROVED bypasses review");
  assert.equal(findTransitionDef(machine, "MERGED", "IMPLEMENTING"), undefined, "MERGED cannot go back to IMPLEMENTING");
});

test("records with illegal transitions are rejected", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  // Corrupt transition #3: pretend we jumped ASSIGNED -> PR_OPEN.
  const transition = record.transitions[2]!;
  (transition as { to: string }).to = "PR_OPEN";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-legality"), `expected transition-legality failure, got: ${failing.join(", ")}`);
});

test("transition ownership is enforced: an implementer cannot declare READY", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.transitions[0]!.role = "implementer";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-legality"));
});

test("transition ownership is enforced: an implementer cannot approve or verify", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  record.transitions[6]!.role = "implementer"; // ARCHITECT_REVIEW -> APPROVED
  record.transitions[8]!.role = "implementer"; // MERGED -> VERIFIED
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-legality"));
});

test("failure-path transitions require a failure_reason", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  // Insert a legitimate verification failure before ARCHITECT_REVIEW.
  record.transitions[5] = {
    from: "VERIFYING",
    to: "IMPLEMENTING",
    at: "2026-01-01T04:30:00Z",
    actor: "ci",
    role: "automation",
    reason: "tests failed",
    // failure_reason deliberately omitted
  };
  // Fix chain: subsequent transitions must start from IMPLEMENTING again.
  record.transitions[6] = { ...record.transitions[6]!, from: "IMPLEMENTING", at: "2026-01-01T04:45:00Z" };
  record.transitions[7] = { ...record.transitions[7]!, from: "PR_OPEN", at: "2026-01-01T04:50:00Z" };
  record.transitions[8] = { ...record.transitions[8]!, from: "VERIFYING", at: "2026-01-01T04:55:00Z" };
  // Remove now-duplicated old VERIFYING -> ARCHITECT_REVIEW and rebuild tail.
  record.transitions = record.transitions.slice(0, 9);
  record.state = "ARCHITECT_REVIEW";
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-legality"), `expected failure_reason enforcement, got: ${failing.join(", ")}`);
});

test("IMPLEMENTING -> PR_OPEN requires a pr reference", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  delete record.transitions[3]!.references;
  const failing = failingCheckIds(record, ctx);
  assert.ok(failing.includes("TEST-001/transition-legality"));
});

test("the baseline VERIFIED record passes every rule", () => {
  const ctx = makeContext();
  const record = baseVerifiedRecord();
  assert.deepEqual(failingCheckIds(record, ctx), []);
});
