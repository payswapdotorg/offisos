/**
 * Drafting edit operations (COMPAT-CAD-001, Issue #37 editing scope).
 *
 * Pure functions from (document entities, operation parameters) to atomic
 * `applyEdits` batches — one logical operation = ONE versioned command =
 * ONE revision = ONE undo entry (the existing document command model). The
 * App API validates operands, applies the batch and returns the snapshot.
 *
 * TRIM (line targets; the supported set for this slice): the picked point
 * selects the portion to REMOVE — the open interval between the nearest
 * intersection before the pick (t_lo) and the nearest after it (t_hi),
 * clipped to the segment ends when a side has no intersection. The surviving
 * head portion RETAINS the original entity identity (endpoint patch); a
 * surviving tail portion becomes a new minted entity. Cutting geometry: all
 * other non-annotation drafting entities regardless of layer visibility
 * (editing ops see hidden geometry — the declared rule).
 *
 * EXTEND (line targets): the picked point selects the end to extend; the
 * line grows along its own direction to the NEAREST intersection with any
 * other non-annotation entity beyond that end. Typed no-op when none exists.
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import { elementToDraftEntity, entityCurves, isDraftingElement, translatePatch, type DraftEntity, type LineEntity } from "./entities.js";
import { intersectCurves } from "./snap.js";
import { PARAM_EPS, Vec2 } from "./precision.js";
import * as g from "./geom2d.js";

export type EditOpOutcome =
  | { readonly status: "applied"; readonly edit: DocumentEdit; readonly summary: string }
  | { readonly status: "no-op"; readonly reason: string };

// --- move / copy / delete ------------------------------------------------------

/** MOVE: translate the selected entities by (dx, dy). One atomic batch. */
export function moveEntities(entities: readonly Element[], ids: readonly string[], dx: number, dy: number): EditOpOutcome {
  const selected = selectDrafting(entities, ids);
  const edits: DocumentEdit[] = [];
  for (const el of selected) {
    const entity = elementToDraftEntity(el);
    const patch = translatePatch(entity, dx, dy);
    if (patch === null) continue;
    edits.push({ type: "updateElement", elementId: el.id, patch });
  }
  if (edits.length === 0) return { status: "no-op", reason: "no translatable drafting entity in the selection" };
  return {
    status: "applied",
    edit: batch(edits),
    summary: `moved ${edits.length} entit${edits.length === 1 ? "y" : "ies"} by (${dx}, ${dy})`,
  };
}

/** COPY: duplicate the selected entities translated by (dx, dy). New
 *  identities are MINTED by the document (addElement with an empty id). */
export function copyEntities(entities: readonly Element[], ids: readonly string[], dx: number, dy: number): EditOpOutcome {
  const selected = selectDrafting(entities, ids);
  const edits: DocumentEdit[] = [];
  for (const el of selected) {
    const entity = elementToDraftEntity(el);
    const patch = translatePatch({ ...entity, id: el.id }, dx, dy);
    const copyProps = patch === null
      ? { ...el.props }
      : { ...el.props, ...patch };
    edits.push({
      type: "addElement",
      element: { id: "", kind: el.kind, engineId: null, props: copyProps },
    });
  }
  if (edits.length === 0) return { status: "no-op", reason: "no drafting entity in the selection" };
  return {
    status: "applied",
    edit: batch(edits),
    summary: `copied ${edits.length} entit${edits.length === 1 ? "y" : "ies"} by (${dx}, ${dy})`,
  };
}

/** DELETE: remove the selected entities (one atomic batch). */
export function deleteEntities(ids: readonly string[]): EditOpOutcome {
  if (ids.length === 0) return { status: "no-op", reason: "empty selection" };
  return {
    status: "applied",
    edit: batch(ids.map((elementId) => ({ type: "removeElement", elementId } as DocumentEdit))),
    summary: `deleted ${ids.length} entit${ids.length === 1 ? "y" : "ies"}`,
  };
}

// --- trim / extend ---------------------------------------------------------------

interface TargetIntersection {
  readonly t: number;
  readonly point: Vec2;
}

function lineTarget(entities: readonly Element[], targetId: string, what: string): LineEntity {
  const el = entities.find((e) => e.id === targetId);
  if (el === undefined) throw new Error(`${what}: no element '${targetId}'`);
  if (!isDraftingElement(el)) throw new Error(`${what}: element '${targetId}' is not a drafting entity`);
  const entity = elementToDraftEntity(el);
  if (entity.type !== "line") {
    throw new Error(`${what}: target must be a line entity (supported set for this slice; got '${entity.type}')`);
  }
  return entity;
}

/** Intersection parameters of the target line with every other non-annotation
 *  entity's curves. `mode "segment"` finds crossings within the target
 *  segment (trim); `mode "infinite"` finds crossings on the target's
 *  INFINITE line (extend — the crossing may lie beyond either end).
 *  Deterministic order: ascending t. */
