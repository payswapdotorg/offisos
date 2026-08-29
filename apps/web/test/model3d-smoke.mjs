// CAD-PARITY-009 / Issue #90: Web host model3d workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) through
// the CAD-PARITY-009 command registry (commands-model3d.ts) — against the
// running dev server, and asserts the document state after every step.
// This is the Web half of the Web/Electron semantic-parity evidence
// (LOCK-004): the Electron smoke (apps/electron/test/smoke-model3d.mjs)
// runs the same stream through the real Electron UI and both must match the
// pinned fixture (app/test/fixtures/cad-parity-009-model3d.json).
//
// Covers the CAD-PARITY-009 acceptance surface: the named-UCS lifecycle
// (UCSNEW with typed world triples + the explicit right-handed completion,
// UCSACT, the ucs_active removal gate), solid creation through the ACTIVE
// UCS and the World UCS (BOX ×2 / CYLINDER / EXTRUDE with the typed profile),
// UCS-aware 3D transforms (MOVE3D / ROTATE3D / SCALE3D with exact bbox
// deltas), the bounded view commands (VPOINT standard views + ZOOM3D Fit —
// non-versioned view state, commandDepth unchanged), the section-preview
// foundation (SECTIONPLANE with un-normalized normal, the stable canonical
// hash, the typed exact-section decline), deterministic 3D selection
// (model3d.pick ordered hits + the typed sub-entity decline), the engine
// mesh query (MeshProvider), typed declines (degenerate extrusion profile,
// unknown element), undo/redo integrity, and the save/open round-trip
// preserving the UCS table + the active workplane + the 3D camera + the
// solids with engine provenance.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/model3d-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-009-model3d.json");

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
const step = (name) => console.log(`MODEL3D SMOKE: ${name}`);

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// ---------------------------------------------------------------------------
step("document.create + the UCS lifecycle (UCSNEW typed world triples + UCSACT)");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-009-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-009-smoke",
    }),
  ),
  "document.create",
);
let snap = val(await q("document.getState", {}));
assert((snap.ucs ?? []).length === 0, "no named UCS yet (World implicit)");
assert(snap.draftingSettings.activeUcs === undefined, "World is the implicit default active UCS");

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
  // The ENGINE echo lines — exactly what the Electron host's echoLog driver
  // collects per event (the semantic-parity digest basis).
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

// UCSNEW 'East-Plan': origin [10,0,0], xAxis [0,1,0], yAxis [−1,0,0] — the
// typed world triples are the origin, a point ON the new X axis and a point
// in the new XY plane (the registry derives + orthonormalizes them).
await runScript([
  { event: { type: "typed", text: "UCSNEW" } },
  { event: { type: "typed", text: "East-Plan" } },
  { event: { type: "typed", text: "10,0,0" } },
  { event: { type: "typed", text: "10,1,0" } },
  { event: { type: "typed", text: "9,0,0" } },
]);
assert((snap.ucs ?? []).length === 1, "East-Plan defined");
assert(snap.ucs[0].id === "ucs-000001", "monotonic ucs identity");
assert(close(snap.ucs[0].origin[0], 10), "the typed origin");
assert(close(snap.ucs[0].xAxis[1], 1), "the derived X axis");
assert(close(snap.ucs[0].yAxis[0], -1), "the orthonormalized Y axis");
assert(close(snap.ucs[0].zAxis[2], 1), "the server's exact right-handed z completion");

await runScript([
  { event: { type: "typed", text: "UCSACT" } },
  { event: { type: "typed", text: "East-Plan" } },
]);
assert(snap.draftingSettings.activeUcs === "ucs-000001", "East-Plan is the active workplane");

// Removing the ACTIVE UCS is the typed ucs_active decline (activate World
// first — UCSDELETE would surface the same decline through the registry).
{
  const refused = await cmd("ucs.remove", { name: "East-Plan" });
  assert(refused.ok === false && refused.code === "ucs_active", `the typed ucs_active decline (got ${refused.code})`);
}

// ---------------------------------------------------------------------------
step("solid creation through the ACTIVE UCS + the World UCS (BOX / CYLINDER / EXTRUDE)");
await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "3" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "enter" } }, // base point <0,0,0>
]);
assert(snap.elements.length === 1, "the box solid exists");
{
  const p = snap.elements[0].props;
  assert(p.type === "model3d.solid" && p.shape === "box", "the model3d.solid element");
  assert(typeof p.meshToken === "string" && p.meshToken.length > 0, "the engine meshToken persisted");
  assert(Array.isArray(p.meshBBox) && p.meshBBox.length === 6, "the engine bbox persisted");
  assert(p.geometryEngine?.engineId === "occt" || p.geometryEngine?.engineId === "reference" || typeof p.geometryEngine?.engineId === "string", "the engine provenance persisted");
  assert(p.ucsId === "ucs-000001", "placed through the ACTIVE UCS");
}

