// CAD-PARITY-010 / Issue #93: Web host model3d P010 workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) through
// the CAD-PARITY-010 command registry entries (UNION/SUBTRACT/INTERSECT/
// SECTIONEXACT/TESSELLATE in commands-model3d.ts) — against the running dev
// server, and asserts the document state after every step. This is the Web
// half of the Web/Electron semantic-parity evidence (LOCK-004): the Electron
// smoke (apps/electron/test/smoke-model3d-p010.mjs) runs the same stream
// through the real Electron UI and both must match the pinned fixture
// (app/test/fixtures/cad-parity-010-model3d.json).
//
// Covers the CAD-PARITY-010 acceptance surface: the boolean triad through
// the command registry (UNION of disjoint solids with the operand
// provenance + the atomic revision; INTERSECT with the exact common cell;
// the typed boolean_empty decline for disjoint intersections — never a
// fabricated empty solid), the EXACT adapter-backed section (SECTIONPLANE +
// SECTIONEXACT — the canonical loops with the stable hash), deterministic
// topology-aware picking (model3d.topology + the per-element sub-entity
// face pick through the projected screen point), the bounded mesh entity
// (TESSELLATE — the persisted model3d.mesh element), progressive LOD
// delivery (model3d.mesh with quality through the bounded cache +
// model3d.cacheStats budgets), undo/redo integrity across the boolean
// batch, and the save/open round-trip preserving the boolean solids, the
// mesh entities and the section planes.
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis (the parity
// pattern — the parity suites run over the deterministic analytic engine;
// real-OCCT coverage runs in the CI workspace-shell app tests). Start the
// dev server with OFFISOS_GEOMETRY_ENGINE=reference (the smoke asserts the
// basis from the engine provenance — an OCCT-basis server is a LOUD
// mismatch, never a silent divergence).
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/model3d-p010-smoke.mjs
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-010-model3d.json");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const executed = [];
const cmd = (name, payload) => {
  executed.push(name);
  return send({ type: "command", name, payload });
};
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const TOL = 1e-6;
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const step = (name) => console.log(`MODEL3D P010 SMOKE: ${name}`);

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// --- document -----------------------------------------------------------------

val(
  await cmd("document.create", {
    entityId: "cad-parity-010-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-010-smoke",
  }),
);
let snap = val(await q("document.getState", {}));

function context() {
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    storyCount: 0,
    currentSelection: [],
    layers: snap.layers ?? [],
    textStyles: snap.textStyles ?? [],
    dimStyles: snap.dimStyles ?? [],
    currentTextStyle: snap.draftingSettings?.textStyle ?? "Standard",
    currentDimStyle: snap.draftingSettings?.dimStyle ?? "Standard",
    blocks: snap.blockDefs ?? [],
    xrefs: snap.xrefs ?? [],
    constraints: snap.constraints ?? [],
    layouts: snap.layouts ?? [],
    viewports: snap.viewports ?? [],
    activeLayoutId: snap.draftingSettings?.activeLayout ?? snap.layouts?.[0]?.id ?? null,
    space: snap.draftingSettings?.space ?? "model",
    ucs: snap.ucs ?? [],
    activeUcsId: snap.draftingSettings?.activeUcs ?? "world",
    view3d: snap.draftingSettings?.view3d ?? null,
    model3dSolidCount: (snap.elements ?? []).filter((e) => e.props?.type === "model3d.solid").length,
  });
}
const echoLines = [];
async function runScript(steps) {
  const plans = [];
  const result = runCommandScript(steps, context(), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

// --- the boolean triad through the command registry ----------------------------

step("solid creation (three boxes: an overlapping pair + a disjoint one)");
await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "enter" } }, // base <0,0,0>
]);
await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "2,0,0" } },
]);
await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "10,0,0" } },
]);
assert(snap.elements.length === 3, "three solids (the overlapping pair + the disjoint one)");
{
  const p = snap.elements[0].props;
  assert(p.type === "model3d.solid" && p.shape === "box", "the model3d.solid element");
  assert(p.geometryEngine?.engineId === "reference", `the parity fixture is REFERENCE basis — this server runs '${p.geometryEngine?.engineId}' (start the dev server with OFFISOS_GEOMETRY_ENGINE=reference)`);
}
const revisionsAfterBoxes = snap.modelHistory.revisions.length;

