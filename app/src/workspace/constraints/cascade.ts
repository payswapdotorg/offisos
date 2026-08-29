/**
 * CAD-PARITY-007 constraint cascades (Issue #86) — the post-edit integration
 * of the declared constraint graph with the atomic DocumentEdit model.
 *
 * Two cascades compose with the CAD-PARITY-005 annotation remeasure cascade
 * inside the SAME atomic applyEdits batch (one revision, one undo entry):
 *
 *  - SEVERANCE (the CAD-PARITY-005 dead-ref precedent): constraints whose
 *    target elements are REMOVED, or whose target entities are
 *    RE-TOPOLOGIZED (trim/extend/break/fillet/chamfer/join — the parametric
 *    identity of the construction points is broken), are REMOVED from the
 *    graph with an explicit echo — never left dangling, never silently
 *    repaired. Constraint-aware COPY/MIRROR copies carry NO constraints
 *    (constraints bind the original canonical identities — documented).
 *
 *  - RE-SOLVE (constraint-aware editing): after transform edits
 *    (move/rotate/scale/mirror/stretch/offset/setGeometry/array …) the
 *    affected components re-solve — FIXED geometry is restored first
 *    (fixed means fixed), then the deterministic propagation adjusts the
 *    free geometry and the typed outcome is echoed.
 *
 * The caller (the App API command layer) passes the document's declared
 * constraint graph; everything here is pure computation producing edits.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { ConstraintRecord, DocumentEdit, Element } from "../../contracts/caddocument.js";
import type { Geom } from "../geometry/types.js";
import { solveConstraints, constraintsReferencing, type SolveResult } from "./solve.js";
import { constrainableGeomOf } from "./types.js";

// ---------------------------------------------------------------------------
// Geometry patches (the replaceGeomEdit contract: canonical flat geometry +
// layer + preserved display overrides — professional display is never
// stripped by a constraint solve; the CAD-PARITY-003/004 regression rule).
// ---------------------------------------------------------------------------

const DISPLAY_KEYS: readonly string[] = ["color", "linetype", "lineweight", "transparency"];

/** One setProps edit replacing an element's geometry with the canonical
 *  flat convention (layer + display overrides preserved). */
export function geometryEditFor(el: Element, geom: Geom): DocumentEdit {
  const props: Record<string, unknown> = {
    drafting: true,
    layer: typeof (el.props as Record<string, unknown>).layer === "string"
      ? (el.props as Record<string, unknown>).layer
      : "0",
    ...(geom as unknown as Record<string, unknown>),
  };
  for (const key of DISPLAY_KEYS) {
    const v = (el.props as Record<string, unknown>)[key];
    if (v !== undefined) props[key] = v;
  }
  return { type: "setProps", elementId: el.id, patch: props };
}

// ---------------------------------------------------------------------------
// Severance.
// ---------------------------------------------------------------------------

export interface SeveranceOutcome {
  /** removeConstraint edits for the dead constraints (deterministic:
   *  constraint-id order). */
  readonly edits: readonly DocumentEdit[];
  /** The severed records (for the caller's bookkeeping). */
  readonly severed: readonly ConstraintRecord[];
  /** Deterministic echo notes. */
  readonly notes: readonly string[];
}

/** The constraints to sever: those referencing any removed element OR any
 *  re-topologized entity (trim/extend/break/fillet/chamfer/join targets). */
export function severanceFor(
  constraints: readonly ConstraintRecord[],
  removedIds: ReadonlySet<string>,
  retopologizedIds: ReadonlySet<string> = new Set(),
): SeveranceOutcome {
  const dead = constraintsReferencing(constraints, removedIds);
  const deadIds = new Set(dead.map((c) => c.id));
  const retopo = constraints.filter(
    (c) => !deadIds.has(c.id) && c.targets.some((t) => retopologizedIds.has(t.id)),
  );
  const severed = [...dead, ...retopo].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edits: DocumentEdit[] = severed.map((c) => ({ type: "removeConstraint", constraintId: c.id }));
  const notes: string[] = [];
  for (const c of severed) {
    notes.push(
      `constraint '${c.id}' (${c.kind}) severed — ${
        c.targets.some((t) => removedIds.has(t.id))
          ? "its target element was removed"
          : "its target entity was re-topologized"
      }`,
    );
  }
  return { edits, severed, notes };
}

// ---------------------------------------------------------------------------
// The re-solve cascade.
// ---------------------------------------------------------------------------

export interface ConstraintCascadeOutcome {
  /** Edits to append to the triggering batch (geometry patches first, then
   *  severance removals — the caller orders them deterministically). */
  readonly edits: readonly DocumentEdit[];
  /** The solve result (diagnostics + outcome for the echo). */
  readonly result: SolveResult | null;
  /** Deterministic echo lines. */
  readonly notes: readonly string[];
  /** The live (unsevered) constraint graph after this cascade. */
  readonly liveConstraints: readonly ConstraintRecord[];
}

