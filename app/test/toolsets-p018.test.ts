/**
 * CAD-PARITY-018 (Issue #118) — the specialized-toolsets core tests: the
 * versioned typed capability registry (26 governed requests — 20 commands
 * + 6 queries, API-001), the architecture composition vocabulary (wall
 * runs with junction openings, hosted openings, roofs, stair runs, space
 * grids, component arrays, dimension chains — EXACTLY the verified
 * bim.createElements/drafting.createEntities batches, ONE atomic revision
 * per command), the bounded MEP routing records (tls- identities, the
 * routing grammar with typed declines, in-record connections, route
 * validation, the deterministic 2D clash/clearance diagnostics), the
 * bounded mechanical equipment records (ordinal ports, deterministic
 * arrays), and the canonical raster/underlay records (source identity +
 * digest, references, the fresh ok/stale/missing status table, the typed
 * NON-AUTHORITATIVE trace through the fixed transform, and the
 * rasterCommitTrace canonicalization with lineage). Determinism:
 * identical scripts mint identical ids and serialize byte-identically;
 * history replay verifies at every revision; undo/redo restore the
 * canonical content; the specialized table is additive-optional (absent
 * from the empty-document serialization).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { COMMAND_PAYLOAD_SCHEMAS, QUERY_PAYLOAD_SCHEMAS } from "../src/app-api/schema.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import {
  TOOLSET_CAPABILITIES,
  toolsetCapabilityOf,
  validateRoute,
} from "../src/toolsets/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type { MechEquipmentData, MepRunData, RasterSourceData } from "../src/contracts/toolsets.js";
import type { SpecializedRecord } from "../src/contracts/caddocument.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p018-toolsets",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p018-toolsets",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errVal(r: CommandQueryResponse): { code: string; message: string; retryable: boolean } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
  return r as { ok: false; code: string; message: string; retryable: boolean };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}

async function qq(h: AppApiHandler, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

interface SeededElements {
  readonly elements: readonly { id: string; props: Record<string, unknown> }[];
  readonly specialized: readonly SpecializedRecord[];
}

async function stateOf(h: AppApiHandler): Promise<SeededElements> {
  return val<SeededElements>(await qq(h, "document.getState"));
}

/** The P017 seed shape + the second story and a component definition the
 *  architecture toolset needs (roof/stair hosts, array definitions). */
async function seed(h: AppApiHandler): Promise<string> {
  await cmd(h, "document.create", { entityId: "p018-toolsets-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.story", id: "story-1", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
    ],
  });
  const state = val<{ version: { entity_id: string } }>(await qq(h, "document.getState"));
  return state.version.entity_id;
}

/** One bounded MEP run payload factory (continuous, orthogonal when duct). */
function runPayload(overrides: Partial<MepRunData> = {}): MepRunData {
  return {
    domain: "duct",
    shape: "round",
    nominalSize: 300,
    name: "sa-1",
    segments: [{ start: { x: 0, y: 500, z: 0 }, end: { x: 3000, y: 500, z: 0 } }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Capability discovery (API-001 — the versioned specialized-toolsets
// surface: 20 commands + 6 queries = 26 governed requests).
// ---------------------------------------------------------------------------

test("toolsets: capabilities expose the closed 26-entry registry, bound to the canonical revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const caps = val<{
    apiVersion: string;
    capabilities: readonly { name: string; kind: string; toolset: string; summary: string }[];
    documentVersion: number;
    contentHash: string;
  }>(await qq(h, "toolset.capabilities"));
  assert.equal(caps.apiVersion, "1");
  assert.equal(caps.capabilities.length, 26);
  assert.equal(caps.capabilities.filter((c) => c.kind === "command").length, 20);
  assert.equal(caps.capabilities.filter((c) => c.kind === "query").length, 6);
  const names = new Set(caps.capabilities.map((c) => c.name));
  assert.equal(names.size, 26); // no duplicates
  for (const c of caps.capabilities) {
    assert.ok(["arch", "mep", "mechanical", "raster"].includes(c.toolset), `toolset of ${c.name}`);
    assert.ok(c.summary.length > 0, `summary of ${c.name}`);
  }
  // The served view agrees with the registry module (ONE definition).
  assert.equal(TOOLSET_CAPABILITIES.length, caps.capabilities.length);
  // Revision-bound discovery view (the P017 convention).
  const version = val<{ version_number: number }>(await qq(h, "document.getVersion"));
  assert.equal(caps.documentVersion, version.version_number);
  assert.equal(caps.contentHash.length, 64);
  assert.equal(caps.contentHash, h.currentContentHash());
});

test("toolsets: every capability name is a real governed App API request (no fabricated names)", () => {
  for (const c of TOOLSET_CAPABILITIES) {
    if (c.kind === "command") {
      assert.ok(
        Object.prototype.hasOwnProperty.call(COMMAND_PAYLOAD_SCHEMAS, c.name),
        `command ${c.name} must exist in the governed command surface`,
      );
    } else {
      assert.ok(
        Object.prototype.hasOwnProperty.call(QUERY_PAYLOAD_SCHEMAS, c.name),
        `query ${c.name} must exist in the governed query surface`,
      );
    }
  }
  // Every toolsets request is schema-declared (the closed set both ways).
  const declared = new Set<string>([
    ...Object.keys(COMMAND_PAYLOAD_SCHEMAS).filter((n) => n.startsWith("toolset.")),
    ...Object.keys(QUERY_PAYLOAD_SCHEMAS).filter((n) => n.startsWith("toolset.")),
  ]);
  for (const c of TOOLSET_CAPABILITIES) {
    assert.ok(declared.has(c.name), `${c.name} must be schema-declared`);
    declared.delete(c.name);
  }
  assert.equal(declared.size, 0, "the schemas and the registry carry exactly the same toolset requests");
});

test("toolsets: the capability lookup is typed (known rows resolve, unknown names decline)", () => {
  const wallRun = toolsetCapabilityOf("toolset.archWallRun");
  assert.notEqual(wallRun, null);
  assert.equal(wallRun!.kind, "command");
  assert.equal(wallRun!.toolset, "arch");
  const caps = toolsetCapabilityOf("toolset.capabilities");
  assert.notEqual(caps, null);
  assert.equal(caps!.kind, "query");
  assert.equal(toolsetCapabilityOf("toolset.archWallRan"), null);
  assert.equal(toolsetCapabilityOf("document.applyEdit"), null);
  // The per-toolset grouping of the closed registry.
  const byToolset = new Map<string, number>();
  for (const c of TOOLSET_CAPABILITIES) {
    byToolset.set(c.toolset, (byToolset.get(c.toolset) ?? 0) + 1);
  }
  assert.deepEqual([...byToolset.entries()].sort(), [["arch", 9], ["mechanical", 4], ["mep", 6], ["raster", 7]]);
});

// ---------------------------------------------------------------------------
// Architecture toolset (composition over the verified BIM primitives —
// ONE atomic revision per command, document-minted element ids).
// ---------------------------------------------------------------------------

test("toolsets: archWallRun composes a 2-segment run with deterministic names and ONE revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const before = await stateOf(h);
  const versionBefore = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const result = val<{ created: string[]; wallCount: number; walls: readonly { id: string; name: string }[]; junctions: unknown[] }>(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }],
      widthMm: 300,
      heightMm: 3000,
      name: "run",
    }),
  );
  assert.equal(result.wallCount, 2);
  assert.equal(result.created.length, 2);
  assert.equal(result.junctions.length, 0);
  assert.deepEqual(result.walls.map((w) => w.name), ["run-1", "run-2"]);
  assert.deepEqual(result.walls.map((w) => w.id), result.created);
  // Exactly ONE atomic revision.
  const versionAfter = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  assert.equal(versionAfter, versionBefore + 1);
  // The created walls carry the per-segment geometry through the REAL
  // bim.createElements path (story binding + deterministic names).
  const after = await stateOf(h);
  assert.equal(after.elements.length, before.elements.length + 2);
  const wall1 = after.elements.find((e) => e.id === result.created[0])!;
  assert.equal(wall1.props.type, "bim.wall");
  assert.equal(wall1.props.storyId, "story-gf");
  assert.equal(wall1.props.name, "run-1");
  assert.deepEqual(wall1.props.start, [0, 0]);
  assert.deepEqual(wall1.props.end, [6000, 0]);
  assert.equal(wall1.props.width, 300);
});

test("toolsets: archWallRun undo restores the exact element count and removes the run walls", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const before = await stateOf(h);
  const result = val<{ created: string[] }>(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }],
      widthMm: 300,
      heightMm: 3000,
      name: "run",
    }),
  );
  await cmd(h, "document.undo", {});
  const after = await stateOf(h);
  assert.equal(after.elements.length, before.elements.length);
  for (const id of result.created) {
    assert.equal(after.elements.some((e) => e.id === id), false, `undo must remove ${id}`);
  }
});

test("toolsets: archWallRun junctions 'openings' hosts one junction opening per interior vertex", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{
    created: string[];
    wallCount: number;
    walls: readonly { id: string }[];
    junctions: readonly {
      vertexIndex: number;
      vertex: { x: number; y: number };
      wallIds: readonly [string, string];
      openingId: string;
    }[];
  }>(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }],
      widthMm: 300,
      heightMm: 3000,
      name: "run",
      junctions: "openings",
    }),
  );
  // 2 walls + 1 junction opening = 3 created elements.
  assert.equal(result.created.length, 3);
  assert.equal(result.junctions.length, 1);
  const junction = result.junctions[0]!;
  assert.equal(junction.vertexIndex, 1);
  assert.deepEqual(junction.vertex, { x: 6000, y: 0 });
  assert.deepEqual(junction.wallIds, [result.walls[0]!.id, result.walls[1]!.id]);
  // The REAL P011 host binding: the opening's hostId is the wall ENDING at
  // the interior vertex, and the deterministic geometry (distance =
  // hostLen − width so the opening ENDS at the vertex).
  const opening = (await stateOf(h)).elements.find((e) => e.id === junction.openingId)!;
  assert.equal(opening.props.type, "bim.opening");
  assert.equal(opening.props.hostId, result.walls[0]!.id);
  assert.equal(opening.props.distance, 5500); // 6000 − 500
  assert.equal(opening.props.width, 500);
  assert.equal(opening.props.height, 2100);
  assert.equal(opening.props.sill, 0);
  assert.equal(opening.props.name, "run-junction-1");
});

