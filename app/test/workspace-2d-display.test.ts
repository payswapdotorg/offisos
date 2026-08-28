/**
 * CAD-PARITY-004 deterministic display/tests (Issue #80, CAD-2D-004) — the
 * ByLayer display resolution chain, entity.setDisplay semantics (atomicity,
 * validation, lock enforcement), display preservation through modify ops and
 * the CHPROP / MATCHPROP command flows through the prompt engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CADDocument } from "../src/caddocument/index.js";
import { createEntities, modifyEntities, EntityOpError } from "../src/workspace/entity-ops.js";
import { runCommandScript, optionValue } from "../src/workspace/prompt-engine.js";
import { defaultCommandContext, type CommandContext } from "../src/workspace/types.js";
import {
  displayOverridesOf,
  resolveDisplay,
  dashToDevicePx,
  lineweightToDevicePx,
  transparencyToAlpha,
} from "../src/workspace/standards/index.js";
import { commandById } from "../src/workspace/commands.js";
import type { Element, LayerRecord } from "../src/contracts/caddocument.js";

const TOL = 1e-9;

function newDoc(): CADDocument {
  return CADDocument.empty("cp4-display", "offisos-occt", "1", "t");
}

function layerTable(doc: CADDocument): readonly LayerRecord[] {
  return doc.layerTable;
}

function layerExists(doc: CADDocument): (id: string) => boolean {
  return (id) => doc.layerById(id) !== undefined;
}

/** Build a context with the document's layer table (the host contract). */
function ctx(doc: CADDocument, overrides: Partial<CommandContext> = {}): CommandContext {
  return defaultCommandContext({
    layers: layerTable(doc),
    currentSelection: doc.allElements().map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> })),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Display resolution (the ByLayer chain).
// ---------------------------------------------------------------------------

test("resolveDisplay: entity override → layer value → document default", () => {
  const layer: LayerRecord = { id: "ly-000001", name: "WALLS", color: "#b45309", visible: true, linetype: "Dashed", lineweight: 0.5, transparency: 30 };
  // Pure ByLayer.
  const byLayer = resolveDisplay({ color: null, linetype: null, lineweight: null, transparency: null }, layer, undefined, []);
  assert.equal(byLayer.color, "#b45309");
  assert.equal(byLayer.linetype, "Dashed");
  assert.deepEqual(byLayer.dash, [12, 6]);
  assert.equal(byLayer.lineweight, 0.5);
  assert.equal(byLayer.transparency, 30);
  // Overrides win.
  const over = resolveDisplay({ color: "#ff0000", linetype: "Hidden", lineweight: 0.13, transparency: 60 }, layer, undefined, []);
  assert.equal(over.color, "#ff0000");
  assert.equal(over.linetype, "Hidden");
  assert.deepEqual(over.dash, [6, 3]);
  assert.equal(over.lineweight, 0.13);
  assert.equal(over.transparency, 60);
});

test("resolveDisplay: defaults when the layer carries nothing (absent = default)", () => {
  const layer: LayerRecord = { id: "0", name: "0", color: "#111827", visible: true };
  const resolved = resolveDisplay({ color: null, linetype: null, lineweight: null, transparency: null }, layer, undefined, []);
  assert.equal(resolved.linetype, "Continuous");
  assert.deepEqual(resolved.dash, []);
  assert.equal(resolved.lineweight, 0.25);
  assert.equal(resolved.transparency, 0);
  // Standards raise the default lineweight + scale the dashes.
  const scaled = resolveDisplay({ color: null, linetype: null, lineweight: null, transparency: null }, { ...layer, linetype: "Dashed" }, { linetypeScale: 2, defaultLineweight: 0.5 }, []);
  assert.deepEqual(scaled.dash, [24, 12]);
  assert.equal(scaled.lineweight, 0.5);
});

test("resolveDisplay: user-defined linetypes resolve after the catalog", () => {
  const layer: LayerRecord = { id: "0", name: "0", color: "#111827", visible: true, linetype: "MyDash" };
  const user = [{ name: "MyDash", pattern: [8, 4] }];
  assert.deepEqual(resolveDisplay({ color: null, linetype: null, lineweight: null, transparency: null }, layer, undefined, user).dash, [8, 4]);
});

