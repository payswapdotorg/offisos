/**
 * COMPAT-CAD-002 — the representative building workflow end to end through
 * the App API: Story → Walls → Slab → Openings → Door/Window → Space → 3D
 * editing → immutable revisions → verified replay → save/open persistence →
 * Construction Graph provenance (engine-free parts use the dummy bundle; the
 * real-engine realization is asserted in bim-occt.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { bridgeModelHistory, graphNodeId } from "../src/graph/index.js";
import { CADDocument } from "../src/caddocument/index.js";
import { buildBimCreate } from "../src/bim/commands.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "bim-workflow",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "workflow",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}
async function qq(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "query", name: name as never, payload });
}

/** Author the representative building: one story, four perimeter walls (the
 *  south wall carries a door opening and a window opening), a ground slab,
 *  door + window fills and an L-shaped office space. Returns element ids. */
async function authorBuilding(handler: AppApiHandler): Promise<Record<string, string>> {
  await cmd(handler, "document.create", { entityId: "repr-building" });
  const created = val<{ created: string[] }>(await cmd(handler, "bim.createElements", {
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
  assert.equal(created.created.length, 11);
  return {
    story: "story-gf", south: "wall-south", east: "wall-east", north: "wall-north", west: "wall-west",
    slab: "slab-g", doorOpening: "op-door", door: "door-main", winOpening: "op-win", window: "win-1", space: "space-office",
  };
}

test("authoring → immutable revisions → verified replay of the full building history", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  // 3D edits: move the door opening +600 along the wall; copy the north wall.
  await cmd(handler, "bim.move", { ids: [ids.doorOpening], dx: 600, dy: 0, dz: 0 });
  await cmd(handler, "bim.copy", { ids: [ids.north], dx: 0, dy: -1000, dz: 0 });
  // Set a camera preset (persisted workspace state).
  await cmd(handler, "bim.setSettings", { settings: { camera: { preset: "top" } } });

  const history = val<{ revisions: unknown[] }>(await qq(handler, "model.getHistory", {}));
  assert.equal(history.revisions.length, 3, "create batch + move + copy = 3 revisions");

  // Verified replay to EVERY revision (information-state correct).
  for (let k = 0; k <= 3; k++) {
    const replayed = val<{ verified: boolean; revision_number: number }>(await qq(handler, "model.replay", { revision_number: k }));
    assert.equal(replayed.verified, true, `replay to revision ${k} verifies`);
    assert.equal(replayed.revision_number, k);
  }
  // The move revision's applied edit is the recorded atomic batch.
  const state0 = val<CADDocumentSnapshot>(await qq(handler, "document.getState", {}));
  const cameraMove = state0.elements.find((el) => el.id === ids.doorOpening)!.props as Record<string, unknown>;
  assert.equal(cameraMove.distance, 1100, "door opening moved by +600 along the host axis");
});

test("save/open preserves geometry provenance, semantics, identities and lineage", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  // Realize geometry through the bound (dummy) engine — one versioned build.
  const built = val<{ built: number; results: { elementId: string; meshToken: string }[]; skipped: { elementId: string; reason: string }[] }>(
    await cmd(handler, "bim.buildGeometry", {}),
  );
  assert.equal(built.built, 10, "every solid-bearing element realized");
  assert.deepEqual(
    built.skipped.map((s) => s.elementId),
    [ids.story],
    "the story is skipped with an honest reason",
  );
  assert.match(built.skipped[0]!.reason, /level container/);

  const saved = val<{ bytes: number[] }>(await cmd(handler, "document.save", {}));
  const beforeState = val<CADDocumentSnapshot>(await qq(handler, "document.getState", {}));
  const beforeEvents = val<{ events_hash: string }>(await qq(handler, "model.getGraphEvents", {}));

  const reopened = AppApiHandler.create(CONFIG);
  const opened = val<CADDocumentSnapshot>(await cmd(reopened, "document.open", { source: saved.bytes }));
  assert.equal(opened.elements.length, 11);
  assert.equal(reopened.currentContentHash(), handler.currentContentHash(), "identical parity content hash through save/open");
  const afterEvents = val<{ events_hash: string }>(await qq(reopened, "model.getGraphEvents", {}));
  assert.equal(afterEvents.events_hash, beforeEvents.events_hash, "identical graph events hash through save/open");
  // Geometry provenance survives (meshToken + engine record on each built element).
  const wallProps = opened.elements.find((el) => el.id === ids.south)!.props as Record<string, unknown>;
  assert.equal(typeof wallProps.meshToken, "string");
  assert.deepEqual(wallProps.geometryEngine, { engineId: "dummy-geometry", engineVersion: "0.1.0" });
  // Verified replay on the OPENED document (adopted history).
  for (let k = 0; k <= 2; k++) {
    const replayed = val<{ verified: boolean }>(await qq(reopened, "model.replay", { revision_number: k }));
    assert.equal(replayed.verified, true);
  }
  assert.equal(beforeState.bimSettings?.camera.preset, "iso", "default camera preset");
});

test("Construction Graph provenance: OBSERVED semantics for BIM elements, engine-independent identity", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  await cmd(handler, "bim.buildGeometry", {});

  const graphValue = val<{ events: unknown[] }>(await qq(handler, "model.getGraphEvents", {}));
  // Find the create-batch revision event and inspect its projections.
  const payloadOf = (e: unknown) => (e as { payload: { elements: { element_id: string; kind: string; engineId: string | null; uncertainty: Record<string, string>; graph_node_id: string }[] } }).payload;
  const versionEvents = graphValue.events.map((e) => payloadOf(e)).filter((p) => p.elements.length > 0);
  const createProjections = versionEvents[0]!.elements;
  const wallProjection = createProjections.find((p) => p.element_id === ids.south)!;
  assert.equal(wallProjection.kind, "bim");
  assert.equal(wallProjection.engineId, null, "engineId stays provenance-only (null at authoring)");
  assert.equal(wallProjection.uncertainty.semantics, "OBSERVED", "authored BIM semantics are extracted and observed");

  // Engine independence of canonical identity: the SAME building authored in a
  // second document with a DIFFERENT engine realization keeps identical graph
  // node ids (graphNodeId derives from entity + element ids only — LOCK-019).
  const docA = CADDocument.empty("entity-x", "offisos-dummy", "1", "t");
  const docB = CADDocument.empty("entity-x", "offisos-dummy", "1", "t");
  const building = [
    { type: "bim.story", id: "story-gf", name: "GF", level: 0, height: 3000 },
    { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  ];
  docA.execute(buildBimCreate([], building).edit);
  docB.execute(buildBimCreate([], building).edit);
  // Different engine provenance attached on B (hand-written provenance record).
  docB.execute({
    type: "applyEdits",
    edits: [{ type: "updateElement", elementId: "wall-south", patch: { meshToken: "occt:different-engine", geometryEngine: { engineId: "occt", engineVersion: "7.8.1.1.post1" } } }],
  });
  const nodeA = graphNodeId("entity-x", "wall-south");
  const nodeB = graphNodeId("entity-x", "wall-south");
  assert.equal(nodeA, nodeB, "graph node identity is independent of engine provenance");
  const bridgeB = bridgeModelHistory(docB.history);
  const lastEvent = bridgeB.events[bridgeB.events.length - 1]!;
  const projection = (lastEvent as unknown as { payload: { elements: { element_id: string; uncertainty: Record<string, string> }[] } }).payload.elements
    .find((p) => p.element_id === "wall-south")!;
  assert.equal(projection.uncertainty.geometry_provenance, "OBSERVED", "realized build flips geometry provenance to OBSERVED");
  assert.equal(projection.uncertainty.semantics, "OBSERVED");
  // And BEFORE realization the geometry provenance is honestly UNKNOWN.
  const bridgeA = bridgeModelHistory(docA.history);
  const authoredWall = bridgeA.events
    .flatMap((e) => (e as unknown as { payload: { elements: { element_id: string; uncertainty: Record<string, string> }[] } }).payload.elements)
    .find((p) => p.element_id === "wall-south")!;
  assert.equal(authoredWall.uncertainty.geometry_provenance, "UNKNOWN", "purely authored elements carry no geometry provenance claim");
});

test("bim.getBuilding returns the deterministic story→elements structure", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  const building = val<{
    stories: {
      story: { semantics: Record<string, unknown> };
      walls: { elementId: string; openings: { elementId: string; fills: { elementId: string }[] }[] }[];
      slabs: { elementId: string }[];
      spaces: { elementId: string; semantics: Record<string, unknown> }[];
    }[];
    bimSettings: { camera: { preset: string } };
  }>(await qq(handler, "bim.getBuilding", {}));
  assert.equal(building.stories.length, 1);
  const story = building.stories[0]!;
  assert.equal(story.walls.length, 4);
  assert.deepEqual(story.walls.map((w) => w.elementId), [ids.east, ids.north, ids.south, ids.west], "walls in canonical id order");
  const south = story.walls.find((w) => w.elementId === ids.south)!;
  assert.equal(south.openings.length, 2);
  const doorOpening = south.openings.find((o) => o.elementId === ids.doorOpening)!;
  assert.deepEqual(doorOpening.fills.map((f) => f.elementId), [ids.door]);
  const space = story.spaces[0]!;
  assert.equal(space.elementId, ids.space);
  assert.equal(space.semantics.area, 27_000_000, "semantic space area surfaced");
  assert.equal(space.semantics.name, "Office 1");
  assert.equal(building.bimSettings.camera.preset, "iso");
});