step("UNION through the command registry — the disjoint fuse (reference-exact)");
await runScript([
  { event: { type: "typed", text: "UNION" } },
  { event: { type: "typed", text: "el-000001" } },
  { event: { type: "typed", text: "el-000003" } },
]);
assert(snap.elements.length === 2, "the operands are consumed into the result solid (3 → 2 elements)");
{
  const u = snap.elements.find((e) => e.id === "el-000004");
  assert(u !== undefined, "the boolean result element el-000004");
  assert(u.props.shape === "boolean" && u.props.op === "union", "the boolean provenance shape/op");
  assert(u.props.operands.length === 2 && u.props.operands[0].elementId === "el-000001" && u.props.operands[1].elementId === "el-000003", "the operand provenance (ids + tokens)");
  assert(typeof u.props.operands[0].meshToken === "string" && u.props.operands[0].meshToken.length > 0, "the operand meshToken provenance");
  assert(close(u.props.meshBBox[0], 0) && close(u.props.meshBBox[3], 12), "the union bbox spans both disjoint boxes (exact)");
  assert(snap.modelHistory.revisions.length === revisionsAfterBoxes + 1, "ONE atomic revision for the boolean batch");
}

step("INTERSECT — the exact common cell of the union and the overlapping box");
await runScript([
  { event: { type: "typed", text: "INTERSECT" } },
  { event: { type: "typed", text: "el-000002" } },
  { event: { type: "typed", text: "el-000004" } },
]);
{
  const i = snap.elements.find((e) => e.id === "el-000005");
  assert(i !== undefined, "the intersection result el-000005");
  assert(i.props.op === "intersection", "the intersection provenance");
  assert(close(i.props.meshBBox[0], 2) && close(i.props.meshBBox[3], 4), "the common cell x ∈ [2, 4] (exact)");
  assert(snap.elements.length === 1, "el-000002/el-000004 consumed (the intersection remains)");
}

step("SUBTRACT — the composite minus a fresh slab (each step one atomic revision)");
await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "1" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "3,0,0" } },
]);
await runScript([
  { event: { type: "typed", text: "SUBTRACT" } },
  { event: { type: "typed", text: "el-000005" } },
  { event: { type: "typed", text: "el-000006" } },
]);
{
  const s = snap.elements.find((e) => e.id === "el-000007");
  assert(s !== undefined, "the subtraction result el-000007");
  assert(s.props.op === "difference", "the difference provenance");
  assert(close(s.props.meshBBox[0], 2) && close(s.props.meshBBox[3], 3), "the remaining slab x ∈ [2, 3] (exact)");
  assert(snap.elements.length === 1, "the model holds exactly ONE composite solid");
}

step("the typed boolean_empty decline — a disjoint intersection (never a fabricated empty solid)");
{
  await runScript([
    { event: { type: "typed", text: "BOX" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "enter" } },
  ]);
  await runScript([
    { event: { type: "typed", text: "BOX" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "typed", text: "1" } },
    { event: { type: "typed", text: "50,0,0" } },
  ]);
  const before = val(await q("document.getState", {}));
  const declined = await cmd("model3d.boolean", { op: "intersection", elementIds: ["el-000008", "el-000009"] });
  assert(declined.ok === false && declined.code === "boolean_empty", `the typed boolean_empty decline (got ${declined.code})`);
  const after = val(await q("document.getState", {}));
  assert(after.elements.length === before.elements.length, "the document is untouched by the decline");
}

// --- the exact section ----------------------------------------------------------

step("SECTIONPLANE + SECTIONEXACT — the adapter-backed exact section");
await runScript([
  { event: { type: "typed", text: "SECTIONPLANE" } },
  { event: { type: "typed", text: "Mid-X" } },
  { event: { type: "typed", text: "2.5,0,0" } },
  { event: { type: "typed", text: "1,0,0" } },
]);
assert((snap.sectionPlanes ?? []).length === 1, "the section plane exists");
await runScript([
  { event: { type: "typed", text: "SECTIONEXACT" } },
  { event: { type: "typed", text: "Mid-X" } },
]);
{
  const section = val(await q("model3d.section", { name: "Mid-X" }));
  const section2 = val(await q("model3d.section", { name: "Mid-X" }));
  assert(section.exact === true, "the exact section flag");
  assert(section.hash === section2.hash, "the exact-section hash is stable (non-mutating)");
  assert(section.section.facets.length >= 1, "at least one solid is sectioned exactly");
  for (const facet of section.section.facets) {
    for (const loop of facet.loops) {
      assert(loop.length >= 3, "a closed canonical loop");
      for (const p of loop) assert(close(p[0], 2.5), "every loop point lies on the plane x = 2.5 exactly");
    }
  }
  assert(section.section.missedElementIds.length >= 1, "the far boxes are explicitly listed as missed");
  globalThis.__sectionHash = section.hash;
  globalThis.__sectionFacets = section.section.facets;
}

