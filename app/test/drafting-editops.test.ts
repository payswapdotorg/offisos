/**
 * COMPAT-CAD-001 — edit operations: move/copy/delete produce atomic batches;
 * trim/extend compute exact geometry with pick-side semantics and typed
 * no-ops; dimensions never act as cutting geometry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentEdit, Element } from "../src/contracts/caddocument.js";
import { CADDocument } from "../src/caddocument/index.js";
import { draftEntityToElement, makeCircle, makeLine, makeRectangle } from "../src/drafting/entities.js";
import { copyEntities, deleteEntities, extendEntity, moveEntities, trimEntity } from "../src/drafting/editops.js";
import { COINCIDENCE_EPS } from "../src/drafting/precision.js";

const TX = COINCIDENCE_EPS;

function line(id: string, from: [number, number], to: [number, number]): Element {
  return draftEntityToElement({ ...makeLine({ from, to, layer: "0" }), id });
}
function circle(id: string, center: [number, number], radius: number): Element {
  return draftEntityToElement({ ...makeCircle({ center, radius, layer: "0" }), id });
}
function rect(id: string, c1: [number, number], c2: [number, number]): Element {
  return draftEntityToElement({ ...makeRectangle({ corner1: c1, corner2: c2, layer: "0" }), id });
}

function apply(doc: CADDocument, outcome: { status: string; edit?: DocumentEdit }): void {
  assert.equal(outcome.status, "applied");
  doc.execute(outcome.edit as DocumentEdit);
}

test("move: one atomic batch of updateElement patches; one revision", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("L1", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: circle("C1", [5, 5], 2) });
  const revisionsBefore = doc.history.revisions.length;
  apply(doc, moveEntities(doc.allElements(), ["L1", "C1"], 3, -1));
  assert.equal(doc.history.revisions.length, revisionsBefore + 1, "one command = one revision");
  const l1 = doc.elementById("L1");
  assert.deepEqual((l1?.props as { from: number[] }).from, [3, -1]);
  assert.deepEqual((l1?.props as { to: number[] }).to, [13, -1]);
  const c1 = doc.elementById("C1");
  assert.deepEqual((c1?.props as { center: number[] }).center, [8, 4]);
  // single undo reverts the whole move
  doc.undo();
  assert.deepEqual((doc.elementById("L1")?.props as { from: number[] }).from, [0, 0]);
});

test("copy: minted ids, translated props, layer preserved", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("L1", [0, 0], [10, 0]) });
  apply(doc, copyEntities(doc.allElements(), ["L1"], 0, 5));
  assert.equal(doc.allElements().length, 2);
  const copy = doc.allElements().find((e) => e.id !== "L1");
  assert.ok(copy !== undefined);
  assert.match(copy.id, /^el-\d{6}$/);
  assert.deepEqual((copy.props as { from: number[] }).from, [0, 5]);
  assert.equal((copy.props as { layer: string }).layer, "0");
});

test("delete: atomic removal of the selection", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("L1", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("L2", [0, 1], [10, 1]) });
  apply(doc, deleteEntities(["L1", "L2"]));
  assert.equal(doc.allElements().length, 0);
  doc.undo();
  assert.equal(doc.allElements().length, 2, "one undo restores both");
});

test("trim between two boundaries: head keeps the id, tail is minted", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  // target crossed at x=3 and x=7
  doc.execute({ type: "addElement", element: line("T", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("B1", [3, -5], [3, 5]) });
  doc.execute({ type: "addElement", element: line("B2", [7, -5], [7, 5]) });
  apply(doc, trimEntity(doc.allElements(), "T", [5, 0]));
  assert.equal(doc.allElements().length, 4, "T split into head + tail");
  const head = doc.elementById("T");
  assert.ok(head !== undefined, "the head portion retains the identity");
  assert.deepEqual((head.props as { from: number[] }).from, [0, 0]);
  assert.ok(Math.abs((head.props as { to: number[] }).to[0]! - 3) <= TX);
  const tail = doc.allElements().find((e) => e.id !== "T" && e.id !== "B1" && e.id !== "B2");
  assert.ok(tail !== undefined);
  assert.ok(Math.abs((tail.props as { from: number[] }).from[0]! - 7) <= TX);
  assert.deepEqual((tail.props as { to: number[] }).to, [10, 0]);
  // one undo restores the original single line
  doc.undo();
  assert.equal(doc.allElements().length, 3);
  assert.deepEqual((doc.elementById("T")?.props as { to: number[] }).to, [10, 0]);
});

test("trim with one boundary: removes to the segment end on the open side", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("B1", [3, -5], [3, 5]) });
  // pick between the boundary and the far end → keep [0..3]
  apply(doc, trimEntity(doc.allElements(), "T", [8, 0]));
  const t = doc.elementById("T");
  assert.ok(t !== undefined);
  assert.deepEqual((t.props as { from: number[] }).from, [0, 0]);
  assert.ok(Math.abs((t.props as { to: number[] }).to[0]! - 3) <= TX);
});

test("trim to nothing when the boundaries sit at both segment ends", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("B1", [0, -5], [0, 5]) }); // cuts at t=0
  doc.execute({ type: "addElement", element: line("B2", [10, -5], [10, 5]) }); // cuts at t=1
  // pick between the two endpoint boundaries → nothing survives on either side
  apply(doc, trimEntity(doc.allElements(), "T", [5, 0]));
  assert.equal(doc.elementById("T"), undefined, "the removed interval spans the whole segment");
  assert.equal(doc.allElements().length, 2);
});

test("trim: circle and rectangle edges act as cutting geometry; dimensions do not", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: circle("C", [5, 3], 4) }); // crosses y=0 at x=5±√7
  doc.execute({
    type: "addElement",
    element: {
      id: "D",
      kind: "annotation",
      engineId: null,
      props: { drafting: true, type: "dim-linear", layer: "0", p1: [0, 9], p2: [10, 9], mode: "aligned", offset: 0, measured: 10 },
    },
  });
  const sqrt7 = Math.sqrt(7);
  apply(doc, trimEntity(doc.allElements(), "T", [5, 0]));
  // the dimension did NOT cut; the circle cut at 5±√7
  const head = doc.elementById("T");
  assert.ok(head !== undefined);
  assert.ok(Math.abs((head.props as { to: number[] }).to[0]! - (5 - sqrt7)) <= 1e-9);
  const tail = doc.allElements().find((e) => (e.props as { type: string }).type === "line" && e.id !== "T");
  assert.ok(tail !== undefined);
  assert.ok(Math.abs((tail.props as { from: number[] }).from[0]! - (5 + sqrt7)) <= 1e-9);
});

test("trim typed no-op when nothing cuts the picked portion", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [0, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("F", [0, 20], [10, 20]) });
  const outcome = trimEntity(doc.allElements(), "T", [5, 0]);
  assert.equal(outcome.status, "no-op");
  assert.match((outcome as { reason: string }).reason, /no intersecting boundary/);
});

test("trim rejects non-line targets with a typed error", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: circle("C", [0, 0], 5) });
  assert.throws(() => trimEntity(doc.allElements(), "C", [1, 1]), /supported set/);
  assert.throws(() => trimEntity(doc.allElements(), "missing", [1, 1]), /no element/);
});

test("extend from the picked end to the nearest boundary crossing", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [5, 0], [10, 0]) });
  doc.execute({ type: "addElement", element: line("B1", [0, -5], [0, 5]) });
  doc.execute({ type: "addElement", element: line("B2", [3, -5], [3, 5]) });
  // extend the `from` end (pick near (5,0)): nearest crossing beyond is x=3
  apply(doc, extendEntity(doc.allElements(), "T", [5.4, 0]));
  const t = doc.elementById("T");
  assert.deepEqual((t?.props as { from: number[] }).from, [3, 0]);
  // extend the `to` end: nothing beyond x=10 → typed no-op
  doc.execute({ type: "addElement", element: line("T2", [5, 0], [10, 0]) });
  const no = extendEntity(doc.allElements(), "T2", [9.5, 0]);
  assert.equal(no.status, "no-op");
  assert.match((no as { reason: string }).reason, /no boundary crossing/);
});

test("extend to a rectangle edge", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({ type: "addElement", element: line("T", [0, 4], [5, 4]) });
  doc.execute({ type: "addElement", element: rect("R", [10, 0], [20, 8]) });
  apply(doc, extendEntity(doc.allElements(), "T", [4.6, 4]));
  const t = doc.elementById("T");
  assert.deepEqual((t?.props as { to: number[] }).to, [10, 4]);
});

test("selection containing non-drafting elements is a typed error", () => {
  const doc = CADDocument.empty("d", "offisos-dummy", "1", "t");
  doc.execute({
    type: "addElement",
    element: { id: "M", kind: "geometry", engineId: "occt", props: { meshToken: "m1" } },
  });
  assert.throws(() => moveEntities(doc.allElements(), ["M"], 1, 1), /non-drafting/);
});