/**
 * The constraint-aware editing cascade. `elements` is the PRE-EDIT world;
 * `batch` is the triggering edit batch (already computed); `constraints` is
 * the declared graph. Computes severance + the re-solve and returns the
 * edits to append so the FINAL batch is one atomic revision.
 */
export function constraintCascade(
  elements: readonly Element[],
  batch: DocumentEdit,
  constraints: readonly ConstraintRecord[],
  retopologizedIds: ReadonlySet<string>,
): ConstraintCascadeOutcome {
  if (constraints.length === 0) {
    return { edits: [], result: null, notes: [], liveConstraints: [] };
  }
  // The post-edit world (the re-solve reads the edited geometry).
  const worldAfter = applyEditsInMemory(elements, batch);
  const afterById = new Map(worldAfter.map((el) => [el.id, el]));

  // 1. Severance: removed targets + re-topologized entities.
  const removedIds = new Set<string>();
  collectRemovedIds(batch, removedIds);
  const severance = severanceFor(constraints, removedIds, retopologizedIds);
  const severedIds = new Set(severance.severed.map((c) => c.id));
  const live = constraints.filter((c) => !severedIds.has(c.id));

  // 2. Re-solve: seeds are the geometry-CHANGED entities that (a) survived,
  //    (b) still carry live constraints.
  const changedIds = new Set<string>();
  collectEditedIds(batch, changedIds);
  const seeds: string[] = [];
  for (const id of changedIds) {
    if (removedIds.has(id)) continue;
    const el = afterById.get(id);
    if (el === undefined) continue;
    if (constrainableGeomOf(el) === null) continue;
    if (live.some((c) => c.targets.some((t) => t.id === id))) seeds.push(id);
  }

  const edits: DocumentEdit[] = [];
  const notes: string[] = [...severance.notes];
  let result: SolveResult | null = null;
  if (seeds.length > 0 && live.length > 0) {
    result = solveConstraints(worldAfter, live, { seedIds: seeds, before: elements });
    for (const [id, geom] of result.geometry) {
      const el = afterById.get(id);
      if (el === undefined) continue;
      edits.push(geometryEditFor(el, geom));
    }
    if (result.geometry.size > 0) {
      notes.push(
        `constraint solve: ${result.outcome} — ${result.geometry.size} ${
          result.geometry.size === 1 ? "entity" : "entities"
        } adjusted`,
      );
    } else {
      notes.push(`constraint solve: ${result.outcome}`);
    }
    for (const n of result.notes) notes.push(n);
  }

  // Severance removals travel AFTER the geometry patches (deterministic
  // order; removal is order-independent within the atomic batch).
  edits.push(...severance.edits);
  return { edits, result, notes, liveConstraints: live };
}

// ---------------------------------------------------------------------------
// Shared in-memory batch application (the entity-ops convention).
// ---------------------------------------------------------------------------

/** Apply an edit batch to an in-memory element world (the cascade's
 *  post-op view — addElement/updateElement(merge)/removeElement/
 *  setProps(replace); non-element edits pass through untouched). */
export function applyEditsInMemory(elements: readonly Element[], edit: DocumentEdit): Element[] {
  let world = [...elements];
  const walk = (e: DocumentEdit): void => {
    if (e.type === "applyEdits") {
      for (const sub of e.edits) walk(sub);
      return;
    }
    switch (e.type) {
      case "addElement":
        world = [...world, e.element];
        break;
      case "removeElement":
        world = world.filter((el) => el.id !== e.elementId);
        break;
      case "updateElement":
        world = world.map((el) =>
          el.id === e.elementId ? { ...el, props: { ...el.props, ...e.patch } } : el,
        );
        break;
      case "setProps":
        world = world.map((el) => (el.id === e.elementId ? { ...el, props: e.patch } : el));
        break;
      default:
        break;
    }
  };
  walk(edit);
  return world;
}

/** Collect the element ids an edit batch touches (add/modify/remove). */
export function collectEditedIds(edit: DocumentEdit, out: Set<string>): void {
  if (edit.type === "applyEdits") {
    for (const sub of edit.edits) collectEditedIds(sub, out);
    return;
  }
  switch (edit.type) {
    case "addElement":
      out.add(edit.element.id);
      break;
    case "removeElement":
    case "updateElement":
    case "setProps":
      out.add(edit.elementId);
      break;
    default:
      break;
  }
}

/** Collect the element ids an edit batch REMOVES. */
export function collectRemovedIds(edit: DocumentEdit, out: Set<string>): void {
  if (edit.type === "applyEdits") {
    for (const sub of edit.edits) collectRemovedIds(sub, out);
    return;
  }
  if (edit.type === "removeElement") out.add(edit.elementId);
}

/** Convert a solve result's geometry patches to setProps edits against a
 *  world (the constraint.create / constraint.update / constraint.solve
 *  command path). */
export function solveGeometryEdits(
  elements: readonly Element[],
  result: SolveResult,
): readonly DocumentEdit[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const edits: DocumentEdit[] = [];
  for (const [id, geom] of result.geometry) {
    const el = byId.get(id);
    if (el === undefined) continue;
    edits.push(geometryEditFor(el, geom));
  }
  return edits;
}
