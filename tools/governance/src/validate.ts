/**
 * Orchestration for the `validate` command: loads every governance artifact,
 * runs all deterministic checks and produces a report.
 *
 * ARCH-WF-002: the ACR registry (governance/acr/) and the reconciliation
 * registry (governance/reconciliations/) are validated in dependency order —
 * ACRs first, then reconciliations (which may cite ACR approvals), then work
 * items (which may consume active reconciliation waivers and ACR reference
 * integrity). A reconciliation that fails its own checks never activates
 * waivers.
 */
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  loadAcrs,
  loadReconciliations,
  loadWorkItems,
  loadRequirementIds,
  readJson,
} from "./loaders.js";
import { validateStateMachineDefinition } from "./state-machine.js";
import { validateWorkItem } from "./rules.js";
import {
  validateAcrRegistry,
  validateArchitectureVersionAcrBinding,
} from "./acr.js";
import { validateReconciliationRegistry } from "./reconciliation.js";
import type {
  ArchitectureVersionsFile,
  CheckResult,
  GovernanceReport,
  ProtectedPathsFile,
  WorkItemRecord,
  WorkflowStates,
} from "./types.js";
import { fail, pass } from "./state-machine.js";

const TOOL = "offisos-governance/0.1.0";

type IssueMigration = {
  work_item: string;
  from_issue: number;
  to_issue: number;
  reason: string;
};

type IssueMigrationFile = {
  migrations: IssueMigration[];
};

export interface ValidateOutcome {
  report: GovernanceReport;
  exitCode: number;
}

function validateArchitectureVersions(file: ArchitectureVersionsFile): CheckResult {
  const details: string[] = [];
  if (file.versions.length === 0) details.push("no architecture versions registered.");
  const versionIds = new Set(file.versions.map((v) => v.version));
  if (!versionIds.has(file.active_version)) {
    details.push(`active_version '${file.active_version}' is not among registered versions: ${[...versionIds].join(", ")}.`);
  }
  for (const v of file.versions) {
    if (v.status !== "FROZEN" && v.status !== "SUPERSEDED") {
      details.push(`version '${v.version}' has unsupported status '${v.status}'.`);
    }
    if (!Array.isArray(v.defined_by) || v.defined_by.length === 0) {
      details.push(`version '${v.version}' must list at least one defining document.`);
    }
  }
  return details.length === 0
    ? pass("architecture-versions/registry", `Architecture version registry valid; active version '${file.active_version}'.`)
    : fail("architecture-versions/registry", "Architecture version registry is invalid.", details);
}

function validateProtectedPathsManifest(file: ProtectedPathsFile, versions: ArchitectureVersionsFile): CheckResult {
  const details: string[] = [];
  if (file.patterns.length === 0) details.push("no protected patterns defined; the architecture lock would be unenforced.");
  const seen = new Set<string>();
  for (const p of file.patterns) {
    if (p.pattern.trim().length === 0) details.push("empty protected pattern.");
    if (seen.has(p.pattern)) details.push(`duplicate protected pattern '${p.pattern}'.`);
    seen.add(p.pattern);
    if (p.reason.trim().length === 0) details.push(`pattern '${p.pattern}' has no reason.`);
  }
  if (file.architecture_version !== versions.active_version) {
    details.push(
      `protected-paths manifest targets architecture '${file.architecture_version}' but the active version is '${versions.active_version}'.`,
    );
  }
  return details.length === 0
    ? pass("protected-paths/manifest", `Protected-path manifest valid (${file.patterns.length} pattern(s)) for architecture '${file.architecture_version}'.`)
    : fail("protected-paths/manifest", "Protected-path manifest is invalid.", details);
}

