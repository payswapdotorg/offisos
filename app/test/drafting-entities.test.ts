/**
 * COMPAT-CAD-001 — drafting entity model: construction validation, canonical
 * element ⇄ entity round-trips, translation semantics, bboxes.
 *
 * Every numerical assertion carries its declared tolerance (Issue #37:
 * "deterministic coordinate/precision behavior with declared tolerances").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COINCIDENCE_EPS,
  DRAFTING_TOLERANCES,
  ccwSweep,
  normalizeAngle,
} from "../src/drafting/precision.js";
import {
  dimensionLinePoints,
  draftEntityToElement,
  elementToDraftEntity,
  entityBBox,
  entityCurves,
  isDraftingElement,
  linearMeasured,
  makeArc,
  makeCircle,
  makeLine,
  makeLinearDimension,
  makePolyline,
  makeRadiusDimension,
  makeRectangle,
  translatePatch,
} from "../src/drafting/entities.js";

const T = 1e-12; // exact-representable constructions must match EXACTLY
const TX = COINCIDENCE_EPS; // declared tolerance for analytic constructions

test("declared tolerance table is published and stable", () => {
  assert.equal(DRAFTING_TOLERANCES.coincidence, 1e-9);
  assert.equal(DRAFTING_TOLERANCES.parallel, 1e-12);
  assert.equal(DRAFTING_TOLERANCES.param, 1e-12);
});

test("line construction accepts valid input and rejects degenerates", () => {
  const line = makeLine({ from: [0, 0], to: [10, 0], layer: "0" });
  assert.equal(line.type, "line");
  assert.deepEqual(line.from, [0, 0]);
  assert.deepEqual(line.to, [10, 0]);
  assert.throws(() => makeLine({ from: [1, 1], to: [1, 1], layer: "0" }), /coincide/);
  assert.throws(() => makeLine({ from: [0, 0], to: [1e-10, 0], layer: "0" }), /coincide/);
  assert.throws(() => makeLine({ from: [0, 0], to: [1, 0] }), /layer/);
  assert.throws(() => makeLine({ from: [0, Number.NaN], to: [1, 0], layer: "0" }), /finite/);
});

test("polyline validation: ≥2 points, no coincident neighbors, closed needs ≥3", () => {
  const pl = makePolyline({ points: [[0, 0], [10, 0], [10, 10]], layer: "0" });
  assert.equal(pl.closed, false);
  assert.throws(() => makePolyline({ points: [[0, 0]], layer: "0" }), /at least 2/);
  assert.throws(() => makePolyline({ points: [[0, 0], [5, 5], [5, 5]], layer: "0" }), /coincide/);
  assert.throws(() => makePolyline({ points: [[0, 0], [10, 0]], closed: true, layer: "0" }), /closed/);
  const closed = makePolyline({ points: [[0, 0], [10, 0], [10, 10]], closed: true, layer: "0" });
  assert.equal(closed.closed, true);
  // closed polyline contributes a closing segment
  assert.equal(entityCurves({ ...closed, id: "p1" }).length, 3);
});

test("circle/arc validation and canonical angle normalization", () => {
  assert.throws(() => makeCircle({ center: [0, 0], radius: 0, layer: "0" }), /positive/);
  assert.throws(() => makeCircle({ center: [0, 0], radius: -1, layer: "0" }), /positive/);
  // negative angles normalize to [0, 2π)
  const arc = makeArc({ center: [0, 0], radius: 5, startAngle: -Math.PI / 2, endAngle: 0, layer: "0" });
  assert.equal(arc.startAngle, normalizeAngle(-Math.PI / 2));
  assert.ok(Math.abs(arc.startAngle - (3 * Math.PI) / 2) <= T);
  assert.equal(arc.endAngle, 0);
  // full sweep is rejected (that is the circle entity)
  assert.throws(() => makeArc({ center: [0, 0], radius: 5, startAngle: 0.5, endAngle: 0.5, layer: "0" }), /sweep/);
  assert.throws(
    () => makeArc({ center: [0, 0], radius: 5, startAngle: 0, endAngle: 2 * Math.PI, layer: "0" }),
    /sweep/,
  );
  assert.equal(ccwSweep(0.5, 0.25), 2 * Math.PI - 0.25, toleranceMessage(2 * Math.PI - 0.25));
});

function toleranceMessage(expected: number): string {
  return `expected ${expected}`;
}

test("rectangle validation: axis-aligned non-degenerate area", () => {
  const r = makeRectangle({ corner1: [0, 0], corner2: [10, 5], layer: "0" });
  assert.deepEqual(r.corner1, [0, 0]);
  assert.throws(() => makeRectangle({ corner1: [0, 0], corner2: [10, 0], layer: "0" }), /degenerate/);
  assert.throws(() => makeRectangle({ corner1: [3, 3], corner2: [3, 8], layer: "0" }), /degenerate/);
});

test("linear dimension: measured values are exact for representable inputs", () => {
  // 3-4-5 triangle: aligned distance is exactly 5
  const d = makeLinearDimension({ p1: [0, 0], p2: [3, 4], mode: "aligned", layer: "0" });
  assert.equal(d.measured, 5);
  const h = makeLinearDimension({ p1: [0, 0], p2: [3, 4], mode: "horizontal", layer: "0" });
  assert.equal(h.measured, 3);
  const v = makeLinearDimension({ p1: [0, 0], p2: [3, 4], mode: "vertical", layer: "0" });
  assert.equal(v.measured, 4);
  assert.equal(linearMeasured([0, 0], [3, 4], "aligned"), 5);
  // zero measured extent in a mode is rejected
  assert.throws(() => makeLinearDimension({ p1: [0, 0], p2: [0, 4], mode: "horizontal", layer: "0" }), /zero/);
});

test("linear dimension offset line: unit normal × signed offset", () => {
  const d = makeLinearDimension({ p1: [0, 0], p2: [10, 0], mode: "aligned", offset: 2, layer: "0" });
  const [p1o, p2o] = dimensionLinePoints({ ...d, id: "d1" });
  // normal of (10,0) is (0,1) → offset +2 moves up
  assert.deepEqual(p1o, [0, 2]);
  assert.deepEqual(p2o, [10, 2]);
  const dn = makeLinearDimension({ p1: [0, 0], p2: [10, 0], mode: "aligned", offset: -2, layer: "0" });
  const [q1, q2] = dimensionLinePoints({ ...dn, id: "d2" });
  assert.deepEqual(q1, [0, -2]);
  assert.deepEqual(q2, [10, -2]);
});

test("radius dimension requires a target and positive measured", () => {
  assert.throws(() => makeRadiusDimension({ target: "", measured: 5, layer: "0" }), /target/);
  assert.throws(() => makeRadiusDimension({ target: "c1", measured: 0, layer: "0" }), /positive/);
  const rd = makeRadiusDimension({ target: "c1", measured: 7.5, layer: "0" });
  assert.equal(rd.measured, 7.5);
});

test("element ⇄ entity round-trip preserves the canonical props layout", () => {
  const entities = [
    makeLine({ from: [0, 0], to: [10, 0], layer: "0" }),
    makePolyline({ points: [[0, 0], [5, 5], [10, 0]], closed: true, layer: "0" }),
    makeCircle({ center: [1, 2], radius: 3, layer: "0" }),
    makeArc({ center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI / 2, layer: "0" }),
    makeRectangle({ corner1: [0, 0], corner2: [8, 4], layer: "0" }),
    makeLinearDimension({ p1: [0, 0], p2: [8, 0], mode: "aligned", offset: 1, layer: "0" }),
    makeRadiusDimension({ target: "el-000003", measured: 3, layer: "0" }),
  ];
  for (const e of entities) {
    const el = draftEntityToElement({ ...e, id: "x1" });
    assert.equal(el.id, "x1");
    assert.equal(el.engineId, null, "drafting entities are engine-free");
    const back = elementToDraftEntity(el);
    assert.equal(back.type, e.type);
    assert.deepEqual(back, { ...e, id: "x1" });
    if (e.type === "dim-linear" || e.type === "dim-radius") {
      assert.equal(el.kind, "annotation");
    } else {
      assert.equal(el.kind, "geometry");
    }
  }
  // empty id → the element asks the document to mint
  const minted = draftEntityToElement({ ...(entities[0] as ReturnType<typeof makeLine>), id: "" });
  assert.equal(minted.id, "");
  assert.ok(isDraftingElement(minted));
});

test("elementToDraftEntity re-validates stored props (LOCK-007: stored data is not trusted)", () => {
  const bad = {
    id: "b1",
    kind: "geometry" as const,
    engineId: null,
    props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [0, 0] },
  };
  assert.throws(() => elementToDraftEntity(bad), /coincide/);
  const notDrafting = { id: "b2", kind: "geometry" as const, engineId: null, props: { meshToken: "m" } };
  assert.throws(() => elementToDraftEntity(notDrafting), /not a drafting entity/);
});

test("translation patches move every coordinate field; measured is invariant", () => {
  const line = { ...makeLine({ from: [1, 1], to: [4, 5], layer: "0" }), id: "e1" };
  const patch = translatePatch(line, 10, -2);
  assert.ok(patch !== null);
  assert.deepEqual(patch.from, [11, -1]);
  assert.deepEqual(patch.to, [14, 3]);
  const dim = { ...makeLinearDimension({ p1: [0, 0], p2: [3, 4], mode: "aligned", layer: "0" }), id: "e2" };
  const dpatch = translatePatch(dim, 100, 100);
  assert.ok(dpatch !== null);
  assert.deepEqual(dpatch.p1, [100, 100]);
  assert.deepEqual(dpatch.p2, [103, 104]);
  // the measured value survives translation (translation-invariant distance)
  const moved = makeLinearDimension({ p1: [100, 100], p2: [103, 104], mode: "aligned", layer: "0" });
  assert.equal(moved.measured, dim.measured);
  const rd = { ...makeRadiusDimension({ target: "e1", measured: 5, layer: "0" }), id: "e3" };
  assert.equal(translatePatch(rd, 1, 1), null, "radius dims have no own geometry");
  assert.equal(translatePatch(line, 0, 0), null, "zero translation is a no-op");
});

test("entity bboxes: exact for axis-aligned constructions", () => {
  const line = { ...makeLine({ from: [-2, 3], to: [5, -1], layer: "0" }), id: "e" };
  assert.deepEqual(entityBBox(line), [[-2, -1], [5, 3]]);
  const circ = { ...makeCircle({ center: [1, 1], radius: 2, layer: "0" }), id: "e" };
  assert.deepEqual(entityBBox(circ), [[-1, -1], [3, 3]]);
  const rect = { ...makeRectangle({ corner1: [-3, -2], corner2: [4, 6], layer: "0" }), id: "e" };
  assert.deepEqual(entityBBox(rect), [[-3, -2], [4, 6]]);
  // quarter arc 0..π/2 r=5 at origin: includes both endpoints and the π/2 axis point
  const arc = { ...makeArc({ center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI / 2, layer: "0" }), id: "e" };
  const [[minX, minY], [maxX, maxY]] = entityBBox(arc);
  assert.ok(Math.abs(minX - 0) <= TX, `minX ${minX}`);
  assert.ok(Math.abs(minY - 0) <= TX, `minY ${minY}`);
  assert.ok(Math.abs(maxX - 5) <= TX, `maxX ${maxX}`);
  assert.ok(Math.abs(maxY - 5) <= TX, `maxY ${maxY}`);
});

test("entityCurves: line 1 segment, rectangle 4 segments, dims none", () => {
  const line = { ...makeLine({ from: [0, 0], to: [1, 1], layer: "0" }), id: "L" };
  assert.equal(entityCurves(line).length, 1);
  const rect = { ...makeRectangle({ corner1: [0, 0], corner2: [5, 5], layer: "0" }), id: "R" };
  const rectCurves = entityCurves(rect);
  assert.equal(rectCurves.length, 4);
  assert.ok(rectCurves.every((c) => c.kind === "segment"));
  const dim = { ...makeLinearDimension({ p1: [0, 0], p2: [5, 0], mode: "aligned", layer: "0" }), id: "D" };
  assert.equal(entityCurves(dim).length, 0, "annotations contribute no cutting geometry");
});
