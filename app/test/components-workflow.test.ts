/**
 * COMPAT-BIM-003 — the representative component/material/coordination
 * workflow end to end through the App API: Definitions → Instances →
 * Materials → Grids/Reference Planes → Parametric propagation → Revisions →
 * IFC round-trip → Construction Graph (Issue #50 acceptance criteria).
 *
 * Engine-free parts use the dummy bundle; the IFC round-trip uses the real
 * toolchain bundle and skips with a recorded reason when unavailable
 * (ifc-availability.ts precedent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { bridgeModelHistory, graphNodeId } from "../src/graph/index.js";
import { ifcSkip } from "./ifc-availability.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const skipIfc = await ifcSkip();

const TOL = 1e-3; // declared round-trip tolerance (mm)

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false);
  return r as unknown as { code: string; message: string };
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}
async function qq(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "query", name: name as never, payload });
}

function dummy(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: DummyAdapterBundle,
    entityId: "components-workflow",
    format: "offisos-dummy",
    formatVersion: "1",
    createdBy: "components-test",
  });
}

function ifcHandler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "components-ifc",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "components-ifc-test",
  });
}

interface ComponentInventory {
  materials: { elementId: string; name: string; properties: Record<string, unknown> }[];
  definitions: { elementId: string; name: string; category: string; parameters: Record<string, number> }[];
  instances: {
    elementId: string; definitionId: string; storyId: string;
    position: [number, number]; rotation: number; baseOffset: number;
    overrides: Record<string, number>;
    effectiveParameters: Record<string, number>;
    effectiveBox: [number, number, number];
    effectiveMaterialId: string | null;
  }[];
  grids: { elementId: string; storyId: string; name: string; uLines: number[]; vLines: number[] }[];
  referencePlanes: { elementId: string; storyId: string; name: string; start: [number, number]; end: [number, number] }[];
  unsupported: Record<string, string>;
}

async function inventory(h: AppApiHandler): Promise<ComponentInventory> {
  return val<ComponentInventory>(await qq(h, "bim.getComponents", {}));
}

/** Author the representative component model: two materials, three
 *  definitions (wall/door/furniture), five instances (one with overrides),
 *  a structural grid and a reference plane on the ground floor story. */
async function authorComponents(h: AppApiHandler): Promise<Record<string, string>> {
  await cmd(h, "document.create", { entityId: "component-model" });
  const created = val<{ created: string[] }>(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      // Materials (domain data).
      { type: "bim.material", id: "mat-concrete", name: "Concrete C30", description: "Structural concrete", color: [128, 128, 128], properties: { Density: 2400, FireRating: "REI90" } },
      { type: "bim.material", id: "mat-glass", name: "Low-E Glazing", color: [180, 210, 230], properties: { UValue: 1.2, Recyclable: true } },
      // Definitions (reusable parametric families).
      { type: "bim.componentDef", id: "def-wall-300", name: "Exterior Wall 300", category: "wall", parameters: { length: 4000, width: 300, height: 3000 }, materialId: "mat-concrete" },
      { type: "bim.componentDef", id: "def-door-900", name: "Interior Door 900", category: "door", parameters: { width: 900, height: 2100, leafThickness: 40 } },
      { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
      // Instances (stable canonical ids + definition provenance).
      { type: "bim.componentInstance", id: "inst-wall-a", definitionId: "def-wall-300", storyId: "story-gf", position: [2000, 1000], rotation: 0 },
      { type: "bim.componentInstance", id: "inst-wall-b", definitionId: "def-wall-300", storyId: "story-gf", position: [2000, 4000], rotation: Math.PI / 2 },
      { type: "bim.componentInstance", id: "inst-door-1", definitionId: "def-door-900", storyId: "story-gf", position: [500, 2500], rotation: 0, materialId: "mat-glass" },
      { type: "bim.componentInstance", id: "inst-desk-1", definitionId: "def-desk", storyId: "story-gf", position: [3000, 2000], rotation: Math.PI / 4 },
      { type: "bim.componentInstance", id: "inst-desk-2", definitionId: "def-desk", storyId: "story-gf", position: [4500, 2000], rotation: 0, overrides: { width: 1200 }, name: "Compact desk" },
      // Coordination primitives.
      { type: "bim.grid", id: "grid-structural", storyId: "story-gf", name: "Structural grid", uLines: [-3000, 3000, 9000], vLines: [0, 5000] },
      { type: "bim.referencePlane", id: "plane-ax", storyId: "story-gf", name: "Axis A reference", start: [-3000, 0], end: [-3000, 5000] },
    ],
  }));
  assert.equal(created.created.length, 13);
  return {
    story: "story-gf", concrete: "mat-concrete", glass: "mat-glass",
    wallDef: "def-wall-300", doorDef: "def-door-900", deskDef: "def-desk",
    wallA: "inst-wall-a", wallB: "inst-wall-b", door1: "inst-door-1",
    desk1: "inst-desk-1", desk2: "inst-desk-2", grid: "grid-structural", plane: "plane-ax",
  };
}

