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
import type { CheckResult, ProtectedPathsFile, ProtectedPathPattern } from "./types.js";
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

export function protectedPathsCheckResult(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
  options: ProtectedCheckOptions = {},
): CheckResult {
  const violations = checkProtectedPaths(changedPaths, manifest, options);
  if (violations.length === 0) {
    return pass(
      "protected-paths/check",
      `No changed path touches architecture-controlled artifacts (${changedPaths.length} path(s) checked).`,
    );
  }
  return fail(
    "protected-paths/check",
    "Changed paths touch architecture-controlled artifacts; an Architecture Change Request is required.",
    violations.map(
      (v) =>
        `'${v.path}' matches protected pattern '${v.pattern}' (${v.reason}). ` +
        "Do not modify this path in an implementation PR. Route the change through an Architecture Change Request " +
        "(see governance/README.md, Architecture changes; ACR lifecycle is owned by ARCH-WF-002).",
    ),
  );
}
