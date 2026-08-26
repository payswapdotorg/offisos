/**
 * Deterministic snapping (COMPAT-CAD-001, Issue #37 precision scope).
 *
 * Snap resolution is a PURE function of (query point, tolerance, enabled
 * kinds, visible entity set, grid size): the same inputs always produce the
 * same ranked candidate list and the same best snap — on every host, every
 * run (Web/Electron parity; deterministic automation is an acceptance
 * criterion). Residual distances are ALWAYS reported (no silent
 * approximation).
 *
 * Ranking (total order, deterministic tie-breaks):
 *   1. distance to the query point, ascending;
 *   2. snap-kind priority (endpoint < intersection < center < midpoint <
 *      quadrant < on-object < grid);
 *   3. target ids joined ascending (intersections carry the sorted id pair);
 *   4. point x, then y, ascending.
 *
 * Entities on hidden layers are not snappable (visibility is pickability).
 * Annotation entities (dimensions) contribute NO snap targets (they are not
 * cutting/reference geometry).
 */

import type { Element, SnapKind } from "../contracts/caddocument.js";
import { elementToDraftEntity, entityCurves, isDraftingElement, type DraftCurve, type DraftEntity } from "./entities.js";
import { SNAP_KIND_PRIORITY } from "../caddocument/workspace.js";
import type { Vec2 } from "./precision.js";
import * as g from "./geom2d.js";

export interface SnapCandidate {
  readonly kind: SnapKind;
  readonly point: Vec2;
  /** Residual distance to the query point (always reported). */
  readonly distance: number;
  /** Contributing entity ids (sorted; intersections carry both). */
  readonly targets: readonly string[];
}

export interface SnapResult {
  readonly query: Vec2;
  readonly tolerance: number;
  readonly snapped: boolean;
  readonly best: SnapCandidate | null;
  /** All candidates within tolerance, deterministically ranked. */
  readonly candidates: readonly SnapCandidate[];
}

export interface SnapQuery {
  readonly point: Vec2;
  readonly tolerance: number;
  readonly kinds: readonly SnapKind[];
  /** Visible drafting entities (hidden layers pre-filtered by the caller). */
  readonly entities: readonly Element[];
  /** Grid size for the `grid` kind (required when grid snapping is enabled). */
  readonly gridSize?: number;
  /** Entity ids to exclude (e.g. the entity currently being drawn). */
  readonly exclude?: readonly string[] | undefined;
}

const KIND_ORDER: ReadonlyMap<SnapKind, number> = new Map(
  SNAP_KIND_PRIORITY.map((k, i) => [k, i] as const),
);

function compareCandidates(a: SnapCandidate, b: SnapCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const ka = KIND_ORDER.get(a.kind) ?? 99;
  const kb = KIND_ORDER.get(b.kind) ?? 99;
  if (ka !== kb) return ka - kb;
  const ta = a.targets.join("|");
  const tb = b.targets.join("|");
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.point[0] !== b.point[0]) return a.point[0] - b.point[0];
  return a.point[1] - b.point[1];
}

export function resolveSnap(query: SnapQuery): SnapResult {
  const { point, tolerance } = query;
  if (!(tolerance > 0)) throw new Error("snap tolerance must be positive");
  const kinds = new Set(query.kinds);
  const exclude = new Set(query.exclude ?? []);
  const candidates: SnapCandidate[] = [];

  // Parse + filter the visible drafting entities up front (LOCK-007: strict
  // parse — a malformed drafting element fails loudly, never guessed).
  const parsed: DraftEntity[] = [];
  for (const el of query.entities) {
    if (!isDraftingElement(el)) continue;
    if (exclude.has(el.id)) continue;
    parsed.push(elementToDraftEntity(el));
  }

  // --- Single-entity candidates ------------------------------------------------
  for (const entity of parsed) {
    if (kinds.has("endpoint")) {
      for (const p of entityEndpoints(entity)) {
        candidates.push(mk("endpoint", p, [entity.id]));
      }
    }
    if (kinds.has("midpoint")) {
      for (const p of entityMidpoints(entity)) {
        candidates.push(mk("midpoint", p, [entity.id]));
      }
    }
    if (kinds.has("center")) {
      if (entity.type === "circle" || entity.type === "arc") {
        candidates.push(mk("center", entity.center, [entity.id]));
      }
    }
    if (kinds.has("quadrant")) {
      for (const p of entityQuadrants(entity)) {
        candidates.push(mk("quadrant", p, [entity.id]));
      }
    }
    if (kinds.has("on-object")) {
      const cp = closestPointOnEntity(entity, point);
      if (cp !== null) candidates.push(mk("on-object", cp, [entity.id]));
    }
  }

  // --- Pairwise intersections ---------------------------------------------------
  if (kinds.has("intersection") && parsed.length >= 2) {
    const curvesByEntity = new Map<string, readonly DraftCurve[]>(
      parsed.map((e) => [e.id, entityCurves(e)] as const),
    );
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const a = parsed[i] as DraftEntity;
        const b = parsed[j] as DraftEntity;
        const targets = [a.id, b.id].sort();
        for (const ca of curvesByEntity.get(a.id) ?? []) {
          for (const cb of curvesByEntity.get(b.id) ?? []) {
            for (const ix of intersectCurves(ca, cb)) {
              candidates.push(mk("intersection", ix, targets));
            }
          }
        }
      }
    }
  }

  // --- Grid ---------------------------------------------------------------------
  if (kinds.has("grid")) {
    const size = query.gridSize;
    if (size === undefined || !(size > 0)) {
      throw new Error("grid snap requires a positive gridSize");
    }
    const gp: Vec2 = [Math.round(point[0] / size) * size, Math.round(point[1] / size) * size];
    candidates.push(mk("grid", gp, []));
  }

  const within = candidates
    .filter((c) => c.distance <= tolerance)
    .sort(compareCandidates);
  const best = within[0] ?? null;
  return { query: point, tolerance, snapped: best !== null, best, candidates: within };

  function mk(kind: SnapKind, p: Vec2, targets: readonly string[]): SnapCandidate {
    return { kind, point: p, distance: g.distance(p, point), targets };
  }
}