// --- acceptance 1: definitions produce instances with stable relationships -------

test("a representative definition produces multiple instances with stable canonical relationships", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  const inv = await inventory(h);
  assert.equal(inv.definitions.length, 3);
  assert.equal(inv.instances.length, 5);
  // Instance → definition provenance + derived state.
  const desk2 = inv.instances.find((i) => i.elementId === ids.desk2)!;
  assert.equal(desk2.definitionId, ids.deskDef);
  assert.deepEqual(desk2.overrides, { width: 1200 });
  assert.deepEqual(desk2.effectiveParameters, { depth: 800, height: 750, width: 1200 });
  assert.deepEqual(desk2.effectiveBox, [1200, 800, 750]);
  // Effective material: instance association wins over the definition default.
  const door1 = inv.instances.find((i) => i.elementId === ids.door1)!;
  assert.equal(door1.effectiveMaterialId, ids.glass);
  const wallA = inv.instances.find((i) => i.elementId === ids.wallA)!;
  assert.equal(wallA.effectiveMaterialId, ids.concrete);
  const desk1 = inv.instances.find((i) => i.elementId === ids.desk1)!;
  assert.equal(desk1.effectiveMaterialId, null);
  // Declared unsupported set is explicit.
  assert.match(inv.unsupported.alignmentConstraints!, /outside the supported set/);
});

test("typed rejects: unknown definition references, duplicate material names, foreign overrides", async () => {
  const h = dummy();
  await cmd(h, "document.create", { entityId: "component-rejects" });
  await cmd(h, "bim.createElements", { entities: [
    { type: "bim.story", id: "story-gf", name: "GF", level: 0, height: 3000 },
    { type: "bim.material", id: "mat-1", name: "Concrete", properties: {} },
  ]});
  // Instance referencing a missing definition.
  let r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.componentInstance", definitionId: "def-nope", storyId: "story-gf", position: [0, 0] },
  ]});
  assert.equal(errVal(r).code, "bim_invalid");
  assert.match(errVal(r).message, /def-nope/);
  // Duplicate material name.
  r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.material", name: "Concrete", properties: {} },
  ]});
  assert.match(errVal(r).message, /already taken/);
  // Definition referencing a non-material.
  r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.componentDef", name: "D", category: "wall", parameters: { length: 1, width: 1, height: 1 }, materialId: "story-gf" },
  ]});
  assert.match(errVal(r).message, /must reference a material/);
  // Instance override outside the definition schema.
  await cmd(h, "bim.createElements", { entities: [
    { type: "bim.componentDef", id: "def-w", name: "W", category: "wall", parameters: { length: 4000, width: 300, height: 3000 } },
  ]});
  r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.componentInstance", definitionId: "def-w", storyId: "story-gf", position: [0, 0], overrides: { depth: 500 } },
  ]});
  assert.match(errVal(r).message, /not a parameter of category 'wall'/);
  // Grid with duplicate lines / story reference integrity.
  r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.grid", storyId: "story-gf", name: "G", uLines: [0, 0], vLines: [1] },
  ]});
  assert.match(errVal(r).message, /strictly ascending/);
  r = await cmd(h, "bim.createElements", { entities: [
    { type: "bim.grid", storyId: "mat-1", name: "G", uLines: [0], vLines: [1] },
  ]});
  assert.match(errVal(r).message, /must reference a story/);
});