test("displayOverridesOf: honest extraction (malformed reads as ByLayer)", () => {
  assert.deepEqual(displayOverridesOf({}), { color: null, linetype: null, lineweight: null, transparency: null });
  assert.deepEqual(displayOverridesOf({ color: "#dc2626", linetype: "Hidden", lineweight: 0.35, transparency: 40 }), {
    color: "#dc2626",
    linetype: "Hidden",
    lineweight: 0.35,
    transparency: 40,
  });
  // Malformed values read as ByLayer (write paths validate strictly).
  assert.deepEqual(displayOverridesOf({ color: "red", linetype: "", lineweight: "thick", transparency: 200 }), {
    color: null,
    linetype: null,
    lineweight: null,
    transparency: null,
  });
  // The "ByLayer" sentinel resets.
  assert.deepEqual(displayOverridesOf({ color: "ByLayer", linetype: "ByLayer" }), { color: null, linetype: null, lineweight: null, transparency: null });
});

test("device mapping: dash × zoom; lineweight clamped [1,12] px; transparency → alpha", () => {
  assert.deepEqual(dashToDevicePx([12, 6], 0.5), [6, 3]);
  assert.equal(lineweightToDevicePx(0.25, 1, false), 1); // display off → hairline
  assert.equal(lineweightToDevicePx(0.25, 1, true), 1); // 0.5px → clamp 1
  assert.equal(lineweightToDevicePx(2.11, 4, true), Math.min(12, 2.11 * 4 * 2));
  assert.equal(lineweightToDevicePx(5, 100, true), 12); // clamp max
  assert.equal(transparencyToAlpha(0), 1);
  assert.equal(transparencyToAlpha(50), 0.5);
  assert.ok(Math.abs(transparencyToAlpha(90) - 0.1) < TOL);
});

// ---------------------------------------------------------------------------
// entity.setDisplay (the shared entity-ops op).
// ---------------------------------------------------------------------------

function seedLine(doc: CADDocument, layer = "0"): string {
  const outcome = createEntities(doc.allElements(), layerExists(doc), [
    { layer, type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
  ]);
  doc.execute(outcome.edit!);
  return doc.allElements()[0]!.id;
}

test("setDisplay: valid patches apply atomically; ByLayer resets remove fields", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  doc.execute(
    modifyEntities(doc.allElements(), {
      op: "setDisplay",
      ids: [id],
      patch: { color: "#dc2626", linetype: "Hidden", lineweight: 0.35, transparency: 40 },
      layerExists: layerExists(doc),
    }).edit!,
  );
  const props = doc.elementById(id)!.props as Record<string, unknown>;
  assert.equal(props.color, "#dc2626");
  assert.equal(props.linetype, "Hidden");
  assert.equal(props.lineweight, 0.35);
  assert.equal(props.transparency, 40);
  // Reset to ByLayer — the fields disappear (absent = ByLayer).
  doc.execute(
    modifyEntities(doc.allElements(), {
      op: "setDisplay",
      ids: [id],
      patch: { color: "ByLayer", linetype: "ByLayer", lineweight: "ByLayer", transparency: "ByLayer" },
      layerExists: layerExists(doc),
    }).edit!,
  );
  const props2 = doc.elementById(id)!.props as Record<string, unknown>;
  assert.equal(props2.color, undefined);
  assert.equal(props2.linetype, undefined);
  assert.equal(props2.lineweight, undefined);
  assert.equal(props2.transparency, undefined);
});

test("setDisplay: typed validation failures (color/linetype/lineweight/transparency/layer)", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  const attempt = (patch: Record<string, unknown>, code: string) => {
    try {
      modifyEntities(doc.allElements(), { op: "setDisplay", ids: [id], patch, layerExists: layerExists(doc), ltypeResolves: () => false });
      assert.fail(`expected ${code}`);
    } catch (e) {
      assert.ok(e instanceof EntityOpError);
      assert.equal((e as EntityOpError).code, code);
    }
  };
  attempt({ color: "red" }, "bad_input");
  attempt({ linetype: "Ghost" }, "bad_linetype");
  attempt({ lineweight: 0.26 }, "bad_input");
  attempt({ transparency: 95 }, "bad_input");
  attempt({ layer: "ly-ghost" }, "bad_layer");
  attempt({ bogus: 1 }, "bad_input");
  // Empty ids rejected.
  try {
    modifyEntities(doc.allElements(), { op: "setDisplay", ids: [], patch: { color: "#dc2626" } });
    assert.fail("expected bad_input");
  } catch (e) {
    assert.equal((e as EntityOpError).code, "bad_input");
  }
});

