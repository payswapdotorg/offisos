/**
 * Immutable model revision history (CAD-IMPLEMENT-003, data-model.md §2/§3,
 * LOCK-005).
 *
 * Every document transition (execute / undo / redo) appends an immutable
 * revision to the ModelHistory: monotonic numbering, deterministic ids, the
 * applied edit, the element-set delta, version linkage and fixed
 * timestamps. Recorded revisions are frozen and append-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import { canonicalStringify, diffElements } from "../src/caddocument/index.js";
import type { Element } from "../src/contracts/caddocument.js";

const OWNER = "model-history-test";

function el(id: string, meshToken: string, engineId: string | null = null): Element {
  return { id, kind: "geometry", engineId, props: { meshToken } };
}

test("a fresh document has an empty history with a created base", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  const history = doc.history;
  assert.equal(history.entity_id, "hist-doc");
  assert.equal(history.format, "offisos-dummy");
  assert.equal(history.formatVersion, "1");
  assert.equal(history.base.origin, "created");
  assert.equal(history.base.elements.length, 0);
  assert.equal(history.revisions.length, 0);
  assert.equal(history.next_element_sequence, 1);
  assert.ok(Object.isFrozen(history), "history must be frozen");
});

test("execute/undo/redo each append one immutable revision with the right note", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.execute({ type: "addElement", element: el("e2", "m2") });
  doc.undo();
  doc.redo();
  const history = doc.history;
  assert.equal(history.revisions.length, 4);
  assert.deepEqual(
    history.revisions.map((r) => r.note),
    ["edit", "edit", "undo", "redo"],
  );
  assert.deepEqual(
    history.revisions.map((r) => r.revision_number),
    [1, 2, 3, 4],
  );
  for (const rev of history.revisions) {
    assert.ok(Object.isFrozen(rev), "each revision must be frozen");
    assert.ok(Object.isFrozen(rev.delta), "each delta must be frozen");
    assert.equal(rev.created_at, "2026-01-01T00:00:00.000Z", "fixed deterministic timestamp");
    assert.equal(rev.created_by, OWNER);
    assert.match(rev.revision_id, /^hist-doc#r\d+\([0-9a-f]{12}\)$/);
  }
});

test("revision deltas record added/removed/updated canonical ids, sorted", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("b", "mb") });
  doc.execute({ type: "addElement", element: el("a", "ma") });
  doc.execute({ type: "addElement", element: el("c", "mc") });
  doc.execute({ type: "updateElement", elementId: "a", patch: { meshToken: "ma2" } });
  doc.execute({ type: "removeElement", elementId: "c" });

  const history = doc.history;
  const r1 = history.revisions[0];
  const r2 = history.revisions[1];
  const r3 = history.revisions[2];
  const r4 = history.revisions[3];
  const r5 = history.revisions[4];
  assert.ok(r1 && r2 && r3 && r4 && r5);
  assert.deepEqual(r1.delta, { added: ["b"], removed: [], updated: [] });
  assert.deepEqual(r2.delta, { added: ["a"], removed: [], updated: [] });
  assert.deepEqual(r3.delta, { added: ["c"], removed: [], updated: [] });
  assert.deepEqual(r4.delta, { added: [], removed: [], updated: ["a"] });
  assert.deepEqual(r5.delta, { added: [], removed: ["c"], updated: [] });

  // Sorted multi-add delta (diffElements is the delta authority).
  const before: Element[] = [];
  const after: Element[] = [el("z", "mz"), el("x", "mx"), el("y", "my")];
  const multiDelta = diffElements(before, after);
  assert.deepEqual(multiDelta.added, ["x", "y", "z"], "delta ids are lexicographically sorted");
  assert.deepEqual(multiDelta.removed, []);
  assert.deepEqual(multiDelta.updated, []);
});

test("revision version linkage: from_version_id chains the transitions", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  const rootId = doc.snapshot().version.version_id;
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.undo();
  doc.redo();

  const [r1, r2, r3] = doc.history.revisions;
  assert.ok(r1 && r2 && r3);
  assert.equal(r1.from_version_id, rootId);
  assert.equal(r1.version.parent_version_id, rootId);
  // undo leaves the undone version; redo leaves the undone-from version.
  assert.equal(r2.from_version_id, r1.version.version_id);
  assert.equal(r2.version.version_id, rootId, "undo restores the root version");
  assert.equal(r3.from_version_id, rootId);
  assert.equal(r3.version.version_id, r1.version.version_id, "redo restores the child version");
  // The document's current version is the last revision's version.
  assert.equal(doc.snapshot().version.version_id, r3.version.version_id);
});

test("recorded revisions are append-only: later edits never mutate earlier records", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  const prefix = canonicalStringify(doc.history.revisions);
  const firstRevision = canonicalStringify(doc.history.revisions[0]);
  doc.execute({ type: "addElement", element: el("e2", "m2") });
  doc.undo();
  doc.redo();
  assert.equal(canonicalStringify(doc.history.revisions[0]), firstRevision);
  assert.ok(canonicalStringify(doc.history.revisions).startsWith(prefix.slice(0, -1) + ","));
});

test("duplicate addElement id is rejected (canonical identity must not be reused)", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  assert.throws(() => doc.execute({ type: "addElement", element: el("e1", "m2") }), /already exists/);
  assert.equal(doc.history.revisions.length, 1, "the rejected edit appended no revision");
});

test("document-minted identities: missing/empty ids are minted, monotonic, never reused", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  // id omitted (the wire is untyped JSON; the document mints the identity)
  const noId = { kind: "geometry", engineId: null, props: { meshToken: "m1" } } as unknown as Element;
  doc.execute({ type: "addElement", element: noId });
  // id empty string
  doc.execute({ type: "addElement", element: { id: "", kind: "geometry", engineId: null, props: { meshToken: "m2" } } });
  const ids = doc.snapshot().elements.map((e) => e.id);
  assert.deepEqual(ids, ["el-000001", "el-000002"]);
  // The minted ids are recorded in the revision log (replay determinism).
  assert.deepEqual(doc.history.revisions[0]?.delta.added, ["el-000001"]);
  assert.deepEqual(doc.history.revisions[1]?.delta.added, ["el-000002"]);

  // Remove + undo: the counter never regresses (identity is never reused).
  doc.execute({ type: "removeElement", elementId: "el-000002" });
  doc.undo();
  const noId2 = { kind: "geometry", engineId: null, props: { meshToken: "m3" } } as unknown as Element;
  doc.execute({ type: "addElement", element: noId2 });
  const idsAfter = doc.snapshot().elements.map((e) => e.id);
  assert.deepEqual(idsAfter, ["el-000001", "el-000002", "el-000003"]);
  assert.equal(doc.history.next_element_sequence, 4);
});

test("two documents driven identically produce byte-identical histories", () => {
  const drive = (doc: CADDocument) => {
    doc.execute({ type: "addElement", element: el("e1", "m1") });
    doc.execute({ type: "addElement", element: el("e2", "m2") });
    doc.undo();
    doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m9" } });
    doc.redo();
  };
  const a = CADDocument.empty("same-doc", "offisos-dummy", "1", OWNER);
  const b = CADDocument.empty("same-doc", "offisos-dummy", "1", OWNER);
  drive(a);
  drive(b);
  assert.equal(canonicalStringify(a.history), canonicalStringify(b.history));
  assert.equal(a.getHistoryHash(), b.getHistoryHash());
});

test("history hash differs when content histories differ", () => {
  const a = CADDocument.empty("doc-a", "offisos-dummy", "1", OWNER);
  const b = CADDocument.empty("doc-b", "offisos-dummy", "1", OWNER);
  a.execute({ type: "addElement", element: el("e1", "m1") });
  b.execute({ type: "addElement", element: el("e1", "m1") });
  assert.notEqual(a.getHistoryHash(), b.getHistoryHash(), "entity id is part of the history identity");
});

test("snapshot carries the model history (persisted state)", () => {
  const doc = CADDocument.empty("hist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  const snapshot = doc.snapshot();
  assert.ok(snapshot.modelHistory !== undefined);
  assert.equal(snapshot.modelHistory.revisions.length, 1);
  // The parity content hash EXCLUDES the history (§5.5: content parity is
  // separate from history parity — undo/redo convergence).
  const { modelHistory: _mh, ...content } = snapshot;
  void _mh;
  const doc2 = CADDocument.open(JSON.parse(canonicalStringify(snapshot)), OWNER);
  assert.equal(doc2.getHistoryHash(), doc.getHistoryHash(), "open adopts the persisted history");
  assert.deepEqual(doc2.snapshot().elements, doc.snapshot().elements, "geometry + identity preserved");
  assert.equal(doc2.snapshot().version.version_id, doc.snapshot().version.version_id, "version lineage preserved");
});