// --- topology + sub-entity picking ----------------------------------------------

step("deterministic topology-aware picking (topology + the sub-entity face pick)");
await runScript([
  { event: { type: "typed", text: "VPOINT" } },
  { event: { type: "typed", text: "Top" } },
]);
{
  const topo = val(await q("model3d.topology", { elementId: "el-000007" }));
  assert(topo.counts.faces >= 6 && topo.counts.edges >= 12 && topo.counts.vertices >= 8, "the composite solid's topology inventory");
  assert(topo.hash.length === 64, "the canonical topology hash");
  // The per-element sub-entity pick: project a known point of the composite
  // solid through the persisted top-view camera.
  const { projectPoint } = await import(join(REPO_ROOT, "app", "src", "workspace", "model3d", "index.ts"));
  const vs = val(await q("view3d.state", {}));
  const b = snap.elements[0].props.meshBBox;
  const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[5]];
  const pr = projectPoint(vs.camera, { width: 800, height: 600 }, center);
  assert(pr !== null, "the projected screen point");
  // The P009 global pick keeps its exact surface (element-granularity) at
  // the SAME projected point.
  const globalPick = val(await q("model3d.pick", { screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 } }));
  assert(globalPick.hits.length >= 1, "the global element pick still works");
  assert(globalPick.hits[0].elementId === "el-000007", "the global pick names the composite solid");
  const declined = await q("model3d.pick", { screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 }, subEntity: true });
  assert(declined.ok === false && declined.code === "subentity_unsupported", "the P009 global sub-entity decline is preserved");
  const subPick = val(await q("model3d.pick", { elementId: "el-000007", subEntityKind: "face", screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 } }));
  assert(subPick.count >= 1, "the sub-entity face pick hits");
  assert(subPick.hits[0].kind === "face" && /^f\d+$/.test(subPick.hits[0].canonicalId), `the canonical face id (${subPick.hits[0].canonicalId})`);
  assert(close(subPick.hits[0].point[2], b[5]), "the face hit is the top face (z = maxZ)");
  globalThis.__topologyHash = topo.hash;
  globalThis.__subPickFace = subPick.hits[0].canonicalId;
}

// --- the mesh entity + LOD delivery ----------------------------------------------

step("TESSELLATE — the bounded engine-neutral mesh entity");
await runScript([
  { event: { type: "typed", text: "TESSELLATE" } },
  { event: { type: "typed", text: "el-000007" } },
  { event: { type: "typed", text: "low" } },
]);
{
  const meshEntity = snap.elements.find((e) => e.props?.type === "model3d.mesh");
  assert(meshEntity !== undefined, "the model3d.mesh entity element exists");
  assert(meshEntity.props.quality === "low", "the quality preset persisted");
  assert(meshEntity.props.vertexCount > 0 && meshEntity.props.triangleCount > 0, "the bounded payload counts");
  assert(meshEntity.props.sourceElementId === "el-000007", "the source provenance");
  globalThis.__meshEntityId = meshEntity.id;
}
step("progressive LOD delivery + the bounded cache evidence");
{
  const full = val(await q("model3d.mesh", { elementId: "el-000007", quality: "full" }));
  const low = val(await q("model3d.mesh", { elementId: "el-000007", quality: "low" }));
  assert(full.quality === "full" && low.quality === "low", "the preset echo");
  assert(full.withinBudget === true && low.withinBudget === true, "within the LOD budgets");
  const cached = val(await q("model3d.mesh", { elementId: "el-000007", quality: "full" }));
  assert(cached.meshToken === full.meshToken, "the cached LOD mesh is identical");
  const stats = val(await q("model3d.cacheStats", {}));
  assert(stats.cache.hits >= 1 && stats.cache.misses >= 1, "the exact hit/miss counters");
  assert(stats.cache.capacity === 128 && stats.cache.vertexBudget === 1500000, "the documented budgets");
  assert(stats.budgets.meshLodMaxVertices === 150000, "the LOD vertex budget");
  globalThis.__lodFullVertices = full.vertices;
  globalThis.__cacheStats = `${stats.cache.hits}/${stats.cache.misses}/${stats.cache.entries}`;
}