test("toolsets: archHostedOpening places a door with the real host binding and ONE revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const versionBefore = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const result = val<{ created: string[]; openingId: string; fillId: string }>(
    await cmd(h, "toolset.archHostedOpening", {
      wallId: "wall-south",
      kind: "door",
      tAlongWall: 1000,
      widthMm: 900,
      heightMm: 2100,
      sillMm: 100,
      name: "Main",
    }),
  );
  assert.equal(result.created.length, 2);
  const elements = (await stateOf(h)).elements;
  const opening = elements.find((e) => e.id === result.openingId)!;
  assert.equal(opening.props.type, "bim.opening");
  assert.equal(opening.props.hostId, "wall-south"); // the P011 host binding
  assert.equal(opening.props.distance, 1000);
  assert.equal(opening.props.sill, 100);
  assert.equal(opening.props.name, "Main-opening");
  const door = elements.find((e) => e.id === result.fillId)!;
  assert.equal(door.props.type, "bim.door");
  assert.equal(door.props.openingId, result.openingId);
  assert.equal(door.props.storyId, "story-gf"); // derived from the host wall chain
  assert.equal(door.props.swing, "left");
  assert.equal(door.props.name, "Main");
  const versionAfter = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  assert.equal(versionAfter, versionBefore + 1); // ONE atomic batch
});

test("toolsets: archHostedOpening windows fill; a missing host declines typed toolset_host_not_found", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const win = val<{ fillId: string }>(
    await cmd(h, "toolset.archHostedOpening", {
      wallId: "wall-south",
      kind: "window",
      tAlongWall: 3000,
      widthMm: 1200,
      heightMm: 1200,
    }),
  );
  const windowEl = (await stateOf(h)).elements.find((e) => e.id === win.fillId)!;
  assert.equal(windowEl.props.type, "bim.window");
  const missing = errVal(
    await cmd(h, "toolset.archHostedOpening", {
      wallId: "no-such-wall",
      kind: "door",
      tAlongWall: 0,
      widthMm: 900,
      heightMm: 2100,
    }),
  );
  assert.equal(missing.code, "toolset_host_not_found");
  assert.equal(missing.retryable, false);
  assert.match(missing.message, /no wall 'no-such-wall'/);
});

test("toolsets: archWallRun host-story and polyline bounds decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const missingStory = errVal(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-basement",
      polyline: [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
      widthMm: 300,
      heightMm: 3000,
    }),
  );
  assert.equal(missingStory.code, "toolset_host_not_found");
  assert.match(missingStory.message, /no story 'story-basement'/);
  // The closed 64-vertex polyline bound (65 vertices decline typed).
  const longPolyline = Array.from({ length: 65 }, (_, i) => ({ x: i, y: 0 }));
  const over = errVal(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: longPolyline,
      widthMm: 300,
      heightMm: 3000,
    }),
  );
  assert.equal(over.code, "toolset_out_of_bounds");
  assert.match(over.message, /64-vertex bound/);
  // 64 vertices remain inside the bound (63 walls).
  const atBound = val<{ wallCount: number }>(
    await cmd(h, "toolset.archWallRun", {
      storyId: "story-gf",
      polyline: Array.from({ length: 64 }, (_, i) => ({ x: i, y: 0 })),
      widthMm: 300,
      heightMm: 3000,
    }),
  );
  assert.equal(atBound.wallCount, 63);
});

test("toolsets: archRoof places the parametric gable roof over an axis-aligned footprint", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ created: string[] }>(
    await cmd(h, "toolset.archRoof", {
      storyId: "story-1",
      corner1: { x: 0, y: 0 },
      corner2: { x: 6000, y: 5000 },
      heightMm: 1500,
      name: "roof-a",
    }),
  );
  assert.equal(result.created.length, 1);
  const roof = (await stateOf(h)).elements.find((e) => e.id === result.created[0])!;
  assert.equal(roof.props.type, "bim.roof");
  assert.equal(roof.props.storyId, "story-1");
  assert.deepEqual(roof.props.corner1, [0, 0]);
  assert.deepEqual(roof.props.corner2, [6000, 5000]);
  assert.equal(roof.props.ridgeAxis, "x");
  assert.equal(roof.props.height, 1500);
  assert.equal(roof.props.baseOffset, 0);
  assert.equal(roof.props.name, "roof-a");
});

test("toolsets: archRoof degenerate footprints and missing stories decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const degenerate = errVal(
    await cmd(h, "toolset.archRoof", {
      storyId: "story-1",
      corner1: { x: 0, y: 0 },
      corner2: { x: 0, y: 5000 }, // zero width
      heightMm: 1500,
    }),
  );
  assert.equal(degenerate.code, "toolset_bad_payload");
  assert.match(degenerate.message, /non-degenerate axis-aligned area/);
  const missingStory = errVal(
    await cmd(h, "toolset.archRoof", {
      storyId: "story-roof-9",
      corner1: { x: 0, y: 0 },
      corner2: { x: 6000, y: 5000 },
      heightMm: 1500,
    }),
  );
  assert.equal(missingStory.code, "toolset_host_not_found");
  assert.match(missingStory.message, /no story 'story-roof-9'/);
  const missingTop = errVal(
    await cmd(h, "toolset.archRoof", {
      storyId: "story-1",
      corner1: { x: 0, y: 0 },
      corner2: { x: 6000, y: 5000 },
      heightMm: 1500,
      topStoryId: "story-roof-10",
    }),
  );
  assert.equal(missingTop.code, "toolset_host_not_found");
  assert.match(missingTop.message, /topStoryId/);
});

test("toolsets: archStairRun places the single-flight stair with both side railings hosted on it", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ created: string[]; stairId: string; railingIds: string[] }>(
    await cmd(h, "toolset.archStairRun", {
      storyId: "story-gf",
      topStoryId: "story-1",
      start: { x: 0, y: 0 },
      widthMm: 1200,
      stepCount: 12,
      treadMm: 280,
      railings: "both",
      name: "stair-a",
    }),
  );
  assert.equal(result.created.length, 3); // 1 stair + 2 railings
  const elements = (await stateOf(h)).elements;
  const stair = elements.find((e) => e.id === result.stairId)!;
  assert.equal(stair.props.type, "bim.stair");
  assert.equal(stair.props.storyId, "story-gf");
  assert.equal(stair.props.topStoryId, "story-1");
  assert.deepEqual(stair.props.start, [0, 0]);
  assert.deepEqual(stair.props.direction, [1, 0]);
  assert.equal(stair.props.width, 1200);
  assert.equal(stair.props.stepCount, 12);
  assert.equal(stair.props.tread, 280);
  assert.equal(stair.props.baseOffset, 0);
  assert.equal(stair.props.name, "stair-a");
  // The railings host on the stair through the REAL hostId field, with the
  // deterministic sides and handrail height.
  assert.deepEqual(result.railingIds, [result.created[1], result.created[2]]);
  const railings = result.railingIds.map((id) => elements.find((e) => e.id === id)!);
  assert.deepEqual(railings.map((r) => r.props.type), ["bim.railing", "bim.railing"]);
  assert.deepEqual(railings.map((r) => r.props.hostId), [result.stairId, result.stairId]);
  assert.deepEqual(railings.map((r) => r.props.side), ["left", "right"]);
  assert.deepEqual(railings.map((r) => r.props.height), [900, 900]);
  assert.deepEqual(railings.map((r) => r.props.name), ["stair-a-railing-left", "stair-a-railing-right"]);
});

test("toolsets: archStairRun stepCount outside the bounded single-flight range declines typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const over = errVal(
    await cmd(h, "toolset.archStairRun", {
      storyId: "story-gf",
      topStoryId: "story-1",
      start: { x: 0, y: 0 },
      widthMm: 1200,
      stepCount: 25, // the bounded range is 2..24
      treadMm: 280,
    }),
  );
  assert.equal(over.code, "toolset_bad_payload");
  assert.match(over.message, /integer between 2 and 24/);
});

test("toolsets: archSpaceGrid composes the rectangular grid with deterministic prefix-<col>-<row> names", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ created: string[]; names: string[] }>(
    await cmd(h, "toolset.archSpaceGrid", {
      storyId: "story-gf",
      origin: { x: 0, y: 0 },
      cols: 3,
      rows: 2,
      cellWidthMm: 4000,
      cellHeightMm: 3000,
      prefix: "grid",
    }),
  );
  assert.equal(result.created.length, 6);
  assert.deepEqual(result.names, [
    "grid-1-1", "grid-2-1", "grid-3-1",
    "grid-1-2", "grid-2-2", "grid-3-2",
  ]);
  // The first cell's footprint: origin + cell size (row-major, col first).
  const first = (await stateOf(h)).elements.find((e) => e.props.name === "grid-1-1")!;
  assert.equal(first.props.type, "bim.space");
  assert.deepEqual(first.props.footprint, [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]);
  assert.equal(first.props.storyId, "story-gf");
});

