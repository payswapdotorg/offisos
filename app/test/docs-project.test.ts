/**
 * COMPAT-CAD-003 — deterministic projection math (plan/elevation/section/
 * detail) with EXACT expected coordinates. The representative building is
 * the COMPAT-CAD-002 workflow building (same geometry the BIM suite pins),
 * so documentation projections are pinned against the same canonical model.
 *
 * All expectations are hand-derived from the fixed construction rules in
 * src/docs/project.ts (IEEE-754, fixed operation order). Engine-free.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { projectView, projectDetail } from "../src/docs/project.js";
import type { DocsViewRecord, Element } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-project",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "projection-tests",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}

async function authorBuilding(handler: AppApiHandler): Promise<void> {
  await cmd(handler, "document.create", { entityId: "repr-building" });
  val(await cmd(handler, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-west", storyId: "story-gf", start: [0, 5000], end: [0, 0], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
      { type: "bim.opening", id: "op-win", hostId: "wall-south", distance: 3500, width: 1500, height: 1200, sill: 900 },
      { type: "bim.window", id: "win-1", openingId: "op-win", name: "Facade W1" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
    ],
  }));
}

async function currentElements(handler: AppApiHandler): Promise<Element[]> {
  const snap = val<{ elements: Element[] }>(await handler.handle({ type: "query", name: "document.getState", payload: {} }));
  return snap.elements;
}

test("plan view: wall outlines, centrelines, door/window symbols, slab, space label — exact coordinates", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const view: DocsViewRecord = { id: "vw-plan", kind: "plan", title: "Ground Floor Plan", storyId: "story-gf" };
  const p = projectView(view, elements);

  // 4 walls × (outline polyline + centreline) + door (2 jambs + leaf + arc)
  // + window (band rect + glazing line) + slab rect + space (polygon + text).
  assert.equal(p.primitives.length, 17, JSON.stringify(p.primitives.map((x) => x.type)));
  assert.equal(p.skips.length, 1, "only the story (level container) is skipped");
  assert.equal(p.skips[0]?.elementId, "story-gf");

  // wall-south outline: (0,150) (0,-150) (6000,-150) (6000,150) closed.
  const outline = p.primitives[0]!;
  assert.equal(outline.type, "polyline");
  assert.deepEqual((outline as unknown as unknown as { points: number[][] }).points, [[0, 150], [0, -150], [6000, -150], [6000, 150]]);
  assert.equal((outline as { closed: boolean }).closed, true);
  assert.equal((outline as { sourceId: string }).sourceId, "wall-south");

  // wall-south centreline (0,0)→(6000,0).
  const centre = p.primitives[1]!;
  assert.equal(centre.type, "line");
  assert.deepEqual(
    [(centre as unknown as { from: number[] }).from, (centre as unknown as { to: number[] }).to],
    [[0, 0], [6000, 0]],
  );

  // Door symbol on op-door (distance 500, width 900): jambs at u=500 and u=1400
  // spanning ±150; leaf (500,0)→(500,900); arc centre (500,0) r=900 from π/2 to 0.
  const doorPrims = p.primitives.filter((x) => x.sourceId === "door-main");
  assert.equal(doorPrims.length, 2, "leaf + arc attributed to the door fill");
  const leaf = doorPrims.find((x) => x.type === "line") as unknown as unknown as { from: number[]; to: number[] };
  assert.deepEqual([leaf.from, leaf.to], [[500, 0], [500, 900]]);
  const arc = doorPrims.find((x) => x.type === "arc") as unknown as unknown as { center: number[]; radius: number; startAngle: number; endAngle: number };
  assert.deepEqual(arc.center, [500, 0]);
  assert.equal(arc.radius, 900);
  assert.ok(Math.abs(arc.startAngle - Math.PI / 2) < 1e-12);
  assert.equal(arc.endAngle, 0);
  const doorJambs = p.primitives.filter((x) => x.sourceId === "op-door");
  assert.equal(doorJambs.length, 2);
  assert.deepEqual(
    [(doorJambs[0] as unknown as { from: number[] }).from, (doorJambs[0] as unknown as { to: number[] }).to],
    [[500, 150], [500, -150]],
  );
  assert.deepEqual(
    [(doorJambs[1] as unknown as { from: number[] }).from, (doorJambs[1] as unknown as { to: number[] }).to],
    [[1400, 150], [1400, -150]],
  );

  // Window symbol on op-win (distance 3500, width 1500): band rect + glazing.
  const winPrims = p.primitives.filter((x) => x.sourceId === "win-1");
  assert.equal(winPrims.length, 2);
  const band = winPrims.find((x) => x.type === "polyline") as unknown as unknown as { points: number[][] };
  assert.deepEqual(band.points, [[3500, 150], [3500, -150], [5000, -150], [5000, 150]]);
  const glazing = winPrims.find((x) => x.type === "line") as unknown as unknown as { from: number[]; to: number[] };
  assert.deepEqual([glazing.from, glazing.to], [[3500, 0], [5000, 0]]);

  // Slab outline: (-300,-300)→(6300,5300).
  const slab = p.primitives.find((x) => x.sourceId === "slab-g") as unknown as unknown as { points: number[][] };
  assert.deepEqual(slab.points, [[-300, -300], [6300, -300], [6300, 5300], [-300, 5300]]);

  // Space polygon + label at the shoelace centroid (2500, 2500) — hand-derived.
  const spaceText = p.primitives.find((x) => x.sourceId === "space-office" && x.type === "text") as unknown as unknown as { at: number[]; text: string };
  assert.deepEqual(spaceText.at, [2500, 2500]);
  assert.equal(spaceText.text, "Office 1");

  // View bbox spans the slab.
  assert.deepEqual(p.bbox, { uMin: -300, uMax: 6300, vMin: -300, vMax: 6000 });
});

test("plan view: bare (unfilled) openings emit jamb lines only", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await cmd(handler, "document.create", { entityId: "bare-opening" });
  val(await cmd(handler, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "s", name: "S", level: 0, height: 3000 },
      { type: "bim.wall", id: "w", storyId: "s", start: [0, 0], end: [4000, 0], width: 200, height: 3000 },
      { type: "bim.opening", id: "op", hostId: "w", distance: 1000, width: 800, height: 2000, sill: 0 },
    ],
  }));
  const elements = await currentElements(handler);
  const p = projectView({ id: "v", kind: "plan", title: "P", storyId: "s" }, elements);
  const jambs = p.primitives.filter((x) => x.sourceId === "op");
  assert.equal(jambs.length, 2);
  assert.deepEqual(
    [(jambs[0] as unknown as { from: number[] }).from, (jambs[0] as unknown as { to: number[] }).to],
    [[1000, 100], [1000, -100]],
  );
});

test("elevation front: exact wall/slab rectangles + opening marks on parallel walls", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const view: DocsViewRecord = { id: "vw-front", kind: "elevation", title: "Front Elevation", direction: "front" };
  const p = projectView(view, elements);

  // 4 wall rects + door (rect + leaf line) + window (rect + 2 glazing) + slab.
  assert.equal(p.primitives.length, 10, JSON.stringify(p.primitives.map((x) => x.sourceId)));

  // wall-south: [-150, 6150]×[0, 3000]; wall-east projects to its width band.
  const south = p.primitives.find((x) => x.sourceId === "wall-south") as unknown as unknown as { points: number[][] };
  assert.deepEqual(south.points, [[-150, 0], [6150, 0], [6150, 3000], [-150, 3000]]);
  const east = p.primitives.find((x) => x.sourceId === "wall-east") as unknown as unknown as { points: number[][] };
  assert.deepEqual(east.points, [[5850, 0], [6150, 0], [6150, 3000], [5850, 3000]]);

  // Door opening rect [500, 1400]×[0, 2100] + centre leaf line at u=950.
  const doorRect = p.primitives.find((x) => x.sourceId === "op-door") as unknown as unknown as { points: number[][] };
  assert.deepEqual(doorRect.points, [[500, 0], [1400, 0], [1400, 2100], [500, 2100]]);
  const doorLeaf = p.primitives.find((x) => x.sourceId === "door-main") as unknown as unknown as { from: number[]; to: number[] };
  assert.deepEqual([doorLeaf.from, doorLeaf.to], [[950, 0], [950, 2100]]);

  // Window opening rect [3500, 5000]×[900, 2100] + horizontal glazing at
  // 900+400=1300 and 900+800=1700.
  const winRect = p.primitives.find((x) => x.sourceId === "op-win") as unknown as unknown as { points: number[][] };
  assert.deepEqual(winRect.points, [[3500, 900], [5000, 900], [5000, 2100], [3500, 2100]]);
  const glz = p.primitives.filter((x) => x.sourceId === "win-1") as unknown as { from: number[]; to: number[] }[];
  assert.equal(glz.length, 2);
  assert.deepEqual([glz[0]?.from, glz[0]?.to], [[3500, 1300], [5000, 1300]]);
  assert.deepEqual([glz[1]?.from, glz[1]?.to], [[3500, 1700], [5000, 1700]]);

  // Slab edge [-300, 6300]×[-200, 0].
  const slab = p.primitives.find((x) => x.sourceId === "slab-g") as unknown as unknown as { points: number[][] };
  assert.deepEqual(slab.points, [[-300, -200], [6300, -200], [6300, 0], [-300, 0]]);

  // Spaces + story skipped honestly.
  assert.ok(p.skips.some((x) => x.elementId === "space-office" && x.reason.includes("semantic")));
  assert.ok(p.skips.some((x) => x.elementId === "story-gf"));
});

test("elevation back mirrors u (u = -x); left projects world Y", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const back = projectView({ id: "vb", kind: "elevation", title: "Back", direction: "back" }, elements);
  const southBack = back.primitives.find((x) => x.sourceId === "wall-south") as unknown as { points: number[][] };
  // x ∈ [-150, 6150] mirrors to u ∈ [-6150, 150] — exact mirror.
  assert.deepEqual(southBack.points, [[-6150, 0], [150, 0], [150, 3000], [-6150, 3000]]);

  const left = projectView({ id: "vl", kind: "elevation", title: "Left", direction: "left" }, elements);
  const eastLeft = left.primitives.find((x) => x.sourceId === "wall-east") as unknown as { points: number[][] };
  assert.deepEqual(eastLeft.points, [[-150, 0], [5150, 0], [5150, 3000], [-150, 3000]]);
});

test("section y=2500: perpendicular walls cut to thickness bands; parallel walls skipped; space chord label", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const view: DocsViewRecord = { id: "vs", kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500 };
  const p = projectView(view, elements);

  // wall-east and wall-west cross the plane → thickness bands; south/north skipped.
  const east = p.primitives.find((x) => x.sourceId === "wall-east") as unknown as unknown as { points: number[][] };
  assert.deepEqual(east.points, [[5850, 0], [6150, 0], [6150, 3000], [5850, 3000]]);
  const west = p.primitives.find((x) => x.sourceId === "wall-west") as unknown as { points: number[][] };
  assert.deepEqual(west.points, [[-150, 0], [150, 0], [150, 3000], [-150, 3000]]);
  assert.ok(!p.primitives.some((x) => x.sourceId === "wall-south"));
  assert.ok(!p.primitives.some((x) => x.sourceId === "wall-north"));

  // Slab crosses → its band; space label at the chord midpoint (3000, 1500).
  const slab = p.primitives.find((x) => x.sourceId === "slab-g") as unknown as unknown as { points: number[][] };
  assert.deepEqual(slab.points, [[-300, -200], [6300, -200], [6300, 0], [-300, 0]]);
  const label = p.primitives.find((x) => x.sourceId === "space-office") as unknown as { at: number[]; text: string };
  assert.deepEqual(label.at, [3000, 1500]);
  assert.equal(label.text, "Office 1");

  // Honest skips: south/north walls + both openings (their host is not cut) + story.
  const skippedIds = p.skips.map((x) => x.elementId).sort();
  assert.deepEqual(skippedIds, ["op-door", "op-win", "story-gf", "wall-north", "wall-south"]);
});

test("section x=6000 cuts the east wall lengthwise (parallel cut → full length profile)", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const p = projectView({ id: "vsx", kind: "section", title: "Section B-B", sectionAxis: "x", sectionOffset: 6000 }, elements);
  // wall-east lies in the plane band: full-length profile [0, 5000] in u (= y).
  const east = p.primitives.find((x) => x.sourceId === "wall-east") as unknown as unknown as { points: number[][] };
  assert.deepEqual(east.points, [[0, 0], [5000, 0], [5000, 3000], [0, 3000]]);
});

test("detail view: Liang-Barsky crop + scale of the door region from the plan", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  const plan: DocsViewRecord = { id: "vw-plan", kind: "plan", title: "Plan", storyId: "story-gf" };
  const planProjection = projectView(plan, elements);
  const detail: DocsViewRecord = {
    id: "vw-door-detail",
    kind: "detail",
    title: "Door Detail",
    sourceViewId: "vw-plan",
    region: { x: 300, y: -300, w: 1400, h: 600 },
    detailScale: 2,
  };
  const d = projectDetail(detail, { view: plan, projection: planProjection });

  // The door leaf (500,0)→(500,900) clips at the region top (y=300) then
  // scales: (500,0)→(400,600); (500,300)→(400,1200).
  const leaf = d.primitives.find((x) => x.sourceId === "door-main" && x.type === "line") as unknown as { from: number[]; to: number[] };
  assert.deepEqual([leaf.from, leaf.to], [[400, 600], [400, 1200]]);

  // The west wall outline segment x=0 is fully outside the region → skipped.
  assert.ok(d.skips.length > 0);
  // The south wall centreline (0,0)→(6000,0) clips to (300,0)→(1700,0) →
  // scaled (0,600)→(2800,600) (y=0 maps to (0−(−300))·2 = 600).
  const centre = d.primitives.find((x) => x.sourceId === "wall-south" && x.type === "line") as unknown as { from: number[]; to: number[] };
  assert.deepEqual([centre.from, centre.to], [[0, 600], [2800, 600]]);
});

test("detail of a detail is rejected at the document level; projection of a dangling plan view throws honestly", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await authorBuilding(handler);
  const elements = await currentElements(handler);
  // Dangling story: a plan view for a story id that does not exist.
  assert.throws(
    () => projectView({ id: "v", kind: "plan", title: "P", storyId: "story-missing" }, elements),
    /story 'story-missing' does not exist/,
  );
});
