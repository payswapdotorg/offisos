/**
 * Pure 2D analytic geometry kernel (COMPAT-CAD-001).
 *
 * Deterministic predicates for the drafting core: intersections, distances,
 * projections and parameterizations over the drafting curve set
 * (segments, circles, arcs). All classification uses the DECLARED tolerances
 * from precision.ts — no silent approximation, no engine involvement (LOCK-
 * 018: this module is pure TypeScript and part of the protected core's
 * engine-free drafting layer).
 *
 * Determinism rules:
 *  - intersection lists are returned in ascending curve-parameter order of
 *    the FIRST operand (and, on ties, of the second operand);
 *  - degenerate inputs (zero-length segments, non-positive radii) are
 *    rejected with descriptive errors (LOCK-007);
 *  - all outputs are raw doubles from the analytic construction.
 */

import { COINCIDENCE_EPS, PARAM_EPS, PARALLEL_EPS, Vec2 } from "./precision.js";

// --- Vector primitives -------------------------------------------------------

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}
export function scale(a: Vec2, k: number): Vec2 {
  return [a[0] * k, a[1] * k];
}
export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}
export function cross(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}
export function length(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}
export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
export function pointsCoincide(a: Vec2, b: Vec2): boolean {
  return distance(a, b) <= COINCIDENCE_EPS;
}

// --- Segment parameterization ------------------------------------------------

/** Point at parameter t ∈ [0,1] along a segment. */
export function pointOnSegment(a: Vec2, b: Vec2, t: number): Vec2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Parameter t of the projection of p onto the segment's infinite line. */
export function projectionParam(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom === 0) throw new Error("degenerate segment: a and b coincide");
  return dot(sub(p, a), ab) / denom;
}

/** Closest point on the SEGMENT (clamped) and its parameter. */
export function closestPointOnSegment(a: Vec2, b: Vec2, p: Vec2): { point: Vec2; t: number } {
  const t = projectionParam(a, b, p);
  const clamped = Math.min(1, Math.max(0, t));
  return { point: pointOnSegment(a, b, clamped), t: clamped };
}

/** Distance from p to the segment (clamped). */
export function distanceToSegment(a: Vec2, b: Vec2, p: Vec2): number {
  return distance(closestPointOnSegment(a, b, p).point, p);
}