test("toolsets: archComponentArray composes the instance array at deterministic offsets", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ created: string[]; count: number }>(
    await cmd(h, "toolset.archComponentArray", {
      definitionId: "def-desk",
      storyId: "story-gf",
      origin: { x: 0, y: 0 },
      cols: 2,
      rows: 2,
      dxMm: 1000,
      dyMm: 1000,
      namePrefix: "desk",
    }),
  );
  assert.equal(result.count, 4);
  assert.equal(result.created.length, 4);
  const elements = (await stateOf(h)).elements;
  const instances = result.created.map((id) => elements.find((e) => e.id === id)!);
  assert.deepEqual(
    instances.map((e) => e.props.position),
    [[0, 0], [1000, 0], [0, 1000], [1000, 1000]],
  );
  assert.deepEqual(
    instances.map((e) => e.props.name),
    ["desk-1-1", "desk-2-1", "desk-1-2", "desk-2-2"],
  );
  for (const e of instances) {
    assert.equal(e.props.type, "bim.componentInstance");
    assert.equal(e.props.definitionId, "def-desk");
    assert.equal(e.props.rotation, 0);
  }
});

test("toolsets: archDimChain composes the aligned dimension chain; the point bound declines typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ created: string[]; dimensionCount: number }>(
    await cmd(h, "toolset.archDimChain", {
      points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }],
      offsetMm: 200,
      layer: "0",
    }),
  );
  assert.equal(result.dimensionCount, 2);
  assert.equal(result.created.length, 2);
  const elements = (await stateOf(h)).elements;
  const dims = result.created.map((id) => elements.find((e) => e.id === id)!);
  assert.deepEqual(dims.map((d) => d.props.type), ["dim-linear", "dim-linear"]);
  assert.deepEqual(dims[0]!.props.p1, [0, 0]);
  assert.deepEqual(dims[0]!.props.p2, [1000, 0]);
  assert.equal(dims[0]!.props.mode, "aligned");
  assert.equal(dims[0]!.props.offset, 200);
  assert.equal(dims[0]!.props.layer, "0");
  assert.deepEqual(dims[1]!.props.p1, [1000, 0]);
  assert.deepEqual(dims[1]!.props.p2, [1000, 500]);
  // The closed 128-point bound.
  const over = errVal(
    await cmd(h, "toolset.archDimChain", {
      points: Array.from({ length: 129 }, (_, i) => ({ x: i, y: 0 })),
    }),
  );
  assert.equal(over.code, "toolset_out_of_bounds");
  assert.match(over.message, /128-point bound/);
});

// ---------------------------------------------------------------------------
// MEP toolset (bounded run records — tls- identities, the routing grammar,
// in-record connections, the deterministic clash/clearance diagnostics).
// ---------------------------------------------------------------------------

test("toolsets: mepAddRun records the bounded run with a document-minted tls- identity and ONE revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const versionBefore = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const result = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: runPayload({ domain: "duct", shape: "round", nominalSize: 300, name: "sa-1" }) }),
  );
  assert.equal(result.record.id, "tls-000001");
  assert.equal(result.record.toolset, "mep");
  assert.equal(result.record.kind, "mep.run");
  const data = result.record.data as MepRunData;
  assert.equal(data.domain, "duct");
  assert.equal(data.shape, "round");
  assert.equal(data.nominalSize, 300);
  assert.equal(data.name, "sa-1");
  assert.equal(data.segments.length, 1);
  assert.deepEqual(data.segments[0]!.start, { x: 0, y: 500, z: 0 });
  // The record is visible in the document-owned table and costs exactly
  // ONE atomic revision.
  const state = await stateOf(h);
  assert.deepEqual(state.specialized.map((r) => r.id), ["tls-000001"]);
  const versionAfter = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  assert.equal(versionAfter, versionBefore + 1);
});

test("toolsets: mepAddRun accepts every domain × shape within the nominal bounds", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const cases: readonly [string, string, number][] = [
    ["duct", "round", 300],
    ["duct", "rect", 600],
    ["pipe", "round", 32],
    ["pipe", "rect", 100],
    ["conduit", "round", 20],
    ["conduit", "rect", 150],
  ];
  for (const [domain, shape, nominalSize] of cases) {
    const result = val<{ record: SpecializedRecord }>(
      await cmd(h, "toolset.mepAddRun", {
        run: {
          domain,
          shape,
          nominalSize,
          segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }],
        },
      }),
    );
    const data = result.record.data as MepRunData;
    assert.equal(data.domain, domain);
    assert.equal(data.shape, shape);
    assert.equal(data.nominalSize, nominalSize);
  }
  assert.deepEqual((await stateOf(h)).specialized.map((r) => r.id), [
    "tls-000001", "tls-000002", "tls-000003", "tls-000004", "tls-000005", "tls-000006",
  ]);
});

test("toolsets: pipe runs route freely; duct runs require orthogonal routing (typed)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // A diagonal pipe run is legal (arbitrary headings allowed).
  const pipe = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }],
      },
    }),
  );
  assert.equal(pipe.record.id, "tls-000001");
  // A diagonal duct run declines with the routing-grammar code.
  const duct = errVal(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "duct",
        shape: "rect",
        nominalSize: 400,
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }],
      },
    }),
  );
  assert.equal(duct.code, "toolset_route_invalid");
  assert.match(duct.message, /segments\[0\] is not axis-aligned/);
  // The failed command burns NO tls- identity (pre-mint validation).
  const next = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: runPayload() }),
  );
  assert.equal(next.record.id, "tls-000002");
});

test("toolsets: degenerate and discontinuous routes decline toolset_route_invalid with the exact messages", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const degenerate = errVal(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } }],
      },
    }),
  );
  assert.equal(degenerate.code, "toolset_route_invalid");
  assert.match(degenerate.message, /segments\[0\] is degenerate/);
  const discontinuous = errVal(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        segments: [
          { start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } },
          { start: { x: 2000, y: 0, z: 0 }, end: { x: 3000, y: 0, z: 0 } },
        ],
      },
    }),
  );
  assert.equal(discontinuous.code, "toolset_route_invalid");
  assert.match(discontinuous.message, /segments\[1\]\.start must equal segments\[0\]\.end/);
});

test("toolsets: nominal sizes outside the per-domain bounds decline toolset_bad_payload", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const segments = [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }];
  for (const [domain, nominalSize] of [["pipe", 5], ["duct", 2500], ["conduit", 350]] as const) {
    const bad = errVal(
      await cmd(h, "toolset.mepAddRun", { run: { domain, shape: "round", nominalSize, segments } }),
    );
    assert.equal(bad.code, "toolset_bad_payload");
    assert.match(bad.message, new RegExp(`nominalSize for domain '${domain}'`));
  }
});

test("toolsets: the 64-segment bound is enforced typed (65 decline, 64 pass)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const segmentsAt = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      start: { x: i * 100, y: 0, z: 0 },
      end: { x: (i + 1) * 100, y: 0, z: 0 },
    }));
  const over = errVal(
    await cmd(h, "toolset.mepAddRun", {
      run: { domain: "pipe", shape: "round", nominalSize: 32, segments: segmentsAt(65) },
    }),
  );
  assert.equal(over.code, "toolset_out_of_bounds");
  assert.match(over.message, /64-segment bound/);
  const atBound = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", {
      run: { domain: "pipe", shape: "round", nominalSize: 32, segments: segmentsAt(64) },
    }),
  );
  assert.equal((atBound.record.data as MepRunData).segments.length, 64);
});

test("toolsets: mepSetRun replaces the full record (name + insulation; id immutable)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const first = val<{ record: SpecializedRecord }>(await cmd(h, "toolset.mepAddRun", { run: runPayload() }));
  const updated = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepSetRun", {
      id: first.record.id,
      run: {
        domain: "duct",
        shape: "round",
        nominalSize: 300,
        insulationMm: 25,
        name: "sa-2",
        segments: [{ start: { x: 0, y: 500, z: 0 }, end: { x: 3000, y: 500, z: 0 } }],
      },
    }),
  );
  assert.equal(updated.record.id, first.record.id); // the identity is immutable
  const data = updated.record.data as MepRunData;
  assert.equal(data.name, "sa-2");
  assert.equal(data.insulationMm, 25);
  assert.equal((await stateOf(h)).specialized.length, 1); // replaced, not appended
});

test("toolsets: mepRemoveRun removes typed; subsequent access declines toolset_not_found; undo restores", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const added = val<{ record: SpecializedRecord }>(await cmd(h, "toolset.mepAddRun", { run: runPayload() }));
  const removed = val<{ removed: string }>(await cmd(h, "toolset.mepRemoveRun", { id: added.record.id }));
  assert.equal(removed.removed, added.record.id);
  // Every subsequent access declines typed.
  const again = errVal(await cmd(h, "toolset.mepRemoveRun", { id: added.record.id }));
  assert.equal(again.code, "toolset_not_found");
  const validate = errVal(await qq(h, "toolset.mepValidateRoute", { id: added.record.id }));
  assert.equal(validate.code, "toolset_not_found");
  const connect = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: added.record.id,
      at: "start",
      target: { kind: "endpoint", point: { x: 0, y: 0, z: 0 } },
    }),
  );
  assert.equal(connect.code, "toolset_not_found");
  // Undo restores the full record atomically.
  await cmd(h, "document.undo", {});
  assert.deepEqual((await stateOf(h)).specialized.map((r) => r.id), [added.record.id]);
});

