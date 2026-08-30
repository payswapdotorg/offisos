/**
 * CAD-PARITY-011 (Issue #97) — the representative Archicad-class authoring
 * workflow end to end through the App API: the two-story model with a
 * cross-story roof, a story-linked stair with hosted railings, zoned spaces
 * and a design-option group; classification/property-set/renovation/option
 * lifecycle edits with undo/redo; the stronger host/story relationship
 * rejections; the declared cascades and reference-integrity gates; the
 * deterministic ACTIVE-OPTION behavior of bim.buildGeometry; save/open
 * persistence; Construction Graph mapping through CANONICAL identities; and
 * byte-identical determinism of repeated execution.
 *
 * Engine basis: the REFERENCE geometry adapter (the parity-fixture basis —
 * the exactness class extended by this work item realizes roof/stair/
 * railing solids exactly).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { CADDocument } from "../src/caddocument/index.js";
import { bridgeModelHistory, graphNodeId } from "../src/graph/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "bim-p011-workflow",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "p011-workflow",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errOf(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false);
  const e = r as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}
async function qq(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "query", name: name as never, payload });
}

async function makeHandler(): Promise<{ handler: AppApiHandler; doc: CADDocument }> {
  const handler = AppApiHandler.create(CONFIG);
  return { handler, doc: handler.document };
}

/** Author the representative P011 model. Returns the element ids. */
async function authorModel(handler: AppApiHandler): Promise<Record<string, string>> {
  await cmd(handler, "document.create", { entityId: "p011-building", createdBy: "p011" });
  const created = val<{ created: string[] }>(await cmd(handler, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.story", id: "story-ff", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.wall", id: "wall-s", storyId: "story-gf", start: [0, 0], end: [8000, 0], width: 240, height: 3000 },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office", footprint: [[0, 0], [8000, 0], [8000, 4000], [0, 4000]], height: 3000 },
      { type: "bim.space", id: "space-hall", storyId: "story-gf", name: "Hall", footprint: [[0, 4000], [8000, 4000], [8000, 8000], [0, 8000]], height: 3000 },
      // The main roof sits ON the first floor (eaves at its level).
      { type: "bim.roof", id: "roof-main", storyId: "story-ff", corner1: [-500, -500], corner2: [8500, 8500], ridgeAxis: "x", height: 1500 },
      // A cross-story roof: hosted on GF with the eaves line at the FF level,
      // its ridge REACHING the declared reference story (GF→FF span).
      { type: "bim.roof", id: "roof-span", storyId: "story-gf", corner1: [-1000, -1000], corner2: [9000, 9000], ridgeAxis: "y", height: 2500, baseOffset: 3000, topStoryId: "story-ff" },
      // The story-linked stair (rise DERIVED from the story delta).
      { type: "bim.stair", id: "stair-main", storyId: "story-gf", topStoryId: "story-ff", start: [1000, 6000], direction: [1, 0], width: 1200, stepCount: 16, tread: 280, landingLength: 1200 },
      // Railings derive from the stair (deterministic propagation).
      { type: "bim.railing", id: "railing-left", hostId: "stair-main", side: "left", height: 900 },
      { type: "bim.railing", id: "railing-right", hostId: "stair-main", side: "right", height: 900 },
      // The zone groups both spaces.
      { type: "bim.zone", id: "zone-daylit", name: "Daylit wing", spaceIds: ["space-office", "space-hall"] },
      // The design-option registry.
      { type: "bim.optionGroup", id: "opt-facade", name: "Facade options", options: ["Glazed", "Solid"], activeOption: "Glazed", description: "Ground-floor facade variants" },
    ],
  }));
  assert.equal(created.created.length, 12);
  return {
    storyGf: "story-gf",
    storyFf: "story-ff",
    wallS: "wall-s",
    spaceOffice: "space-office",
    spaceHall: "space-hall",
    roof: "roof-main",
    roofSpan: "roof-span",
    stair: "stair-main",
    railingLeft: "railing-left",
    railingRight: "railing-right",
    zone: "zone-daylit",
    optionGroup: "opt-facade",
  };
}

// ---------------------------------------------------------------------------
// Creation + the vertical relationships
// ---------------------------------------------------------------------------

