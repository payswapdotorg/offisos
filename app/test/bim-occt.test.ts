/**
 * COMPAT-CAD-002 — BIM solids realized through the REAL OCCT engine
 * (CAD-IMPLEMENT-002 toolchain; engine-gated like every real-engine test —
 * skips with a recorded reason when OCP is not importable).
 *
 * Deterministic volume assertions are EXACT analytic expectations (the
 * declared overhang lies outside the wall solid, so wall volumes are exact:
 * L·W·H − Σ openingWidth·openingHeight·W) with declared tolerance 1e-6 mm³
 * scale for OCCT mass-properties rounding.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcctGeometryAdapter } from "../src/adapters/occt/index.js";
import { engineSkip } from "./engine-availability.js";
import {
  bimGeometryContext,
  bimSolidDescriptor,
} from "../src/bim/geometry.js";
import {
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  type BimEntity,
} from "../src/bim/elements.js";

const skipEngine = await engineSkip();
const VOL_TOL = 1e-3; // mm³ — OCCT volume properties round at 9 decimals

function entity<T extends object>(input: T, id: string): T & { id: string } {
  return { id, ...input };
}

async function prepare(descriptor: unknown): Promise<{ meshToken: string; volume: number; stats: { vertices: number; triangles: number } }> {
  const adapter = createOcctGeometryAdapter();
  const result = await adapter.prepareGeometry({ id: "bim-occt", kind: "bim", engineId: null, props: descriptor as Record<string, unknown> });
  const metadata = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(metadata !== null, "OCCT adapter provides metadata");
  return { meshToken: result.meshToken, volume: metadata.volume, stats: { vertices: metadata.vertices, triangles: metadata.triangles } };
}

const STORY = entity(makeStory({ name: "GF", level: 0, height: 3000 }), "story");

test("extrude: axis-aligned wall solid has the exact analytic volume", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [0, 0], end: [6000, 0], width: 300, height: 3000 }), "wall-1");
  const { descriptor } = bimSolidDescriptor(wall, bimGeometryContext([STORY, wall]));
  const realized = await prepare(descriptor);
  assert.equal(realized.meshToken.startsWith("occt:"), true);
  assert.ok(Math.abs(realized.volume - 6000 * 300 * 3000) <= VOL_TOL, `volume ${realized.volume}`);
  assert.equal(realized.stats.vertices, 8, "prism = 8 vertices");
  assert.equal(realized.stats.triangles, 12, "prism = 12 triangles");
});

test("extrude: rotated (90°) wall keeps the exact volume (rigid transform)", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 }), "wall-1");
  const { descriptor } = bimSolidDescriptor(wall, bimGeometryContext([STORY, wall]));
  const realized = await prepare(descriptor);
  assert.ok(Math.abs(realized.volume - 5000 * 300 * 3000) <= VOL_TOL, `volume ${realized.volume}`);
});

test("cut: wall with door + window openings subtracts EXACTLY (declared overhang)", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [0, 0], end: [6000, 0], width: 300, height: 3000 }), "wall-1");
  const doorOpening = entity(makeOpening({ hostId: "wall-1", distance: 500, width: 900, height: 2100, sill: 0 }), "op-1");
  const winOpening = entity(makeOpening({ hostId: "wall-1", distance: 3500, width: 1500, height: 1200, sill: 900 }), "op-2");
  const ctx = bimGeometryContext([STORY, wall, doorOpening, winOpening]);
  const { descriptor } = bimSolidDescriptor(wall, ctx);
  const realized = await prepare(descriptor);
  const expected = 6000 * 300 * 3000 - 900 * 2100 * 300 - 1500 * 1200 * 300;
  assert.ok(Math.abs(realized.volume - expected) <= VOL_TOL, `volume ${realized.volume} vs ${expected}`);
});

test("cut: 45° wall with an opening keeps the exact volume", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [0, 0], end: [5000, 5000], width: 200, height: 3000 }), "wall-1");
  const opening = entity(makeOpening({ hostId: "wall-1", distance: 1000, width: 900, height: 2100, sill: 0 }), "op-1");
  const ctx = bimGeometryContext([STORY, wall, opening]);
  const { descriptor } = bimSolidDescriptor(wall, ctx);
  const realized = await prepare(descriptor);
  const length = Math.sqrt(5000 ** 2 + 5000 ** 2);
  const expected = length * 200 * 3000 - 900 * 2100 * 200;
  assert.ok(Math.abs(realized.volume - expected) <= 1e-2, `volume ${realized.volume} vs ${expected}`);
});

test("extrude: slab and L-shaped space realize with exact volumes", { skip: skipEngine }, async () => {
  const slab = entity(makeSlab({ storyId: "story", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 }), "slab-1");
  const slabSolid = await prepare(bimSolidDescriptor(slab, bimGeometryContext([STORY, slab])).descriptor);
  assert.ok(Math.abs(slabSolid.volume - 6600 * 5600 * 200) <= VOL_TOL, `slab ${slabSolid.volume}`);

  const space = entity(
    makeSpace({
      storyId: "story",
      name: "Office 1",
      footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]],
      height: 3000,
    }),
    "space-1",
  );
  const spaceSolid = await prepare(bimSolidDescriptor(space, bimGeometryContext([STORY, space])).descriptor);
  assert.ok(Math.abs(spaceSolid.volume - 27_000_000 * 3000) <= VOL_TOL, `space ${spaceSolid.volume}`);
});

test("door leaf and window panel realize exactly in the wall plane", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [0, 0], end: [6000, 0], width: 300, height: 3000 }), "wall-1");
  const doorOpening = entity(makeOpening({ hostId: "wall-1", distance: 500, width: 900, height: 2100, sill: 0 }), "op-1");
  const winOpening = entity(makeOpening({ hostId: "wall-1", distance: 3500, width: 1500, height: 1200, sill: 900 }), "op-2");
  const door = entity(makeDoor({ openingId: "op-1", storyId: "story", swing: "left", leafThickness: 40 }), "door-1");
  const win = entity(makeWindow({ openingId: "op-2", storyId: "story" }), "win-1");
  const ctx = bimGeometryContext([STORY, wall, doorOpening, winOpening, door, win]);
  const doorSolid = await prepare(bimSolidDescriptor(door, ctx).descriptor);
  assert.ok(Math.abs(doorSolid.volume - 900 * 40 * 2100) <= VOL_TOL, `door ${doorSolid.volume}`);
  const winSolid = await prepare(bimSolidDescriptor(win, ctx).descriptor);
  assert.ok(Math.abs(winSolid.volume - 1500 * 40 * 1200) <= VOL_TOL, `window ${winSolid.volume}`);
});

test("determinism: identical BIM derivations produce identical meshTokens across processes", { skip: skipEngine }, async () => {
  const wall = entity(makeWall({ storyId: "story", start: [0, 0], end: [6000, 0], width: 300, height: 3000 }), "wall-1");
  const opening = entity(makeOpening({ hostId: "wall-1", distance: 500, width: 900, height: 2100, sill: 0 }), "op-1");
  const descriptor = bimSolidDescriptor(wall, bimGeometryContext([STORY, wall, opening])).descriptor;
  const a = await prepare(descriptor);
  const b = await prepare(JSON.parse(JSON.stringify(descriptor)));
  assert.equal(a.meshToken, b.meshToken, "same derivation → same meshToken (fresh subprocess each call)");
});

test("extrude through geometry.prepare: profile validation is typed at the boundary", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  // Repeated closing point rejected.
  await assert.rejects(
    () => adapter.prepareGeometry({ id: "x", kind: "bim", engineId: null, props: { shape: "extrude", profile: [[0, 0], [1, 0], [0, 1], [0, 0]], height: 10 } }),
    /coincides with its successor/,
  );
  // Degenerate (collinear) profile rejected.
  await assert.rejects(
    () => adapter.prepareGeometry({ id: "x", kind: "bim", engineId: null, props: { shape: "extrude", profile: [[0, 0], [1, 1], [2, 2]], height: 10 } }),
    /non-degenerate area/,
  );
  // Two-point profile rejected.
  await assert.rejects(
    () => adapter.prepareGeometry({ id: "x", kind: "bim", engineId: null, props: { shape: "extrude", profile: [[0, 0], [1, 0]], height: 10 } }),
    /at least 3/,
  );
});