// --- acceptance 2: deterministic propagation + immutable revisions + undo ----------

test("definition edits propagate deterministically to instances and create immutable revisions", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  const before = await inventory(h);
  assert.equal(before.instances.find((i) => i.elementId === ids.desk1)!.effectiveParameters.width, 1600);

  // Edit the definition default: every instance follows deterministically.
  await cmd(h, "bim.setProperties", { elementId: ids.deskDef, patch: { parameters: { width: 1800, depth: 800, height: 750 } } });
  const after = await inventory(h);
  for (const id of [ids.desk1, ids.desk2]) {
    const inst = after.instances.find((i) => i.elementId === id)!;
    if (id === ids.desk1) {
      assert.equal(inst.effectiveParameters.width, 1800, "plain instance follows the new default");
      assert.deepEqual(inst.effectiveBox, [1800, 800, 750]);
    } else {
      assert.equal(inst.effectiveParameters.width, 1200, "the override PINS its key against definition changes");
      assert.equal(inst.effectiveParameters.depth, 800);
    }
    // The stored instance props are UNCHANGED — propagation is derivation.
    assert.deepEqual(inst.overrides, id === ids.desk2 ? { width: 1200 } : {});
  }

  // The edit is ONE immutable revision; undo restores the previous effective
  // state exactly (definition + instances).
  const history = val<{ revisions: { revision_number: number }[] }>(await qq(h, "model.getHistory", {}));
  assert.equal(history.revisions.length, 2, "create batch + definition edit = 2 revisions");
  const undone = val<{ undone: unknown }>(await cmd(h, "document.undo", {}));
  assert.ok(undone);
  const restored = await inventory(h);
  assert.equal(restored.instances.find((i) => i.elementId === ids.desk1)!.effectiveParameters.width, 1600);
  assert.equal(restored.instances.find((i) => i.elementId === ids.desk2)!.effectiveParameters.width, 1200);
});

test("instance edits are whitelisted + re-validated (overrides cross-checked against the definition)", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  // Move an instance (plan + z).
  const moved = val<{ applied: boolean }>(await cmd(h, "bim.move", { ids: [ids.desk1], dx: 500, dy: -200, dz: 100 }));
  assert.equal(moved.applied, true);
  const inv1 = await inventory(h);
  const m = inv1.instances.find((i) => i.elementId === ids.desk1)!;
  assert.deepEqual(m.position, [3500, 1800]);
  assert.equal(m.baseOffset, 100);
  // Update overrides (whole-object semantics).
  await cmd(h, "bim.setProperties", { elementId: ids.desk2, patch: { overrides: { width: 1400, depth: 700 } } });
  const inv2 = await inventory(h);
  const d2 = inv2.instances.find((i) => i.elementId === ids.desk2)!;
  assert.deepEqual(d2.overrides, { depth: 700, width: 1400 });
  assert.deepEqual(d2.effectiveParameters, { depth: 700, height: 750, width: 1400 });
  // Foreign override keys are rejected against the definition schema.
  let r = await cmd(h, "bim.setProperties", { elementId: ids.desk2, patch: { overrides: { leafThickness: 40 } } });
  assert.equal(errVal(r).code, "bim_invalid");
  assert.match(errVal(r).message, /parameter of its definition's category|not a parameter/);
  // Whitelist: definitionId/storyId are immutable through setProperties.
  r = await cmd(h, "bim.setProperties", { elementId: ids.desk2, patch: { definitionId: ids.wallDef } });
  assert.match(errVal(r).message, /not a settable property/);
  // Copy an instance (minted id, same definition + shifted placement).
  const copied = val<{ applied: boolean; created: string[] }>(await cmd(h, "bim.copy", { ids: [ids.desk2], dx: 1000, dy: 0, dz: 0 }));
  assert.equal(copied.created.length, 1);
  const inv3 = await inventory(h);
  const copy = inv3.instances.find((i) => i.elementId === copied.created[0])!;
  assert.equal(copy.definitionId, ids.deskDef);
  assert.deepEqual(copy.overrides, { depth: 700, width: 1400 });
  assert.deepEqual(copy.position, [5500, 2000]);
  // Domain data is honestly outside the move/copy supported set.
  let mr = await cmd(h, "bim.move", { ids: [ids.wallDef], dx: 1, dy: 0, dz: 0 });
  assert.equal(errVal(mr).code, "bim_unsupported");
  assert.match(errVal(mr).message, /no spatial placement/);
  mr = await cmd(h, "bim.copy", { ids: [ids.concrete], dx: 1, dy: 0, dz: 0 });
  assert.equal(errVal(mr).code, "bim_unsupported");
});