test("bim.getSemantics + bim.camera serve deterministic queries", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  const one = val<{ elementId: string; type: string; semantics: Record<string, unknown> }>(
    await qq(handler, "bim.getSemantics", { elementId: ids.space }),
  );
  assert.equal(one.type, "bim.space");
  assert.equal(one.semantics.area, 27_000_000);
  const all = val<{ semantics: { elementId: string }[] }>(await qq(handler, "bim.getSemantics", {}));
  assert.equal(all.semantics.length, 11);
  const camera = val<{ camera: { preset: string; eye: number[]; target: number[]; up: number[] }; bbox: number[] }>(
    await qq(handler, "bim.camera", { preset: "iso" }),
  );
  assert.equal(camera.camera.preset, "iso");
  assert.deepEqual(camera.bbox, [-300, -300, -200, 6300, 6000, 3000], "model bbox from derived world extents (the L-space reaches y=6000)");
  // Unknown semantics targets are typed rejects.
  const bad = await qq(handler, "bim.getSemantics", { elementId: "nope" });
  assert.equal(bad.ok, false);
});

test("undo of a key-adding patch (geometry build) serializes and reopens correctly (regression)", async () => {
  // Defect class found by the COMPAT-CAD-002 Electron smoke: undoing a patch
  // that ADDED a prop key produced an inverse with undefined previous values,
  // which corrupted canonical serialization (invalid JSON on save/open).
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  await cmd(handler, "bim.buildGeometry", {});
  await cmd(handler, "document.undo", {});
  // The undo removed the attached geometry provenance (key removal works)…
  const undone = val<CADDocumentSnapshot>(await qq(handler, "document.getState", {}));
  const wallProps = undone.elements.find((el) => el.id === ids.south)!.props as Record<string, unknown>;
  assert.equal(wallProps.meshToken, undefined, "undo removed the added meshToken key");
  // …and the document STILL saves/opens with identical identity.
  const saved = val<{ bytes: number[] }>(await cmd(handler, "document.save", {}));
  const beforeEvents = val<{ events_hash: string }>(await qq(handler, "model.getGraphEvents", {}));
  const reopened = AppApiHandler.create(CONFIG);
  const opened = val<CADDocumentSnapshot>(await cmd(reopened, "document.open", { source: saved.bytes }));
  assert.equal(opened.elements.length, 11);
  const afterEvents = val<{ events_hash: string }>(await qq(reopened, "model.getGraphEvents", {}));
  assert.equal(afterEvents.events_hash, beforeEvents.events_hash, "identical events hash through save-after-undo");
  // Verified replay including the undo revision (recorded as setProps inverse).
  for (let k = 0; k <= 2; k++) {
    const replayed = val<{ verified: boolean }>(await qq(reopened, "model.replay", { revision_number: k }));
    assert.equal(replayed.verified, true);
  }
});

