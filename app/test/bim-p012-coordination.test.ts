/**
 * CAD-PARITY-012 (Issue #102) — the components, materials and coordination
 * expansion end to end through the App API: material records (the bim.material
 * elements + the parity fields) with create/update/assign/remove, the
 * reference-integrity gates and the byte-identical absence restoration on
 * undo/redo; the block-system component library (blockDef materialId
 * defaults, components.list, EXPLODE material inheritance with the
 * instance ?? definition precedence); grid datums (the full strictly-
 * ascending u/v-set grammar, updates, DERIVED Excel-style labels); the
 * coordination surfaces (pairwise clash detection with typed exclusions,
 * the deterministic bill of materials, revision clouds with the bounded
 * marker); double-run determinism, save/open persistence and the
 * additive-absence guarantee (pre-P012 documents carry NO new fields).
 *
 * Engine basis: the REFERENCE geometry adapter (the parity-fixture basis).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { WORKSPACE_COMMANDS, commandById, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_COORDINATION } from "../src/workspace/commands-coordination.js";
import { defaultCommandContext } from "../src/workspace/types.js";
import type { CommandContext, CommandPlan, EntityPick, PromptValue } from "../src/workspace/types.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "bim-p012-coordination",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "p012-coordination",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errOf(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, `expected a typed failure, got: ${JSON.stringify(r).slice(0, 300)}`);
  const e = r as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}
async function qq(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "query", name: name as never, payload });
}

async function makeHandler(): Promise<AppApiHandler> {
  return AppApiHandler.create(CONFIG);
}

interface MaterialRow {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly color?: number[];
  readonly lineweight?: number;
  readonly density?: number;
  readonly description?: string;
}

interface BomRow {
  readonly materialId: string | null;
  readonly name: string;
  readonly count: number;
  readonly length: number;
  readonly area: number;
}

interface GridRow {
  readonly id: string;
  readonly name: string;
  readonly storyId: string;
  readonly uLines: number[];
  readonly vLines: number[];
  readonly uLabels: string[];
  readonly vLabels: string[];
}

interface ComponentRow {
  readonly id: string;
  readonly name: string;
  readonly materialId: string | null;
  readonly instanceCount: number;
  readonly instanceIds: string[];
}

/** Author the base scene: one story, a 400-long line and a r=100 circle. */
async function authorScene(handler: AppApiHandler): Promise<{ storyId: string; lineId: string; circleId: string }> {
  await cmd(handler, "document.create", { entityId: "p012-scene", createdBy: "p012" });
  await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 }],
  });
  const created = val<{ created: string[] }>(await cmd(handler, "entity.create", {
    entities: [
      { type: "line", layer: "0", x1: 0, y1: 0, x2: 400, y2: 0 },
      { type: "circle", layer: "0", cx: 0, cy: 500, r: 100 },
    ],
  }));
  assert.equal(created.created.length, 2);
  return { storyId: "story-gf", lineId: created.created[0]!, circleId: created.created[1]! };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Materials — create / list canonical form / typed failures
// ---------------------------------------------------------------------------

test("materials: create persists the parity fields through ONE revision; list omits absent fields", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const versionBefore = val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number;
  const m = val<{ applied: boolean; materialId: string; summary: string }>(
    await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", density: 2400, description: "Slab mix" }),
  );
  assert.equal(m.applied, true);
  assert.match(m.summary, /material 'Concrete C30' \(Concrete\) created/);
  assert.ok(m.materialId.startsWith("el-"));
  // ONE version = ONE undo entry.
  const versionAfter = val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number;
  assert.equal(versionAfter, versionBefore + 1);
  // The parity fields land on the bim.material element (absent color omitted).
  const el = h.document.elementById(m.materialId)!;
  assert.equal((el.props as Record<string, unknown>).type, "bim.material");
  assert.equal((el.props as Record<string, unknown>).category, "Concrete");
  assert.equal((el.props as Record<string, unknown>).density, 2400);
  assert.equal((el.props as Record<string, unknown>).description, "Slab mix");
  assert.ok(!("color" in (el.props as Record<string, unknown>)), "absent color must be OMITTED, never undefined");
  // materials.list: id-sorted, absent optional fields omitted entirely.
  val(await cmd(h, "material.create", { name: "Steel S1", category: "Steel", color: [139, 139, 150] }));
  const list = val<{ materials: MaterialRow[] }>(await qq(h, "materials.list", {}));
  assert.equal(list.materials.length, 2);
  const concrete = list.materials.find((x) => x.name === "Concrete C30")!;
  assert.deepEqual(
    Object.keys(concrete).sort(),
    ["category", "density", "description", "id", "lineweight", "name"],
  );
  assert.equal(concrete.category, "Concrete");
  assert.equal(concrete.lineweight, 1.4);
  const steel = list.materials.find((x) => x.name === "Steel S1")!;
  assert.deepEqual(steel.color, [139, 139, 150]);
  void scene;
});

