/**
 * Shared test helpers: loads the real governance artifacts from the repository
 * and provides a minimal, valid, fully-VERIFIED work-item record as the base
 * fixture for mutation-based negative tests.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadArchitectureVersions,
  loadWorkflowStates,
  parseRequirementIds,
} from "../src/loaders.js";
import { validateWorkItem } from "../src/rules.js";
import type { WorkItemContext } from "../src/rules.js";
import type { WorkItemRecord } from "../src/types.js";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function makeContext(registry: WorkItemRecord[] = []): WorkItemContext {
  return {
    machine: loadWorkflowStates(REPO_ROOT),
    architectureVersions: loadArchitectureVersions(REPO_ROOT),
    requirementIds: parseRequirementIds(join(REPO_ROOT, "spec", "requirements.md")),
    registry: new Map(registry.map((r) => [r.id, r])),
  };
}

/**
 * A minimal record that reaches VERIFIED entirely legally:
 * DRAFT → READY → ASSIGNED → IMPLEMENTING → PR_OPEN → VERIFYING →
 * ARCHITECT_REVIEW → APPROVED → MERGED → VERIFIED,
 * with one qualifying evidence item and one approved architect decision.
 */
export function baseVerifiedRecord(): WorkItemRecord {
  return structuredClone({
    id: "TEST-001",
    title: "Base verified fixture",
    issue: 42,
    objective: "Minimal valid record used as the base for mutation tests.",
    architecture_version: "1.0",
    requirements: ["FLOW-001"],
    dependencies: [],
    acceptance_criteria: ["criterion one"],
    non_goals: ["none"],
    evidence_requirements: ["one accepted evidence item"],
    state: "VERIFIED",
    transitions: [
      {
        from: "DRAFT",
        to: "READY",
        at: "2026-01-01T00:00:00Z",
        actor: "owner",
        role: "product-owner",
        reason: "ready",
        references: { issue: 42 },
      },
      {
        from: "READY",
        to: "ASSIGNED",
        at: "2026-01-01T01:00:00Z",
        actor: "owner",
        role: "product-owner",
        reason: "assigned",
        references: { issue: 42, assignee: "implementer-a" },
      },
      {
        from: "ASSIGNED",
        to: "IMPLEMENTING",
        at: "2026-01-01T02:00:00Z",
        actor: "implementer-a",
        role: "implementer",
        reason: "started",
      },
      {
        from: "IMPLEMENTING",
        to: "PR_OPEN",
        at: "2026-01-01T03:00:00Z",
        actor: "implementer-a",
        role: "implementer",
        reason: "opened pr",
        references: { pr: 42 },
      },
      {
        from: "PR_OPEN",
        to: "VERIFYING",
        at: "2026-01-01T04:00:00Z",
        actor: "implementer-a",
        role: "implementer",
        reason: "submitted",
      },
      {
        from: "VERIFYING",
        to: "ARCHITECT_REVIEW",
        at: "2026-01-01T05:00:00Z",
        actor: "ci",
        role: "automation",
        reason: "evidence complete",
        references: { evidence: ["EV-001"] },
      },
      {
        from: "ARCHITECT_REVIEW",
        to: "APPROVED",
        at: "2026-01-01T06:00:00Z",
        actor: "architect-a",
        role: "architect",
        reason: "approved",
        references: { decision: "DEC-001" },
      },
      {
        from: "APPROVED",
        to: "MERGED",
        at: "2026-01-01T07:00:00Z",
        actor: "owner",
        role: "product-owner",
        reason: "merged",
        references: { merge_commit: "abcdef1" },
      },
      {
        from: "MERGED",
        to: "VERIFIED",
        at: "2026-01-01T08:00:00Z",
        actor: "architect-a",
        role: "architect",
        reason: "verified",
        references: { decision: "DEC-001", evidence: ["EV-001"] },
      },
    ],
    evidence: [
      {
        id: "EV-001",
        type: "automated-test-suite",
        description: "test suite",
        produced_at: "2026-01-01T05:00:00Z",
        reproducible: true,
        reproduction: "npm test",
        references: { pr: 42, commit: "1234567" },
      },
    ],
    decisions: [
      {
        id: "DEC-001",
        status: "approved",
        decided_at: "2026-01-01T06:00:00Z",
        decided_by: "architect-a",
        role: "architect",
        rationale: "approved",
        evidence_refs: ["EV-001"],
      },
    ],
  });
}

/** Returns the failing check ids for a record (without the work-item/ prefix). */
export function failingCheckIds(record: WorkItemRecord, ctx: WorkItemContext): string[] {
  return validateWorkItem(record, ctx)
    .filter((c) => c.status === "fail")
    .map((c) => c.id.replace(/^work-item\//, ""));
}