/** Point at angle θ on a circle. */
export function pointOnCircle(center: Vec2, radius: number, angle: number): Vec2 {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

// --- Intersections -----------------------------------------------------------

export interface Intersection {
  /** The intersection point (raw analytic double coordinates). */
  readonly point: Vec2;
  /** Curve parameter on the first operand (segment t ∈ [0,1] or line t ∈ ℝ
   *  or circle/arc angle θ). */
  readonly t1: number;
  /** Curve parameter on the second operand. */
  readonly t2: number;
}

/** Infinite line through a segment, parameterized as a + t·(b−a), t ∈ ℝ. */
export function intersectLines(
  a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2,
): Intersection | null {
  const d1 = sub(b1, a1);
  const d2 = sub(b2, a2);
  const denom = cross(d1, d2);
  if (Math.abs(denom) <= PARALLEL_EPS * Math.max(1, length(d1) * length(d2))) {
    return null; // parallel or coincident (coincident lines have no single crossing)
  }
  const t1 = cross(sub(a2, a1), d2) / denom;
  const t2 = cross(sub(a2, a1), d1) / denom;
  return { point: pointOnSegment(a1, b1, t1), t1, t2 };
}

/** Segment ∩ segment: the single proper crossing when it exists within both
 *  parameter ranges (endpoints inclusive within PARAM_EPS). Collinear
 *  overlaps return null (the drafting ops treat them as "no cutting point";
 *  this is the declared rule — no silent best-effort splitting). */
export function intersectSegments(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): Intersection | null {
  const line = intersectLines(a1, b1, a2, b2);
  if (line === null) return null;
  const within = (t: number) => t >= -PARAM_EPS && t <= 1 + PARAM_EPS;
  if (!within(line.t1) || !within(line.t2)) return null;
  return line;
}

/** Infinite line (a + t·(b−a), t ∈ ℝ) ∩ circle. 0/1/2 points, ascending t. */
export function intersectLineCircle(a: Vec2, b: Vec2, center: Vec2, radius: number): Intersection[] {
  if (!(radius > 0)) throw new Error("circle radius must be positive");
  const d = sub(b, a);
  const f = sub(a, center);
  const A = dot(d, d);
  if (A === 0) throw new Error("degenerate line: a and b coincide");
  const B = 2 * dot(f, d);
  const C = dot(f, f) - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  if (disc === 0) {
    const t = -B / (2 * A);
    return [{ point: pointOnSegment(a, b, t), t1: t, t2: angleOf(center, pointOnSegment(a, b, t)) }];
  }
  const root = Math.sqrt(disc);
  const tLow = (-B - root) / (2 * A);
  const tHigh = (-B + root) / (2 * A);
  const ordered = tLow <= tHigh ? [tLow, tHigh] : [tHigh, tLow];
  return ordered.map((t) => {
    const point = pointOnSegment(a, b, t);
    return { point, t1: t, t2: angleOf(center, point) };
  });
}

/** Segment ∩ circle: intersections with t ∈ [0,1], ascending t. */
export function intersectSegmentCircle(a: Vec2, b: Vec2, center: Vec2, radius: number): Intersection[] {
  return intersectLineCircle(a, b, center, radius).filter((i) => i.t1 >= -PARAM_EPS && i.t1 <= 1 + PARAM_EPS);
}

/** Circle ∩ circle: 0/1/2 points. Ascending angle on the FIRST circle. */
export function intersectCircles(c1: Vec2, r1: number, c2: Vec2, r2: number): Intersection[] {
  if (!(r1 > 0) || !(r2 > 0)) throw new Error("circle radii must be positive");
  const d = distance(c1, c2);
  if (d === 0) return []; // concentric: no crossing points
  if (d > r1 + r2 + COINCIDENCE_EPS) return []; // separate
  if (d < Math.abs(r1 - r2) - COINCIDENCE_EPS) return []; // contained
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  if (hSq <= 0) {
    // Tangent (external or internal): single point on the center line.
    const t = a / d;
    const point: Vec2 = [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t];
    return [{ point, t1: angleOf(c1, point), t2: angleOf(c2, point) }];
  }
  const h = Math.sqrt(hSq);
  const mx = c1[0] + (a / d) * (c2[0] - c1[0]);
  const my = c1[1] + (a / d) * (c2[1] - c1[1]);
  const ux = (c2[1] - c1[1]) / d; // unit perpendicular
  const uy = -(c2[0] - c1[0]) / d;
  const pA: Vec2 = [mx + h * ux, my + h * uy];
  const pB: Vec2 = [mx - h * ux, my - h * uy];
  const iA: Intersection = { point: pA, t1: angleOf(c1, pA), t2: angleOf(c2, pA) };
  const iB: Intersection = { point: pB, t1: angleOf(c1, pB), t2: angleOf(c2, pB) };
  return iA.t1 <= iB.t1 ? [iA, iB] : [iB, iA];
}

/** Angle of a point around a center (normalized [0, 2π)). */
export function angleOf(center: Vec2, p: Vec2): number {
  const a = Math.atan2(p[1] - center[1], p[0] - center[0]);
  const TWO_PI = 2 * Math.PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Distance from a point to a circle's rim (|dist − r|). */
export function distanceToCircle(center: Vec2, radius: number, p: Vec2): number {
  return Math.abs(distance(center, p) - radius);
}

/** Closest point on a circle's rim to p. */
export function closestPointOnCircle(center: Vec2, radius: number, p: Vec2): Vec2 {
  if (pointsCoincide(center, p)) return pointOnCircle(center, radius, 0); // declared: +X point
  return pointOnCircle(center, radius, angleOf(center, p));
}

/** Distance from a point to an arc (CCW start→end around center). */
export function distanceToArc(center: Vec2, radius: number, startAngle: number, sweep: number, p: Vec2): number {
  const theta = angleOf(center, p);
  const withinSweep = theta >= startAngle - PARAM_EPS && theta <= startAngle + sweep + PARAM_EPS;
  if (withinSweep) return distanceToCircle(center, radius, p);
  const startPt = pointOnCircle(center, radius, startAngle);
  const endPt = pointOnCircle(center, radius, startAngle + sweep);
  return Math.min(distance(startPt, p), distance(endPt, p));
}

/** Closest point on an arc to p (rim point when within the sweep, else the
 *  nearer endpoint — deterministic tie: the start endpoint). */
export function closestPointOnArc(
  center: Vec2, radius: number, startAngle: number, sweep: number, p: Vec2,
): Vec2 {
  const theta = angleOf(center, p);
  const withinSweep = theta >= startAngle - PARAM_EPS && theta <= startAngle + sweep + PARAM_EPS;
  if (withinSweep) return closestPointOnCircle(center, radius, p);
  const startPt = pointOnCircle(center, radius, startAngle);
  const endPt = pointOnCircle(center, radius, startAngle + sweep);
  return distance(startPt, p) <= distance(endPt, p) ? startPt : endPt;
}

/** Midpoint of a segment. */
export function segmentMidpoint(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Arc midpoint (at half the CCW sweep). */
export function arcMidpoint(center: Vec2, radius: number, startAngle: number, sweep: number): Vec2 {
  return pointOnCircle(center, radius, startAngle + sweep / 2);
}
