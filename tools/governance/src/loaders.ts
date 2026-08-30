/**
 * Loaders for governance data files and requirement IDs.
 *
 * All validation is offline and deterministic: the validator only reads files
 * from the repository. It never performs network calls, so results are
 * reproducible from a given commit.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type {
  AcrRecord,
  ArchitectureVersionsFile,
  ProtectedPathsFile,
  ReconciliationRecord,
  WorkItemRecord,
  WorkflowStates,
} from "./types.js";

export function readJson<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
}

export function loadWorkflowStates(root: string): WorkflowStates {
  return readJson<WorkflowStates>(join(root, "governance", "workflow-states.json"));
}

export function loadArchitectureVersions(root: string): ArchitectureVersionsFile {
  return readJson<ArchitectureVersionsFile>(join(root, "governance", "architecture-versions.json"));
}

export function loadProtectedPaths(root: string): ProtectedPathsFile {
  return readJson<ProtectedPathsFile>(join(root, "governance", "protected-paths.json"));
}

export interface LoadedWorkItem {
  file: string;
  record: WorkItemRecord;
}

/** Loads every *.json work-item record from governance/work-items/. */
export function loadWorkItems(root: string): LoadedWorkItem[] {
  const dir = join(root, "governance", "work-items");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => ({
    file,
    record: readJson<WorkItemRecord>(join(dir, file)),
  }));
}

/**
 * Extracts requirement IDs from spec/requirements.md.
 *
 * The requirements file stores requirements as markdown table rows whose first
 * cell is the ID: `| PLAT-001 | description | module | deps |`.
 */
export function parseRequirementIds(specRequirementsPath: string): Set<string> {
  const ids = new Set<string>();
  const markdown = readFileSync(specRequirementsPath, "utf8");
  const tablePattern = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3})\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(markdown)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

/**
 * Extracts requirement IDs from a SUBORDORDINATE product requirements
 * registry (spec/<product>/requirements.md).
 *
 * CAD-PARITY-011 (Issue #97): the CAD/BIM product requirements registry
 * (spec/cad-bim/requirements.md) stores requirements as markdown bullet
 * rows: `- CAD-BIM-001 description.` — a separate ID namespace from the
 * ConstructionOS system requirements. The root registry stays authoritative
 * for cross-domain governance; this loader makes the subordinate product
 * namespaces resolvable for work-item requirement references WITHOUT
 * duplicating them into the root file (the product registries own their IDs).
 *
 * The bullet form: an optional bold/italic-free list marker, the ID, then a
 * space and the description text.
 */
export function parseSubRequirementIds(subRequirementsPath: string): Set<string> {
  const ids = new Set<string>();
  const markdown = readFileSync(subRequirementsPath, "utf8");
  const bulletPattern = /^-\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3})\s/mg;
  let match: RegExpExecArray | null;
  while ((match = bulletPattern.exec(markdown)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  // Subordinate registries may also use the root table form — accept both.
  const tablePattern = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3})\s*\|/gm;
  while ((match = tablePattern.exec(markdown)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

/**
 * Loads the resolvable requirement-ID set for the whole spec tree: the root
 * spec/requirements.md PLUS every subordinate product registry
 * (spec/&lt;product&gt;/requirements.md — currently spec/cad-bim/requirements.md,
 * the CAD/BIM Product Requirements v1.0 namespace of CAD-P-, CAD-2D-,
 * CAD-3D-, CAD-BIM- and CAD-DOC- prefixed IDs).
 *
 * Additive (CAD-PARITY-011, Issue #97): the P011 work-item record references
 * the CAD-BIM-* product requirements; before this loader the validator only
 * resolved the root namespace, so those references failed resolution. This
 * widens the resolvable set with legitimately-specified IDs — no check is
 * weakened (unknown IDs still fail).
 */
export function loadRequirementIds(root: string): Set<string> {
  const ids = parseRequirementIds(join(root, "spec", "requirements.md"));
  const specDir = join(root, "spec");
  for (const entry of readdirSync(specDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(specDir, entry.name, "requirements.md");
    if (existsSync(sub)) {
      for (const id of parseSubRequirementIds(sub)) ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// ACR registry (governance/acr/, ARCH-WF-002 — Issue #12).
// ---------------------------------------------------------------------------

export interface LoadedAcr {
  file: string;
  record: AcrRecord;
}

/**
 * Loads every machine-readable ACR record from governance/acr/.
 *
 * Only files named ACR-NNN.json are registry records; TEMPLATE.json and any
 * other documentation files in the directory are skipped. ACR-001 and ACR-002
 * predate the machine-readable lifecycle and remain markdown documents in
 * governance/architecture-changes/ (legacy resolution, see
 * legacyAcrMarkdownExists).
 */
export function loadAcrs(root: string): LoadedAcr[] {
  const dir = join(root, "governance", "acr");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^ACR-[0-9]{3}\.json$/.test(f))
    .sort();
  return files.map((file) => ({
    file,
    record: readJson<AcrRecord>(join(dir, file)),
  }));
}

/**
 * Resolves a legacy (pre-registry) ACR id against the historical markdown
 * documents in governance/architecture-changes/ (ACR-001, ACR-002). Those
 * documents remain valid historical records; the machine-readable lifecycle
 * starts at ACR-003.
 */
export function legacyAcrMarkdownExists(root: string, acrId: string): boolean {
  const dir = join(root, "governance", "architecture-changes");
  if (!existsSync(dir)) return false;
  const prefix = `${acrId}-`;
  return readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith(".md"));
}

/** Resolves an ACR id against the JSON registry or the legacy markdown ACRs. */
export function acrIdResolvable(
  root: string,
  acrId: string,
  registry: Map<string, AcrRecord>,
): boolean {
  if (registry.has(acrId)) return true;
  return legacyAcrMarkdownExists(root, acrId);
}

// ---------------------------------------------------------------------------
// Reconciliation registry (governance/reconciliations/, ARCH-WF-002 — Issue #12).
// ---------------------------------------------------------------------------

export interface LoadedReconciliation {
  file: string;
  record: ReconciliationRecord;
}

/**
 * Loads every historical reconciliation record from
 * governance/reconciliations/. Files are named after the reconciled work item
 * (<WORK-ITEM-ID>.json); one reconciliation record per work item.
 */
export function loadReconciliations(root: string): LoadedReconciliation[] {
  const dir = join(root, "governance", "reconciliations");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => ({
    file,
    record: readJson<ReconciliationRecord>(join(dir, file)),
  }));
}

export { basename };
