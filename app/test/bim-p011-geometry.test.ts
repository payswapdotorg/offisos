/**
 * CAD-PARITY-011 (Issue #97) — the Archicad-class authoring solid
 * derivations: the closed-form descriptors (roof gable prism, stacked-boxes
 * stair + landing, railing posts + sloped handrail), the analytic world
 * bboxes, the vertical-relationship derivations, and the EXACT realization
 * through the REFERENCE geometry adapter (the parity-fixture basis) —
 * volumes against the closed forms, honest no-solid declines for
 * zones/option groups, and the deterministic active-option behavior at the
 * geometry layer's boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIM_RAILING_POST_WIDTH,
  BIM_RAILING_RAIL_THICKNESS,
  makeRailing,
  makeRoof,
  makeSpace,
  makeStair,
  makeStory,
  makeZone,
} from "../src/bim/elements.js";
import {
  bimGeometryContext,
  bimSolidDescriptor,
  bimWorldBBox,
  railingVolume,
  roofSlope,
  roofSpanAndLength,
  roofVolume,
  stairRise,
  stairSolid,
  stairStepTopZ,
  stairTotalRise,
  stairVolume,
} from "../src/bim/geometry.js";
import { createReferenceGeometryAdapter } from "../src/adapters/reference/index.js";
import type { Element } from "../src/contracts/caddocument.js";
import type { GeometryDescriptor } from "../src/contracts/geometry.js";

const TOL = 1e-6;
const close = (a: number, b: number, tol = TOL): boolean => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** Realize a descriptor through the reference adapter; returns metadata
 *  (volume) or the typed failure message. */
async function realize(descriptor: GeometryDescriptor): Promise<{ volume: number; bbox: readonly number[]; meshToken: string }> {
  const adapter = createReferenceGeometryAdapter();
  const element: Element = { id: "geom", kind: "bim", engineId: null, props: descriptor as unknown as Record<string, unknown> };
  const result = await adapter.prepareGeometry(element);
  const meta = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(meta !== null, "the reference adapter must provide geometry metadata");
  return { volume: meta.volume, bbox: result.bbox, meshToken: result.meshToken };
}

function ctxOf(entities: readonly Parameters<typeof bimGeometryContext>[0][number][]): ReturnType<typeof bimGeometryContext> {
  return bimGeometryContext(entities);
}

// The representative two-story model used throughout.
const STORIES = [
  { ...makeStory({ name: "GF", level: 0, height: 3000 }), id: "story-gf" },
  { ...makeStory({ name: "FF", level: 3000, height: 3000 }), id: "story-ff" },
];

// ---------------------------------------------------------------------------
// Roof geometry
// ---------------------------------------------------------------------------

test("roof: the story-derived span/slope/volume closed forms", () => {
  const roof = { ...makeRoof({ storyId: "story-ff", corner1: [0, 0], corner2: [8000, 6000], ridgeAxis: "x", height: 1500 }), id: "roof-1" };
  const { span, ridgeLength } = roofSpanAndLength(roof);
  // ridge ∥ x → the span is the Y extent.
  assert.equal(span, 6000);
  assert.equal(ridgeLength, 8000);
  assert.ok(close(roofSlope(roof), Math.atan(2 * 1500 / 6000)));
  assert.ok(close(roofVolume(roof), (6000 * 8000 * 1500) / 2));
  const roofY = { ...roof, ridgeAxis: "y" as const };
  assert.equal(roofSpanAndLength(roofY).span, 8000);
  assert.equal(roofSpanAndLength(roofY).ridgeLength, 6000);
});

test("roof: the gable-prism descriptor realizes EXACTLY on the reference engine (both ridge axes)", async () => {
  for (const ridgeAxis of ["x", "y"] as const) {
    const roof = { ...makeRoof({ storyId: "story-ff", corner1: [1000, 2000], corner2: [9000, 8000], ridgeAxis, height: 1800, baseOffset: 200 }), id: "roof-1" };
    const ctx = ctxOf(STORIES);
    const { descriptor, reason } = bimSolidDescriptor(roof, ctx);
    assert.ok(descriptor !== null, String(reason));
    const realized = await realize(descriptor);
    assert.ok(
      close(realized.volume, roofVolume(roof), 1e-9),
      `ridge ∥ ${ridgeAxis}: reference volume ${realized.volume} must equal the closed form ${roofVolume(roof)}`,
    );
    // The analytic bbox: the footprint × [level+baseOffset, +height].
    const bbox = bimWorldBBox(roof, ctx)!;
    assert.deepEqual(realized.bbox, bbox);
  }
});