test("materials: create typed failures (exists, invalid category/lineweight/color, bad payload)", async () => {
  const h = await makeHandler();
  await authorScene(h);
  val(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete" }));
  assert.equal(errOf(await cmd(h, "material.create", { name: "Concrete C30", category: "Steel" })).code, "material_exists");
  assert.match(errOf(await cmd(h, "material.create", { name: "Water", category: "Liquid" })).message, /not in the vocabulary/);
  assert.equal(errOf(await cmd(h, "material.create", { name: "W1", category: "Water" })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.create", { name: "W2", category: "Steel", lineweight: 12 })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.create", { name: "W3", category: "Steel", lineweight: 0.2 })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.create", { name: "W4", category: "Steel", color: [0, 0, 999] })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.create", { name: "W5", category: "Steel", density: -1 })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.create", { name: "", category: "Steel" })).code, "material_bad_payload");
  assert.equal(errOf(await cmd(h, "material.create", { category: "Steel" })).code, "material_bad_payload");
});

// ---------------------------------------------------------------------------
// Materials — update / assign / remove
// ---------------------------------------------------------------------------

test("materials: update patches through a full-record rewrite; no-op stays one version", async () => {
  const h = await makeHandler();
  await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Steel S1", category: "Steel" }));
  const up = val<{ applied: boolean; summary: string }>(
    await cmd(h, "material.update", { elementId: m.materialId, patch: { name: "Steel S2", lineweight: 2.5, description: "Hot rolled" } }),
  );
  assert.equal(up.applied, true);
  const list = val<{ materials: MaterialRow[] }>(await qq(h, "materials.list", {}));
  assert.deepEqual(list.materials[0], { id: m.materialId, name: "Steel S2", category: "Steel", lineweight: 2.5, description: "Hot rolled" });
  // Null clears an optional field back to ABSENCE.
  val(await cmd(h, "material.update", { elementId: m.materialId, patch: { description: null } }));
  const list2 = val<{ materials: MaterialRow[] }>(await qq(h, "materials.list", {}));
  assert.ok(!("description" in (list2.materials[0] as unknown as Record<string, unknown>)));
  // A no-op patch does NOT create a version.
  const v0 = val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number;
  const noop = val<{ applied: boolean; reason: string }>(
    await cmd(h, "material.update", { elementId: m.materialId, patch: { name: "Steel S2" } }),
  );
  assert.equal(noop.applied, false);
  assert.equal(val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number, v0);
  // Typed failures.
  assert.equal(errOf(await cmd(h, "material.update", { elementId: "el-999999", patch: { name: "X" } })).code, "material_not_found");
  assert.equal(errOf(await cmd(h, "material.update", { elementId: m.materialId, patch: { color: "red" } })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.update", { elementId: m.materialId, patch: { bogus: 1 } })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.update", { elementId: m.materialId, patch: { name: "Steel S2", category: "Plasma" } })).code, "material_invalid");
  // Renaming onto a taken name fails typed.
  val(await cmd(h, "material.create", { name: "Taken", category: "Glass" }));
  assert.equal(errOf(await cmd(h, "material.update", { elementId: m.materialId, patch: { name: "Taken" } })).code, "material_exists");
});

test("materials: assign writes materialId through full-record rewrites; null unassigns (absence exact)", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete" }));
  const a = val<{ applied: boolean; assigned: number }>(
    await cmd(h, "material.assign", { ids: [scene.lineId, scene.circleId], materialId: m.materialId }),
  );
  assert.equal(a.assigned, 2);
  for (const id of [scene.lineId, scene.circleId]) {
    assert.equal((h.document.elementById(id)!.props as Record<string, unknown>).materialId, m.materialId);
  }
  // ONE version for the whole batch (one undo entry).
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: null }));
  const lineProps = h.document.elementById(scene.lineId)!.props as Record<string, unknown>;
  assert.ok(!("materialId" in lineProps), "unassignment restores canonical ABSENCE (never an undefined hole)");
  assert.equal((h.document.elementById(scene.circleId)!.props as Record<string, unknown>).materialId, m.materialId);
  // Typed failures.
  assert.equal(errOf(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: "el-999999" })).code, "material_not_found");
  assert.equal(errOf(await cmd(h, "material.assign", { ids: ["el-999999"], materialId: m.materialId })).code, "material_invalid");
  assert.equal(errOf(await cmd(h, "material.assign", { ids: [], materialId: m.materialId })).code, "material_bad_payload");
});

test("materials: remove is reference-checked (element assignment AND blockDef default); no cascade", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete" }));
  // In use through an element assignment.
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: m.materialId }));
  const inUse = errOf(await cmd(h, "material.remove", { elementId: m.materialId }));
  assert.equal(inUse.code, "material_in_use");
  assert.match(inUse.message, new RegExp(scene.lineId));
  assert.match(inUse.message, /unassign them first/);
  // Unassign, then block through the BLOCK-DEFINITION default.
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: null }));
  val(await cmd(h, "block.create", { name: "SYMB", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.circleId] }));
  val(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: m.materialId } }));
  const inUseDef = errOf(await cmd(h, "material.remove", { elementId: m.materialId }));
  assert.equal(inUseDef.code, "material_in_use");
  assert.match(inUseDef.message, /blk-000001/);
  // Clear the definition default (null) → removal succeeds and is ONE revision.
  val(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: null } }));
  const rm = val<{ applied: boolean; summary: string }>(await cmd(h, "material.remove", { elementId: m.materialId }));
  assert.equal(rm.applied, true);
  assert.equal(h.document.elementById(m.materialId), undefined);
  assert.equal(errOf(await cmd(h, "material.remove", { elementId: m.materialId })).code, "material_not_found");
});

test("materials: assignment undo/redo restores absence byte-identically (content hash + exact props)", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete" }));
  const hashBefore = h.document.currentContentHash();
  const propsBefore = JSON.stringify(h.document.elementById(scene.lineId)!.props);
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: m.materialId }));
  assert.notEqual(h.document.currentContentHash(), hashBefore);
  val(await cmd(h, "document.undo", {}));
  // The undo inverse restores the exact previous props byte-identically —
  // absence is key ABSENCE (no undefined-hole serialization class).
  assert.equal(h.document.currentContentHash(), hashBefore, "undo restores the canonical pre-assignment content");
  assert.equal(JSON.stringify(h.document.elementById(scene.lineId)!.props), propsBefore);
  val(await cmd(h, "document.redo", {}));
  assert.equal((h.document.elementById(scene.lineId)!.props as Record<string, unknown>).materialId, m.materialId);
  val(await cmd(h, "document.undo", {}));
  assert.ok(!("materialId" in (h.document.elementById(scene.lineId)!.props as Record<string, unknown>)));
});