test("workflow: the representative model authors atomically with the story relationships", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  const building = val<{ stories: unknown[]; zones: unknown[]; optionGroups: unknown[] }>(await qq(handler, "bim.getBuilding", {}));
  assert.equal(building.stories.length, 2);
  assert.equal(building.zones.length, 1);
  assert.equal(building.optionGroups.length, 1);
  // The stair appears on GF with its hosted railings; the roof on FF.
  const b = building as {
    stories: { story: { elementId: string }; stairs: { railings: unknown[] }[]; roofs: unknown[] }[];
  };
  const gf = b.stories.find((s) => s.story.elementId === "story-gf")!;
  assert.equal(gf.stairs.length, 1);
  assert.equal(gf.stairs[0]!.railings.length, 2);
  const ff = b.stories.find((s) => s.story.elementId === "story-ff")!;
  assert.equal(ff.roofs.length, 1);
});

test("workflow: cross-story rejections (roof reach, stair rise, self-reference)", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  // A roof whose ridge does NOT reach the declared top story.
  let r = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.roof", id: "roof-low", storyId: "story-gf", corner1: [0, 0], corner2: [1000, 1000], height: 500, topStoryId: "story-ff" }],
  });
  assert.match(errOf(r).message, /does not reach the declared reference story/);
  // A stair to a LOWER story (negative derived rise).
  r = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.stair", id: "stair-down", storyId: "story-ff", topStoryId: "story-gf", start: [0, 0], direction: [1, 0], width: 1000, stepCount: 10, tread: 280 }],
  });
  assert.match(errOf(r).message, /derived rise .* must climb to a higher story level/);
  // A stair referencing its own host story.
  r = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.stair", id: "stair-self", storyId: "story-gf", topStoryId: "story-gf", start: [0, 0], direction: [1, 0], width: 1000, stepCount: 10, tread: 280 }],
  });
  assert.match(errOf(r).message, /DIFFERENT story above the host story/);
  // A railing on a non-stair host.
  r = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.railing", id: "railing-bad", hostId: "wall-s", height: 900 }],
  });
  assert.match(errOf(r).message, /must reference a stair \(got 'bim.wall'/);
});

test("workflow: story LEVEL edits re-enforce the vertical relationships (typed rejections)", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  // Dropping FF below GF breaks the stair rise AND the roof-span relationship.
  let r = await cmd(handler, "bim.setProperties", { elementId: "story-ff", patch: { level: -1000 } });
  assert.match(errOf(r).message, /derived rise|ABOVE the host story/);
  // Raising GF above FF breaks the roof-span relationship (and would break
  // the stair rise too — the FIRST failure wins deterministically).
  r = await cmd(handler, "bim.setProperties", { elementId: "story-gf", patch: { level: 4000 } });
  assert.match(errOf(r).message, /derived rise|ABOVE the host story/);
  // A legal shift (FF to 3300: rise 3300 > 0; roof-span ridge 3000+2500 =
  // 5500 ≥ 3300; FF still above GF) applies cleanly.
  r = await cmd(handler, "bim.setProperties", { elementId: "story-ff", patch: { level: 3300 } });
  assert.equal(r.ok, true);
  // bim.move of the story (dz) enforces the same gate.
  r = await cmd(handler, "bim.move", { ids: ["story-ff"], dx: 0, dy: 0, dz: -5000 });
  assert.match(errOf(r).message, /derived rise|ABOVE the host story/);
});

test("workflow: the roof top-story self-reference is rejected at creation", async () => {
  const { handler } = await makeHandler();
  await cmd(handler, "document.create", { entityId: "x", createdBy: "x" });
  await cmd(handler, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "s1", name: "One", level: 0, height: 3000 },
      { type: "bim.story", id: "s2", name: "Two", level: 3000, height: 3000 },
    ],
  });
  const r = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.roof", id: "bad", storyId: "s1", corner1: [0, 0], corner2: [1000, 1000], height: 4000, topStoryId: "s1" }],
  });
  assert.match(errOf(r).message, /DIFFERENT story above the host story/);
});

// ---------------------------------------------------------------------------
// Classification / property sets / renovation / options
// ---------------------------------------------------------------------------