test("setDisplay: layer reassignment moves the entity (id preserved)", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "TARGET", color: "#15803d", visible: true } });
  const id = seedLine(doc, "0");
  doc.execute(
    modifyEntities(doc.allElements(), { op: "setDisplay", ids: [id], patch: { layer: "ly-000001" }, layerExists: layerExists(doc) }).edit!,
  );
  assert.equal(doc.elementById(id)!.props.layer, "ly-000001");
});

test("setDisplay: ONE atomic revision for a batch (single undo reverts all)", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "L2", color: "#111827", visible: true } });
  const a = seedLine(doc, "0");
  const outcome = createEntities(doc.allElements(), layerExists(doc), [{ layer: "ly-000001", type: "line", x1: 0, y1: 0, x2: 50, y2: 0 }]);
  doc.execute(outcome.edit!);
  const b = doc.allElements().find((el) => el.id !== a)!.id;
  const before = doc.history.revisions.length;
  doc.execute(
    modifyEntities(doc.allElements(), {
      op: "setDisplay",
      ids: [a, b],
      patch: { color: "#dc2626", lineweight: 0.5 },
      layerExists: layerExists(doc),
    }).edit!,
  );
  assert.equal(doc.history.revisions.length, before + 1);
  assert.equal((doc.elementById(a)!.props as Record<string, unknown>).color, "#dc2626");
  assert.equal((doc.elementById(b)!.props as Record<string, unknown>).color, "#dc2626");
  doc.undo();
  assert.equal((doc.elementById(a)!.props as Record<string, unknown>).color, undefined);
  assert.equal((doc.elementById(b)!.props as Record<string, unknown>).color, undefined);
});

// ---------------------------------------------------------------------------
// Display preservation through modify operations (the directed regression).
// ---------------------------------------------------------------------------

test("display overrides are PRESERVED through move/rotate/scale/mirror/offset geometry ops", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  doc.execute(
    modifyEntities(doc.allElements(), { op: "setDisplay", ids: [id], patch: { color: "#dc2626", linetype: "Hidden", lineweight: 0.35, transparency: 30 }, layerExists: layerExists(doc) }).edit!,
  );
  doc.execute(modifyEntities(doc.allElements(), { op: "move", ids: [id], dx: 10, dy: 0 }).edit!);
  let props = doc.elementById(id)!.props as Record<string, unknown>;
  assert.equal(props.color, "#dc2626");
  assert.equal(props.linetype, "Hidden");
  assert.equal(props.lineweight, 0.35);
  assert.equal(props.transparency, 30);
  assert.equal(props.x1, 10); // moved

  doc.execute(modifyEntities(doc.allElements(), { op: "rotate", ids: [id], base: { x: 0, y: 0 }, angle: Math.PI / 2 }).edit!);
  doc.execute(modifyEntities(doc.allElements(), { op: "scale", ids: [id], base: { x: 0, y: 0 }, factor: 2 }).edit!);
  props = doc.elementById(id)!.props as Record<string, unknown>;
  assert.equal(props.color, "#dc2626");
  assert.equal(props.linetype, "Hidden");

  // Copies inherit the display overrides.
  const copy = modifyEntities(doc.allElements(), { op: "copy", ids: [id], dx: 5, dy: 5 });
  doc.execute(copy.edit!);
  const created = doc.allElements().find((el) => el.id !== id)!;
  const cProps = created.props as Record<string, unknown>;
  assert.equal(cProps.color, "#dc2626");
  assert.equal(cProps.linetype, "Hidden");
  assert.equal(cProps.lineweight, 0.35);
});

