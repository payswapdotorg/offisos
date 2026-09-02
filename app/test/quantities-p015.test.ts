/**
 * CAD-PARITY-015 (Issue #110) — the quantity workflows: the closed
 * canonical rule table (quantities.rules — the typed unsupported surface)
 * and the deterministic REVISION-BOUND takeoff (quantities.run — closed-form
 * measures from the canonical geometry/component/material semantics,
 * grouped subtotals, the material BOM with density-derived mass, the
 * RevisionRef binding of the model head, and the report sha256
 * determinism anchor). Nothing is stored — every run is fresh.
 *
 * Engine-free paths through the dummy bundle (the closed-form rules are
 * pure canonical derivations; real engine BRep measurement stays behind
 * the adapter boundary in the impact cascade surface).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "quantities-p015",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p015-quantities",
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

/** One story, two walls (one with a door opening), a slab, a space, a roof,
 *  a stair and a component — the full canonical measure vocabulary. */
async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p015-quantities-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.story", id: "story-ff", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left" },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
      { type: "bim.roof", id: "roof-main", storyId: "story-ff", corner1: [-300, -300], corner2: [6300, 5300], ridgeAxis: "x", height: 1500 },
      {
        type: "bim.stair", id: "stair-core", storyId: "story-gf", topStoryId: "story-ff",
        start: [1000, 1000], direction: [1, 0], width: 1200, stepCount: 10, tread: 280, baseOffset: 0,
      },
      // A component definition + placed instance (the effective-box volume).
      {
        type: "bim.componentDef", id: "def-column", name: "Structural Column", category: "fixture",
        parameters: { width: 300, depth: 300, height: 2600 },
      },
      {
        type: "bim.componentInstance", id: "inst-column", definitionId: "def-column", storyId: "story-gf",
        position: [2000, 2000], rotation: 0,
      },
    ],
  }));
  // Materials + assignments (the density → mass derivation).
  await val(await cmd(h, "material.create", { name: "Concrete C30", category: "Concrete", color: [128, 128, 128], lineweight: 1.4, density: 2400 }));
  await val(await cmd(h, "material.create", { name: "Glass", category: "Glass", lineweight: 0.7 }));
  await val(await cmd(h, "material.assign", { ids: ["wall-south", "wall-east", "slab-g"], materialId: "el-000001" }));
}

test("quantities: the closed rule table + live counts (the typed unsupported surface)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const rules = val<{
    contract: string;
    units: Record<string, string>;
    measures: string[];
    sources: string[];
    groupings: string[];
    rules: { type: string; length: string | null; area: string | null; volume: string | null }[];
    liveCounts: { type: string; count: number }[];
  }>(await qq(h, "quantities.rules", {}));
  assert.equal(rules.contract, "offisos-quantity-rules/1");
  assert.deepEqual(rules.units, { count: "ea", length: "mm", area: "mm2", volume: "mm3", mass: "kg" });
  assert.deepEqual(rules.sources, ["elements", "components", "materials"]);
  assert.deepEqual(rules.groupings, ["none", "type", "story", "material"]);
  // The closed per-type support matrix.
  const wall = rules.rules.find((r) => r.type === "bim.wall")!;
  assert.ok(wall.length !== null && wall.volume !== null && wall.area === null);
  const door = rules.rules.find((r) => r.type === "bim.door");
  assert.equal(door, undefined, "doors are outside the table — count only (typed honest boundary)");
  // The live per-type counts.
  const live = new Map(rules.liveCounts.map((c) => [c.type, c.count] as const));
  assert.equal(live.get("bim.wall"), 2);
  assert.equal(live.get("bim.roof"), 1);
  assert.equal(live.get("bim.componentInstance"), 1);
  assert.equal(live.get("bim.componentDef"), 1);
});