test("workflow: classification and property-set edits persist and surface in semantics", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  val(await cmd(handler, "bim.setClassification", { elementId: "roof-main", classificationRef: "OFFISOS-ARCH-120" }));
  val(await cmd(handler, "bim.setPropertySets", {
    elementId: "roof-main",
    propertySets: [
      { name: "Pset_RoofCommon", properties: [{ key: "FireRating", value: "REI30" }, { key: "Pitched", value: true }, { key: "RidgeHeight", value: 3000 }] },
    ],
  }));
  // A cross-type classification is a typed rejection.
  const bad = await cmd(handler, "bim.setClassification", { elementId: "roof-main", classificationRef: "OFFISOS-ARCH-160" });
  assert.match(errOf(bad).message, /does not apply to bim.roof/);
  // The semantics record carries the meta overlay.
  const sem = val<{ semantics: { elementId: string; semantics: Record<string, unknown> }[] }>(await qq(handler, "bim.getSemantics", {}));
  const roofSem = sem.semantics.find((x) => x.elementId === "roof-main")!;
  assert.equal(roofSem.semantics.classificationRef, "OFFISOS-ARCH-120");
  assert.equal((roofSem.semantics.propertySets as { name: string }[])[0]!.name, "Pset_RoofCommon");
  // The classification table query.
  const table = val<{ codes: { code: string }[] }>(await qq(handler, "bim.getClassification", {}));
  assert.ok(table.codes.some((c) => c.code === "OFFISOS-ARCH-120"));
});

test("workflow: renovation lifecycle edits with the derived default and the eligibility boundary", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  val(await cmd(handler, "bim.setRenovation", { elementId: "wall-s", status: "to-be-demolished" }));
  val(await cmd(handler, "bim.setRenovation", { elementId: "stair-main", status: "new" }));
  val(await cmd(handler, "bim.setRenovation", { elementId: "zone-daylit", status: "new" }));
  // Stories are NOT eligible (the typed boundary).
  const bad = await cmd(handler, "bim.setRenovation", { elementId: "story-gf", status: "new" });
  assert.equal(errOf(bad).code, "bim_unsupported");
  assert.match(errOf(bad).message, /not supported on bim.story/);
  // The lifecycle query reports the EFFECTIVE statuses (derived default).
  const life = val<{ elements: { elementId: string; renovationStatus: string }[] }>(await qq(handler, "bim.getLifecycle", {}));
  const byId = new Map(life.elements.map((x) => [x.elementId, x.renovationStatus]));
  assert.equal(byId.get("wall-s"), "to-be-demolished");
  assert.equal(byId.get("stair-main"), "new");
  assert.equal(byId.get("space-office"), "existing"); // the derived default
  // Setting back to "existing" canonicalizes to the ABSENT key (byte-identity).
  val(await cmd(handler, "bim.setRenovation", { elementId: "wall-s", status: "existing" }));
  const snap = val<{ elements: unknown[] }>(await qq(handler, "document.getState", {}));
  const wall = (snap as { elements: { id: string; props: Record<string, unknown> }[] }).elements.find((e) => e.id === "wall-s")!;
  assert.equal(wall.props.meta, undefined);
});

test("workflow: design-option membership + the deterministic ACTIVE-option behavior", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  // Two facade variants: the glazed option holds the hall wall variant...
  val(await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: "Glazed" }));
  val(await cmd(handler, "bim.setOptionMembership", { elementId: "stair-main", optionGroupId: "opt-facade", option: "Solid" }));
  // The options query reports the registry with members per option.
  const opts = val<{ groups: { elementId: string; activeOption: string; membersByOption: { option: string; active: boolean; memberIds: string[] }[] }[] }>(await qq(handler, "bim.getOptions", {}));
  const group = opts.groups.find((g) => g.elementId === "opt-facade")!;
  assert.equal(group.activeOption, "Glazed");
  assert.deepEqual(group.membersByOption.find((m) => m.option === "Glazed")!.memberIds, ["wall-s"]);
  assert.deepEqual(group.membersByOption.find((m) => m.option === "Solid")!.memberIds, ["stair-main"]);
  // Switching the active option is one versioned edit.
  val(await cmd(handler, "bim.setActiveOption", { optionGroupId: "opt-facade", option: "Solid" }));
  // buildGeometry SKIPS the now-inactive member with an explicit reason.
  const built = val<{ built: number; skipped: { elementId: string; reason: string }[] }>(
    await cmd(handler, "bim.buildGeometry", { ids: ["wall-s", "stair-main"] }),
  );
  assert.equal(built.built, 1); // the stair (Solid — now active)
  assert.equal(built.skipped.length, 1);
  assert.equal(built.skipped[0]!.elementId, "wall-s");
  assert.match(built.skipped[0]!.reason, /active option is 'Solid'/);
  // Nothing was deleted — switching back rebuilds the wall (and the stair,
  // a member of the now-inactive option, is skipped with the SAME explicit
  // reason — the deterministic mirror behavior; no destructive duplication).
  val(await cmd(handler, "bim.setActiveOption", { optionGroupId: "opt-facade", option: "Glazed" }));
  const rebuilt = val<{ built: number; skipped: { elementId: string; reason: string }[] }>(
    await cmd(handler, "bim.buildGeometry", { ids: ["wall-s", "stair-main"] }),
  );
  assert.equal(rebuilt.built, 1);
  assert.equal(rebuilt.skipped.length, 1);
  assert.equal(rebuilt.skipped[0]!.elementId, "stair-main");
  assert.match(rebuilt.skipped[0]!.reason, /active option is 'Glazed'/);
  // Membership pair validation.
  const bad = await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: null });
  assert.match(errOf(bad).message, /TOGETHER/);
  const badOption = await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: "Timber" });
  assert.match(errOf(badOption).message, /not declared by option group/);
});

