/**
 * COMPAT-CAD-010 (Issue #18) — the deterministic hatch → render-primitive
 * resolution.
 *
 * THE shared semantic core of hatch rendering: a hatch entity (+ the
 * document annotation scale) resolves to a plain list of RENDER
 * PRIMITIVES — clipped pattern SEGMENTS, solid FILL regions and pattern
 * DOTS. BOTH hosts paint exactly these primitives through the shared
 * painter (hatch/paint.ts) — Web and Electron produce identical hatch
 * output by construction (LOCK-004). The SAME primitives drive hatch
 * picking (hatch/pick.ts) — the pick surface and the visible surface can
 * never disagree.
 *
 * Determinism contract (documented, host-independent):
 *  - region semantics are EXACT EVEN-ODD over the stored boundary loops
 *    (islands are XOR semantics; loop orientation is irrelevant);
 *  - pattern line families are generated from the CANONICAL origin (0,0):
 *    family order is the registry order, offsets are integer multiples of
 *    the effective spacing along the family normal, ascending; within one
 *    line the covered intervals are ascending along the line direction;
 *  - the effective spacing is base spacing × entity scale × document
 *    annotation scale (the DIMSCALE-class convention);
 *  - line/region intersection is analytic (half-open polygon edges so a
 *    line through a shared vertex crosses exactly once; circle roots via
 *    the quadratic with an epsilon-tangent skip);
 *  - zero-length intervals (below 1e-9) are dropped — no degenerate
 *    strokes;
 *  - dots are a lattice over the same canonical origin, rows then
 *    columns, inside the region only.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import {
  EPS,
  Pt,
} from "../geometry/math2d.js";
import {
  HATCH_DOT_RADIUS_FACTOR,
  HATCH_PATTERNS,
  type HatchEntity,
  type HatchLoop,
} from "./types.js";

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

export type HatchPrimitive =
  | { readonly kind: "segment"; readonly a: Pt; readonly b: Pt }
  | { readonly kind: "fill"; readonly loops: readonly HatchLoop[] }
  | { readonly kind: "dot"; readonly at: Pt; readonly radius: number };

/** Everything the hatch resolution needs from the document (hosts derive
 *  it from the snapshot deterministically — the annotation style context
 *  convention). */
export interface HatchRenderContext {
  /** The document annotation scale (DrawingStandards.annotationScale;
   *  1 when absent). Multiplies the effective pattern spacing. */
  readonly annotationScale: number;
}

export function hatchRenderContext(annotationScale: number | undefined): HatchRenderContext {
  return { annotationScale: annotationScale !== undefined && Number.isFinite(annotationScale) && annotationScale > 0 ? annotationScale : 1 };
}

// ---------------------------------------------------------------------------
// Region geometry (exact, even-odd).
// ---------------------------------------------------------------------------