test("quantities: the canonical closed-form measures (wall/slab/space/roof/stair/component)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const run = val<{
    contract: string;
    rows: { elementId: string; type: string; name: string; story: string; material: string; length: number | null; area: number | null; volume: number | null }[];
    skipped: { elementId: string; type: string; reason: string }[];
    reportSha256: string;
  }>(await qq(h, "quantities.run", { source: "elements" }));
  assert.equal(run.contract, "offisos-quantities/1");

  const byId = new Map(run.rows.map((r) => [r.elementId, r] as const));
  // wall-south: gross 6000·300·3000 − the door void 900·2100·300.
  const south = byId.get("wall-south")!;
  assert.equal(south.length, 6000);
  assert.equal(south.volume, 6000 * 300 * 3000 - 900 * 2100 * 300);
  assert.equal(south.name, "South wall");
  assert.equal(south.story, "Ground Floor");
  assert.equal(south.material, "Concrete C30");
  // wall-east: no openings.
  const east = byId.get("wall-east")!;
  assert.equal(east.volume, 5000 * 300 * 3000);
  assert.equal(east.material, "Concrete C30");
  // slab: 6600 × 5600 × 200.
  const slab = byId.get("slab-g")!;
  assert.equal(slab.area, 6600 * 5600);
  assert.equal(slab.volume, 6600 * 5600 * 200);
  // space: the authored shoelace area × height.
  const space = byId.get("space-office")!;
  assert.equal(space.area, 6000 * 3000);
  assert.equal(space.volume, 6000 * 3000 * 3000);
  // roof: the gable prism span · ridgeLength · height / 2
  // (span = 5600 across the ridge axis x, ridgeLength = 6600).
  const roof = byId.get("roof-main")!;
  assert.equal(roof.volume, (5600 * 6600 * 1500) / 2);
  // stair: tread · width · rise · n(n+1)/2 with rise = 3000/10.
  const stair = byId.get("stair-core")!;
  assert.equal(stair.volume, 280 * 1200 * (3000 / 10) * ((10 * 11) / 2));
  // component instance: the effective box 300·300·2600.
  const column = byId.get("inst-column")!;
  assert.equal(column.volume, 300 * 300 * 2600);
  // The unmeasured types are reported honestly (never approximated).
  const skippedIds = run.skipped.map((s) => s.elementId).sort();
  assert.deepEqual(skippedIds, ["def-column", "door-main", "el-000001", "el-000002", "op-door", "story-ff", "story-gf"]);
  assert.ok(run.skipped.every((s) => s.reason === "no-canonical-rule"));
  assert.match(run.reportSha256, /^[0-9a-f]{64}$/);
});

test("quantities: the revision binding — reproducible against the model head, tracking mutations", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const first = val<{
    revision: { revision_number: number; content_hash: string };
    rows: { elementId: string; volume: number | null }[];
    reportSha256: string;
  }>(await qq(h, "quantities.run", { source: "elements" }));
  // Bound to the current model head (the seed = createElements +
  // material.create ×2 + material.assign = 4 versioned commands).
  assert.equal(first.revision.revision_number, 4);
  assert.match(first.revision.content_hash, /^[0-9a-f]{64}$/);
  // Deterministic: the same state yields the identical report twice.
  const again = val<typeof first>(await qq(h, "quantities.run", { source: "elements" }));
  assert.equal(again.reportSha256, first.reportSha256);
  assert.equal(again.revision.content_hash, first.revision.content_hash);

  // A canonical mutation moves the binding AND the measures (no stale
  // storage — the report is always fresh).
  await val(await cmd(h, "bim.move", { ids: ["wall-east"], dx: 0, dy: 1000, dz: 0 }));
  const moved = val<typeof first>(await qq(h, "quantities.run", { source: "elements" }));
  assert.equal(moved.revision.revision_number, 5);
  assert.notEqual(moved.revision.content_hash, first.revision.content_hash);
  // The move shifts the binding (a new model revision) — the wall's length
  // (and therefore its volume) is unchanged, but the report is a FRESH
  // derivation over the new state.
  const movedEast = moved.rows.find((r) => r.elementId === "wall-east")!;
  assert.equal(movedEast.volume, 5000 * 300 * 3000);

  // A pure query never records a revision.
  const state = val<{ modelHistory: { revisions: unknown[] } }>(await qq(h, "document.getState", {}));
  assert.equal(state.modelHistory?.revisions.length, 5, "quantities.run records no revision");
});

