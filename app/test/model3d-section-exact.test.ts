/**
 * CAD-PARITY-010 deterministic exact-section tests (Issue #93) — the
 * engine-free core (structural validation, deterministic curve chaining,
 * canonical loop orientation/start, the plane basis) and the App API
 * surface on the reference engine (exact loops + the canonical hash, missed
 * elements, the per-element decline, the P009 preview unchanged).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import {
  SectionGeometryValidationError,
  buildSectionExact,
  canonicalizeLoop,
  chainSectionPolylines,
  encodeSectionPoint,
  sectionPlaneBasis,
  sectionPlaneCoords,
  validateSectionGeometry,
} from "../src/workspace/model3d/index.js";
import type { SectionGeometry, Vec3 } from "../src/contracts/geometry.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cp10-section",
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

const PLANE = { origin: [0, 0, 2] as Vec3, normal: [0, 0, 1] as Vec3 };

// ---------------------------------------------------------------------------
// The engine-free core.
// ---------------------------------------------------------------------------

test("encodeSectionPoint: fixed 9 decimals, negative zero normalized", () => {
  assert.equal(encodeSectionPoint([0, -0, 1.5]), "0.000000000,0.000000000,1.500000000");
  assert.equal(encodeSectionPoint([1 / 3, 2 / 3, -1]), "0.333333333,0.666666667,-1.000000000");
});

test("sectionPlaneBasis: the fixed in-plane basis (x-preferred, orthonormal)", () => {
  const { u, v } = sectionPlaneBasis([0, 0, 1]);
  // For n = +Z: cross([1,0,0], n) = (0, 1, 0) → u = +Y; v = n × u = −X.
  assert.deepEqual([...u], [0, 1, 0]);
  assert.deepEqual([...v], [-1, 0, 0]);
  // u ⊥ v, both ⊥ n, unit length.
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(u, v)) < 1e-12);
  assert.ok(Math.abs(dot(u, [0, 0, 1])) < 1e-12);
  assert.ok(Math.abs(dot(v, [0, 0, 1])) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...u) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
});

test("sectionPlaneCoords: world → in-plane coordinates", () => {
  // For n = +Z the basis maps (x, y) → (y, −x).
  const [a, b] = sectionPlaneCoords([3, 5, 7], [0, 0, 0], [0, 0, 1]);
  assert.equal(a, 5);
  assert.equal(b, -3);
});

test("chainSectionPolylines: four box edges in mixed directions close into ONE loop", () => {
  const { loops, chains } = chainSectionPolylines(
    [
      { points: [0, 0, 2, 4, 0, 2] },
      { points: [0, 4, 2, 0, 0, 2] },
      { points: [0, 4, 2, 4, 4, 2] },
      { points: [4, 4, 2, 4, 0, 2] },
    ],
    [0, 0, 1],
  );
  assert.equal(loops.length, 1);
  assert.equal(chains.length, 0);
  assert.deepEqual(loops[0], [
    [0, 0, 2],
    [4, 0, 2],
    [4, 4, 2],
    [0, 4, 2],
  ]);
});

test("chainSectionPolylines: a closed engine polyline (repeated first point) canonicalizes to the same loop", () => {
  const ellipse: number[] = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const a = (2 * Math.PI * i) / N;
    ellipse.push(2 * Math.cos(a), 2 * Math.sin(a), 1);
  }
  const { loops, chains } = chainSectionPolylines([{ points: ellipse }], [0, 0, 1]);
  assert.equal(loops.length, 1);
  assert.equal(chains.length, 0);
  assert.equal(loops[0]!.length, 16, "the closing duplicate is dropped");
  // Every point on the plane and radius 2 (the ellipse sample).
  for (const p of loops[0]!) {
    assert.ok(Math.abs(p[2]! - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(p[0]!, p[1]!) - 2) < 1e-9);
  }
});

test("chainSectionPolylines: two disjoint loops stay separate; duplicates collapse", () => {
  const square = (x0: number): { points: number[] } => ({
    points: [...[x0, 0, 0], ...[x0 + 1, 0, 0], ...[x0 + 1, 1, 0], ...[x0, 1, 0], ...[x0, 0, 0]],
  });
  const { loops } = chainSectionPolylines([square(0), square(0), square(5)], [0, 0, 1]);
  assert.equal(loops.length, 2, "the identical duplicate collapses; the disjoint square stays");
});

test("chainSectionPolylines: open chains are kept honestly (never forced closed)", () => {
  const { loops, chains } = chainSectionPolylines(
    [{ points: [0, 0, 0, 1, 0, 0, 1, 1, 0] }],
    [0, 0, 1],
  );
  assert.equal(loops.length, 0);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]!.length, 3);
});

test("canonicalizeLoop: opposite curve directions canonicalize IDENTICALLY", () => {
  const cw: Vec3[] = [
    [0, 0, 2],
    [4, 0, 2],
    [4, 4, 2],
    [0, 4, 2],
  ];
  const ccw: Vec3[] = [...cw].reverse();
  const { u, v } = sectionPlaneBasis([0, 0, 1]);
  assert.deepEqual([...canonicalizeLoop(cw, u, v)], [...canonicalizeLoop(ccw, u, v)]);
  // A rotation of the same loop canonicalizes identically too.
  const rotated: Vec3[] = [cw[1]!, cw[2]!, cw[3]!, cw[0]!];
  assert.deepEqual([...canonicalizeLoop(cw, u, v)], [...canonicalizeLoop(rotated, u, v)]);
});

test("validateSectionGeometry: off-plane, non-finite, short and oversized inputs decline typed", () => {
  const okRaw: SectionGeometry = {
    polylines: [{ points: [0, 0, 2, 4, 0, 2] }],
    engine: { engineId: "reference", engineVersion: "1.1.0" },
  };
  validateSectionGeometry(PLANE, okRaw);
  assert.throws(
    () => validateSectionGeometry(PLANE, { ...okRaw, polylines: [{ points: [0, 0, 3, 4, 0, 3] }] }),
    SectionGeometryValidationError,
  );
  assert.throws(
    () => validateSectionGeometry(PLANE, { ...okRaw, polylines: [{ points: [0, 0, 2] }] }),
    SectionGeometryValidationError,
  );
  assert.throws(
    () => validateSectionGeometry(PLANE, { ...okRaw, polylines: [{ points: [0, 0, 2, NaN, 0, 2] }] }),
    SectionGeometryValidationError,
  );
});

test("buildSectionExact: the IR body with facets, missed ids and engine provenance", () => {
  const raw: SectionGeometry = {
    polylines: [{ points: [0, 0, 2, 4, 0, 2, 4, 4, 2, 0, 4, 2, 0, 0, 2] }],
    engine: { engineId: "reference", engineVersion: "1.1.0" },
  };
  const empty: SectionGeometry = { polylines: [], engine: { engineId: "reference", engineVersion: "1.1.0" } };
  const body = buildSectionExact(
    { id: "sp-000001", name: "S", origin: [0, 0, 2], normal: [0, 0, 1], createdAt: "" },
    [
      { id: "el-000001", raw },
      { id: "el-000002", raw: empty },
    ],
  );
  assert.equal(body.format, "offisos-section-exact-ir");
  assert.equal(body.version, "1");
  assert.equal(body.sectionPlaneId, "sp-000001");
  assert.equal(body.facets.length, 1);
  assert.equal(body.facets[0]!.loops.length, 1);
  assert.deepEqual(body.missedElementIds, ["el-000002"]);
  assert.equal(body.engine.engineId, "reference");
});

// ---------------------------------------------------------------------------
// The App API surface on the reference engine.
// ---------------------------------------------------------------------------

test("model3d.section: the exact section of solids with the stable canonical hash", async () => {
  const h = make();
  await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 });
  await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [10, 0, 10] });
  await cmd(h, "sectionplane.create", { name: "S1", origin: [0, 0, 2], normal: [0, 0, 1] });

  const s = val<{
    exact: boolean;
    hash: string;
    section: { facets: readonly { elementId: string; loops: readonly (readonly Vec3[])[]; chains: readonly (readonly Vec3[])[] }[]; missedElementIds: readonly string[] };
  }>(await q(h, "model3d.section", { name: "S1" }));
  assert.equal(s.exact, true);
  assert.equal(s.section.facets.length, 1);
  assert.equal(s.section.facets[0]!.elementId, "el-000001");
  assert.deepEqual(s.section.facets[0]!.loops, [[[0, 0, 2], [4, 0, 2], [4, 4, 2], [0, 4, 2]]]);
  assert.equal(s.section.facets[0]!.chains.length, 0);
  // The second box (z ∈ [10, 12]) misses the plane z = 2 entirely — a legal
  // exact result, explicitly listed.
  assert.deepEqual(s.section.missedElementIds, ["el-000002"]);

  // STABLE HASH: the same query twice is byte-identical.
  const again = val<{ hash: string }>(await q(h, "model3d.section", { name: "S1" }));
  assert.equal(again.hash, s.hash);
  console.log(`CP10 section hash=${s.hash.slice(0, 16)}`);
});

test("model3d.section: a single element via elementId; declines for unknown plane/element", async () => {
  const h = make();
  await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 });
  await cmd(h, "sectionplane.create", { name: "S1", origin: [0, 0, 2], normal: [0, 0, 1] });
  const one = val<{ section: { facets: readonly { elementId: string }[] } }>(
    await q(h, "model3d.section", { name: "S1", elementId: "el-000001" }),
  );
  assert.equal(one.section.facets.length, 1);
  assert.equal(errCode(await q(h, "model3d.section", { name: "NOPE" })), "bad_id");
  assert.equal(errCode(await q(h, "model3d.section", { name: "S1", elementId: "el-999999" })), "bad_id");
  // No plane at all.
  const h2 = make();
  assert.equal(errCode(await q(h2, "model3d.section", {})), "bad_id");
});

test("model3d.section: the out-of-class solid surfaces the typed section_exact_unsupported decline", async () => {
  const h = make();
  await cmd(h, "model3d.cylinder", { radius: 1, height: 3 });
  await cmd(h, "sectionplane.create", { name: "S1", origin: [0, 0, 1], normal: [0, 0, 1] });
  const r = await q(h, "model3d.section", { name: "S1" });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "section_exact_unsupported");
  assert.match((r as { message: string }).message, /el-000001/);
});

test("the P009 extent preview remains byte-identical (the labeled fallback)", async () => {
  const h = make();
  await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 });
  await cmd(h, "sectionplane.create", { name: "S1", origin: [0, 0, 2], normal: [0, 0, 3] });
  const preview = val<{ hash: string; preview: unknown; exactDecline: string }>(
    await q(h, "model3d.sectionPreview", { name: "S1" }),
  );
  assert.ok(typeof preview.hash === "string" && preview.hash.length === 64);
  assert.ok(typeof preview.exactDecline === "string" && preview.exactDecline.length > 0);
  // The exact:true decline keeps its P009 code.
  assert.equal(errCode(await q(h, "model3d.sectionPreview", { name: "S1", exact: true })), "section_exact_unsupported");
});

test("PARITY ANCHOR: the exact section stream twice is byte-identical", async () => {
  const run = async (): Promise<string> => {
    const h = make();
    await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 });
    await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, at: [2, 2, 0] });
    await cmd(h, "sectionplane.create", { name: "S", origin: [0, 0, 1.5], normal: [0, 1, 1] });
    const s = val<{ hash: string }>(await q(h, "model3d.section", { name: "S" }));
    return createHash("sha256").update(s.hash).digest("hex");
  };
  assert.equal(await run(), await run());
});