// ---------------------------------------------------------------------------
// Components — the block system extension
// ---------------------------------------------------------------------------

test("components: blockDef materialId default + block.update validation (typed, no dangling refs)", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Steel S1", category: "Steel" }));
  val(await cmd(h, "block.create", { name: "SYMB", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.circleId] }));
  val(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: m.materialId } }));
  const def = h.document.blockDefById("blk-000001")!;
  assert.equal(def.materialId, m.materialId);
  // The record serializes additively: a materialId-less definition stays absent.
  val(await cmd(h, "block.create", { name: "PLAIN", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.lineId] }));
  const plain = h.document.blockDefById("blk-000002")!;
  assert.ok(!("materialId" in (plain as unknown as Record<string, unknown>)));
  // Unknown material → typed failure; garbage type → bad payload.
  assert.equal(errOf(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: "el-999999" } })).code, "material_not_found");
  assert.equal(errOf(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: 17 } })).code, "bad_payload");
});

test("components.list: id-sorted inventory with materialId + instance counts and ids", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Steel S1", category: "Steel" }));
  val(await cmd(h, "block.create", { name: "SYMB", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.circleId] }));
  val(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: m.materialId } }));
  val(await cmd(h, "block.create", { name: "PLAIN", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.lineId] }));
  // No instances yet.
  let list = val<{ components: ComponentRow[] }>(await qq(h, "components.list", {}));
  assert.deepEqual(
    list.components.map((c) => [c.id, c.name, c.materialId, c.instanceCount]),
    [["blk-000001", "SYMB", m.materialId, 0], ["blk-000002", "PLAIN", null, 0]],
  );
  // Insert two SYMB instances; the scan counts them and lists their ids.
  const i1 = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "SYMB", x: 100, y: 100 }));
  const i2 = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "SYMB", x: 500, y: 500, scale: 2 }));
  list = val<{ components: ComponentRow[] }>(await qq(h, "components.list", {}));
  const symb = list.components.find((c) => c.name === "SYMB")!;
  assert.equal(symb.instanceCount, 2);
  assert.deepEqual(symb.instanceIds, [i1.elementId, i2.elementId]);
  assert.deepEqual(list.components.map((c) => c.instanceIds.length), [2, 0]);
});

test("components: EXPLODE inherits the RESOLVED material (instance override ?? definition default ?? none)", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const matDef = val<{ materialId: string }>(await cmd(h, "material.create", { name: "DefMat", category: "Steel" }));
  const matInst = val<{ materialId: string }>(await cmd(h, "material.create", { name: "InstMat", category: "Timber" }));
  val(await cmd(h, "block.create", { name: "SYMB", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.circleId] }));
  val(await cmd(h, "block.update", { name: "SYMB", patch: { materialId: matDef.materialId } }));
  // Instance WITHOUT its own association → the piece inherits the DEFINITION default.
  const plain = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "SYMB", x: 0, y: 0 }));
  // Instance WITH its own association → the override wins (precedence).
  const overridden = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "SYMB", x: 900, y: 900 }));
  val(await cmd(h, "material.assign", { ids: [overridden.elementId], materialId: matInst.materialId }));
  const r1 = val<{ created: number }>(await cmd(h, "entity.modify", { op: "explode", ids: [plain.elementId] }));
  assert.equal(r1.created, 1);
  const r2 = val<{ created: number }>(await cmd(h, "entity.modify", { op: "explode", ids: [overridden.elementId] }));
  assert.equal(r2.created, 1);
  const pieces = h.document.allElements().filter((el) => (el.props as Record<string, unknown>).type === "circle" && (el.props as Record<string, unknown>).materialId !== undefined);
  assert.equal(pieces.length, 2);
  const byMat = new Map(pieces.map((p) => [String((p.props as Record<string, unknown>).materialId), p.id]));
  assert.equal(byMat.get(matDef.materialId) !== undefined, true, "the plain instance's piece inherits the definition default");
  assert.equal(byMat.get(matInst.materialId) !== undefined, true, "the overridden instance's piece carries the INSTANCE override");
  // The exploded pieces are plain canonical geometry (one level, no block-ref).
  for (const p of pieces) {
    assert.equal((p.props as Record<string, unknown>).type, "circle");
    assert.equal((p.props as Record<string, unknown>).layer, "0");
    assert.ok((p.props as Record<string, unknown>).blockId === undefined, "no block-ref remnant on the piece");
  }
});

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

test("grids: create accepts the full strictly-ascending grammar; rejects duplicates/empty/non-ascending", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const g = val<{ applied: boolean; gridId: string; summary: string }>(
    await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 3000, 6000], vLines: [0, 2000] }),
  );
  assert.equal(g.applied, true);
  assert.ok(g.gridId.startsWith("el-"));
  assert.match(g.summary, /grid 'Grid 1' created \(3 u-lines, 2 v-lines\)/);
  const el = h.document.elementById(g.gridId)!;
  assert.equal((el.props as Record<string, unknown>).type, "bim.grid");
  assert.deepEqual((el.props as Record<string, unknown>).uLines, [0, 3000, 6000]);
  // The grammar rejects: duplicates, empty arrays, non-ascending.
  assert.equal(errOf(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 0], vLines: [0] })).code, "grid_invalid");
  assert.equal(errOf(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [], vLines: [0] })).code, "grid_invalid");
  assert.equal(errOf(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [3000, 0], vLines: [0] })).code, "grid_invalid");
  assert.equal(errOf(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0], vLines: ["a"] })).code, "grid_invalid");
  // A second story makes the implicit story resolution ambiguous → typed failure.
  await cmd(h, "bim.createElements", { entities: [{ type: "bim.story", id: "story-ff", name: "FF", level: 3000, height: 3000 }] });
  const ambiguous = errOf(await cmd(h, "grid.create", { uLines: [0], vLines: [0] }));
  assert.equal(ambiguous.code, "grid_bad_payload");
  assert.match(ambiguous.message, /storyId/);
});

