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
import {
  checkRegistryAdditionTraversal,
  isLegalRegistryLifecycleTransition,
  type RegistryLifecycleKind,
  type RegistryRecordHistoryStep,
} from "./registry-lifecycle.js";

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
  /** True when the matched pattern allows pure additions (registry trees). */
  additionsAllowed?: boolean;
  /** Present when the matched pattern is a lifecycle-managed registry tree. */
  lifecycle?: RegistryLifecycleKind;
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
      return {
        path,
        pattern: entry.pattern,
        reason: entry.reason,
        ...(entry.additions === "allowed" ? { additionsAllowed: true } : {}),
      ...(entry.lifecycle !== undefined ? { lifecycle: entry.lifecycle } : {}),
      };
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

/** A registry record advanced through its own legal lifecycle transition. */
export interface RegistryLifecyclePath {
  path: string;
  pattern: string;
  kind: RegistryLifecycleKind;
  edge: string;
  instruments: string[];
}

/**
 * A registry record created under a lifecycle-managed tree (the creation
 * invariant): real records are born at their initial status; demo fixtures
 * are exempt but inert. When the same change advances the new record, the
 * legal edges it traversed are recorded in advancedBy.
 */
export interface RegistryCreationPath {
  path: string;
  pattern: string;
  kind: RegistryLifecycleKind;
  /** Present for a real record: the initial lifecycle status it was born at. */
  initialStatus?: string;
  /** Present for a demo fixture (exempt from the initial-status rule). */
  demo?: boolean;
  /** Present when the same change advanced the new record: the legal edges traversed. */
  advancedBy?: string[];
}

/** Reads the (before, after) JSON record pair for a registry path. */
export type RecordPairReader = (
  path: string,
) => { before?: unknown; after?: unknown } | undefined;

/**
 * Reads a registry path's full commit history within the checked range,
 * oldest-first, with the record content before/after each commit (enables
 * the addition traversal: creation at the initial status + every
 * subsequent intra-change step as a legal lifecycle transition).
 */
export type RecordHistoryReader = (path: string) => RegistryRecordHistoryStep[] | undefined;

export interface AcrRoutingOptions {
  /** All ACR records by id (governance/acr/). */
  registry: Map<string, AcrRecord>;
  /** ACR ids explicitly cited by the change author (e.g. the PR's ACR-Routing line). */
  citedAcrs: string[];
}

export interface RoutedCheckOptions extends ProtectedCheckOptions {
  acrRouting?: AcrRoutingOptions;
  /**
   * Registry lifecycle verification (ARCH-WF-002 remediation): resolves the
   * record content for paths under lifecycle-managed registry patterns. A
   * MODIFICATION of an existing record is waived only when its before/after
   * content is a narrowly content-checked legal lifecycle transition
   * (readRecordPair). A NEWLY CREATED record is waived only when its full
   * commit-range traversal is lawful (readRecordHistory): created at its
   * initial lifecycle status (ACR → PROPOSED, reconciliation → STAGED) and
   * advanced only through legal transitions. Without the readers the check
   * fails closed: unverifiable modifications AND creations stay violations.
   */
  registryLifecycle?: {
    readRecordPair?: RecordPairReader;
    readRecordHistory?: RecordHistoryReader;
  };
}

export interface RoutedCheckOutcome {
  violations: ProtectedPathViolation[];
  routed: RoutedPath[];
  lifecycled: RegistryLifecyclePath[];
  /** Registry additions under lifecycle-managed patterns, checked against the creation invariant. */
  creations: RegistryCreationPath[];
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
  const lifecycled: RegistryLifecyclePath[] = [];
  const creations: RegistryCreationPath[] = [];
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

    // Content-level failure reason for lifecycle-managed registry patterns:
    // set by the creation invariant (for additions) or the transition rule
    // (for modifications) when the content is not lawfully authorized; the
    // ACR-routing channel below may still waive the path explicitly.
    let contentFailure: string | undefined;
    let lifecycleFailure: string | undefined;

    if (violation.additionsAllowed === true) {
      // Registry tree (e.g. governance/acr/**): additions are the normal flow
      // (proposing an ACR must not itself require an ACR); only modifications,
      // deletions or renames of already-existing paths are violations. In
      // strict mode (no base ref) additions cannot be distinguished and stay
      // violations.
      if (options.existsOnBase !== undefined && !pathExists) {
        // A newly created registry record. For lifecycle-managed patterns the
        // CREATION TRAVERSAL applies (the round-3 ruling — lifecycle bypass at
        // record creation): the record's full commit history within the range
        // is read; the INTRODUCTION must be born at the initial lifecycle
        // status (ACR → PROPOSED, reconciliation → STAGED) and EVERY later
        // intra-change step must itself be a legal lifecycle transition. A
        // record created mid-lifecycle — already APPROVED, IMPLEMENTED or
        // DECIDED — is a violation: the lifecycle-transition guard only sees
        // before/after pairs for modifications of pre-existing paths, so
        // without this traversal a "born-APPROVED" addition would bypass the
        // entire review/approval chain. The traversal is also what keeps the
        // documented review-time acts flow lawful: a record born PROPOSED on
        // this branch may be advanced to APPROVED by a later commit in the
        // same PR — the advancement is checked as the legal transition it
        // must be. Demo fixtures (demo: true) are exempt — they are inert
        // (they can never route protected-path changes or sanction real
        // reconciliations). Unreadable history fails closed.
        if (violation.lifecycle === undefined) {
          continue; // plain registry tree (none today): additions are the normal flow
        }
        const historyReader = options.registryLifecycle?.readRecordHistory;
        const history = historyReader === undefined ? undefined : historyReader(trimmed);
        const outcome = checkRegistryAdditionTraversal(violation.lifecycle, history);
        if (outcome.ok) {
          creations.push({
            path: trimmed,
            pattern: violation.pattern,
            kind: violation.lifecycle,
            ...(outcome.demo === true
              ? { demo: true }
              : { initialStatus: outcome.initialStatus }),
            ...(outcome.steps !== undefined && outcome.steps.length > 0
              ? { advancedBy: outcome.steps.map((s) => s.edge) }
              : {}),
          });
          for (const step of outcome.steps ?? []) {
            lifecycled.push({
              path: trimmed,
              pattern: violation.pattern,
              kind: violation.lifecycle,
              edge: step.edge,
              instruments: step.instruments,
            });
          }
          continue;
        }
        // Not a lawful addition: fall through so the general ACR-routing
        // channel may still explicitly authorize the exact path; otherwise
        // the violation below carries the creation-traversal reason.
        contentFailure = outcome.reason;
      }
    } else if (!pathExists && !treeExists) {
      // Bootstrap case: brand-new protected file where nothing existed before
      // (e.g. the PR introducing the governance system itself).
      continue;
    }

