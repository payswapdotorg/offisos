/**
 * CAD-PARITY-006 deterministic blocks document tests (Issue #84) — the
 * document-level block/xref tables: canonical identity minting (blk-/xr-
 * monotonic), add/update/remove semantics with reference-checked removal,
 * exact inverses (undo/redo convergence), the definition-graph gates at the
 * write path, snapshot emission (additive-optional — legacy saves stay
 * byte-identical), open validation (integrity, cycles, dangling instances)
 * and the mint-sequence persistence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CADDocument } from "../src/caddocument/document.js";
import { canonicalStringify } from "../src/caddocument/serialization.js";
import type { BlockDefinitionRecord, XrefRecord } from "../src/contracts/caddocument.js";

const TOL = 1e-9;

function doc(): CADDocument {
  return CADDocument.empty("cp6-doc-tests", "offisos-dummy", "1", "cp6-tests");
}

function block(name: string, entities: Record<string, unknown>[] = [], id = ""): BlockDefinitionRecord {
  return { id, name, basePoint: { x: 0, y: 0 }, entities, createdAt: "2026-01-01T00:00:00.000Z" };
}

function xref(name: string, path = `${name}.offisos`, status: "loaded" | "unresolved" = "unresolved"): XrefRecord {
  return {
    id: "",
    name,
    path,
    status,
    sourceHash: status === "loaded" ? "a".repeat(64) : null,
    attachedAt: "2026-01-01T00:00:00.000Z",
    entities: status === "loaded" ? [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" }] : [],
  };
}

// ---------------------------------------------------------------------------
// Identity minting.
// ---------------------------------------------------------------------------

test("addBlockDef mints monotonic blk-NNNNNN identities; explicit ids are duplicate-checked", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A") });
  d.execute({ type: "addBlockDef", block: block("B") });
  assert.equal(d.blockDefTable[0]!.id, "blk-000001");
  assert.equal(d.blockDefTable[1]!.id, "blk-000002");
  assert.equal(d.blockDefByName("A")!.id, "blk-000001");
  // Monotonic across removal: identities are never reused.
  d.execute({ type: "removeBlockDef", blockId: "blk-000001" });
  d.execute({ type: "addBlockDef", block: block("C") });
  assert.equal(d.blockDefByName("C")!.id, "blk-000003");
  // An explicit duplicate id is rejected.
  assert.throws(() => d.execute({ type: "addBlockDef", block: { ...block("D"), id: "blk-000002" } }));
});

test("addXref mints monotonic xr-NNNNNN identities", () => {
  const d = doc();
  d.execute({ type: "addXref", xref: xref("SITE") });
  d.execute({ type: "addXref", xref: xref("TOPO") });
  assert.deepEqual(d.xrefTable.map((x) => x.id), ["xr-000001", "xr-000002"]);
  assert.equal(d.xrefByName("TOPO")!.id, "xr-000002");
});

test("duplicate names are rejected at write time (definitions and xrefs)", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A") });
  assert.throws(() => d.execute({ type: "addBlockDef", block: block("A") }), /already exists/);
  d.execute({ type: "addXref", xref: xref("SITE") });
  assert.throws(() => d.execute({ type: "addXref", xref: xref("SITE") }), /already exists/);
  // A rename colliding with the OTHER definition is rejected.
  d.execute({ type: "addBlockDef", block: block("B") });
  assert.throws(() => d.execute({ type: "updateBlockDef", blockId: "blk-000001", patch: { name: "B" } }), /already exists/);
});

// ---------------------------------------------------------------------------
// Definition writes: validation, graph gates, inverses.
// ---------------------------------------------------------------------------

test("addBlockDef validates inline entities strictly (LOCK-007 at the document gate)", () => {
  const d = doc();
  assert.throws(() => d.execute({ type: "addBlockDef", block: block("BAD", [{ type: "nonsense" }]) }));
  assert.throws(() => d.execute({ type: "addBlockDef", block: block("BAD", [{ type: "circle", cx: 0, cy: 0, r: -1 }]) }));
  // The record is canonicalized: entity display fields survive.
  d.execute({ type: "addBlockDef", block: block("OK", [{ type: "line", x1: 0, y1: 0, x2: 1, y2: 0, layer: "W", color: "#ff0000" }]) });
  const stored = d.blockDefByName("OK")!;
  assert.equal(stored.entities[0]!.layer, "W");
  assert.equal(stored.entities[0]!.color, "#ff0000");
});

test("the definition-graph gates run at the write path: self-reference + unknown target rejected", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A") });
  const aId = d.blockDefByName("A")!.id;
  // Self-reference through a patch.
  assert.throws(
    () => d.execute({ type: "updateBlockDef", blockId: aId, patch: { entities: [{ type: "block-ref", layer: "0", blockId: aId, x: 0, y: 0, scale: 1, rotation: 0 }] } }),
    /circular/i,
  );
  // Unknown nested target.
  assert.throws(
    () => d.execute({ type: "addBlockDef", block: block("B", [{ type: "block-ref", layer: "0", blockId: "blk-999999", x: 0, y: 0, scale: 1, rotation: 0 }]) }),
    /unknown definition/i,
  );
});

test("removeBlockDef is reference-checked: instances AND other definitions' content block removal", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A") });
  d.execute({ type: "addBlockDef", block: block("B", [{ type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }]) });
  assert.throws(() => d.execute({ type: "removeBlockDef", blockId: "blk-000001" }), /definition 'B'/);
  // Removing B frees A.
  d.execute({ type: "removeBlockDef", blockId: "blk-000002" });
  // An instance still blocks removal.
  d.execute({
    type: "addElement",
    element: {
      id: "el-000001",
      kind: "geometry",
      engineId: null,
      props: { drafting: true, type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 },
    },
  });
  assert.throws(() => d.execute({ type: "removeBlockDef", blockId: "blk-000001" }), /instance/);
});

test("updateBlockDef exact inverses: undo restores name/basePoint/entities/description exactly (incl. key removal)", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: { ...block("A", [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }]), description: "first" } });
  const before = canonicalStringify(d.blockDefByName("A"));
  d.execute({ type: "updateBlockDef", blockId: "blk-000001", patch: { name: "RENAMED", basePoint: { x: 5, y: 5 }, entities: [{ type: "circle", cx: 0, cy: 0, r: 3 }] } });
  assert.equal(d.blockDefByName("RENAMED")!.entities.length, 1);
  d.undo();
  assert.equal(canonicalStringify(d.blockDefByName("A")), before);
  // A patch that REMOVES the description key inverts through the full-record
  // restore (the setBlockDefRecord precedent).
  d.execute({ type: "updateBlockDef", blockId: "blk-000001", patch: { description: null } });
  assert.equal(d.blockDefByName("A")!.description, undefined);
  d.undo();
  assert.equal(d.blockDefByName("A")!.description, "first");
  // Redo converges.
  d.redo();
  assert.equal(d.blockDefByName("A")!.description, undefined);
});

test("removeBlockDef undo restores the definition exactly", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A", [{ type: "circle", cx: 1, cy: 2, r: 3 }]) });
  const before = canonicalStringify(d.blockDefByName("A"));
  d.execute({ type: "removeBlockDef", blockId: "blk-000001" });
  assert.equal(d.blockDefTable.length, 0);
  d.undo();
  assert.equal(canonicalStringify(d.blockDefByName("A")), before);
});

// ---------------------------------------------------------------------------
// Xref lifecycle at the document level.
// ---------------------------------------------------------------------------

test("xref records validate their status invariants (loaded needs a hash; unresolved carries neither)", () => {
  const d = doc();
  assert.throws(() => d.execute({ type: "addXref", xref: { ...xref("X"), status: "loaded", sourceHash: null } }));
  assert.throws(() => d.execute({ type: "addXref", xref: { ...xref("X"), status: "unresolved", sourceHash: "a".repeat(64) } }));
  assert.throws(() => d.execute({ type: "addXref", xref: { ...xref("X"), status: "unresolved", entities: [{ type: "point", x: 0, y: 0 }] } }));
  // Reload (loaded → unresolved → loaded) through updateXref. The failed
  // writes above BURNED minted ids (the never-reuse contract) — resolve
  // the live id from the table.
  d.execute({ type: "addXref", xref: xref("SITE", "site.offisos", "loaded") });
  const siteId = d.xrefByName("SITE")!.id;
  d.execute({ type: "updateXref", xrefId: siteId, patch: { status: "unresolved", sourceHash: null, entities: [] } });
  assert.equal(d.xrefByName("SITE")!.status, "unresolved");
  d.undo();
  assert.equal(d.xrefByName("SITE")!.status, "loaded");
});

test("removeXref is reference-checked: instances block removal (detach is the explicit cascade)", () => {
  const d = doc();
  d.execute({ type: "addXref", xref: xref("SITE") });
  d.execute({
    type: "addElement",
    element: {
      id: "el-000001",
      kind: "geometry",
      engineId: null,
      props: { drafting: true, type: "xref-ref", layer: "0", xrefId: "xr-000001", x: 0, y: 0, scale: 1, rotation: 0 },
    },
  });
  assert.throws(() => d.execute({ type: "removeXref", xrefId: "xr-000001" }), /XDETACH/);
});

// ---------------------------------------------------------------------------
// Snapshot emission + open validation.
// ---------------------------------------------------------------------------

test("snapshot: blockDefs/xrefs are additive-optional (empty tables keep the legacy form byte-identical)", () => {
  const empty = doc();
  const snap = empty.snapshot();
  assert.equal("blockDefs" in snap, false);
  assert.equal("xrefs" in snap, false);
  const legacy = canonicalStringify(snap);
  // A document with an unrelated element edit but no tables stays identical
  // in the table fields.
  empty.execute({ type: "addElement", element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, type: "point", x: 0, y: 0, layer: "0" } } });
  assert.equal("blockDefs" in empty.snapshot(), false);
  // Adding a definition materializes the field.
  empty.execute({ type: "addBlockDef", block: block("A") });
  assert.deepEqual(empty.snapshot().blockDefs!.map((b) => b.name), ["A"]);
  assert.equal("xrefs" in empty.snapshot(), false);
  void legacy;
});

test("save/open round-trip: tables + instances + mint counters survive exactly", () => {
  const d = doc();
  d.execute({ type: "addBlockDef", block: block("A", [{ type: "circle", cx: 0, cy: 0, r: 5 }, { type: "attdef", tag: "T", default: "d", layer: "0", x: 0, y: 0, height: 2, rotation: 0 }], "blk-000001") });
  d.execute({ type: "addXref", xref: xref("SITE", "site.offisos", "loaded") });
  d.execute({
    type: "addElement",
    element: {
      id: "",
      kind: "geometry",
      engineId: null,
      props: { drafting: true, type: "block-ref", layer: "0", blockId: "blk-000001", x: 10, y: 10, scale: 2, rotation: 0.5, attributes: [{ tag: "T", value: "v" }] },
    },
  });
  const snap = d.snapshot();
  const reopened = CADDocument.open(snap, "reopener");
  assert.equal(canonicalStringify(reopened.blockDefTable), canonicalStringify(snap.blockDefs));
  assert.equal(canonicalStringify(reopened.xrefTable), canonicalStringify(snap.xrefs));
  assert.equal(reopened.history.next_block_sequence, snap.modelHistory!.next_block_sequence);
  assert.equal(reopened.history.next_xref_sequence, snap.modelHistory!.next_xref_sequence);
  // Minting continues past the persisted counters.
  reopened.execute({ type: "addBlockDef", block: block("NEXT") });
  assert.equal(reopened.blockDefByName("NEXT")!.id, "blk-000002");
});

test("open rejects corrupt snapshots: dangling instances, cycles, duplicate names, bad records", () => {
  const base = doc();
  base.execute({ type: "addBlockDef", block: block("A") });
  const good = base.snapshot();
  // A dangling instance reference.
  const dangling: typeof good = JSON.parse(JSON.stringify(good));
  dangling.elements = [
    { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "block-ref", layer: "0", blockId: "blk-999999", x: 0, y: 0, scale: 1, rotation: 0 } },
  ];
  assert.throws(() => CADDocument.open(dangling, "x"), /unknown block definition/i);
  // A cyclic definition table.
  const cyclic: typeof good = JSON.parse(JSON.stringify(good));
  cyclic.blockDefs = [
    { ...block("A", [{ type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }], "blk-000001") },
  ];
  assert.throws(() => CADDocument.open(cyclic, "x"), /circular/i);
  // Duplicate names.
  const dupes: typeof good = JSON.parse(JSON.stringify(good));
  dupes.blockDefs = [block("A", [], "blk-000001"), block("A", [], "blk-000002")];
  assert.throws(() => CADDocument.open(dupes, "x"), /duplicate block definition name/i);
  // A malformed inline entity.
  const badEntity: typeof good = JSON.parse(JSON.stringify(good));
  badEntity.blockDefs = [block("A", [{ type: "nonsense" }], "blk-000001")];
  assert.throws(() => CADDocument.open(badEntity, "x"), /blockDef/);
});

test("locked/frozen layer gate applies to instance ELEMENTS (the drafting marker is present)", () => {
  const d = doc();
  d.execute({ type: "addLayer", layer: { id: "ly-000001", name: "LOCKED", color: "#111111", visible: true, locked: true } });
  d.execute({ type: "addLayer", layer: { id: "ly-000002", name: "FROZEN", color: "#111111", visible: true, frozen: true } });
  d.execute({ type: "addBlockDef", block: block("A") });
  assert.throws(
    () =>
      d.execute({
        type: "addElement",
        element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, type: "block-ref", layer: "ly-000002", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 } },
      }),
    /frozen/,
  );
  d.execute({
    type: "addElement",
    element: { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "block-ref", layer: "ly-000001", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 } },
  });
  assert.throws(() => d.execute({ type: "setProps", elementId: "el-000001", patch: { x: 5 } }), /locked/);
  assert.throws(() => d.execute({ type: "removeElement", elementId: "el-000001" }), /locked/);
});

test("one execute = one revision: composite BLOCK conversion batches are single revisions", () => {
  const d = doc();
  d.execute({ type: "addElement", element: { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" } } });
  const revisionsBefore = d.history.revisions.length;
  d.execute({
    type: "applyEdits",
    edits: [
      { type: "addBlockDef", block: block("CONV") },
      { type: "removeElement", elementId: "el-000001" },
    ],
  });
  assert.equal(d.history.revisions.length, revisionsBefore + 1);
  const delta = d.history.revisions[d.history.revisions.length - 1]!.delta;
  assert.deepEqual(delta.removed, ["el-000001"]);
  // Undo restores BOTH together.
  d.undo();
  assert.equal(d.blockDefTable.length, 0);
  assert.equal(d.elementById("el-000001") !== undefined, true);
});