// ---------------------------------------------------------------------------
// Cascades + reference-integrity gates
// ---------------------------------------------------------------------------

test("workflow: the stair copy CASCADE-copies its railings (re-pointed)", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  const copied = val<{ applied: boolean; created: string[]; summary: string }>(
    await cmd(handler, "bim.copy", { ids: ["stair-main"], dx: 3000, dy: 0, dz: 0 }),
  );
  assert.equal(copied.applied, true);
  assert.equal(copied.created.length, 3); // stair + 2 railings
  assert.match(copied.summary, /declared hosted cascades/);
  // The copied railings reference the NEW stair.
  const state = val<{ elements: { id: string; props: Record<string, unknown> }[] }>(await qq(handler, "document.getState", {}));
  const newStair = state.elements.find((e) => e.id === copied.created[0])!;
  assert.equal(newStair.props.type, "bim.stair");
  for (const id of copied.created.slice(1)) {
    const railing = state.elements.find((e) => e.id === id)!;
    assert.equal(railing.props.type, "bim.railing");
    assert.equal(railing.props.hostId, copied.created[0]);
  }
  // A direct railing copy is the typed boundary.
  const bad = await cmd(handler, "bim.copy", { ids: ["railing-left"], dx: 100, dy: 0, dz: 0 });
  assert.match(errOf(bad).message, /copied WITH their stair/);
});

test("workflow: stair deletion cascades its railings; space/option-group deletions are gated", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  // Stair delete cascades railings (declared, itemized).
  const del = val<{ summary: string }>(await cmd(handler, "bim.delete", { ids: ["stair-main"] }));
  assert.match(del.summary, /railing-left, railing-right/);
  // Space deletion is gated by the zone reference.
  const badSpace = await cmd(handler, "bim.delete", { ids: ["space-office"] });
  assert.match(errOf(badSpace).message, /referenced by 1 zone\(s\): zone-daylit/);
  // Option-group deletion is gated by members.
  val(await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: "Glazed" }));
  const badGroup = await cmd(handler, "bim.delete", { ids: ["opt-facade"] });
  assert.match(errOf(badGroup).message, /still referenced by 1 element\(s\): wall-s/);
  // Story deletion is gated by hosted elements (roofs/stairs join the gate).
  const badStory = await cmd(handler, "bim.delete", { ids: ["story-ff"] });
  assert.match(errOf(badStory).message, /hosted element|vertical reference/);
});

test("workflow: option-group option removal is gated while a member references it", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  val(await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: "Glazed" }));
  const bad = await cmd(handler, "bim.setProperties", { elementId: "opt-facade", patch: { options: ["Solid", "Timber"], activeOption: "Solid" } });
  assert.match(errOf(bad).message, /'Glazed' still referenced by element 'wall-s'/);
  // Clearing the membership first unblocks the edit (the active option must
  // survive the new vocabulary — one atomic patch).
  val(await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: null, option: null }));
  val(await cmd(handler, "bim.setProperties", { elementId: "opt-facade", patch: { options: ["Solid", "Timber"], activeOption: "Solid" } }));
});

// ---------------------------------------------------------------------------
// Undo/redo + save/open + graph mapping + determinism
// ---------------------------------------------------------------------------