test("grids: update replaces whole arrays with full re-validation; grid_not_found for unknown ids", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const g = val<{ gridId: string }>(
    await cmd(h, "grid.create", { storyId: scene.storyId, name: "Structural", uLines: [0, 1000], vLines: [0, 500] }),
  );
  const up = val<{ applied: boolean; summary: string }>(
    await cmd(h, "grid.update", { elementId: g.gridId, patch: { name: "Axes", vLines: [0, 500, 1000] } }),
  );
  assert.equal(up.applied, true);
  const grids = val<{ grids: GridRow[] }>(await qq(h, "grids.list", {}));
  const axes = grids.grids.find((x) => x.id === g.gridId)!;
  assert.equal(axes.name, "Axes");
  assert.deepEqual(axes.vLines, [0, 500, 1000]);
  assert.deepEqual(axes.uLines, [0, 1000]);
  // Full re-validation on update.
  assert.equal(errOf(await cmd(h, "grid.update", { elementId: g.gridId, patch: { uLines: [5, 5] } })).code, "grid_invalid");
  assert.equal(errOf(await cmd(h, "grid.update", { elementId: g.gridId, patch: { vLines: [] } })).code, "grid_invalid");
  assert.equal(errOf(await cmd(h, "grid.update", { elementId: "el-999999", patch: { name: "X" } })).code, "grid_not_found");
  assert.equal(errOf(await cmd(h, "grid.update", { elementId: scene.storyId, patch: { name: "X" } })).code, "grid_not_found");
});

test("grids.list: DERIVED Excel-style labels (A,B,C… / 1,2,3…) — never stored", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const g = val<{ gridId: string }>(
    await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700], vLines: [0, 1, 2] }),
  );
  const grids = val<{ grids: GridRow[] }>(await qq(h, "grids.list", {}));
  const grid = grids.grids.find((x) => x.id === g.gridId)!;
  assert.deepEqual(grid.uLabels, "ABCDEFGHIJKLMNOP".split("").concat(["Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB"]));
  assert.deepEqual(grid.vLabels, ["1", "2", "3"]);
  // Labels are DERIVED — the stored element carries no label arrays.
  const props = h.document.elementById(g.gridId)!.props as Record<string, unknown>;
  assert.ok(!("uLabels" in props) && !("vLabels" in props) && !("labels" in props));
  // The listing is id-sorted.
  val(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [5], vLines: [7] }));
  const grids2 = val<{ grids: GridRow[] }>(await qq(h, "grids.list", {}));
  assert.equal(grids2.grids.length, 2);
  assert.ok(grids2.grids[0]!.id < grids2.grids[1]!.id);
});

test("grids: create + update are single revisions and undo reverts them exactly", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const v0 = val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number;
  const g = val<{ gridId: string }>(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 1000], vLines: [0, 500] }));
  assert.equal(val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number, v0 + 1);
  val(await cmd(h, "grid.update", { elementId: g.gridId, patch: { vLines: [0, 500, 1000] } }));
  assert.equal(val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number, v0 + 2);
  val(await cmd(h, "document.undo", {}));
  let grids = val<{ grids: GridRow[] }>(await qq(h, "grids.list", {}));
  assert.deepEqual(grids.grids.find((x) => x.id === g.gridId)!.vLines, [0, 500]);
  val(await cmd(h, "document.undo", {}));
  grids = val<{ grids: GridRow[] }>(await qq(h, "grids.list", {}));
  assert.equal(grids.grids.length, 0);
  assert.equal(h.document.elementById(g.gridId), undefined);
});

// ---------------------------------------------------------------------------
// Coordination — clash detection
// ---------------------------------------------------------------------------

interface ClashPoint { readonly x: number; readonly y: number }
interface ClashPair { readonly a: string; readonly b: string; readonly points: readonly ClashPoint[] }
interface ClashResult { readonly pairs: readonly ClashPair[]; readonly checked: number; readonly excluded: number }

test("clash: line × circle crossing reports the exact pair and points; ray + revcloud are excluded (counted)", async () => {
  const h = await makeHandler();
  await cmd(h, "document.create", { entityId: "clash-doc", createdBy: "p012" });
  val(await cmd(h, "entity.create", {
    entities: [
      { type: "line", layer: "0", x1: 0, y1: 200, x2: 400, y2: 200 },
      { type: "circle", layer: "0", cx: 200, cy: 200, r: 100 },
      { type: "ray", layer: "0", x1: 0, y1: 900, x2: 1, y2: 0 },
    ],
  }));
  val(await cmd(h, "revcloud.create", { cornerA: { x: -10, y: -10 }, cornerB: { x: 410, y: 410 } }));
  const r1 = val<ClashResult>(await qq(h, "coordination.clash", {}));
  assert.equal(r1.checked, 2);
  assert.equal(r1.excluded, 2);
  assert.equal(r1.pairs.length, 1);
  const pair = r1.pairs[0]!;
  assert.deepEqual([pair.a, pair.b], ["el-000001", "el-000002"]);
  assert.deepEqual(pair.points.map((p) => [p.x, p.y]), [[100, 200], [300, 200]]);
  // Deterministic double-run: identical result object.
  const r2 = val<ClashResult>(await qq(h, "coordination.clash", {}));
  assert.deepEqual(r2, r1);
});

