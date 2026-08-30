/**
 * Protected-path checking for architecture-controlled artifacts.
 *
 * Any change to a path matching governance/protected-paths.json must go
 * through an Architecture Change Request; an implementation PR that touches a
 * protected path fails this check so the deviation cannot be silently
 * accepted (spec/architecture-lock.md; Issue #11 scope 4).
 *
 * Bootstrap semantics: protection applies to paths that already exist on the
 * base branch (modifications, deletions, renames) and to additions inside
 * protected directory trees that already exist on the base branch. Creating a
 * brand-new protected file in a location where nothing existed before is the
 * documented bootstrap case (e.g. the PR that introduces the governance
 * system itself) and is not a violation.
 */
import type { AcrRecord, CheckResult, ProtectedPathsFile, ProtectedPathPattern } from "./types.js";
import { fail, pass } from "./state-machine.js";

/**
 * Converts a protected-path pattern to a RegExp.
 *
 *  - `**` matches any characters including `/` (directory tree);
 *  - `*`  matches any characters except `/`;
 *  - everything else matches literally.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${withWildcards}$`);
}

/** For tree patterns (`a/b/**`) returns the tree prefix (`a/b`); else undefined. */
export function treePrefix(pattern: string): string | undefined {
  const index = pattern.indexOf("**");
  if (index === -1) return undefined;
  return pattern.slice(0, index).replace(/\/+$/, "");
}

export interface ProtectedPathViolation {
  path: string;
  pattern: string;
  reason: string;
}

export interface ProtectedCheckOptions {
  /**
   * Predicate telling whether a path exists on the base (protected) branch.
   * When omitted, every matching changed path is a violation (strict mode).
   */
  existsOnBase?: (path: string) => boolean;
}

export function matchProtectedPath(path: string, patterns: ProtectedPathPattern[]): ProtectedPathViolation | undefined {
  for (const entry of patterns) {
    if (globToRegex(entry.pattern).test(path)) {
      return { path, pattern: entry.pattern, reason: entry.reason };
    }
  }
  return undefined;
}

