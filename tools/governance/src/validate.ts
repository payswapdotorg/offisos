/**
 * Orchestration for the `validate` command: loads every governance artifact,
 * runs all deterministic checks and produces a report.
 */
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { loadWorkItems, parseRequirementIds, readJson } from "./loaders.js";
import { validateStateMachineDefinition } from "./state-machine.js";
import { validateWorkItem } from "./rules.js";
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
  // Requirement IDs from spec/requirements.md.
  // ------------------------------------------------------------------
  const requirementIds = parseRequirementIds(join(root, "spec", "requirements.md"));
  checks.push(
    requirementIds.size > 0
      ? pass("requirements/parsable", `Parsed ${requirementIds.size} requirement IDs from spec/requirements.md.`)
      : fail("requirements/parsable", "Could not parse any requirement IDs from spec/requirements.md.", []),
  );

  // ------------------------------------------------------------------
  // Work-item records.
  // ------------------------------------------------------------------
  const workItemSchema = readJson<object>(join(root, "governance", "schemas", "work-item.schema.json"));
  const itemValidator = ajv.compile(workItemSchema);
  const loaded = loadWorkItems(root);

  // Registry of real (non-demo) records for dependency resolution.
  const registry = new Map<string, WorkItemRecord>();
  const duplicateIds: string[] = [];
  for (const { record } of loaded) {
    if (record.demo === true) continue;
    if (registry.has(record.id)) duplicateIds.push(record.id);
    registry.set(record.id, record);
  }

  const filenameMismatches: string[] = [];
  const duplicateIssues: string[] = [];
  const issueOwners = new Map<number, string>();
  for (const { file, record } of loaded) {
    if (file !== `${record.id}.json`) {
      filenameMismatches.push(`'${file}' contains record id '${record.id}'; expected file name '${record.id}.json'.`);
    }
    if (record.demo === true) continue;
    const previousOwner = issueOwners.get(record.issue);
    if (previousOwner !== undefined && previousOwner !== record.id) {
      duplicateIssues.push(`issue #${record.issue} is referenced by both '${previousOwner}' and '${record.id}'.`);
    }
    issueOwners.set(record.issue, record.id);
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
      ? pass("registry/unique-issues", "GitHub issues map to at most one real work-item record.")
      : fail("registry/unique-issues", "GitHub issue numbers are reused across real work-item records.", duplicateIssues),
  );

  const ctx = {
    machine,
    architectureVersions: versions,
    requirementIds,
    registry,
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