test("clash: block instances expand (participant id = the INSTANCE); same-instance pieces never clash", async () => {
  // Scenario A: a definition whose two content lines CROSS each other — one
  // instance expands to two checked pieces that must NEVER form a pair
  // (two pieces of the same instance are one body).
  const ha = await makeHandler();
  await cmd(ha, "document.create", { entityId: "clash-self", createdBy: "p012" });
  const made = val<{ created: string[] }>(await cmd(ha, "entity.create", {
    entities: [
      { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
      { type: "line", layer: "0", x1: 50, y1: -50, x2: 50, y2: 50 },
    ],
  }));
  val(await cmd(ha, "block.create", { name: "CROSS", basePoint: { x: 0, y: 0 }, fromElementIds: made.created }));
  val(await cmd(ha, "block.insert", { name: "CROSS", x: 0, y: 0 }));
  const ra = val<ClashResult>(await qq(ha, "coordination.clash", {}));
  assert.equal(ra.checked, 2, "both expanded pieces are checked");
  assert.equal(ra.pairs.length, 0, "a pair never forms WITHIN one instance");

  // Scenario B: two instances of a one-line definition placed so the
  // expanded lines cross — the pair maps back to the INSTANCE element ids
  // with deterministic (a, b) ordering.
  const h = await makeHandler();
  await cmd(h, "document.create", { entityId: "clash-blocks", createdBy: "p012" });
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 }] }));
  val(await cmd(h, "block.create", { name: "BAR", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  const inst = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "BAR", x: 0, y: 0 }));
  const inst2 = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "BAR", x: 50, y: 0, rotation: Math.PI / 2 }));
  const r = val<ClashResult>(await qq(h, "coordination.clash", {}));
  assert.equal(r.checked, 2);
  assert.equal(r.pairs.length, 1);
  const pair = r.pairs[0]!;
  assert.deepEqual([pair.a, pair.b], [inst.elementId, inst2.elementId].sort());
  assert.equal(pair.points.length, 1);
  assert.ok(Math.abs(pair.points[0]!.x - 50) < 1e-9 && Math.abs(pair.points[0]!.y) < 1e-9);
});

// ---------------------------------------------------------------------------
// Coordination — bill of materials
// ---------------------------------------------------------------------------

test("BOM: exact quantities (line 400 + circle r=100); unassigned row LAST; missing material → unassigned", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete" }));
  // Assign only the LINE; the circle stays unassigned.
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: m.materialId }));
  const bom = val<{ unit: string; rows: BomRow[] }>(await qq(h, "materials.bom", {}));
  assert.equal(bom.unit, "document units");
  assert.equal(bom.rows.length, 2);
  const assigned = bom.rows[0]!;
  assert.equal(assigned.materialId, m.materialId);
  assert.equal(assigned.name, "Concrete C30");
  assert.equal(assigned.count, 1);
  assert.equal(assigned.length, 400);
  assert.equal(assigned.area, 0);
  const unassigned = bom.rows[1]!;
  assert.equal(unassigned.materialId, null);
  assert.equal(unassigned.count, 1);
  // Circle: length 2πr, area πr² — rounded to 1e-6.
  assert.equal(unassigned.length, Math.round((2 * Math.PI * 100) * 1e6) / 1e6);
  assert.equal(unassigned.area, Math.round((Math.PI * 100 * 100) * 1e6) / 1e6);
  // A materialId reference to a MISSING material reads as unassigned. The
  // remove gate keeps the API path reference-clean (material_in_use), so a
  // dangling reference only exists in hand-forged legacy data — forged here
  // through the raw document edit; the reader must fold it, never guess.
  const lineProps = h.document.elementById(scene.lineId)!.props as Record<string, unknown>;
  h.document.execute({ type: "setProps", elementId: scene.lineId, patch: { ...lineProps, materialId: "el-999999" } });
  const bom2 = val<{ rows: BomRow[] }>(await qq(h, "materials.bom", {}));
  // The dangling assignment on the line folds into the unassigned bucket
  // (with the still-unassigned circle).
  assert.equal(bom2.rows.length, 1);
  assert.equal(bom2.rows[0]!.materialId, null);
  assert.equal(bom2.rows[0]!.count, 2);
  assert.equal(bom2.rows[0]!.length, 400 + Math.round((2 * Math.PI * 100) * 1e6) / 1e6);
  assert.equal(bom2.rows[0]!.area, Math.round((Math.PI * 100 * 100) * 1e6) / 1e6);
});

test("BOM: a block instance contributes its EXPANDED measures as ONE element", async () => {
  const h = await makeHandler();
  await cmd(h, "document.create", { entityId: "bom-blocks", createdBy: "p012" });
  // Definition content: a 100-long line; the instance scales it ×2 → 200.
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 }] }));
  val(await cmd(h, "block.create", { name: "BAR", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Steel S1", category: "Steel" }));
  const inst = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "BAR", x: 0, y: 0, scale: 2 }));
  val(await cmd(h, "material.assign", { ids: [inst.elementId], materialId: m.materialId }));
  const bom = val<{ rows: BomRow[] }>(await qq(h, "materials.bom", {}));
  assert.equal(bom.rows.length, 1);
  const row = bom.rows[0]!;
  assert.equal(row.materialId, m.materialId);
  assert.equal(row.count, 1, "the instance measures as ONE element");
  assert.equal(row.length, 200, "the expanded (scale ×2) length");
  // An UNASSIGNED instance resolves through the definition's materialId
  // default (instance ?? definition ?? null) — its measures land in the
  // definition-default material's bucket.
  val(await cmd(h, "material.assign", { ids: [inst.elementId], materialId: null }));
  const m2 = val<{ materialId: string }>(await cmd(h, "material.create", { name: "DefMat", category: "Timber" }));
  val(await cmd(h, "block.update", { name: "BAR", patch: { materialId: m2.materialId } }));
  const bom2 = val<{ rows: BomRow[] }>(await qq(h, "materials.bom", {}));
  assert.equal(bom2.rows.length, 1);
  assert.equal(bom2.rows[0]!.materialId, m2.materialId);
  assert.equal(bom2.rows[0]!.count, 1);
  assert.equal(bom2.rows[0]!.length, 200);
  // Undoing the definition edit restores the exact previous record
  // (materialId back to absent — the full-record inverse); the instance's
  // measures then fold into the unassigned bucket.
  val(await cmd(h, "document.undo", {}));
  const comps = val<{ components: ComponentRow[] }>(await qq(h, "components.list", {}));
  assert.equal(comps.components[0]!.materialId, null);
  const bom3 = val<{ rows: BomRow[] }>(await qq(h, "materials.bom", {}));
  assert.equal(bom3.rows.length, 1);
  assert.equal(bom3.rows[0]!.materialId, null);
  assert.equal(bom3.rows[0]!.length, 200);
});