/** The axis-aligned bounding box of a loop set. */
export function loopsBBox(loops: readonly HatchLoop[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const addPt = (p: Pt): void => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const loop of loops) {
    if (loop.kind === "polygon") {
      for (const p of loop.points) addPt(p);
    } else {
      addPt({ x: loop.center.x - loop.radius, y: loop.center.y - loop.radius });
      addPt({ x: loop.center.x + loop.radius, y: loop.center.y + loop.radius });
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Point-in-region (exact even-odd over all loops; polygon edges are
 *  half-open so boundary-exact queries stay deterministic). */
export function pointInRegion(point: Pt, loops: readonly HatchLoop[]): boolean {
  let inside = false;
  for (const loop of loops) {
    if (loop.kind === "circle") {
      const dx = point.x - loop.center.x;
      const dy = point.y - loop.center.y;
      if (dx * dx + dy * dy < loop.radius * loop.radius) inside = !inside;
      continue;
    }
    const pts = loop.points;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      // Half-open edge rule (y strictly within [a.y, b.y) or [b.y, a.y)).
      if (a.y > point.y !== b.y > point.y) {
        const xAt = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (point.x < xAt) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * The inside-intervals of an INFINITE line (origin `o`, unit direction
 * `d`) over the region — exact, per-loop pairing then an even-odd sweep
 * across ALL loops (island XOR). Returns ascending [t0, t1] pairs with
 * t0 < t1 (degenerate intervals dropped).
 */
function lineIntervals(o: Pt, d: Pt, loops: readonly HatchLoop[]): [number, number][] {
  // Per-loop intervals: crossings on the line (param t), sorted, paired.
  const intervals: [number, number][] = [];
  for (const loop of loops) {
    if (loop.kind === "circle") {
      // |o + t·d − c|² = r² → quadratic in t.
      const ox = o.x - loop.center.x;
      const oy = o.y - loop.center.y;
      const b = 2 * (ox * d.x + oy * d.y);
      const c = ox * ox + oy * oy - loop.radius * loop.radius;
      const disc = b * b - 4 * c; // a = |d|² = 1
      if (disc <= EPS) continue; // miss or tangent → no interval
      const s = Math.sqrt(disc);
      const t0 = (-b - s) / 2;
      const t1 = (-b + s) / 2;
      if (t1 - t0 > EPS) intervals.push([t0, t1]);
      continue;
    }
    const crossings: number[] = [];
    const pts = loop.points;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      // Line: P(t) = o + t·d. Edge: Q(s) = a + s·(b − a), s ∈ [0, 1)
      // (half-open: shared vertices cross exactly once — the deterministic
      // vertex rule). Solving o + t·d = a + s·e with e = b − a:
      //   d × e = d.x·ey − d.y·ex  (denominator)
      //   t = (a − o) × e / (d × e)   (the line parameter)
      //   s = −(o − a) × d / (d × e)  (the edge parameter)
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const denom = d.x * ey - d.y * ex;
      if (Math.abs(denom) <= EPS) continue; // parallel
      const crossAE = (a.x - o.x) * ey - (a.y - o.y) * ex; // (a − o) × e
      const t = crossAE / denom;
      const crossOD = (o.x - a.x) * d.y - (o.y - a.y) * d.x; // (o − a) × d
      const s = -crossOD / denom;
      if (s < 0 || s >= 1) continue;
      crossings.push(t);
    }
    if (crossings.length < 2) continue;
    crossings.sort((x, y) => x - y);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const t0 = crossings[i]!;
      const t1 = crossings[i + 1]!;
      if (t1 - t0 > EPS) intervals.push([t0, t1]);
    }
  }
  if (intervals.length === 0) return [];
  // Even-odd sweep across all loops: coverage events sorted by t (ends
  // before starts on exact ties — a touching point is not inside).
  const events: { t: number; delta: number }[] = [];
  for (const [t0, t1] of intervals) {
    events.push({ t: t0, delta: 1 });
    events.push({ t: t1, delta: -1 });
  }
  events.sort((x, y) => (x.t !== y.t ? x.t - y.t : y.delta - x.delta));
  const out: [number, number][] = [];
  let coverage = 0;
  let start = 0;
  for (const e of events) {
    const before = coverage;
    coverage += e.delta;
    if (before % 2 === 0 && coverage % 2 === 1) start = e.t;
    else if (before % 2 === 1 && coverage % 2 === 0) {
      if (e.t - start > EPS) out.push([start, e.t]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern resolution.
// ---------------------------------------------------------------------------

/** The resolved pattern primitives of a hatch (deterministic — see the
 *  module contract). */
export function hatchPrimitives(h: HatchEntity, ctx: HatchRenderContext): readonly HatchPrimitive[] {
  const def = HATCH_PATTERNS[h.pattern];
  const loops = h.boundary.map((ref) => ref.loop);
  if (def.solid) {
    return loops.length > 0 ? [{ kind: "fill", loops }] : [];
  }
  const spacingScale = h.scale * ctx.annotationScale;
  if (def.dots) {
    const family = def.families[0]!;
    const theta = family.angle + h.angle;
    const d: Pt = { x: Math.cos(theta), y: Math.sin(theta) };
    const n: Pt = { x: -d.y, y: d.x };
    const spacing = family.spacing * spacingScale;
    const box = loopsBBox(loops);
    // Lattice range over the bbox (canonical origin (0,0), k along d and
    // m along n; rows = k, then columns = m — deterministic order).
    let minKd = Infinity;
    let maxKd = -Infinity;
    let minMn = Infinity;
    let maxMn = -Infinity;
    for (const p of [ { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY } ]) {
      const kd = p.x * d.x + p.y * d.y;
      const mn = p.x * n.x + p.y * n.y;
      minKd = Math.min(minKd, kd);
      maxKd = Math.max(maxKd, kd);
      minMn = Math.min(minMn, mn);
      maxMn = Math.max(maxMn, mn);
    }
    const dots: HatchPrimitive[] = [];
    const radius = HATCH_DOT_RADIUS_FACTOR * h.scale * ctx.annotationScale;
    const kFrom = Math.ceil(minKd / spacing);
    const kTo = Math.floor(maxKd / spacing);
    const mFrom = Math.ceil(minMn / spacing);
    const mTo = Math.floor(maxMn / spacing);
    for (let k = kFrom; k <= kTo; k++) {
      for (let m = mFrom; m <= mTo; m++) {
        const at: Pt = { x: k * spacing * d.x + m * spacing * n.x, y: k * spacing * d.y + m * spacing * n.y };
        if (pointInRegion(at, loops)) dots.push({ kind: "dot", at, radius });
      }
    }
    return dots;
  }
  // Line families (one or two — ANSI31/32 single, ANSI37/NET crosshatch).
  const segments: HatchPrimitive[] = [];
  const box = loopsBBox(loops);
  for (const family of def.families) {
    const theta = family.angle + h.angle;
    const d: Pt = { x: Math.cos(theta), y: Math.sin(theta) };
    const n: Pt = { x: -d.y, y: d.x };
    const spacing = family.spacing * spacingScale;
    // Offset range over the bbox corners (canonical origin (0,0)).
    let minN = Infinity;
    let maxN = -Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of [ { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY } ]) {
      const pn = p.x * n.x + p.y * n.y;
      const pt = p.x * d.x + p.y * d.y;
      minN = Math.min(minN, pn);
      maxN = Math.max(maxN, pn);
      minT = Math.min(minT, pt);
      maxT = Math.max(maxT, pt);
    }
    const kFrom = Math.ceil(minN / spacing);
    const kTo = Math.floor(maxN / spacing);
    for (let k = kFrom; k <= kTo; k++) {
      const offset = k * spacing;
      const o: Pt = { x: n.x * offset, y: n.y * offset };
      for (const [t0, t1] of lineIntervals(o, d, loops)) {
        // Clip to the bbox parameter range (deterministic bounds; the
        // intervals are already inside the region which is inside the box).
        const lo = Math.max(t0, minT - 1);
        const hi = Math.min(t1, maxT + 1);
        if (hi - lo <= EPS) continue;
        segments.push({
          kind: "segment",
          a: { x: o.x + d.x * lo, y: o.y + d.y * lo },
          b: { x: o.x + d.x * hi, y: o.y + d.y * hi },
        });
      }
    }
  }
  return segments;
}