test("roof: the transform matrix maps the profile corners onto the analytic gable corners", async () => {
  const roof = { ...makeRoof({ storyId: "story-gf", corner1: [0, 0], corner2: [6000, 4000], ridgeAxis: "x", height: 1000 }), id: "roof-1" };
  const ctx = ctxOf(STORIES);
  const { descriptor } = bimSolidDescriptor(roof, ctx);
  assert.ok(descriptor !== null);
  assert.equal(descriptor.shape, "transform");
  const m = descriptor.matrix;
  const apply = (px: number, py: number, z: number): [number, number, number] => [
    m[0]! * px + m[1]! * py + m[2]! * z + m[3]!,
    m[4]! * px + m[5]! * py + m[6]! * z + m[7]!,
    m[8]! * px + m[9]! * py + m[10]! * z + m[11]!,
  ];
  // The gable section at x = 0: base corners (0,0)/(0,4000) at z=0 and the
  // apex (0, 2000) at z=1000 — the FIRST extrusion cross-section.
  assert.deepEqual(apply(0, 0, 0), [0, 0, 0]);
  assert.deepEqual(apply(4000, 0, 0), [0, 4000, 0]);
  assert.deepEqual(apply(2000, 1000, 0), [0, 2000, 1000]);
  // The ridge end: the same section at the extrusion end (x = 6000).
  assert.deepEqual(apply(2000, 1000, 6000), [6000, 2000, 1000]);
});

// ---------------------------------------------------------------------------
// Stair geometry
// ---------------------------------------------------------------------------

const stair = {
  ...makeStair({ storyId: "story-gf", topStoryId: "story-ff", start: [500, 500], direction: [1, 0], width: 1200, stepCount: 16, tread: 280 }),
  id: "stair-1",
};

test("stair: the story-derived rise (LOCK-007 — never a stored copy)", () => {
  const ctx = ctxOf(STORIES);
  assert.ok(close(stairTotalRise(stair, ctx), 3000));
  assert.ok(close(stairRise(stair, ctx), 3000 / 16));
  // The canonical step-top formula: level + baseOffset + H·i/n.
  assert.ok(close(stairStepTopZ(stair, ctx, 0), 0));
  assert.ok(close(stairStepTopZ(stair, ctx, 16), 3000));
  assert.ok(close(stairStepTopZ(stair, ctx, 8), (3000 * 8) / 16));
});

test("stair: the stacked-boxes closed-form volume (with + without landing)", async () => {
  const ctx = ctxOf(STORIES);
  const { descriptor, reason } = bimSolidDescriptor(stair, ctx);
  assert.ok(descriptor !== null, String(reason));
  const realized = await realize(descriptor);
  const expected = 280 * 1200 * (3000 / 16) * ((16 * 17) / 2);
  assert.ok(close(realized.volume, expected, 1e-9), `reference volume ${realized.volume} == closed form ${expected}`);
  assert.ok(close(stairVolume(stair, ctx), expected));

  const withLanding = { ...stair, landingLength: 1200 };
  const realizedLanding = await realize(bimSolidDescriptor(withLanding, ctx).descriptor!);
  const expectedLanding = expected + 1200 * 1200 * 3000;
  assert.ok(close(realizedLanding.volume, expectedLanding, 1e-9));
  assert.ok(close(stairVolume(withLanding, ctx), expectedLanding));
});

test("stair: an arbitrary run heading realizes exactly (the unit direction carries no axis bias)", async () => {
  const heading: readonly [number, number] = [3 / 5, 4 / 5]; // a 3-4-5 triangle heading — unit length.
  const diagonal = { ...stair, direction: heading, stepCount: 10, tread: 300 };
  const ctx = ctxOf(STORIES);
  const realized = await realize(bimSolidDescriptor(diagonal, ctx).descriptor!);
  const expected = 300 * 1200 * (3000 / 10) * ((10 * 11) / 2);
  assert.ok(close(realized.volume, expected, 1e-9));
});

test("stair: the analytic bbox equals the realized bbox", async () => {
  const ctx = ctxOf(STORIES);
  const { descriptor } = bimSolidDescriptor(stair, ctx);
  const realized = await realize(descriptor!);
  assert.deepEqual(realized.bbox, bimWorldBBox(stair, ctx));
});

// ---------------------------------------------------------------------------
// Railing geometry
// ---------------------------------------------------------------------------

