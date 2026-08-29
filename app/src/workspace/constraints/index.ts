/**
 * CAD-PARITY-007 constraints barrel (Issue #86) — the public surface of the
 * shared parametric-constraints core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts and the App API so the constraint semantics are THE SAME everywhere
 * (LOCK-004 Web/Electron semantic parity).
 */

export {
  ConstraintError,
  GEOMETRIC_KINDS,
  DIMENSIONAL_KINDS,
  ALL_KINDS,
  CONSTRAINT_LABEL,
  CONSTRAINT_GLYPH,
  KIND_ARITY,
  KIND_ANCHOR_RULE,
  CONSTRAINED_TYPES,
  isConstrainableElement,
  anchorsOfType,
  anchorPosition,
  nearestAnchor,
  entityDof,
  constraintDof,
  makeConstraint,
  circleOf,
  validateConstraintTargets,
  constraintElementIds,
  constraintReferencesAny,
  constrainableGeomOf,
} from "./types.js";

export {
  solveConstraints,
  diagnoseConstraints,
  constraintsReferencing,
  type SolveOutcome,
  type SolveResult,
  type SolveOptions,
  type ConstraintStatus,
  type ComponentDof,
} from "./solve.js";

export {
  constraintCascade,
  severanceFor,
  geometryEditFor,
  solveGeometryEdits,
  applyEditsInMemory,
  collectEditedIds,
  collectRemovedIds,
  type SeveranceOutcome,
  type ConstraintCascadeOutcome,
} from "./cascade.js";

export {
  constraintGlyphs,
  paintConstraintGlyphs,
  GLYPH_RADIUS_PX,
  GLYPH_FONT,
  GLYPH_COLORS,
  type ConstraintGlyph,
  type GlyphCanvas2DContext,
  type GlyphPaintOptions,
} from "./paint.js";