test("toolsets: mepConnect records the equipment-port connection with the ordinal id", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const run = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        name: "cw-1",
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }],
      },
    }),
  );
  const equipment = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "pump",
        name: "pump-a",
        origin: { x: -500, y: 0, z: 0 },
        ports: [
          { id: "p1", kind: "supply", position: { x: 100, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
          { id: "p2", kind: "return", position: { x: -100, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
        ],
      },
    }),
  );
  const result = val<{ connection: { id: string; at: string; target: Record<string, unknown>; domain: string } }>(
    await cmd(h, "toolset.mepConnect", {
      runId: run.record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: equipment.record.id, portId: "p1" },
    }),
  );
  assert.equal(result.connection.id, "c1");
  assert.equal(result.connection.at, "start");
  assert.equal(result.connection.domain, "pipe");
  assert.deepEqual(result.connection.target, {
    kind: "equipment",
    equipmentId: equipment.record.id,
    portId: "p1",
  });
  // The connection lives ON the run record (in-record, no separate table).
  const stored = (await stateOf(h)).specialized.find((r) => r.id === run.record.id)!;
  assert.equal((stored.data as MepRunData).connections?.length, 1);
  // A second connection mints the ordinal c2.
  const second = val<{ connection: { id: string } }>(
    await cmd(h, "toolset.mepConnect", {
      runId: run.record.id,
      at: "end",
      target: { kind: "equipment", equipmentId: equipment.record.id, portId: "p2" },
    }),
  );
  assert.equal(second.connection.id, "c2");
});

test("toolsets: mepConnect records run-to-run and run-to-endpoint connections", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const segment = { start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } };
  const a = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: { domain: "pipe", shape: "round", nominalSize: 32, name: "a", segments: [segment] } }),
  );
  const b = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: { domain: "pipe", shape: "round", nominalSize: 32, name: "b", segments: [segment] } }),
  );
  const runToRun = val<{ connection: { id: string; target: Record<string, unknown> } }>(
    await cmd(h, "toolset.mepConnect", {
      runId: a.record.id,
      at: "end",
      target: { kind: "run", runId: b.record.id, end: "start" },
    }),
  );
  assert.equal(runToRun.connection.id, "c1");
  assert.deepEqual(runToRun.connection.target, { kind: "run", runId: b.record.id, end: "start" });
  const runToEndpoint = val<{ connection: { id: string; target: Record<string, unknown> } }>(
    await cmd(h, "toolset.mepConnect", {
      runId: a.record.id,
      at: "start",
      target: { kind: "endpoint", point: { x: 1, y: 2, z: 3 } },
    }),
  );
  assert.equal(runToEndpoint.connection.id, "c2");
  assert.deepEqual(runToEndpoint.connection.target, { kind: "endpoint", point: { x: 1, y: 2, z: 3 } });
});

test("toolsets: mepConnect domain/kind mismatches and unknown targets decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const segment = { start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } };
  const duct = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: { domain: "duct", shape: "round", nominalSize: 300, segments: [segment] } }),
  );
  const pipe = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", { run: { domain: "pipe", shape: "round", nominalSize: 32, segments: [segment] } }),
  );
  const equipment = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "ahu",
        origin: { x: 0, y: 0, z: 0 },
        ports: [
          { id: "p1", kind: "supply", position: { x: 0, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
          { id: "p2", kind: "power", position: { x: 0, y: 0, z: 0 } },
        ],
      },
    }),
  );
  // A duct run cannot land on a pipe-domain port.
  const portDomain = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: duct.record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: equipment.record.id, portId: "p1" },
    }),
  );
  assert.equal(portDomain.code, "toolset_unsupported");
  assert.match(portDomain.message, /serves domain 'pipe'/);
  // Power/signal connectors cannot carry MEP runs at all.
  const powerPort = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: pipe.record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: equipment.record.id, portId: "p2" },
    }),
  );
  assert.equal(powerPort.code, "toolset_unsupported");
  assert.match(powerPort.message, /'power' connector/);
  // A duct run cannot connect to a pipe run.
  const runMismatch = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: duct.record.id,
      at: "end",
      target: { kind: "run", runId: pipe.record.id, end: "start" },
    }),
  );
  assert.equal(runMismatch.code, "toolset_unsupported");
  assert.match(runMismatch.message, /domain mismatch/);
  // Unknown targets decline not-found; a run cannot connect to itself.
  const unknownEquipment = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: pipe.record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: "tls-999999", portId: "p1" },
    }),
  );
  assert.equal(unknownEquipment.code, "toolset_not_found");
  const unknownPort = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: pipe.record.id,
      at: "start",
      target: { kind: "equipment", equipmentId: equipment.record.id, portId: "p9" },
    }),
  );
  assert.equal(unknownPort.code, "toolset_not_found");
  assert.match(unknownPort.message, /no port 'p9'/);
  const self = errVal(
    await cmd(h, "toolset.mepConnect", {
      runId: pipe.record.id,
      at: "end",
      target: { kind: "run", runId: pipe.record.id, end: "start" },
    }),
  );
  assert.equal(self.code, "toolset_unsupported");
  assert.match(self.message, /connect to itself/);
});

test("toolsets: mepValidateRoute derives no violations for a stored (grammar-valid) run", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const run = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "duct",
        shape: "round",
        nominalSize: 300,
        segments: [
          { start: { x: 0, y: 500, z: 0 }, end: { x: 3000, y: 500, z: 0 } },
          { start: { x: 3000, y: 500, z: 0 }, end: { x: 3000, y: -500, z: 0 } },
        ],
      },
    }),
  );
  const result = val<{ id: string; domain: string; violations: unknown[] }>(
    await qq(h, "toolset.mepValidateRoute", { id: run.record.id }),
  );
  assert.equal(result.id, run.record.id);
  assert.equal(result.domain, "duct");
  assert.deepEqual(result.violations, []); // stored runs pass the grammar at write time
});

test("toolsets: the route validator derives the deterministic violation codes and ordering", () => {
  // The pure derivation (the query's engine): degenerate → non-orthogonal →
  // discontinuous, ordered by segment index.
  const violations = validateRoute({
    domain: "duct",
    shape: "rect",
    nominalSize: 400,
    segments: [
      { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } }, // degenerate (index 0)
      { start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }, // non-orthogonal + discontinuity at 1
      { start: { x: 200, y: 200, z: 0 }, end: { x: 300, y: 200, z: 0 } }, // discontinuity at 2
    ],
  });
  assert.deepEqual(
    violations.map((v) => [v.code, v.segmentIndex]),
    [
      ["segment_degenerate", 0],
      ["duct_non_orthogonal", 1],
      ["segment_discontinuous", 2],
    ],
  );
  // A valid continuous pipe route derives no violations — even diagonal.
  assert.deepEqual(
    validateRoute({
      domain: "pipe",
      shape: "round",
      nominalSize: 32,
      segments: [
        { start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } },
        { start: { x: 100, y: 100, z: 0 }, end: { x: 200, y: 0, z: 0 } },
      ],
    }),
    [],
  );
});

test("toolsets: mepClashReport derives the exact intersection diagnostic for a run crossing a wall", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // wall-south: [0,0]→[6000,0], width 300 → the body rectangle y∈[-150,150],
  // x∈[0,6000] (centerline y=0, half-width 150). The run crosses it at
  // x=3000 → the exact planar distance is 0 (intersection).
  const run = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        name: "cw-1",
        segments: [{ start: { x: 3000, y: 500, z: 0 }, end: { x: 3000, y: -500, z: 0 } }],
      },
    }),
  );
  const report = val<{ clearanceMm: number; runCount: number; diagnostics: readonly {
    runId: string; segmentIndex: number; elementId: string; kindOfClash: string; distanceMm: number; clearanceMm: number; message: string;
  }[] }>(await qq(h, "toolset.mepClashReport", { clearanceMm: 100 }));
  assert.equal(report.runCount, 1);
  assert.equal(report.clearanceMm, 100);
  assert.equal(report.diagnostics.length, 1);
  const d = report.diagnostics[0]!;
  assert.equal(d.runId, run.record.id);
  assert.equal(d.segmentIndex, 0);
  assert.equal(d.elementId, "wall-south");
  assert.equal(d.kindOfClash, "intersection");
  assert.equal(d.distanceMm, 0); // the exact center-line-to-body distance
  assert.equal(d.clearanceMm, 100);
  assert.match(d.message, /intersects bim\.wall 'wall-south'/);
});

test("toolsets: mepClashReport derives the exact clearance distance, the empty no-clash report and the default", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const add = async (name: string, y1: number, y2: number): Promise<string> => {
    const r = val<{ record: SpecializedRecord }>(
      await cmd(h, "toolset.mepAddRun", {
        run: {
          domain: "pipe",
          shape: "round",
          nominalSize: 32,
          name,
          segments: [{ start: { x: 3000, y: y1, z: 0 }, end: { x: 3000, y: y2, z: 0 } }],
        },
      }),
    );
    return r.record.id;
  };
  // A run ending 400 mm above the wall centerline: the closest body edge is
  // y=150 (top face) → the exact center-line-to-body distance is 250 mm.
  const nearId = await add("cw-near", 400, 500);
  // A run far away from every wall body → no diagnostics at any clearance.
  await add("cw-far", 5000, 6000);
  const at300 = val<{ diagnostics: readonly { runId: string; kindOfClash: string; distanceMm: number }[] }>(
    await qq(h, "toolset.mepClashReport", { clearanceMm: 300 }),
  );
  assert.equal(at300.diagnostics.length, 1); // only the near run violates 300
  assert.equal(at300.diagnostics[0]!.runId, nearId);
  assert.equal(at300.diagnostics[0]!.kindOfClash, "clearance");
  assert.equal(at300.diagnostics[0]!.distanceMm, 250); // 400 − 150
  const at100 = val<{ diagnostics: readonly { runId: string }[] }>(
    await qq(h, "toolset.mepClashReport", { clearanceMm: 100 }),
  );
  assert.deepEqual(at100.diagnostics, []); // 250 > 100 → the near run passes
  // The default clearance is 50 mm when not declared.
  const defaulted = val<{ clearanceMm: number; diagnostics: unknown[] }>(await qq(h, "toolset.mepClashReport"));
  assert.equal(defaulted.clearanceMm, 50);
  assert.deepEqual(defaulted.diagnostics, []);
  // A negative clearance declines typed (the coarse envelope guard).
  const bad = errVal(await qq(h, "toolset.mepClashReport", { clearanceMm: -1 }));
  assert.equal(bad.code, "bad_payload");
  assert.equal(bad.retryable, true);
});

