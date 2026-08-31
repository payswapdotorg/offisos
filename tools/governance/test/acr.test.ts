/**
 * ACR registry tests (ARCH-WF-002, Issue #12).
 *
 * Proves: the machine-checkable ACR lifecycle — PROPOSED → ENDORSED
 * (architect review) → APPROVED (product-owner approval) → IMPLEMENTED
 * (bidirectional work-item linkage), with REJECTED terminal — is enforced
 * with role ownership, ordering, reference resolution, version binding and
 * demo isolation. Every test mutates a valid base fixture and expects the
 * mutated record to fail with an attributable reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAcrRegistry, validateArchitectureVersionAcrBinding } from "../src/acr.js";
import type { LoadedAcr } from "../src/loaders.js";
import type { AcrRecord, ArchitectureVersionsFile, WorkItemRecord } from "../src/types.js";
import { baseVerifiedRecord } from "./helpers.js";

function makeAcrRegistryContext(workItems: WorkItemRecord[]) {
  return {
    architectureVersions: {
      active_version: "1.1",
      versions: [
        { version: "1.0", status: "SUPERSEDED", defined_by: ["spec/architecture.md"] },
        {
          version: "1.1",
          status: "FROZEN",
          defined_by: ["spec/architecture.md"],
          change_requests: ["ACR-002"],
        },
        { version: "1.2", status: "FROZEN", defined_by: ["spec/architecture.md"], change_requests: ["ACR-010"] },
      ],
    } as ArchitectureVersionsFile,
    requirementIds: new Set(["FLOW-001", "FLOW-002", "FLOW-003", "FLOW-004", "FLOW-005"]),
    workItems: new Map(workItems.map((w) => [w.id, w] as const)),
  };
}

function baseAcr(): AcrRecord {
  return structuredClone({
    id: "ACR-010",
    title: "Base ACR fixture",
    status: "PROPOSED",
    requested_by: "requester-a",
    requested_at: "2026-09-01T00:00:00Z",
    problem: "A sample problem statement long enough for the schema.",
    evidence: ["issue #1 describes the problem"],
    impact: "A sample impact statement long enough for the schema.",
    alternatives: ["do nothing — rejected because the problem stands."],
    recommendation: "A sample recommendation long enough for the schema.",
    migration_plan: "A sample migration plan long enough for the schema.",
    compatibility: "A sample compatibility analysis long enough for the schema.",
    security_impact: "A sample security impact analysis long enough for the schema.",
    affected_requirements: ["FLOW-001"],
    affected_work_items: ["TEST-001"],
    architecture_version_from: "1.1",
    architecture_version_to: "1.1",
    authorized_paths: ["governance/protected-paths.json"],
  });
}

function decidedAcr(): AcrRecord {
  const acr = baseAcr();
  acr.status = "IMPLEMENTED";
  acr.review = {
    reviewed_by: "architect-a",
    role: "architect",
    reviewed_at: "2026-09-01T00:10:00Z",
    verdict: "endorsed",
    rationale: "endorsed",
  };
  acr.approval = {
    approved_by: "owner-a",
    role: "product-owner",
    approved_at: "2026-09-01T00:20:00Z",
    decision: "approved",
    rationale: "approved",
  };
  acr.implementation = {
    work_item: "TEST-001",
    references: { pr: 7, commit: "1234567" },
  };
  return acr;
}

function runAcrValidation(
  records: AcrRecord[],
  workItems: WorkItemRecord[] = [baseVerifiedRecord()],
  legacyAcrIds: Set<string> = new Set(["ACR-001", "ACR-002"]),
) {
  const loaded: LoadedAcr[] = records.map((record, i) => ({ file: `${record.id}.json`, record }));
  const ctx = makeAcrRegistryContext(workItems);
  // The implementation linkage requires the work item to reference the ACR back.
  const items = workItems.map((w) =>
    w.id === "TEST-001" && records.some((r) => r.implementation?.work_item === "TEST-001")
      ? { ...w, acr: records.find((r) => r.implementation?.work_item === "TEST-001")!.id }
      : w,
  );
  ctx.workItems = new Map(items.map((w) => [w.id, w] as const));
  return { outcome: validateAcrRegistry(loaded, ctx, legacyAcrIds), ctx };
}

function lifecycleFailures(records: AcrRecord[]): string[] {
  const { outcome } = runAcrValidation(records);
  return outcome.checks
    .filter((c) => c.status === "fail" && c.id.includes("/lifecycle"))
    .flatMap((c) => c.details ?? []);
}

function referenceFailures(records: AcrRecord[], workItems: WorkItemRecord[] = [baseVerifiedRecord()]): string[] {
  const { outcome } = runAcrValidation(records, workItems);
  return outcome.checks
    .filter((c) => c.status === "fail" && c.id.includes("/references"))
    .flatMap((c) => c.details ?? []);
}

test("a fully decided ACR passes every lifecycle and reference rule", () => {
  const { outcome } = runAcrValidation([decidedAcr()]);
  const failures = outcome.checks.filter((c) => c.status === "fail");
  assert.deepEqual(failures, []);
  assert.equal(outcome.registry.size, 1);
});

test("PROPOSED must not already carry review, approval or implementation", () => {
  const acr = baseAcr();
  acr.review = {
    reviewed_by: "architect-a",
    role: "architect",
    reviewed_at: "2026-09-01T00:10:00Z",
    verdict: "endorsed",
    rationale: "endorsed",
  };
  const failures = lifecycleFailures([acr]);
  assert.ok(failures.some((d) => d.includes("PROPOSED but a review is already recorded")));
});

test("ENDORSED requires an endorsed architect review and no approval yet", () => {
  const acr = baseAcr();
  acr.status = "ENDORSED";
  assert.ok(lifecycleFailures([acr]).some((d) => d.includes("ENDORSED requires a recorded architect review")));

  const endorsed = baseAcr();
  endorsed.status = "ENDORSED";
  endorsed.review = {
    reviewed_by: "architect-a",
    role: "architect",
    reviewed_at: "2026-09-01T00:10:00Z",
    verdict: "endorsed",
    rationale: "endorsed",
  };
  endorsed.approval = {
    approved_by: "owner-a",
    role: "product-owner",
    approved_at: "2026-09-01T00:20:00Z",
    decision: "approved",
    rationale: "approved",
  };
  assert.ok(lifecycleFailures([endorsed]).some((d) => d.includes("ENDORSED but an approval is already recorded")));
});

test("APPROVED requires endorsed review plus product-owner approval in order", () => {
  const acr = baseAcr();
  acr.status = "APPROVED";
  assert.ok(lifecycleFailures([acr]).some((d) => d.includes("APPROVED requires a prior architect review")));

  const wrongOrder = decidedAcr();
  wrongOrder.status = "APPROVED";
  wrongOrder.implementation = undefined;
  wrongOrder.review!.reviewed_at = "2026-09-01T00:25:00Z"; // after the approval
  assert.ok(
    lifecycleFailures([wrongOrder]).some((d) => d.includes("predates the architect review")),
  );

  const wrongRole = decidedAcr();
  wrongRole.status = "APPROVED";
  wrongRole.implementation = undefined;
  wrongRole.approval!.role = "architect";
  assert.ok(
    lifecycleFailures([wrongRole]).some((d) => d.includes("only the product-owner may approve")),
  );

  const wrongReviewRole = decidedAcr();
  wrongReviewRole.status = "APPROVED";
  wrongReviewRole.implementation = undefined;
  wrongReviewRole.review!.role = "product-owner";
  assert.ok(
    lifecycleFailures([wrongReviewRole]).some((d) => d.includes("only the architect may review")),
  );
});

test("IMPLEMENTED requires a bidirectional implementation linkage", () => {
  const acr = decidedAcr();
  acr.implementation!.work_item = "TEST-002"; // not registered
  assert.ok(lifecycleFailures([acr]).some((d) => d.includes("unknown work item")));

  const noRef = decidedAcr();
  noRef.implementation!.references = {};
  assert.ok(lifecycleFailures([noRef]).some((d) => d.includes("must reference the landing PR and/or commit")));
});

test("REJECTED requires an actual rejection at either gate", () => {
  const acr = baseAcr();
  acr.status = "REJECTED";
  assert.ok(lifecycleFailures([acr]).some((d) => d.includes("REJECTED requires either a rejected architect review")));

  const rejectedAtReview = baseAcr();
  rejectedAtReview.status = "REJECTED";
  rejectedAtReview.review = {
    reviewed_by: "architect-a",
    role: "architect",
    reviewed_at: "2026-09-01T00:10:00Z",
    verdict: "rejected",
    rationale: "rejected",
  };
  assert.deepEqual(lifecycleFailures([rejectedAtReview]), []);
});

test("a version-changing ACR must create its immutable version once approved", () => {
  const unregistered = decidedAcr();
  unregistered.architecture_version_to = "1.3"; // not in the registry
  assert.ok(
    lifecycleFailures([unregistered]).some((d) => d.includes("architecture_version_to '1.3' is not registered")),
  );

  const unbound = decidedAcr();
  unbound.architecture_version_to = "1.1"; // registered but 1.1→1.1: same-version; use 1.2 with wrong change_requests
  unbound.id = "ACR-011";
  unbound.architecture_version_from = "1.1";
  unbound.architecture_version_to = "1.2"; // change_requests lists ACR-010, not ACR-011
  assert.ok(
    lifecycleFailures([unbound]).some((d) => d.includes("does not list 'ACR-011' in its change_requests")),
  );

  // PROPOSED version-changing ACRs may target a not-yet-registered version.
  const proposedFuture = baseAcr();
  proposedFuture.architecture_version_to = "1.3";
  assert.deepEqual(lifecycleFailures([proposedFuture]), []);
});

test("references must resolve: requirements, work items, legacy collision, globs, demo rules", () => {
  const badReq = baseAcr();
  badReq.affected_requirements = ["FLOW-999"];
  assert.ok(referenceFailures([badReq]).some((d) => d.includes("affected requirement 'FLOW-999'")));

  const badItem = baseAcr();
  badItem.affected_work_items = ["TEST-999"];
  assert.ok(referenceFailures([badItem]).some((d) => d.includes("affected work item 'TEST-999'")));

  const legacyCollision = baseAcr();
  legacyCollision.id = "ACR-002"; // legacy markdown id
  assert.ok(referenceFailures([legacyCollision]).some((d) => d.includes("collides with a legacy markdown ACR")));

  const glob = baseAcr();
  glob.authorized_paths = ["governance/acr/**"];
  assert.ok(referenceFailures([glob]).some((d) => d.includes("glob character")));

  const demo = baseAcr();
  demo.id = "ACR-901";
  demo.demo = true;
  assert.ok(referenceFailures([demo]).some((d) => d.includes("must carry a non-empty disclaimer")));

  const demoWrongRange = baseAcr();
  demoWrongRange.demo = true;
  assert.ok(referenceFailures([demoWrongRange]).some((d) => d.includes("reserved ACR-9xx id range")));

  const realInRange = baseAcr();
  realInRange.id = "ACR-905";
  assert.ok(referenceFailures([realInRange]).some((d) => d.includes("must not use the demo-reserved")));
});

test("real ACRs may not list demo work items as affected", () => {
  const demoItem = baseVerifiedRecord();
  demoItem.id = "TEST-002";
  demoItem.demo = true;
  demoItem.disclaimer = "demo";
  const acr = baseAcr();
  acr.affected_work_items = ["TEST-002"];
  assert.ok(
    referenceFailures([acr], [baseVerifiedRecord(), demoItem]).some((d) => d.includes("lists demo fixture")),
  );
});

test("architecture-version change_requests must resolve to registry or legacy ACRs", () => {
  const versions: ArchitectureVersionsFile = {
    active_version: "1.1",
    versions: [
      { version: "1.1", status: "FROZEN", defined_by: ["spec/architecture.md"], change_requests: ["ACR-002", "ACR-777"] },
    ],
  };
  const registry = new Map([["ACR-010", baseAcr()]]);
  const result = validateArchitectureVersionAcrBinding(versions, registry, new Set(["ACR-002"]));
  assert.equal(result.status, "fail");
  assert.ok((result.details ?? []).some((d) => d.includes("'ACR-777'")));

  const okResult = validateArchitectureVersionAcrBinding(
    { ...versions, versions: [{ ...versions.versions[0]!, change_requests: ["ACR-002", "ACR-010"] }] },
    registry,
    new Set(["ACR-002"]),
  );
  assert.equal(okResult.status, "pass");
});