// --- acceptance 3: materials are canonical domain data with reference integrity ----

test("materials carry canonical identity and provenance; references are protected", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  const inv = await inventory(h);
  const concrete = inv.materials.find((m) => m.elementId === ids.concrete)!;
  assert.equal(concrete.name, "Concrete C30");
  assert.deepEqual(concrete.properties, { Density: 2400, FireRating: "REI90" });

  // Deleting a referenced material is rejected (no silent cascade).
  let r = await cmd(h, "bim.delete", { ids: [ids.concrete] });
  assert.equal(errVal(r).code, "bim_invalid");
  assert.match(errVal(r).message, /still referenced by/);
  // Deleting a referenced definition is rejected.
  r = await cmd(h, "bim.delete", { ids: [ids.wallDef] });
  assert.match(errVal(r).message, /instance\(s\)/);
  // Deleting a story hosting instances is rejected.
  r = await cmd(h, "bim.delete", { ids: [ids.story] });
  assert.match(errVal(r).message, /hosted element\(s\)/);
  // Renaming to a taken material name is rejected.
  r = await cmd(h, "bim.setProperties", { elementId: ids.glass, patch: { name: "Concrete C30" } });
  assert.match(errVal(r).message, /already taken/);
  // Plain instance deletion works; then the definition deletes cleanly.
  const del = val<{ applied: boolean }>(await cmd(h, "bim.delete", { ids: [ids.wallA, ids.wallB] }));
  assert.equal(del.applied, true);
  const delDef = val<{ applied: boolean }>(await cmd(h, "bim.delete", { ids: [ids.wallDef] }));
  assert.equal(delDef.applied, true);
  // Update material properties canonically.
  await cmd(h, "bim.setProperties", { elementId: ids.concrete, patch: { properties: { Density: 2500, FireRating: "REI120" } } });
  const inv2 = await inventory(h);
  assert.deepEqual(inv2.materials.find((m) => m.elementId === ids.concrete)!.properties, { Density: 2500, FireRating: "REI120" });
});

// --- acceptance 4: coordination data persists + replays -----------------------------

test("grid/reference-plane data persists through save/open and verified replay", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  // Edit the grid (moved) so the history has a coordination revision.
  await cmd(h, "bim.move", { ids: [ids.grid], dx: 1000, dy: 0, dz: 0 });

  // Verified replay to every revision keeps the coordination data (revision 0
  // is the EMPTY base — the grid exists from revision 1 on).
  for (let k = 0; k <= 2; k++) {
    const replayed = val<{ verified: boolean; elements: { id: string }[] }>(await qq(h, "model.replay", { revision_number: k }));
    assert.equal(replayed.verified, true);
    const gridEl = replayed.elements.find((e) => e.id === ids.grid);
    if (k === 0) {
      assert.equal(gridEl, undefined, "revision 0 is the empty base");
    } else {
      assert.ok(gridEl, `revision ${k} keeps the grid`);
    }
  }

  // Serialize → open round-trip (the serialize value IS the text).
  const saved = val<string>(await cmd(h, "document.serialize", {}));
  const h2 = dummy();
  await cmd(h2, "document.create", { entityId: "component-model" });
  val<{ snapshot: CADDocumentSnapshot }>(await cmd(h2, "document.deserialize", { text: saved }));
  const inv2 = await inventory(h2);
  const grid = inv2.grids.find((g) => g.elementId === ids.grid)!;
  assert.deepEqual(grid.uLines, [-2000, 4000, 10000]);
  assert.deepEqual(grid.vLines, [0, 5000]);
  const plane = inv2.referencePlanes.find((p) => p.elementId === ids.plane)!;
  assert.deepEqual(plane.start, [-3000, 0]);
  assert.deepEqual(plane.end, [-3000, 5000]);
  assert.equal(inv2.instances.length, 5);
  assert.equal(inv2.materials.length, 2);
});

