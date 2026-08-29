/**
 * CAD-PARITY-005 associative dimension core (Issue #82) — the deterministic
 * re-measurement cascade.
 *
 * Associativity model: a dimension ANNOTATION records which measured points
 * derive from which referenced elements (`refs`, plus the radius/diameter
 * `target`). When a referenced element's geometry changes through
 * entity.modify, the annotation re-derives its points from the CURRENT
 * geometry and re-measures — as part of the SAME atomic versioned batch
 * (one revision, one undo entry; AutoCAD-class associative dimensions).
 *
 * Resolution rules (deterministic, typed behavior — LOCK-007):
 *  - ref anchors resolve on the canonical geometry view: line/ray/xline
 *    start/end/midpoint, circle/arc center, arc start/end, polyline
 *    start/end (first/last vertex);
 *  - a ref whose target element no longer exists DISASSOCIATES (the DEAD
 *    ref is REMOVED from the stored refs array — the association is
 *    severed in storage, never left stale; surviving refs stay live; when
 *    none survive the refs key is REMOVED, the contract's canonical "no
 *    references" form; the stored measured value survives — the dimension
 *    keeps its last known state; the echo says so, never a silent repair;
 *    PR #83 review comment 5460214794);
 *  - dim-radius/dim-diameter keep a self-contained center/radius snapshot
 *    (rendered even when disassociated); a present target refreshes both;
 *  - dim-angular legs reference the line endpoints their ray pointed at
 *    (creation-time anchor); on remeasure the vertex re-intersects and the
 *    sector whose mid-angle is closest to the previous mid-angle wins
 *    (deterministic re-selection);
 *  - the offset (dimension line placement) is PRESERVED through
 *    re-measurement (the placement is the user's, not the measurement's).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { DocumentEdit, Element } from "../../contracts/caddocument.js";
import { geomFromElement } from "../geometry/bridge.js";
import { lineLine, Pt, TAU } from "../geometry/math2d.js";
import {
  Annotation,
  annotationFromElement,
  annotationToProps,
  ccwSweep,
  linearMeasured,
  type DimRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Anchor resolution (the canonical geometry view).
// ---------------------------------------------------------------------------

/** Resolve a ref anchor on an element's canonical geometry. Null when the
 *  element does not carry that anchor. */
export function resolveAnchor(
  el: Element,
  anchor: "start" | "end" | "center" | "midpoint",
): Pt | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  switch (geom.type) {
    case "line":
    case "ray":
    case "xline":
      if (anchor === "start") return { x: geom.x1, y: geom.y1 };
      if (anchor === "end") return { x: geom.x2, y: geom.y2 };
      if (anchor === "midpoint") return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
      return null;
    case "circle":
      return anchor === "center" ? { x: geom.cx, y: geom.cy } : null;
    case "arc": {
      if (anchor === "center") return { x: geom.cx, y: geom.cy };
      if (anchor === "start") return arcPoint(geom, geom.startAngle);
      if (anchor === "end") return arcPoint(geom, geom.endAngle);
      return null;
    }
    case "ellipse":
      return anchor === "center" ? { x: geom.cx, y: geom.cy } : null;
    case "polyline":
      if (anchor === "start") return geom.vertices[0] ?? null;
      if (anchor === "end") return geom.vertices[geom.vertices.length - 1] ?? null;
      return null;
    case "point":
      return { x: geom.x, y: geom.y };
    case "spline":
    case "region":
      return null;
  }
}

function arcPoint(geom: Extract<import("../geometry/types.js").Geom, { type: "arc" }>, angle: number): Pt {
  return { x: geom.cx + geom.r * Math.cos(angle), y: geom.cy + geom.r * Math.sin(angle) };
}

/** The circle/arc geometry of an element (radius/diameter targets). */
export function circleGeomOf(el: Element): { center: Pt; radius: number } | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  if (geom.type === "circle") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r };
  if (geom.type === "arc") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r };
  return null;
}

