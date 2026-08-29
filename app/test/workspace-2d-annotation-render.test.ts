/**
 * CAD-PARITY-005 deterministic annotation render tests (Issue #82) — the
 * style-driven primitive resolution: effective dim/text style math, the
 * document annotation scale, exact measurement formatting (precision +
 * suffix + degree conversion), text metrics, and the primitive geometry of
 * every annotation kind (dimension lines, extension overshoot, arrow
 * direction/flip, text placement + readability rotation, leader landings).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annotationPrimitives,
  annotationStyleContext,
  DEFAULT_LEADER_TEXT_HEIGHT,
  dimensionLabel,
  effectiveDimStyle,
  effectiveTextStyle,
  formatAngleValue,
  formatLinearValue,
  readableRotation,
  textWidth,
  textLinePitch,
  TEXT_GLYPH_ASPECT,
  type RenderPrimitive,
} from "../src/workspace/annotation/render.js";
import {
  makeDimAngular,
  makeDimDiameter,
  makeDimLinear,
  makeDimRadius,
  makeLeader,
  makeMLeader,
  makeMText,
  makeText,
} from "../src/workspace/annotation/types.js";
import {
  pickAnnotationAt,
  selectAnnotations,
} from "../src/workspace/annotation/pick.js";
import type { Element } from "../src/contracts/caddocument.js";

const TOL = 1e-9;
const CTX = annotationStyleContext([], [], undefined);
const ctxWith = (annotationScale: number | undefined) => annotationStyleContext([], [], annotationScale);

function seg(p: RenderPrimitive): p is Extract<RenderPrimitive, { kind: "segment" }> {
  return p.kind === "segment";
}
function arrow(p: RenderPrimitive): p is Extract<RenderPrimitive, { kind: "arrow" }> {
  return p.kind === "arrow";
}
function text(p: RenderPrimitive): p is Extract<RenderPrimitive, { kind: "text" }> {
  return p.kind === "text";
}
function closeTo(a: number, b: number, tol = 1e-9): void {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);
}
function annoElement(props: Record<string, unknown>): Element {
  return { id: "el-000001", kind: "annotation", engineId: null, props };
}

// ---------------------------------------------------------------------------
// Style resolution + formatting.
// ---------------------------------------------------------------------------

test("effectiveDimStyle: Standard defaults; user style fields; scale × annotationScale", () => {
  const std = effectiveDimStyle(undefined, CTX);
  assert.equal(std.textHeight, 2.5);
  assert.equal(std.arrowSize, 2.5);
  assert.equal(std.precision, 0);
  assert.equal(std.arrowStyle, "closed");
  assert.equal(std.unitSuffix, "");
  const styled = effectiveDimStyle("ISO", annotationStyleContext([], [{ name: "ISO", textHeight: 3, arrowSize: 1.5, scale: 2, precision: 2 }], 2));
  assert.equal(styled.textHeight, 12); // 3 × 2 × 2
  assert.equal(styled.arrowSize, 6); // 1.5 × 2 × 2
  assert.equal(styled.precision, 2);
});

test("effectiveTextStyle: font/widthFactor/oblique resolve from the style table", () => {
  assert.deepEqual(effectiveTextStyle(undefined, CTX), { font: "sans", widthFactor: 1, oblique: 0 });
  const eff = effectiveTextStyle("Notes", annotationStyleContext([{ name: "Notes", font: "mono", height: 0, widthFactor: 0.8, obliqueAngle: 15 }], [], 1));
  assert.deepEqual(eff, { font: "mono", widthFactor: 0.8, oblique: 15 });
});

test("formatLinearValue / formatAngleValue: precision + suffix + degrees", () => {
  const eff = effectiveDimStyle(undefined, CTX);
  assert.equal(formatLinearValue(50.25, eff), "50");
  assert.equal(formatLinearValue(50.25, { ...eff, precision: 1 }), "50.3");
  assert.equal(formatLinearValue(50.25, { ...eff, precision: 2, unitSuffix: " mm" }), "50.25 mm");
  assert.equal(formatAngleValue(Math.PI / 3, eff), "60°");
  assert.equal(formatAngleValue(Math.PI / 6, { ...eff, precision: 1 }), "30.0°");
});

test("dimensionLabel: prefixes (R/⌀), textOverride wins, angular in degrees", () => {
  const r = makeDimRadius({ layer: "0", target: null, center: { x: 0, y: 0 }, radius: 25, measured: 25 });
  assert.equal(dimensionLabel(r, CTX), "R25");
  const d = makeDimDiameter({ layer: "0", target: null, center: { x: 0, y: 0 }, radius: 25, angle: 0, measured: 50 });
  assert.equal(dimensionLabel(d, CTX), "\u230050");
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, mode: "horizontal", offset: 10, textOverride: "FIFTY" });
  assert.equal(dimensionLabel(l, CTX), "FIFTY");
  const a = makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0, endAngle: Math.PI / 2, radius: 20 });
  assert.equal(dimensionLabel(a, CTX), "90°");
});

test("annotationScale multiplies the effective dim geometry (DIMSCALE-class)", () => {
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, mode: "horizontal", offset: 10 });
  const base = annotationPrimitives(l, CTX).find(arrow)!;
  const scaled = annotationPrimitives(l, ctxWith(4)).find(arrow)!;
  closeTo(scaled.size, base.size * 4);
  const baseText = annotationPrimitives(l, CTX).find(text)!;
  const scaledText = annotationPrimitives(l, ctxWith(4)).find(text)!;
  closeTo(scaledText.height, baseText.height * 4);
});

// ---------------------------------------------------------------------------
// Text metrics + readability.
// ---------------------------------------------------------------------------

test("text metrics: 0.6 glyph aspect × widthFactor; 1.2 line pitch", () => {
  assert.equal(TEXT_GLYPH_ASPECT, 0.6);
  closeTo(textWidth("ABCD", 10, 1), 24); // 4 × 10 × 0.6
  closeTo(textWidth("ABCD", 10, 0.5), 12);
  closeTo(textLinePitch(10), 12);
});

test("readableRotation: upside-down runs flip 180°", () => {
  assert.equal(readableRotation(0), 0);
  closeTo(readableRotation(Math.PI), 2 * Math.PI);
  closeTo(readableRotation(Math.PI / 2), Math.PI / 2); // up stays
  closeTo(readableRotation(-Math.PI / 2), Math.PI / 2); // straight down flips
  closeTo(readableRotation(Math.PI * 0.75), Math.PI * 0.75 + Math.PI);
});

// ---------------------------------------------------------------------------
// Primitive geometry: dimensions.
// ---------------------------------------------------------------------------

test("dim-linear primitives: extension lines, dim line, inward arrows, text above the line", () => {
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, mode: "horizontal", offset: 15 });
  const ps = annotationPrimitives(l, CTX);
  const segments = ps.filter(seg);
  const arrows = ps.filter(arrow);
  const t = ps.find(text)!;
  // Two extension lines at x=0/x=100 from the gap (0.625 = arrow × 0.25)
  // past the dim line (16.25 = 15 + arrow × 0.5 overshoot).
  const exts = segments.filter((s) => Math.abs(s.a.x - s.b.x) < TOL && (Math.abs(s.a.x) < TOL || Math.abs(s.a.x - 100) < TOL));
  assert.equal(exts.length, 2, "two extension lines from the origins");
  closeTo(exts[0]!.a.y, 2.5 * 0.25);
  closeTo(exts[0]!.b.y, 15 + 2.5 * 0.5);
  // Dim line endpoints: (0,15) → (100,15).
  const dimLine = segments.find((s) => Math.abs(s.a.y - 15) < TOL && Math.abs(s.b.y - 15) < TOL)!;
  closeTo(dimLine.a.x, 0);
  closeTo(dimLine.b.x, 100);
  // Arrows at the dim line ends: tips at the extension lines pointing
  // OUTWARD (the body extends into the span — AutoCAD inside arrows).
  assert.equal(arrows.length, 2);
  const left = arrows.find((a) => a.at.x < 50)!;
  const right = arrows.find((a) => a.at.x > 50)!;
  closeTo(left.at.y, 15);
  closeTo(left.dir.x, -1);
  closeTo(right.dir.x, 1);
  // Text at the midpoint, half the text height above the line, horizontal.
  closeTo(t.at.x, 50);
  closeTo(t.at.y, 15 + 2.5 * 0.5);
  closeTo(t.rotation, 0);
  assert.equal(t.value, "100");
  assert.equal(t.hAlign, "center");
});

test("dim-linear arrows flip OUTSIDE when they do not fit (AutoCAD behavior)", () => {
  // measured 6 mm with 2.5 arrows + "6" text (~9 mm) → does not fit.
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 6, y: 0 }, mode: "horizontal", offset: 5 });
  const ps = annotationPrimitives(l, CTX);
  const arrows = ps.filter(arrow);
  const left = arrows.find((a) => a.at.x <= 3)!;
  const right = arrows.find((a) => a.at.x > 3)!;
  closeTo(left.dir.x, 1); // pointing INWARD now (bodies outside)
  closeTo(right.dir.x, -1);
  // The dimension line extends beyond both feet by one arrow size.
  const dimLine = ps.filter(seg).find((s) => Math.abs(s.a.y - 5) < TOL && Math.abs(s.b.y - 5) < TOL)!;
  closeTo(dimLine.a.x, 0 - 2.5);
  closeTo(dimLine.b.x, 6 + 2.5);
});

test("dim-linear textPos override (DIMTEDIT) replaces the placement", () => {
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, mode: "horizontal", offset: 10, textPos: { x: 25, y: 40 } });
  const t = annotationPrimitives(l, CTX).find(text)!;
  closeTo(t.at.x, 25);
  closeTo(t.at.y, 40);
});

test("dim-radius primitives: arrow on the circle pointing inward, leader to the placement, R label", () => {
  const r = makeDimRadius({ layer: "0", target: null, center: { x: 0, y: 0 }, radius: 20, measured: 20, at: { x: 50, y: 0 } });
  const ps = annotationPrimitives(r, CTX);
  const a = ps.find(arrow)!;
  closeTo(a.at.x, 20); // boundary point toward the placement
  closeTo(a.at.y, 0);
  closeTo(a.dir.x, -1); // toward the center
  const leader = ps.filter(seg)[0]!;
  closeTo(leader.a.x, 20);
  closeTo(leader.b.x, 50);
  const t = ps.find(text)!;
  assert.equal(t.value, "R20");
  assert.equal(t.hAlign, "left");
});

test("dim-diameter primitives: line through the circle, outward arrows, ⌀ label", () => {
  const d = makeDimDiameter({ layer: "0", target: null, center: { x: 0, y: 0 }, radius: 30, angle: 0, measured: 60 });
  const ps = annotationPrimitives(d, CTX);
  const line = ps.filter(seg).find((s) => Math.abs(s.b.x - 30) < TOL)!;
  closeTo(line.a.x, -30);
  const arrows = ps.filter(arrow);
  assert.equal(arrows.length, 2);
  const right = arrows.find((x) => x.at.x > 0)!;
  closeTo(right.dir.x, 1); // outward
  const t = ps.find(text)!;
  assert.equal(t.value, "\u230060");
  // The text fits inside (60 ≥ text + arrows) → centered above the line.
  closeTo(t.at.x, 0, 1e-6);
  closeTo(t.at.y, 2.5 * 0.5);
});

test("dim-angular primitives: arc polyline, tangential arrows, degree label at mid-arc", () => {
  const a = makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0, endAngle: Math.PI / 2, radius: 30 });
  const ps = annotationPrimitives(a, CTX);
  // Arc segments lie at radius 30 from the vertex; the two extension
  // lines are radial too but long — filter by exact arc membership: the
  // arc polyline chords (6° steps → 15 segments).
  const arcs = ps.filter(seg).filter((s) => {
    const ra = Math.hypot(s.a.x, s.a.y);
    const rb = Math.hypot(s.b.x, s.b.y);
    return Math.abs(ra - 30) < 1e-6 && Math.abs(rb - 30) < 1e-6;
  });
  assert.equal(arcs.length, 15);
  const first = arcs[0]!;
  closeTo(first.a.x, 30);
  closeTo(first.a.y, 0);
  const last = arcs[arcs.length - 1]!;
  closeTo(last.b.x, 0, 1e-9);
  closeTo(last.b.y, 30);
  const arrows = ps.filter(arrow);
  assert.equal(arrows.length, 2);
  // Arrow at the start: tangent INTO the sweep = +tangent at θ=0 → (0,1)... 
  // rotated for reading: tangent (−sinθ, cosθ) at 0 = (0, 1).
  const startArrow = arrows.find((x) => Math.abs(x.at.x - 30) < TOL)!;
  closeTo(startArrow.dir.x, 0);
  closeTo(startArrow.dir.y, 1);
  const t = ps.find(text)!;
  assert.equal(t.value, "90°");
  // At mid-angle 45° on the arc, offset radially by half the text height.
  const mid = Math.PI / 4;
  closeTo(t.at.x, 30 * Math.cos(mid) + 1.25 * Math.cos(mid), 1e-9);
  closeTo(t.at.y, 30 * Math.sin(mid) + 1.25 * Math.sin(mid), 1e-9);
});

// ---------------------------------------------------------------------------
// Primitive geometry: text, mtext, leaders.
// ---------------------------------------------------------------------------

test("text primitives: the live text style drives font/width/oblique; height is per-entity", () => {
  const t = makeText({ layer: "0", x: 5, y: 5, height: 4, rotation: 0.3, value: "NOTE" });
  const p = annotationPrimitives(t, CTX).find(text)!;
  assert.equal(p.font, "sans");
  assert.equal(p.widthFactor, 1);
  assert.equal(p.height, 4);
  const styled = annotationStyleContext([{ name: "Notes", font: "serif", height: 0, widthFactor: 0.7, obliqueAngle: 12 }], [], 1);
  const t2 = makeText({ layer: "0", x: 0, y: 0, height: 4, rotation: 0, value: "N", style: "Notes" });
  const p2 = annotationPrimitives(t2, styled).find(text)!;
  assert.equal(p2.font, "serif");
  assert.equal(p2.widthFactor, 0.7);
  assert.equal(p2.oblique, 12);
  assert.equal(p2.height, 4, "height stays per-entity");
});

test("mtext primitives: multi-line block with pitch, attachment positions the block", () => {
  const top = makeMText({ layer: "0", x: 10, y: 20, height: 5, width: 60, rotation: 0, value: "one\ntwo\nthree" });
  const ps = annotationPrimitives(top, CTX).filter(text);
  assert.equal(ps.length, 3);
  closeTo(ps[0]!.at.y, 20 + 5 * 0.8);
  closeTo(ps[1]!.at.y, 20 + 5 * 0.8 + 6); // + pitch 1.2 × 5
  closeTo(ps[2]!.at.y, 20 + 5 * 0.8 + 12);
  closeTo(ps[0]!.at.x, 10); // top-left: block edge at (x,y)
  // bottom-center attachment: block bottom at y, lines centered in width.
  const bc = makeMText({ layer: "0", x: 10, y: 0, height: 5, width: 60, rotation: 0, value: "one\ntwo", attachment: "bottom-center" });
  const ps2 = annotationPrimitives(bc, CTX).filter(text);
  closeTo(ps2[0]!.at.x, 10 - 30); // −width/2
  // Block spans y ∈ [−12, 0]; first baseline at −12 + 4, last at −12 + 10.
  closeTo(ps2[0]!.at.y, -12 + 5 * 0.8);
  closeTo(ps2[1]!.at.y, -12 + 6 + 5 * 0.8);
});

test("leader primitives: arrow at the tip, spine segments, landing + text when annotated", () => {
  const bare = makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 60, y: 20 }] });
  const barePs = annotationPrimitives(bare, CTX);
  assert.equal(barePs.filter(seg).length, 2);
  const a = barePs.find(arrow)!;
  closeTo(a.at.x, 0);
  closeTo(a.at.y, 0);
  // Arrow points back along the first segment.
  closeTo(a.dir.x, -Math.SQRT1_2);
  closeTo(a.dir.y, -Math.SQRT1_2);

  const annotated = makeLeader({ layer: "0", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 60, y: 20 }], value: "see detail", height: 3 });
  const ps = annotationPrimitives(annotated, CTX);
  // 2 spine + 1 landing segments.
  assert.equal(ps.filter(seg).length, 3);
  const landing = ps.filter(seg)[2]!;
  closeTo(landing.a.x, 60);
  closeTo(landing.b.x, 60 + 2 * 3, 1e-9); // 2 × height to the right
  const t = ps.find(text)!;
  assert.equal(t.value, "see detail");
  assert.equal(t.height, 3);
});

test("mleader primitives: spine + landing + vertically-centered content block", () => {
  const m = makeMLeader({ layer: "0", arrow: { x: 0, y: 0 }, landing: { x: 30, y: 10 }, value: "A\nB", height: 4 });
  const ps = annotationPrimitives(m, CTX);
  assert.equal(ps.filter(seg).length, 2); // spine + landing
  const landing = ps.filter(seg)[1]!;
  closeTo(landing.a.x, 30);
  closeTo(landing.b.x, 30 + 8); // 2 × height
  const texts = ps.filter(text);
  assert.equal(texts.length, 2);
  // Block vertically centered on the landing line: total 2 lines × 4.8 = 9.6;
  // first baseline = 10 − 4.8 + 3.2 = 8.4.
  closeTo(texts[0]!.at.y, 10 - 2 * 4.8 / 2 + 4 * 0.8);
  closeTo(texts[1]!.at.y, texts[0]!.at.y + 4.8);
  closeTo(texts[0]!.at.x, 38 + 0.8, 1e-9);
  // Default height when absent.
  const plain = makeMLeader({ layer: "0", arrow: { x: 0, y: 0 }, landing: { x: 10, y: 0 }, value: "x" });
  assert.equal(annotationPrimitives(plain, CTX).find(text)!.height, DEFAULT_LEADER_TEXT_HEIGHT);
});

// ---------------------------------------------------------------------------
// Picking (the SAME primitives).
// ---------------------------------------------------------------------------

test("pickAnnotationAt: text pick inside the metrics box; outside misses", () => {
  const el = annoElement({
    drafting: true, annotation: true, type: "text", layer: "0",
    x: 0, y: 0, height: 10, rotation: 0, value: "HELLO",
  });
  // Box: x ∈ [0, 30] (5 glyphs × 6), y ∈ [−2.5, 10].
  const pick = pickAnnotationAt([el], { x: 15, y: 5 }, 5, CTX);
  assert.ok(pick !== null, "inside the box");
  assert.equal(pick.id, "el-000001");
  const miss = pickAnnotationAt([el], { x: 15, y: -8 }, 5, CTX);
  assert.equal(miss, null, "outside the box + aperture");
  const miss2 = pickAnnotationAt([el], { x: 40, y: 5 }, 5, CTX);
  assert.equal(miss2, null, "right of the box + aperture");
});

test("pickAnnotationAt: dim pick on the dimension line", () => {
  const l = makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, mode: "horizontal", offset: 15 });
  const el = annoElement({
    drafting: true, annotation: true, type: "dim-linear", layer: "0",
    p1: l.p1, p2: l.p2, mode: "horizontal", offset: 15, measured: 100,
  });
  const hit = pickAnnotationAt([el], { x: 50, y: 15.5 }, 2, CTX);
  assert.ok(hit !== null);
  const miss = pickAnnotationAt([el], { x: 50, y: 5 }, 2, CTX);
  assert.equal(miss, null);
});

test("selectAnnotations: window mode needs the whole annotation inside; crossing any intersection", () => {
  const el = annoElement({
    drafting: true, annotation: true, type: "text", layer: "0",
    x: 0, y: 0, height: 10, rotation: 0, value: "AB",
  });
  // Box (−5,−5)..(20,15) fully contains the text box (0..12 × −2.5..10).
  assert.deepEqual(selectAnnotations([el], { mode: "window", min: { x: -5, y: -5 }, max: { x: 20, y: 15 } }, CTX), ["el-000001"]);
  assert.deepEqual(selectAnnotations([el], { mode: "window", min: { x: -5, y: -5 }, max: { x: 10, y: 15 } }, CTX), []);
  assert.deepEqual(selectAnnotations([el], { mode: "window", min: { x: 1, y: -5 }, max: { x: 20, y: 15 } }, CTX), []);
  assert.deepEqual(selectAnnotations([el], { mode: "crossing", min: { x: 5, y: -5 }, max: { x: 10, y: 15 } }, CTX), ["el-000001"]);
});

// ---------------------------------------------------------------------------
// Determinism (double-run).
// ---------------------------------------------------------------------------

test("annotationPrimitives is double-run deterministic", () => {
  const annos = [
    makeText({ layer: "0", x: 1, y: 1, height: 3, rotation: 0.4, value: "DET" }),
    makeDimLinear({ layer: "0", p1: { x: 0, y: 0 }, p2: { x: 33, y: 7 }, mode: "aligned", offset: -4 }),
    makeDimAngular({ layer: "0", vertex: { x: 0, y: 0 }, startAngle: 0.3, endAngle: 2.1, radius: 17 }),
  ];
  for (const a of annos) {
    const r1 = JSON.stringify(annotationPrimitives(a, ctxWith(2.5)));
    const r2 = JSON.stringify(annotationPrimitives(a, ctxWith(2.5)));
    assert.equal(r1, r2);
  }
});