// --- acceptance 7: Construction Graph mappings on canonical ids ---------------------

test("Construction Graph mappings stay keyed by canonical ids (engine ids never participate)", async () => {
  const h = dummy();
  const ids = await authorComponents(h);
  await cmd(h, "bim.setProperties", { elementId: ids.deskDef, patch: { parameters: { width: 1800, depth: 800, height: 750 } } });

  const graphed = val<{ events: unknown[] }>(await qq(h, "model.getGraphEvents", {}));
  assert.ok(graphed.events.length >= 2, "model.created + version events");
  const events = graphed.events as {
    payload: { elements?: { element_id: string; graph_node_id: string; change: string }[] };
  }[];
  const allProjections = events.flatMap((e) => e.payload.elements ?? []);
  const projected = new Set(allProjections.map((p) => p.element_id));
  for (const id of [ids.wallDef, ids.deskDef, ids.desk1, ids.desk2, ids.concrete, ids.glass, ids.grid, ids.plane]) {
    assert.ok(id !== undefined && projected.has(id), `${id ?? "(missing)"} is projected into the graph`);
  }
  // Graph node ids derive from the document entity + canonical element id ONLY.
  for (const p of allProjections) {
    assert.equal(p.graph_node_id, graphNodeId("component-model", p.element_id));
  }
  // The definition edit revision carries the definition element (canonical,
  // not engine-derived).
  const last = events[events.length - 1]!;
  const affected = last.payload.elements ?? [];
  assert.ok(affected.some((e) => e.element_id === ids.deskDef && e.change === "updated"));
});

// --- acceptance 6: IFC round-trip (real toolchain) ----------------------------------

test("IFC export includes components + materials; grids are explicitly not exported", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  const ids = await authorComponents(h);
  const exported = val<{ ifc: string; sha256: string; size: number; counts: Record<string, number> }>(
    await cmd(h, "ifc.export", { projectName: "Component Tower" }),
  );
  assert.equal(exported.counts.materials, 2);
  assert.equal(exported.counts.components, 5);
  assert.equal(exported.counts.gridsNotExported, 1, "the grid is canonical-only in IFC (declared)");
  assert.equal(exported.counts.referencePlanesNotExported, 1);
  // Determinism: equal inputs → byte-identical outputs.
  const again = val<{ sha256: string }>(await cmd(h, "ifc.export", { projectName: "Component Tower" }));
  assert.equal(again.sha256, exported.sha256);
  void ids;
});

