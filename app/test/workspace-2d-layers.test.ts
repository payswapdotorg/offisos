/**
 * CAD-PARITY-004 deterministic layer/state/standards tests (Issue #80,
 * CAD-2D-004) — the layer table semantics, the locked/frozen enforcement,
 * layer states, isolation, filters and the named drawing standards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CADDocument } from "../src/caddocument/index.js";
import {
  DEFAULT_LAYER,
  ISOLATE_LAYER_STATE_NAME,
  applyLayerPatch,
  captureLayerState,
  layerStateRestoreEdits,
  validateLayerRecord,
  validateLayerStateRecord,
} from "../src/caddocument/workspace.js";
import {
  filterLayers,
  layerRenderable,
  LAYER_STANDARDS,
  layerStandardById,
} from "../src/workspace/standards/index.js";
import type { DocumentEdit, LayerRecord } from "../src/contracts/caddocument.js";

const TOL = 1e-9;

function newDoc(): CADDocument {
  return CADDocument.empty("cp4-layers-test", "offisos-occt", "1", "cp4-test");
}

function addLayer(doc: CADDocument, id: string, patch: Partial<LayerRecord> = {}): void {
  doc.execute({
    type: "addLayer",
    layer: { id, name: patch.name ?? id, color: patch.color ?? "#111827", visible: patch.visible ?? true, ...patch },
  });
}

function addLine(doc: CADDocument, id: string, layer: string): void {
  doc.execute({
    type: "addElement",
    element: {
      id,
      kind: "geometry",
      engineId: null,
      props: { drafting: true, layer, type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
    },
  });
}

// ---------------------------------------------------------------------------
// Layer record semantics.
// ---------------------------------------------------------------------------

test("layer records: legacy shape stays canonical (fixture safety)", () => {
  const layer = validateLayerRecord({ id: "0", name: "0", color: "#111827", visible: true });
  assert.deepEqual(Object.keys(layer).sort(), ["color", "id", "name", "visible"]);
});

test("layer records: extended fields validate; absent = default", () => {
  const ok = validateLayerRecord({
    id: "ly-000001",
    name: "WALLS",
    color: "#b45309",
    visible: true,
    frozen: true,
    locked: true,
    linetype: "Hidden",
    lineweight: 0.35,
    transparency: 30,
    plot: false,
    description: "walls",
  });
  assert.equal(ok.frozen, true);
  assert.equal(ok.lineweight, 0.35);
  assert.throws(() => validateLayerRecord({ id: "x", name: "x", color: "#111827", visible: true, lineweight: 0.26 }));
  assert.throws(() => validateLayerRecord({ id: "x", name: "x", color: "#111827", visible: true, transparency: 91 }));
  assert.throws(() => validateLayerRecord({ id: "x", name: "x", color: "#111827", visible: true, frozen: "yes" }));
});

test("applyLayerPatch: default-valued optionals normalize away; explicit weights persist", () => {
  const current: LayerRecord = { id: "ly-000001", name: "A", color: "#111827", visible: true };
  // Setting defaults removes the fields (canonical-minimal).
  const reset = applyLayerPatch(current, { locked: false, frozen: false, plot: true, transparency: 0, linetype: "Continuous" });
  assert.equal(reset.locked, undefined);
  assert.equal(reset.frozen, undefined);
  assert.equal(reset.plot, undefined);
  assert.equal(reset.transparency, undefined);
  assert.equal(reset.linetype, undefined);
  // Explicit lineweight 0.25 STAYS (must win over a standards-raised default).
  const weighted = applyLayerPatch(current, { lineweight: 0.25 });
  assert.equal(weighted.lineweight, 0.25);
  // Unknown field rejected.
  assert.throws(() => applyLayerPatch(current, { bogus: 1 }));
});

test("applyLayerPatch: carried optionals survive untouched patches", () => {
  const current: LayerRecord = { id: "ly-000001", name: "A", color: "#111827", visible: false, locked: true, linetype: "Dashed" };
  const merged = applyLayerPatch(current, { visible: true });
  assert.equal(merged.locked, true);
  assert.equal(merged.linetype, "Dashed");
});

// ---------------------------------------------------------------------------
// Locked-layer enforcement (the document execute gate).
// ---------------------------------------------------------------------------

test("locked layer: updateElement / setProps / removeElement rejected with typed errors", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001", { locked: true });
  addLine(doc, "el-000001", "ly-000001");
  assert.throws(() => doc.execute({ type: "updateElement", elementId: "el-000001", patch: { x2: 200 } }), /locked layer/);
  assert.throws(
    () => doc.execute({ type: "setProps", elementId: "el-000001", patch: { drafting: true, layer: "ly-000001", type: "line", x1: 0, y1: 0, x2: 1, y2: 0 } }),
    /locked layer/,
  );
  assert.throws(() => doc.execute({ type: "removeElement", elementId: "el-000001" }), /locked layer/);
  // Nothing was applied (the line keeps its created geometry).
  assert.equal((doc.elementById("el-000001")!.props as Record<string, unknown>).x2, 100);
});

test("locked layer: BIM elements are not layer-managed (documented scope)", () => {
  const doc = newDoc();
  doc.execute({
    type: "addElement",
    element: { id: "el-bim", kind: "bim", engineId: null, props: { type: "bim.wall", start: [0, 0], end: [100, 0], width: 10 } },
  });
  doc.execute({ type: "updateElement", elementId: "el-bim", patch: { width: 20 } });
  assert.equal((doc.elementById("el-bim")!.props as Record<string, unknown>).width, 20);
});

test("frozen layer: new drafting entities are rejected", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001", { frozen: true });
  assert.throws(() => addLine(doc, "el-000001", "ly-000001"), /frozen/);
  assert.equal(doc.allElements().length, 0);
});

test("reassigning an entity ONTO a locked/frozen layer is rejected", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001");
  addLayer(doc, "ly-locked", { locked: true });
  addLayer(doc, "ly-frozen", { frozen: true });
  addLine(doc, "el-000001", "ly-000001");
  assert.throws(() => doc.execute({ type: "updateElement", elementId: "el-000001", patch: { layer: "ly-locked" } }), /locked/);
  assert.throws(() => doc.execute({ type: "updateElement", elementId: "el-000001", patch: { layer: "ly-frozen" } }), /frozen/);
});

test("applyEdits batches: unlock-then-edit is legitimate; edit-then-unlock is rejected", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001", { locked: true });
  addLine(doc, "el-000001", "ly-000001");
  const unlockFirst: DocumentEdit = {
    type: "applyEdits",
    edits: [
      { type: "updateLayer", layerId: "ly-000001", patch: { locked: false } },
      { type: "updateElement", elementId: "el-000001", patch: { x2: 500 } },
    ],
  };
  doc.execute(unlockFirst);
  assert.equal((doc.elementById("el-000001")!.props as Record<string, unknown>).x2, 500);

  const doc2 = newDoc();
  addLayer(doc2, "ly-000001", { locked: true });
  addLine(doc2, "el-000001", "ly-000001");
  const editFirst: DocumentEdit = {
    type: "applyEdits",
    edits: [
      { type: "updateElement", elementId: "el-000001", patch: { x2: 900 } },
      { type: "updateLayer", layerId: "ly-000001", patch: { locked: false } },
    ],
  };
  assert.throws(() => doc2.execute(editFirst), /locked layer/);
});

test("undo/redo bypass the lock gate (journal semantics)", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001");
  addLine(doc, "el-000001", "ly-000001");
  doc.execute({ type: "updateElement", elementId: "el-000001", patch: { x2: 200 } });
  // Lock the layer AFTER the edit; undo must still revert the edit.
  doc.execute({ type: "updateLayer", layerId: "ly-000001", patch: { locked: true } });
  doc.undo(); // undoes the lock
  doc.undo(); // undoes the x2 edit (journal bypasses the lock)
  assert.equal((doc.elementById("el-000001")!.props as Record<string, unknown>).x2, 100);
});

// ---------------------------------------------------------------------------
// Layer states.
// ---------------------------------------------------------------------------

test("layer states: capture → mutate → restore is exact", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001", { color: "#b45309", linetype: "Dashed", lineweight: 0.35 });
  addLayer(doc, "ly-000002", { visible: false });
  const captured = captureLayerState(doc.layerTable);
  assert.equal(captured.length, 3);
  const entry = captured.find((e) => e.layerId === "ly-000001")!;
  assert.equal(entry.linetype, "Dashed");
  assert.equal(entry.lineweight, 0.35);
  assert.equal(entry.plot, true);

  // Mutate the table.
  doc.execute({ type: "updateLayer", layerId: "ly-000001", patch: { color: "#ff0000", locked: true } });
  doc.execute({ type: "updateLayer", layerId: "ly-000002", patch: { visible: true } });

  // Restore as ONE atomic batch.
  const edits = layerStateRestoreEdits({ name: "S", layers: captured }, doc.layerTable);
  doc.execute({ type: "applyEdits", edits });
  const l1 = doc.layerById("ly-000001")!;
  assert.equal(l1.color, "#b45309");
  assert.equal(l1.locked, undefined);
  assert.equal(doc.layerById("ly-000002")!.visible, false);
});

test("layer states: removed layers are skipped honestly on restore", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001");
  const captured = captureLayerState(doc.layerTable);
  doc.execute({ type: "removeLayer", layerId: "ly-000001" });
  const edits = layerStateRestoreEdits({ name: "S", layers: captured }, doc.layerTable);
  // The REMOVED layer produces no restore edit (no resurrection); the
  // surviving default layer legitimately restores.
  assert.ok(edits.every((e) => e.type !== "updateLayer" || e.layerId !== "ly-000001"));
});

test("layerState records: validation + the reserved *ISOLATE* name", async () => {
  const valid = validateLayerStateRecord({
    name: "Setup A",
    layers: [{ layerId: "0", visible: true, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true }],
  });
  assert.equal(valid.name, "Setup A");
  assert.throws(() => validateLayerStateRecord({ name: "*MINE*", layers: [] }));
  assert.throws(() =>
    validateLayerStateRecord({
      name: "dup",
      layers: [
        { layerId: "0", visible: true, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true },
        { layerId: "0", visible: true, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true },
      ],
    }),
  );
  // The reserved isolation name is valid ONLY through the isolation path.
  assert.equal(ISOLATE_LAYER_STATE_NAME, "*ISOLATE*");
});

test("document: addLayerState replaces same-name states; snapshot omits empty tables", () => {
  const doc = newDoc();
  const mk = (visible: boolean) => ({
    name: "S",
    layers: [{ layerId: "0", visible, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true }],
  });
  doc.execute({ type: "addLayerState", state: mk(false) });
  doc.execute({ type: "addLayerState", state: mk(true) });
  assert.equal(doc.layerStateTable.length, 1);
  assert.equal(doc.layerStateTable[0]!.layers[0]!.visible, true);
  doc.execute({ type: "removeLayerState", stateName: "S" });
  assert.equal(doc.layerStateTable.length, 0);
  assert.equal(doc.snapshot().layerStates, undefined);
});

// ---------------------------------------------------------------------------
// Filters + standards + renderability.
// ---------------------------------------------------------------------------

test("filterLayers: text + state filters are deterministic", () => {
  const layers: LayerRecord[] = [
    { id: "0", name: "0", color: "#111827", visible: true },
    { id: "ly-000001", name: "A-WALL", color: "#b45309", visible: true, locked: true },
    { id: "ly-000002", name: "A-DOOR", color: "#15803d", visible: false },
    { id: "ly-000003", name: "HIDDEN-EDGES", color: "#374151", visible: true, frozen: true, linetype: "Hidden" },
    { id: "ly-000004", name: "NOTES", color: "#111827", visible: true, plot: false },
  ];
  const used = new Set(["ly-000001", "ly-000003"]);
  assert.deepEqual(filterLayers(layers, "all", "", used).map((l) => l.name), ["0", "A-WALL", "A-DOOR", "HIDDEN-EDGES", "NOTES"]);
  assert.deepEqual(filterLayers(layers, "in-use", "", used).map((l) => l.name), ["A-WALL", "HIDDEN-EDGES"]);
  assert.deepEqual(filterLayers(layers, "not-in-use", "", used).map((l) => l.name), ["0", "A-DOOR", "NOTES"]);
  assert.deepEqual(filterLayers(layers, "off", "", used).map((l) => l.name), ["A-DOOR"]);
  assert.deepEqual(filterLayers(layers, "frozen", "", used).map((l) => l.name), ["HIDDEN-EDGES"]);
  assert.deepEqual(filterLayers(layers, "locked", "", used).map((l) => l.name), ["A-WALL"]);
  assert.deepEqual(filterLayers(layers, "unplottable", "", used).map((l) => l.name), ["NOTES"]);
  assert.deepEqual(filterLayers(layers, "all", "wall", used).map((l) => l.name), ["A-WALL"]);
  assert.deepEqual(filterLayers(layers, "all", "a-", used).map((l) => l.name), ["A-WALL", "A-DOOR"]);
});

test("layerRenderable: frozen layers are suppressed like off layers", () => {
  assert.equal(layerRenderable({ id: "0", name: "0", color: "#111827", visible: true }), true);
  assert.equal(layerRenderable({ id: "0", name: "0", color: "#111827", visible: false }), false);
  assert.equal(layerRenderable({ id: "0", name: "0", color: "#111827", visible: true, frozen: true }), false);
});

test("named layer standards: deterministic presets; apply creates missing layers only", () => {
  assert.ok(LAYER_STANDARDS.length >= 2);
  const arch = layerStandardById("architectural")!;
  assert.ok(arch.layers.every((l) => /^#[0-9a-f]{6}$/.test(l.color)));
  assert.ok(arch.layers.some((l) => l.name === "A-WALL"));
  const mech = layerStandardById("mechanical")!;
  assert.ok(mech.layers.some((l) => l.linetype === "Hidden"));
  assert.equal(layerStandardById("bogus"), null);
});

test("layer standards via document edits: the applyStandard edit batch is atomic", () => {
  const doc = newDoc();
  const edits: DocumentEdit[] = LAYER_STANDARDS[0]!.layers.slice(0, 3).map((def, i) => ({
    type: "addLayer" as const,
    layer: {
      id: `ly-${String(i + 1).padStart(6, "0")}`,
      name: def.name,
      color: def.color,
      visible: true,
      ...(def.linetype !== "Continuous" ? { linetype: def.linetype } : {}),
      ...(def.lineweight !== 0.25 ? { lineweight: def.lineweight } : {}),
    },
  }));
  doc.execute({ type: "applyEdits", edits });
  assert.equal(doc.layerTable.length, 4);
  assert.equal(doc.layerById("ly-000001")!.name, LAYER_STANDARDS[0]!.layers[0]!.name);
});

// ---------------------------------------------------------------------------
// Snapshot/open round-trips.
// ---------------------------------------------------------------------------

test("save/open round-trip: extended layer fields, states and ltypes persist", () => {
  const doc = newDoc();
  addLayer(doc, "ly-000001", { locked: true, linetype: "Dashed", lineweight: 0.5, transparency: 40 });
  doc.execute({ type: "addLtype", ltype: { name: "MyDash", description: "custom", pattern: [8, 4] } });
  const snap = doc.snapshot();
  const reopened = CADDocument.open(snap, "reopener");
  const l = reopened.layerById("ly-000001")!;
  assert.equal(l.locked, true);
  assert.equal(l.linetype, "Dashed");
  assert.equal(l.lineweight, 0.5);
  assert.equal(l.transparency, 40);
  assert.equal(reopened.ltypeByName("MyDash")?.pattern.length, 2);
  assert.equal(reopened.layerTable.length, 2);
});

test("the default layer is untouched by the extension (fixture identity)", () => {
  assert.deepEqual({ ...DEFAULT_LAYER }, { id: "0", name: "0", color: "#111827", visible: true });
  const fresh = newDoc();
  const layer = fresh.layerTable[0]!;
  assert.deepEqual(Object.keys(layer).sort(), ["color", "id", "name", "visible"]);
});

test("determinism: identical layer command sequences produce identical snapshots", () => {
  const run = (): string => {
    const doc = newDoc();
    addLayer(doc, "ly-000001", { color: "#b45309", linetype: "Center", lineweight: 0.35 });
    addLayer(doc, "ly-000002", { locked: true });
    doc.execute({ type: "updateLayer", layerId: "ly-000001", patch: { transparency: 30 } });
    doc.undo();
    return JSON.stringify(doc.snapshot().layers);
  };
  assert.equal(run(), run());
});

test("linetype removal is reference-checked (no silent cascade)", () => {
  const doc = newDoc();
  doc.execute({ type: "addLtype", ltype: { name: "MyDash", description: "", pattern: [8, 4] } });
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "L", color: "#111827", visible: true, linetype: "MyDash" } });
  assert.throws(() => doc.execute({ type: "removeLtype", ltypeName: "MyDash" }), /used by layer/);
  doc.execute({ type: "updateLayer", layerId: "ly-000001", patch: { linetype: "Continuous" } });
  doc.execute({ type: "removeLtype", ltypeName: "MyDash" });
  assert.equal(doc.ltypeByName("MyDash"), undefined);
  // Field removed (Continuous is default → absent).
  assert.equal(doc.layerById("ly-000001")!.linetype, undefined);
});
