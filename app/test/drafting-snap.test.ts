/**
 * COMPAT-CAD-001 — deterministic snapping: kinds, ranking with total-order
 * tie-breaks, tolerance boundaries, hidden-layer exclusion is the caller's
 * filter, exclude list. "At least one snap workflow is automated and
 * deterministic" is an acceptance criterion — this suite IS that automation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Element } from "../src/contracts/caddocument.js";
import { draftEntityToElement, makeArc, makeCircle, makeLine, makeRectangle } from "../src/drafting/entities.js";
import { resolveSnap } from "../src/drafting/snap.js";
import { COINCIDENCE_EPS } from "../src/drafting/precision.js";

const TX = COINCIDENCE_EPS;

function fixture(): readonly Element[] {
  return [
    { ...draftEntityToElement({ ...makeLine({ from: [0, 0], to: [10, 0], layer: "0" }), id: "L1" }) },
    { ...draftEntityToElement({ ...makeLine({ from: [5, -5], to: [5, 5], layer: "0" }), id: "L2" }) },
    { ...draftEntityToElement({ ...makeCircle({ center: [20, 0], radius: 3, layer: "0" }), id: "C1" }) },
    { ...draftEntityToElement({ ...makeArc({ center: [0, 20], radius: 4, startAngle: 0, endAngle: Math.PI / 2, layer: "0" }), id: "A1" }) },
    { ...draftEntityToElement({ ...makeRectangle({ corner1: [30, 0], corner2: [40, 8], layer: "0" }), id: "R1" }) },
  ];
}

test("endpoint snap: nearest endpoint within tolerance, residual reported", () => {
  const r = resolveSnap({
    point: [0.1, 0.1],
    tolerance: 0.5,
    kinds: ["endpoint"],
    entities: fixture(),
  });
  assert.equal(r.snapped, true);
  assert.ok(r.best !== null);
  assert.equal(r.best.kind, "endpoint");
  assert.deepEqual(r.best.point, [0, 0]);
  assert.deepEqual(r.best.targets, ["L1"]);
  assert.ok(r.best.distance > 0 && r.best.distance <= 0.5, "residual always reported");
});

test("endpoint beats on-object at the same distance (kind priority tie-break)", () => {
  // point exactly ON the line near an endpoint: endpoint candidate and
  // on-object candidate have (near-)identical distance; endpoint must rank first.
  const r = resolveSnap({
    point: [0, 0.05],
    tolerance: 0.5,
    kinds: ["endpoint", "on-object"],
    entities: fixture(),
  });
  assert.equal(r.best?.kind, "endpoint");
  assert.deepEqual(r.best?.point, [0, 0]);
});

test("midpoint snap: exact segment midpoint", () => {
  const r = resolveSnap({
    point: [5, 0.05],
    tolerance: 0.5,
    kinds: ["midpoint"],
    entities: fixture(),
  });
  assert.equal(r.snapped, true);
  assert.deepEqual(r.best?.point, [5, 0]);
  assert.deepEqual(r.best?.targets, ["L1"]);
});

test("center snap: circle and arc centers", () => {
  const r = resolveSnap({
    point: [20.1, 0.1],
    tolerance: 0.5,
    kinds: ["center"],
    entities: fixture(),
  });
  assert.deepEqual(r.best?.point, [20, 0]);
  assert.deepEqual(r.best?.targets, ["C1"]);
  const r2 = resolveSnap({ point: [0.1, 20.1], tolerance: 0.5, kinds: ["center"], entities: fixture() });
  assert.deepEqual(r2.best?.targets, ["A1"]);
});

test("quadrant snap: circle quadrants; arc only within the sweep", () => {
  const r = resolveSnap({
    point: [23.1, 0],
    tolerance: 0.5,
    kinds: ["quadrant"],
    entities: fixture(),
  });
  assert.deepEqual(r.best?.point, [23, 0]);
  assert.deepEqual(r.best?.targets, ["C1"]);
  // A1 spans 0..π/2: quadrant 0 (point (4,20)) is within; quadrant π ((−4,20)) is not
  const q0 = resolveSnap({ point: [4, 20.1], tolerance: 0.5, kinds: ["quadrant"], entities: fixture() });
  assert.deepEqual(q0.best?.point, [4, 20]);
  const qPi = resolveSnap({ point: [-4, 20.1], tolerance: 0.5, kinds: ["quadrant"], entities: fixture() });
  assert.equal(qPi.best, null, "quadrant π is outside the arc sweep");
});

test("intersection snap: L1×L2 cross at (5,0); carries both target ids", () => {
  const r = resolveSnap({
    point: [5, 0.1],
    tolerance: 0.5,
    kinds: ["intersection"],
    entities: fixture(),
  });
  assert.equal(r.snapped, true);
  assert.deepEqual(r.best?.point, [5, 0]);
  assert.deepEqual(r.best?.targets, ["L1", "L2"]);
  // rectangle edge × L2? L2 x=5 doesn't reach x=30..40 — no extra pairs.
  assert.equal(r.candidates.length, 1);
});

test("intersection of segment and circle within range", () => {
  const ents = [
    { ...draftEntityToElement({ ...makeLine({ from: [17, 0], to: [23, 0], layer: "0" }), id: "SL" }) },
    { ...draftEntityToElement({ ...makeCircle({ center: [20, 0], radius: 3, layer: "0" }), id: "SC" }) },
  ];
  const r = resolveSnap({ point: [17.1, 0], tolerance: 0.5, kinds: ["intersection"], entities: ents });
  assert.deepEqual(r.best?.point, [17, 0]);
  const r2 = resolveSnap({ point: [23.1, 0], tolerance: 0.5, kinds: ["intersection"], entities: ents });
  assert.deepEqual(r2.best?.point, [23, 0]);
});

test("on-object snap: closest point on a rectangle edge", () => {
  const r = resolveSnap({
    point: [35, 8.2],
    tolerance: 0.5,
    kinds: ["on-object"],
    entities: fixture(),
  });
  assert.deepEqual(r.best?.point, [35, 8]);
});

test("grid snap: rounds to the grid multiple; deterministic", () => {
  const r = resolveSnap({
    point: [2.4, 3.6],
    tolerance: 2,
    kinds: ["grid"],
    entities: [],
    gridSize: 2,
  });
  assert.deepEqual(r.best?.point, [2, 4]);
  const half = resolveSnap({ point: [1, 0], tolerance: 1, kinds: ["grid"], entities: [], gridSize: 2 });
  assert.deepEqual(half.best?.point, [2, 0], "x.5 rounds up (Math.round)");
});

test("ranking determinism: total order under candidate permutation", () => {
  const a = fixture();
  const b = [...a].reverse();
  const q = { point: [5.05, 0.05] as [number, number], tolerance: 2, kinds: ["endpoint", "intersection", "midpoint", "on-object"] as const, entities: a };
  const r1 = resolveSnap(q);
  const r2 = resolveSnap({ ...q, entities: b });
  assert.deepEqual(
    r1.candidates.map((c) => [c.kind, c.point, c.targets]),
    r2.candidates.map((c) => [c.kind, c.point, c.targets]),
    "candidate order must be a total order independent of entity insertion order",
  );
  // At (5.05, 0.05): the two on-object candidates are within ~2e-17 of each
  // other (a genuine floating-point ordering — hypot over the computed
  // closest points); the intersection (5,0) at ~0.0707 ranks after them.
  // Determinism = the SAME winner under identical inputs (the permutation
  // assertion above); we do not pin the ~ulp-level winner here.
  assert.equal(r1.best?.kind, "on-object");
  assert.ok(Math.abs(r1.best.distance - 0.05) <= 1e-12);
  const kinds = r1.candidates.map((c) => c.kind);
  assert.ok(kinds.indexOf("on-object") < kinds.indexOf("intersection"));
});

test("tolerance boundary: candidates strictly outside are excluded", () => {
  const r = resolveSnap({
    point: [0.5 + 1e-6, 0],
    tolerance: 0.5,
    kinds: ["endpoint"],
    entities: fixture(),
  });
  assert.equal(r.best, null, "just outside the tolerance → no snap");
  const rIn = resolveSnap({
    point: [0.5 - 1e-6, 0],
    tolerance: 0.5,
    kinds: ["endpoint"],
    entities: fixture(),
  });
  assert.equal(rIn.best?.kind, "endpoint");
});

test("exclude list removes entities from all candidate kinds", () => {
  const r = resolveSnap({
    point: [5.05, 0.05],
    tolerance: 2,
    kinds: ["endpoint", "intersection", "midpoint", "on-object"],
    entities: fixture(),
    exclude: ["L1", "L2"],
  });
  for (const c of r.candidates) {
    assert.ok(!c.targets.includes("L1") && !c.targets.includes("L2"));
  }
});

test("residuals are always reported with the raw query point", () => {
  const r = resolveSnap({ point: [0.2, 0.1], tolerance: 0.5, kinds: ["endpoint"], entities: fixture() });
  assert.deepEqual(r.query, [0.2, 0.1]);
  assert.ok(r.best !== null);
  const expected = Math.hypot(0.2, 0.1);
  assert.ok(Math.abs(r.best.distance - expected) <= TX);
});