test("createEntities: display overrides on creation (validated; absent = ByLayer)", () => {
  const doc = newDoc();
  const outcome = createEntities(doc.allElements(), layerExists(doc), [
    { layer: "0", type: "line", x1: 0, y1: 0, x2: 10, y2: 0, color: "#0e7490", linetype: "Center", lineweight: 0.5, transparency: 20 },
  ]);
  doc.execute(outcome.edit!);
  const props = doc.allElements()[0]!.props as Record<string, unknown>;
  assert.equal(props.color, "#0e7490");
  assert.equal(props.linetype, "Center");
  assert.equal(props.lineweight, 0.5);
  assert.equal(props.transparency, 20);
  // Invalid overrides rejected at creation.
  assert.throws(
    () => createEntities(doc.allElements(), layerExists(doc), [{ layer: "0", type: "point", x: 1, y: 1, color: "blue" }]),
    /color must be/i,
  );
});

// ---------------------------------------------------------------------------
// CHPROP + MATCHPROP command flows (the prompt engine).
// ---------------------------------------------------------------------------

test("CHPROP: P (previous selection) → Color → hex applies through entity.setDisplay", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  const context = () => ctx(doc, { currentSelection: [{ id, kind: "geometry", props: doc.elementById(id)!.props as Record<string, unknown> }] });
  const plans = [];
  const result = runCommandScript(
    [
      { event: { type: "typed", text: "CHPROP" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "C" } },
      { event: { type: "typed", text: "#dc2626" } },
      { event: { type: "enter" } },
    ],
    context(),
    (plan) => plans.push(plan),
  );
  assert.equal(result.lines.includes("*Cancel*"), false);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.appApi[0]!.name, "entity.setDisplay");
  assert.deepEqual(plans[0]!.appApi[0]!.payload, { ids: [id], patch: { color: "#dc2626" } });
  // Apply it and verify.
  doc.execute(
    modifyEntities(doc.allElements(), { op: "setDisplay", ids: [id], patch: { color: "#dc2626" }, layerExists: layerExists(doc) }).edit!,
  );
  assert.equal((doc.elementById(id)!.props as Record<string, unknown>).color, "#dc2626");
});

test("CHPROP: multiple properties collected then applied as ONE patch", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  const selection = [{ id, kind: "geometry", props: doc.elementById(id)!.props as Record<string, unknown> }];
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "CHPROP" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "LT" } },
      { event: { type: "typed", text: "Hidden" } },
      { event: { type: "typed", text: "LW" } },
      { event: { type: "typed", text: "0.5" } },
      { event: { type: "typed", text: "T" } },
      { event: { type: "typed", text: "40" } },
      { event: { type: "enter" } },
    ],
    ctx(doc, { currentSelection: selection }),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as { ids: string[]; patch: Record<string, unknown> };
  assert.equal(payload.ids.length, 1);
  assert.equal(payload.patch.linetype, "Hidden");
  assert.equal(payload.patch.lineweight, 0.5);
  assert.equal(payload.patch.transparency, 40);
});

test("CHPROP: invalid values echo honest skips (nothing half-applied)", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  const selection = [{ id, kind: "geometry", props: doc.elementById(id)!.props as Record<string, unknown> }];
  const plans = [];
  const result = runCommandScript(
    [
      { event: { type: "typed", text: "CHPROP" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "C" } },
      { event: { type: "typed", text: "not-a-color" } },
      { event: { type: "enter" } },
    ],
    ctx(doc, { currentSelection: selection }),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1); // an echo-only plan (empty appApi — nothing applied)
  assert.equal(plans[0]!.appApi.length, 0);
  assert.ok(result.lines.some((l) => l.includes("not a color")));
});

