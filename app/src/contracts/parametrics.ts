/**
 * COMPAT-CAD-004 (Issue #121) — the parametrics/associative/patterns shared
 * contract types (additive, Architecture v1.1 FROZEN).
 *
 * These are the bounded, versioned, typed contracts for the consolidated
 * complete-enough CAD/BIM hardening surface: the versioned capability
 * registry over the VERIFIED constraint (CAD-PARITY-007), block/symbol
 * (CAD-PARITY-006), associative-annotation (CAD-PARITY-005) and
 * documentation (COMPAT-CAD-003) baselines, the consolidated associative
 * report with typed dangling/reference-loss outcomes and its one-revision
 * atomic refresh, and the bounded deterministic pattern operations (the
 * mirror that includes symbol instances through the reflected placement;
 * the rectangular/polar arrays over entities and symbols through the
 * existing verified array op).
 *
 * Governing boundary (LOCK-019, the P015/P017/P018 precedents): the
 * Construction Graph / CADDocument stays the canonical system of record.
 * COMPAT-CAD-004 adds NO parallel record table — mirrored symbol instances
 * are the existing block-ref ELEMENTS with the additive optional
 * `mirrored: true` placement state; the associative refresh composes the
 * EXISTING annotation re-measurement cascade and the EXISTING documentation
 * regeneration into ONE `doc.execute(applyEdits)` revision; pattern
 * operations emit exactly the addElement/setProps/updateElement sub-edits
 * the document already validates (no parallel element semantics, no
 * fabricated geometry).
 *
 * Engine boundary (LOCK-003/018, unchanged): the parametrics core
 * (app/src/parametrics) is pure TypeScript — no engine imports, no host
 * imports, no environment reads, no wall-clock, no random.
 *
 * Determinism convention: every derivation here is a pure function of the
 * canonical elements/records (deterministic ordering, fixed formulas, typed
 * outcome codes). Repeated execution over identical canonical inputs yields
 * byte-identical declared outputs (the reproducibility contract).
 *
 * Typed failure codes surfaced by the parametrics core (documented here,
 * the module `Error` subclass carries them; the App API maps them typed):
 *  - parametrics_bad_payload   — malformed/invalid request payload data
 *  - parametrics_not_found     — a referenced element does not exist
 *  - parametrics_unsupported   — a requested capability outside the bounded
 *                                model (never a fabricated semantic)
 *  - parametrics_out_of_bounds — a request exceeding the declared bounds
 */

// ---------------------------------------------------------------------------
// The parametrics API version (API-001: additive-only; breaking changes
// create a new version — the App API §8 convention).
// ---------------------------------------------------------------------------

/** The parametrics/associative/patterns contract version. */
export const PARAMETRICS_API_VERSION = "1" as const;
export type ParametricsApiVersion = typeof PARAMETRICS_API_VERSION;

// ---------------------------------------------------------------------------
// Bounds (the closed surface limits — every bound is enforced typed, never
// silently truncated).
// ---------------------------------------------------------------------------

/** Maximum entities of ONE pattern.mirror batch. */
export const PATTERNS_MAX_MIRROR_ENTITIES = 256;

// ---------------------------------------------------------------------------
// The capability registry vocabulary (the discovery surface).
// ---------------------------------------------------------------------------

/** The closed capability area vocabulary. */
export type ParametricCapabilityArea =
  | "constraints"
  | "associations"
  | "symbols"
  | "patterns";

/** One capability-discovery row: every governed App API request of the
 *  consolidated parametrics family, its kind, its area and one-line
 *  summary. `origin` separates the requests COMPAT-CAD-004 ADDS from the
 *  VERIFIED baseline requests the family consolidates (both are exercised
 *  through the same governed App API — the honest provenance, never a
 *  re-branded baseline). */
export interface ParametricCapabilityView {
  /** The capability id — exactly the governed App API request name. */
  readonly name: string;
  readonly kind: "command" | "query";
  readonly area: ParametricCapabilityArea;
  readonly summary: string;
  /** "compat-cad-004" = introduced by this work item; "verified-baseline"
   *  = the pre-existing verified request surfaced by the consolidated
   *  registry. */
  readonly origin: "compat-cad-004" | "verified-baseline";
}

// ---------------------------------------------------------------------------
// The consolidated associative report (computed fresh, never stored stale).
// ---------------------------------------------------------------------------

/** The typed outcome vocabulary of one association row. */
export type AssocOutcome =
  | "ok"
  | "dangling"
  | "source_loss"
  | "missing"
  | "stale";

/** One typed associative-report row (deterministic ordering, computed
 *  fresh from the canonical elements/records every call — the report IS
 *  the derivation, never a stored result). */
export interface AssocRow {
  /** The row's association class (deterministic section grouping). */
  readonly kind:
    | "annotation"
    | "symbol"
    | "xref"
    | "raster"
    | "docs";
  /** The associating record/element id (the annotation element, the
   *  instance element, the specialized record, the docs annotation). */
  readonly id: string;
  /** The typed outcome (see AssocOutcome). */
  readonly outcome: AssocOutcome;
  /** The typed failure code (present iff outcome is not "ok"). */
  readonly code?: string;
  /** The deterministic one-line reason (echo, never silent). */
  readonly reason: string;
  /** The association targets (referenced canonical ids, id-sorted). */
  readonly targets: readonly string[];
}

/** The consolidated associative report view. */
export interface AssocReportView {
  readonly rows: readonly AssocRow[];
  readonly counts: {
    readonly total: number;
    readonly ok: number;
    readonly notOk: number;
  };
  /** Deterministic digest of the row set (sha256 over the canonical
   *  serialization — the parity/reproducibility basis). */
  readonly reportSha256: string;
}

// ---------------------------------------------------------------------------
// The associative refresh outcome (one atomic revision).
// ---------------------------------------------------------------------------

/** The `assoc.refresh` command result view. */
export interface AssocRefreshView {
  /** True when any edit was applied (one revision); false = everything
   *  already current (no revision burned). */
  readonly applied: boolean;
  /** Deterministic summary line. */
  readonly summary: string;
  /** The typed per-annotation notes (the re-measurement cascade echoes —
   *  disassociation is REPORTED, never a silent re-target). */
  readonly notes: readonly string[];
  /** The documentation regeneration annotation outcome counts. */
  readonly docs: {
    readonly updated: number;
    readonly dangling: number;
    readonly sourceLoss: number;
  };
  /** The post-refresh consolidated report (same shape as assoc.report). */
  readonly report: AssocReportView;
}

// ---------------------------------------------------------------------------
// The bounded pattern operations.
// ---------------------------------------------------------------------------

/** The `pattern.mirror` command result view. */
export interface PatternMirrorView {
  /** Deterministic summary line. */
  readonly summary: string;
  /** Created element count (mirrored copies — eraseSource=false). */
  readonly created: number;
  /** Modified element count (in-place mirrors — eraseSource=true). */
  readonly modified: number;
  /** The per-kind outcome rows (geometry vs block instances, ids in the
   *  deterministic batch order). */
  readonly rows: readonly {
    readonly id: string;
    readonly kind: "geometry" | "block-ref";
    /** The element id AFTER the operation (the minted copy id when
     *  eraseSource=false — resolved from the post-execute snapshot). */
    readonly resultId: string;
    readonly mirrored: boolean;
  }[];
}
