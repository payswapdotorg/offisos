/**
 * Protected-path checking for architecture-controlled artifacts.
 *
 * Any change to a path matching governance/protected-paths.json must go
 * through an Architecture Change Request; an implementation PR that touches a
 * protected path fails this check so the deviation cannot be silently
 * accepted (spec/architecture-lock.md; Issue #11 scope 4).
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

export interface ProtectedPathViolation {
  path: string;
  pattern: string;
  reason: string;
}

export function matchProtectedPath(path: string, patterns: ProtectedPathPattern[]): ProtectedPathViolation | undefined {
  for (const entry of patterns) {
    if (globToRegex(entry.pattern).test(path)) {
      return { path, pattern: entry.pattern, reason: entry.reason };
    }
  }
  return undefined;
}

export function checkProtectedPaths(changedPaths: string[], manifest: ProtectedPathsFile): ProtectedPathViolation[] {
  const violations: ProtectedPathViolation[] = [];
  for (const path of changedPaths) {
    const trimmed = path.trim();
    if (trimmed.length === 0) continue;
    const violation = matchProtectedPath(trimmed, manifest.patterns);
    if (violation !== undefined) violations.push(violation);
  }
  return violations;
}

export function protectedPathsCheckResult(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
): CheckResult {
  const violations = checkProtectedPaths(changedPaths, manifest);
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