test("toolsets: mepClashReport diagnostics are ordered runId → segmentIndex → elementId", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const add = async (name: string): Promise<string> => {
    const r = val<{ record: SpecializedRecord }>(
      await cmd(h, "toolset.mepAddRun", {
        run: {
          domain: "pipe",
          shape: "round",
          nominalSize: 32,
          name,
          segments: [{ start: { x: 3000, y: 500, z: 0 }, end: { x: 3000, y: -500, z: 0 } }],
        },
      }),
    );
    return r.record.id;
  };
  const first = await add("cw-cross-1"); // tls-000001
  const second = await add("cw-cross-2"); // tls-000002
  assert.ok(first < second); // the mint order is the sort order
  const report = val<{ diagnostics: readonly { runId: string; segmentIndex: number; elementId: string }[] }>(
    await qq(h, "toolset.mepClashReport", { clearanceMm: 100 }),
  );
  assert.deepEqual(
    report.diagnostics.map((d) => [d.runId, d.segmentIndex, d.elementId]),
    [
      [first, 0, "wall-south"],
      [second, 0, "wall-south"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Mechanical toolset (bounded equipment records — ordinal ports,
// deterministic arrays).
// ---------------------------------------------------------------------------

test("toolsets: mechAddEquipment records the equipment with ordinal ports and ONE revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const versionBefore = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const result = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "pump",
        name: "pump-a",
        origin: { x: -500, y: 0, z: 0 },
        rotationDeg: 90,
        ports: [
          { id: "p1", kind: "supply", position: { x: 100, y: 0, z: 0 }, nominal: 32, domain: "pipe" },
          { id: "p2", kind: "drain", position: { x: -100, y: 0, z: 0 } },
        ],
      },
    }),
  );
  assert.equal(result.record.id, "tls-000001");
  assert.equal(result.record.toolset, "mechanical");
  assert.equal(result.record.kind, "mech.equipment");
  const data = result.record.data as MechEquipmentData;
  assert.equal(data.kind, "pump");
  assert.equal(data.name, "pump-a");
  assert.deepEqual(data.origin, { x: -500, y: 0, z: 0 });
  assert.equal(data.rotationDeg, 90);
  assert.deepEqual(
    data.ports.map((p) => [p.id, p.kind]),
    [["p1", "supply"], ["p2", "drain"]],
  );
  assert.deepEqual(data.ports[0]!.position, { x: 100, y: 0, z: 0 });
  assert.equal(data.ports[0]!.nominal, 32);
  assert.equal(data.ports[0]!.domain, "pipe");
  assert.equal(data.ports[1]!.nominal, undefined);
  assert.deepEqual((await stateOf(h)).specialized.map((r) => r.id), ["tls-000001"]);
  const versionAfter = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  assert.equal(versionAfter, versionBefore + 1);
});

test("toolsets: equipment port ids are the deterministic ordinals; the 16-port bound is typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const badOrdinal = errVal(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "pump",
        origin: { x: 0, y: 0, z: 0 },
        ports: [{ id: "x1", kind: "supply", position: { x: 0, y: 0, z: 0 } }],
      },
    }),
  );
  assert.equal(badOrdinal.code, "toolset_bad_payload");
  assert.match(badOrdinal.message, /must be the deterministic ordinal 'p1'/);
  const ports = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, kind: "signal" as const, position: { x: i, y: 0, z: 0 } }));
  const over = errVal(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: { kind: "panel", origin: { x: 0, y: 0, z: 0 }, ports: ports(17) },
    }),
  );
  assert.equal(over.code, "toolset_out_of_bounds");
  assert.match(over.message, /16-port bound/);
  const atBound = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: { kind: "panel", origin: { x: 0, y: 0, z: 0 }, ports: ports(16) },
    }),
  );
  assert.equal((atBound.record.data as MechEquipmentData).ports.length, 16);
});

test("toolsets: mechArray composes the deterministic array (origins, ports and names offset by the cell delta)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const base = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "fan",
        name: "ahu",
        origin: { x: 100, y: 200, z: 0 },
        ports: [{ id: "p1", kind: "supply", position: { x: 50, y: 0, z: 0 }, nominal: 300, domain: "duct" }],
      },
    }),
  );
  const result = val<{ created: string[]; count: number }>(
    await cmd(h, "toolset.mechArray", {
      equipmentId: base.record.id,
      cols: 2,
      rows: 2,
      dxMm: 2000,
      dyMm: 3000,
    }),
  );
  assert.equal(result.count, 4);
  assert.deepEqual(result.created, ["tls-000002", "tls-000003", "tls-000004", "tls-000005"]);
  // Row-major (col first): the cell origins are base + (col−1)·dx, (row−1)·dy.
  const cells = (await stateOf(h)).specialized.filter((r) => result.created.includes(r.id));
  assert.deepEqual(
    cells.map((r) => (r.data as MechEquipmentData).origin),
    [
      { x: 100, y: 200, z: 0 },
      { x: 2100, y: 200, z: 0 },
      { x: 100, y: 3200, z: 0 },
      { x: 2100, y: 3200, z: 0 },
    ],
  );
  // The ports move WITH the equipment (same cell delta).
  assert.deepEqual(
    cells.map((r) => (r.data as MechEquipmentData).ports[0]!.position),
    [
      { x: 50, y: 0, z: 0 },
      { x: 2050, y: 0, z: 0 },
      { x: 50, y: 3000, z: 0 },
      { x: 2050, y: 3000, z: 0 },
    ],
  );
  // The deterministic name suffix (only when the base is named); the port
  // ids stay the ordinal p1 grammar.
  assert.deepEqual(
    cells.map((r) => (r.data as MechEquipmentData).name),
    ["ahu-1-1", "ahu-2-1", "ahu-1-2", "ahu-2-2"],
  );
  assert.ok(cells.every((r) => (r.data as MechEquipmentData).ports[0]!.id === "p1"));
});

test("toolsets: mechSetEquipment and mechRemoveEquipment (typed not-found on unknown ids)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const added = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: { kind: "tank", name: "tk-1", origin: { x: 0, y: 0, z: 0 }, ports: [] },
    }),
  );
  const updated = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechSetEquipment", {
      id: added.record.id,
      equipment: { kind: "tank", name: "tk-2", origin: { x: 10, y: 0, z: 0 }, ports: [] },
    }),
  );
  assert.equal(updated.record.id, added.record.id);
  assert.equal((updated.record.data as MechEquipmentData).name, "tk-2");
  assert.equal((await stateOf(h)).specialized.length, 1);
  const removed = val<{ removed: string }>(await cmd(h, "toolset.mechRemoveEquipment", { id: added.record.id }));
  assert.equal(removed.removed, added.record.id);
  // The snapshot OMITS the specialized key while the table is empty (the
  // additive-optional contract — pre-P018 snapshots stay byte-compatible).
  assert.deepEqual((await stateOf(h)).specialized ?? [], []);
  const again = errVal(await cmd(h, "toolset.mechRemoveEquipment", { id: added.record.id }));
  assert.equal(again.code, "toolset_not_found");
  const setGone = errVal(
    await cmd(h, "toolset.mechSetEquipment", {
      id: added.record.id,
      equipment: { kind: "tank", origin: { x: 0, y: 0, z: 0 }, ports: [] },
    }),
  );
  assert.equal(setGone.code, "toolset_not_found");
  const listed = val<{ count: number }>(await qq(h, "toolset.listRecords"));
  assert.equal(listed.count, 0);
});

test("toolsets: mechArray unknown base and the per-axis bound decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const unknown = errVal(
    await cmd(h, "toolset.mechArray", { equipmentId: "tls-999999", cols: 2, rows: 2, dxMm: 100, dyMm: 100 }),
  );
  assert.equal(unknown.code, "toolset_not_found");
  assert.match(unknown.message, /array base/);
  const base = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: { kind: "fan", origin: { x: 0, y: 0, z: 0 }, ports: [] },
    }),
  );
  const overAxis = errVal(
    await cmd(h, "toolset.mechArray", { equipmentId: base.record.id, cols: 33, rows: 1, dxMm: 100, dyMm: 100 }),
  );
  assert.equal(overAxis.code, "toolset_out_of_bounds");
  assert.match(overAxis.message, /32-per-axis bound/);
});

// ---------------------------------------------------------------------------
// Raster toolset (canonical underlay sources/references, the fresh
// ok/stale/missing status table, the typed non-authoritative trace, and
// the rasterCommitTrace canonicalization with lineage).
// ---------------------------------------------------------------------------

