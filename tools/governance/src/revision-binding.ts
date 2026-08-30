/**
 * Revision-bound verification drift audit (ARCH-WF-002, Issue #12).
 *
 * Every VERIFIED work item's verification binds to an exact implementation
 * revision (the commit cited by the verify transition, or the commit bound to
 * its cited evidence). This audit uses local git history to detect drift:
 *
 *  - if a file that the verification's evidence declared as a bound path
 *    (references.path / references.artifact_path) changed after the binding
 *    revision, the verification is STALE — later material implementation
 *    changes invalidate prior verification — and the audit fails;
 *  - material drift outside declared bound paths is reported informationally
 *    (the per-item byte-identical fixture discipline covers it in CI);
 *  - changes confined to governance metadata, docs, spec, research and the
 *    validator tooling itself are not material implementation drift.
 *
 * Demo fixtures are skipped (their references are synthetic by design).
 */
import type { CheckResult, EvidenceRecord, WorkItemRecord } from "./types.js";
import { fail, pass } from "./state-machine.js";

export interface GitOperations {
  /** Resolve a ref to a full sha; undefined when unresolvable. */
  revParse(ref: string): string | undefined;
  /** Files changed between two refs (exclusive of `from`). */
  diffNames(from: string, to: string): string[];
}

export interface VerifiedRevisionAuditEntry {
  workItem: string;
  bindingRevision: string;
  boundPaths: string[];
  materialDriftCount: number;
  stale: boolean;
  stalePaths: string[];
  note?: string;
}

const NON_MATERIAL_PREFIXES = ["governance/", ".github/", "tools/", "spec/", "research/"];

export function isMaterialPath(path: string): boolean {
  if (NON_MATERIAL_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (path === "governance-report.json") return false;
  if (path.endsWith(".md")) return false;
  return true;
}

/** The binding revision of a VERIFIED record: the verify transition's commit, else its last commit-bound cited evidence. */
export function bindingRevision(record: WorkItemRecord): string | undefined {
  const verifyTransition = [...record.transitions].reverse().find((t) => t.to === "VERIFIED");
  if (verifyTransition === undefined) return undefined;
  const transitionCommit = verifyTransition.references?.commit;
  if (transitionCommit !== undefined) return transitionCommit;
  const evidence: EvidenceRecord[] = record.evidence ?? [];
  const cited = verifyTransition.references?.evidence ?? [];
  for (const evidenceId of [...cited].reverse()) {
    const item = evidence.find((e) => e.id === evidenceId);
    const commit = item?.references?.commit;
    if (commit !== undefined) return commit;
  }
  return undefined;
}

/** Paths declared as bound by the verify transition's cited evidence. */
export function boundPathsOf(record: WorkItemRecord): string[] {
  const verifyTransition = [...record.transitions].reverse().find((t) => t.to === "VERIFIED");
  if (verifyTransition === undefined) return [];
  const evidence: EvidenceRecord[] = record.evidence ?? [];
  const cited = verifyTransition.references?.evidence ?? [];
  const paths: string[] = [];
  for (const evidenceId of cited) {
    const item = evidence.find((e) => e.id === evidenceId);
    const refs = item?.references;
    if (refs === undefined) continue;
    for (const p of [refs.path, refs.artifact_path]) {
      if (p !== undefined && p.trim().length > 0 && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

export function computeVerifiedRevisionAudit(
  records: WorkItemRecord[],
  git: GitOperations,
  base = "HEAD",
): { entries: VerifiedRevisionAuditEntry[]; check: CheckResult } {
  const entries: VerifiedRevisionAuditEntry[] = [];

  for (const record of records) {
    if (record.demo === true) continue;
    if (record.state !== "VERIFIED") continue;

    const revision = bindingRevision(record);
    const boundPaths = boundPathsOf(record);
    if (revision === undefined) {
      entries.push({
        workItem: record.id,
        bindingRevision: "<none>",
        boundPaths,
        materialDriftCount: 0,
        stale: true,
        stalePaths: [],
        note: "the verify transition is not revision-bound (no transition commit and no commit-bound cited evidence); the drift audit cannot certify it.",
      });
      continue;
    }

    const resolved = git.revParse(revision);
    if (resolved === undefined) {
      entries.push({
        workItem: record.id,
        bindingRevision: revision,
        boundPaths,
        materialDriftCount: 0,
        stale: true,
        stalePaths: [],
        note: `binding revision '${revision}' does not resolve in the local git history; a real verification must cite a commit that exists.`,
      });
      continue;
    }

    const changed = git.diffNames(resolved, base);
    const material = changed.filter(isMaterialPath);
    const stalePaths = boundPaths.filter((p) => changed.includes(p));
    entries.push({
      workItem: record.id,
      bindingRevision: resolved,
      boundPaths,
      materialDriftCount: material.length,
      stale: stalePaths.length > 0,
      stalePaths,
    });
  }

  const staleEntries = entries.filter((e) => e.stale);
  const detailLines = entries.map((e) => {
    if (e.note !== undefined) {
      return `${e.workItem}: binding ${e.bindingRevision.slice(0, 12)} — ${e.note}`;
    }
    const bound =
      e.boundPaths.length > 0 ? `bound path(s): ${e.boundPaths.join(", ")}` : "no declared bound paths (fixture discipline covers regressions)";
    if (e.stale) {
      return `${e.workItem}: binding ${e.bindingRevision.slice(0, 12)} — STALE: bound path(s) changed after verification: ${e.stalePaths.join(", ")}`;
    }
    return `${e.workItem}: binding ${e.bindingRevision.slice(0, 12)} — intact (${bound}; ${e.materialDriftCount} unrelated material file(s) changed since).`;
  });

  const check = staleEntries.length === 0
    ? pass(
        "verified-revisions/drift",
        `All ${entries.length} verified work-item revision bindings are intact${base === "HEAD" ? "" : ` against ${base}`}.`,
      )
    : fail(
        "verified-revisions/drift",
        "One or more VERIFIED revision bindings are stale: material changes landed after the verified revision on paths the verification is bound to. Later material implementation changes invalidate prior verification.",
        detailLines,
      );

  if (staleEntries.length === 0 && detailLines.length > 0) {
    return { entries, check: { ...check, details: detailLines } };
  }
  return { entries, check };
}