test("MATCHPROP: source display + layer copied onto targets as ONE patch", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "SRC", color: "#0e7490", visible: true } });
  // Source with overrides on a named layer.
  const source = createEntities(doc.allElements(), layerExists(doc), [
    { layer: "ly-000001", type: "line", x1: 0, y1: 0, x2: 10, y2: 0, color: "#dc2626", linetype: "Dashed", lineweight: 0.5, transparency: 25 },
  ]);
  doc.execute(source.edit!);
  const sourceId = doc.allElements()[0]!.id;
  // Target on layer 0.
  const target = createEntities(doc.allElements(), layerExists(doc), [{ layer: "0", type: "line", x1: 0, y1: 0, x2: 5, y2: 0 }]);
  doc.execute(target.edit!);
  const targetId = doc.allElements().find((el) => el.id !== sourceId)!.id;

  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "MATCHPROP" } },
      { event: { type: "entity", entity: { id: sourceId, kind: "geometry", props: doc.elementById(sourceId)!.props as Record<string, unknown> } } },
      { event: { type: "entity", entity: { id: targetId, kind: "geometry", props: doc.elementById(targetId)!.props as Record<string, unknown> } } },
      { event: { type: "enter" } },
    ],
    ctx(doc),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as { ids: string[]; patch: Record<string, unknown> };
  assert.deepEqual(payload.ids, [targetId]);
  assert.equal(payload.patch.color, "#dc2626");
  assert.equal(payload.patch.linetype, "Dashed");
  assert.equal(payload.patch.lineweight, 0.5);
  assert.equal(payload.patch.transparency, 25);
  assert.equal(payload.patch.layer, "ly-000001");
});

// ---------------------------------------------------------------------------
// -LAYER / CLAYER / LAYISO / LAYON / LTSCALE flows.
// ---------------------------------------------------------------------------

test("-LAYER: Make creates + sets active; Set resolves by name", () => {
  const doc = newDoc();
  const plans = [];
  const context = () => ctx(doc);
  runCommandScript(
    [
      { event: { type: "typed", text: "-LAYER" } },
      { event: { type: "typed", text: "M" } },
      { event: { type: "typed", text: "NewLayer" } },
      { event: { type: "enter" } },
    ],
    context(),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, { name: "NewLayer", makeActive: true });
  // Apply through the document + settings.
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "NewLayer", color: "#111827", visible: true } });
  doc.setDraftingSettings({ ...doc.draftingSettings, activeLayer: "ly-000001" });
  assert.equal(doc.draftingSettings.activeLayer, "ly-000001");

  // Set by name through the next run.
  const plans2 = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "-LAYER" } },
      { event: { type: "typed", text: "S" } },
      { event: { type: "typed", text: "0" } },
      { event: { type: "enter" } },
    ],
    ctx(doc),
    (plan) => plans2.push(plan),
  );
  assert.deepEqual(plans2[0]!.appApi[0]!.payload, { layerId: "0" });
});

test("-LAYER: ON/OFF/Freeze/Thaw/Lock/Unlock with names and '*'; OFF '*' declined", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "L1", color: "#111827", visible: false } });
  doc.execute({ type: "addLayer", layer: { id: "ly-000002", name: "L2", color: "#111827", visible: true } });
  const plans = [];
  const result = runCommandScript(
    [
      { event: { type: "typed", text: "-LA" } },
      { event: { type: "typed", text: "ON" } },
      { event: { type: "typed", text: "*" } },
      { event: { type: "typed", text: "OFF" } },
      { event: { type: "typed", text: "*" } },
      { event: { type: "typed", text: "L" } },
      { event: { type: "typed", text: "L1" } },
      { event: { type: "enter" } },
    ],
    ctx(doc),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  const appApi = plans[0]!.appApi;
  // ALL state ops merge into ONE atomic applyEdits batch: ON * (3 layers)
  // + Lock L1 (the declined OFF '*' contributes nothing).
  assert.equal(appApi.length, 1);
  assert.equal(appApi[0]!.name, "document.applyEdit");
  const edits = (appApi[0]!.payload as { edit: { edits: readonly { layerId: string; patch: Record<string, unknown> }[] } }).edit.edits;
  assert.equal(edits.length, 4); // 0, L1, L2 turned on + L1 locked
  const onEdits = edits.filter((e) => e.patch.visible === true);
  assert.equal(onEdits.length, 3);
  // OFF * declined with the honest echo.
  assert.ok(result.lines.some((l) => l.includes("cannot turn off every layer")));
  // Lock L1 → the last edit carries {locked:true}.
  const lockEdit = edits.find((e) => e.patch.locked === true);
  assert.equal(lockEdit!.layerId, "ly-000001");
});