test("railing: posts + sloped handrail closed-form volume realizes EXACTLY on the reference engine", async () => {
  const ctx = ctxOf([...STORIES, stair]);
  const railing = { ...makeRailing({ hostId: "stair-1", side: "left", height: 900 }), id: "railing-1" };
  const { descriptor, reason } = bimSolidDescriptor(railing, ctx);
  assert.ok(descriptor !== null, String(reason));
  const realized = await realize(descriptor);
  const n = 16;
  const rise = 3000 / 16;
  const slopeLen = Math.sqrt(280 * 280 + rise * rise);
  const expected = (n + 1) * BIM_RAILING_POST_WIDTH * BIM_RAILING_POST_WIDTH * 900 + n * slopeLen * BIM_RAILING_POST_WIDTH * BIM_RAILING_RAIL_THICKNESS;
  assert.ok(close(realized.volume, expected, 1e-9), `reference volume ${realized.volume} == closed form ${expected}`);
  assert.ok(close(railingVolume(railing, ctx), expected));
});

test("railing: both sides realize identically (mirrored geometry, same volume)", async () => {
  const ctx = ctxOf([...STORIES, stair]);
  const left = await realize(bimSolidDescriptor({ ...makeRailing({ hostId: "stair-1", side: "left", height: 900 }), id: "l" }, ctx).descriptor!);
  const right = await realize(bimSolidDescriptor({ ...makeRailing({ hostId: "stair-1", side: "right", height: 900 }), id: "r" }, ctx).descriptor!);
  assert.ok(close(left.volume, right.volume, 1e-12));
});

test("railing: a railing without its host stair is an honest decline", () => {
  const ctx = ctxOf(STORIES); // no stair
  const railing = { ...makeRailing({ hostId: "missing", height: 900 }), id: "r" };
  const { descriptor, reason } = bimSolidDescriptor(railing, ctx);
  assert.ok(descriptor === null);
  assert.match(reason!, /host stair 'missing' does not exist/);
});

test("railing: the analytic bbox equals the realized bbox", async () => {
  const ctx = ctxOf([...STORIES, stair]);
  const railing = { ...makeRailing({ hostId: "stair-1", side: "right", height: 850 }), id: "railing-1" };
  const { descriptor } = bimSolidDescriptor(railing, ctx);
  const realized = await realize(descriptor!);
  assert.deepEqual(realized.bbox, bimWorldBBox(railing, ctx));
});

// ---------------------------------------------------------------------------
// Zones / option groups: the honest no-solid declines
// ---------------------------------------------------------------------------

test("zone and optionGroup: no solids — typed honest declines", () => {
  const space = { ...makeSpace({ storyId: "story-gf", name: "Office", footprint: [[0, 0], [4000, 0], [4000, 3000], [0, 3000]], height: 3000 }), id: "space-1" };
  const zone = { ...makeZone({ name: "Wing", spaceIds: ["space-1"] }), id: "zone-1" };
  const ctx = ctxOf([...STORIES, space, zone]);
  const z = bimSolidDescriptor(zone, ctx);
  assert.ok(z.descriptor === null);
  assert.match(z.reason!, /spatial grouping/);
  assert.equal(bimWorldBBox(zone, ctx), null);
});

// ---------------------------------------------------------------------------
// The max-size bounded composition (determinism bound check)
// ---------------------------------------------------------------------------

test("the 24-riser bound: the maximum stair + railing composition realizes within the adapter bounds", async () => {
  const maxStair = {
    ...makeStair({ storyId: "story-gf", topStoryId: "story-ff", start: [0, 0], direction: [0, 1], width: 1000, stepCount: 24, tread: 250, landingLength: 1000 }),
    id: "stair-max",
  };
  const ctx = ctxOf([...STORIES, maxStair]);
  const stairRealized = await realize(bimSolidDescriptor(maxStair, ctx).descriptor!);
  const expectedStair = 250 * 1000 * (3000 / 24) * ((24 * 25) / 2) + 1000 * 1000 * 3000;
  assert.ok(close(stairRealized.volume, expectedStair, 1e-9));
  const railing = { ...makeRailing({ hostId: "stair-max", height: 900 }), id: "rail-max" };
  const railingRealized = await realize(bimSolidDescriptor(railing, ctx).descriptor!);
  const slopeLen = Math.sqrt(250 * 250 + (3000 / 24) ** 2);
  const expectedRailing = 25 * BIM_RAILING_POST_WIDTH ** 2 * 900 + 24 * slopeLen * BIM_RAILING_POST_WIDTH * BIM_RAILING_RAIL_THICKNESS;
  assert.ok(close(railingRealized.volume, expectedRailing, 1e-9));
});
