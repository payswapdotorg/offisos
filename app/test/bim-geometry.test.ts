/**
 * COMPAT-CAD-002 — deterministic BIM solid derivation + world bboxes +
 * standard cameras (pure, engine-free; the engine assertions live in
 * bim-occt.test.ts).
 *
 * Exact analytic expectations with declared tolerance 1e-9 for rotated
 * constructions (IEEE-754 trigonometry is deterministic on both hosts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bimGeometryContext,
  bimModelBBox,
  bimSolidDescriptor,
  bimWorldBBox,
  OPENING_CUT_OVERHANG,
  wallProfile,
  type BimGeometryContext,
} from "../src/bim/geometry.js";
import { standardCamera } from "../src/bim/camera.js";
import {
  bimEntityToElement,
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  type BimEntity,
} from "../src/bim/elements.js";

const TOL = 1e-9;

function entity<T extends object>(input: T, id: string): T & { id: string } {
  return { id, ...input };
}

const STORY = entity(makeStory({ name: "Ground Floor", level: 0, height: 3000 }), "el-000001");
const WALL_SOUTH = entity(
  makeWall({ storyId: "el-000001", start: [0, 0], end: [6000, 0], width: 300, height: 3000 }),
  "el-000002",
);

function ctxOf(...entities: BimEntity[]): BimGeometryContext {
  return bimGeometryContext(entities);
}

test("wall profile: axis-aligned wall has exact world rectangle corners", () => {
  // +X axis wall: left normal n = (0,1); profile spans [0,6000]×[-150,150].
  const profile = wallProfile(WALL_SOUTH);
  assert.deepEqual(profile, [
    [0, -150],
    [6000, -150],
    [6000, 150],
    [0, 150],
  ]);
});

test("wall profile: rotated wall (90°) has exact corners", () => {
  const wall = entity(
    makeWall({ storyId: "el-000001", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 }),
    "el-000003",
  );
  // +Y axis: u=(0,1), n=(-1,0); corners = start−n·h, end−n·h, end+n·h, start+n·h.
  assert.deepEqual(wallProfile(wall), [
    [6150, 0],
    [6150, 5000],
    [5850, 5000],
    [5850, 0],
  ]);
});

test("wall profile: 45° wall corners match IEEE-754 exact trigonometry", () => {
  const k = Math.SQRT1_2; // cos/sin(45°)
  const wall = entity(
    makeWall({ storyId: "el-000001", start: [0, 0], end: [5000, 5000], width: 200, height: 3000 }),
    "el-000004",
  );
  // u=(k,k), n=(-k,k); corners = start−n·h, end−n·h, end+n·h, start+n·h with h=100.
  const profile = wallProfile(wall);
  const expected: [number, number][] = [
    [100 * k, -100 * k],
    [5000 + 100 * k, 5000 - 100 * k],
    [5000 - 100 * k, 5000 + 100 * k],
    [-100 * k, 100 * k],
  ];
  profile.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - expected[i]![0]) <= TOL, `corner ${i} x`);
    assert.ok(Math.abs(p[1] - expected[i]![1]) <= TOL, `corner ${i} y`);
  });
});

test("wall solid: descriptor is extrude(profile, height) at story z with nested opening cuts", () => {
  const doorOpening = entity(
    makeOpening({ hostId: "el-000002", distance: 500, width: 900, height: 2100, sill: 0 }),
    "el-000005",
  );
  const winOpening = entity(
    makeOpening({ hostId: "el-000002", distance: 3500, width: 1500, height: 1200, sill: 900 }),
    "el-000006",
  );
  const ctx = ctxOf(STORY, WALL_SOUTH, doorOpening, winOpening);
  const { descriptor, reason } = bimSolidDescriptor(WALL_SOUTH, ctx);
  assert.equal(reason, null);
  assert.equal(descriptor!.shape, "cut");
  // Outer cut: cut(cut(body, first-by-distance), second).
  const outer = descriptor as { shape: "cut"; a: unknown; b: unknown };
  const inner = outer.a as { shape: "cut"; a: { shape: string }; b: { shape: "extrude"; base: number[] } };
  assert.equal(inner.a.shape, "extrude");
  assert.deepEqual(inner.b.base, [0, 0, 0]); // first opening: sill 0
  const second = outer.b as { shape: "extrude"; base: number[]; profile: readonly (readonly [number, number])[] };
  assert.deepEqual(second.base, [0, 0, 900]); // second opening: sill 900
  // Cut tool overhang: width 300 + 2×1 = 302 across y for the axis-aligned wall.
  const ys = [...new Set(second.profile.map((p) => p[1]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-151, 151]);
  assert.equal(OPENING_CUT_OVERHANG, 1, "declared overhang constant");
});

test("slab solid: axis-aligned footprint extruded by thickness at story z", () => {
  const slab = entity(
    makeSlab({ storyId: "el-000001", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 }),
    "el-000007",
  );
  const { descriptor } = bimSolidDescriptor(slab, ctxOf(STORY, slab));
  assert.deepEqual(descriptor, {
    shape: "extrude",
    profile: [[-300, -300], [6300, -300], [6300, 5300], [-300, 5300]],
    height: 200,
    base: [0, 0, -200],
  });
});

test("space solid: L-shaped footprint extruded at story z + baseOffset", () => {
  const space = entity(
    makeSpace({
      storyId: "el-000001",
      name: "Office 1",
      footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]],
      height: 3000,
      baseOffset: 0,
    }),
    "el-000008",
  );
  const { descriptor } = bimSolidDescriptor(space, ctxOf(STORY, space));
  assert.equal(descriptor!.shape, "extrude");
  const d = descriptor as unknown as { shape: string; profile: readonly unknown[]; base: number[] };
  assert.equal(d.profile.length, 6);
  assert.deepEqual(d.base, [0, 0, 0]);
});

test("door solid: leaf fills the opening in the wall plane at the sill base", () => {
  const opening = entity(
    makeOpening({ hostId: "el-000002", distance: 500, width: 900, height: 2100, sill: 0 }),
    "el-000005",
  );
  const door = entity(makeDoor({ openingId: "el-000005", storyId: "el-000001", swing: "left", leafThickness: 40 }), "el-000009");
  const { descriptor } = bimSolidDescriptor(door, ctxOf(STORY, WALL_SOUTH, opening, door));
  const d = descriptor as unknown as { shape: string; profile: readonly (readonly [number, number])[]; height: number; base: number[] };
  assert.equal(d.shape, "extrude");
  assert.equal(d.height, 2100);
  assert.deepEqual(d.base, [0, 0, 0]);
  const xs = [...new Set(d.profile.map((p) => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(d.profile.map((p) => p[1]))].sort((a, b) => a - b);
  assert.deepEqual(xs, [500, 1400]); // distance..distance+width
  assert.deepEqual(ys, [-20, 20]); // leaf thickness centered
});

test("window solid: panel thickness = min(40, wall width), centered", () => {
  const opening = entity(
    makeOpening({ hostId: "el-000002", distance: 3500, width: 1500, height: 1200, sill: 900 }),
    "el-000006",
  );
  const win = entity(makeWindow({ openingId: "el-000006", storyId: "el-000001" }), "el-000010");
  const { descriptor } = bimSolidDescriptor(win, ctxOf(STORY, WALL_SOUTH, opening, win));
  const d = descriptor as unknown as { profile: readonly (readonly [number, number])[]; height: number; base: number[] };
  assert.equal(d.height, 1200);
  assert.deepEqual(d.base, [0, 0, 900]);
  const ys = [...new Set(d.profile.map((p) => p[1]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-20, 20]); // min(40, 300) = 40
});

test("story has no solid — honest typed reason, not a guessed shape", () => {
  const { descriptor, reason } = bimSolidDescriptor(STORY, ctxOf(STORY));
  assert.equal(descriptor, null);
  assert.match(reason!, /level container/);
});

test("world bbox: axis-aligned wall spans exact extents at story z", () => {
  const box = bimWorldBBox(WALL_SOUTH, ctxOf(STORY, WALL_SOUTH))!;
  assert.deepEqual(box, [0, -150, 0, 6000, 150, 3000]);
});

test("world bbox: story elevation lifts hosted geometry exactly", () => {
  const story2 = entity(makeStory({ name: "L1", level: 3200, height: 3000 }), "el-000011");
  const wall = entity(
    makeWall({ storyId: "el-000011", start: [0, 0], end: [6000, 0], width: 300, height: 2800 }),
    "el-000012",
  );
  const box = bimWorldBBox(wall, ctxOf(story2, wall))!;
  assert.deepEqual(box, [0, -150, 3200, 6000, 150, 6000]);
});

test("model bbox: union over solid-bearing elements, stories excluded", () => {
  const slab = entity(
    makeSlab({ storyId: "el-000001", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 }),
    "el-000007",
  );
  const entities = [STORY, WALL_SOUTH, slab];
  const box = bimModelBBox(entities, bimGeometryContext(entities))!;
  assert.deepEqual(box, [-300, -300, -200, 6300, 5300, 3000]);
});

test("standard cameras: deterministic constructions from the model bbox", () => {
  const bbox = [0, 0, 0, 6000, 6000, 3000] as const;
  const iso = standardCamera("iso", bbox);
  const k = 1 / Math.sqrt(3);
  const d = 18000; // diagonal 9000 × 2
  assert.ok(Math.abs(iso.eye[0] - (3000 + k * d)) <= TOL);
  assert.ok(Math.abs(iso.eye[1] - (3000 - k * d)) <= TOL);
  assert.ok(Math.abs(iso.eye[2] - (1500 + k * d)) <= TOL);
  assert.deepEqual(iso.target, [3000, 3000, 1500]);
  assert.deepEqual(iso.up, [0, 0, 1]);
  const top = standardCamera("top", bbox);
  assert.deepEqual(top.eye, [3000, 3000, 1500 + 18000]);
  assert.deepEqual(top.up, [0, 1, 0], "top view keeps +Y up");
  const front = standardCamera("front", bbox);
  assert.deepEqual(front.eye, [3000, 3000 - 18000, 1500]);
  const right = standardCamera("right", bbox);
  assert.deepEqual(right.eye, [3000 + 18000, 3000, 1500]);
});

test("standard cameras: unknown presets and empty models are typed rejects", () => {
  assert.throws(() => standardCamera("plan", [0, 0, 0, 1, 1, 1]), /preset/);
  assert.throws(() => standardCamera("iso", null), /bounding box/);
  assert.throws(() => standardCamera("iso", [0, 0, 0, 0, 0, 0]), /non-degenerate/);
});

test("camera parity anchor: same building → identical camera through element round-trip", () => {
  // The camera derives from props → serialization round-trip must not drift.
  const wallRoundTriipped = JSON.parse(JSON.stringify(bimEntityToElement(WALL_SOUTH)));
  const ctxA = bimGeometryContext([STORY, WALL_SOUTH]);
  const ctxB = bimGeometryContext([STORY, { ...WALL_SOUTH, start: wallRoundTriipped.props.start as [number, number] }]);
  const camA = standardCamera("iso", bimModelBBox([STORY, WALL_SOUTH], ctxA));
  const camB = standardCamera("iso", bimModelBBox([STORY, WALL_SOUTH], ctxB));
  assert.deepEqual(camA, camB);
});
