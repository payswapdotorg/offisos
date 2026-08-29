// CAD-PARITY-008 / Issue #88: Web host layouts/plot workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) —
// against the running dev server, and asserts the document state after
// every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004): the Electron smoke runs the same stream through the
// real Electron UI and both must match the pinned fixture
// (app/test/fixtures/cad-parity-008-layouts.json).
//
// Covers the CAD-PARITY-008 acceptance surface: the multi-layout lifecycle
// (LAYOUTNEW ×2, LAYOUTRENAME, LAYOUTCLONE with viewports, LAYOUTDELETE with
// the atomic cascade), MVIEW (Fit from the deterministic model extents +
// the explicit 1:100 Scale view), the viewport display-lock gate
// (viewport_locked) + frame moves, per-viewport layer overrides (VPLAYER),
// PAGESETUP (A2 landscape, 15 mm margins, 1:50 — every step defaulting to
// the current value), TILEMODE/MSPACE/PSPACE, layouts.list/plot.preview
// (the canonical IR + stable hash), the deterministic plot exports
// (byte-identical repeated SVG + PDF), the bounded PUBLISH batch
// (multi-page PDF), save/open round-trips preserving the layout/viewport/
// page-setup state exactly, and the deterministic pinned fixture.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/layouts-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-008-layouts.json");

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
const step = (name) => console.log(`LAYOUTS SMOKE: ${name}`);

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
step("document.create + the model geometry (LINE + CIRCLE through the command line)");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-008-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-008-smoke",
    }),
  ),
  "document.create",
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
  });
}
async function runScript(steps) {
  const plans = [];
  const result = runCommandScript(steps, context(), (plan) => plans.push(plan));
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "10000,0" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "0,5000" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "CIRCLE" } },
  { event: { type: "typed", text: "5000,2500" } },
  { event: { type: "typed", text: "1500" } },
]);
assert(snap.elements.length === 3, "three model entities (two lines + the circle)");

// ---------------------------------------------------------------------------
step("LAYOUTNEW ×2 — the multi-layout document (canonical default page setup)");
await runScript([
  { event: { type: "typed", text: "LAYOUTNEW" } },
  { event: { type: "enter" } }, // Enter keeps 'Layout1'
]);
assert((snap.layouts ?? []).length === 1, "Layout1 created");
assert(snap.layouts[0].name === "Layout1", "the default name");
assert(snap.layouts[0].pageSetup.paperSize === "A3", "the canonical A3 default");
assert(snap.layouts[0].pageSetup.orientation === "landscape", "the canonical landscape default");
assert(snap.draftingSettings.activeLayout === "lo-000001", "the new layout is active");
assert(snap.draftingSettings.space === "paper", "activation switches to paper space");

await runScript([
  { event: { type: "typed", text: "LAYOUTNEW" } },
  { event: { type: "typed", text: "Working" } },
]);
assert((snap.layouts ?? []).length === 2, "the named layout created");
assert(snap.layouts[1].id === "lo-000002", "monotonic layout identity");
assert(snap.draftingSettings.activeLayout === "lo-000002", "Working is active");

// ---------------------------------------------------------------------------
step("MVIEW Fit — the deterministic model extents project into the paper rectangle");
await runScript([
  { event: { type: "typed", text: "MVIEW" } },
  { event: { type: "typed", text: "20,20" } },
  { event: { type: "typed", text: "190,180" } },
  { event: { type: "enter" } }, // <Fit>
]);
assert((snap.viewports ?? []).length === 1, "the fit viewport exists");
const vp1 = snap.viewports[0];
// extents = 10000×5000 (the circle top is 4000 < 5000) → max(10000/170, 5000/160).
assert(close(vp1.scaleDenominator, 10000 / 170), `fit denominator (${vp1.scaleDenominator})`);
assert(close(vp1.camera.centerX, 5000) && close(vp1.camera.centerY, 2500), "fit camera = the extents center");

step("MVIEW Scale — the explicit 1:100 view with a typed center");
await runScript([
  { event: { type: "typed", text: "MVIEW" } },
  { event: { type: "typed", text: "210,20" } },
  { event: { type: "typed", text: "400,180" } },
  { event: { type: "typed", text: "Scale" } },
  { event: { type: "typed", text: "100" } },
  { event: { type: "typed", text: "5000,2500" } },
]);
assert((snap.viewports ?? []).length === 2, "the scaled viewport exists");
assert(snap.viewports[1].scaleDenominator === 100, "the explicit 1:100");