function cuttingIntersections(
  target: LineEntity,
  others: readonly Element[],
  excludeId: string,
  mode: "segment" | "infinite",
): readonly TargetIntersection[] {
  const hits: TargetIntersection[] = [];
  for (const el of others) {
    if (el.id === excludeId) continue;
    if (!isDraftingElement(el)) continue;
    const entity = elementToDraftEntity(el);
    if (entity.type === "dim-linear" || entity.type === "dim-radius") continue;
    for (const curve of entityCurves(entity)) {
      let points: readonly { point: Vec2; t1: number }[] = [];
      if (curve.kind === "segment") {
        const ix = mode === "infinite"
          ? g.intersectLines(target.from, target.to, curve.a, curve.b)
          : g.intersectSegments(target.from, target.to, curve.a, curve.b);
        points = ix === null ? [] : [{ point: ix.point, t1: ix.t1 }];
      } else {
        // circle/arc: intersect on the infinite line, filter the arc sweep
        const startAngle = curve.kind === "arc" ? curve.startAngle : 0;
        const sweep = curve.kind === "arc" ? curve.sweep : 2 * Math.PI;
        const TWO_PI = 2 * Math.PI;
        points = g.intersectLineCircle(target.from, target.to, curve.center, curve.radius)
          .filter((i) => {
            if (curve.kind !== "arc") return true;
            const rel = ((i.t2 - startAngle) % TWO_PI + TWO_PI) % TWO_PI;
            return rel <= sweep + 1e-12;
          })
          .map((i) => ({ point: i.point, t1: i.t1 }));
        if (mode === "segment") {
          points = points.filter((i) => i.t1 >= -PARAM_EPS && i.t1 <= 1 + PARAM_EPS);
        }
      }
      for (const p of points) hits.push({ t: p.t1, point: p.point });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

/** TRIM a line at the picked portion. */
export function trimEntity(entities: readonly Element[], targetId: string, pick: Vec2): EditOpOutcome {
  const target = lineTarget(entities, targetId, "trim");
  const { t: tPick } = g.closestPointOnSegment(target.from, target.to, pick);
  const hits = cuttingIntersections(target, entities, targetId, "segment");
  // Intersection exactly AT the pick is not a boundary on either side.
  const before = hits.filter((h) => h.t <= tPick - PARAM_EPS);
  const after = hits.filter((h) => h.t >= tPick + PARAM_EPS);
  const tLo = before.length > 0 ? (before[before.length - 1] as TargetIntersection) : null;
  const tHi = after.length > 0 ? (after[0] as TargetIntersection) : null;
  if (tLo === null && tHi === null) {
    return { status: "no-op", reason: "trim: the picked portion has no intersecting boundary on either side" };
  }
  const lo = tLo !== null ? tLo.t : 0;
  const hi = tHi !== null ? tHi.t : 1;
  const keepHead = tLo !== null && lo > PARAM_EPS;
  const keepTail = tHi !== null && hi < 1 - PARAM_EPS;
  const edits: DocumentEdit[] = [];
  if (keepHead && keepTail) {
    // Head retains the identity; the tail becomes a new minted entity.
    edits.push({
      type: "updateElement",
      elementId: target.id,
      patch: { to: pointAt(target, lo) },
    });
    edits.push({
      type: "addElement",
      element: {
        id: "",
        kind: "geometry",
        engineId: null,
        props: {
          ...lineProps(target),
          from: pointAt(target, hi),
          to: target.to,
        },
      },
    });
  } else if (keepHead) {
    edits.push({
      type: "updateElement",
      elementId: target.id,
      patch: { to: pointAt(target, lo) },
    });
  } else if (keepTail) {
    edits.push({
      type: "updateElement",
      elementId: target.id,
      patch: { from: pointAt(target, hi) },
    });
  } else {
    // The removed interval spans the whole segment.
    edits.push({ type: "removeElement", elementId: target.id });
  }
  return {
    status: "applied",
    edit: batch(edits),
    summary: `trimmed '${targetId}' between t=${lo.toFixed(6)} and t=${hi.toFixed(6)}`,
  };
}

/** EXTEND a line from the picked end to the nearest boundary crossing. */
export function extendEntity(entities: readonly Element[], targetId: string, pick: Vec2): EditOpOutcome {
  const target = lineTarget(entities, targetId, "extend");
  const { t: tPick } = g.closestPointOnSegment(target.from, target.to, pick);
  const extendFromEnd = tPick < 0.5;
  const hits = cuttingIntersections(target, entities, targetId, "infinite");
  let candidate: TargetIntersection | null = null;
  for (const h of hits) {
    if (extendFromEnd && h.t <= -PARAM_EPS) {
      if (candidate === null || h.t > candidate.t) candidate = h; // nearest beyond `from`
    } else if (!extendFromEnd && h.t >= 1 + PARAM_EPS) {
      if (candidate === null || h.t < candidate.t) candidate = h; // nearest beyond `to`
    }
  }
  if (candidate === null) {
    return {
      status: "no-op",
      reason: extendFromEnd
        ? "extend: no boundary crossing exists beyond the picked 'from' end"
        : "extend: no boundary crossing exists beyond the picked 'to' end",
    };
  }
  const patch = extendFromEnd ? { from: candidate.point } : { to: candidate.point };
  return {
    status: "applied",
    edit: batch([{ type: "updateElement", elementId: target.id, patch }]),
    summary: `extended '${targetId}' at the ${extendFromEnd ? "from" : "to"} end to the nearest boundary crossing`,
  };
}

// --- helpers ---------------------------------------------------------------------

function selectDrafting(entities: readonly Element[], ids: readonly string[]): readonly Element[] {
  const wanted = new Set(ids);
  const out: Element[] = [];
  for (const el of entities) {
    if (wanted.has(el.id)) {
      if (!isDraftingElement(el)) {
        throw new Error(`selection contains non-drafting element '${el.id}' (drafting ops apply to drafting entities only)`);
      }
      out.push(el);
    }
  }
  if (out.length === 0) throw new Error("selection contains no drafting entities");
  return out;
}

function batch(edits: readonly DocumentEdit[]): DocumentEdit {
  return { type: "applyEdits", edits: [...edits] };
}

function pointAt(line: LineEntity, t: number): Vec2 {
  return g.pointOnSegment(line.from, line.to, t);
}

function lineProps(line: LineEntity): Record<string, unknown> {
  return { drafting: true, type: "line", layer: line.layer };
}