test("canonicalStringify rejects undefined values (LOCK-007 hardening)", async () => {
  const { canonicalStringify } = await import("../src/caddocument/serialization.js");
  assert.throws(() => canonicalStringify({ a: undefined }), /undefined is not representable/);
  assert.throws(() => canonicalStringify([1, undefined]), /undefined is not representable/);
  assert.equal(canonicalStringify({ a: 1, b: null }), '{"a":1,"b":null}');
});

test("typed failures: unsupported BIM operations never silently approximate", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const ids = await authorBuilding(handler);
  // Move a fill directly → bim_unsupported.
  const fillMove = await cmd(handler, "bim.move", { ids: [ids.door], dx: 10, dy: 0, dz: 0 });
  assert.equal(fillMove.ok, false);
  assert.equal((fillMove as { code: string }).code, "bim_unsupported");
  // Cross-axis opening move → typed reject.
  const cross = await cmd(handler, "bim.move", { ids: [ids.doorOpening], dx: 0, dy: 50, dz: 0 });
  assert.equal(cross.ok, false);
  assert.match((cross as { message: string }).message, /cross-axis/);
  // Story plan move → typed reject.
  const story = await cmd(handler, "bim.move", { ids: [ids.story], dx: 10, dy: 0, dz: 0 });
  assert.equal(story.ok, false);
  assert.match((story as { message: string }).message, /Z only/);
  // Story delete with hosted elements → typed reject.
  const del = await cmd(handler, "bim.delete", { ids: [ids.story] });
  assert.equal(del.ok, false);
  assert.match((del as { message: string }).message, /still referenced/);
  // Malformed creation → bim_invalid with the deterministic first failure.
  const badCreate = await cmd(handler, "bim.createElements", {
    entities: [{ type: "bim.wall", storyId: "story-gf", start: [0, 0], end: [0, 0], width: 300, height: 3000 }],
  });
  assert.equal((badCreate as { code: string }).code, "bim_invalid");
  // Camera on an empty document → typed reject.
  const empty = AppApiHandler.create(CONFIG);
  const cam = await qq(empty, "bim.camera", { preset: "iso" });
  assert.equal(cam.ok, false);
  assert.match((cam as { message: string }).message, /bounding box/);
});