// ---------------------------------------------------------------------------
step("viewport display lock — the view freezes, the frame still moves");
{
  const locked = val(await cmd("viewport.update", { id: "vp-000002", patch: { locked: true } }));
  assert(locked.viewport.locked === true, "locked");
  const refused = await cmd("viewport.update", { id: "vp-000002", patch: { scaleDenominator: 50 } });
  assert(refused.ok === false && refused.code === "viewport_locked", "the typed viewport_locked decline");
  const moved = val(await cmd("viewport.update", { id: "vp-000002", patch: { corner1: [215, 25], corner2: [405, 185] } }));
  assert(close(moved.viewport.corner1[0], 215), "the frame moved while locked");
  // An atomic unlock+rescale patch ALSO declines (the gate reads the CURRENT
  // lock — unlock is its own edit, AutoCAD-class behavior).
  const atomic = await cmd("viewport.update", { id: "vp-000002", patch: { locked: false, scaleDenominator: 50 } });
  assert(atomic.ok === false && atomic.code === "viewport_locked", "the atomic unlock+rescale declines too");
  val(await cmd("viewport.update", { id: "vp-000002", patch: { locked: false } }));
  const rescaled = val(await cmd("viewport.update", { id: "vp-000002", patch: { scaleDenominator: 50, rotationDeg: 90 } }));
  assert(rescaled.viewport.scaleDenominator === 50 && rescaled.viewport.rotationDeg === 90, "unlocked → the view edits pass");
}

step("per-viewport layer visibility (VPLAYER) — the override composes with the layer table");
{
  const over = val(await cmd("viewport.update", { id: "vp-000001", patch: { layerOverrides: [{ layerId: "0", visible: false }] } }));
  assert(over.viewport.layerOverrides.length === 1 && over.viewport.layerOverrides[0].visible === false, "the override persisted");
  const preview = val(await q("plot.preview", { name: "Working" }));
  // Layer 0 hidden in vp-000001 → its primitives vanish from that viewport
  // (vp-000002 still projects — the override is per-viewport).
  assert(preview.ir.viewports.find((v) => v.id === "vp-000001").primitiveCount === 0, "the hidden layer plots nothing in the viewport");
  assert(preview.ir.viewports.find((v) => v.id === "vp-000002").primitiveCount > 0, "the other viewport still projects");
  const cleared = val(await cmd("viewport.update", { id: "vp-000001", patch: { layerOverrides: [] } }));
  assert(cleared.viewport.layerOverrides.length === 0, "the override cleared");
  const restored = val(await q("plot.preview", { name: "Working" }));
  assert(restored.ir.viewports.find((v) => v.id === "vp-000001").primitiveCount > 0, "the layer table visibility restores the content");
}

// ---------------------------------------------------------------------------
step("PAGESETUP — A2 landscape, 15 mm margins, 1:50 (every step defaults to the current value)");
await runScript([
  { event: { type: "typed", text: "PAGESETUP" } },
  { event: { type: "enter" } }, // layout <active = Working>
  { event: { type: "typed", text: "A2" } },
  { event: { type: "typed", text: "Landscape" } },
  { event: { type: "typed", text: "15" } },
  { event: { type: "typed", text: "1:50" } },
  { event: { type: "enter" } }, // plot style <None>
  { event: { type: "enter" } }, // plot borders <Yes>
]);
const working = (snap.layouts ?? []).find((l) => l.name === "Working");
assert(working.pageSetup.paperSize === "A2", "A2");
assert(working.pageSetup.widthMm === 420 && working.pageSetup.heightMm === 594, "the canonical A2 portrait dimensions");
assert(working.pageSetup.orientation === "landscape", "landscape");
assert(working.pageSetup.marginsMm.top === 15, "the 15 mm margins");
assert(working.pageSetup.plotScale === "1:50", "the 1:50 plot scale");
assert(working.pageSetup.plotStyleKind === "none", "as-displayed plot style");