test("export → import into a FRESH document preserves component/material semantics", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  const ids = await authorComponents(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const h2 = ifcHandler();
  await cmd(h2, "document.create", { entityId: "component-model" });
  const imported = val<{ created: string[]; report: { summary: Record<string, number>; elements: { canonicalId: string | null; ifcClass: string; action: string; fields: { classification: string }[] }[] } }>(
    await cmd(h2, "ifc.import", { ifc: exported.ifc }),
  );
  // All exported entities recreate: story + 2 materials + 3 definitions +
  // 5 instances = 11 (the grid/reference plane are canonical-only).
  assert.equal(imported.created.length, 11);

  const inv = await inventory(h2);
  // Canonical identities are preserved for instances AND definitions.
  assert.equal(inv.instances.length, 5);
  assert.equal(inv.definitions.length, 3);
  assert.equal(inv.materials.length, 2);
  for (const id of [ids.wallDef, ids.deskDef, ids.doorDef]) {
    assert.ok(inv.definitions.some((d) => d.elementId === id), `definition ${id} preserved`);
  }
  // Effective parameters survive exactly (within the declared tolerance).
  const desk2 = inv.instances.find((i) => i.elementId === ids.desk2)!;
  assert.ok(Math.abs(desk2.effectiveParameters.width! - 1200) <= TOL);
  assert.ok(Math.abs(desk2.effectiveParameters.depth! - 800) <= TOL);
  assert.deepEqual(desk2.overrides, { width: 1200 });
  const desk1 = inv.instances.find((i) => i.elementId === ids.desk1)!;
  assert.ok(Math.abs(desk1.position[0] - 3000) <= TOL);
  assert.ok(Math.abs(desk1.position[1] - 2000) <= TOL);
  assert.ok(Math.abs(desk1.rotation - Math.PI / 4) <= 1e-6);
  // REGRESSION (definition defaults are NOT polluted by overridden instances):
  // the definition's DEFAULT width is 1600 even though the file's first desk
  // instance carries a 1200 override — a non-overriding instance witnesses the
  // default. desk1 (no overrides) must derive the authored default, not the
  // overridden value.
  const deskDef = inv.definitions.find((d) => d.elementId === ids.deskDef)!;
  assert.ok(Math.abs(deskDef.parameters.width! - 1600) <= TOL, "definition default width survives the round trip");
  assert.ok(Math.abs(desk1.effectiveParameters.width! - 1600) <= TOL, "non-overriding instance derives the definition default");
  assert.deepEqual(desk1.overrides, {}, "non-overriding instance stays override-free");
  // Materials reconcile on their identity psets (canonical ids preserved).
  const concrete = inv.materials.find((m) => m.elementId === ids.concrete)!;
  assert.equal(concrete.name, "Concrete C30");
  assert.equal(concrete.properties.Density, 2400);
  assert.equal(concrete.properties.FireRating, "REI90");
  // Effective materials survive the association round trip.
  const door1 = inv.instances.find((i) => i.elementId === ids.door1)!;
  assert.equal(door1.effectiveMaterialId, ids.glass);
  // GlobalIds are retained as engineId provenance ONLY (LOCK-019).
  const snapshot = val<CADDocumentSnapshot>(await qq(h2, "document.getState", {}));
  const instEl = snapshot.elements.find((e) => e.id === ids.desk1)!;
  assert.ok(typeof instEl.engineId === "string" && instEl.engineId.length > 0, "GlobalId retained as provenance");
  // The report classifies the round trip honestly.
  const materialEntries = imported.report.elements.filter((e) => e.ifcClass === "IfcMaterial");
  assert.equal(materialEntries.length, 2);
  assert.ok(materialEntries.every((e) => e.action === "created"));
  const instanceEntries = imported.report.elements.filter((e) => e.ifcClass.startsWith("Ifc"));
  assert.ok(instanceEntries.some((e) => e.canonicalId === ids.desk2));
});

test("export → import into the SAME document reconciles unchanged (identity-based)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  const ids = await authorComponents(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const imported = val<{
    created: string[]; patched: string[];
    report: {
      summary: Record<string, number>;
      elements: { canonicalId: string | null; ifcClass: string; action: string }[];
    };
  }>(
    await cmd(h, "ifc.import", { ifc: exported.ifc }),
  );
  // Everything already exists: nothing created, nothing patched (within the
  // declared tolerance — the pset parameter surface matches).
  const created = imported.created.filter((id) => id.length > 0);
  assert.deepEqual(created, []);
  assert.deepEqual(imported.patched, []);
  const componentEntries = imported.report.elements.filter((e) => e.ifcClass !== "IfcMaterial" && e.ifcClass !== "IfcComponentDefinition");
  assert.ok(componentEntries.length >= 5);
  const unsupportedEntries = componentEntries.filter((e) => e.action === "unsupported");
  assert.deepEqual(unsupportedEntries.map((e) => e.canonicalId), []);
  void ids;
});