// --- Per-entity candidate points ------------------------------------------------

function entityEndpoints(entity: DraftEntity): readonly Vec2[] {
  switch (entity.type) {
    case "line":
      return [entity.from, entity.to];
    case "polyline":
      return entity.closed ? [] : [entity.points[0] as Vec2, entity.points[entity.points.length - 1] as Vec2];
    case "arc":
      return [
        g.pointOnCircle(entity.center, entity.radius, entity.startAngle),
        g.pointOnCircle(entity.center, entity.radius, entity.endAngle),
      ];
    default:
      return [];
  }
}

function entityMidpoints(entity: DraftEntity): readonly Vec2[] {
  switch (entity.type) {
    case "line":
      return [g.segmentMidpoint(entity.from, entity.to)];
    case "polyline": {
      const mids: Vec2[] = [];
      const n = entity.points.length;
      const last = entity.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        mids.push(g.segmentMidpoint(entity.points[i] as Vec2, entity.points[(i + 1) % n] as Vec2));
      }
      return mids;
    }
    case "arc": {
      const sweep = entity.endAngle - entity.startAngle;
      const ccw = sweep > 0 ? sweep : sweep + 2 * Math.PI;
      return [g.arcMidpoint(entity.center, entity.radius, entity.startAngle, ccw)];
    }
    case "rectangle": {
      const curves = entityCurves(entity) as Extract<DraftCurve, { kind: "segment" }>[];
      return curves.map((c) => g.segmentMidpoint(c.a, c.b));
    }
    default:
      return [];
  }
}

function entityQuadrants(entity: DraftEntity): readonly Vec2[] {
  if (entity.type !== "circle" && entity.type !== "arc") return [];
  const out: Vec2[] = [];
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI) / 2;
    if (entity.type === "circle") {
      out.push(g.pointOnCircle(entity.center, entity.radius, angle));
    } else {
      const sweep = entity.endAngle - entity.startAngle;
      const ccw = sweep > 0 ? sweep : sweep + 2 * Math.PI;
      const rel = ((angle - entity.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (rel <= ccw) out.push(g.pointOnCircle(entity.center, entity.radius, angle));
    }
  }
  return out;
}

function closestPointOnEntity(entity: DraftEntity, p: Vec2): Vec2 | null {
  const curves = entityCurves(entity);
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (const c of curves) {
    const cp = closestPointOnCurve(c, p);
    if (cp === null) continue;
    const d = g.distance(cp, p);
    if (d < bestDist) {
      bestDist = d;
      best = cp;
    }
  }
  return best;
}

export function closestPointOnCurve(c: DraftCurve, p: Vec2): Vec2 | null {
  switch (c.kind) {
    case "segment":
      return g.closestPointOnSegment(c.a, c.b, p).point;
    case "circle":
      return g.closestPointOnCircle(c.center, c.radius, p);
    case "arc":
      return g.closestPointOnArc(c.center, c.radius, c.startAngle, c.sweep, p);
  }
}

/** Curve ∩ curve points (proper crossings; deterministic order). */
export function intersectCurves(a: DraftCurve, b: DraftCurve): readonly Vec2[] {
  const seg = (c: DraftCurve): c is Extract<DraftCurve, { kind: "segment" }> => c.kind === "segment";
  const arcOf = (c: DraftCurve): { center: Vec2; radius: number; startAngle: number; sweep: number } | null => {
    if (c.kind === "circle") return { center: c.center, radius: c.radius, startAngle: 0, sweep: 2 * Math.PI };
    if (c.kind === "arc") return { center: c.center, radius: c.radius, startAngle: c.startAngle, sweep: c.sweep };
    return null;
  };
  const withinArc = (angle: number, start: number, sweep: number): boolean => {
    const rel = ((angle - start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return rel <= sweep + 1e-12;
  };
  if (seg(a) && seg(b)) {
    const ix = g.intersectSegments(a.a, a.b, b.a, b.b);
    return ix === null ? [] : [ix.point];
  }
  if (seg(a)) {
    const cb = arcOf(b);
    if (cb === null) return [];
    return g.intersectSegmentCircle(a.a, a.b, cb.center, cb.radius)
      .filter((i) => withinArc(i.t2, cb.startAngle, cb.sweep))
      .map((i) => i.point);
  }
  if (seg(b)) {
    const ca = arcOf(a);
    if (ca === null) return [];
    return g.intersectSegmentCircle(b.a, b.b, ca.center, ca.radius)
      .filter((i) => withinArc(i.t2, ca.startAngle, ca.sweep))
      .map((i) => i.point);
  }
  const ca = arcOf(a);
  const cb = arcOf(b);
  if (ca === null || cb === null) return [];
  return g.intersectCircles(ca.center, ca.radius, cb.center, cb.radius)
    .filter((i) => withinArc(i.t1, ca.startAngle, ca.sweep) && withinArc(i.t2, cb.startAngle, cb.sweep))
    .map((i) => i.point);
}
