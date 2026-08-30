/**
 * CAD-PARITY-011 (Issue #97) — the Archicad-class authoring solids realized
 * through the REAL OCCT engine (engine-gated like every real-engine test).
 *
 * Coverage: the roof gable prism (rigid placement of a triangle-profile
 * extrusion), the stacked-boxes stair (+ landing) as a face-touching fuse
 * chain, the railing trapezoid posts + sloped handrail segments (rigid
 * transforms + exact fuses), and the CROSS-ENGINE volume agreement with the
 * reference adapter's independent analytic evaluation (the same descriptor,
 * both engines, the closed forms). Deterministic mesh tokens across repeated
 * realizations on the same engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcctGeometryAdapter } from "../src/adapters/occt/index.js";
import { createReferenceGeometryAdapter } from "../src/adapters/reference/index.js";
import { engineSkip } from "./engine-availability.js";
import { bimGeometryContext, bimSolidDescriptor, railingVolume, roofVolume, stairVolume } from "../src/bim/geometry.js";
import {
  makeRailing,
  makeRoof,
  makeStair,
  makeStory,
  type BimEntity,
} from "../src/bim/elements.js";

const skipEngine = await engineSkip();
const VOL_TOL = 1e-3; // mm³ — OCCT volume properties round at 9 decimals
const CROSS_TOL = 1e-6; // relative — the cross-engine volume agreement

function entity<T extends object>(input: T, id: string): T & { id: string } {
  return { id, ...input };
}

const GF = entity(makeStory({ name: "GF", level: 0, height: 3000 }), "story-gf");
const FF = entity(makeStory({ name: "FF", level: 3000, height: 3000 }), "story-ff");

const OCCT = createOcctGeometryAdapter();
const REF = createReferenceGeometryAdapter();

async function realize(
  adapter: { prepareGeometry(el: { id: string; kind: string; engineId: null; props: Record<string, unknown> }): Promise<{ meshToken: string }>; describeGeometryMetadata(t: string): Promise<{ volume: number } | null> },
  descriptor: unknown,
): Promise<{ meshToken: string; volume: number }> {
  const result = await adapter.prepareGeometry({ id: "p011", kind: "bim", engineId: null, props: descriptor as Record<string, unknown> });
  const meta = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(meta !== null);
  return { meshToken: result.meshToken, volume: meta.volume };
}

// ---------------------------------------------------------------------------
// Roof — the gable prism through the real kernel
// ---------------------------------------------------------------------------

test("roof: the gable prism has the exact closed-form volume through real OCCT (both ridge axes)", { skip: skipEngine }, async () => {
  for (const ridgeAxis of ["x", "y"] as const) {
    const roof = entity(
      makeRoof({ storyId: "story-ff", corner1: [1000, 2000], corner2: [9000, 8000], ridgeAxis, height: 1800, baseOffset: 200 }),
      "roof-1",
    );
    const ctx = bimGeometryContext([GF, FF, roof]);
    const { descriptor } = bimSolidDescriptor(roof, ctx);
    const realized = await realize(OCCT, descriptor);
    assert.ok(realized.meshToken.startsWith("occt:"));
    const expected = roofVolume(roof);
    assert.ok(
      Math.abs(realized.volume - expected) <= VOL_TOL,
      `ridge ∥ ${ridgeAxis}: OCCT volume ${realized.volume} == closed form ${expected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Stair — the stacked-boxes fuse chain through the real kernel
// ---------------------------------------------------------------------------

const stair = entity(
  makeStair({ storyId: "story-gf", topStoryId: "story-ff", start: [500, 500], direction: [1, 0], width: 1200, stepCount: 16, tread: 280 }),
  "stair-1",
);

test("stair: the stacked-boxes fuse has the exact closed-form volume through real OCCT", { skip: skipEngine }, async () => {
  const ctx = bimGeometryContext([GF, FF, stair]);
  const { descriptor } = bimSolidDescriptor(stair, ctx);
  const realized = await realize(OCCT, descriptor);
  const expected = stairVolume(stair, ctx);
  assert.ok(Math.abs(realized.volume - expected) <= VOL_TOL, `OCCT volume ${realized.volume} == closed form ${expected}`);
});

test("stair: the 24-riser bounded composition with landing realizes through real OCCT", { skip: skipEngine }, async () => {
  const maxStair = entity(
    makeStair({ storyId: "story-gf", topStoryId: "story-ff", start: [0, 0], direction: [0, 1], width: 1000, stepCount: 24, tread: 250, landingLength: 1000 }),
    "stair-max",
  );
  const ctx = bimGeometryContext([GF, FF, maxStair]);
  const realized = await realize(OCCT, bimSolidDescriptor(maxStair, ctx).descriptor);
  const expected = stairVolume(maxStair, ctx);
  assert.ok(Math.abs(realized.volume - expected) <= VOL_TOL, `OCCT volume ${realized.volume} == closed form ${expected}`);
});

// ---------------------------------------------------------------------------
// Railing — trapezoid posts + sloped handrail through the real kernel
// ---------------------------------------------------------------------------

test("railing: posts + sloped handrail realize with the exact closed-form volume through real OCCT (both sides)", { skip: skipEngine }, async () => {
  const ctx = bimGeometryContext([GF, FF, stair]);
  for (const side of ["left", "right"] as const) {
    const railing = entity(makeRailing({ hostId: "stair-1", side, height: 900 }), "railing-1");
    const realized = await realize(OCCT, bimSolidDescriptor(railing, ctx).descriptor);
    const expected = railingVolume(railing, ctx);
    assert.ok(Math.abs(realized.volume - expected) <= VOL_TOL, `${side}: OCCT volume ${realized.volume} == closed form ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Cross-engine agreements — the SAME descriptor, both engines, the closed form
// ---------------------------------------------------------------------------

test("cross-engine: OCCT and the reference adapter agree on the roof/stair/railing volumes (independent evaluations)", { skip: skipEngine }, async () => {
  const roof = entity(
    makeRoof({ storyId: "story-gf", corner1: [-500, -500], corner2: [8500, 8500], ridgeAxis: "x", height: 1500, baseOffset: 3000 }),
    "roof-x",
  );
  const withLanding = { ...stair, landingLength: 1200 };
  const railing = entity(makeRailing({ hostId: "stair-1", side: "left", height: 900 }), "railing-x");
  const roofCtx = bimGeometryContext([GF, FF, roof]);
  const stairCtx = bimGeometryContext([GF, FF, withLanding, railing]);
  const cases: { name: string; descriptor: unknown; closed: number }[] = [
    { name: "roof", descriptor: bimSolidDescriptor(roof, roofCtx).descriptor, closed: roofVolume(roof) },
    { name: "stair+landing", descriptor: bimSolidDescriptor(withLanding, stairCtx).descriptor, closed: stairVolume(withLanding, stairCtx) },
    { name: "railing", descriptor: bimSolidDescriptor(railing, stairCtx).descriptor, closed: railingVolume(railing, stairCtx) },
  ];
  for (const c of cases) {
    const occt = await realize(OCCT, c.descriptor);
    const ref = await realize(REF, c.descriptor);
    assert.ok(
      Math.abs(occt.volume - ref.volume) <= CROSS_TOL * Math.max(1, Math.abs(c.closed)),
      `${c.name}: OCCT ${occt.volume} vs reference ${ref.volume} (closed form ${c.closed})`,
    );
    assert.ok(Math.abs(occt.volume - c.closed) <= VOL_TOL, `${c.name}: OCCT vs closed form`);
    assert.ok(Math.abs(ref.volume - c.closed) <= 1e-6, `${c.name}: reference vs closed form`);
  }
});

test("cross-engine: an arbitrary-heading stair + railing agree (no axis bias)", { skip: skipEngine }, async () => {
  const heading: [number, number] = [3 / 5, 4 / 5];
  const diagonal = entity(
    makeStair({ storyId: "story-gf", topStoryId: "story-ff", start: [1000, 1000], direction: heading, width: 1100, stepCount: 12, tread: 300 }),
    "stair-d",
  );
  const railing = entity(makeRailing({ hostId: "stair-d", side: "right", height: 850 }), "railing-d");
  const ctx = bimGeometryContext([GF, FF, diagonal, railing]);
  for (const [name, ent] of [["stair", diagonal], ["railing", railing]] as const) {
    const { descriptor } = bimSolidDescriptor(ent as BimEntity, ctx);
    const occt = await realize(OCCT, descriptor);
    const ref = await realize(REF, descriptor);
    assert.ok(
      Math.abs(occt.volume - ref.volume) <= CROSS_TOL * Math.max(1, Math.abs(ref.volume)),
      `${name}: OCCT ${occt.volume} vs reference ${ref.volume}`,
    );
  }
});

test("determinism: repeated realizations produce the IDENTICAL mesh token (same engine)", { skip: skipEngine }, async () => {
  const ctx = bimGeometryContext([GF, FF, stair]);
  const { descriptor } = bimSolidDescriptor(stair, ctx);
  const a = await realize(OCCT, descriptor);
  const b = await realize(OCCT, descriptor);
  assert.equal(a.meshToken, b.meshToken);
});