// ---------------------------------------------------------------------------
step("TILEMODE / MSPACE / PSPACE — the bounded context switches");
await runScript([
  { event: { type: "typed", text: "TILEMODE" } },
  { event: { type: "typed", text: "0" } },
]);
assert(snap.draftingSettings.space === "paper", "TILEMODE 0 → paper");
await runScript([{ event: { type: "typed", text: "MSPACE" } }]);
assert(snap.draftingSettings.space === "model", "MSPACE → model");
await runScript([{ event: { type: "typed", text: "PSPACE" } }]);
assert(snap.draftingSettings.space === "paper", "PSPACE → paper");

// ---------------------------------------------------------------------------
step("LAYOUTRENAME / LAYOUTCLONE (viewports copy) / LAYOUTDELETE (atomic cascade)");
await runScript([
  { event: { type: "typed", text: "LAYOUTRENAME" } },
  { event: { type: "enter" } }, // <active>
  { event: { type: "typed", text: "Sheet-A" } },
]);
assert((snap.layouts ?? []).some((l) => l.name === "Sheet-A"), "renamed");
await runScript([
  { event: { type: "typed", text: "LAYOUTCLONE" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "Sheet-A-Copy" } },
]);
assert((snap.layouts ?? []).length === 3, "the clone exists (Layout1, Sheet-A, Sheet-A-Copy)");
assert((snap.viewports ?? []).length === 4, "the clone's two viewports copied with fresh identities");
assert(snap.viewports.some((v) => v.layoutId === "lo-000003"), "the cloned viewports reference the new layout");
const revisionsBefore = snap.modelHistory.revisions.length;
await runScript([
  { event: { type: "typed", text: "LAYOUTDELETE" } },
  { event: { type: "typed", text: "Sheet-A-Copy" } },
]);
snap = val(await q("document.getState", {}));
assert((snap.layouts ?? []).length === 2, "the clone deleted");
assert((snap.viewports ?? []).length === 2, "its viewports went with it — ONE atomic revision");
assert(snap.modelHistory.revisions.length === revisionsBefore + 1, "the cascade is one revision (one undo entry)");
{
  // Layout1 carries no viewports — removal succeeds (the reference check
  // only guards layouts WITH viewports; the last-layout rule is a separate
  // COMMAND rule exercised next).
  const removed = await cmd("layout.remove", { name: "Layout1" });
  assert(removed.ok === true, "the viewportless Layout1 removes");
  snap = val(await q("document.getState", {}));
  assert((snap.layouts ?? []).length === 1, "only Sheet-A remains");
  // Only Sheet-A remains — the last-layout rule is the typed decline.
  const last = await cmd("layout.remove", { name: "Sheet-A" });
  assert(last.ok === false && last.code === "layout_last", "the last remaining layout rejects (layout_last)");
}

// Recreate Layout1 so the final document carries two layouts for publish.
await runScript([
  { event: { type: "typed", text: "LAYOUTNEW" } },
  { event: { type: "typed", text: "Layout2" } },
]);

// ---------------------------------------------------------------------------
step("plot.preview — the canonical IR + stable hash (non-mutating)");
{
  const a = val(await q("plot.preview", { name: "Sheet-A" }));
  const b = val(await q("plot.preview", { name: "Sheet-A" }));
  assert(a.hash === b.hash, "the IR hash is stable");
  assert(a.ir.format === "offisos-plot-ir", "the IR format identity");
  assert(a.ir.viewports.length === 2, "both viewports project");
  assert(a.ir.viewports[0].primitiveCount > 0, "the model geometry projects through the viewports");
  assert(a.ir.sheet.widthMm === 594 && a.ir.sheet.heightMm === 420, "the A2 landscape sheet (oriented)");
  assert(a.ir.plot.scaleN === 1 && a.ir.plot.scaleM === 50, "the 1:50 plot policy");
  assert(a.ir.plot.outputWidthMm === 594 && a.ir.plot.sheetScale === 1, "the output page = the exact A2 landscape sheet (the bounded layout-plot equivalence)");
}

