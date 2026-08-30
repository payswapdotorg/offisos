/**
 * CAD-PARITY-010 deterministic topology tests (Issue #93) — the engine-free
 * core (the canonical TopologyMap with canonical f/e/v ids, the structural
 * validation bounds, the exact ray-triangle/ray-segment/ray-point
 * primitives, the exactly-ordered sub-entity pick) and the App API surface
 * on the reference engine (the topology query, the per-element sub-entity
 * pick, the P009 global-pick decline preserved).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import {
  TopologyValidationError,
  buildTopologyMap,
  pickSubEntity,
  rayPointDistance,
  raySegmentDistance,
  rayTriangle,
} from "../src/workspace/model3d/index.js";
import type { TopologyGeometry, Vec3 } from "../src/contracts/geometry.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cp10-topology",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "cad-parity-010-tests",
};

function make(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}

async function q(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r as OkResult).value as T;
}

function errCode(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { code: string }).code;
}

/** A reference-engine box's raw topology (the adapter output shape). */
async function rawBoxTopology(): Promise<TopologyGeometry> {
  const adapter = createReferenceAdapterBundle().geometry;
  return (adapter as unknown as { describeTopology(d: unknown): Promise<TopologyGeometry> }).describeTopology({
    shape: "box",
    width: 4,
    depth: 4,
    height: 4,
  });
}

// ---------------------------------------------------------------------------
// The engine-free core.
// ---------------------------------------------------------------------------

test("buildTopologyMap: a box is 6/12/8 with canonical ids in canonical order", async () => {
  const raw = await rawBoxTopology();
  const map = buildTopologyMap("el-000001", raw);
  assert.equal(map.counts.faces, 6);
  assert.equal(map.counts.edges, 12);
  assert.equal(map.counts.vertices, 8);
  // Canonical ids are dense f0..f5 / e0..e11 / v0..v7.
  assert.deepEqual(map.faces.map((f) => f.canonicalId), ["f0", "f1", "f2", "f3", "f4", "f5"]);
  assert.deepEqual(map.edges.map((e) => e.canonicalId).slice(0, 3), ["e0", "e1", "e2"]);
  assert.deepEqual(map.vertices.map((v) => v.canonicalId).slice(0, 3), ["v0", "v1", "v2"]);
  // Every face carries the provenance engine key (never the identity).
  for (const f of map.faces) {
    assert.ok(f.engineKey.startsWith("ref-f:"));
    assert.equal(f.surfaceType, "plane");
    assert.equal(f.area, 16);
    assert.equal(f.vertices.length / 3, 4);
    assert.equal(f.indices.length / 3, 2);
  }
  // The 12 box edges are all lines of length 4 with line keys.
  for (const e of map.edges) {
    assert.ok(e.engineKey.startsWith("ref-e:"));
    assert.equal(e.curveType, "line");
    assert.equal(e.length, 4);
    assert.equal(e.points.length / 3, 2);
  }
});

test("buildTopologyMap: engine enumeration order is irrelevant (canonical re-sort)", async () => {
  const raw = await rawBoxTopology();
  const shuffled: TopologyGeometry = {
    ...raw,
    faces: [...raw.faces].reverse(),
    edges: [...raw.edges].reverse(),
    vertices: [...raw.vertices].reverse(),
  };
  const a = buildTopologyMap("el-x", raw);
  const b = buildTopologyMap("el-x", shuffled);
  assert.equal(createHash("sha256").update(JSON.stringify(a)).digest("hex"),
    createHash("sha256").update(JSON.stringify(b)).digest("hex"));
});

