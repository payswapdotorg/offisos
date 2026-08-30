/**
 * CAD-PARITY-010 — the P010 capabilities realized through the REAL OCCT
 * engine (Issue #93; engine-gated like every real-engine test — skips with
 * a recorded reason when OCP is not importable).
 *
 * Covers the acceptance criteria that specifically require the real kernel:
 *  - the intersect boolean (BRepAlgoAPI_Common) with exact volumes/bboxes
 *    and the typed engine_empty_result for disjoint operands;
 *  - the exact section op (BRepAlgoAPI_Section): the box square loop and
 *    the cylinder ellipse arc with every sampled point at exact radius;
 *  - the topology op: box 6/12/8 and cylinder 3/3/2 inventories with exact
 *    areas/lengths, deterministic across processes;
 *  - the quality meshes: the LOD presets produce distinct vertex counts
 *    (progressive delivery), full == the prepare default;
 *  - the CROSS-ENGINE canonical agreement: the shared core canonicalizes
 *    the reference engine's and OCCT's raw output IDENTICALLY (the same
 *    section loops and the same canonical topology ids for the same
 *    geometry — the LOCK-004 parity evidence at the engine boundary).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcctGeometryAdapter } from "../src/adapters/occt/index.js";
import { createReferenceGeometryAdapter } from "../src/adapters/reference/index.js";
import { engineSkip } from "./engine-availability.js";
import {
  buildSectionExact,
  buildTopologyMap,
  validateSectionGeometry,
} from "../src/workspace/model3d/index.js";
import type { GeometryDescriptor, Vec3 } from "../src/contracts/geometry.js";

const skipEngine = await engineSkip();

const BOX: GeometryDescriptor = { shape: "box", width: 4, depth: 4, height: 4 };
const MOVED_BOX: GeometryDescriptor = {
  shape: "transform",
  matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  target: BOX,
};
const DISJOINT_BOX: GeometryDescriptor = {
  shape: "transform",
  matrix: [1, 0, 0, 50, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  target: BOX,
};

test("OCCT intersect: the exact common volume and bbox", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const result = await adapter.prepareGeometry({
    id: "p010",
    kind: "geometry",
    engineId: null,
    props: { shape: "intersect", a: BOX, b: MOVED_BOX } as Record<string, unknown>,
  });
  assert.ok(result.meshToken.startsWith("occt:"));
  // 4×4×4 ∩ (the same box at x+2) = 2×4×4 → bbox [2..4]×[0..4]×[0..4]
  // within the declared OCCT tolerance (~1e-7 for primitives).
  for (let i = 0; i < 6; i++) {
    const expected = [2, 0, 0, 4, 4, 4][i]!;
    assert.ok(Math.abs(result.bbox[i]! - expected) < 1e-6, `bbox[${i}] ${result.bbox[i]} ≈ ${expected}`);
  }
  const metadata = await adapter.describeGeometryMetadata(result.meshToken);
  assert.ok(metadata !== null);
  assert.ok(Math.abs(metadata.volume - 32) < 1e-6, `volume ${metadata.volume} ≈ 32`);
});

test("OCCT intersect: disjoint operands decline typed engine_empty_result", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  await assert.rejects(
    () =>
      adapter.prepareGeometry({
        id: "p010",
        kind: "geometry",
        engineId: null,
        props: { shape: "intersect", a: BOX, b: DISJOINT_BOX } as Record<string, unknown>,
      }),
    (e: unknown) => {
      assert.ok((e as { code?: string }).code === "engine_empty_result");
      return true;
    },
  );
});

test("OCCT intersect determinism: identical descriptors produce identical meshTokens", { skip: skipEngine }, async () => {
  const run = async (): Promise<string> => {
    const adapter = createOcctGeometryAdapter();
    const result = await adapter.prepareGeometry({
      id: "p010",
      kind: "geometry",
      engineId: null,
      props: { shape: "intersect", a: BOX, b: MOVED_BOX } as Record<string, unknown>,
    });
    return result.meshToken;
  };
  assert.equal(await run(), await run());
});

test("OCCT section: the box square loop with exact corners", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const plane = { origin: [0, 0, 2] as Vec3, normal: [0, 0, 1] as Vec3 };
  const raw = await adapter.computeSection(BOX, plane);
  validateSectionGeometry(plane, raw);
  const ir = buildSectionExact(
    { id: "sp", name: "S", origin: plane.origin, normal: plane.normal, createdAt: "" },
    [{ id: "el", raw }],
  );
  assert.equal(ir.facets.length, 1);
  assert.equal(ir.facets[0]!.loops.length, 1);
  assert.equal(ir.facets[0]!.chains.length, 0);
  assert.deepEqual(ir.facets[0]!.loops[0], [
    [0, 0, 2],
    [4, 0, 2],
    [4, 4, 2],
    [0, 4, 2],
  ]);
});

test("OCCT section: the cylinder ellipse — every point at exact radius 2", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const plane = { origin: [0, 0, 1] as Vec3, normal: [0, 0, 1] as Vec3 };
  const raw = await adapter.computeSection({ shape: "cylinder", radius: 2, height: 2 }, plane);
  validateSectionGeometry(plane, raw);
  assert.ok(raw.polylines.length >= 1);
  let points = 0;
  for (const polyline of raw.polylines) {
    const pts = polyline.points;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      points += 1;
      assert.ok(Math.abs(Math.hypot(x, y) - 2) < 1e-9, `radius at (${x},${y}) ≈ 2`);
      assert.ok(Math.abs(pts[i + 2]! - 1) < 1e-9, "z ≈ 1");
    }
  }
  assert.ok(points >= 8, `a sampled ellipse (${points} points), not a coarse polygon`);
});

test("OCCT section: a plane missing the solid yields the empty exact result", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const raw = await adapter.computeSection(BOX, { origin: [0, 0, 50], normal: [0, 0, 1] });
  assert.equal(raw.polylines.length, 0);
});

test("OCCT topology: the box 6/12/8 inventory with exact areas", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const raw = await adapter.describeTopology(BOX);
  const map = buildTopologyMap("el", raw);
  assert.deepEqual(map.counts, { faces: 6, edges: 12, vertices: 8 });
  for (const face of map.faces) {
    assert.equal(face.surfaceType, "plane");
    assert.ok(Math.abs(face.area - 16) < 1e-6, `face area ${face.area} ≈ 16`);
    assert.equal(face.vertices.length / 3, 4, "a planar box face triangulates to 4 nodes");
    assert.equal(face.indices.length / 3, 2);
    assert.ok(face.engineKey.startsWith("occt-f:"));
  }
  for (const edge of map.edges) {
    assert.equal(edge.curveType, "line");
    assert.ok(Math.abs(edge.length - 4) < 1e-6);
    assert.ok(edge.engineKey.startsWith("occt-e:"));
  }
  assert.deepEqual(
    map.vertices.map((v) => v.canonicalId),
    ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"],
  );
});

test("OCCT topology: the cylinder 3/3/2 inventory with exact areas and lengths", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const raw = await adapter.describeTopology({ shape: "cylinder", radius: 2, height: 2 });
  const map = buildTopologyMap("el", raw);
  assert.deepEqual(map.counts, { faces: 3, edges: 3, vertices: 2 });
  const lateral = map.faces.find((f) => f.surfaceType === "cylinder")!;
  assert.ok(lateral !== undefined);
  assert.ok(Math.abs(lateral.area - 2 * Math.PI * 2 * 2) < 1e-6, `lateral area ${lateral.area} ≈ 8π`);
  const caps = map.faces.filter((f) => f.surfaceType === "plane");
  assert.equal(caps.length, 2);
  for (const cap of caps) assert.ok(Math.abs(cap.area - Math.PI * 4) < 1e-6, `cap area ${cap.area} ≈ 4π`);
  for (const edge of map.edges) {
    if (edge.curveType === "circle") {
      assert.ok(Math.abs(edge.length - 4 * Math.PI) < 1e-6, `circle length ${edge.length} ≈ 4π`);
      assert.ok(edge.points.length / 3 >= 8, "the circle is sampled, not a 2-point chord");
    } else {
      assert.equal(edge.curveType, "line");
      assert.ok(Math.abs(edge.length - 2) < 1e-6, "the seam line has length 2");
    }
  }
});

test("OCCT quality meshes: the LOD presets deliver progressively", { skip: skipEngine }, async () => {
  const adapter = createOcctGeometryAdapter();
  const cylinder: GeometryDescriptor = { shape: "cylinder", radius: 2, height: 2 };
  const low = await adapter.prepareMeshAtQuality(cylinder, "low");
  const medium = await adapter.prepareMeshAtQuality(cylinder, "medium");
  const full = await adapter.prepareMeshAtQuality(cylinder, "full");
  // Coarser presets produce strictly fewer vertices (progressive delivery).
  assert.ok(low.metadata.vertices < full.metadata.vertices, `low ${low.metadata.vertices} < full ${full.metadata.vertices}`);
  assert.ok(medium.metadata.vertices <= full.metadata.vertices);
  // `full` matches the default prepare tessellation exactly.
  const prepared = await adapter.prepareGeometry({
    id: "p010",
    kind: "geometry",
    engineId: null,
    props: cylinder as Record<string, unknown>,
  });
  assert.equal(full.meshToken, prepared.meshToken, "the full preset == the prepare default");
  // Every preset is within the LOD bound.
  assert.ok(full.metadata.vertices <= 150_000);
});

test("CROSS-ENGINE: the shared core canonicalizes both engines' sections IDENTICALLY", { skip: skipEngine }, async () => {
  const occt = createOcctGeometryAdapter();
  const reference = createReferenceGeometryAdapter();
  const plane = { origin: [0, 0, 2] as Vec3, normal: [0, 0, 1] as Vec3 };
  const rawOcct = await occt.computeSection(BOX, plane);
  const rawRef = await reference.computeSection(BOX, plane);
  const mk = (raw: typeof rawOcct) =>
    buildSectionExact(
      { id: "sp", name: "S", origin: plane.origin, normal: plane.normal, createdAt: "" },
      [{ id: "el", raw }],
    );
  const irOcct = mk(rawOcct);
  const irRef = mk(rawRef);
  assert.deepEqual(irRef.facets[0]!.loops, irOcct.facets[0]!.loops);
  assert.equal(irRef.facets[0]!.chains.length, irOcct.facets[0]!.chains.length);
});

test("CROSS-ENGINE: the canonical topology ids agree for the same geometry", { skip: skipEngine }, async () => {
  const occt = createOcctGeometryAdapter();
  const reference = createReferenceGeometryAdapter();
  const topoOcct = buildTopologyMap("el", await occt.describeTopology(BOX));
  const topoRef = buildTopologyMap("el", await reference.describeTopology(BOX));
  assert.equal(topoOcct.counts.faces, topoRef.counts.faces);
  // The canonical ids map to the SAME geometry (area + centroid) in both
  // engines — the document-owned canonical identity is engine-independent.
  const summarize = (m: typeof topoOcct) =>
    m.faces.map((f) => `${f.canonicalId}:${f.surfaceType}:${f.area.toFixed(6)}@${f.centroid.map((c) => +c.toFixed(6)).join(",")}`).join("|");
  assert.equal(summarize(topoOcct), summarize(topoRef));
  const edges = (m: typeof topoOcct) => m.edges.map((e) => `${e.canonicalId}:${e.length.toFixed(6)}`).join(",");
  assert.equal(edges(topoOcct), edges(topoRef));
  const verts = (m: typeof topoOcct) => m.vertices.map((v) => `${v.canonicalId}:${v.point.map((c) => +c.toFixed(6)).join(",")}`).join(",");
  assert.equal(verts(topoOcct), verts(topoRef));
});

test("CROSS-ENGINE: the boolean result volumes agree (reference cells vs OCCT BRep)", { skip: skipEngine }, async () => {
  const occt = createOcctGeometryAdapter();
  const reference = createReferenceGeometryAdapter();
  const element = (props: Record<string, unknown>) => ({ id: "x", kind: "geometry" as const, engineId: null, props });
  const intersect = { shape: "intersect", a: BOX, b: MOVED_BOX } as Record<string, unknown>;
  const viaOcct = await occt.prepareGeometry(element(intersect));
  const viaRef = await reference.prepareGeometry(element(intersect));
  const metaOcct = await occt.describeGeometryMetadata(viaOcct.meshToken);
  const metaRef = await reference.describeGeometryMetadata(viaRef.meshToken);
  assert.ok(metaOcct !== null && metaRef !== null);
  assert.ok(Math.abs(metaOcct.volume - metaRef.volume) < 1e-6, `OCCT ${metaOcct.volume} ≈ reference ${metaRef.volume} ≈ 32`);
});