// ---------------------------------------------------------------------------
// Coordination — revision clouds
// ---------------------------------------------------------------------------

test("revcloud: create persists the closed scalloped polyline + bounded marker; clash-excluded; typed failures", async () => {
  const h = await makeHandler();
  await cmd(h, "document.create", { entityId: "revcloud-doc", createdBy: "p012" });
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 400, y2: 0 }] }));
  const rc = val<{ applied: boolean; elementId: string; summary: string }>(
    await cmd(h, "revcloud.create", { cornerA: { x: -50, y: -50 }, cornerB: { x: 450, y: 300 } }),
  );
  assert.equal(rc.applied, true);
  const el = h.document.elementById(rc.elementId)!;
  const props = el.props as Record<string, unknown>;
  assert.equal(props.marker, "revcloud");
  assert.equal(props.closed, true);
  assert.equal(props.type, "polyline");
  assert.equal(props.drafting, true);
  assert.equal(props.layer, "0");
  // 500-wide × 350-tall rect: 8 + 6 + 8 + 6 = 28 scallops × 8 samples.
  assert.equal((props.vertices as { x: number; y: number }[]).length, 224);
  // ONE revision; undo removes it.
  const v0 = val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number;
  val(await cmd(h, "revcloud.create", { cornerA: { x: 0, y: 0 }, cornerB: { x: 100, y: 100 } }));
  assert.equal(val<{ version: { version_number: number } }>(await qq(h, "document.getState", {})).version.version_number, v0 + 1);
  val(await cmd(h, "document.undo", {}));
  // The cloud is clash-EXCLUDED (markup) while the line is checked.
  const clash = val<ClashResult>(await qq(h, "coordination.clash", {}));
  assert.equal(clash.checked, 1);
  assert.equal(clash.excluded, 1);
  assert.equal(clash.pairs.length, 0);
  // Typed failures: degenerate rect, bad payload.
  assert.equal(errOf(await cmd(h, "revcloud.create", { cornerA: { x: 0, y: 0 }, cornerB: { x: 100, y: 0 } })).code, "revcloud_invalid");
  assert.equal(errOf(await cmd(h, "revcloud.create", { cornerA: { x: 0, y: 0 }, cornerB: { x: 0, y: 100 } })).code, "revcloud_invalid");
  assert.equal(errOf(await cmd(h, "revcloud.create", { cornerA: "nope", cornerB: { x: 1, y: 1 } })).code, "revcloud_bad_payload");
  assert.equal(errOf(await cmd(h, "revcloud.create", { cornerA: { x: 0, y: 0 } })).code, "revcloud_bad_payload");
});

// ---------------------------------------------------------------------------
// Determinism + persistence
// ---------------------------------------------------------------------------

test("double-run determinism: the same authoring sequence yields byte-identical saves", async () => {
  const run = async (): Promise<string> => {
    const h = await makeHandler();
    const scene = await authorScene(h);
    const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", density: 2400 }));
    val(await cmd(h, "material.assign", { ids: [scene.lineId, scene.circleId], materialId: m.materialId }));
    val(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 3000], vLines: [0, 2000] }));
    val(await cmd(h, "revcloud.create", { cornerA: { x: -50, y: -50 }, cornerB: { x: 450, y: 300 } }));
    val(await cmd(h, "block.create", { name: "SYM", basePoint: { x: 0, y: 0 }, fromElementIds: [scene.circleId] }));
    val(await cmd(h, "block.update", { name: "SYM", patch: { materialId: m.materialId } }));
    val(await cmd(h, "block.insert", { name: "SYM", x: 1000, y: 1000, scale: 2 }));
    const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
    return JSON.stringify(saved.bytes);
  };
  const a = await run();
  const b = await run();
  assert.equal(a, b);
  assert.ok(a.length > 1000);
});

