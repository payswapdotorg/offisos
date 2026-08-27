/**
 * COMPAT-CAD-003 — documentation annotation entity validation (LOCK-007:
 * every malformed input rejected with a descriptive error; derived fields
 * are regeneration-only). Granular per-field coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationElement,
  elementToDocsAnnotationOrNull,
  isDocsAnnotationType,
  makeDocsDim,
  makeDocsNote,
  makeDocsTag,
} from "../src/docs/entities.js";
import type { Element } from "../src/contracts/caddocument.js";

const VIEW = "vw-000001";

test("docs.dim: valid construction carries the canonical binding fields", () => {
  const d = makeDocsDim({ viewId: VIEW, refIds: ["wall-a", "wall-b"], axis: "y", mode: "overall", offset: -500 });
  assert.deepEqual(d, {
    type: "docs.dim",
    viewId: VIEW,
    refIds: ["wall-a", "wall-b"],
    axis: "y",
    mode: "overall",
    offset: -500,
  });
  // offset defaults to 0; both axes and modes accepted.
  assert.equal(makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "clear" }).offset, 0);
});

test("docs.dim rejections: viewId, refIds shape, self-reference, axis, mode, offset, derived fields", () => {
  assert.throws(() => makeDocsDim({ refIds: ["a", "b"], axis: "x", mode: "overall" }), /viewId/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a"], axis: "x", mode: "overall" }), /exactly two/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b", "c"], axis: "x", mode: "overall" }), /exactly two/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", 7], axis: "x", mode: "overall" }), /exactly two/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "a"], axis: "x", mode: "overall" }), /DIFFERENT/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "z", mode: "overall" }), /axis/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "aligned" }), /mode/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "overall", offset: "far" }), /offset/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "overall", offset: Number.NaN }), /offset/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "overall", measured: 100 }), /derived field/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "overall", dangling: false }), /derived field/);
  assert.throws(() => makeDocsDim({ viewId: VIEW, refIds: ["a", "b"], axis: "x", mode: "overall", reason: "x" }), /derived field/);
});

test("docs.tag: valid construction + rejections (targetId, derived label)", () => {
  const t = makeDocsTag({ viewId: VIEW, targetId: "space-1" });
  assert.deepEqual(t, { type: "docs.tag", viewId: VIEW, targetId: "space-1" });
  assert.throws(() => makeDocsTag({ targetId: "space-1" }), /viewId/);
  assert.throws(() => makeDocsTag({ viewId: VIEW }), /targetId/);
  assert.throws(() => makeDocsTag({ viewId: VIEW, targetId: "s", label: "Hand written" }), /derived field/);
});

test("docs.note: valid construction + rejections (text, anchor)", () => {
  const n = makeDocsNote({ viewId: VIEW, x: 100, y: 200, text: "Note text" });
  assert.deepEqual(n, { type: "docs.note", viewId: VIEW, x: 100, y: 200, text: "Note text" });
  assert.throws(() => makeDocsNote({ x: 0, y: 0, text: "t" }), /viewId/);
  assert.throws(() => makeDocsNote({ viewId: VIEW, x: 0, y: 0, text: "" }), /text/);
  assert.throws(() => makeDocsNote({ viewId: VIEW, x: "a", y: 0, text: "t" }), /anchor/);
  assert.throws(() => makeDocsNote({ viewId: VIEW, x: 0, y: Number.POSITIVE_INFINITY, text: "t" }), /anchor/);
});

test("annotation elements carry kind 'annotation' and round-trip through the cast helper", () => {
  const el: Element = annotationElement("an-1", makeDocsNote({ viewId: VIEW, x: 1, y: 2, text: "t" }) as never);
  assert.equal(el.kind, "annotation");
  assert.equal(el.engineId, null);
  assert.equal(elementToDocsAnnotationOrNull(el)?.type, "docs.note");
  // Non-annotation elements (drafting dim, geometry, BIM) return null.
  const drafting: Element = { id: "d", kind: "annotation", engineId: null, props: { type: "dim-linear", layer: "0" } };
  assert.equal(elementToDocsAnnotationOrNull(drafting), null);
  const bim: Element = { id: "b", kind: "bim", engineId: null, props: { type: "bim.wall" } };
  assert.equal(elementToDocsAnnotationOrNull(bim), null);
  assert.equal(isDocsAnnotationType("docs.dim"), true);
  assert.equal(isDocsAnnotationType("dim-linear"), false);
});
