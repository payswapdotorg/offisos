/**
 * Deterministic real-engine geometry tests (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Exercises the OCCT geometry adapter (the real engine behind the frozen
 * EngineAdapterBundle boundary) over the minimum canonical geometry set:
 * box, cylinder, transform, boolean fuse/cut — asserting DETERMINISM (the
 * LOCK-004/005/017 invariant that preserves Web/Electron host parity) and
 * mathematical correctness within the declared tolerances (bbox is the
 * tolerance-inclusive OCCT Bnd_Box: ~1e-7 for primitives, up to ~5e-3 after
 * booleans; volumes are exact for polyhedra, within 1e-6 for curved
 * surfaces).
 *
 * Skips (with the recorded reason) when the pinned toolchain
 * (python3 + cadquery-ocp / OCCT) is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcctAdapterBundle, createOcctGeometryAdapter } from "../src/adapters/occt/index.js";
import { engineSkip } from "./engine-availability.js";
import { ADAPTER_BOUNDARY_MARK } from "../src/contracts/adapter.js";
import type { Element } from "../src/contracts/caddocument.js";

const skipEngine = await engineSkip();

function geometryElement(props: Record<string, unknown>): Element {
  return { id: "test-geometry", kind: "geometry", engineId: null, props };
}

test("adapter declares the frozen boundary mark and engine provenance", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  assert.equal(adapter.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(adapter.engineId, "occt");
  assert.equal(typeof adapter.engineVersion, "string");
});

test("box: deterministic meshToken, exact volume, 8 verts / 12 triangles, tight bbox", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const a = await adapter.prepareGeometry(geometryElement({ shape: "box", width: 80, depth: 60, height: 40 }));
  const b = await adapter.prepareGeometry(geometryElement({ shape: "box", width: 80, depth: 60, height: 40 }));
  assert.equal(a.meshToken, b.meshToken, "identical boxes must yield identical meshTokens (determinism)");
  assert.ok(a.meshToken.startsWith("occt:"), "meshToken carries the occt: prefix");
  assert.equal(a.meshToken.length, 5 + 64, "meshToken is occt: + sha256 hex");
  // Deterministic across adapter instances (fresh process per call anyway).
  const other = await createOcctGeometryAdapter().prepareGeometry(
    geometryElement({ shape: "box", width: 80, depth: 60, height: 40 }),
  );
  assert.equal(a.meshToken, other.meshToken, "meshToken is stable across adapter instances");
  // Different geometry -> different token.
  const different = await adapter.prepareGeometry(geometryElement({ shape: "box", width: 1, depth: 1, height: 1 }));
  assert.notEqual(a.meshToken, different.meshToken);
  // Metadata capabilities.
  const mesh = await adapter.describeMesh(a.meshToken);
  assert.ok(mesh !== null, "MeshProvider capability returns the cached mesh");
  assert.equal(mesh!.vertices.length, 8 * 3, "box tessellates to 8 vertices");
  assert.equal(mesh!.indices.length, 12 * 3, "box tessellates to 12 triangles");
  const metadata = await adapter.describeGeometryMetadata(a.meshToken);
  assert.ok(metadata !== null, "GeometryMetadataProvider capability returns metadata");
  assert.equal(metadata!.volume, 80 * 60 * 40, "box volume is exact");
  assert.equal(metadata!.vertices, 8);
  assert.equal(metadata!.triangles, 12);
  // bbox within the declared tolerance of the exact box extents.
  const expected = [0, 0, 0, 80, 60, 40];
  a.bbox.forEach((value, i) => {
    assert.ok(
      Math.abs(value - expected[i]!) <= 0.01,
      `bbox[${i}] = ${value} within 0.01 of ${expected[i]}`,
    );
  });
  assert.equal(adapter.engineVersion !== "unknown", true, "engineVersion discovered after first call");
});

test("cylinder: volume pi*r^2*h within tolerance, deterministic", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const a = await adapter.prepareGeometry(geometryElement({ shape: "cylinder", radius: 0.5, height: 2 }));
  const b = await adapter.prepareGeometry(geometryElement({ shape: "cylinder", radius: 0.5, height: 2 }));
  assert.equal(a.meshToken, b.meshToken, "cylinder determinism");
  const metadata = await adapter.describeGeometryMetadata(a.meshToken);
  assert.ok(metadata !== null);
  assert.ok(
    Math.abs(metadata!.volume - Math.PI * 0.25 * 2) <= 1e-6,
    `cylinder volume ${metadata!.volume} ~= pi*r^2*h`,
  );
  // Axis override: cylinder along +X with BASE at (5,0,0) (OCCT gp_Ax2
  // semantics: the origin is the base center, height extends along the
  // direction) -> x in [5,7], y/z in [-0.5,0.5].
  const along = await adapter.prepareGeometry(
    geometryElement({ shape: "cylinder", radius: 0.5, height: 2, origin: [5, 0, 0], direction: [1, 0, 0] }),
  );
  assert.notEqual(a.meshToken, along.meshToken, "axis placement changes the geometry");
  along.bbox.forEach((value, i) => {
    const expected = [5, -0.5, -0.5, 7, 0.5, 0.5];
    assert.ok(Math.abs(value - expected[i]!) <= 0.01, `axis bbox[${i}] = ${value} ~ ${expected[i]}`);
  });
});

test("transform: translation and rotation move the bbox deterministically", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const plain = await adapter.prepareGeometry(geometryElement({ shape: "box", width: 1, depth: 2, height: 3 }));
  const translate10 = await adapter.prepareGeometry(
    geometryElement({
      shape: "transform",
      matrix: [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      target: { shape: "box", width: 1, depth: 2, height: 3 },
    }),
  );
  assert.notEqual(plain.meshToken, translate10.meshToken);
  translate10.bbox.forEach((value, i) => {
    const expected = [10, 0, 0, 11, 2, 3];
    assert.ok(Math.abs(value - expected[i]!) <= 0.01, `translated bbox[${i}] = ${value} ~ ${expected[i]}`);
  });
  // Rotation about Z by 90 degrees: (x, y) -> (-y, x); box [0,1]x[0,2]x[0,3]
  // becomes [-2,0]x[0,1]x[0,3].
  const rotate = await adapter.prepareGeometry(
    geometryElement({
      shape: "transform",
      matrix: [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      target: { shape: "box", width: 1, depth: 2, height: 3 },
    }),
  );
  rotate.bbox.forEach((value, i) => {
    const expected = [-2, 0, 0, 0, 1, 3];
    assert.ok(Math.abs(value - expected[i]!) <= 0.01, `rotated bbox[${i}] = ${value} ~ ${expected[i]}`);
  });
  // Uniform scale 2x (affine, gp_Trsf supports it).
  const scaled = await adapter.prepareGeometry(
    geometryElement({
      shape: "transform",
      matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
      target: { shape: "box", width: 1, depth: 2, height: 3 },
    }),
  );
  scaled.bbox.forEach((value, i) => {
    const expected = [0, 0, 0, 2, 4, 6];
    assert.ok(Math.abs(value - expected[i]!) <= 0.02, `scaled bbox[${i}] = ${value} ~ ${expected[i]}`);
  });
  const scaledMetadata = await adapter.describeGeometryMetadata(scaled.meshToken);
  assert.ok(Math.abs(scaledMetadata!.volume - 6 * 8) <= 1e-6, "uniform scale 2x multiplies volume by 8");
});

test("boolean fuse: disjoint volumes add; overlapping union is exact", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  // Disjoint: box at origin, cylinder at (5,0,0).
  const disjoint = await adapter.prepareGeometry(
    geometryElement({
      shape: "fuse",
      a: { shape: "box", width: 1, depth: 1, height: 1 },
      b: { shape: "cylinder", radius: 0.5, height: 1, origin: [5, 0, 0] },
    }),
  );
  const dMeta = await adapter.describeGeometryMetadata(disjoint.meshToken);
  assert.ok(
    Math.abs(dMeta!.volume - (1 + Math.PI * 0.25)) <= 1e-6,
    `disjoint fuse volume ${dMeta!.volume} ~= 1 + pi/4`,
  );
  // Overlapping: box(2,2,2) with cylinder axis (1,1) spanning z in [-0.5,1.5].
  // Inside-part pi*0.25*1.5; outside-part pi*0.25*0.5; union = 8 + outside.
  const overlap = await adapter.prepareGeometry(
    geometryElement({
      shape: "fuse",
      a: { shape: "box", width: 2, depth: 2, height: 2 },
      b: { shape: "cylinder", radius: 0.5, height: 2, origin: [1, 1, -0.5], direction: [0, 0, 1] },
    }),
  );
  const oMeta = await adapter.describeGeometryMetadata(overlap.meshToken);
  assert.ok(
    Math.abs(oMeta!.volume - (8 + Math.PI * 0.25 * 0.5)) <= 1e-4,
    `overlapping fuse volume ${oMeta!.volume} ~= 8 + pi*0.25*0.5`,
  );
  // Determinism of the composed recipe.
  const repeat = await adapter.prepareGeometry(
    geometryElement({
      shape: "fuse",
      a: { shape: "box", width: 2, depth: 2, height: 2 },
      b: { shape: "cylinder", radius: 0.5, height: 2, origin: [1, 1, -0.5], direction: [0, 0, 1] },
    }),
  );
  assert.equal(overlap.meshToken, repeat.meshToken, "boolean fuse determinism");
});

test("boolean cut: subtracts the intersection exactly", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const cut = await adapter.prepareGeometry(
    geometryElement({
      shape: "cut",
      a: { shape: "box", width: 2, depth: 2, height: 2 },
      b: { shape: "cylinder", radius: 0.5, height: 2, origin: [1, 1, -0.5], direction: [0, 0, 1] },
    }),
  );
  const meta = await adapter.describeGeometryMetadata(cut.meshToken);
  assert.ok(
    Math.abs(meta!.volume - (8 - Math.PI * 0.25 * 1.5)) <= 1e-4,
    `cut volume ${meta!.volume} ~= 8 - pi*0.25*1.5`,
  );
  // Nested composition: cut then translate — the full descriptor DAG.
  const cutMoved = await adapter.prepareGeometry(
    geometryElement({
      shape: "transform",
      matrix: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      target: {
        shape: "cut",
        a: { shape: "box", width: 2, depth: 2, height: 2 },
        b: { shape: "cylinder", radius: 0.5, height: 2, origin: [1, 1, -0.5], direction: [0, 0, 1] },
      },
    }),
  );
  const movedMeta = await adapter.describeGeometryMetadata(cutMoved.meshToken);
  assert.ok(Math.abs(movedMeta!.volume - meta!.volume) <= 1e-9, "rigid transform preserves volume");
  cutMoved.bbox.forEach((value, i) => {
    const expected = cut.bbox[i]! + (i === 0 || i === 3 ? 5 : 0);
    assert.ok(Math.abs(value - expected) <= 0.01, `translated cut bbox[${i}] tracks the source`);
  });
});

test("bundle wires geometry/bim/file with the shared kernel version", { skip: skipEngine }, async () => {
  const bundle = createOcctAdapterBundle();
  assert.equal(bundle.geometry.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(bundle.bim.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(bundle.file.adapterMark, ADAPTER_BOUNDARY_MARK);
  assert.equal(bundle.file.format, "offisos-occt");
  const result = await bundle.geometry.prepareGeometry(
    geometryElement({ shape: "box", width: 1, depth: 1, height: 1 }),
  );
  assert.ok(result.meshToken.startsWith("occt:"));
  // BIM passthrough (IfcOpenShell is a later slice — Issue #26 non-goal).
  const semantics = await bundle.bim.extractSemantics(
    geometryElement({ shape: "box", width: 1, depth: 1, height: 1, semantics: { storey: "L2" } }),
  );
  assert.deepEqual(semantics, { storey: "L2" });
  assert.equal(bundle.bim.engineVersion, bundle.geometry.engineVersion, "shared kernel provenance");
  // File adapter: canonical round-trip through the OCCT bundle format.
  const serialized = await bundle.file.write({
    version: {
      entity_id: "t", version_id: "t#v1(root)", version_number: 1, parent_version_id: null,
      created_at: "2026-01-01T00:00:00.000Z", created_by: "t", source_snapshot_id: null, status: "ACTIVE",
    },
    format: "offisos-occt",
    formatVersion: "1",
    sourceArtifactLineage: [],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements: [{ id: "e1", kind: "geometry", engineId: "occt", props: { meshToken: result.meshToken, bbox: [...result.bbox] } }],
  });
  const reopened = await bundle.file.read(serialized);
  assert.equal(reopened.elements.length, 1);
  assert.equal(reopened.elements[0]!.props.meshToken, result.meshToken);
});