test("buildTopologyMap: structural validation declines typed", async () => {
  const raw = await rawBoxTopology();
  const badIndex: TopologyGeometry = {
    ...raw,
    faces: [{ ...raw.faces[0]!, indices: [0, 1, 99] }],
  };
  assert.throws(() => buildTopologyMap("el", badIndex), TopologyValidationError);
  const badCoord: TopologyGeometry = {
    ...raw,
    vertices: [{ point: [0, NaN, 0], engineKey: "k" }],
  };
  assert.throws(() => buildTopologyMap("el", badCoord), TopologyValidationError);
  const badCount: TopologyGeometry = { ...raw, faces: Array.from({ length: 513 }, (_, i) => ({ ...raw.faces[0]!, engineKey: `k${i}` })) };
  assert.throws(() => buildTopologyMap("el", badCount), TopologyValidationError);
});

test("rayTriangle: the Möller–Trumbore exact hit/miss", () => {
  const tri: readonly Vec3[] = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
  const hit = rayTriangle([0.5, 0.5, 5], [0, 0, -1], tri[0]!, tri[1]!, tri[2]!);
  assert.ok(hit !== null && Math.abs(hit - 5) < 1e-12);
  assert.equal(rayTriangle([-1, -1, 5], [0, 0, -1], tri[0]!, tri[1]!, tri[2]!), null);
  assert.equal(rayTriangle([0.5, 0.5, 5], [0, 0, 1], tri[0]!, tri[1]!, tri[2]!), null, "behind the ray");
  // Degenerate (zero-area) triangle declines.
  assert.equal(rayTriangle([0, 0, 5], [0, 0, -1], [0, 0, 0], [1, 1, 0], [2, 2, 0]), null);
});

test("raySegmentDistance: the clamped closest-approach distances", () => {
  // PERPENDICULAR segment ahead: the ray along +X, a segment crossing x=2
  // at y ∈ [1, 3] — the closest approach is (2,0,0)↔(2,1,0), distance 1.
  const perp = raySegmentDistance([0, 0, 0], [1, 0, 0], [2, 1, 0], [2, 3, 0]);
  assert.ok(perp !== null && Math.abs(perp.distance - 1) < 1e-12);
  assert.ok(Math.abs(perp.segPoint[0] - 2) < 1e-12 && Math.abs(perp.segPoint[1] - 1) < 1e-12);
  // PARALLEL segment ahead at y = 1: the uniform line distance is 1
  // (aligned at the segment start).
  const par = raySegmentDistance([0, 0, 0], [1, 0, 0], [2, 1, 0], [4, 1, 0]);
  assert.ok(par !== null && Math.abs(par.distance - 1) < 1e-12);
  assert.deepEqual([...par.segPoint], [2, 1, 0]);
  // A PARALLEL segment BEHIND the ray origin: the clamped solve pins s = 0
  // and the nearest endpoint (−1, 4) → distance √17.
  const behind = raySegmentDistance([0, 0, 0], [1, 0, 0], [-3, 4, 0], [-1, 4, 0]);
  assert.ok(behind !== null && Math.abs(behind.distance - Math.sqrt(17)) < 1e-12);
  assert.deepEqual([...behind.segPoint], [-1, 4, 0]);
  // A SKEW crossing segment: the ray passes through its midpoint — distance 0.
  const skew = raySegmentDistance([0, 0, 0], [1, 0, 0], [1, -1, 0], [1, 1, 0]);
  assert.ok(skew !== null && Math.abs(skew.distance) < 1e-12);
  // A degenerate (point) segment declines.
  assert.equal(raySegmentDistance([0, 0, 0], [1, 0, 0], [1, 1, 1], [1, 1, 1]), null);
});

test("rayPointDistance: the clamped ray-point distance", () => {
  const d = rayPointDistance([0, 0, 0], [1, 0, 0], [3, 4, 0]);
  assert.ok(Math.abs(d.distance - 4) < 1e-12);
  assert.deepEqual([...d.closest], [3, 0, 0]);
  // Behind the origin → the origin itself.
  const behind = rayPointDistance([0, 0, 0], [1, 0, 0], [-2, 3, 0]);
  assert.ok(Math.abs(behind.distance - Math.hypot(2, 3)) < 1e-12);
});