test("LAYISO builds the isolate payload from the picked layers; LAYUNISO restores", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "KEEP", color: "#111827", visible: true } });
  const outcome = createEntities(doc.allElements(), layerExists(doc), [
    { layer: "ly-000001", type: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
  ]);
  doc.execute(outcome.edit!);
  const pick = doc.allElements()[0]!;
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "LAYISO" } },
      { event: { type: "entity", entity: { id: pick.id, kind: "geometry", props: pick.props as Record<string, unknown> } } },
      { event: { type: "enter" } },
    ],
    ctx(doc),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, { layerIds: ["ly-000001"] });
  // The semantic core: isolate = save *ISOLATE* state + hide others.
  doc.execute({ type: "addLayerState", state: { name: "*ISOLATE*", layers: [{ layerId: "0", visible: true, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true }, { layerId: "ly-000001", visible: true, frozen: false, locked: false, color: "#111827", linetype: "Continuous", lineweight: 0.25, transparency: 0, plot: true }] } });
  doc.execute({ type: "updateLayer", layerId: "0", patch: { visible: false } });
  assert.equal(doc.layerById("0")!.visible, false);
  // Unisolate: restore edits + remove the state.
  const saved = doc.layerStateByName("*ISOLATE*")!;
  doc.execute({ type: "applyEdits", edits: [...saved.layers.map((e) => ({ type: "updateLayer" as const, layerId: e.layerId, patch: { visible: e.visible } })), { type: "removeLayerState", stateName: "*ISOLATE*" }] });
  assert.equal(doc.layerById("0")!.visible, true);
  assert.equal(doc.layerStateByName("*ISOLATE*"), undefined);
});

test("LAYON: one applyEdit batch turning every layer on", () => {
  const doc = newDoc();
  doc.execute({ type: "addLayer", layer: { id: "ly-000001", name: "L1", color: "#111827", visible: false } });
  const cmd = commandById("layon")!;
  const plan = cmd.instant!(ctx(doc));
  assert.equal(plan.appApi[0]!.name, "document.applyEdit");
  const edits = (plan.appApi[0]!.payload as { edit: { edits: readonly unknown[] } }).edit.edits;
  assert.equal(edits.length, 2);
  doc.execute((plan.appApi[0]!.payload as { edit: Parameters<CADDocument["execute"]>[0] }).edit);
  assert.ok(doc.layerTable.every((l) => l.visible));
});

test("LTSCALE: the standards patch flows through drafting.setSettings", () => {
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "LTSCALE" } },
      { event: { type: "typed", text: "2.5" } },
    ],
    defaultCommandContext(),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, { settings: { standards: { linetypeScale: 2.5 } } });
});

test("the CHPROP/MATCHPROP/LAYER commands are keyboard + palette reachable (registry)", () => {
  assert.ok(commandById("chprop")!.ribbonTab === "Home");
  assert.ok(commandById("matchprop")!.aliases.includes("MA"));
  assert.ok(commandById("layercli")!.name === "-LAYER");
  assert.ok(commandById("clayer")!.steps.length === 1);
  assert.ok(commandById("layiso")!.steps.length > 0);
  assert.ok(commandById("layuniso")!.instant !== undefined);
  assert.ok(commandById("layon")!.instant !== undefined);
  assert.ok(commandById("layerstate")!.instant !== undefined);
  assert.ok(commandById("linetype")!.aliases.includes("LT"));
  assert.ok(commandById("textstyle")!.name === "STYLE");
  assert.ok(commandById("dimstyle")!.aliases.includes("D"));
  assert.ok(commandById("ltscale")!.aliases.includes("LTS"));
  assert.ok(commandById("lweight")!.aliases.includes("LW"));
});

// ---------------------------------------------------------------------------
// Determinism double-run.
// ---------------------------------------------------------------------------

test("determinism: CHPROP flows produce byte-identical plans on double-run", () => {
  const doc = newDoc();
  const id = seedLine(doc);
  const selection = [{ id, kind: "geometry", props: doc.elementById(id)!.props as Record<string, unknown> }];
  const run = (): string => {
    const plans = [];
    runCommandScript(
      [
        { event: { type: "typed", text: "CHPROP" } },
        { event: { type: "typed", text: "P" } },
        { event: { type: "enter" } },
        { event: { type: "typed", text: "C" } },
        { event: { type: "typed", text: "#0e7490" } },
        { event: { type: "enter" } },
      ],
      ctx(doc, { currentSelection: selection }),
      (plan) => plans.push(plan),
    );
    return JSON.stringify(plans);
  };
  assert.equal(run(), run());
});