function validateIssueMigrations(
  file: IssueMigrationFile,
  workItems: Map<string, WorkItemRecord>,
): CheckResult {
  const details: string[] = [];
  const targetOwners = new Map<number, string>();
  const seenWorkItems = new Set<string>();
  const seenSources = new Map<number, string>();

  if (!Array.isArray(file.migrations)) {
    return fail("registry/issue-migrations", "Issue migration registry must contain a migrations array.", []);
  }

  for (const migration of file.migrations) {
    const record = workItems.get(migration.work_item);
    if (record === undefined) {
      details.push(`migration work item '${migration.work_item}' does not resolve to a registered work item.`);
      continue;
    }
    if (record.demo === true) {
      details.push(`migration work item '${migration.work_item}' is a demo fixture.`);
    }
    if (!Number.isInteger(migration.from_issue) || migration.from_issue <= 0) {
      details.push(`migration '${migration.work_item}' has invalid from_issue '${migration.from_issue}'.`);
    }
    if (!Number.isInteger(migration.to_issue) || migration.to_issue <= 0) {
      details.push(`migration '${migration.work_item}' has invalid to_issue '${migration.to_issue}'.`);
    }
    if (migration.from_issue === migration.to_issue) {
      details.push(`migration '${migration.work_item}' must change the issue number.`);
    }
    if (record.issue !== migration.from_issue) {
      details.push(
        `migration '${migration.work_item}' declares source issue #${migration.from_issue}, but the record carries issue #${record.issue}.`,
      );
    }
    if (migration.reason.trim().length === 0) {
      details.push(`migration '${migration.work_item}' must explain why the issue number moved.`);
    }
    if (seenWorkItems.has(migration.work_item)) {
      details.push(`work item '${migration.work_item}' is listed more than once in issue migrations.`);
    }
    seenWorkItems.add(migration.work_item);

    const sourceOwner = seenSources.get(migration.from_issue);
    if (sourceOwner !== undefined && sourceOwner !== migration.work_item) {
      details.push(`source issue #${migration.from_issue} is claimed by both '${sourceOwner}' and '${migration.work_item}'.`);
    }
    seenSources.set(migration.from_issue, migration.work_item);

    const targetOwner = targetOwners.get(migration.to_issue);
    if (targetOwner !== undefined && targetOwner !== migration.work_item) {
      details.push(`target issue #${migration.to_issue} is claimed by both '${targetOwner}' and '${migration.work_item}'.`);
    }
    targetOwners.set(migration.to_issue, migration.work_item);
  }

  const migratedTargetIssues = new Set(targetOwners.keys());
  for (const record of workItems.values()) {
    if (record.demo === true) continue;
    const targetOwner = targetOwners.get(record.issue);
    if (targetOwner !== undefined && targetOwner !== record.id) {
      details.push(
        `migrated target issue #${record.issue} for '${targetOwner}' collides with current issue ownership of '${record.id}'.`,
      );
    }
  }
  for (const target of migratedTargetIssues) {
    const owner = targetOwners.get(target);
    if (owner === undefined) continue;
    for (const migration of file.migrations) {
      if (migration.work_item === owner) continue;
      if (migration.from_issue === target) {
        details.push(`migration target issue #${target} is also used as a source issue by '${migration.work_item}'.`);
      }
    }
  }

  return details.length === 0
    ? pass("registry/issue-migrations", `${file.migrations.length} historical issue migration(s) are explicit, unique and source/target consistent.`)
    : fail("registry/issue-migrations", "Historical issue migration registry is invalid.", details);
}