test("pickSubEntity: the exactly-ordered face pick (distance then canonical id)", async () => {
  const raw = await rawBoxTopology();
  const map = buildTopologyMap("el", raw);
  // A vertical ray through the box center: the top face (z=4) hits at t=16
  // from z=20, the bottom face (z=0) at t=20.
  const hits = pickSubEntity({ origin: [2, 2, 20], direction: [0, 0, -1] }, map, { filter: "face" });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.kind, "face");
  assert.ok(Math.abs(hits[0]!.distance - 16) < 1e-9);
  assert.deepEqual([...hits[0]!.point], [2, 2, 4]);
  assert.ok(Math.abs(hits[1]!.distance - 20) < 1e-9);
  // The ids are stable across calls (canonical).
  const again = pickSubEntity({ origin: [2, 2, 20], direction: [0, 0, -1] }, map, { filter: "face" });
  assert.equal(hits[0]!.canonicalId, again[0]!.canonicalId);
  console.log(`CP10 top face=${hits[0]!.canonicalId}`);
});

test("pickSubEntity: the edge/vertex tolerance picks with canonical ordering", async () => {
  const raw = await rawBoxTopology();
  const map = buildTopologyMap("el", raw);
  // A ray passing exactly through the +X edge (4,0,0)-(4,0,4) at (4,0,2).
  const edgeHits = pickSubEntity({ origin: [4, 3, 2], direction: [0, -1, 0] }, map, { filter: "edge", tolerance: 0.5 });
  assert.ok(edgeHits.length >= 1, "the grazed edge is within tolerance");
  assert.ok(edgeHits.every((h) => h.kind === "edge"));
  assert.ok(Math.abs(edgeHits[0]!.distance) < 1e-9, "the ray passes exactly through the edge");
  // A ray passing exactly over the corner vertex (0,0,0) from above.
  const vertexHits = pickSubEntity({ origin: [0, 0, 10], direction: [0, 0, -1] }, map, { filter: "vertex", tolerance: 0.5 });
  assert.ok(vertexHits.length >= 1);
  assert.equal(vertexHits[0]!.kind, "vertex");
  assert.deepEqual([...vertexHits[0]!.point], [0, 0, 0]);
  // A ray missing every vertex by more than the tolerance: nothing.
  const far = pickSubEntity({ origin: [1.7, 1.7, 10], direction: [0, 0, -1] }, map, { filter: "vertex", tolerance: 0.5 });
  assert.equal(far.length, 0, "no vertex within tolerance of (1.7,1.7)");
});

test("pickSubEntity: the unfiltered pick lists faces → edges → vertices", async () => {
  const raw = await rawBoxTopology();
  const map = buildTopologyMap("el", raw);
  const hits = pickSubEntity({ origin: [2, 2, 20], direction: [0, 0, -1] }, map, { tolerance: 1.0 });
  const kinds = hits.map((h) => h.kind);
  const firstEdge = kinds.indexOf("edge");
  const firstVertex = kinds.indexOf("vertex");
  assert.ok(kinds[0] === "face");
  if (firstEdge >= 0 && firstVertex >= 0) assert.ok(firstEdge < firstVertex);
});

// ---------------------------------------------------------------------------
// The App API surface on the reference engine.
// ---------------------------------------------------------------------------

test("model3d.topology: the deterministic map with the stable canonical hash", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const t = val<{ elementId: string; counts: { faces: number; edges: number; vertices: number }; hash: string; topology: unknown }>(
    await q(h, "model3d.topology", { elementId: box.elementId }),
  );
  assert.deepEqual(t.counts, { faces: 6, edges: 12, vertices: 8 });
  const again = val<{ hash: string }>(await q(h, "model3d.topology", { elementId: box.elementId }));
  assert.equal(again.hash, t.hash);
  console.log(`CP10 topology hash=${t.hash.slice(0, 16)}`);
});