test("save/open round-trip: materials/grids/BOM/clash/revcloud all survive", async () => {
  const h = await makeHandler();
  const scene = await authorScene(h);
  const m = val<{ materialId: string }>(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", density: 2400 }));
  val(await cmd(h, "material.assign", { ids: [scene.lineId], materialId: m.materialId }));
  val(await cmd(h, "grid.create", { storyId: scene.storyId, uLines: [0, 3000], vLines: [0, 2000] }));
  val(await cmd(h, "revcloud.create", { cornerA: { x: -50, y: -50 }, cornerB: { x: 450, y: 300 } }));
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const reopened = AppApiHandler.create(CONFIG);
  val(await cmd(reopened, "document.open", { source: saved.bytes }));
  const mats = val<{ materials: MaterialRow[] }>(await qq(reopened, "materials.list", {}));
  assert.equal(mats.materials.length, 1);
  assert.equal(mats.materials[0]!.category, "Concrete");
  assert.equal(mats.materials[0]!.density, 2400);
  const grids = val<{ grids: GridRow[] }>(await qq(reopened, "grids.list", {}));
  assert.deepEqual(grids.grids[0]!.uLabels, ["A", "B"]);
  assert.deepEqual(grids.grids[0]!.vLabels, ["1", "2"]);
  const bom = val<{ rows: BomRow[] }>(await qq(reopened, "materials.bom", {}));
  assert.equal(bom.rows.length, 2);
  assert.equal(bom.rows[0]!.length, 400);
  const clash = val<ClashResult>(await qq(reopened, "coordination.clash", {}));
  assert.equal(clash.excluded, 1, "the revision cloud survives and stays excluded");
  const rcEl = reopened.document.allElements().find((el) => (el.props as Record<string, unknown>).marker === "revcloud");
  assert.ok(rcEl !== undefined);
  assert.equal((rcEl.props as Record<string, unknown>).closed, true);
  assert.equal(((rcEl.props as Record<string, unknown>).vertices as unknown[]).length, 224);
});

// ---------------------------------------------------------------------------
// The additive-absence guarantee (CANONICAL-MINIMAL)
// ---------------------------------------------------------------------------

test("additive absence: a pre-P012 document serializes with NO new fields", async () => {
  const h = await makeHandler();
  // Author with PRE-P012 commands only (story/wall via bim.createElements,
  // line/circle via entity.create, a block + instance through P006).
  await cmd(h, "document.create", { entityId: "legacy-doc", createdBy: "legacy" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "st", name: "GF", level: 0, height: 3000 },
      { type: "bim.wall", id: "w1", storyId: "st", start: [0, 0], end: [4000, 0], width: 240, height: 3000 },
    ],
  });
  await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 400, y2: 0 }] });
  await cmd(h, "block.create", { name: "LEGACY", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000002"] });
  await cmd(h, "block.insert", { name: "LEGACY", x: 100, y: 100 });
  const snap = h.document.snapshot();
  const forbidden = ["category", "lineweight", "density", "materialId", "marker"];
  for (const el of snap.elements) {
    for (const key of forbidden) {
      assert.ok(!(key in (el.props as Record<string, unknown>)), `element ${el.id} must not carry the new field '${key}'`);
    }
    assert.notEqual((el.props as Record<string, unknown>).type, "bim.material");
  }
  for (const def of snap.blockDefs ?? []) {
    assert.ok(!("materialId" in (def as unknown as Record<string, unknown>)), "the blockDef must not carry materialId");
  }
  // And the SAVED bytes carry none of the new vocabulary either.
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const text = Buffer.from(saved.bytes).toString("utf8");
  for (const key of forbidden) {
    assert.ok(!text.includes(`"${key}"`), `the legacy save must not contain '${key}'`);
  }
  assert.ok(!text.includes("bim.material"));
  assert.equal(sha(text).length, 64);
});

// ---------------------------------------------------------------------------
// The registry extension (CAD-PARITY-012 vocabulary)
// ---------------------------------------------------------------------------

function pickOf(id: string): EntityPick {
  return { id, kind: "geometry", props: { type: "line" } };
}

function textOf(t: string): PromptValue {
  return { kind: "text", text: t };
}
function pointOf(x: number, y: number): PromptValue {
  return { kind: "point", point: [x, y] };
}
function entitiesOf(picks: readonly EntityPick[]): PromptValue {
  return { kind: "entities", entities: picks };
}

test("registry: exactly the 7 CAD-PARITY-012 commands; names/aliases resolve (CGRID not GRID, MSET not MA)", () => {
  assert.deepEqual(
    COMMANDS_COORDINATION.map((c) => c.id),
    ["material", "matset", "cgrid", "revcloud", "matlist", "bom", "clash"],
  );
  // Registry-level resolution through the merged WORKSPACE_COMMANDS.
  assert.equal(resolveCommand("MATERIAL")!.id, "material");
  assert.equal(resolveCommand("MATSET")!.id, "matset");
  assert.equal(resolveCommand("MSET")!.id, "matset");
  assert.equal(resolveCommand("CGRID")!.id, "cgrid");
  assert.equal(resolveCommand("GRIDLINE")!.id, "cgrid");
  assert.equal(resolveCommand("REVCLOUD")!.id, "revcloud");
  assert.equal(resolveCommand("RVC")!.id, "revcloud");
  assert.equal(resolveCommand("MATLIST")!.id, "matlist");
  assert.equal(resolveCommand("BOM")!.id, "bom");
  assert.equal(resolveCommand("CLASH")!.id, "clash");
  // The collision discipline: GRID stays the drafting-aid toggle, MA stays MATCHPROP.
  assert.equal(resolveCommand("GRID")!.id, "grid-toggle");
  assert.equal(resolveCommand("MA")!.id, "matchprop");
  assert.equal(resolveCommand("ST")!.id, "story");
  // Every command carries the full metadata shape.
  for (const c of COMMANDS_COORDINATION) {
    assert.ok(c.label.length > 0 && c.description.length > 0);
    assert.ok(["bim", "draw", "view"].includes(c.category));
    assert.ok(["Materials", "Coordination"].includes(c.ribbonTab));
  }
  assert.ok(WORKSPACE_COMMANDS.includes(COMMANDS_COORDINATION[0]!));
});

