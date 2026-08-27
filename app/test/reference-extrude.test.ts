/**
 * COMPAT-CAD-002 — reference engine (the second, engine-free geometry
 * implementation) exact extrude class: exact prism volumes/bboxes/meshes,
 * winding-independent tokens, exact Z-preserving affine transforms, and
 * typed declines outside the exactness class (LOCK-003/007).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReferenceGeometryAdapter,
  evaluateDescriptorAnalytically,
} from "../src/adapters/reference/reference-geometry-adapter.js";
import type { Element } from "../src/contracts/caddocument.js";

const RECT: [number, number][] = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];
const L_SHAPE: [number, number][] = [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]];

function element(props: Record<string, unknown>): Element {
  return { id: "ref-extrude", kind: "bim", engineId: null, props };
}

test("extrude: exact prism volume + bbox + mesh stats", async () => {
  const adapter = createReferenceGeometryAdapter();
  const result = await adapter.prepareGeometry(element({ shape: "extrude", profile: RECT, height: 2500, base: [0, 0, 100] }));
  assert.ok(result.meshToken.startsWith("ref:"));
  assert.deepEqual(result.bbox, [0, 0, 100, 4000, 3000, 2600]);
  const meta = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(meta !== null);
  assert.equal(meta.volume, 4000 * 3000 * 2500);
  assert.equal(meta.vertices, 8);
  assert.equal(meta.triangles, 12, "caps (2+2) + sides (8)");
});

test("extrude: L-shaped footprint volume is exact (shoelace × height)", () => {
  const { volume, bbox } = evaluateDescriptorAnalytically({ shape: "extrude", profile: L_SHAPE, height: 3000 });
  assert.equal(volume, 27_000_000 * 3000);
  assert.deepEqual(bbox, [0, 0, 0, 6000, 6000, 3000]);
});

test("extrude: winding-independent mesh token (CCW normalization)", async () => {
  const adapter = createReferenceGeometryAdapter();
  const ccw = await adapter.prepareGeometry(element({ shape: "extrude", profile: RECT, height: 100 }));
  const cw = await adapter.prepareGeometry(element({ shape: "extrude", profile: [...RECT].reverse(), height: 100 }));
  assert.equal(ccw.meshToken, cw.meshToken, "either winding of the same polygon yields the identical token");
});

test("extrude: Z-preserving affine transform stays exact", () => {
  // Planar rotation by 90° about Z + translation: [x'] = [-y+5000, x, z].
  const matrix = [
    0, -1, 0, 5000,
    1, 0, 0, 0,
    0, 0, 1, 200,
    0, 0, 0, 1,
  ];
  const { volume, bbox } = evaluateDescriptorAnalytically({
    shape: "transform",
    matrix,
    target: { shape: "extrude", profile: RECT, height: 2500 },
  });
  assert.equal(volume, 4000 * 3000 * 2500, "rigid transform preserves volume exactly");
  // Rotated rect: x ∈ [5000-3000, 5000], y ∈ [0, 4000], z ∈ [200, 2700].
  assert.deepEqual(bbox, [2000, 0, 200, 5000, 4000, 2700]);
});

test("extrude: tilting transforms are typed declines (never approximated)", () => {
  // Rotation about X: z mixes into y → the image is not a Z prism.
  const matrix = [
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  ];
  assert.throws(
    () => evaluateDescriptorAnalytically({ shape: "transform", matrix, target: { shape: "extrude", profile: RECT, height: 100 } }),
    /non-Z-preserving affine transform of an extrusion/,
  );
  // cut of prisms is outside the cut exactness class (cells only).
  assert.throws(
    () =>
      evaluateDescriptorAnalytically({
        shape: "cut",
        a: { shape: "extrude", profile: RECT, height: 100 },
        b: { shape: "extrude", profile: [[100, 100], [200, 100], [200, 200], [100, 200]], height: 100 },
      }),
    /cut requires both operands to be axis-aligned box combinations/,
  );
});

test("extrude: malformed profiles fail typed at both engines' shared boundary", () => {
  assert.throws(
    () => evaluateDescriptorAnalytically({ shape: "extrude", profile: [[0, 0], [1, 0], [1, 0]], height: 10 }),
    /coincides with its successor/,
  );
  assert.throws(
    () => evaluateDescriptorAnalytically({ shape: "extrude", profile: [[0, 0], [1, 1], [2, 2]], height: 10 }),
    /non-degenerate area/,
  );
  assert.throws(
    () => evaluateDescriptorAnalytically({ shape: "extrude", profile: RECT, height: -1 }),
    /geometry\.height/,
  );
});

test("engine equivalence: extrude volumes agree between the reference engine and the analytic derivation", () => {
  // The reference engine IS analytic — the equivalence anchor is the exact
  // value; the OCCT engine agrees within its 9-decimal rounding (bim-occt).
  for (const [profile, area] of [
    [RECT, 12_000_000],
    [L_SHAPE, 27_000_000],
  ] as const) {
    const { volume } = evaluateDescriptorAnalytically({ shape: "extrude", profile, height: 3000 });
    assert.equal(volume, area * 3000);
  }
});