test("controlled component mutations survive the round trip and identify EXACTLY the changed element", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  const ids = await authorComponents(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  // Controlled mutation: move one instance + change one override.
  await cmd(h, "bim.move", { ids: [ids.desk1], dx: 777, dy: 0, dz: 0 });
  await cmd(h, "bim.setProperties", { elementId: ids.desk2, patch: { overrides: { width: 1100 } } });
  const imported = val<{ created: string[]; patched: string[]; report: { elements: { canonicalId: string | null; action: string }[] } }>(
    await cmd(h, "ifc.import", { ifc: exported.ifc }),
  );
  assert.deepEqual(imported.created, []);
  // EXACTLY the two mutated instances reconcile (field-level, by identity).
  const reconciled = imported.report.elements.filter((e) => e.action === "reconciled").map((e) => e.canonicalId).sort();
  assert.deepEqual(reconciled, [ids.desk1, ids.desk2].sort());
  // And the reconciliation RESTORES the exported state.
  const inv = await inventory(h);
  const desk1 = inv.instances.find((i) => i.elementId === ids.desk1)!;
  assert.ok(Math.abs(desk1.position[0] - 3000) <= TOL, "the mutation is reconciled back to the exported state");
  const desk2 = inv.instances.find((i) => i.elementId === ids.desk2)!;
  assert.ok(Math.abs(desk2.overrides.width! - 1200) <= TOL);
});

test("ifc.compare classifies the component model against its own export with zero loss", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await authorComponents(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const compared = val<{ report: { summary: Record<string, number>; elements: { fields: { classification: string }[] }[] } }>(
    await qq(h, "ifc.compare", { ifc: exported.ifc }),
  );
  assert.equal(compared.report.summary.lossy, 0);
  assert.equal(compared.report.summary.unsupportedFields, 0);
});

test("an external IFC furnishing imports as a component with declared fallbacks", { skip: skipIfc }, async () => {
  // Author a model with one furnishing component, export it, then strip the
  // Offisos provenance psets to simulate external authoring.
  const h = ifcHandler();
  await cmd(h, "document.create", { entityId: "external-authoring" });
  await cmd(h, "bim.createElements", { entities: [
    { type: "bim.story", id: "story-gf", name: "GF", level: 0, height: 3000 },
    { type: "bim.componentDef", id: "def-chair", name: "Task Chair", category: "fixture", parameters: { width: 600, depth: 600, height: 950 } },
    { type: "bim.componentInstance", id: "inst-chair-1", definitionId: "def-chair", storyId: "story-gf", position: [1000, 1000], rotation: 0 },
  ]});
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));

  // Externalize: rewrite the Offisos provenance pset NAMES in the IFC text
  // (a pure textual rename preserves STEP reference integrity — removing
  // entity lines would corrupt the file; the IFC-001 external fixture
  // precedent uses a committed externally-authored file).
  const raw = Buffer.from(exported.ifc, "base64").toString("utf-8");
  const stripped = raw
    .replaceAll("Pset_OffisosIdentity", "Pset_ExternalIdentity")
    .replaceAll("Pset_OffisosComponent", "Pset_ExternalComponent");

  const h2 = ifcHandler();
  await cmd(h2, "document.create", { entityId: "external-import" });
  const imported = val<{ created: string[]; report: { elements: { ifcClass: string; action: string; canonicalId: string | null }[]; declaredFallbacks: string[] } }>(
    await cmd(h2, "ifc.import", { ifc: Buffer.from(stripped, "utf-8").toString("base64") }),
  );
  // The furnishing imports as a component instance with a MINTED definition;
  // the fallback is declared in the report.
  const furnishing = imported.report.elements.filter((e) => e.ifcClass === "IfcFurnishingElement" || e.ifcClass === "IfcWall" || e.ifcClass === "IfcDoor" || e.ifcClass === "IfcWindow");
  const createdInstances = furnishing.filter((e) => e.action === "created");
  assert.equal(createdInstances.length, 1, "exactly the chair imports as a component");
  assert.ok(imported.report.declaredFallbacks.some((d) => d.includes("externally")), "the external fallback is declared");
  const inv = await inventory(h2);
  assert.equal(inv.instances.length, 1);
  const chair = inv.instances[0]!;
  assert.notEqual(chair.definitionId, "def-chair", "the definition was minted (no provenance)");
  assert.ok(Math.abs(chair.effectiveParameters.width! - 600) <= TOL, "geometry facts flow into the minted definition");
  assert.ok(Math.abs(chair.effectiveParameters.height! - 950) <= TOL);
});
