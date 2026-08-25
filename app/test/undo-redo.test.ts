/**
 * Undo/redo command log + inverse semantics (§5.4, §15).
 *
 * Each edit type computes its inverse from current state. Undo reverts content
 * and version; redo re-applies. A new execute after undo clears the redo stack.
 * The same sequence through any host converges identically (§5.5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import type { Element } from "../src/contracts/caddocument.js";

const OWNER = "undo-redo-test";

function el(id: string, meshToken: string): Element {
  return { id, kind: "geometry", engineId: null, props: { meshToken } };
}

test("execute addElement → canUndo true; undo reverts content and version", () => {
  const doc = CADDocument.empty("undo-doc", "offisos-dummy", "1", OWNER);
  assert.equal(doc.canUndo, false);
  const before = doc.snapshot().version.version_number;
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  assert.equal(doc.canUndo, true);
  assert.equal(doc.snapshot().version.version_number, before + 1);
  doc.undo();
  assert.equal(doc.canUndo, false);
  assert.equal(doc.snapshot().version.version_number, before);
  assert.equal(doc.snapshot().elements.length, 0);
});

test("redo re-applies the undone edit and restores the child version", () => {
  const doc = CADDocument.empty("redo-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  const afterExecute = doc.snapshot().version.version_id;
  doc.undo();
  assert.equal(doc.canRedo, true);
  doc.redo();
  assert.equal(doc.canRedo, false);
  assert.equal(doc.snapshot().version.version_id, afterExecute);
  assert.equal(doc.snapshot().elements.length, 1);
});

test("a new execute after undo clears the redo stack", () => {
  const doc = CADDocument.empty("clear-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.undo();
  assert.equal(doc.canRedo, true);
  doc.execute({ type: "addElement", element: el("e2", "m2") });
  assert.equal(doc.canRedo, false);
  assert.equal(doc.snapshot().elements.length, 1);
  assert.equal(doc.snapshot().elements[0]?.id, "e2");
});

test("updateElement inverse restores previous prop values", () => {
  const doc = CADDocument.empty("upd-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } });
  assert.equal((doc.snapshot().elements[0]?.props as Record<string, unknown>).meshToken, "m2");
  doc.undo();
  assert.equal((doc.snapshot().elements[0]?.props as Record<string, unknown>).meshToken, "m1");
});

test("setProps inverse restores the full previous props object", () => {
  const doc = CADDocument.empty("set-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: { id: "e1", kind: "geometry", engineId: null, props: { a: 1, b: 2 } } });
  doc.execute({ type: "setProps", elementId: "e1", patch: { c: 3 } });
  assert.deepEqual((doc.snapshot().elements[0]?.props as Record<string, unknown>), { c: 3 });
  doc.undo();
  assert.deepEqual((doc.snapshot().elements[0]?.props as Record<string, unknown>), { a: 1, b: 2 });
});

test("undo/redo converges to the same content hash as a direct execute sequence", () => {
  // Path A: execute add, execute update.
  const a = CADDocument.empty("conv-doc", "offisos-dummy", "1", OWNER);
  a.execute({ type: "addElement", element: el("e1", "m1") });
  a.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } });
  const hashA = a.currentContentHash();

  // Path B: execute add, execute update, undo, redo, undo, redo (same end state).
  const b = CADDocument.empty("conv-doc", "offisos-dummy", "1", OWNER);
  b.execute({ type: "addElement", element: el("e1", "m1") });
  b.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } });
  b.undo();
  b.redo();
  b.undo();
  b.redo();
  assert.equal(b.currentContentHash(), hashA);
});