test("workflow: lifecycle edits are immutable revisions with exact undo/redo", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  val(await cmd(handler, "bim.setRenovation", { elementId: "wall-s", status: "new" }));
  val(await cmd(handler, "bim.setClassification", { elementId: "wall-s", classificationRef: "OFFISOS-ARCH-100" }));
  // Undo both (LIFO) — the meta overlay reverts exactly.
  val(await cmd(handler, "document.undo", {}));
  let state = val<{ elements: { id: string; props: Record<string, unknown> }[] }>(await qq(handler, "document.getState", {}));
  let wall = state.elements.find((e) => e.id === "wall-s")!;
  assert.deepEqual(wall.props.meta, { renovationStatus: "new" });
  val(await cmd(handler, "document.undo", {}));
  state = val(await qq(handler, "document.getState", {}));
  wall = state.elements.find((e) => e.id === "wall-s")!;
  assert.equal(wall.props.meta, undefined);
  // Redo both.
  val(await cmd(handler, "document.redo", {}));
  val(await cmd(handler, "document.redo", {}));
  state = val(await qq(handler, "document.getState", {}));
  wall = state.elements.find((e) => e.id === "wall-s")!;
  assert.deepEqual(wall.props.meta, { classificationRef: "OFFISOS-ARCH-100", renovationStatus: "new" });
});

test("workflow: classification/property edits persist through save/open and map through the Construction Graph with STABLE canonical node ids", async () => {
  const { handler } = await makeHandler();
  await authorModel(handler);
  // The wall's graph node id BEFORE the edits.
  const nodeId = graphNodeId("p011-building", "wall-s");
  val(await cmd(handler, "bim.setClassification", { elementId: "wall-s", classificationRef: "OFFISOS-ARCH-100" }));
  val(await cmd(handler, "bim.setPropertySets", {
    elementId: "wall-s",
    propertySets: [{ name: "Pset_Wall", properties: [{ key: "FireRating", value: "REI90" }] }],
  }));
  // Save → open → the meta overlay survives byte-exactly.
  const saved = val<{ bytes: number[] }>(await cmd(handler, "document.save", {}));
  const beforeEvents = val<{ events_hash: string }>(await qq(handler, "model.getGraphEvents", {}));
  const reopened = AppApiHandler.create(CONFIG);
  await cmd(reopened, "document.open", { source: saved.bytes });
  const life = val<{ elements: { elementId: string; classificationRef?: string; propertySets?: { name: string }[] }[] }>(
    await qq(reopened, "bim.getLifecycle", { elementId: "wall-s" }),
  );
  const wallLife = life.elements.find((x) => x.elementId === "wall-s")!;
  const afterEvents = val<{ events_hash: string }>(await qq(reopened, "model.getGraphEvents", {}));
  assert.equal(afterEvents.events_hash, beforeEvents.events_hash, "identical graph events hash through save/open");
  assert.equal(wallLife.classificationRef, "OFFISOS-ARCH-100");
  assert.equal(wallLife.propertySets![0]!.name, "Pset_Wall");
  // The graph events after the edits: the SAME canonical node id, updated.
  const graph = bridgeModelHistory(handler.document.history as Parameters<typeof bridgeModelHistory>[0]);
  const versionEvents = graph.events.filter((e) => e.event_type === "model.version.created");
  assert.ok(versionEvents.length >= 2);
  const wallEvents = versionEvents.filter((e) =>
    (e.payload as unknown as { elements: { element_id: string; change: string }[] }).elements.some(
      (el) => el.element_id === "wall-s" && el.change === "updated",
    ),
  );
  assert.ok(wallEvents.length >= 2, "the classification + pset edits must produce UPDATED graph events for the wall");
  for (const event of wallEvents) {
    const projection = (event.payload as unknown as { elements: { element_id: string; graph_node_id: string; change: string }[] }).elements.find(
      (el) => el.element_id === "wall-s",
    )!;
    assert.equal(projection.graph_node_id, nodeId, "the canonical graph node id must be STABLE across lifecycle edits");
    assert.equal(projection.change, "updated");
  }
});

test("workflow: repeated execution over identical state yields identical serialization (determinism)", async () => {
  const run = async (): Promise<string> => {
    const { handler } = await makeHandler();
    await authorModel(handler);
    val(await cmd(handler, "bim.setClassification", { elementId: "roof-main", classificationRef: "OFFISOS-ARCH-120" }));
    val(await cmd(handler, "bim.setRenovation", { elementId: "stair-main", status: "new" }));
    val(await cmd(handler, "bim.setOptionMembership", { elementId: "wall-s", optionGroupId: "opt-facade", option: "Glazed" }));
    val(await cmd(handler, "bim.setActiveOption", { optionGroupId: "opt-facade", option: "Solid" }));
    val(await cmd(handler, "bim.buildGeometry", {}));
    const saved = val<{ bytes: number[] }>(await cmd(handler, "document.save", {}));
    return JSON.stringify(saved.bytes);
  };
  const a = await run();
  const b = await run();
  assert.equal(a, b);
  assert.ok(a.length > 1000);
});