/** The infinite-line geometry of an element (angular legs). */
export function lineGeomOf(el: Element): { a: Pt; b: Pt } | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  if (geom.type === "line" || geom.type === "ray" || geom.type === "xline") {
    return { a: { x: geom.x1, y: geom.y1 }, b: { x: geom.x2, y: geom.y2 } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-measurement.
// ---------------------------------------------------------------------------

export interface RemeasureResult {
  /** The updated annotation (identical content when nothing changed). */
  readonly annotation: Annotation;
  /** True when the stored values changed (a patch is needed). */
  readonly changed: boolean;
  /** Human summary of what happened (echo, deterministic). */
  readonly note: string;
}

function ptChanged(a: Pt, b: Pt): boolean {
  return a.x !== b.x || a.y !== b.y;
}

/** The canonical refs rewrite after reference loss: the stored refs are
 *  stripped and only LIVE refs are re-attached. When no ref survives, the
 *  key is ABSENT (the canonical "no references" form — `optRefs` normalizes
 *  [] to undefined, `annotationToProps` omits the key, and the setProps
 *  full-record rewrite in `remeasureCascade` therefore REMOVES the stored
 *  refs: the disassociation is material, not cosmetic). exactOptionalProperty
 *  Types forbids `refs: undefined`, hence the strip-then-re-attach shape. */
function withLiveRefs<T extends { readonly refs?: readonly DimRef[] }>(
  a: T,
  live: readonly DimRef[],
): T {
  const { refs: _severed, ...base } = a;
  return live.length > 0 ? ({ ...base, refs: live } as T) : (base as T);
}

/** Re-measure ONE annotation against the current elements. */
export function remeasureAnnotation(
  a: Annotation,
  elements: readonly Element[],
): RemeasureResult {
  const byId = new Map(elements.map((el) => [el.id, el]));
  switch (a.type) {
    case "dim-linear": {
      const refs = a.refs ?? [];
      if (refs.length === 0) return { annotation: a, changed: false, note: "no references" };
      let p1 = a.p1;
      let p2 = a.p2;
      let dropped = false;
      const liveRefs: DimRef[] = [];
      for (const ref of refs) {
        const target = byId.get(ref.id);
        const anchor = target !== undefined ? resolveAnchor(target, ref.anchor) : null;
        if (target === undefined || anchor === null) {
          dropped = true;
          continue;
        }
        liveRefs.push(ref);
        if (ref.to === "p1") p1 = anchor;
        if (ref.to === "p2") p2 = anchor;
      }
      const measured = linearMeasured(p1, p2, a.mode, a.angle);
      if (measured <= 1e-9) {
        // The referenced points collapsed — keep the last known state and
        // disassociate (honest: a zero measurement is not representable).
        return {
          annotation: withLiveRefs(a, liveRefs),
          changed: liveRefs.length !== refs.length,
          note: "referenced points coincide — dimension disassociated at its last known value",
        };
      }
      const changed =
        ptChanged(p1, a.p1) || ptChanged(p2, a.p2) ||
        Math.abs(measured - a.measured) > 1e-9 ||
        liveRefs.length !== refs.length;
      return {
        annotation: { ...withLiveRefs(a, liveRefs), p1, p2, measured },
        changed,
        note: liveRefs.length === 0
          ? "all references gone — dimension disassociated at its last known value"
          : dropped
            ? "re-measured; missing references dropped"
            : "re-measured",
      };
    }
    case "dim-radius":
    case "dim-diameter": {
      if (a.target === null) return { annotation: a, changed: false, note: "disassociated" };
      const target = byId.get(a.target);
      if (target === undefined) {
        // Disassociate: keep the self-contained snapshot + last measured.
        return {
          annotation: { ...a, target: null },
          changed: true,
          note: `target '${a.target}' no longer exists — dimension disassociated at its last known value`,
        };
      }
      const circle = circleGeomOf(target);
      if (circle === null) {
        return {
          annotation: { ...a, target: null },
          changed: true,
          note: `target '${a.target}' is no longer a circle/arc — dimension disassociated`,
        };
      }
      const measured = a.type === "dim-radius" ? circle.radius : 2 * circle.radius;
      const changed =
        ptChanged(circle.center, a.center) ||
        Math.abs(measured - a.measured) > 1e-9;
      return {
        annotation: { ...a, center: circle.center, radius: circle.radius, measured },
        changed,
        note: "re-measured",
      };
    }
    case "dim-angular": {
      const refs = a.refs ?? [];
      const leg1Ref = refs.find((r) => r.to === "leg1");
      const leg2Ref = refs.find((r) => r.to === "leg2");
      if (leg1Ref === undefined || leg2Ref === undefined) {
        return { annotation: a, changed: false, note: "no leg references" };
      }
      const leg1 = byId.get(leg1Ref.id);
      const leg2 = byId.get(leg2Ref.id);
      if (leg1 === undefined || leg2 === undefined) {
        // PR #83 review comment 5460214794: the DEAD leg refs are removed
        // explicitly (surviving refs stay; none survive → the key is gone).
        // The vertex/sector/measurement keep their last known values.
        const live = refs.filter((r) => byId.has(r.id));
        return {
          annotation: withLiveRefs(a, live),
          changed: live.length !== refs.length,
          note: live.length === 0
            ? "both leg references gone — angular dimension disassociated at its last known value"
            : "missing leg reference — angular dimension disassociated at its last known value",
        };
      }
      const g1 = lineGeomOf(leg1);
      const g2 = lineGeomOf(leg2);
      if (g1 === null || g2 === null) {
        return { annotation: a, changed: false, note: "leg geometry is not a line — unchanged" };
      }
      const d1: Pt = { x: g1.b.x - g1.a.x, y: g1.b.y - g1.a.y };
      const d2: Pt = { x: g2.b.x - g2.a.x, y: g2.b.y - g2.a.y };
      const vertex = lineLine(g1.a, d1, g2.a, d2);
      if (vertex === null) {
        return { annotation: a, changed: false, note: "legs are parallel — unchanged at last known value" };
      }
      // Leg ray directions: from the vertex toward the anchored endpoint of
      // each line (the creation-time pick side).
      const a1 = resolveAnchor(leg1, leg1Ref.anchor);
      const a2 = resolveAnchor(leg2, leg2Ref.anchor);
      if (a1 === null || a2 === null) {
        return { annotation: a, changed: false, note: "leg anchor unresolvable — unchanged" };
      }
      const leg1Dir: Pt = { x: a1.x - vertex.x, y: a1.y - vertex.y };
      const leg2Dir: Pt = { x: a2.x - vertex.x, y: a2.y - vertex.y };
      if (Math.hypot(leg1Dir.x, leg1Dir.y) <= 1e-12 || Math.hypot(leg2Dir.x, leg2Dir.y) <= 1e-12) {
        return { annotation: a, changed: false, note: "degenerate leg — unchanged at last known value" };
      }
      const ang1 = Math.atan2(leg1Dir.y, leg1Dir.x);
      const ang2 = Math.atan2(leg2Dir.y, leg2Dir.x);
      const prevMid = a.startAngle + ccwSweep(a.startAngle, a.endAngle) / 2;
      // Pick the sector whose mid-angle is closest to the previous one.
      const normA = (v: number): number => ((v % TAU) + TAU) % TAU;
      const candidates: readonly [number, number][] = [
        [normA(ang1), normA(ang2)],
        [normA(ang2), normA(ang1)],
      ];
      let best: readonly [number, number] | null = null;
      let bestDiff = Infinity;
      for (const [s, e] of candidates) {
        const mid = s + ccwSweep(s, e) / 2;
        const raw = Math.abs(normA(mid - prevMid));
        const diff = Math.min(raw, TAU - raw);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = [s, e];
        }
      }
      if (best === null) return { annotation: a, changed: false, note: "no sector" };
      const [startAngle, endAngle] = best;
      const measured = ccwSweep(startAngle, endAngle);
      if (measured <= 1e-9 || measured >= TAU - 1e-9) {
        return { annotation: a, changed: false, note: "degenerate sector — unchanged at last known value" };
      }
      const changed =
        ptChanged(vertex, a.vertex) ||
        Math.abs(startAngle - a.startAngle) > 1e-9 ||
        Math.abs(endAngle - a.endAngle) > 1e-9 ||
        Math.abs(measured - a.measured) > 1e-9;
      return {
        annotation: { ...a, vertex, startAngle, endAngle, measured },
        changed,
        note: "re-measured",
      };
    }
    default:
      return { annotation: a, changed: false, note: "not a dimension" };
  }
}

// ---------------------------------------------------------------------------
// The cascade: post-op element world → setProps edits for every dependent
// annotation whose stored values changed.
// ---------------------------------------------------------------------------

export interface CascadeOutcome {
  /** setProps edits for changed annotations (the caller appends them into
   *  the SAME atomic applyEdits batch — one revision, one undo entry). */
  readonly edits: readonly DocumentEdit[];
  /** Deterministic echo lines. */
  readonly notes: readonly string[];
}

/** The display-override keys an annotation element may carry (CAD-PARITY-004
 *  vocabulary) — preserved through full-record props rewrites. */
const DISPLAY_KEYS: readonly string[] = ["color", "linetype", "lineweight", "transparency"];

/** Compute the remeasure cascade over the annotation views of the post-op
 *  element world. `elementsAfter` must reflect the geometry patches of the
 *  triggering modify op (the caller applies them in memory first). */
export function remeasureCascade(
  annotations: readonly { id: string; annotation: Annotation }[],
  elementsAfter: readonly Element[],
): CascadeOutcome {
  const byId = new Map(elementsAfter.map((el) => [el.id, el]));
  const edits: DocumentEdit[] = [];
  const notes: string[] = [];
  for (const { id, annotation } of annotations) {
    const result = remeasureAnnotation(annotation, elementsAfter);
    if (!result.changed) continue;
    const el = byId.get(id);
    const currentProps = (el?.props ?? {}) as Record<string, unknown>;
    // Full-record props rewrite (setProps semantics — canonical-minimal
    // records: dropped optionals disappear, display overrides preserved).
    const props = annotationToProps(result.annotation);
    for (const key of DISPLAY_KEYS) {
      if (currentProps[key] !== undefined) props[key] = currentProps[key];
    }
    edits.push({ type: "setProps", elementId: id, patch: props });
    notes.push(`${id}: ${result.note}`);
  }
  return { edits, notes };
}

/** Convenience: collect the annotation view of all annotation elements. */
export function annotationViewsOf(elements: readonly Element[]): { id: string; annotation: Annotation }[] {
  const out: { id: string; annotation: Annotation }[] = [];
  for (const el of elements) {
    const a = annotationFromElement(el);
    if (a !== null) out.push({ id: el.id, annotation: a });
  }
  return out;
}

/** Which annotation views reference any of the given element ids? */
export function annotationsReferencing(
  annotations: readonly { id: string; annotation: Annotation }[],
  changedIds: ReadonlySet<string>,
): { id: string; annotation: Annotation }[] {
  return annotations.filter(({ annotation }) => {
    for (const refId of refIdSet(annotation)) {
      if (changedIds.has(refId)) return true;
    }
    return false;
  });
}

function refIdSet(a: Annotation): ReadonlySet<string> {
  const ids = new Set<string>();
  switch (a.type) {
    case "dim-radius":
    case "dim-diameter":
      if (a.target !== null) ids.add(a.target);
      break;
    case "dim-linear":
    case "dim-angular":
      for (const r of a.refs ?? []) ids.add(r.id);
      break;
    default:
      break;
  }
  return ids;
}