test("model3d.topology: declines for unknown/non-solid elements; out-of-class solids decline typed", async () => {
  const h = make();
  assert.equal(errCode(await q(h, "model3d.topology", { elementId: "el-999999" })), "bad_id");
  assert.equal(errCode(await q(h, "model3d.topology", {})), "bad_payload");
  await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] });
  assert.equal(errCode(await q(h, "model3d.topology", { elementId: "el-000001" })), "topology_unsupported");
  // A cylinder is outside the reference cell class → the typed decline.
  await cmd(h, "model3d.cylinder", { radius: 1, height: 2 });
  const r = await q(h, "model3d.topology", { elementId: "el-000002" });
  assert.equal((r as { code: string }).code, "topology_unsupported");
});

test("model3d.pick sub-entity: the per-element face pick through the projected screen point", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  await cmd(h, "view3d.standard", { view: "top", aspect: 1.6 });
  const { projectPoint } = await import("../src/workspace/model3d/index.js");
  const vs = val<{ camera: unknown }>(await q(h, "view3d.state", {}));
  const vp = { width: 800, height: 600 };
  const pr = projectPoint(vs.camera as never, vp, [2, 2, 4]);
  assert.ok(pr !== null, "the top-view camera projects the face point");
  const pick = val<{ elementId: string; count: number; hits: readonly { kind: string; canonicalId: string; point: Vec3 }[]; topologyCounts: unknown }>(
    await q(h, "model3d.pick", { elementId: box.elementId, subEntityKind: "face", screenX: pr.x, screenY: pr.y, viewport: vp }),
  );
  assert.equal(pick.elementId, box.elementId);
  assert.ok(pick.count >= 1);
  assert.equal(pick.hits[0]!.kind, "face");
  assert.deepEqual([...pick.hits[0]!.point], [2, 2, 4]);
  // The P009 global pick still works element-granularity (unchanged surface).
  const global = val<{ count: number }>(await q(h, "model3d.pick", { screenX: pr.x, screenY: pr.y, viewport: vp }));
  assert.ok(global.count >= 1);
});

test("model3d.pick: the P009 subEntity decline preserved; the strict payload rules", async () => {
  const h = make();
  await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 });
  // subEntity WITHOUT elementId — the P009 decline, byte-identical code.
  const decline = await q(h, "model3d.pick", { screenX: 400, screenY: 300, viewport: { width: 800, height: 600 }, subEntity: true });
  assert.equal((decline as { code: string }).code, "subentity_unsupported");
  // elementId WITHOUT subEntity — the strict bad_payload.
  const strict = await q(h, "model3d.pick", { screenX: 400, screenY: 300, viewport: { width: 800, height: 600 }, elementId: "el-000001" });
  assert.equal((strict as { code: string }).code, "bad_payload");
  // An invalid kind declines.
  const badKind = await q(h, "model3d.pick", { elementId: "el-000001", subEntityKind: "solid", screenX: 400, screenY: 300, viewport: { width: 800, height: 600 } });
  assert.equal((badKind as { code: string }).code, "bad_payload");
  // A sub-entity pick of an out-of-class solid declines topology_unsupported.
  await cmd(h, "model3d.cylinder", { radius: 1, height: 2 });
  const r = await q(h, "model3d.pick", { elementId: "el-000002", subEntity: true, screenX: 400, screenY: 300, viewport: { width: 800, height: 600 } });
  assert.equal((r as { code: string }).code, "topology_unsupported");
});

test("PARITY ANCHOR: the topology pick stream twice is byte-identical", async () => {
  const run = async (): Promise<string> => {
    const h = make();
    const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
    await cmd(h, "view3d.standard", { view: "iso", aspect: 1.6 });
    const t = val<{ hash: string }>(await q(h, "model3d.topology", { elementId: box.elementId }));
    const pick = val<{ hits: readonly { canonicalId: string; distance: number }[] }>(
      await q(h, "model3d.pick", { elementId: box.elementId, subEntityKind: "face", screenX: 400, screenY: 300, viewport: { width: 800, height: 600 } }),
    );
    return createHash("sha256").update(t.hash + JSON.stringify(pick.hits.map((x) => [x.canonicalId, x.distance]))).digest("hex");
  };
  assert.equal(await run(), await run());
});