export function validateRepository(root: string): ValidateOutcome {
  const checks: CheckResult[] = [];

  // ------------------------------------------------------------------
  // Canonical state machine: schema + definition integrity.
  // ------------------------------------------------------------------
  const machine = readJson<WorkflowStates>(join(root, "governance", "workflow-states.json"));
  const machineSchema = readJson<object>(join(root, "governance", "schemas", "workflow-states.schema.json"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const machineValidator = ajv.compile(machineSchema);
  const machineSchemaValid = machineValidator(machine);
  checks.push(
    machineSchemaValid
      ? pass("state-machine/schema", "workflow-states.json conforms to workflow-states.schema.json.")
      : fail("state-machine/schema", "workflow-states.json violates its own schema.", (machineValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim())),
  );
  checks.push(...validateStateMachineDefinition(machine));

  // ------------------------------------------------------------------
  // Architecture version registry and protected-path manifest.
  // ------------------------------------------------------------------
  const versions = readJson<ArchitectureVersionsFile>(join(root, "governance", "architecture-versions.json"));
  checks.push(validateArchitectureVersions(versions));
  const protectedPaths = readJson<ProtectedPathsFile>(join(root, "governance", "protected-paths.json"));
  checks.push(validateProtectedPathsManifest(protectedPaths, versions));

  // ------------------------------------------------------------------
  // Requirement IDs from spec/requirements.md (root + product registries).
  // ------------------------------------------------------------------
  const requirementIds = loadRequirementIds(root);
  checks.push(
    requirementIds.size > 0
      ? pass("requirements/parsable", `Parsed ${requirementIds.size} requirement IDs from the spec requirement registries.`)
      : fail("requirements/parsable", "Could not parse any requirement IDs from spec/requirements.md.", []),
  );

  // ------------------------------------------------------------------
  // Work-item records.
  // ------------------------------------------------------------------
  const workItemSchema = readJson<object>(join(root, "governance", "schemas", "work-item.schema.json"));
  const itemValidator = ajv.compile(workItemSchema);
  const loaded = loadWorkItems(root);
  const allWorkItems = new Map<string, WorkItemRecord>(loaded.map((l) => [l.record.id, l.record]));

  // ------------------------------------------------------------------
  // ACR registry (ARCH-WF-002, Issue #12).
  // ------------------------------------------------------------------
  const acrSchema = readJson<object>(join(root, "governance", "schemas", "acr.schema.json"));
  const acrValidator = ajv.compile(acrSchema);
  const loadedAcrs = loadAcrs(root);

  // Legacy markdown ACR ids (ACR-001, ACR-002) that resolve without records.
  const legacyAcrIds = new Set<string>();
  const architectureChangesDir = join(root, "governance", "architecture-changes");
  if (existsSync(architectureChangesDir)) {
    for (const f of readdirSync(architectureChangesDir)) {
      const match = f.match(/^(ACR-[0-9]{3})-.*\.md$/);
      if (match?.[1] !== undefined) legacyAcrIds.add(match[1]);
    }
  }

  const schemaValidAcrs = new Set<string>();
  for (const { file, record } of loadedAcrs) {
    const schemaValid: boolean = acrValidator(record);
    if (schemaValid) schemaValidAcrs.add(record.id);
    checks.push(
      schemaValid
        ? pass(`acr/${record.id}/schema`, `'${file}' conforms to acr.schema.json.`)
        : fail(`acr/${record.id}/schema`, `'${file}' violates acr.schema.json.`, (acrValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim())),
    );
  }
  const acrOutcome = validateAcrRegistry(
    loadedAcrs.filter((l) => schemaValidAcrs.has(l.record.id)),
    { architectureVersions: versions, requirementIds, workItems: allWorkItems },
    legacyAcrIds,
  );
  checks.push(...acrOutcome.checks);
  checks.push(validateArchitectureVersionAcrBinding(versions, acrOutcome.registry, legacyAcrIds));

  // ------------------------------------------------------------------
  // Historical reconciliation registry (ARCH-WF-002, Issue #12).
  // ------------------------------------------------------------------
  const reconciliationSchema = readJson<object>(join(root, "governance", "schemas", "reconciliation.schema.json"));
  const reconciliationValidator = ajv.compile(reconciliationSchema);
  const loadedReconciliations = loadReconciliations(root);
  const schemaValidReconciliations = new Set<string>();
  for (const { file, record } of loadedReconciliations) {
    const schemaValid: boolean = reconciliationValidator(record);
    if (schemaValid) schemaValidReconciliations.add(record.id);
    const checkId = `reconciliation/${file.replace(/\.json$/, "")}`;
    checks.push(
      schemaValid
        ? pass(`${checkId}/schema`, `'${file}' conforms to reconciliation.schema.json.`)
        : fail(`${checkId}/schema`, `'${file}' violates reconciliation.schema.json.`, (reconciliationValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim())),
    );
  }
  const reconciliationOutcome = validateReconciliationRegistry(
    loadedReconciliations.filter((l) => schemaValidReconciliations.has(l.record.id)),
    { machine, workItems: allWorkItems, acrRecords: acrOutcome.allRecords },
  );
  checks.push(...reconciliationOutcome.checks);
  checks.push(
    reconciliationOutcome.active.size > 0
      ? pass(
          "reconciliation/active-waivers",
          `${reconciliationOutcome.active.size} DECIDED reconciliation(s) with active, narrowly-scoped waivers: ${[...reconciliationOutcome.active.values()].map((r) => `${r.id} (${r.workItem}, ${r.waivedKeys.size} waived violation(s))`).join("; ")}.`,
        )
      : pass(
          "reconciliation/active-waivers",
          "No DECIDED reconciliation is active; all historical ledger failures (if any) remain fully visible.",
        ),
  );

  // Registry of real (non-demo) records for dependency resolution.
  const registry = new Map<string, WorkItemRecord>();
  const duplicateIds: string[] = [];
  for (const { record } of loaded) {
    if (record.demo === true) continue;
    if (registry.has(record.id)) duplicateIds.push(record.id);
    registry.set(record.id, record);
  }

  const migrationFile = readJson<IssueMigrationFile>(join(root, "governance", "issue-migrations.json"));
  checks.push(validateIssueMigrations(migrationFile, allWorkItems));

  const filenameMismatches: string[] = [];
  const duplicateIssues: string[] = [];
  const issueOwners = new Map<number, string>();
  const issueMigrations = new Map<string, IssueMigration>();
  for (const migration of migrationFile.migrations) issueMigrations.set(migration.work_item, migration);

  for (const { file, record } of loaded) {
    if (file !== `${record.id}.json`) {
      filenameMismatches.push(`'${file}' contains record id '${record.id}'; expected file name '${record.id}.json'.`);
    }
    if (record.demo === true) continue;
    const migration = issueMigrations.get(record.id);
    const effectiveIssue = migration?.to_issue ?? record.issue;
    const previousOwner = issueOwners.get(effectiveIssue);
    if (previousOwner !== undefined && previousOwner !== record.id) {
      duplicateIssues.push(
        `effective issue #${effectiveIssue} is referenced by both '${previousOwner}' and '${record.id}'.`,
      );
    }
    issueOwners.set(effectiveIssue, record.id);
  }
  checks.push(
    duplicateIds.length === 0
      ? pass("registry/unique-ids", "Work-item ids are unique across governance/work-items/.")
      : fail("registry/unique-ids", "Duplicate work-item ids detected.", duplicateIds),
  );
  checks.push(
    filenameMismatches.length === 0
      ? pass("registry/filename-match", "Every record file is named after its work-item id.")
      : fail("registry/filename-match", "Record file names do not match record ids.", filenameMismatches),
  );
  checks.push(
    duplicateIssues.length === 0
      ? pass("registry/unique-issues", "Current GitHub issues map to at most one real work-item record; historical aliases are resolved through explicit migrations.")
      : fail("registry/unique-issues", "GitHub issue numbers are reused across real work-item records.", duplicateIssues),
  );

  const ctx = {
    machine,
    architectureVersions: versions,
    requirementIds,
    registry,
    acrRegistry: acrOutcome.allRecords,
    legacyAcrIds,
    activeReconciliations: reconciliationOutcome.active,
  };

  const demoDeps: string[] = [];
  for (const { record } of loaded) {
    if (record.demo === true) continue;
    for (const dep of record.dependencies) {
      if (!registry.has(dep)) {
        const demo = loaded.find((l) => l.record.id === dep && l.record.demo === true);
        if (demo !== undefined) demoDeps.push(`real record '${record.id}' depends on demo fixture '${dep}'.`);
      }
    }
  }
  checks.push(
    demoDeps.length === 0
      ? pass("registry/demo-dependencies", "No real work item depends on a demo fixture.")
      : fail("registry/demo-dependencies", "Real work items must not depend on demo fixtures.", demoDeps),
  );

  for (const { file, record } of loaded) {
    const schemaValid: boolean = itemValidator(record);
    checks.push(
      schemaValid
        ? pass(`work-item/${record.id}/schema`, `'${file}' conforms to work-item.schema.json.`)
        : fail(`work-item/${record.id}/schema`, `'${file}' violates work-item.schema.json.`, (itemValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim())),
    );
    // Validate demo records too (they must satisfy every rule), but resolve
    // dependencies against the real registry only.
    checks.push(...validateWorkItem(record, ctx));
  }

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const report: GovernanceReport = {
    generated_at: new Date().toISOString(),
    tool: TOOL,
    summary: { total: checks.length, passed, failed },
    checks,
  };
  return { report, exitCode: failed > 0 ? 1 : 0 };
}
