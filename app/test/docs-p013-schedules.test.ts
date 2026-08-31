/**
 * CAD-PARITY-013 (Issue #104) — the schedules/indexes shared core: the
 * sch-NNNNNN definitions (closed per-source column vocabulary, dynamic
 * ps:<set>.<key> property columns, elements/components filters) and the
 * FRESH deterministic row derivation (schedules.run — rows are NEVER
 * stored; the same snapshot yields the same rows + sha256 on every host,
 * and canonical mutations flow straight through: no parallel source of
 * truth).
 *
 * Engine-free paths through the dummy bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { DEFAULT_SCHEDULE_COLUMNS } from "../src/workspace/commands-documentation.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-p013-schedules",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p013-schedules",
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

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

const WALL_COLUMNS = ["id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option"];

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p013-schedules-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
    ],
  }));
}

async function createSchedule(
  h: AppApiHandler,
  name: string,
  source: string,
  columns: readonly { key: string; label: string }[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = val<{ schedule: { id: string } }>(await cmd(h, "schedule.create", {
    name, source, columns, ...extra,
  }));
  return created.schedule.id;
}

test("schedules: create with the default column sets; typed failures (source/column/filter/name)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // The default full-vocabulary column sets (≤ 12, humanized labels).
  assert.deepEqual(DEFAULT_SCHEDULE_COLUMNS["elements"]!.map((c) => c.key), WALL_COLUMNS);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["elements"]!.length, 9);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["materials"]!.length, 6);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["views"]!.length, 7);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["layouts"]!.length, 7);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["sheets"]!.length, 5);
  assert.equal(DEFAULT_SCHEDULE_COLUMNS["elements"]![7]!.label, "Renovation Status");
  const id = await createSchedule(h, "All elements", "elements", DEFAULT_SCHEDULE_COLUMNS["elements"]!);
  assert.match(id, /^sch-\d{6}$/);
  // Typed failures.
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      name: "Bad", source: "spaces", columns: [{ key: "id", label: "Id" }],
    })).code,
    "schedule_invalid",
  );
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      // "name" is not in the views vocabulary (views carry "title").
      name: "Bad", source: "views", columns: [{ key: "name", label: "Name" }],
    })).code,
    "schedule_invalid",
  );
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      name: "Bad", source: "elements", columns: [{ key: "volume", label: "Volume" }],
    })).code,
    "schedule_invalid",
  );
  // The dynamic ps:<set>.<key> columns validate on the elements/components
  // sources only.
  await createSchedule(h, "PS", "elements", [{ key: "ps:PSetA.FireRating", label: "Fire Rating" }]);
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      name: "Bad", source: "materials", columns: [{ key: "ps:PSetA.FireRating", label: "FR" }],
    })).code,
    "schedule_invalid",
  );
  // A filter is only valid on the elements/components sources.
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      name: "Bad", source: "layouts", filter: { type: "bim.wall" }, columns: [{ key: "id", label: "Id" }],
    })).code,
    "schedule_invalid",
  );
  // Duplicate name.
  assert.equal(
    errOf(await cmd(h, "schedule.create", {
      name: "All elements", source: "elements", columns: [{ key: "id", label: "Id" }],
    })).code,
    "schedule_exists",
  );
  // Run: unknown id.
  assert.equal(errOf(await qq(h, "schedules.run", { id: "sch-999999" })).code, "schedule_not_found");
});

test("schedules: elements rows resolve every cell deterministically (story/material/meta/ps: columns)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // Enrich the model: material + assignment, classification, renovation,
  // property sets.
  await val(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", color: [128, 128, 128], lineweight: 1.4, density: 2400 }));
  await val(await cmd(h, "material.assign", { ids: ["wall-south", "wall-east"], materialId: "el-000001" }));
  await val(await cmd(h, "bim.setClassification", { elementId: "wall-south", classificationRef: "OFFISOS-ARCH-100" }));
  await val(await cmd(h, "bim.setRenovation", { elementId: "wall-south", status: "new" }));
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-south",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 90 }] }],
  }));
  const columns = [
    ...DEFAULT_SCHEDULE_COLUMNS["elements"]!.slice(0, 8),
    { key: "ps:PSetA.FireRating", label: "Fire Rating" },
  ];
  const id = await createSchedule(h, "Elements enriched", "elements", columns);
  const run = val<{ rows: readonly (readonly string[])[]; rowCount: number; sha256: string }>(
    await qq(h, "schedules.run", { id }),
  );
  // Rows: the 6 seed entities + the material record, document order.
  assert.deepEqual(run.rows.map((r) => r[0]), [
    "story-gf", "wall-south", "wall-east", "op-door", "door-main", "space-office", "el-000001",
  ]);
  assert.equal(run.rowCount, 7);
  // The enriched wall row: every cell resolves.
  const wall = run.rows[1]!;
  assert.deepEqual(wall, [
    "wall-south",      // id
    "bim.wall",        // type
    "South wall",      // name
    "Ground Floor",    // story (resolved name)
    "-",               // layer (BIM elements carry no drafting layer)
    "Concrete C30",    // material (resolved name)
    "OFFISOS-ARCH-100",// classification
    "new",             // renovationStatus (effective state)
    "90",              // ps:PSetA.FireRating
  ]);
  // Defaults: absent classification/renovation "existing".
  const east = run.rows[2]!;
  assert.equal(east[6], "-");
  assert.equal(east[7], "existing");
  assert.equal(east[8], "-");
  // The opening (hosted, no storyId of its own) reads "-" for story.
  assert.equal(run.rows[3]![3], "-");
  // The door's storyId was derived from the host wall at creation.
  assert.equal(run.rows[4]![3], "Ground Floor");
  // The material record row itself.
  assert.deepEqual(run.rows[6]!.slice(0, 3), ["el-000001", "bim.material", "Concrete C30"]);
  // Boolean rendering through the ps: column (typed values).
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-east",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: true }] }],
  }));
  const rerun = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id }));
  assert.equal(rerun.rows[2]![8], "true");
});

test("schedules: run determinism — the same doc yields identical rows + sha256 twice; nothing is stored", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const id = await createSchedule(h, "All elements", "elements", DEFAULT_SCHEDULE_COLUMNS["elements"]!);
  const run1 = val<{ rows: readonly (readonly string[])[]; rowCount: number; sha256: string }>(await qq(h, "schedules.run", { id }));
  const run2 = val<{ rows: readonly (readonly string[])[]; rowCount: number; sha256: string }>(await qq(h, "schedules.run", { id }));
  assert.deepEqual(run1.rows, run2.rows);
  assert.equal(run1.sha256, run2.sha256);
  assert.match(run1.sha256, /^[0-9a-f]{64}$/);
  // Rows are NEVER stored: the snapshot carries no rows anywhere (and a
  // query never records a revision — createElements + schedule.create are
  // the two versioned edits; document.create itself records none).
  const state = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  assert.equal(state.modelHistory?.revisions.length, 2, "a query never records a revision");
});

test("schedules: rows track canonical mutations — no parallel source of truth", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await val(await cmd(h, "docs.createViews", {
    views: [{ kind: "plan", title: "Ground Floor Plan", storyId: "story-gf" }],
  }));
  await val(await cmd(h, "material.create", { name: "Steel S355", category: "Steel", lineweight: 0.8, density: 7850 }));
  await val(await cmd(h, "material.create", { name: "Glass", category: "Glass" }));
  const viewsId = await createSchedule(h, "View index", "views", DEFAULT_SCHEDULE_COLUMNS["views"]!);
  const materialsId = await createSchedule(h, "Material index", "materials", DEFAULT_SCHEDULE_COLUMNS["materials"]!);

  const before = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: viewsId }));
  const matBefore = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: materialsId }));
  assert.equal(matBefore.rows.length, 2);

  // A canonical MODEL mutation (move a wall) flows straight into the
  // view-index contentHash/primitives cells (the rows are derived fresh).
  await val(await cmd(h, "bim.move", { ids: ["wall-east"], dx: 500, dy: 0, dz: 0 }));
  const after = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: viewsId }));
  assert.equal(after.rows[0]![1], "plan");
  assert.notEqual(after.rows[0]![5], before.rows[0]![5], "the plan view's contentHash cell changed after the move");
  assert.match(after.rows[0]![5]!, /^[0-9a-f]{64}$/);

  // Deleting a material removes its row from the material index.
  await val(await cmd(h, "material.remove", { elementId: "el-000002" }));
  const matAfter = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: materialsId }));
  assert.deepEqual(matAfter.rows.map((r) => r[1]), ["Steel S355"]);
});

test("schedules: the views/layouts/sheets index sources (contentHash/title/sheetNumber cells)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await val(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front" },
    ],
  }));
  await val(await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "Ground Floor Documentation",
      titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101" },
      viewPlacements: [
        { viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 },
        { viewId: "vw-000002", x: 320, y: 10, w: 300, h: 280 },
      ],
    }],
  }));
  await val(await cmd(h, "layout.create", { name: "GF" }));
  await val(await cmd(h, "layout.create", { name: "FF" }));
  const subset = val<{ node: { id: string } }>(await cmd(h, "navigator.createSubset", { name: "S", prefix: "A", numbering: "custom", customNumber: "01" }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  const folder = val<{ node: { id: string } }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));

  const viewsId = await createSchedule(h, "Views", "views", DEFAULT_SCHEDULE_COLUMNS["views"]!);
  const views = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: viewsId }));
  assert.deepEqual(views.rows.map((r) => [r[0], r[1], r[2], r[3], r[4]]), [
    ["vw-000001", "plan", "Ground Floor Plan", "50", "Plans"],
    ["vw-000002", "elevation", "Front Elevation", "-", "-"],
  ]);
  assert.match(views.rows[0]![5]!, /^[0-9a-f]{64}$/, "the filed view's fresh content hash");
  assert.ok(Number(views.rows[0]![6]) > 0, "primitive count cell");

  const layoutsId = await createSchedule(h, "Layouts", "layouts", DEFAULT_SCHEDULE_COLUMNS["layouts"]!);
  const layouts = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: layoutsId }));
  assert.deepEqual(layouts.rows.map((r) => [r[1], r[2], r[3], r[4], r[5], r[6]]), [
    ["GF", "S", "-", "A-01", "-", "-"],
    ["FF", "-", "-", "L01", "-", "-"],
  ]);

  const sheetsId = await createSchedule(h, "Sheets", "sheets", DEFAULT_SCHEDULE_COLUMNS["sheets"]!);
  const sheets = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: sheetsId }));
  assert.deepEqual(sheets.rows.map((r) => [r[1], r[2], r[3], r[4]]), [
    ["Ground Floor Documentation", "A-101", "Offisos Demo", "2"],
  ]);
});

test("schedules: filters scope the elements/components sources (type and story)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const byType = await createSchedule(h, "Walls only", "elements", [{ key: "id", label: "Id" }, { key: "type", label: "Type" }], {
    filter: { type: "bim.wall" },
  });
  const walls = val<{ rows: readonly (readonly string[])[]; rowCount: number }>(await qq(h, "schedules.run", { id: byType }));
  assert.deepEqual(walls.rows.map((r) => r[0]), ["wall-south", "wall-east"]);
  assert.equal(walls.rowCount, 2);
  const byStory = await createSchedule(h, "GF only", "elements", [{ key: "id", label: "Id" }], {
    filter: { storyId: "story-gf" },
  });
  const gf = val<{ rows: readonly (readonly string[])[] }>(await qq(h, "schedules.run", { id: byStory }));
  // The story filter keeps the entities whose storyId resolves to the story
  // (the opening has no storyId of its own — hosted entities resolve through
  // their hosts only in the tree's elementCount rule, the schedule filter is
  // the direct storyId match).
  assert.deepEqual(gf.rows.map((r) => r[0]), ["wall-south", "wall-east", "door-main", "space-office"]);
});

test("schedules: list/update/remove with the typed failure codes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const id = await createSchedule(h, "All elements", "elements", DEFAULT_SCHEDULE_COLUMNS["elements"]!);
  const list = val<{ schedules: { id: string; name: string; source: string; columnCount: number }[] }>(await qq(h, "schedules.list", {}));
  assert.deepEqual(list.schedules.map((s) => [s.id, s.name, s.source, s.columnCount]), [
    [id, "All elements", "elements", 9],
  ]);
  // Update: rename + narrow the columns; the merged record revalidates.
  val(await cmd(h, "schedule.update", { id, patch: { name: "Elements (narrow)", columns: [{ key: "id", label: "Id" }, { key: "type", label: "Type" }] } }));
  const run = val<{ schedule: { name: string; columns: { key: string }[] }; rows: readonly (readonly string[])[] }>(
    await qq(h, "schedules.run", { id }),
  );
  assert.equal(run.schedule.name, "Elements (narrow)");
  assert.equal(run.schedule.columns.length, 2);
  assert.equal(run.rows[0]!.length, 2);
  // Unknown id / bad patch.
  assert.equal(errOf(await cmd(h, "schedule.update", { id: "sch-999999", patch: { name: "X" } })).code, "schedule_not_found");
  assert.equal(
    errOf(await cmd(h, "schedule.update", { id, patch: { columns: [{ key: "junk", label: "J" }] } })).code,
    "schedule_invalid",
  );
  // Remove (no gates — nothing references a schedule).
  val(await cmd(h, "schedule.remove", { id }));
  assert.equal(errOf(await qq(h, "schedules.run", { id })).code, "schedule_not_found");
  assert.equal(errOf(await cmd(h, "schedule.remove", { id })).code, "schedule_not_found");
});
