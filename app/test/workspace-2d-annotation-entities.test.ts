/**
 * CAD-PARITY-005 deterministic annotation entity tests (Issue #82) — the
 * canonical annotation vocabulary: constructors with strict typed
 * validation, exact measurement math (linear modes incl. rotated, angular
 * sectors, auto-mode rule), the element loader for BOTH storage
 * conventions (canonical flat + legacy COMPAT-CAD-001 dims), and the
 * props writer's canonical-minimal records.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANNOTATION_TYPES,
  AnnotationError,
  angularSectorForPlacement,
  annotationToProps,
  autoLinearMode,
  ccwSweep,
  elementToAnnotation,
  isAnnotationElement,
  linearDimDirection,
  linearMeasured,
  linearOffsetForPlacement,
  makeDimAngular,
  makeDimDiameter,
  makeDimLinear,
  makeDimRadius,
  makeLeader,
  makeMLeader,
  makeMText,
  makeText,
} from "../src/workspace/annotation/types.js";
import type { Element } from "../src/contracts/caddocument.js";

const TOL = 1e-9;
const TAU = Math.PI * 2;

function annoElement(props: Record<string, unknown>): Element {
  return { id: "el-000001", kind: "annotation", engineId: null, props };
}

// ---------------------------------------------------------------------------
// Constructors: happy paths with exact stored values.
// ---------------------------------------------------------------------------

test("text: stores placement, height, rotation, style + justification", () => {
  const t = makeText({ layer: "0", x: 10, y: 20, height: 3.5, rotation: 0.5, value: "Hello", style: "Notes", hAlign: "center", vAlign: "middle" });
  assert.equal(t.type, "text");
  assert.equal(t.x, 10);
  assert.equal(t.height, 3.5);
  assert.equal(t.value, "Hello");
  assert.equal(t.style, "Notes");
  assert.equal(t.hAlign, "center");
  assert.equal(t.vAlign, "middle");
});

test("text: defaults are left/baseline justification and no style", () => {
  const t = makeText({ layer: "0", x: 0, y: 0, height: 2.5, rotation: 0, value: "x" });
  assert.equal(t.hAlign, "left");
  assert.equal(t.vAlign, "baseline");
  assert.equal(t.style, undefined);
});

test("text: empty value / zero height / bad justification are typed failures", () => {
  assert.throws(() => makeText({ layer: "0", x: 0, y: 0, height: 2.5, rotation: 0, value: "" }), AnnotationError);
  assert.throws(() => makeText({ layer: "0", x: 0, y: 0, height: 0, rotation: 0, value: "x" }), AnnotationError);
  assert.throws(() => makeText({ layer: "0", x: 0, y: 0, height: 2.5, rotation: 0, value: "x", hAlign: "middle" as unknown as "left" }), AnnotationError);
  assert.throws(() => makeText({ layer: "0", x: 0, y: 0, height: 2.5, rotation: 0, value: "x", vAlign: "center" as unknown as "baseline" }), AnnotationError);
});

test("mtext: height + width + attachment; bad attachment is a typed failure", () => {
  const m = makeMText({ layer: "0", x: 1, y: 2, height: 2.5, width: 40, rotation: 0, value: "a\nb", attachment: "middle-center" });
  assert.equal(m.height, 2.5);
  assert.equal(m.width, 40);
  assert.equal(m.value, "a\nb");
  assert.equal(m.attachment, "middle-center");
  assert.throws(() => makeMText({ layer: "0", x: 1, y: 2, height: 2.5, width: 40, rotation: 0, value: "a", attachment: "center" as never }), AnnotationError);
  assert.throws(() => makeMText({ layer: "0", x: 1, y: 2, height: 0, width: 40, rotation: 0, value: "a" }), AnnotationError);
});

// ---------------------------------------------------------------------------
// Linear measurement math (exact).
// ---------------------------------------------------------------------------

test("linearMeasured: aligned = distance, horizontal = |dx|, vertical = |dy|", () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 30, y: 40 };
  assert.equal(linearMeasured(p1, p2, "aligned"), 50);
  assert.equal(linearMeasured(p1, p2, "horizontal"), 30);
  assert.equal(linearMeasured(p1, p2, "vertical"), 40);
});

test("linearMeasured: rotated = |projection onto the direction|", () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 10, y: 20 };
  // 30° direction: cos = √3/2, sin = 0.5
  const angle = Math.PI / 6;
  const expected = Math.abs(10 * Math.cos(angle) + 20 * Math.sin(angle));
  assert.ok(Math.abs(linearMeasured(p1, p2, "rotated", angle) - expected) < TOL);
  // 90° rotation of a horizontal segment → zero projection (rejected later)
  assert.ok(Math.abs(linearMeasured({ x: 0, y: 0 }, { x: 10, y: 0 }, "rotated", Math.PI / 2)) < TOL);
});

test("linearDimDirection: derived modes + rotated", () => {
  assert.deepEqual(linearDimDirection({ x: 0, y: 0 }, { x: 0, y: 1 }, "horizontal"), { x: 1, y: 0 });
  assert.deepEqual(linearDimDirection({ x: 0, y: 0 }, { x: 1, y: 0 }, "vertical"), { x: 0, y: 1 });
  const d = linearDimDirection({ x: 0, y: 0 }, { x: 30, y: 40 }, "aligned");
  assert.ok(Math.abs(d.x - 0.6) < TOL && Math.abs(d.y - 0.8) < TOL);
  const r = linearDimDirection({ x: 0, y: 0 }, { x: 1, y: 0 }, "rotated", Math.PI / 4);
  assert.ok(Math.abs(r.x - Math.SQRT1_2) < TOL && Math.abs(r.y - Math.SQRT1_2) < TOL);
});

test("linearOffsetForPlacement: signed offset along the left normal", () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 100, y: 0 };
  // aligned: left normal of +X is +Y
  assert.equal(linearOffsetForPlacement(p1, p2, "aligned", undefined, { x: 50, y: 30 }), 30);
  assert.equal(linearOffsetForPlacement(p1, p2, "aligned", undefined, { x: 50, y: -30 }), -30);
  // horizontal mode has the same normal here
  assert.equal(linearOffsetForPlacement(p1, p2, "horizontal", undefined, { x: 50, y: 20 }), 20);
});

test("autoLinearMode: placement above/below → horizontal; left/right → vertical", () => {
  assert.equal(autoLinearMode({ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 80 }), "horizontal");
  assert.equal(autoLinearMode({ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 150, y: 25 }), "vertical");
});

test("dim-linear: rotated requires angle; zero projected extent is a typed failure; measured recomputed (client value must match)", () => {
  const d = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 30, y: 40 }, mode: "aligned", offset: 10 });
  assert.equal(d.measured, 50);
  assert.equal(d.offset, 10);
  assert.throws(() => makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, mode: "rotated" }), AnnotationError);
  assert.throws(() => makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, mode: "vertical" }), AnnotationError);
  assert.throws(() => makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 30, y: 0 }, mode: "horizontal", measured: 999 }), AnnotationError);
  assert.throws(() => makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, mode: "aligned" }), AnnotationError);
});

test("dim-radius / dim-diameter: measured must equal the radius / twice it", () => {
  const r = makeDimRadius({ layer: "0", target: "el-1", center: { x: 5, y: 5 }, radius: 25, measured: 25, at: { x: 50, y: 50 } });
  assert.equal(r.measured, 25);
  assert.equal(r.target, "el-1");
  assert.deepEqual(r.at, { x: 50, y: 50 });
  assert.throws(() => makeDimRadius({ layer: "0", target: "el-1", center: { x: 5, y: 5 }, radius: 25, measured: 24 }), AnnotationError);
  const d = makeDimDiameter({ layer: "0", target: "el-1", center: { x: 0, y: 0 }, radius: 25, angle: 0.7, measured: 50 });
  assert.equal(d.measured, 50);
  assert.throws(() => makeDimDiameter({ layer: "0", target: "el-1", center: { x: 0, y: 0 }, radius: 25, angle: 0, measured: 25 }), AnnotationError);
});

// ---------------------------------------------------------------------------
// Angular math (exact).
// ---------------------------------------------------------------------------

test("ccwSweep: wraps negative differences into (0, 2π)", () => {
  assert.equal(ccwSweep(0, Math.PI / 2), Math.PI / 2);
  assert.ok(Math.abs(ccwSweep(Math.PI / 2, 0) - (3 * Math.PI) / 2) < TOL);
  assert.ok(Math.abs(ccwSweep(-Math.PI / 4, Math.PI / 4) - Math.PI / 2) < TOL);
});

test("angularSectorForPlacement: the placement selects the CCW sector containing it", () => {
  const vertex = { x: 0, y: 0 };
  // leg1 → +X (0), leg2 → +Y (π/2)
  const sectorA = angularSectorForPlacement(vertex, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 });
  assert.equal(sectorA[0], 0);
  assert.ok(Math.abs(sectorA[1] - Math.PI / 2) < TOL);
  // placement in the OTHER sector → start/end swap (the reflex angle)
  const sectorB = angularSectorForPlacement(vertex, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: -1 });
  assert.ok(Math.abs(sectorB[0] - Math.PI / 2) < TOL);
  assert.ok(Math.abs(sectorB[1] - TAU) < TOL);
});

test("dim-angular: measured = CCW sweep; zero/full sweeps are typed failures", () => {
  const a = makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0, endAngle: Math.PI / 3, radius: 20 });
  assert.ok(Math.abs(a.measured - Math.PI / 3) < TOL);
  assert.equal(a.radius, 20);
  assert.throws(() => makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0.5, endAngle: 0.5, radius: 20 }), AnnotationError);
  assert.throws(() => makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0, endAngle: TAU, radius: 20 }), AnnotationError);
  assert.throws(() => makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0, endAngle: Math.PI / 2, radius: 20, measured: 1 }), AnnotationError);
});

// ---------------------------------------------------------------------------
// Leaders / multileaders.
// ---------------------------------------------------------------------------

test("leader: ≥2 distinct points; optional value; optional height", () => {
  const l = makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 30, y: 10 }], value: "note", height: 3 });
  assert.equal(l.points.length, 3);
  assert.equal(l.value, "note");
  assert.equal(l.height, 3);
  assert.equal(makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }).value, undefined);
  assert.throws(() => makeLeader({ layer: "0", points: [{ x: 0, y: 0 }] }), AnnotationError);
  assert.throws(() => makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }), AnnotationError);
});

test("mleader: arrow + landing must differ; value required", () => {
  const m = makeMLeader({ layer: "0", arrow: { x: 0, y: 0 }, landing: { x: 20, y: 10 }, value: "detail" });
  assert.equal(m.value, "detail");
  assert.throws(() => makeMLeader({ layer: "0", arrow: { x: 0, y: 0 }, landing: { x: 0, y: 0 }, value: "x" }), AnnotationError);
  assert.throws(() => makeMLeader({ layer: "0", arrow: { x: 0, y: 0 }, landing: { x: 1, y: 1 } }), AnnotationError);
});

// ---------------------------------------------------------------------------
// Props writer: canonical-minimal records.
// ---------------------------------------------------------------------------

test("annotationToProps: canonical-minimal (default optionals drop out)", () => {
  const t = makeText({ layer: "0", x: 1, y: 2, height: 2.5, rotation: 0, value: "x" });
  const props = annotationToProps(t);
  assert.equal(props.annotation, true);
  assert.equal(props.drafting, true);
  assert.equal(props.type, "text");
  assert.equal(props.layer, "0");
  assert.ok(!("style" in props));
  assert.ok(!("hAlign" in props));
  assert.ok(!("vAlign" in props));
  const l = makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
  const lp = annotationToProps(l);
  assert.ok(!("value" in lp));
  assert.ok(!("height" in lp));
});

// ---------------------------------------------------------------------------
// Loader: both storage conventions.
// ---------------------------------------------------------------------------

test("elementToAnnotation: canonical flat props round-trip", () => {
  const d = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, mode: "horizontal", offset: 12, style: "ISO-25", textOverride: "≈50" });
  const el = annoElement(annotationToProps(d));
  assert.ok(isAnnotationElement(el));
  const back = elementToAnnotation(el);
  assert.equal(back.type, "dim-linear");
  if (back.type === "dim-linear") {
    assert.equal(back.mode, "horizontal");
    assert.equal(back.offset, 12);
    assert.equal(back.measured, 50);
    assert.equal(back.style, "ISO-25");
    assert.equal(back.textOverride, "≈50");
  }
});

test("elementToAnnotation: legacy COMPAT-CAD-001 dim-linear (tuple points) loads with defaults", () => {
  const el = annoElement({
    drafting: true,
    type: "dim-linear",
    layer: "0",
    p1: [0, 0],
    p2: [30, 40],
    mode: "aligned",
    offset: 5,
    measured: 50,
  });
  assert.ok(isAnnotationElement(el));
  const back = elementToAnnotation(el);
  assert.equal(back.type, "dim-linear");
  if (back.type === "dim-linear") {
    assert.deepEqual(back.p1, { x: 0, y: 0 });
    assert.deepEqual(back.p2, { x: 30, y: 40 });
    assert.equal(back.mode, "aligned");
    assert.equal(back.measured, 50);
    assert.equal(back.style, undefined);
    assert.equal(back.refs, undefined);
  }
});

test("elementToAnnotation: legacy dim-radius (target + measured) synthesizes the self-contained snapshot", () => {
  const el = annoElement({ drafting: true, type: "dim-radius", layer: "0", target: "el-9", measured: 25 });
  const back = elementToAnnotation(el);
  assert.equal(back.type, "dim-radius");
  if (back.type === "dim-radius") {
    assert.equal(back.target, "el-9");
    assert.equal(back.measured, 25);
    assert.equal(back.radius, 25);
    assert.deepEqual(back.center, { x: 0, y: 0 });
  }
});

test("elementToAnnotation: malformed annotation props throw (LOCK-007)", () => {
  assert.throws(() => elementToAnnotation(annoElement({ drafting: true, annotation: true, type: "text", layer: "0", x: 0, y: 0, height: 0, rotation: 0, value: "x" })), AnnotationError);
  assert.throws(() => elementToAnnotation(annoElement({ drafting: true, annotation: true, type: "nonsense", layer: "0" })), AnnotationError);
});

test("isAnnotationElement: only kind=annotation elements with the marks", () => {
  assert.equal(isAnnotationElement({ id: "a", kind: "geometry", engineId: null, props: { annotation: true } }), false);
  assert.equal(isAnnotationElement(annoElement({ drafting: true, annotation: true, type: "text", layer: "0", x: 0, y: 0, height: 2, rotation: 0, value: "x" })), true);
  assert.equal(isAnnotationElement(annoElement({ drafting: true, type: "dim-linear", layer: "0", p1: [0, 0], p2: [1, 0], mode: "aligned", offset: 0, measured: 1 })), true);
});

test("ANNOTATION_TYPES: the eight-type vocabulary", () => {
  assert.deepEqual([...ANNOTATION_TYPES], [
    "text", "mtext", "dim-linear", "dim-radius", "dim-diameter", "dim-angular", "leader", "mleader",
  ]);
});
