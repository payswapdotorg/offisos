/**
 * CAD-PARITY-010 deterministic mesh-entity + bounded-cache tests (Issue #93)
 * — the engine-free core (the closed quality-preset vocabulary, the payload
 * validation, the bounded LRU cache with dual budgets and exact counters)
 * and the App API surface on the reference engine (model3d.tessellate, the
 * LOD mesh query with cache hits, cacheStats budgets, invalidation on
 * modeling edits, and the mesh-entity persistence round-trip).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import {
  MESH_ENTITY_MAX_TRIANGLES,
  MESH_ENTITY_MAX_VERTICES,
  MESH_QUALITY_PRESETS,
  TessellationCache,
  buildMeshEntityProps,
  descriptorCacheKey,
  meshQualityKnobs,
  parseMeshQuality,
  validateMeshEntityProps,
  validateMeshPayload,
} from "../src/workspace/model3d/index.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cp10-mesh",
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

// ---------------------------------------------------------------------------
// The engine-free core: quality presets + payload validation.
// ---------------------------------------------------------------------------

test("the quality presets are the closed vocabulary; full matches the prepare defaults", () => {
  assert.deepEqual(parseMeshQuality("low"), "low");
  assert.deepEqual(parseMeshQuality("medium"), "medium");
  assert.deepEqual(parseMeshQuality("full"), "full");
  assert.equal(parseMeshQuality("ultra"), null);
  assert.equal(parseMeshQuality(""), null);
  assert.deepEqual(meshQualityKnobs("full"), { linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(meshQualityKnobs("low"), MESH_QUALITY_PRESETS.low);
  assert.deepEqual(meshQualityKnobs("medium"), MESH_QUALITY_PRESETS.medium);
});

test("validateMeshPayload: structure, bounds and index ranges", () => {
  assert.equal(validateMeshPayload([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]), null);
  assert.match(validateMeshPayload([0, 0], [0, 1, 2])!, /flat x,y,z/);
  assert.match(validateMeshPayload([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1])!, /flat a,b,c/);
  assert.match(validateMeshPayload([0, 0, 0], [0, 1, 2])!, /within the vertex range/, "a single vertex cannot carry 3 indices");
  assert.match(validateMeshPayload([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 3])!, /within the vertex range/);
  assert.match(validateMeshPayload([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -1])!, /within the vertex range/);
  assert.match(validateMeshPayload([0, 0, NaN, 1, 0, 0, 0, 1, 0], [0, 1, 2])!, /non-finite/);
  const huge: number[] = [];
  for (let i = 0; i <= MESH_ENTITY_MAX_VERTICES; i++) huge.push(i, i, i);
  assert.match(validateMeshPayload(huge, [0, 1, 2])!, /vertex entity bound/);
});

test("buildMeshEntityProps: the persisted props with consistent counts", () => {
  const built = buildMeshEntityProps({
    sourceElementId: "el-000001",
    sourceMeshToken: "ref:abc",
    quality: "medium",
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    engine: { engineId: "reference", engineVersion: "1.1.0" },
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.props.type, "model3d.mesh");
  assert.equal(built.props.quality, "medium");
  assert.equal(built.props.vertexCount, 3);
  assert.equal(built.props.triangleCount, 1);
  assert.equal(validateMeshEntityProps(built.props), null);
  // Inconsistent persisted counts decline at open time.
  assert.match(
    validateMeshEntityProps({ ...built.props, vertexCount: 5 } as never)!,
    /inconsistent/,
  );
  assert.match(validateMeshEntityProps({ type: "model3d.mesh" } as never)!, /sourceElementId/);
  assert.match(
    validateMeshEntityProps({ ...built.props, quality: "ultra" } as never)!,
    /quality must be one of/,
  );
});

// ---------------------------------------------------------------------------
// The engine-free core: the bounded cache.
// ---------------------------------------------------------------------------

test("the cache key ties to the canonical descriptor + quality", () => {
  const box = { shape: "box", width: 1, depth: 1, height: 1 } as const;
  const moved = { shape: "transform", matrix: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], target: box } as const;
  assert.notEqual(TessellationCache.key(box, "low"), TessellationCache.key(box, "full"));
  assert.notEqual(TessellationCache.key(box, "low"), TessellationCache.key(moved, "low"));
  // The key basis is a deterministic injective encoding.
  assert.equal(descriptorCacheKey(box), descriptorCacheKey({ depth: 1, height: 1, shape: "box", width: 1 } as never));
});

test("the bounded LRU cache: hits/misses/evictions + the entry budget", () => {
  const cache = new TessellationCache(3, 1_000_000);
  const entry = (n: number) => ({
    mesh: { vertices: new Array(n * 3).fill(1), indices: [0, 1, 2] },
    meshToken: `t${n}`,
    vertices: n,
    triangles: 1,
  });
  cache.set("a", entry(1));
  cache.set("b", entry(1));
  cache.set("c", entry(1));
  assert.deepEqual(cache.stats(), { capacity: 3, vertexBudget: 1_000_000, entries: 3, cachedVertices: 3, hits: 0, misses: 0, evictions: 0 });
  // Touch a (LRU order: a newest, b oldest now).
  assert.ok(cache.get("a") !== null);
  assert.equal(cache.stats().hits, 1);
  // Insert d → evicts b (the least recently used).
  cache.set("d", entry(1));
  assert.equal(cache.stats().evictions, 1);
  assert.ok(cache.get("b") === null);
  assert.equal(cache.stats().misses, 1);
  assert.ok(cache.get("a") !== null);
  assert.ok(cache.get("c") !== null);
  assert.ok(cache.get("d") !== null);
});

test("the bounded cache: the VERTEX budget evicts LRU; oversized entries are refused", () => {
  const cache = new TessellationCache(10, 10);
  const entry = (n: number, token: string) => ({ mesh: { vertices: new Array(n * 3).fill(1), indices: [] }, meshToken: token, vertices: n, triangles: 0 });
  cache.set("a", entry(6, "a"));
  cache.set("b", entry(6, "b"));
  // 12 > 10 vertices → the oldest (a) is evicted.
  assert.equal(cache.stats().cachedVertices, 6);
  assert.equal(cache.stats().evictions, 1);
  assert.ok(cache.get("b") !== null);
  assert.ok(cache.get("a") === null);
  // An entry larger than the whole budget is refused (counted as an
  // eviction, never silently unbounded).
  cache.set("huge", entry(11, "huge"));
  assert.ok(cache.get("huge") === null);
  assert.ok(cache.get("b") !== null, "the budget is not flushed for the refused entry");
});

test("the cache invalidation is descriptor-tied (all quality presets)", () => {
  const cache = new TessellationCache();
  const box = { shape: "box", width: 1, depth: 1, height: 1 } as const;
  const entry = { mesh: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }, meshToken: "t", vertices: 3, triangles: 1 };
  cache.set(TessellationCache.key(box, "low"), entry);
  cache.set(TessellationCache.key(box, "full"), entry);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.invalidateDescriptor(box as never), 2);
  assert.equal(cache.stats().entries, 0);
});

// ---------------------------------------------------------------------------
// The App API surface on the reference engine.
// ---------------------------------------------------------------------------

test("model3d.tessellate: the persisted mesh entity with deterministic serialization", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const t = val<{ elementId: string; sourceElementId: string; quality: string; vertexCount: number; triangleCount: number; knobs: unknown }>(
    await cmd(h, "model3d.tessellate", { elementId: box.elementId, quality: "low" }),
  );
  assert.equal(t.sourceElementId, box.elementId);
  assert.equal(t.quality, "low");
  // The reference box mesh: 8 vertices / 12 triangles.
  assert.equal(t.vertexCount, 8);
  assert.equal(t.triangleCount, 12);
  assert.deepEqual(t.knobs, meshQualityKnobs("low"));
  // The entity is a document element with the validated persisted props.
  const snap = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h, "document.getState", {}));
  const entity = snap.elements.find((e) => e.id === t.elementId)!;
  assert.equal(entity.props.type, "model3d.mesh");
  assert.equal(validateMeshEntityProps(entity.props), null);
  // The save/open round-trip preserves the mesh entity byte-identically.
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const h2 = make();
  await cmd(h2, "document.open", { source: Array.from(saved.bytes) });
  const snap2 = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h2, "document.getState", {}));
  const entity2 = snap2.elements.find((e) => e.id === t.elementId)!;
  assert.deepEqual(entity2.props, entity.props);
});

test("model3d.tessellate: declines for non-solids, unknown ids and bad quality", async () => {
  const h = make();
  assert.equal(errCode(await cmd(h, "model3d.tessellate", {})), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.tessellate", { elementId: "el-999999" })), "bad_id");
  await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] });
  assert.equal(errCode(await cmd(h, "model3d.tessellate", { elementId: "el-000001" })), "not_a_solid");
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1 }));
  assert.equal(errCode(await cmd(h, "model3d.tessellate", { elementId: box.elementId, quality: "ultra" })), "bad_payload");
});

test("model3d.mesh with quality: the LOD path through the cache (hit/miss evidence)", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const first = val<{ quality: string; vertices: number; meshToken: string; withinBudget: boolean }>(
    await q(h, "model3d.mesh", { elementId: box.elementId, quality: "full" }),
  );
  assert.equal(first.quality, "full");
  assert.equal(first.vertices, 8);
  assert.equal(first.withinBudget, true);
  const stats1 = val<{ cache: { hits: number; misses: number; entries: number } }>(await q(h, "model3d.cacheStats", {}));
  assert.ok(stats1.cache.misses >= 1, "the first LOD fetch is a miss");
  assert.equal(stats1.cache.entries, 1);
  const second = val<{ meshToken: string }>(await q(h, "model3d.mesh", { elementId: box.elementId, quality: "full" }));
  const stats2 = val<{ cache: { hits: number; misses: number } }>(await q(h, "model3d.cacheStats", {}));
  assert.ok(stats2.cache.hits === stats1.cache.hits + 1, "the second fetch hits the cache");
  assert.equal(second.meshToken, first.meshToken, "the cached token is identical");
  // The P009 token path (no quality) still works unchanged.
  const legacy = val<{ mesh: { vertices: readonly number[] } | null; meshAvailable: boolean }>(
    await q(h, "model3d.mesh", { elementId: box.elementId }),
  );
  assert.equal(legacy.meshAvailable, true);
  assert.equal(legacy.mesh!.vertices.length / 3, 8);
});

test("model3d.mesh with quality: declines for non-solids and bad quality", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1 }));
  assert.equal(errCode(await q(h, "model3d.mesh", { elementId: box.elementId, quality: "high" })), "bad_payload");
  await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] });
  assert.equal(errCode(await q(h, "model3d.mesh", { elementId: "el-000002", quality: "low" })), "not_a_solid");
});

test("cacheStats: the documented budgets (the deterministic performance evidence)", async () => {
  const h = make();
  const s = val<{ cache: { capacity: number; vertexBudget: number }; budgets: Record<string, unknown> }>(await q(h, "model3d.cacheStats", {}));
  assert.equal(s.cache.capacity, 128);
  assert.equal(s.cache.vertexBudget, 1_500_000);
  assert.deepEqual(s.budgets, {
    maxCacheEntries: 128,
    maxCachedVertices: 1_500_000,
    meshLodMaxVertices: 150_000,
    meshEntityMaxVertices: 150_000,
    topologyBounds: { faces: 512, edges: 1024, vertices: 1024 },
    sectionMaxPoints: 8192,
  });
});

test("the LOD cache invalidates when a modeling edit changes the geometry", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  await q(h, "model3d.mesh", { elementId: box.elementId, quality: "full" });
  let stats = val<{ cache: { entries: number } }>(await q(h, "model3d.cacheStats", {}));
  assert.equal(stats.cache.entries, 1);
  // A modeling edit changes the element's canonical descriptor → the stale
  // entry is dropped eagerly (invalidation tied to the geometry state).
  await cmd(h, "model3d.move", { elementId: box.elementId, delta: [5, 0, 0] });
  stats = val<{ cache: { entries: number } }>(await q(h, "model3d.cacheStats", {}));
  assert.equal(stats.cache.entries, 0);
  // The new geometry misses (a different canonical key).
  await q(h, "model3d.mesh", { elementId: box.elementId, quality: "full" });
  stats = val<{ cache: { entries: number; misses: number } }>(await q(h, "model3d.cacheStats", {}));
  assert.equal(stats.cache.entries, 1);
});

test("PARITY ANCHOR: the tessellation stream twice is byte-identical", async () => {
  const run = async (): Promise<string> => {
    const h = make();
    const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
    const t = val<{ elementId: string }>(await cmd(h, "model3d.tessellate", { elementId: box.elementId, quality: "medium" }));
    const mesh = val<{ meshToken: string; vertices: number }>(await q(h, "model3d.mesh", { elementId: box.elementId, quality: "medium" }));
    const snap = val<unknown>(await q(h, "document.getState", {}));
    return createHash("sha256")
      .update(t.elementId + mesh.meshToken + mesh.vertices + JSON.stringify(snap))
      .digest("hex");
  };
  assert.equal(await run(), await run());
});
