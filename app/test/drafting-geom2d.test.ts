/**
 * COMPAT-CAD-001 — analytic geometry kernel: deterministic predicates with
 * exact assertions where inputs are exactly representable, and declared
 * tolerances elsewhere (Issue #37 precision scope).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as g from "../src/drafting/geom2d.js";
import { COINCIDENCE_EPS, PARAM_EPS, angleWithinArc, ccwSweep, normalizeAngle } from "../src/drafting/precision.js";

const T = 0; // exact for representable cases
const TX = COINCIDENCE_EPS;

test("line-line intersection is exact for rational-representable inputs", () => {
  const ix = g.intersectLines([0, 0], [10, 10], [0, 10], [10, 0]);
  assert.ok(ix !== null);
  assert.equal(ix.point[0], 5);
  assert.equal(ix.point[1], 5);
  assert.equal(ix.t1, 0.5);
  // parallel lines never cross
  assert.equal(g.intersectLines([0, 0], [10, 0], [0, 1], [10, 1]), null);
  // coincident lines are classified as no-single-crossing (declared rule)
  assert.equal(g.intersectLines([0, 0], [10, 0], [5, 0], [7, 0]), null);
});

test("segment-segment: endpoints inclusive, out-of-range rejected", () => {
  const ix = g.intersectSegments([0, 0], [10, 10], [0, 10], [10, 0]);
  assert.ok(ix !== null);
  assert.equal(ix.point[0], 5);
  assert.equal(ix.point[1], 5);
  assert.equal(g.intersectSegments([0, 0], [1, 0], [5, 0], [6, 0]), null, "collinear overlap: no crossing point");
  assert.equal(g.intersectSegments([0, 0], [1, 1], [2, 0], [3, 1]), null, "disjoint");
  const atEnd = g.intersectSegments([0, 0], [2, 2], [2, 2], [4, 0]);
  assert.ok(atEnd !== null, "shared endpoint is an intersection");
  assert.equal(atEnd.point[0], 2);
});

test("line-circle intersection: 3-4-5 geometry exact; ordering ascending in t", () => {
  // line y=4 through the circle r=5 at origin → x=±3
  const ixs = g.intersectLineCircle([0, 4], [10, 4], [0, 0], 5);
  assert.equal(ixs.length, 2);
  assert.equal(ixs[0]?.point[0], -3);
  assert.equal(ixs[1]?.point[0], 3);
  assert.ok(ixs[0] !== undefined && ixs[1] !== undefined && ixs[0].t1 < ixs[1].t1, "ascending t");
  // tangent line y=5 → single point
  const tan = g.intersectLineCircle([0, 5], [10, 5], [0, 0], 5);
  assert.equal(tan.length, 1);
  assert.equal(tan[0]?.point[0], 0);
  assert.equal(tan[0]?.point[1], 5);
  // miss y=6 → none
  assert.equal(g.intersectLineCircle([0, 6], [10, 6], [0, 0], 5).length, 0);
  // segment range filter
  const segIxs = g.intersectSegmentCircle([0, 4], [10, 4], [0, 0], 5);
  assert.equal(segIxs.length, 1, "only x=3 lies within the [0,10] segment");
  assert.equal(segIxs[0]?.point[0], 3);
});

test("circle-circle: crossing, tangent and disjoint cases deterministic", () => {
  // r=3 at (0,0) and r=4 at (5,0): |d|=5, crossings at x=0, y=±... a=(9-16+25)/10=1.8, h=2.4
  const ix = g.intersectCircles([0, 0], 3, [5, 0], 4);
  assert.equal(ix.length, 2);
  assert.ok(Math.abs(ix[0]!.point[0] - 1.8) <= TX, `x ${ix[0]!.point[0]}`);
  assert.ok(Math.abs(ix[0]!.point[1] - 2.4) <= TX, `y ${ix[0]!.point[1]}`);
  assert.ok(Math.abs(ix[1]!.point[1] + 2.4) <= TX);
  // external tangent: d = r1 + r2 → single point on the center line
  const tan = g.intersectCircles([0, 0], 2, [5, 0], 3);
  assert.equal(tan.length, 1);
  assert.equal(tan[0]?.point[0], 2);
  // separate
  assert.equal(g.intersectCircles([0, 0], 1, [10, 0], 1).length, 0);
  // contained
  assert.equal(g.intersectCircles([0, 0], 5, [1, 0], 1).length, 0);
  // concentric
  assert.equal(g.intersectCircles([0, 0], 2, [0, 0], 3).length, 0);
});

test("distances and closest points", () => {
  assert.equal(g.distance([0, 0], [3, 4]), 5);
  const cp = g.closestPointOnSegment([0, 0], [10, 0], [3, 5]);
  assert.equal(cp.point[0], 3);
  assert.equal(cp.point[1], 0);
  assert.equal(cp.t, 0.3);
  // clamping to the nearer endpoint
  const clamped = g.closestPointOnSegment([0, 0], [10, 0], [-4, 1]);
  assert.deepEqual(clamped.point, [0, 0]);
  assert.equal(clamped.t, 0);
  assert.equal(g.distanceToSegment([0, 0], [10, 0], [13, 4]), 5);
  assert.equal(g.distanceToCircle([0, 0], 5, [8, 0]), 3);
  assert.deepEqual(g.closestPointOnCircle([0, 0], 5, [10, 0]), [5, 0]);
  // the center itself: declared fallback +X point
  assert.deepEqual(g.closestPointOnCircle([0, 0], 5, [0, 0]), [5, 0]);
});

test("arc distances respect the CCW sweep", () => {
  // arc from 0 to π/2 (first quadrant)
  const dist = g.distanceToArc([0, 0], 5, 0, Math.PI / 2, [8, 1]);
  // the closest rim point within the sweep is (5·cos θ, 5·sin θ) with tan θ = 1/8
  const expected = Math.hypot(8, 1) - 5;
  assert.ok(Math.abs(dist - expected) <= TX, `dist ${dist} vs ${expected}`);
  // outside the sweep (third quadrant point) → nearer endpoint (0,5)... use (−8,−1): both endpoints equidistant-ish
  const d2 = g.distanceToArc([0, 0], 5, 0, Math.PI / 2, [-8, -1]);
  const expected2 = Math.min(g.distance([5, 0], [-8, -1]), g.distance([0, 5], [-8, -1]));
  assert.ok(Math.abs(d2 - expected2) <= TX, `d2 ${d2} vs ${expected2}`);
});

test("angle helpers: normalization and sweep containment", () => {
  assert.equal(normalizeAngle(-Math.PI / 2), (3 * Math.PI) / 2);
  assert.equal(normalizeAngle(Math.PI * 2.5), Math.PI / 2);
  assert.ok(Math.abs(ccwSweep((3 * Math.PI) / 2, Math.PI / 2) - Math.PI) <= PARAM_EPS);
  // wrap-around arc 3π/2 → π/2 covers quadrant 4 + quadrant 1: contains 0, NOT π
  assert.ok(angleWithinArc(0, (3 * Math.PI) / 2, Math.PI), "wrap-around containment");
  assert.ok(!angleWithinArc(Math.PI, (3 * Math.PI) / 2, Math.PI), "π is in quadrant 2 — outside");
  assert.ok(!angleWithinArc(Math.PI / 2 + 0.01, (3 * Math.PI) / 2, Math.PI / 2), "outside the sweep");
  assert.ok(angleWithinArc((3 * Math.PI) / 2, (3 * Math.PI) / 2, Math.PI / 2), "start endpoint inclusive");
});

test("midpoints", () => {
  assert.deepEqual(g.segmentMidpoint([0, 0], [10, 4]), [5, 2]);
  const mid = g.arcMidpoint([0, 0], 5, 0, Math.PI / 2);
  assert.ok(Math.abs(mid[0] - 5 * Math.cos(Math.PI / 4)) <= TX);
  assert.ok(Math.abs(mid[1] - 5 * Math.sin(Math.PI / 4)) <= TX);
});
