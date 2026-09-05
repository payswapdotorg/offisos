/**
 * Revision-bound verification tests (ARCH-WF-002, Issue #12).
 *
 * Proves: the transition into VERIFIED must bind to the exact implementation
 * revision it verified (a transition commit or commit-bound cited evidence);
 * the drift audit flags bound paths that changed after the binding revision
 * (later material implementation changes invalidate prior verification),
 * stays quiet for governance-only drift including governance/.github/tools
 * paths even when such a path is explicitly cited, rejects unresolvable
 * bindings, and skips demo fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindingRevision,
  boundPathsOf,
  computeVerifiedRevisionAudit,
  isMaterialPath,
} from "../src/revision-binding.js";
import { validateWorkItem } from "../src/rules.js";
import { makeContext, baseVerifiedRecord } from "./helpers.js";
import type { GitOperations } from "../src/revision-binding.js";

test("the verify-transition revision-binding rule holds for the base fixture", () => {
  const ctx = makeContext([baseVerifiedRecord()]);
  const results = validateWorkItem(baseVerifiedRecord(), ctx);
  const binding = results.find((r) => r.id.endsWith("/revision-binding"));
  assert.ok(binding !== undefined);
  assert.equal(binding.status, "pass");
  assert.ok((binding.description ?? "").includes("EV-001"));
});

test("a verify transition citing only non-commit evidence fails the binding rule", () => {
  const record = baseVerifiedRecord();
  record.evidence![0]!.references = { pr: 42 }; // no commit anywhere
  const ctx = makeContext([record]);
  const results = validateWorkItem(record, ctx);
  const binding = results.find((r) => r.id.endsWith("/revision-binding"));
  assert.equal(binding!.status, "fail");
});

test("the binding revision prefers the transition commit and falls back to cited evidence", () => {
  const withTransitionCommit = baseVerifiedRecord();
  const verify = withTransitionCommit.transitions.find((t) => t.to === "VERIFIED")!;
  verify.references = { decision: "DEC-001", evidence: ["EV-001"], commit: "9876543" };
  assert.equal(bindingRevision(withTransitionCommit), "9876543");

  const evidenceOnly = baseVerifiedRecord();
  const verifyFallback = evidenceOnly.transitions.find((t) => t.to === "VERIFIED")!;
  verifyFallback.references = { decision: "DEC-001", evidence: ["EV-001"] };
  assert.equal(bindingRevision(evidenceOnly), "1234567");
});

test("bound paths come from the verify-cited evidence only", () => {
  const record = baseVerifiedRecord();
  record.evidence!.push({
    id: "EV-002",
    type: "ci-run",
    description: "not cited by the verify transition",
    produced_at: "2026-01-01T05:00:00Z",
    reproducible: true,
    references: { commit: "9999999", path: "app/uncited.txt" },
  });
  record.evidence![0]!.references = { commit: "1234567", path: "app/bound-fixture.json" };
  assert.deepEqual(boundPathsOf(record), ["app/bound-fixture.json"]);
});

test("material paths exclude governance, docs, spec, research and tooling", () => {
  assert.ok(!isMaterialPath("governance/work-items/X.json"));
  assert.ok(!isMaterialPath(".github/workflows/governance.yml"));
  assert.ok(!isMaterialPath("tools/governance/src/rules.ts"));
  assert.ok(!isMaterialPath("spec/requirements.md"));
  assert.ok(!isMaterialPath("research/cad-001/evidence/run-001"));
  assert.ok(!isMaterialPath("README.md"));
  assert.ok(!isMaterialPath("governance-report.json"));
  assert.ok(isMaterialPath("apps/web/src/app/page.tsx"));
  assert.ok(isMaterialPath("app/test/fixtures/cad-parity-008-layouts.json"));
  assert.ok(isMaterialPath("package.json"));
});

function auditGit(changedAfterBinding: string[]): GitOperations {
  return {
    revParse: (ref: string) => (ref.startsWith("1234567") ? "1234567abcdefabcdefabcdefabcdefabcdef12" : undefined),
    diffNames: () => changedAfterBinding,
  };
}

function verifiedRecordWithBoundPath(path = "app/test/fixtures/pinned.json"): ReturnType<typeof baseVerifiedRecord> {
  const record = baseVerifiedRecord();
  record.evidence![0]!.references = { commit: "1234567", path };
  const verify = record.transitions.find((t) => t.to === "VERIFIED")!;
  verify.references = { decision: "DEC-001", evidence: ["EV-001"] };
  return record;
}

test("a changed bound material path makes the verification stale (invalidation)", () => {
  const record = verifiedRecordWithBoundPath();
  const { check } = computeVerifiedRevisionAudit([record], auditGit(["app/test/fixtures/pinned.json", "governance/work-items/X.json"]));
  assert.equal(check.status, "fail");
  assert.ok((check.details ?? []).join(" ").includes("STALE"));
  assert.ok((check.details ?? []).join(" ").includes("app/test/fixtures/pinned.json"));
});

test("governance-only drift after the binding revision does not invalidate it", () => {
  const record = verifiedRecordWithBoundPath();
  const { check } = computeVerifiedRevisionAudit(
    [record],
    auditGit(["governance/work-items/X.json", "tools/governance/src/rules.ts", "docs/notes.md"]),
  );
  assert.equal(check.status, "pass");
  assert.ok((check.details ?? []).join(" ").includes("intact"));
});

test("a changed non-material bound path does not make the verification stale", () => {
  const record = verifiedRecordWithBoundPath(".github/workflows/governance.yml");
  const { check, entries } = computeVerifiedRevisionAudit(
    [record],
    auditGit([".github/workflows/governance.yml"]),
  );
  assert.equal(check.status, "pass");
  assert.equal(entries[0]!.stale, false);
  assert.deepEqual(entries[0]!.stalePaths, []);
});

test("an unresolvable binding revision is stale", () => {
  const record = verifiedRecordWithBoundPath();
  const git: GitOperations = { revParse: () => undefined, diffNames: () => [] };
  const { check } = computeVerifiedRevisionAudit([record], git);
  assert.equal(check.status, "fail");
  assert.ok((check.details ?? []).join(" ").includes("does not resolve"));
});

test("demo fixtures and non-VERIFIED records are skipped", () => {
  const demo = verifiedRecordWithBoundPath();
  demo.id = "SAMPLE-001";
  demo.demo = true;
  demo.disclaimer = "demo";
  const merged = verifiedRecordWithBoundPath();
  merged.id = "TEST-002";
  merged.state = "MERGED";
  merged.transitions = merged.transitions.filter((t) => t.to !== "VERIFIED");
  const { entries, check } = computeVerifiedRevisionAudit([demo, merged], auditGit(["app/test/fixtures/pinned.json"]));
  assert.deepEqual(entries, []);
  assert.equal(check.status, "pass");
});
