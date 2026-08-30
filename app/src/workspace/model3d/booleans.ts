/**
 * CAD-PARITY-010 (Issue #93): the engine-neutral boolean solid core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Completes the
 * boolean triad over the EXISTING GeometryDescriptor vocabulary:
 *
 *   union       → { shape: "fuse",      a, b }  (CAD-IMPLEMENT-002)
 *   difference  → { shape: "cut",       a, b }  (CAD-IMPLEMENT-002)
 *   intersection→ { shape: "intersect", a, b }  (CAD-PARITY-010 — the new
 *                                                 third boolean)
 *
 * The command layer composes the operands' PERSISTED descriptors (the
 * document-owned geometry declarations); the adapter realizes the composed
 * descriptor through the engine (OCCT BRepAlgoAPI_Fuse/Cut/Common) and
 * returns the deterministic result (meshToken/bbox/provenance), which is
 * persisted with the result element in the SAME atomic revision. Engine ids
 * never appear here; the operand provenance carries the DOCUMENT ids and the
 * operands' meshTokens (deterministic result provenance — acceptance
 * criterion 2).
 *
 * Typed failures (the command layer surfaces these; never a silent
 * approximation — Issue #93 §1):
 *   boolean_operand   — an operand is not a model3d solid with persisted
 *                       geometry (or the same element is named twice).
 *   boolean_empty     — the operation annihilates all material (the engine
 *                       reports engine_empty_result: a disjoint intersection
 *                       or a subtraction that removes everything).
 *   boolean_invalid   — the engine rejects the combination (non-manifold or
 *                       invalid result, construction failure) — the message
 *                       carries the engine detail verbatim.
 */

import type { GeometryDescriptor } from "../../contracts/geometry.js";

/** The bounded boolean operation vocabulary (the full triad). */
export type BooleanOp = "union" | "difference" | "intersection";

/** The canonical operation order (echo/validation surfaces). */
export const BOOLEAN_OPS: readonly BooleanOp[] = ["union", "difference", "intersection"];

/** Parse/validate a boolean op name (typed decline text on failure). */
export function parseBooleanOp(value: string): BooleanOp | null {
  if (value === "union" || value === "difference" || value === "intersection") return value;
  return null;
}

/** Compose the boolean descriptor for the op over two operand descriptors.
 *  The composition is the descriptor vocabulary itself — deterministic by
 *  construction (no engine work here). */
export function booleanDescriptor(op: BooleanOp, a: GeometryDescriptor, b: GeometryDescriptor): GeometryDescriptor {
  switch (op) {
    case "union":
      return { shape: "fuse", a, b };
    case "difference":
      return { shape: "cut", a, b };
    case "intersection":
      return { shape: "intersect", a, b };
  }
}

/** One operand's deterministic provenance (document id + the meshToken the
 *  operand had when the boolean was composed — the result is reproducible
 *  from the persisted descriptors; the tokens bind the operands' realized
 *  state at composition time). */
export interface BooleanOperandProvenance {
  readonly elementId: string;
  readonly meshToken: string;
}

/** The deterministic result provenance persisted with the boolean solid. */
export interface BooleanProvenance {
  readonly op: BooleanOp;
  readonly operands: readonly BooleanOperandProvenance[];
}

/** Build the result provenance (the command layer supplies the operands'
 *  persisted state; ordering is the command's operand order — stable). */
export function booleanProvenance(op: BooleanOp, operands: readonly BooleanOperandProvenance[]): BooleanProvenance {
  return { op, operands: [...operands] };
}

/** The typed decline surfaced when a boolean operand is not usable (not a
 *  model3d solid, no persisted geometry, or the same element twice). */
export const BOOLEAN_OPERAND_DECLINE_REASON =
  "boolean operands must be distinct model3d solid elements with persisted geometry (create them with model3d.box/cylinder/extrude/boolean first)";

/**
 * The bounded operand-count rule: exactly TWO operands per boolean command
 * (AutoCAD accepts more; the bounded deterministic slice composes longer
 * chains through repeated commands — each step one atomic revision with
 * exact undo/redo, so N-ary unions are expressible without ambiguity).
 */
export const BOOLEAN_OPERAND_COUNT = 2;

/** Map an adapter failure code to the typed boolean decline code (the App
 *  API boolean command uses this; engine transport codes — unavailable,
 *  timeout, generic engine_error — pass through verbatim). */
export function booleanFailureCode(adapterCode: string): string {
  switch (adapterCode) {
    case "engine_empty_result":
      return "boolean_empty";
    case "engine_non_manifold":
    case "engine_malformed_input":
      return "boolean_invalid";
    default:
      return adapterCode;
  }
}

/** The typed decline text for the empty result (deterministic). */
export const BOOLEAN_EMPTY_DECLINE_REASON =
  "the boolean operation annihilates all material (a disjoint intersection or a subtraction that removes everything) — an empty solid is never fabricated";

/** The typed decline text for invalid/non-manifold results. */
export const BOOLEAN_INVALID_DECLINE_REASON =
  "the engine rejected the boolean combination (invalid or non-manifold result) — the message carries the engine detail";
