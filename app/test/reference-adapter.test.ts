/**
 * Reference adapter contract conformance + exactness (RESEARCH-CAD-007 /
 * Issue #32). Engine-free: runs on any toolchain (no python, no OCCT).
 *
 * Proves the second geometry engine satisfies the SAME frozen
 * GeometryEngineAdapter contract with the SAME typed failure surface as the
 * OCCT adapter, computes EXACT analytic values inside its declared
 * exactness classes, declines outside them TYPED (LOCK-007), and is fully
 * deterministic (LOCK-004/005/017).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReferenceAdapterBundle,
  createReferenceGeometryAdapter,
  evaluateDescriptorAnalytically,
  REFERENCE_ENGINE_ID,
  REFERENCE_ENGINE_VERSION,
} from "../src/adapters/reference/index.js";
import { ADAPTER_BOUNDARY_MARK } from "../src/contracts/adapter.js";
import type { Element } from "../src/contracts/caddocument.js";
import { isAdapterFailure } from "../src/contracts/geometry.js";
import { CORPUS, EXPECTED_VOLUMES, rotationZ, translation } from "./cad007-corpus.js";

function geometryElement(props: Record<string, unknown>): Element {
  return { id: "test-geometry", kind: "geometry", engineId: null, props };
}

test("adapter declares the frozen boundary mark and engine identity", () => {
  const adapter = createReferenceGeometryAdapter();
  assert.equal(adapter.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(adapter.engineId, REFERENCE_ENGINE_ID);
  assert.equal(adapter.engineVersion, REFERENCE_ENGINE_VERSION);
  assert.equal(REFERENCE_ENGINE_ID, "reference");
});

test("bundle satisfies the EngineAdapterBundle shape (geometry/bim/file)", () => {
  const bundle = createReferenceAdapterBundle();
  assert.equal(bundle.geometry.engineId, "reference");
  assert.equal(bundle.bim.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(bundle.file.format, "offisos-reference");
  assert.equal(typeof bundle.file.read, "function");
  assert.equal(typeof bundle.file.write, "function");
});

test("malformed descriptors throw the SAME typed failures as the OCCT adapter", async () => {
  const adapter = createReferenceGeometryAdapter();
  const cases: [unknown, string, RegExp][] = [
    [{ shape: "box", width: -1, depth: 1, height: 1 }, "engine_malformed_input", /geometry\.width/],
    [{ shape: "box", width: "x", depth: 1, height: 1 }, "engine_malformed_input", /geometry\.width/],
    [{ shape: "cylinder", radius: 0, height: 1 }, "engine_malformed_input", /geometry\.radius/],
    [{ shape: "cylinder", radius: 1, height: 1, direction: [0, 0, 0] }, "engine_malformed_input", /non-null vector/],
    [{ shape: "nope" }, "engine_malformed_input", /box\/cylinder\/transform\/fuse\/cut/],
    [null, "engine_malformed_input", /must be an object/],
    [
      { shape: "transform", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1], target: { shape: "box", width: 1, depth: 1, height: 1 } },
      "engine_malformed_input",
      /affine/,
    ],
  ];
  for (const [descriptor, code, message] of cases) {
    await assert.rejects(
      () => adapter.prepareGeometry(geometryElement(descriptor as Record<string, unknown>)),
      (e: unknown) => {
        assert.ok(isAdapterFailure(e), `expected AdapterFailure for ${JSON.stringify(descriptor)}`);
        assert.equal((e as { code: string }).code, code);
        assert.match((e as Error).message, message);
        return true;
      },
    );
  }
});

test("corpus: exact analytic volumes, exact bboxes, deterministic meshTokens", async () => {
  const adapter = createReferenceGeometryAdapter();
  for (const item of CORPUS) {
    const a = await adapter.prepareGeometry(geometryElement(item.descriptor));
    const b = await adapter.prepareGeometry(geometryElement(item.descriptor));
    assert.equal(a.meshToken, b.meshToken, `${item.id}: deterministic meshToken`);
    assert.ok(a.meshToken.startsWith("ref:"), `${item.id}: ref: prefix`);
    assert.equal(a.meshToken.length, 4 + 64, `${item.id}: ref: + sha256 hex`);
    const metadata = await adapter.describeGeometryMetadata(a.meshToken);
    assert.ok(metadata !== null, `${item.id}: metadata capability`);
    const expected = EXPECTED_VOLUMES[item.id]!;
    assert.ok(
      Math.abs(metadata!.volume - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
      `${item.id}: volume ${metadata!.volume} === ${expected} (exact analytic)`,
    );
    const mesh = await adapter.describeMesh(a.meshToken);
    assert.ok(mesh !== null, `${item.id}: mesh capability`);
    assert.equal(metadata!.vertices, mesh!.vertices.length / 3, `${item.id}: vertex count matches mesh`);
    assert.equal(metadata!.triangles, mesh!.indices.length / 3, `${item.id}: triangle count matches mesh`);
    assert.ok(mesh!.indices.length % 3 === 0, `${item.id}: triangle list`);
    assert.ok(mesh!.vertices.length % 3 === 0, `${item.id}: flat vertices`);
  }
});

test("deterministic across adapter instances; distinct for distinct geometry", async () => {
  const a = createReferenceGeometryAdapter();
  const b = createReferenceGeometryAdapter();
  const d = { shape: "box", width: 2, depth: 3, height: 4 };
  const ra = await a.prepareGeometry(geometryElement(d));
  const rb = await b.prepareGeometry(geometryElement(d));
  assert.equal(ra.meshToken, rb.meshToken);
  const other = await a.prepareGeometry(geometryElement({ shape: "box", width: 2, depth: 3, height: 5 }));
  assert.notEqual(ra.meshToken, other.meshToken);
});

test("box: exact volume/bbox; transform: exact corners under any affine", async () => {
  const adapter = createReferenceGeometryAdapter();
  const box = await adapter.prepareGeometry(geometryElement({ shape: "box", width: 2, depth: 3, height: 4 }));
  const meta = await adapter.describeGeometryMetadata(box.meshToken);
  assert.equal(meta!.volume, 24);
  assert.deepEqual([...box.bbox], [0, 0, 0, 2, 3, 4]);

  // rotate + translate: v' = M·v with rotationZ(90°, t=10,20,30): x' = 10 − y
  // ∈ [7,10], y' = 20 + x ∈ [20,22], z' ∈ [30,34] — the rotated 2×3×4 box's
  // world bbox swaps the width/depth extents. Exact corner computation.
  const rotated = await adapter.prepareGeometry(
    geometryElement({ shape: "transform", matrix: rotationZ(Math.PI / 2, 10, 20, 30), target: { shape: "box", width: 2, depth: 3, height: 4 } }),
  );
  const rotMeta = await adapter.describeGeometryMetadata(rotated.meshToken);
  assert.ok(Math.abs(rotMeta!.volume - 24) <= 1e-9, "rigid transform preserves volume");
  const rb = rotated.bbox;
  const expectedRb = [7, 20, 30, 10, 22, 34];
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(rb[i]! - expectedRb[i]!) <= 1e-9, `rotated bbox[${i}] ${rb[i]} ~ ${expectedRb[i]}`);
  }

  // NON-uniform scale on a box stays exact (parallelepiped): volume × |det|
  const scaled = await adapter.prepareGeometry(
    geometryElement({
      shape: "transform",
      matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1],
      target: { shape: "box", width: 2, depth: 3, height: 4 },
    }),
  );
  const scaleMeta = await adapter.describeGeometryMetadata(scaled.meshToken);
  assert.ok(Math.abs(scaleMeta!.volume - 24 * 3) <= 1e-9, "non-uniform scale multiplies volume by |det| = 3");
  assert.deepEqual([...scaled.bbox], [0, 0, 0, 4, 9, 2]);
});

test("cylinder: exact πr²h volume + exact directional bbox", async () => {
  const adapter = createReferenceGeometryAdapter();
  const r = 0.5;
  const h = 2;
  const along = await adapter.prepareGeometry(
    geometryElement({ shape: "cylinder", radius: r, height: h, origin: [5, 0, 0], direction: [1, 0, 0] }),
  );
  const meta = await adapter.describeGeometryMetadata(along.meshToken);
  assert.ok(Math.abs(meta!.volume - Math.PI * r * r * h) <= 1e-12, "πr²h");
  const expected = [5, -r, -r, 5 + h, r, r];
  along.bbox.forEach((v, i) => {
    assert.ok(Math.abs(v - expected[i]!) <= 1e-12, `axis bbox[${i}] ${v} === ${expected[i]}`);
  });
  // diagonal direction: exact projection formula still holds
  const diag = await adapter.prepareGeometry(
    geometryElement({ shape: "cylinder", radius: 1, height: 1, origin: [0, 0, 0], direction: [1, 1, 1] }),
  );
  const d = 1 / Math.sqrt(3);
  const radial = Math.sqrt(1 - d * d);
  const expectedDiag = [-radial, -radial, -radial, d + radial, d + radial, d + radial];
  diag.bbox.forEach((v, i) => {
    assert.ok(Math.abs(v - expectedDiag[i]!) <= 1e-12, `diag bbox[${i}] ${v} === ${expectedDiag[i]}`);
  });
});

test("cut: exact cell decomposition (notch, through-opening, double cut)", async () => {
  const adapter = createReferenceGeometryAdapter();
  // corner notch of 1×1×1 out of a 2×2×2 box
  const notch = await adapter.prepareGeometry(
    geometryElement({
      shape: "cut",
      a: { shape: "box", width: 2, depth: 2, height: 2 },
      b: { shape: "transform", matrix: translation(1, 1, 1), target: { shape: "box", width: 1, depth: 1, height: 1 } },
    }),
  );
  const notchMeta = await adapter.describeGeometryMetadata(notch.meshToken);
  assert.ok(Math.abs(notchMeta!.volume - (8 - 1)) <= 1e-12, `notch volume ${notchMeta!.volume} === 7`);
  assert.deepEqual([...notch.bbox], [0, 0, 0, 2, 2, 2]);

  // double cut: remove two disjoint corners
  const twice = await adapter.prepareGeometry(
    geometryElement({
      shape: "cut",
      a: {
        shape: "cut",
        a: { shape: "box", width: 2, depth: 2, height: 2 },
        b: { shape: "transform", matrix: translation(1, 1, 1), target: { shape: "box", width: 1, depth: 1, height: 1 } },
      },
      b: { shape: "box", width: 1, depth: 1, height: 1 },
    }),
  );
  const twiceMeta = await adapter.describeGeometryMetadata(twice.meshToken);
  assert.ok(Math.abs(twiceMeta!.volume - (8 - 2)) <= 1e-12, `double-cut volume ${twiceMeta!.volume} === 6`);

  // non-overlapping cut: unchanged volume
  const away = await adapter.prepareGeometry(
    geometryElement({
      shape: "cut",
      a: { shape: "box", width: 2, depth: 2, height: 2 },
      b: { shape: "transform", matrix: translation(5, 5, 5), target: { shape: "box", width: 1, depth: 1, height: 1 } },
    }),
  );
  const awayMeta = await adapter.describeGeometryMetadata(away.meshToken);
  assert.ok(Math.abs(awayMeta!.volume - 8) <= 1e-12, "non-overlapping cut leaves volume unchanged");
});

test("exactness-class declines are TYPED engine_error failures, never guesses", async () => {
  const adapter = createReferenceGeometryAdapter();
  // overlapping fuse
  await assert.rejects(
    () =>
      adapter.prepareGeometry(
        geometryElement({
          shape: "fuse",
          a: { shape: "box", width: 2, depth: 2, height: 2 },
          b: { shape: "box", width: 2, depth: 2, height: 2 },
        }),
      ),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e));
      assert.equal((e as { code: string }).code, "engine_error");
      assert.match((e as Error).message, /fuse/);
      assert.equal((e as { retryable: boolean }).retryable, false);
      return true;
    },
  );
  // non-uniform affine on a cylinder
  await assert.rejects(
    () =>
      adapter.prepareGeometry(
        geometryElement({
          shape: "transform",
          matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          target: { shape: "cylinder", radius: 1, height: 1 },
        }),
      ),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e));
      assert.equal((e as { code: string }).code, "engine_error");
      assert.match((e as Error).message, /cylinder/);
      return true;
    },
  );
  // cut involving a cylinder
  await assert.rejects(
    () =>
      adapter.prepareGeometry(
        geometryElement({
          shape: "cut",
          a: { shape: "box", width: 2, depth: 2, height: 2 },
          b: { shape: "cylinder", radius: 0.5, height: 3 },
        }),
      ),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e));
      assert.equal((e as { code: string }).code, "engine_error");
      return true;
    },
  );
  // rotated box inside a cut leaves the axis-aligned cell class
  await assert.rejects(
    () =>
      adapter.prepareGeometry(
        geometryElement({
          shape: "cut",
          a: { shape: "transform", matrix: rotationZ(Math.PI / 4), target: { shape: "box", width: 2, depth: 2, height: 2 } },
          b: { shape: "box", width: 1, depth: 1, height: 1 },
        }),
      ),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e));
      assert.equal((e as { code: string }).code, "engine_error");
      return true;
    },
  );
  // cut that removes everything
  await assert.rejects(
    () =>
      adapter.prepareGeometry(
        geometryElement({
          shape: "cut",
          a: { shape: "box", width: 1, depth: 1, height: 1 },
          b: { shape: "transform", matrix: translation(-0.5, -0.5, -0.5), target: { shape: "box", width: 2, depth: 2, height: 2 } },
        }),
      ),
    (e: unknown) => {
      assert.ok(isAdapterFailure(e));
      assert.match((e as Error).message, /empty/);
      return true;
    },
  );
});

test("evaluateDescriptorAnalytically exposes the same exact values without caches", () => {
  for (const item of CORPUS) {
    const { volume } = evaluateDescriptorAnalytically(item.descriptor);
    const expected = EXPECTED_VOLUMES[item.id]!;
    assert.ok(Math.abs(volume - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${item.id} analytic volume`);
  }
});