test("toolsets: rasterAddSource registers the source; duplicate sourceRefs and lineWork bounds decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const result = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAddSource", {
      source: {
        sourceRef: "underlay-1",
        contentDigest: "digest-AAA",
        widthPx: 2000,
        heightPx: 1000,
        lineWork: [
          { x1: 100, y1: 100, x2: 200, y2: 100 },
          { x1: 200, y1: 100, x2: 200, y2: 200 },
        ],
      },
    }),
  );
  assert.equal(result.record.id, "tls-000001");
  assert.equal(result.record.kind, "raster.source");
  const data = result.record.data as RasterSourceData;
  assert.equal(data.sourceRef, "underlay-1");
  assert.equal(data.contentDigest, "digest-AAA");
  assert.equal(data.widthPx, 2000);
  assert.equal(data.heightPx, 1000);
  assert.equal(data.lineWork!.length, 2);
  // sourceRefs are unique among raster sources.
  const duplicate = errVal(
    await cmd(h, "toolset.rasterAddSource", {
      source: { sourceRef: "underlay-1", contentDigest: "digest-BBB", widthPx: 100, heightPx: 100 },
    }),
  );
  assert.equal(duplicate.code, "toolset_bad_payload");
  assert.match(duplicate.message, /already registered/);
  // The closed 256-vector lineWork bound.
  const over = errVal(
    await cmd(h, "toolset.rasterAddSource", {
      source: {
        sourceRef: "underlay-2",
        contentDigest: "digest-CCC",
        widthPx: 100,
        heightPx: 100,
        lineWork: Array.from({ length: 257 }, () => ({ x1: 0, y1: 0, x2: 1, y2: 0 })),
      },
    }),
  );
  assert.equal(over.code, "toolset_out_of_bounds");
  assert.match(over.message, /256-vector bound/);
});

test("toolsets: rasterAttach binds the reference to a REGISTERED source; unknown sources decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const missing = errVal(
    await cmd(h, "toolset.rasterAttach", {
      reference: {
        sourceRef: "underlay-404",
        declaredDigest: "digest-X",
        visible: true,
        transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      },
    }),
  );
  assert.equal(missing.code, "toolset_reference_missing");
  assert.equal(missing.retryable, false);
  assert.match(missing.message, /attach the source first/);
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "underlay-1", contentDigest: "digest-AAA", widthPx: 2000, heightPx: 1000 },
  });
  const result = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: {
        sourceRef: "underlay-1",
        declaredDigest: "digest-AAA",
        visible: true,
        layer: "underlays",
        transform: { origin: { x: 1000, y: 2000 }, scale: 0.1, rotationDeg: 90 },
      },
    }),
  );
  assert.equal(result.record.id, "tls-000002");
  assert.equal(result.record.kind, "raster.reference");
  // rasterSetReference verifies the source the same way.
  const setMissing = errVal(
    await cmd(h, "toolset.rasterSetReference", {
      id: result.record.id,
      reference: {
        sourceRef: "underlay-404",
        declaredDigest: "digest-X",
        visible: true,
        transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      },
    }),
  );
  assert.equal(setMissing.code, "toolset_reference_missing");
});

test("toolsets: rasterStatus derives the fresh ok table (sorted, referenceCount)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100 },
  });
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "u2", contentDigest: "d2", widthPx: 100, heightPx: 100 },
  });
  const attach = async (sourceRef: string): Promise<string> => {
    const r = val<{ record: SpecializedRecord }>(
      await cmd(h, "toolset.rasterAttach", {
        reference: {
          sourceRef,
          declaredDigest: sourceRef === "u1" ? "d1" : "d2",
          visible: true,
          transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
        },
      }),
    );
    return r.record.id;
  };
  const first = await attach("u1"); // tls-000003
  const second = await attach("u2"); // tls-000004
  const status = val<{ statuses: readonly { referenceId: string; sourceRef: string; status: string; reason: string }[]; referenceCount: number }>(
    await qq(h, "toolset.rasterStatus"),
  );
  assert.equal(status.referenceCount, 2);
  assert.deepEqual(status.statuses.map((s) => [s.referenceId, s.sourceRef, s.status]), [
    [first, "u1", "ok"],
    [second, "u2", "ok"], // id-sorted (deterministic order)
  ]);
  assert.match(status.statuses[0]!.reason, /matches the declared digest 'd1'/);
});

test("toolsets: a digest mismatch derives the STALE status and the typed trace/commit declines", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "u1", contentDigest: "d-current", widthPx: 100, heightPx: 100, lineWork: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] },
  });
  // The REAL stale path: the reference DECLARES a digest that does not match
  // the registered source (the underlay changed relative to the attach).
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: {
        sourceRef: "u1",
        declaredDigest: "d-at-attach",
        visible: true,
        transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      },
    }),
  );
  const status = val<{ statuses: readonly { status: string; reason: string }[] }>(await qq(h, "toolset.rasterStatus"));
  assert.equal(status.statuses[0]!.status, "stale");
  assert.match(status.statuses[0]!.reason, /digest changed since attach/);
  assert.match(status.statuses[0]!.reason, /declared 'd-at-attach', current 'd-current'/);
  // The trace declines typed (never a guess over a stale underlay).
  const trace = errVal(await qq(h, "toolset.rasterTrace", { referenceId: reference.record.id }));
  assert.equal(trace.code, "toolset_reference_stale");
  assert.equal(trace.retryable, false);
  // The commit declines the same way.
  const commit = errVal(await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id }));
  assert.equal(commit.code, "toolset_reference_stale");
});

test("toolsets: a removed source derives the MISSING status with the typed reason", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const source = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAddSource", {
      source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100, lineWork: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] },
    }),
  );
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: {
        sourceRef: "u1",
        declaredDigest: "d1",
        visible: true,
        transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      },
    }),
  );
  // Remove the SOURCE through the canonical document edit path (there is
  // deliberately no toolset source-remove command).
  await cmd(h, "document.applyEdit", { edit: { type: "removeSpecialized", id: source.record.id } });
  const status = val<{ statuses: readonly { status: string; reason: string }[] }>(await qq(h, "toolset.rasterStatus"));
  assert.equal(status.statuses[0]!.status, "missing");
  assert.match(status.statuses[0]!.reason, /the underlay is missing/);
  const trace = errVal(await qq(h, "toolset.rasterTrace", { referenceId: reference.record.id }));
  assert.equal(trace.code, "toolset_reference_missing");
  const commit = errVal(await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id }));
  assert.equal(commit.code, "toolset_reference_missing");
});

test("toolsets: rasterRemoveReference removes typed; the status table follows", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", { source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100 } });
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } },
    }),
  );
  const removed = val<{ removed: string }>(await cmd(h, "toolset.rasterRemoveReference", { id: reference.record.id }));
  assert.equal(removed.removed, reference.record.id);
  const status = val<{ statuses: unknown[]; referenceCount: number }>(await qq(h, "toolset.rasterStatus"));
  assert.deepEqual(status.statuses, []);
  assert.equal(status.referenceCount, 0);
  const again = errVal(await cmd(h, "toolset.rasterRemoveReference", { id: reference.record.id }));
  assert.equal(again.code, "toolset_not_found");
  const trace = errVal(await qq(h, "toolset.rasterTrace", { referenceId: reference.record.id }));
  assert.equal(trace.code, "toolset_not_found");
});

test("toolsets: the trace maps pixel space → document space through the EXACT fixed transform", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "u1",
      contentDigest: "d1",
      widthPx: 2000,
      heightPx: 1000,
      lineWork: [{ x1: 100, y1: 100, x2: 200, y2: 100 }],
    },
  });
  // scale first (×0.1), then rotate 90° (the exact axis table: cos 0, sin 1),
  // then translate to the origin: doc = origin + R(θ)·(scale·pixel).
  // (100,100) → (10,10) → (−10,10) → (1000−10, 2000+10) = (990, 2010).
  // (200,100) → (20,10) → (−10,20) → (990, 2020).
  const rotated = val<{ vectors: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[] }>(
    await attachAndTrace(h, "u1", "d1", { origin: { x: 1000, y: 2000 }, scale: 0.1, rotationDeg: 90 }),
  );
  assert.deepEqual(rotated.vectors, [
    { from: { x: 990, y: 2010 }, to: { x: 990, y: 2020 } },
  ]);
  // The identity-ish transform: scale ×2, no rotation, origin (5,5).
  // (100,100) → (200,200) → (205,205); (200,100) → (400,200) → (405,205).
  const scaled = val<{ vectors: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[] }>(
    await attachAndTrace(h, "u1", "d1", { origin: { x: 5, y: 5 }, scale: 2, rotationDeg: 0 }),
  );
  assert.deepEqual(scaled.vectors, [
    { from: { x: 205, y: 205 }, to: { x: 405, y: 205 } },
  ]);
  // 180° (cos −1, sin 0): (100,100) → (100,100) → (−100,−100) → (−100,−100);
  // (200,100) → (200,100) → (−200,−100).
  const flipped = val<{ vectors: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[] }>(
    await attachAndTrace(h, "u1", "d1", { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 180 }),
  );
  assert.deepEqual(flipped.vectors, [
    { from: { x: -100, y: -100 }, to: { x: -200, y: -100 } },
  ]);
});

test("toolsets: the clipping filter keeps vectors by the MIDPOINT containment rule", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "u1",
      contentDigest: "d1",
      widthPx: 2000,
      heightPx: 1000,
      lineWork: [
        { x1: 100, y1: 100, x2: 200, y2: 100 }, // midpoint (150,100) — inside the clip
        { x1: 1500, y1: 1500, x2: 1600, y2: 1500 }, // midpoint (1550,1500) — outside
      ],
    },
  });
  const result = val<{ vectors: readonly unknown[]; notice: string; authoritative: false }>(
    await attachAndTrace(h, "u1", "d1", { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 }, { x: 0, y: 0, w: 1000, h: 1000 }),
  );
  assert.equal(result.vectors.length, 1); // the outside-midpoint vector is dropped
  assert.match(result.notice, /1\/2 vectors kept after clipping/);
  // An inclusive-edge midpoint is kept (mx === clip.x + clip.w).
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "u2",
      contentDigest: "d2",
      widthPx: 2000,
      heightPx: 1000,
      lineWork: [{ x1: 1900, y1: 100, x2: 2100, y2: 100 }], // midpoint x = 2000 === clip edge
    },
  });
  const edge = val<{ vectors: readonly unknown[] }>(
    await attachAndTrace(h, "u2", "d2", { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 }, { x: 0, y: 0, w: 2000, h: 1000 }),
  );
  assert.equal(edge.vectors.length, 1);
});

