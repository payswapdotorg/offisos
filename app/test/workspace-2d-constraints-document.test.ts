/**
 * CAD-PARITY-007 deterministic constraint document tests (Issue #86) — the
 * CADDocument constraint table: con-NNNNNN minting (monotonic, never
 * reused), the four DocumentEdit variants with exact inverses (incl. the
 * key-adding update → full-record restore), undo/redo convergence, the
 * canonical-minimal snapshot/history contract (legacy byte-identity), the
 * replay integrity and the open-time validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot, ConstraintRecord } from "../src/contracts/caddocument.js";
import { canonicalStringify } from "../src/caddocument/serialization.js";
import { verifiedReplay } from "../src/caddocument/history.js";

const NOW = "2026-01-01T00:00:00.000Z";

function empty(): CADDocument {
  return CADDocument.empty("cp7-doc", "offisos-dummy", "1", "cp7-tests");
}

function con(
  id: string,
  kind: string,
  targets: readonly { id: string; anchor?: string }[],
  value?: number,
): ConstraintRecord {
  return {
    id,
    kind,
    targets,
    ...(value !== undefined ? { value } : {}),
    createdAt: NOW,
  } as ConstraintRecord;
}

test("addConstraint mints nothing by itself — an explicit id is stored; empty mints con-000001", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  // Explicit id.
  doc.execute({ type: "addConstraint", constraint: con("con-000042", "horizontal", [{ id: "el-1" }]) });
  assert.equal(doc.constraintTable.length, 1);
  assert.equal(doc.constraintById("con-000042")?.kind, "horizontal");
  // Empty id mints the NEXT canonical identity (monotonic from the mint
  // counter; the counter only counts MINTS — an explicit id does not advance
  // it, and the mint skips past taken ids).
  doc.execute({ type: "addConstraint", constraint: con("", "fixed", [{ id: "el-1" }]) });
  const minted = doc.constraintTable[1];
  assert.ok(minted);
  assert.match(minted.id, /^con-000001$/); // the first MINT (42 was explicit)
  // Duplicate id rejected.
  assert.throws(() => doc.execute({ type: "addConstraint", constraint: con("con-000042", "vertical", [{ id: "el-1" }]) }));
});

test("addConstraint structural validation rejects malformed records", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  assert.throws(() =>
    doc.execute({
      type: "addConstraint",
      constraint: { id: "con-1", kind: "sideways", targets: [{ id: "el-1" }], createdAt: NOW } as never,
    }),
  );
  assert.throws(() =>
    doc.execute({
      type: "addConstraint",
      constraint: { id: "con-1", kind: "radius", targets: [{ id: "el-1" }], createdAt: NOW } as never,
    }),
  );
  assert.throws(() =>
    doc.execute({
      type: "addConstraint",
      constraint: { id: "con-1", kind: "horizontal", targets: [{ id: "el-1", anchor: "start" }], createdAt: NOW } as never,
    }),
  );
});

test("updateConstraint patches value/mode; identity fields are immutable", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("con-1", "distance", [{ id: "el-1" }], 100) });
  doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { value: 200 } });
  assert.equal(doc.constraintById("con-1")?.value, 200);
  assert.throws(() => doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { kind: "radius" } }));
  assert.throws(() => doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { targets: [{ id: "el-9" }] } }));
  assert.throws(() => doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { createdAt: "2030-01-01T00:00:00.000Z" } }));
  assert.throws(() => doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { bogus: 1 } }));
  assert.throws(() => doc.execute({ type: "updateConstraint", constraintId: "con-X", patch: { value: 1 } }));
});

test("setConstraintRecord restores a full record (the update inverse)", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("con-1", "distance", [{ id: "el-1" }], 100) });
  doc.execute({ type: "setConstraintRecord", constraintId: "con-1", constraint: con("con-1", "distance", [{ id: "el-1" }], 350) });
  assert.equal(doc.constraintById("con-1")?.value, 350);
  assert.throws(() =>
    doc.execute({
      type: "setConstraintRecord",
      constraintId: "con-1",
      constraint: con("con-2", "distance", [{ id: "el-1" }], 1),
    }),
  );
});

test("removeConstraint + unknown-id rejections", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("con-1", "horizontal", [{ id: "el-1" }]) });
  doc.execute({ type: "removeConstraint", constraintId: "con-1" });
  assert.equal(doc.constraintTable.length, 0);
  assert.throws(() => doc.execute({ type: "removeConstraint", constraintId: "con-1" }));
});

test("undo/redo: exact inverses (value update, key-adding update, add, remove)", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addElement", element: { id: "el-2", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "circle", cx: 50, cy: 50, r: 10 } } });

  // add → undo removes (geometry + record in one revision each).
  doc.execute({ type: "addConstraint", constraint: con("con-1", "distance", [{ id: "el-1" }], 100) });
  assert.equal(doc.constraintTable.length, 1);
  doc.undo();
  assert.equal(doc.constraintTable.length, 0);
  doc.redo();
  assert.equal(doc.constraintTable.length, 1);

  // value update → undo restores the previous value.
  doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { value: 200 } });
  assert.equal(doc.constraintById("con-1")?.value, 200);
  doc.undo();
  assert.equal(doc.constraintById("con-1")?.value, 100);
  doc.redo();
  assert.equal(doc.constraintById("con-1")?.value, 200);

  // key-adding update (mode appears on a tangent record) → the inverse is
  // the FULL-RECORD restore (absence of keys is representable).
  doc.execute({ type: "addConstraint", constraint: con("con-2", "tangent", [{ id: "el-1" }, { id: "el-2" }]) });
  assert.equal(doc.constraintById("con-2")?.mode, undefined);
  doc.execute({ type: "updateConstraint", constraintId: "con-2", patch: { mode: "internal" } });
  assert.equal(doc.constraintById("con-2")?.mode, "internal");
  doc.undo();
  assert.equal(doc.constraintById("con-2")?.mode, undefined);
  assert.ok(!("mode" in (doc.constraintById("con-2") as unknown as Record<string, unknown>)));

  // remove → undo restores the exact record.
  doc.execute({ type: "removeConstraint", constraintId: "con-1" });
  assert.equal(doc.constraintById("con-1"), undefined);
  doc.undo();
  assert.equal(doc.constraintById("con-1")?.value, 200);
});

test("snapshot: constraints absent while empty; present + ordered after adds", () => {
  const doc = empty();
  assert.equal("constraints" in doc.snapshot(), false);
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("con-1", "horizontal", [{ id: "el-1" }]) });
  const snap = doc.snapshot();
  assert.deepEqual(
    snap.constraints?.map((c) => c.id),
    ["con-1"],
  );
});

test("save/open round-trip preserves the declared graph + the mint counter", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("", "horizontal", [{ id: "el-1" }]) }); // con-000001
  doc.execute({ type: "addConstraint", constraint: con("", "distance", [{ id: "el-1" }], 120) }); // con-000002
  const snap = doc.snapshot();
  const text = canonicalStringify(snap);
  const reopened = CADDocument.open(JSON.parse(text) as CADDocumentSnapshot, "cp7-tests");
  assert.deepEqual(reopened.constraintTable, snap.constraints);
  assert.equal(reopened.constraintTable.length, 2);
  // The mint counter survives: the next mint continues the sequence.
  reopened.execute({ type: "addElement", element: { id: "el-2", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "circle", cx: 0, cy: 0, r: 5 } } });
  reopened.execute({ type: "addConstraint", constraint: con("", "fixed", [{ id: "el-2" }]) });
  assert.equal(reopened.constraintTable[2]?.id, "con-000003");
});

test("history: next_constraint_sequence is canonical-minimal (absent until the first mint)", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  // Element-only revision: the counter stays ABSENT (legacy byte-identity).
  assert.equal(doc.history.next_constraint_sequence, undefined);
  doc.execute({ type: "addConstraint", constraint: con("", "horizontal", [{ id: "el-1" }]) });
  assert.equal(doc.history.next_constraint_sequence, 2);
  // The counter never decreases across undo/redo.
  doc.undo();
  assert.equal(doc.history.next_constraint_sequence, 2);
  doc.redo();
  assert.equal(doc.history.next_constraint_sequence, 2);
});

test("history validation: a malformed counter is rejected on open", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("", "horizontal", [{ id: "el-1" }]) });
  const snap = JSON.parse(canonicalStringify(doc.snapshot())) as CADDocumentSnapshot;
  snap.modelHistory = { ...snap.modelHistory!, next_constraint_sequence: 0 };
  assert.throws(() => CADDocument.open(snap, "cp7-tests"));
});

test("replay: constraint edits replay with verified content hashes", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  doc.execute({ type: "addConstraint", constraint: con("con-1", "distance", [{ id: "el-1" }], 100) });
  doc.execute({ type: "updateConstraint", constraintId: "con-1", patch: { value: 200 } });
  doc.execute({ type: "removeConstraint", constraintId: "con-1" });
  const history = doc.history;
  for (let k = 0; k <= history.revisions.length; k++) {
    const replayed = verifiedReplay(history, k);
    assert.equal(replayed.verified, true, `revision ${k} must replay verified`);
  }
});

test("legacy snapshots (no constraints field) open with an empty table", () => {
  const doc = empty();
  doc.execute({ type: "addElement", element: { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } } });
  const snap = JSON.parse(canonicalStringify(doc.snapshot())) as CADDocumentSnapshot;
  delete snap.constraints;
  const reopened = CADDocument.open(snap, "cp7-tests");
  assert.equal(reopened.constraintTable.length, 0);
  // Byte-identity: a constraint-free document serializes WITHOUT the key.
  assert.equal(canonicalStringify(reopened.snapshot()).includes('"constraints"'), false);
});

test("open: duplicate constraint ids are rejected", () => {
  const snap = {
    version: {
      entity_id: "cp7-dup",
      version_id: "v1",
      version_number: 1,
      parent_version_id: null,
      created_at: NOW,
      created_by: "cp7-tests",
      source_snapshot_id: null,
      status: "ACTIVE",
    },
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: [],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements: [
      { id: "el-1", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
    ],
    constraints: [
      con("con-1", "horizontal", [{ id: "el-1" }]),
      con("con-1", "vertical", [{ id: "el-1" }]),
    ],
  } as unknown as CADDocumentSnapshot;
  assert.throws(() => CADDocument.open(snap, "cp7-tests"), /duplicate constraint id/);
});