test("quantities: grouping by type/story/material (subtotals + grand totals)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const byType = val<{
    rows: { elementId: string }[];
    groups: { key: string[]; rowCount: number; count: number; length: number | null; area: number | null; volume: number | null }[];
    totals: { count: number; length: number | null; area: number | null; volume: number | null };
  }>(await qq(h, "quantities.run", { source: "elements", groupBy: "type" }));
  const groups = new Map(byType.groups.map((g) => [g.key[0]!, g] as const));
  assert.equal(groups.get("bim.wall")!.count, 2);
  assert.equal(groups.get("bim.wall")!.length, 11000);
  assert.equal(
    groups.get("bim.wall")!.volume,
    (6000 * 300 * 3000 - 900 * 2100 * 300) + 5000 * 300 * 3000,
  );
  assert.ok(groups.get("bim.space")!.area === 18000000 && groups.get("bim.space")!.volume === 54000000000);
  assert.equal(byType.totals.count, byType.rows.length);

  const byStory = val<{ groups: { key: string[]; count: number }[] }>(await qq(h, "quantities.run", { source: "elements", groupBy: "story" }));
  const storyCounts = new Map(byStory.groups.map((g) => [g.key[0]!, g.count] as const));
  assert.equal(storyCounts.get("Ground Floor"), 6, "the GF-measured elements");
  assert.equal(storyCounts.get("First Floor"), 1, "the roof only");

  const byMaterial = val<{ groups: { key: string[]; volume: number | null }[] }>(await qq(h, "quantities.run", { source: "elements", groupBy: "material" }));
  const materialVolumes = new Map(byMaterial.groups.map((g) => [g.key[0]!, g.volume] as const));
  assert.equal(materialVolumes.get("Concrete C30"), (6000 * 300 * 3000 - 900 * 2100 * 300) + 5000 * 300 * 3000 + 6600 * 5600 * 200);
  assert.equal(materialVolumes.get("-"), 54000000000 + (5600 * 6600 * 1500) / 2 + 280 * 1200 * 300 * 55 + 300 * 300 * 2600);

  // The components source scopes to componentInstance entities only.
  const components = val<{ rows: { elementId: string }[] }>(await qq(h, "quantities.run", { source: "components" }));
  assert.deepEqual(components.rows.map((r) => r.elementId), ["inst-column"]);

  // The filter scopes the elements source (the schedule grammar).
  const walls = val<{ rows: { elementId: string }[] }>(await qq(h, "quantities.run", { source: "elements", filter: { type: "bim.wall" } }));
  assert.deepEqual(walls.rows.map((r) => r.elementId), ["wall-south", "wall-east"]);
});

test("quantities: the material BOM (density-derived mass; honest nulls)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const bom = val<{
    bom: { materialId: string; materialName: string; category: string; count: number; volume: number | null; mass: number | null }[];
    totals: { count: number; volume: number | null };
  }>(await qq(h, "quantities.run", { source: "materials" }));
  // Two BOM rows: Concrete C30 (the three volumed assignments) + the
  // unassigned aggregate (space/roof/stair/component — no material).
  assert.equal(bom.bom.length, 2);
  const concrete = bom.bom.find((r) => r.materialName === "Concrete C30")!;
  assert.equal(concrete.category, "Concrete");
  assert.equal(concrete.count, 3);
  const concreteVolume = (6000 * 300 * 3000 - 900 * 2100 * 300) + 5000 * 300 * 3000 + 6600 * 5600 * 200;
  assert.equal(concrete.volume, concreteVolume);
  // mass = density kg/m³ × volume m³ (the deterministic unit conversion).
  assert.equal(concrete.mass, 2400 * concreteVolume * 1e-9);
  const unassigned = bom.bom.find((r) => r.materialName === "-")!;
  // The Glass material carries no density and no volumed assignment → no row;
  // the unassigned row has no density → honest null mass.
  assert.equal(unassigned.mass, null);
  assert.equal(bom.totals.count, 3 + unassigned.count);
  assert.equal(bom.totals.volume, concreteVolume + unassigned.volume!);
});

test("quantities: typed input failures (source/groupBy/filter grammar)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  assert.equal(errOf(await qq(h, "quantities.run", {})).code, "bad_payload");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "views" })).code, "quantities_invalid");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "elements", groupBy: "layer" })).code, "quantities_invalid");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "materials", groupBy: "type" })).code, "quantities_invalid");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "materials", filter: { type: "bim.wall" } })).code, "quantities_invalid");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "elements", junk: 1 })).code, "quantities_invalid");
  assert.equal(errOf(await qq(h, "quantities.run", { source: "elements", filter: { type: "" } })).code, "quantities_invalid");
});
