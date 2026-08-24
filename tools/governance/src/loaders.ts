/**
 * Loaders for governance data files and requirement IDs.
 *
 * All validation is offline and deterministic: the validator only reads files
 * from the repository. It never performs network calls, so results are
 * reproducible from a given commit.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type {
  ArchitectureVersionsFile,
  ProtectedPathsFile,
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
  const pattern = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3})\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

export { basename };