export function checkProtectedPaths(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
  options: ProtectedCheckOptions = {},
): ProtectedPathViolation[] {
  const violations: ProtectedPathViolation[] = [];
  const existsOnBase = options.existsOnBase ?? (() => true);
  for (const changed of changedPaths) {
    const trimmed = changed.trim();
    if (trimmed.length === 0) continue;
    const violation = matchProtectedPath(trimmed, manifest.patterns);
    if (violation === undefined) continue;
    // Bootstrap rule: an addition is only a violation when the path itself
    // exists on the base branch (modification/deletion/rename), or when it
    // lands inside a protected tree that already exists on the base branch.
    // A brand-new protected file where nothing existed before is the
    // documented bootstrap case (e.g. the PR introducing the governance
    // system itself) and is not a violation.
    const pathExists = existsOnBase(trimmed);
    const prefix = treePrefix(violation.pattern);
    const treeExists = prefix !== undefined ? existsOnBase(prefix) : false;
    if (pathExists || treeExists) {
      violations.push(violation);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ACR routing (ARCH-WF-002, Issue #12).
// ---------------------------------------------------------------------------

/** A protected change explicitly routed through an approved ACR. */
export interface RoutedPath {
  path: string;
  pattern: string;
  reason: string;
  acr: string;
  approvedAt: string;
  approvedBy: string;
}

/** An ACR citation that could not route a protected change, and why. */
export interface RoutingRefusal {
  acr: string;
  reason: string;
}

export interface AcrRoutingOptions {
  /** All ACR records by id (governance/acr/). */
  registry: Map<string, AcrRecord>;
  /** ACR ids explicitly cited by the change author (e.g. the PR's ACR-Routing line). */
  citedAcrs: string[];
}

export interface RoutedCheckOptions extends ProtectedCheckOptions {
  acrRouting?: AcrRoutingOptions;
}

export interface RoutedCheckOutcome {
  violations: ProtectedPathViolation[];
  routed: RoutedPath[];
  refusals: RoutingRefusal[];
}

/**
 * Protected-path checking with explicit ACR routing.
 *
 * A protected change is a violation UNLESS the change author explicitly cites
 * an ACR that (a) exists in the registry, (b) is real (non-demo), (c) is
 * APPROVED or IMPLEMENTED, and (d) enumerates the exact changed path in its
 * authorized_paths. Routing is never implicit: uncited ACRs authorize nothing,
 * and an ACR only routes the exact paths it enumerates.
 */
export function checkProtectedPathsWithRouting(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
  options: RoutedCheckOptions = {},
): RoutedCheckOutcome {
  const routing = options.acrRouting;
  const violations: ProtectedPathViolation[] = [];
  const routed: RoutedPath[] = [];
  const refusals = new Map<string, RoutingRefusal>();

  const evaluateAcr = (acrId: string): { ok: boolean; acr?: AcrRecord } => {
    if (refusals.has(acrId)) {
      return { ok: false };
    }
    const acr = routing?.registry.get(acrId);
    if (acr === undefined) {
      refusals.set(acrId, { acr: acrId, reason: `cited ACR '${acrId}' does not resolve in governance/acr/ (legacy markdown ACRs cannot route protected-path changes).` });
      return { ok: false };
    }
    if (acr.demo === true) {
      refusals.set(acrId, { acr: acrId, reason: `cited ACR '${acrId}' is a demo fixture; demo ACRs cannot route real protected-path changes.` });
      return { ok: false };
    }
    if (acr.status !== "APPROVED" && acr.status !== "IMPLEMENTED") {
      refusals.set(acrId, { acr: acrId, reason: `cited ACR '${acrId}' is ${acr.status}; routing requires an APPROVED or IMPLEMENTED ACR (Architect endorsement + Product Owner approval).` });
      return { ok: false };
    }
    if (acr.approval === undefined) {
      refusals.set(acrId, { acr: acrId, reason: `cited ACR '${acrId}' records no product-owner approval.` });
      return { ok: false };
    }
    return { ok: true, acr };
  };

  for (const changed of changedPaths) {
    const trimmed = changed.trim();
    if (trimmed.length === 0) continue;
    const violation = matchProtectedPath(trimmed, manifest.patterns);
    if (violation === undefined) continue;

    const pathExists = options.existsOnBase ? options.existsOnBase(trimmed) : true;
    const prefix = treePrefix(violation.pattern);
    const treeExists = prefix !== undefined && options.existsOnBase ? options.existsOnBase(prefix) : prefix !== undefined;
    if (!pathExists && !treeExists) {
      continue; // Bootstrap case: brand-new protected file where nothing existed.
    }

    // Protected change: explicit ACR routing only.
    let routedBy: RoutedPath | undefined = undefined;
    if (routing !== undefined) {
      for (const acrId of routing.citedAcrs) {
        const { ok, acr } = evaluateAcr(acrId);
        if (!ok || acr === undefined) continue;
        if (acr.authorized_paths.includes(trimmed)) {
          routedBy = {
            ...violation,
            acr: acr.id,
            approvedAt: acr.approval!.approved_at,
            approvedBy: acr.approval!.approved_by,
          };
          break;
        }
        const refusalKey = `${acrId}:${trimmed}`;
        if (!refusals.has(refusalKey)) {
          refusals.set(refusalKey, {
            acr: acrId,
            reason: `cited ACR '${acrId}' does not authorize '${trimmed}' (authorized_paths: ${acr.authorized_paths.length === 0 ? "none" : acr.authorized_paths.join(", ")}).`,
          });
        }
      }
    }

    if (routedBy !== undefined) {
      routed.push(routedBy);
    } else {
      violations.push(violation);
    }
  }

  return { violations, routed, refusals: [...refusals.values()] };
}

export function protectedPathsCheckResult(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
  options: RoutedCheckOptions = {},
): CheckResult {
  const outcome = checkProtectedPathsWithRouting(changedPaths, manifest, options);
  if (outcome.violations.length === 0) {
    const routedDetails = outcome.routed.map(
      (r) =>
        `'${r.path}' matches protected pattern '${r.pattern}' (${r.reason}) — ROUTED via ${r.acr} (product-owner approval by ${r.approvedBy} at ${r.approvedAt}).`,
    );
    const description =
      outcome.routed.length > 0
        ? `No unrouted protected-path change (${changedPaths.length} path(s) checked; ${outcome.routed.length} explicitly ACR-routed).`
        : `No changed path touches architecture-controlled artifacts (${changedPaths.length} path(s) checked).`;
    return routedDetails.length > 0
      ? { id: "protected-paths/check", description, status: "pass", details: routedDetails }
      : pass("protected-paths/check", description);
  }
  const details = outcome.violations.map(
    (v) =>
      `'${v.path}' matches protected pattern '${v.pattern}' (${v.reason}). ` +
      "Do not modify this path in an implementation PR. Route the change through an Architecture Change Request " +
      "(see governance/README.md, Architecture changes; cite the ACR with check-protected --acr and the PR's ACR-Routing line).",
  );
  for (const refusal of outcome.refusals) {
    details.push(`Routing refused: ${refusal.reason}`);
  }
  for (const r of outcome.routed) {
    details.push(
      `'${r.path}' matches protected pattern '${r.pattern}' — ROUTED via ${r.acr} (product-owner approval by ${r.approvedBy} at ${r.approvedAt}).`,
    );
  }
  return fail(
    "protected-paths/check",
    "Changed paths touch architecture-controlled artifacts without an approved ACR covering them.",
    details,
  );
}