// --- undo/redo + save/open --------------------------------------------------------

step("undo/redo integrity — five revisions deep, the boolean batch inverse restores the operands");
{
  const before = val(await q("document.getState", {}));
  const countBefore = before.elements.length; // composite + 2 far boxes + the mesh entity
  await cmd("document.undo", {}); // 1: undo the TESSELLATE (the mesh entity)
  const mid1 = val(await q("document.getState", {}));
  assert(mid1.elements.length === countBefore - 1, "undo removes the mesh entity (one atomic revision)");
  await cmd("document.undo", {}); // 2: undo the SECTIONPLANE
  const mid2 = val(await q("document.getState", {}));
  assert((mid2.sectionPlanes ?? []).length === 0, "undo removes the section plane");
  await cmd("document.undo", {}); // 3: undo BOX el-000009
  const mid3 = val(await q("document.getState", {}));
  assert(mid3.elements.length === countBefore - 2, "undo removes the second far box");
  await cmd("document.undo", {}); // 4: undo BOX el-000008
  const mid4 = val(await q("document.getState", {}));
  assert(mid4.elements.length === countBefore - 3 && mid4.elements[0].id === "el-000007", "only the composite solid remains");
  await cmd("document.undo", {}); // 5: undo the SUBTRACT (the boolean batch)
  const mid5 = val(await q("document.getState", {}));
  assert(mid5.elements.length === countBefore - 2, "undo restores BOTH operands (the result removed, the two operands back)");
  assert(mid5.elements.some((e) => e.id === "el-000005") && mid5.elements.some((e) => e.id === "el-000006"), "the subtraction operands are restored by the batch inverse");
  await cmd("document.redo", {}); // 1: redo the SUBTRACT
  const mid6 = val(await q("document.getState", {}));
  assert(mid6.elements.length === countBefore - 3, "redo reproduces the composite solid");
  const composite = mid6.elements.find((e) => e.id === "el-000007");
  assert(composite !== undefined && composite.props.shape === "boolean" && composite.props.op === "difference", "the redone composite keeps the boolean provenance");
  await cmd("document.redo", {}); // 2: redo BOX el-000008
  await cmd("document.redo", {}); // 3: redo BOX el-000009
  const mid7 = val(await q("document.getState", {}));
  assert(mid7.elements.length === countBefore - 1, "redo reproduces the far boxes");
  await cmd("document.redo", {}); // 4: redo the SECTIONPLANE
  const mid8 = val(await q("document.getState", {}));
  assert((mid8.sectionPlanes ?? []).length === 1 && mid8.elements.length === countBefore - 1, "redo reproduces the section plane");
  await cmd("document.redo", {}); // 5: redo the TESSELLATE
  const after = val(await q("document.getState", {}));
  assert(after.elements.length === countBefore && (after.sectionPlanes ?? []).length === 1, "redo reproduces the mesh entity — the full pre-undo state");
  snap = after;
}