test("toolsets: a source without lineWork traces EMPTY with the typed notice (never an error)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100 }, // no lineWork
  });
  const result = val<{ vectors: readonly unknown[]; notice: string; authoritative: false }>(
    await attachAndTrace(h, "u1", "d1", { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 }),
  );
  assert.deepEqual(result.vectors, []);
  assert.match(result.notice, /declares no lineWork vectors — the trace is empty/);
  assert.match(result.notice, /non-authoritative: commit through toolset\.rasterCommitTrace/);
});

test("toolsets: rasterCommitTrace canonicalizes the traced vectors as line elements with lineage, in ONE revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "u1",
      contentDigest: "d1",
      widthPx: 2000,
      heightPx: 1000,
      lineWork: [
        { x1: 100, y1: 100, x2: 200, y2: 100 },
        { x1: 200, y1: 100, x2: 200, y2: 200 },
      ],
    },
  });
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: {
        sourceRef: "u1",
        declaredDigest: "d1",
        visible: true,
        transform: { origin: { x: 1000, y: 2000 }, scale: 0.1, rotationDeg: 90 },
      },
    }),
  );
  const elementsBefore = (await stateOf(h)).elements.length;
  const versionBefore = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const result = val<{
    created: string[];
    committed: number;
    trace: { notice: string; authoritative: false };
  }>(await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id }));
  assert.equal(result.committed, 2);
  assert.equal(result.created.length, 2);
  assert.equal(result.trace.authoritative, false); // the commit result restates non-authority of the TRACE
  // ONE atomic revision for the whole commit.
  const versionAfter = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  assert.equal(versionAfter, versionBefore + 1);
  // The lines are REAL canonical elements with the exact trace geometry and
  // the lineage recorded in the props under the `trace` key.
  const elements = (await stateOf(h)).elements;
  assert.equal(elements.length, elementsBefore + 2);
  const lines = result.created.map((id) => elements.find((e) => e.id === id)!);
  assert.deepEqual(lines.map((l) => l.props.type), ["line", "line"]);
  // The reference declared no layer → the canonical default layer "0".
  assert.deepEqual(lines.map((l) => l.props.layer), ["0", "0"]);
  assert.deepEqual([lines[0]!.props.from, lines[0]!.props.to], [[990, 2010], [990, 2020]]);
  assert.deepEqual([lines[1]!.props.from, lines[1]!.props.to], [[990, 2020], [980, 2020]]);
  assert.deepEqual(
    lines.map((l) => l.props.trace),
    [
      { sourceRef: "u1", referenceId: reference.record.id, vectorIndices: [0] },
      { sourceRef: "u1", referenceId: reference.record.id, vectorIndices: [1] },
    ],
  );
});

test("toolsets: rasterCommitTrace undo removes exactly the committed line elements", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100, lineWork: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] },
  });
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } },
    }),
  );
  const before = (await stateOf(h)).elements;
  const result = val<{ created: string[] }>(await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id }));
  await cmd(h, "document.undo", {});
  const after = (await stateOf(h)).elements;
  assert.equal(after.length, before.length); // exactly the created elements removed
  for (const id of result.created) {
    assert.equal(after.some((e) => e.id === id), false, `undo must remove the committed line ${id}`);
  }
  assert.deepEqual(
    after.map((e) => e.id),
    before.map((e) => e.id),
  );
});

test("toolsets: rasterCommitTrace vectorIndices select, validate and decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "u1",
      contentDigest: "d1",
      widthPx: 100,
      heightPx: 100,
      lineWork: [
        { x1: 0, y1: 0, x2: 10, y2: 0 },
        { x1: 10, y1: 0, x2: 10, y2: 10 },
      ],
    },
  });
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } },
    }),
  );
  // A subset commit: only the SECOND vector, lineage records [1].
  const subset = val<{ created: string[]; committed: number }>(
    await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id, vectorIndices: [1] }),
  );
  assert.equal(subset.committed, 1);
  const line = (await stateOf(h)).elements.find((e) => e.id === subset.created[0])!;
  assert.deepEqual([line.props.from, line.props.to], [[10, 0], [10, 10]]);
  assert.deepEqual(line.props.trace, { sourceRef: "u1", referenceId: reference.record.id, vectorIndices: [1] });
  // Out-of-range and duplicate indices decline typed; an unknown reference
  // declines not-found.
  const outOfRange = errVal(
    await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id, vectorIndices: [5] }),
  );
  assert.equal(outOfRange.code, "toolset_out_of_bounds");
  assert.match(outOfRange.message, /vectorIndex 5 is out of range/);
  const duplicate = errVal(
    await cmd(h, "toolset.rasterCommitTrace", { referenceId: reference.record.id, vectorIndices: [0, 0] }),
  );
  assert.equal(duplicate.code, "toolset_bad_payload");
  assert.match(duplicate.message, /requested twice/);
  const unknown = errVal(await cmd(h, "toolset.rasterCommitTrace", { referenceId: "tls-999999" }));
  assert.equal(unknown.code, "toolset_not_found");
});

// ---------------------------------------------------------------------------
// Determinism & replay (identical scripts → identical ids and bytes; the
// immutable history verifies at every revision; undo/redo restore the
// canonical content; the serialize round trip preserves the records).
// ---------------------------------------------------------------------------

test("toolsets: identical command scripts mint identical ids and serialize byte-identically", async () => {
  const drive = async (h: AppApiHandler): Promise<{ walls: { id: string; name: string }[]; created: string[]; records: string[]; text: string }> => {
    await cmd(h, "document.create", { entityId: "p018-identical-building" });
    await cmd(h, "bim.createElements", {
      entities: [
        { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
        { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
        { type: "bim.story", id: "story-1", name: "First Floor", level: 3000, height: 3000 },
      ],
    });
    const wallRun = val<{ created: string[]; walls: { id: string; name: string }[] }>(
      await cmd(h, "toolset.archWallRun", {
        storyId: "story-gf",
        polyline: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 5000 }],
        widthMm: 300,
        heightMm: 3000,
        name: "run",
        junctions: "openings",
      }),
    );
    await cmd(h, "toolset.mepAddRun", {
      run: {
        domain: "duct",
        shape: "round",
        nominalSize: 300,
        name: "sa-1",
        segments: [{ start: { x: 3000, y: 500, z: 0 }, end: { x: 3000, y: -500, z: 0 } }],
      },
    });
    await cmd(h, "toolset.mechAddEquipment", {
      equipment: {
        kind: "pump",
        name: "pump-a",
        origin: { x: 0, y: 0, z: 0 },
        ports: [{ id: "p1", kind: "supply", position: { x: 100, y: 0, z: 0 }, nominal: 32, domain: "pipe" }],
      },
    });
    await cmd(h, "toolset.rasterAddSource", {
      source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100, lineWork: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] },
    });
    await cmd(h, "toolset.rasterAttach", {
      reference: { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } },
    });
    const records = (await stateOf(h)).specialized.map((r) => r.id);
    const text = val<string>(await cmd(h, "document.serialize", {}));
    return { walls: wallRun.walls, created: wallRun.created, records, text };
  };
  const a = await drive(AppApiHandler.create(CONFIG));
  const b = await drive(AppApiHandler.create(CONFIG));
  assert.deepEqual(a.created, b.created); // identical element identities
  assert.deepEqual(a.walls, b.walls); // identical manifests
  assert.deepEqual(a.records, ["tls-000001", "tls-000002", "tls-000003", "tls-000004"]);
  assert.deepEqual(b.records, a.records); // identical minted tls- identities
  assert.equal(a.text, b.text); // byte-identical canonical serialization
});

test("toolsets: the history replay verifies at every revision through the specialized mutations", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.mepAddRun", { run: runPayload() });
  await cmd(h, "toolset.mepRemoveRun", { id: "tls-000001" });
  await cmd(h, "document.undo", {});
  const history = val<{ revisions: unknown[]; next_specialized_sequence?: number }>(
    await qq(h, "model.getHistory"),
  );
  for (let k = 0; k <= history.revisions.length; k++) {
    const replay = val<{ revision_number: number; verified: boolean; revision_id: string }>(
      await qq(h, "model.replay", { revision_number: k }),
    );
    assert.equal(replay.revision_number, k);
    assert.equal(replay.verified, true, `replay to revision ${k} verifies`);
    // The deterministic revision id: <entityId>#r<n>(<contentHash12>).
    assert.match(replay.revision_id, /^p018-toolsets-building#r\d+\([0-9a-f]{12}\)$/);
  }
  // The tls- mint counter is CHECKPOINTED in the model history (the
  // canonical-minimal contract: absent before the first specialized id,
  // advanced past the last minted one) — the reopened/replayed document
  // takes max(derived, checkpoint) so identities are never reused.
  assert.equal(history.next_specialized_sequence, 2); // one tls- minted (000001)
  // The record edits are part of the immutable log (the undo transition
  // carries the removeSpecialized edit; the redo of the undo restores it).
  assert.deepEqual((await stateOf(h)).specialized.map((r) => r.id), ["tls-000001"]);
});