test("registry: MATERIAL builder emits the material.create plan (typed name, flag shortcut, hex color, default lineweight)", () => {
  const material = commandById("material")!;
  const ctx = defaultCommandContext();
  // Typed full category name + #RRGGBB color.
  const p1 = material.build!(
    { name: textOf("Concrete C30"), category: textOf("Concrete"), color: textOf("#a8a29e"), lineweight: { kind: "number", value: 2 } },
    ctx,
  ) as CommandPlan;
  assert.equal(p1.appApi.length, 1);
  assert.equal(p1.appApi[0]!.name, "material.create");
  assert.deepEqual(p1.appApi[0]!.payload, { name: "Concrete C30", category: "Concrete", color: [168, 162, 158], lineweight: 2 });
  // Enter-skip fallbacks: the keyword FLAG (CON), no color (category default), default lineweight.
  const p2 = material.build!(
    {
      name: textOf("Structural concrete"),
      "opt:category:CON": textOf("CON"),
      category: textOf("Generic"),
      lineweight: { kind: "number", value: 1.4 },
    },
    ctx,
  ) as CommandPlan;
  assert.deepEqual(p2.appApi[0]!.payload, {
    name: "Structural concrete",
    category: "Concrete",
    color: [168, 162, 158],
    lineweight: 1.4,
  });
  // A category outside the vocabulary fails typed.
  assert.throws(() => material.build!({ name: textOf("X"), category: textOf("Water") }, ctx), /not in the vocabulary/);
  assert.throws(() => material.build!({ name: textOf("X"), category: textOf("Steel"), color: textOf("red") }, ctx), /#RRGGBB/);
});

test("registry: MATSET builder validates against the context materials table (assign / unassign / unknown)", () => {
  const matset = commandById("matset")!;
  const ctx = defaultCommandContext({
    materials: [{ id: "el-000009", name: "Steel S1", category: "Steel" }],
  });
  const picks = [pickOf("el-000001"), pickOf("el-000002")];
  const assign = matset.build!({ objects: entitiesOf(picks), material: textOf("Steel S1") }, ctx) as CommandPlan;
  assert.equal(assign.appApi.length, 1);
  assert.deepEqual(assign.appApi[0]!.payload, { ids: ["el-000001", "el-000002"], materialId: "el-000009" });
  // Enter on the name step = UNASSIGN.
  const unassign = matset.build!({ objects: entitiesOf(picks) }, ctx) as CommandPlan;
  assert.deepEqual(unassign.appApi[0]!.payload, { ids: ["el-000001", "el-000002"], materialId: null });
  // Unknown material → the typed failure is ECHOED, nothing changes.
  const unknown = matset.build!({ objects: entitiesOf(picks), material: textOf("Nope") }, ctx) as CommandPlan;
  assert.equal(unknown.appApi.length, 0);
  assert.match(unknown.echo[0]!, /'Nope' not found/);
  // No objects → honest no-op echo.
  const empty = matset.build!({}, ctx) as CommandPlan;
  assert.equal(empty.appApi.length, 0);
  assert.match(empty.echo[0]!, /no objects selected/);
  // Legacy contexts (empty materials table) echo the typed failure.
  const legacy = matset.build!({ objects: entitiesOf(picks), material: textOf("Steel S1") }, defaultCommandContext()) as CommandPlan;
  assert.equal(legacy.appApi.length, 0);
  assert.match(legacy.echo[0]!, /not found/);
});

test("registry: CGRID builder parses the ascending line lists; REVCLOUD builder plans the two corners", () => {
  const cgrid = commandById("cgrid")!;
  const ctx = defaultCommandContext({ activeStoryId: "story-gf" });
  const p = cgrid.build!(
    { name: textOf("Structural"), uLines: textOf("0, 3000, 6000"), vLines: textOf("0,2000") },
    ctx,
  ) as CommandPlan;
  assert.deepEqual(p.appApi[0]!.payload, { name: "Structural", storyId: "story-gf", uLines: [0, 3000, 6000], vLines: [0, 2000] });
  // Enter-skip fallbacks: default name omitted, default 2-line sets.
  const defaults = cgrid.build!({ uLines: textOf("0,6000"), vLines: textOf("0,4000") }, defaultCommandContext()) as CommandPlan;
  assert.deepEqual(defaults.appApi[0]!.payload, { uLines: [0, 6000], vLines: [0, 4000] });
  // Non-ascending / duplicates / garbage fail typed.
  assert.throws(() => cgrid.build!({ uLines: textOf("100, 50"), vLines: textOf("0") }, ctx), /strictly-ascending/);
  assert.throws(() => cgrid.build!({ uLines: textOf("5, 5"), vLines: textOf("0") }, ctx), /strictly-ascending/);
  assert.throws(() => cgrid.build!({ uLines: textOf("a, b"), vLines: textOf("0") }, ctx), /strictly-ascending/);
  // REVCLOUD.
  const revcloud = commandById("revcloud")!;
  const rp = revcloud.build!({ cornerA: pointOf(-50, -50), cornerB: pointOf(450, 300) }, defaultCommandContext()) as CommandPlan;
  assert.equal(rp.appApi[0]!.name, "revcloud.create");
  assert.deepEqual(rp.appApi[0]!.payload, { cornerA: { x: -50, y: -50 }, cornerB: { x: 450, y: 300 }, layer: "0" });
  assert.throws(
    () => revcloud.build!({ cornerA: pointOf(0, 0), cornerB: pointOf(100, 0) }, defaultCommandContext()),
    /non-degenerate/,
  );
});

test("registry: MATLIST/BOM/CLASH are instant report commands with the exact ui action strings", () => {
  const ctx = defaultCommandContext();
  const matlist = commandById("matlist")!.instant!(ctx) as CommandPlan;
  assert.deepEqual(matlist, {
    appApi: [],
    echo: ["MATLIST."],
    ui: [{ action: "report.matlist" }, { action: "palette.show", payload: { palette: "coordination" } }],
  });
  const bom = commandById("bom")!.instant!(ctx) as CommandPlan;
  assert.deepEqual(bom.ui, [{ action: "report.bom" }, { action: "palette.show", payload: { palette: "coordination" } }]);
  assert.deepEqual(bom.echo, ["BOM."]);
  const clash = commandById("clash")!.instant!(ctx) as CommandPlan;
  assert.deepEqual(clash.ui, [{ action: "report.clash" }, { action: "palette.show", payload: { palette: "coordination" } }]);
  assert.deepEqual(clash.echo, ["CLASH."]);
  assert.equal(clash.appApi.length, 0);
});