// ---------------------------------------------------------------------------
step("PLOT — deterministic SVG/PDF exports (byte-identical repeats) + typed declines");
const svg1 = val(await cmd("plot.export", { name: "Sheet-A", format: "svg" }));
const svg2 = val(await cmd("plot.export", { name: "Sheet-A", format: "svg" }));
assert(svg1.sha256 === svg2.sha256, "repeated SVG exports are byte-identical");
assert(svg1.text.startsWith("<svg"), "the SVG artifact");
assert(svg1.text.includes('clip-path="url(#clip-vp-'), "native viewport clipPaths");
const pdf1 = val(await cmd("plot.export", { name: "Sheet-A", format: "pdf" }));
const pdf2 = val(await cmd("plot.export", { name: "Sheet-A", format: "pdf" }));
assert(pdf1.sha256 === pdf2.sha256, "repeated PDF exports are byte-identical");
assert(pdf1.size > 500, "a substantial PDF artifact");
const dwg = await cmd("plot.export", { name: "Sheet-A", format: "dwg" });
assert(dwg.ok === false && dwg.code === "plot_unsupported", "proprietary formats are typed declines");
const plotSvgSha = svg1.sha256;
const plotPdfSha = pdf1.sha256;
console.log(`LAYOUTS SMOKE: plot SVG sha256 ${plotSvgSha}`);
console.log(`LAYOUTS SMOKE: plot PDF sha256 ${plotPdfSha}`);

// ---------------------------------------------------------------------------
step("PUBLISH — the bounded batch (every layout into ONE multi-page PDF)");
const published = val(await cmd("plot.publish", { format: "pdf" }));
assert(published.pageCount === 2, "both layouts published (Sheet-A + Layout2)");
assert(published.pages[0].layoutName === "Sheet-A", "layout table order");
const published2 = val(await cmd("plot.publish", { format: "pdf" }));
assert(published.sha256 === published2.sha256, "repeated publishes are byte-identical");

// ---------------------------------------------------------------------------
step("save/open round-trip — the layout/viewport/page-setup state survives exactly");
const saved = val(await cmd("document.save", {}));
assert(ok(await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-008-smoke-reopened" })), "reopen");
snap = val(await q("document.getState", {}));
assert((snap.layouts ?? []).length === 2, "the layouts survived");
assert((snap.viewports ?? []).length === 2, "the viewports survived");
const reopenedA = snap.layouts.find((l) => l.name === "Sheet-A");
assert(reopenedA.pageSetup.paperSize === "A2" && reopenedA.pageSetup.plotScale === "1:50", "the page setup survived (acceptance #3)");
assert(snap.viewports[0].id === "vp-000001" && snap.viewports[0].scaleDenominator === vp1.scaleDenominator, "the viewport state survived exactly");
assert(snap.draftingSettings.activeLayout !== undefined, "the active layout survived");
assert(snap.draftingSettings.space === "paper", "the space context survived");
// The plot exports are identical after the round trip (determinism across save/open).
const svg3 = val(await cmd("plot.export", { name: "Sheet-A", format: "svg" }));
assert(svg3.sha256 === plotSvgSha, "the SVG export is identical after save/open");

// ---------------------------------------------------------------------------
step("deterministic save + pinned CAD-PARITY-008 fixture");
snap = val(await q("document.getState", {}));
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const sha = shaA;
console.log(`LAYOUTS SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    layouts: snap.layouts?.length ?? 0,
    viewports: snap.viewports?.length ?? 0,
    elements: snap.elements.length,
    plotSvgSha256: plotSvgSha,
    plotPdfSha256: plotPdfSha,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`LAYOUTS SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.layouts === (snap.layouts?.length ?? 0), "fixture layout count");
  assert(fixture.viewports === (snap.viewports?.length ?? 0), "fixture viewport count");
  assert(fixture.elements === snap.elements.length, "fixture element count");
  assert(fixture.plotSvgSha256 === plotSvgSha, `fixture plot SVG sha: expected ${fixture.plotSvgSha256}, got ${plotSvgSha}`);
  assert(fixture.plotPdfSha256 === plotPdfSha, `fixture plot PDF sha: expected ${fixture.plotPdfSha256}, got ${plotPdfSha}`);
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(
  `LAYOUTS SMOKE: PASS — ${executed.length} commands; ${snap.layouts?.length ?? 0} layouts, ${snap.viewports?.length ?? 0} viewports, ${snap.elements.length} elements; save sha ${sha.slice(0, 16)}… (CAD-PARITY-008 fixture)`,
);