    // Protected change. Authorization channels, in order of specificity:
    //   1. the registry lifecycle rules — for a MODIFICATION, the record's
    //      OWN machine-checkable lifecycle transition; for a CREATION under a
    //      lifecycle-managed tree, the initial-status invariant (both
    //      narrowly content-checked; they break the circular authorization
    //      an ACR-record path change would otherwise create);
    //   2. explicit ACR routing — an approved ACR enumerating the exact path
    //      (the general channel; it can authorize registry-record amendments,
    //      deletions and out-of-band registrations when the ACR explicitly
    //      enumerates them);
    //   3. otherwise: violation (with the lifecycle-aware reason when the
    //      pattern is lifecycle-managed).
    if (violation.lifecycle !== undefined && pathExists) {
      const reader = options.registryLifecycle?.readRecordPair;
      const pair = reader === undefined ? undefined : reader(trimmed);
      if (pair !== undefined && pair.after !== undefined) {
        const outcome = isLegalRegistryLifecycleTransition(violation.lifecycle, pair.before, pair.after);
        if (outcome.ok) {
          lifecycled.push({
            path: trimmed,
            pattern: violation.pattern,
            kind: violation.lifecycle,
            edge: outcome.edge!,
            instruments: outcome.instruments!,
          });
          continue;
        }
        lifecycleFailure = outcome.reason;
      } else if (reader === undefined) {
        lifecycleFailure =
          "Lifecycle-managed registry record modified, but no before/after reader is available (strict mode): the transition cannot be verified and fails closed.";
      } else {
        lifecycleFailure =
          "the record is unreadable or deleted on one side of the change; deletions of registry records are not lifecycle transitions";
      }
    }
    if (contentFailure === undefined) {
      contentFailure = lifecycleFailure;
    }

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
    } else if (contentFailure !== undefined) {
      violations.push({ ...violation, reason: `${violation.reason} ${contentFailure}` });
    } else {
      violations.push(violation);
    }
  }

  return { violations, routed, lifecycled, creations, refusals: [...refusals.values()] };
}

export function protectedPathsCheckResult(
  changedPaths: string[],
  manifest: ProtectedPathsFile,
  options: RoutedCheckOptions = {},
): CheckResult {
  const outcome = checkProtectedPathsWithRouting(changedPaths, manifest, options);
  const lifecycleDetails = outcome.lifecycled.map(
    (l) =>
      `'${l.path}' matches protected pattern '${l.pattern}' — REGISTRY LIFECYCLE transition ${l.edge} (instruments: ${l.instruments.join(", ")}) authorized by the ${l.kind} lifecycle rules; arbitrary edits to existing registry records remain protected.`,
  );
  const creationDetails = outcome.creations.map((c) => {
    const base =
      c.demo === true
        ? `'${c.path}' matches protected pattern '${c.pattern}' — REGISTRY ADDITION of a demo fixture (demo: true): exempt from the initial-status rule; demo records can never route protected-path changes or sanction real reconciliations.`
        : `'${c.path}' matches protected pattern '${c.pattern}' — REGISTRY ADDITION born at the initial status ${c.initialStatus} (real ${c.kind} record)` +
          (c.advancedBy !== undefined && c.advancedBy.length > 0
            ? `, advanced within this change by legal transition(s): ${c.advancedBy.join("; ")}`
            : ": later lifecycle states are reachable only through the narrowly checked legal transitions (REGISTRY LIFECYCLE)") +
          ".";
    return base;
  });
  if (outcome.violations.length === 0) {
    const routedDetails = outcome.routed.map(
      (r) =>
        `'${r.path}' matches protected pattern '${r.pattern}' (${r.reason}) — ROUTED via ${r.acr} (product-owner approval by ${r.approvedBy} at ${r.approvedAt}).`,
    );
    const allDetails = [...routedDetails, ...lifecycleDetails, ...creationDetails];
    const waivable =
      outcome.routed.length > 0 || outcome.lifecycled.length > 0 || outcome.creations.length > 0;
    const description = waivable
      ? `No unauthorized protected-path change (${changedPaths.length} path(s) checked; ${outcome.routed.length} explicitly ACR-routed, ${outcome.lifecycled.length} registry lifecycle transition(s), ${outcome.creations.length} registry addition(s) under the creation invariant).`
      : `No changed path touches architecture-controlled artifacts (${changedPaths.length} path(s) checked).`;
    return allDetails.length > 0
      ? { id: "protected-paths/check", description, status: "pass", details: allDetails }
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
  details.push(...lifecycleDetails);
  details.push(...creationDetails);
  return fail(
    "protected-paths/check",
    "Changed paths touch architecture-controlled artifacts without an approved ACR covering them.",
    details,
  );
}
