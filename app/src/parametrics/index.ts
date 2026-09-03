/**
 * COMPAT-CAD-004 (Issue #121) — the bounded consolidated parametrics core:
 * the versioned capability registry (API-001), the consolidated typed
 * associative report + the one-revision atomic refresh, and the bounded
 * deterministic pattern operations (the mirror that includes symbol
 * instances) (additive, engine-free, Architecture v1.1 FROZEN).
 *
 * Governing boundaries honored here (LOCK-003/018/019, the P015/P017/P018
 * precedents):
 *  - This module family is pure TypeScript: no engine imports, no host
 *    imports, no environment reads, no wall-clock, no random. Every
 *    derivation is a pure function of the canonical elements/records.
 *  - The CADDocument stays the single canonical system of record. The
 *    family adds NO parallel record table: mirrored symbol instances are
 *    the existing block-ref ELEMENTS with the additive optional
 *    `mirrored: true` placement state; the associative refresh composes
 *    the EXISTING verified cascades; pattern operations emit exactly the
 *    sub-edits the document already validates.
 */

export { ParametricsError, parametricsErr } from "./errors.js";
export {
  PARAMETRICS_API_VERSION,
  PARAMETRIC_CAPABILITIES,
  parametricCapabilityOf,
  parametricCapabilityViews,
} from "./capabilities.js";
export {
  assocReport,
  composeAssocRefresh,
  assocRefreshViewOf,
  type AssocWorld,
  type AssocRefreshOutcome,
} from "./associative.js";
export {
  buildMirrorPlan,
  mirrorViewOf,
  type PatternMirrorPlan,
  type MirrorRowPlan,
} from "./patterns.js";