step("save/open round-trip — the boolean/mesh/section state survives exactly");
{
  const saved = val(await cmd("document.save", {}));
  val(await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-010-smoke-reopened" }));
  const reopened = val(await q("document.getState", {}));
  assert(reopened.elements.length === snap.elements.length, "all elements survived");
  const booleanSolid = reopened.elements.find((e) => e.id === "el-000007");
  assert(booleanSolid !== undefined && booleanSolid.props.shape === "boolean" && booleanSolid.props.op === "difference", "the boolean solid + provenance survived");
  const meshEntity = reopened.elements.find((e) => e.props?.type === "model3d.mesh");
  assert(meshEntity !== undefined && meshEntity.props.quality === "low", "the mesh entity survived");
  assert((reopened.sectionPlanes ?? []).length === 1, "the section plane survived");
  const sectionAgain = val(await q("model3d.section", { name: "Mid-X" }));
  assert(sectionAgain.hash === globalThis.__sectionHash, "the exact-section hash is identical after save/open");
  await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-010-smoke-final" });
}

// --- the fixture -------------------------------------------------------------------

step("deterministic save + the canonical 3D scene SVG + pinned CAD-PARITY-010 fixture");
snap = val(await q("document.getState", {}));
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const saveSha = shaA;

const { buildScene3DSVG, WORLD_UCS } = await import(join(REPO_ROOT, "app", "src", "workspace", "model3d", "index.ts"));
const activeUcsId = snap.draftingSettings.activeUcs ?? "world";
const activeUcsRecord = activeUcsId === "world" ? WORLD_UCS : (snap.ucs ?? []).find((u) => u.id === activeUcsId) ?? WORLD_UCS;
// The canonical scene: the persisted camera + elements + the World UCS triad
// + the EXACT-section loops rendered as the section facets (each canonical
// loop is one facet polygon — the scene digest binds the exact section).
const sceneSvg = buildScene3DSVG({
  viewport: { width: 800, height: 600 },
  camera: snap.draftingSettings.view3d,
  elements: snap.elements.map((el) => {
    const b = Array.isArray(el.props.meshBBox) && el.props.meshBBox.length === 6 ? el.props.meshBBox : null;
    return {
      id: el.id,
      bbox: b === null ? null : { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] },
      ...(typeof el.props.meshToken === "string" ? { meshToken: el.props.meshToken } : {}),
    };
  }),
  ucs: activeUcsRecord,
  sectionFacets: (globalThis.__sectionFacets ?? []).flatMap((facet) =>
    facet.loops.map((loop) => ({ elementId: facet.elementId, polygon: loop })),
  ),
  selectedIds: ["el-000007"],
});
const svgSha = createHash("sha256").update(sceneSvg).digest("hex");
const sectionSha = globalThis.__sectionHash;
const topologySha = globalThis.__topologyHash;
const echoDigest = createHash("sha256").update(echoLines.join("\n")).digest("hex");
console.log(`MODEL3D P010 SMOKE: save sha256 ${saveSha}`);
console.log(`MODEL3D P010 SMOKE: scene SVG sha256 ${svgSha}`);
console.log(`MODEL3D P010 SMOKE: exact section sha256 ${sectionSha}`);
console.log(`MODEL3D P010 SMOKE: topology sha256 ${topologySha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: saveSha,
    saveSize: s1.bytes.length,
    elements: snap.elements.length,
    solids: snap.elements.filter((e) => e.props?.type === "model3d.solid").length,
    meshEntities: snap.elements.filter((e) => e.props?.type === "model3d.mesh").length,
    sectionPlanes: (snap.sectionPlanes ?? []).length,
    sceneSvgSha256: svgSha,
    sectionSha256: sectionSha,
    topologySha256: topologySha,
    subPickFace: globalThis.__subPickFace,
    lodFullVertices: globalThis.__lodFullVertices,
    cacheStats: globalThis.__cacheStats,
    echoDigest,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`MODEL3D P010 SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === saveSha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${saveSha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.elements === snap.elements.length, "fixture element count");
  assert(fixture.solids === snap.elements.filter((e) => e.props?.type === "model3d.solid").length, "fixture solid count");
  assert(fixture.meshEntities === snap.elements.filter((e) => e.props?.type === "model3d.mesh").length, "fixture mesh entity count");
  assert(fixture.sectionPlanes === (snap.sectionPlanes ?? []).length, "fixture section plane count");
  assert(fixture.sceneSvgSha256 === svgSha, `fixture scene SVG sha: expected ${fixture.sceneSvgSha256}, got ${svgSha}`);
  assert(fixture.sectionSha256 === sectionSha, `fixture exact-section sha: expected ${fixture.sectionSha256}, got ${sectionSha}`);
  assert(fixture.topologySha256 === topologySha, `fixture topology sha: expected ${fixture.topologySha256}, got ${topologySha}`);
  assert(fixture.subPickFace === globalThis.__subPickFace, `fixture sub-entity pick face: expected ${fixture.subPickFace}, got ${globalThis.__subPickFace}`);
  assert(fixture.lodFullVertices === globalThis.__lodFullVertices, "fixture LOD vertex count");
  assert(fixture.cacheStats === globalThis.__cacheStats, "fixture cache stats (hits/misses/entries)");
  assert(fixture.echoDigest === echoDigest, "fixture echo digest (the semantic command stream echoes)");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(
  `MODEL3D P010 SMOKE: PASS — ${executed.length} commands; ${snap.elements.filter((e) => e.props?.type === "model3d.solid").length} solids (1 composite boolean), ${snap.elements.filter((e) => e.props?.type === "model3d.mesh").length} mesh entity, ${(snap.sectionPlanes ?? []).length} section plane; save sha ${saveSha.slice(0, 16)}… (CAD-PARITY-010 fixture)`,
);