test("toolsets: serialize → deserialize round trip preserves the records with exact ids and history", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.mepAddRun", { run: runPayload() });
  await cmd(h, "toolset.mechAddEquipment", {
    equipment: { kind: "pump", name: "pump-a", origin: { x: 0, y: 0, z: 0 }, ports: [] },
  });
  await cmd(h, "toolset.rasterAddSource", { source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100 } });
  await cmd(h, "toolset.rasterAttach", {
    reference: { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } },
  });
  const text = val<string>(await cmd(h, "document.serialize", {}));
  const recordsBefore = val<{ records: unknown[] }>(await qq(h, "toolset.listRecords"));
  const specializedBefore = (await stateOf(h)).specialized;
  // Deserialize into a FRESH handler (a new session).
  const reopened = AppApiHandler.create(CONFIG);
  await cmd(reopened, "document.deserialize", { text });
  const recordsAfter = val<{ records: unknown[] }>(await qq(reopened, "toolset.listRecords"));
  assert.deepEqual(recordsAfter, recordsBefore); // exact ids, toolsets and kinds
  assert.deepEqual((await stateOf(reopened)).specialized, specializedBefore); // full record payloads
  assert.equal(reopened.currentContentHash(), h.currentContentHash());
  // The ADOPTED history replays verified on the reopened handler.
  const history = val<{ revisions: unknown[] }>(await qq(reopened, "model.getHistory"));
  assert.ok(history.revisions.length > 0);
  for (let k = 0; k <= history.revisions.length; k++) {
    const replay = val<{ verified: boolean }>(await qq(reopened, "model.replay", { revision_number: k }));
    assert.equal(replay.verified, true);
  }
});

test("toolsets: undo → redo restores the canonical content (content hash, records, element ids)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.mepAddRun", { run: runPayload() });
  await cmd(h, "toolset.rasterAddSource", { source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100 } });
  const before = await stateOf(h);
  const hashBefore = h.currentContentHash();
  await cmd(h, "document.undo", {}); // removes the raster source
  assert.deepEqual((await stateOf(h)).specialized.map((r) => r.id), ["tls-000001"]);
  await cmd(h, "document.redo", {});
  // The canonical content is EXACTLY restored (the undo/redo transitions
  // append immutable history revisions — the serialize bytes legitimately
  // differ by those records; the canonical CONTENT hash is the invariant).
  const after = await stateOf(h);
  assert.equal(h.currentContentHash(), hashBefore);
  assert.deepEqual(
    after.specialized.map((r) => r.id),
    before.specialized.map((r) => r.id),
  );
  assert.deepEqual(
    after.elements.map((e) => e.id),
    before.elements.map((e) => e.id),
  );
});

test("toolsets: tls- identities are monotonic and never reused across removals", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const first = val<{ record: SpecializedRecord }>(await cmd(h, "toolset.mepAddRun", { run: runPayload() }));
  const second = val<{ record: SpecializedRecord }>(await cmd(h, "toolset.mepAddRun", {
    run: { ...runPayload(), name: "second" },
  }));
  assert.equal(first.record.id, "tls-000001");
  assert.equal(second.record.id, "tls-000002");
  await cmd(h, "toolset.mepRemoveRun", { id: first.record.id });
  await cmd(h, "toolset.mepRemoveRun", { id: second.record.id });
  // The snapshot omits the specialized key while the table is empty.
  assert.deepEqual((await stateOf(h)).specialized ?? [], []);
  // The mint counter is checkpointed: the next record mints tls-000003,
  // never reusing a removed identity.
  const third = val<{ record: SpecializedRecord }>(await cmd(h, "toolset.mepAddRun", {
    run: { ...runPayload(), name: "third" },
  }));
  assert.equal(third.record.id, "tls-000003");
});

// ---------------------------------------------------------------------------
// Typed declines & hygiene (unknown ids, malformed payloads, unknown
// command names, the additive-optional specialized table).
// ---------------------------------------------------------------------------

test("toolsets: unknown record ids on set/remove decline toolset_not_found across every toolset", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const run = { domain: "pipe", shape: "round", nominalSize: 32, segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }] };
  const setRun = errVal(await cmd(h, "toolset.mepSetRun", { id: "tls-000001", run }));
  assert.equal(setRun.code, "toolset_not_found");
  const removeRun = errVal(await cmd(h, "toolset.mepRemoveRun", { id: "tls-000001" }));
  assert.equal(removeRun.code, "toolset_not_found");
  const equipment = { kind: "pump", origin: { x: 0, y: 0, z: 0 }, ports: [] };
  const setEquipment = errVal(await cmd(h, "toolset.mechSetEquipment", { id: "tls-000001", equipment }));
  assert.equal(setEquipment.code, "toolset_not_found");
  const removeEquipment = errVal(await cmd(h, "toolset.mechRemoveEquipment", { id: "tls-000001" }));
  assert.equal(removeEquipment.code, "toolset_not_found");
  const reference = { sourceRef: "u1", declaredDigest: "d1", visible: true, transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 } };
  const setReference = errVal(await cmd(h, "toolset.rasterSetReference", { id: "tls-000001", reference }));
  assert.equal(setReference.code, "toolset_not_found");
  const removeReference = errVal(await cmd(h, "toolset.rasterRemoveReference", { id: "tls-000001" }));
  assert.equal(removeReference.code, "toolset_not_found");
  for (const r of [setRun, removeRun, setEquipment, removeEquipment, setReference, removeReference]) {
    assert.equal(r.retryable, false);
  }
});

test("toolsets: malformed coarse payloads decline bad_payload with retryable true", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const cases: readonly [string, unknown][] = [
    ["toolset.mepAddRun", {}],
    ["toolset.mepSetRun", { id: "tls-000001" }],
    ["toolset.mepConnect", { runId: "tls-000001", at: "sideways", target: { kind: "endpoint", point: { x: 0, y: 0, z: 0 } } }],
    ["toolset.mechAddEquipment", {}],
    ["toolset.rasterAddSource", {}],
    ["toolset.rasterAttach", {}],
    ["toolset.rasterCommitTrace", {}],
    ["toolset.archWallRun", { storyId: "story-gf", polyline: [{ x: 0, y: 0 }], widthMm: 300, heightMm: 3000 }],
    ["toolset.archWallRun", { storyId: "story-gf", polyline: [{ x: 0, y: 0 }, { x: 1, y: 0 }], widthMm: 300, heightMm: 3000, junctions: "both" }],
  ];
  for (const [name, payload] of cases) {
    const declined = errVal(await cmd(h, name, payload));
    assert.equal(declined.code, "bad_payload", `${name} declines bad_payload`);
    assert.equal(declined.retryable, true, `${name} malformed payload is retryable`);
  }
});

test("toolsets: unknown toolset request names decline through the App API's own typed failure", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const unknownCommand = errVal(await cmd(h, "toolset.archWallRan", {}));
  assert.equal(unknownCommand.code, "unknown_command");
  assert.equal(unknownCommand.retryable, false);
  assert.match(unknownCommand.message, /unknown command/);
  const unknownQuery = errVal(await qq(h, "toolset.rasterTraces", {}));
  assert.equal(unknownQuery.code, "unknown_query");
  assert.equal(unknownQuery.retryable, false);
  assert.match(unknownQuery.message, /unknown query/);
});

test("toolsets: listRecords filters by toolset and kind; the empty document omits the specialized key", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "toolset.mepAddRun", { run: runPayload() });
  await cmd(h, "toolset.mechAddEquipment", { equipment: { kind: "pump", origin: { x: 0, y: 0, z: 0 }, ports: [] } });
  await cmd(h, "toolset.rasterAddSource", { source: { sourceRef: "u1", contentDigest: "d1", widthPx: 1, heightPx: 1 } });
  const all = val<{ records: readonly { id: string; toolset: string; kind: string }[]; count: number }>(
    await qq(h, "toolset.listRecords"),
  );
  assert.equal(all.count, 3);
  assert.deepEqual(all.records.map((r) => [r.id, r.toolset, r.kind]), [
    ["tls-000001", "mep", "mep.run"],
    ["tls-000002", "mechanical", "mech.equipment"],
    ["tls-000003", "raster", "raster.source"],
  ]);
  const mechanical = val<{ records: readonly { toolset: string }[]; count: number }>(
    await qq(h, "toolset.listRecords", { toolset: "mechanical" }),
  );
  assert.equal(mechanical.count, 1);
  assert.equal(mechanical.records[0]!.toolset, "mechanical");
  const runs = val<{ records: readonly { kind: string }[]; count: number }>(
    await qq(h, "toolset.listRecords", { kind: "mep.run" }),
  );
  assert.equal(runs.count, 1);
  assert.equal(runs.records[0]!.kind, "mep.run");
  // The additive-optional proof: an EMPTY document serializes WITHOUT the
  // specialized key (pre-P018 snapshots stay byte-compatible).
  const fresh = AppApiHandler.create(CONFIG);
  await cmd(fresh, "document.create", { entityId: "p018-empty-building" });
  const text = val<string>(await cmd(fresh, "document.serialize", {}));
  assert.equal(text.includes("specialized"), false);
  const emptyRecords = val<{ records: unknown[]; count: number }>(await qq(fresh, "toolset.listRecords"));
  assert.deepEqual(emptyRecords.records, []);
  assert.equal(emptyRecords.count, 0);
});

// ---------------------------------------------------------------------------
// Local helper: attach a reference to a registered source and trace it.
// ---------------------------------------------------------------------------

async function attachAndTrace(
  h: AppApiHandler,
  sourceRef: string,
  declaredDigest: string,
  transform: { origin: { x: number; y: number }; scale: number; rotationDeg: number },
  clipping?: { x: number; y: number; w: number; h: number },
): Promise<CommandQueryResponse> {
  const reference = val<{ record: SpecializedRecord }>(
    await cmd(h, "toolset.rasterAttach", {
      reference: { sourceRef, declaredDigest, visible: true, transform, ...(clipping !== undefined ? { clipping } : {}) },
    }),
  );
  return qq(h, "toolset.rasterTrace", { referenceId: reference.record.id });
}