await runScript([{ event: { type: "typed", text: "UCSW" } }]);
assert(snap.draftingSettings.activeUcs === "world", "World active again");

await runScript([
  { event: { type: "typed", text: "BOX" } },
  { event: { type: "typed", text: "10" } },
  { event: { type: "typed", text: "10" } },
  { event: { type: "typed", text: "10" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "CYLINDER" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "5" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "EXTRUDE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "4,0" } },
  { event: { type: "typed", text: "4,3" } },
  { event: { type: "typed", text: "0,3" } },
  { event: { type: "enter" } }, // finish the profile
  { event: { type: "typed", text: "5" } }, // height
  { event: { type: "enter" } }, // base Z <0>
]);
assert(snap.elements.length === 4, "four solids (box ×2 + cylinder + extrusion)");
{
  const cyl = snap.elements[2].props;
  assert(cyl.shape === "cylinder" && close(cyl.radius, 2) && close(cyl.height, 5), "the cylinder parameters");
  const ext = snap.elements[3].props;
  assert(ext.shape === "extrude" && ext.profile.length === 4 && close(ext.height, 5), "the extrusion parameters");
  const revisions = snap.modelHistory.revisions.length;
  assert(revisions === 5, "one atomic revision per creation (1 UCS + 4 solids)");
}

// Typed declines: a degenerate (zero-area) extrusion profile and an unknown
// element id — explicit, deterministic, never silent.
{
  const degenerate = await cmd("model3d.extrude", { profile: [[0, 0], [1, 0], [2, 0]], height: 1 });
  assert(degenerate.ok === false && degenerate.code === "model3d_invalid", `the degenerate profile decline (got ${degenerate.code})`);
  const unknown = await cmd("model3d.move", { elementId: "el-999999", delta: [1, 0, 0] });
  assert(unknown.ok === false && unknown.code === "bad_id", `the unknown element decline (got ${unknown.code})`);
}

// ---------------------------------------------------------------------------
step("UCS-aware 3D transforms (MOVE3D / ROTATE3D / SCALE3D) — exact bbox deltas");
const box2Before = [...snap.elements[1].props.meshBBox];
const box2TokenBefore = snap.elements[1].props.meshToken;
await runScript([
  { event: { type: "typed", text: "MOVE3D" } },
  { event: { type: "typed", text: "el-000002" } },
  { event: { type: "typed", text: "5,0,0" } },
]);
{
  const b = val(await q("document.getState", {})).elements[1].props.meshBBox;
  assert(close(b[0], box2Before[0] + 5) && close(b[3], box2Before[3] + 5), "move shifts the bbox by exactly 5 in X");
}
await runScript([
  { event: { type: "typed", text: "ROTATE3D" } },
  { event: { type: "typed", text: "el-000002" } },
  { event: { type: "typed", text: "0,0,1" } },
  { event: { type: "typed", text: "90" } },
  { event: { type: "enter" } }, // base <UCS origin = world origin>
]);
await runScript([
  { event: { type: "typed", text: "SCALE3D" } },
  { event: { type: "typed", text: "el-000003" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "0,0,0" } },
]);
{
  const s = val(await q("document.getState", {}));
  const cylB = s.elements[2].props.meshBBox;
  // OCCT's curved-extent bboxes carry the tessellation deflection margin
  // (~0.03) — the box deltas above are exact, the cylinder widths approximate.
  assert(close(cylB[3] - cylB[0], 8, 0.1) && close(cylB[4] - cylB[1], 8, 0.1), "scale 2 doubles the cylinder extents (r2 → r4)");
  assert(s.modelHistory.revisions.length === 8, "one atomic revision per transform (5 + 3)");
  // The meshToken changed with each transform (the engine re-realized the
  // composed descriptor — provenance tracks the current state).
  assert(s.elements[1].props.meshToken !== box2TokenBefore, "the transformed box carries the re-prepared meshToken");
}

// ---------------------------------------------------------------------------
step("the bounded view commands (VPOINT / ZOOM3D) — non-versioned view state");
const depthBeforeViews = snap.modelHistory.revisions.length;
await runScript([
  { event: { type: "typed", text: "VPOINT" } },
  { event: { type: "enter" } }, // <Iso>
]);
await runScript([
  { event: { type: "typed", text: "VPOINT" } },
  { event: { type: "typed", text: "Top" } },
]);
await runScript([
  { event: { type: "typed", text: "ZOOM3D" } },
  { event: { type: "enter" } }, // <Fit>
]);
snap = val(await q("document.getState", {}));
{
  const camera = snap.draftingSettings.view3d;
  assert(camera !== undefined, "the deterministic camera persisted (view3d editor settings)");
  assert(close(camera.eye[0], camera.target[0]) && close(camera.eye[1], camera.target[1]) && camera.eye[2] > camera.target[2], "the fitted top view looks straight down +Z");
  assert(snap.modelHistory.revisions.length === depthBeforeViews, "view state NEVER creates a revision (view ≠ model)");
}
const cameraEcho = val(await q("view3d.state", {}));
assert(cameraEcho.camera.mode === "orthographic", "the persisted camera mode");
assert(cameraEcho.echo.length > 0, "the deterministic camera echo");

// ---------------------------------------------------------------------------
step("the section-preview foundation (SECTIONPLANE + the stable canonical hash)");
await runScript([
  { event: { type: "typed", text: "SECTIONPLANE" } },
  { event: { type: "typed", text: "Mid-Z" } },
  { event: { type: "typed", text: "0,0,2" } },
  { event: { type: "typed", text: "0,0,3" } }, // un-normalized — normalized exactly on the server
]);
snap = val(await q("document.getState", {}));
assert((snap.sectionPlanes ?? []).length === 1, "the section plane exists");
{
  const sp = snap.sectionPlanes[0];
  assert(sp.id === "sp-000001", "monotonic sp identity");
  assert(close(sp.origin[2], 2), "the typed origin");
  assert(close(sp.normal[0], 0) && close(sp.normal[1], 0) && close(sp.normal[2], 1), "the normal normalized to [0,0,1] exactly");
  assert(snap.modelHistory.revisions.length === 9, "one atomic revision for the section plane");
}
let sectionPreview = val(await q("model3d.sectionPreview", {}));
const sectionPreview2 = val(await q("model3d.sectionPreview", {}));
assert(sectionPreview.hash === sectionPreview2.hash, "the section preview hash is stable (non-mutating)");
assert(sectionPreview.preview.facets.length >= 1, "at least one element's extent is cut");
assert(/section/i.test(sectionPreview.exactDecline), "the exact-section decline is carried explicitly");
{
  const exact = await q("model3d.sectionPreview", { exact: true });
  assert(exact.ok === false && exact.code === "section_exact_unsupported", `the typed exact-section decline (got ${exact.code})`);
}

// ---------------------------------------------------------------------------
step("deterministic 3D selection (ordered hits + the typed sub-entity decline)");
{
  const pick = val(await q("model3d.pick", { screenX: 400, screenY: 300, viewport: { width: 800, height: 600 } }));
  assert(Array.isArray(pick.hits), "the hit list");
  for (let i = 1; i < pick.hits.length; i += 1) {
    assert(
      pick.hits[i - 1].distance < pick.hits[i].distance ||
        (pick.hits[i - 1].distance === pick.hits[i].distance && pick.hits[i - 1].elementId < pick.hits[i].elementId),
      "the hit list is exactly ordered (distance, then canonical id)",
    );
  }
  const declined = await q("model3d.pick", { screenX: 10, screenY: 10, viewport: { width: 800, height: 600 }, subEntity: true });
  assert(declined.ok === false && declined.code === "subentity_unsupported", `the typed sub-entity decline (got ${declined.code})`);
}
{
  const mesh = val(await q("model3d.mesh", { elementId: "el-000001" }));
  assert(mesh.meshToken.length > 0, "the meshToken echo");
  // Both engines expose the MeshProvider capability; the dummy adapter does
  // not (meshAvailable false + the explicit extent-level note is honest).
  assert(typeof mesh.meshAvailable === "boolean", "the mesh availability is explicit");
}

// ---------------------------------------------------------------------------
step("undo/redo integrity — the exact inverses restore the engine state");
{
  const before = val(await q("document.getState", {}));
  const cylBBoxAfterScale = [...before.elements[2].props.meshBBox];
  const cylTokenAfterScale = before.elements[2].props.meshToken;
  await cmd("document.undo", {}); // undo the section plane
  await cmd("document.undo", {}); // undo the scale
  const mid = val(await q("document.getState", {}));
  assert((mid.sectionPlanes ?? []).length === 0, "the section plane undone");
  const cylB = mid.elements[2].props.meshBBox;
  assert(close(cylB[3] - cylB[0], 4, 0.1) && close(cylB[4] - cylB[1], 4, 0.1), "the scale inverse restores the r=2 cylinder extents exactly");
  assert(mid.elements[2].props.meshToken !== cylTokenAfterScale, "the engine result reverted with the exact inverse");
  await cmd("document.redo", {});
  await cmd("document.redo", {});
  const after = val(await q("document.getState", {}));
  assert((after.sectionPlanes ?? []).length === 1, "the section plane redone");
  const cylB2 = after.elements[2].props.meshBBox;
  assert(close(cylB2[3], cylBBoxAfterScale[3]) && close(cylB2[4], cylBBoxAfterScale[4]), "redo reproduces the scaled extents");
  assert(after.elements.length === 4 && after.modelHistory.revisions.length === before.modelHistory.revisions.length + 4, "undo+redo append revisions (journal semantics)");
}

// ---------------------------------------------------------------------------
step("save/open round-trip — the UCS/camera/solids state survives exactly");
const saved = val(await cmd("document.save", {}));
assert(ok(await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-009-smoke-reopened" })), "reopen");
snap = val(await q("document.getState", {}));
assert((snap.ucs ?? []).length === 1 && snap.ucs[0].name === "East-Plan", "the UCS table survived");
assert(snap.draftingSettings.activeUcs === "world", "the active workplane survived (World after UCSW)");
assert(snap.draftingSettings.view3d !== undefined, "the 3D camera survived");
assert(snap.elements.length === 4, "the solids survived");
for (const el of snap.elements) {
  assert(el.props.type === "model3d.solid" && el.props.meshToken.length > 0, `element ${el.id} keeps its engine provenance`);
}
assert((snap.sectionPlanes ?? []).length === 1, "the section planes survived");
{
  const reopened = val(await q("model3d.sectionPreview", {}));
  assert(reopened.hash === sectionPreview.hash, "the section preview hash is identical after save/open");
}

// ---------------------------------------------------------------------------
step("deterministic save + the canonical 3D scene SVG + pinned CAD-PARITY-009 fixture");
snap = val(await q("document.getState", {}));
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const saveSha = shaA;

// The canonical 3D scene SVG through the SHARED deterministic renderer (the
// same basis the Electron smoke hashes through its model3dSceneSvg driver:
// the persisted camera + elements + the ACTIVE UCS — the World triad
// included when World is active — + the section facets + the selection).
const { buildScene3DSVG, WORLD_UCS } = await import(join(REPO_ROOT, "app", "src", "workspace", "model3d", "index.ts"));
const activeUcsId = snap.draftingSettings.activeUcs ?? "world";
const activeUcsRecord = activeUcsId === "world"
  ? WORLD_UCS
  : (snap.ucs ?? []).find((u) => u.id === activeUcsId) ?? WORLD_UCS;
const sceneSvg = buildScene3DSVG({
  viewport: { width: 800, height: 600 },
  camera: snap.draftingSettings.view3d,
  elements: snap.elements.map((el) => {
    const b = Array.isArray(el.props.meshBBox) && el.props.meshBBox.length === 6 ? el.props.meshBBox : null;
    return {
      id: el.id,
      bbox: b === null ? null : {
        minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5],
      },
      ...(typeof el.props.meshToken === "string" ? { meshToken: el.props.meshToken } : {}),
    };
  }),
  ucs: activeUcsRecord,
  sectionFacets: sectionPreview.preview.facets,
  selectedIds: ["el-000001"],
});
const svgSha = createHash("sha256").update(sceneSvg).digest("hex");
const sectionSha = sectionPreview.hash;
const echoDigest = createHash("sha256").update(echoLines.join("\n")).digest("hex");
console.log(`MODEL3D SMOKE: save sha256 ${saveSha}`);
console.log(`MODEL3D SMOKE: scene SVG sha256 ${svgSha}`);
console.log(`MODEL3D SMOKE: section preview sha256 ${sectionSha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: saveSha,
    saveSize: s1.bytes.length,
    ucs: (snap.ucs ?? []).length,
    sectionPlanes: (snap.sectionPlanes ?? []).length,
    elements: snap.elements.length,
    sceneSvgSha256: svgSha,
    sectionPreviewSha256: sectionSha,
    echoDigest,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`MODEL3D SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === saveSha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${saveSha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.ucs === (snap.ucs ?? []).length, "fixture ucs count");
  assert(fixture.sectionPlanes === (snap.sectionPlanes ?? []).length, "fixture section plane count");
  assert(fixture.elements === snap.elements.length, "fixture element count");
  assert(fixture.sceneSvgSha256 === svgSha, `fixture scene SVG sha: expected ${fixture.sceneSvgSha256}, got ${svgSha}`);
  assert(fixture.sectionPreviewSha256 === sectionSha, `fixture section preview sha: expected ${fixture.sectionPreviewSha256}, got ${sectionSha}`);
  assert(fixture.echoDigest === echoDigest, "fixture echo digest (the semantic command stream echoes)");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(
  `MODEL3D SMOKE: PASS — ${executed.length} commands; ${(snap.ucs ?? []).length} named UCS, ${(snap.sectionPlanes ?? []).length} section planes, ${snap.elements.length} solids; save sha ${saveSha.slice(0, 16)}… (CAD-PARITY-009 fixture)`,
);
