// CAD-PARITY-008 / Issue #88: Layouts/plot Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, typed paper coordinates), the layout tab row,
// the paper canvas, the plot preview overlay and window.cad.send — through
// the SAME semantic command sequence the Web host's layouts-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256, the semantic command stream AND the deterministic plot
// artifact hashes must equal the pinned CAD-PARITY-008 fixture
// (app/test/fixtures/cad-parity-008-layouts.json).
//
// Reproduce: cd apps/electron && node test/smoke-layouts.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-layouts.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-008-layouts.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-layouts-smoke-"));
const displayNum = 200 + Math.floor(Math.random() * 100);
const display = `:${displayNum}`;

const env = {
  ...process.env,
  DISPLAY: display,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  ELECTRON_RUN_AS_NODE: "",
};

const verbose = !!process.env.OFFISOS_SMOKE_VERBOSE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function push(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Xvfb.
const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore" });
await sleep(1000);

// 2. Electron (normal mode — the professional workspace mounts on boot).
const cdpPort = 9400 + (process.pid % 200);
const proc = spawn(
  electronExe,
  [APP, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${cdpPort}`],
  { env: { ...env, OFFISOS_SMOKE_OUT: "" }, stdio: "ignore" },
);

let ws = null;
let wsMessageId = 0;
const pending = new Map();
function cleanup() {
  try { if (ws) ws.close(); } catch {}
  try { proc.kill(); } catch {}
  try { xvfb.kill(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

try {
  // 3. Connect over the DevTools protocol.
  let page = null;
  for (let i = 0; i < 60 && page === null; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await res.json();
      page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url)) ?? null;
    } catch {}
    if (page === null) await sleep(500);
  }
  if (page === null) throw new Error("DevTools target not found");
  if (typeof WebSocket !== "function") throw new Error("no built-in WebSocket (Node >= 22 required)");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP websocket open timeout")), 15000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP websocket error")); });
  });
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
    const msg = JSON.parse(text);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const cdp = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++wsMessageId;
      const t = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
      pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (js) => {
    const r = await cdp("Runtime.evaluate", {
      expression: `(async () => (${js}))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.error !== undefined) throw new Error(`CDP error: ${JSON.stringify(r.error).slice(0, 300)}`);
    const payload = r.result;
    if (payload === undefined || payload.exceptionDetails !== undefined) {
      throw new Error(`renderer exception: ${JSON.stringify(payload && payload.exceptionDetails).slice(0, 600)}`);
    }
    return payload.result !== undefined ? payload.result.value : undefined;
  };
  const waitForEval = async (predicateJs, what, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if ((await evaluate(predicateJs)) === true) return;
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
      await sleep(150);
    }
  };

  await waitForEval("!!window.__offisosWorkspace", "professional workspace driver");
  const drv = (method, ...args) => evaluate(`window.__offisosWorkspace.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const cad = (req) => evaluate(`window.cad.send(${JSON.stringify(req)})`);
  const docState = async () => (await cad({ type: "query", name: "document.getState", payload: {} })).value;

  // The command stream log (parity with the Web smoke).
  const stream = [];
  let lastLogLen = 0;
  const syncDriverLog = async () => {
    const log = await drv("commandLog");
    for (; lastLogLen < log.length; lastLogLen++) stream.push(log[lastLogLen]);
  };
  const send = async (name, payload) => {
    const res = await cad({ type: "command", name, payload });
    stream.push(name);
    await drv("refresh");
    await syncDriverLog();
    return res;
  };
  const typed = async (text) => {
    await drv("typedInput", text);
    await syncDriverLog();
  };

  const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  // --- Boot + document. ---------------------------------------------------------
  push("professional workspace mounts (the CAD-PARITY-002 shell)", true, "driver present");
  const created = await send("document.create", { entityId: "cad-parity-008-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-008-smoke" });
  push("document.create", created && created.ok === true, "ok");

  // --- The model geometry through the REAL command line. -------------------------
  await typed("LINE");
  await typed("0,0");
  await typed("10000,0");
  await typed("");
  await typed("LINE");
  await typed("0,0");
  await typed("0,5000");
  await typed("");
  await typed("CIRCLE");
  await typed("5000,2500");
  await typed("1500");
  let snap = await docState();
  push("model geometry through the command line", snap.elements.length === 3, `${snap.elements.length} elements`);

  // --- The layout lifecycle through the REAL command line. ------------------------
  await typed("LAYOUTNEW");
  await typed(""); // Enter keeps 'Layout1'
  snap = await docState();
  push(
    "LAYOUTNEW <Enter> — Layout1 with the canonical A3 landscape page setup",
    (snap.layouts ?? []).length === 1 && snap.layouts[0].pageSetup.paperSize === "A3" && snap.layouts[0].pageSetup.orientation === "landscape",
    "A3 landscape default",
  );
  await typed("LAYOUTNEW");
  await typed("Working");
  snap = await docState();
  push(
    "LAYOUTNEW 'Working' — the multi-layout document + activation",
    (snap.layouts ?? []).length === 2 && snap.draftingSettings.activeLayout === "lo-000002",
    "Working active",
  );

  // --- The layout tab row (the REAL UI surface). ----------------------------------
  const tabCount = await evaluate("document.querySelectorAll('[data-testid^=\"pro-tab-layout-\"]').length");
  push("the layout tab row renders one tab per layout (distinct from the Model tab)", tabCount === 2, `${tabCount} layout tabs`);
  const modelTab = await evaluate("!!document.querySelector('[data-testid=\"pro-tab-model\"]')");
  push("the Model tab exists alongside the layout tabs", modelTab === true, "pro-tab-model");

  // --- MVIEW (Fit + Scale) through the command line. ------------------------------
  await typed("MVIEW");
  await typed("20,20");
  await typed("190,180");
  await typed(""); // <Fit>
  await typed("MVIEW");
  await typed("210,20");
  await typed("400,180");
  await typed("Scale");
  await typed("100");
  await typed("5000,2500");
  snap = await docState();
  const vp1 = (snap.viewports ?? [])[0];
  const vp2 = (snap.viewports ?? [])[1];
  push(
    "MVIEW Fit — the deterministic model extents (1:58.82…, camera at the extents center)",
    (snap.viewports ?? []).length === 2 && close(vp1.scaleDenominator, 10000 / 170) && close(vp1.camera.centerX, 5000),
    `1:${vp1 && vp1.scaleDenominator.toFixed(3)}`,
  );
  push("MVIEW Scale — the explicit 1:100 view", vp2.scaleDenominator === 100, "1:100");

  // --- The viewport display lock + frame moves. ------------------------------------
  await send("viewport.update", { id: "vp-000002", patch: { locked: true } });
  const refused = await send("viewport.update", { id: "vp-000002", patch: { scaleDenominator: 50 } });
  push("the locked view rejects scale edits (typed viewport_locked)", refused.ok === false && refused.code === "viewport_locked", refused.code);
  const moved = await send("viewport.update", { id: "vp-000002", patch: { corner1: [215, 25], corner2: [405, 185] } });
  push("the locked frame still moves (AutoCAD display-lock semantics)", moved.ok === true && close(moved.value.viewport.corner1[0], 215), "corner1 x=215");
  const atomic = await send("viewport.update", { id: "vp-000002", patch: { locked: false, scaleDenominator: 50 } });
  push("the atomic unlock+rescale declines (unlock is its own edit)", atomic.ok === false && atomic.code === "viewport_locked", atomic.code);
  await send("viewport.update", { id: "vp-000002", patch: { locked: false } });
  const rescaled = await send("viewport.update", { id: "vp-000002", patch: { scaleDenominator: 50, rotationDeg: 90 } });
  push("unlocked → the view edits pass", rescaled.ok === true && rescaled.value.viewport.scaleDenominator === 50, "1:50, 90°");

  // --- VPLAYER: per-viewport layer visibility. --------------------------------------
  await send("viewport.update", { id: "vp-000001", patch: { layerOverrides: [{ layerId: "0", visible: false }] } });
  let previewA = (await cad({ type: "query", name: "plot.preview", payload: { name: "Working" } })).value;
  await send("viewport.update", { id: "vp-000001", patch: { layerOverrides: [] } });
  let previewB = (await cad({ type: "query", name: "plot.preview", payload: { name: "Working" } })).value;
  push(
    "VPLAYER — the override composes with the layer table (hidden → 0 primitives, cleared → restored)",
    previewA.ir.viewports.find((v) => v.id === "vp-000001").primitiveCount === 0 &&
      previewB.ir.viewports.find((v) => v.id === "vp-000001").primitiveCount > 0,
    "per-viewport visibility",
  );

  // --- PAGESETUP (A2 landscape, 15 mm margins, 1:50). -------------------------------
  await typed("PAGESETUP");
  await typed(""); // layout <active>
  await typed("A2");
  await typed("Landscape");
  await typed("15");
  await typed("1:50");
  await typed(""); // plot style <None>
  await typed(""); // plot borders <Yes>
  snap = await docState();
  const working = (snap.layouts ?? []).find((l) => l.name === "Working");
  push(
    "PAGESETUP — A2 landscape, 15 mm margins, 1:50, as-displayed plot style",
    working.pageSetup.paperSize === "A2" && working.pageSetup.marginsMm.top === 15 && working.pageSetup.plotScale === "1:50" && working.pageSetup.plotStyleKind === "none",
    "A2 landscape · 15 mm · 1:50 · none",
  );

  // --- The context switches. ---------------------------------------------------------
  await typed("TILEMODE");
  await typed("0");
  await typed("MSPACE");
  await typed("PSPACE");
  snap = await docState();
  push("TILEMODE 0 → MSPACE → PSPACE land on layout.setSpace", snap.draftingSettings.space === "paper", "paper space");

  // --- The paper canvas (the REAL painted surface). -----------------------------------
  const paperSheet = await evaluate("!!document.querySelector('[data-testid=\"pro-paper-sheet\"]')");
  push("the paper canvas paints the sheet (the shared paper painter + Plot IR)", paperSheet === true, "pro-paper-sheet");
  const paperInfo = await drv("paperInfo");
  push(
    "the driver paperInfo — the active layout + its viewports",
    paperInfo.space === "paper" && paperInfo.layoutName === "Working" && paperInfo.viewportCount === 2,
    `${paperInfo.layoutName}, ${paperInfo.viewportCount} viewports`,
  );

  // --- LAYOUTRENAME / LAYOUTCLONE / LAYOUTDELETE. ---------------------------------------
  await typed("LAYOUTRENAME");
  await typed("");
  await typed("Sheet-A");
  await typed("LAYOUTCLONE");
  await typed("");
  await typed("Sheet-A-Copy");
  snap = await docState();
  push(
    "LAYOUTCLONE — the layout AND its viewports copy (one atomic revision)",
    (snap.layouts ?? []).length === 3 && (snap.viewports ?? []).length === 4,
    "3 layouts, 4 viewports",
  );
  const revisionsBefore = snap.modelHistory.revisions.length;
  await typed("LAYOUTDELETE");
  await typed("Sheet-A-Copy");
  snap = await docState();
  push(
    "LAYOUTDELETE — the atomic cascade (ONE revision)",
    (snap.layouts ?? []).length === 2 && (snap.viewports ?? []).length === 2 && snap.modelHistory.revisions.length === revisionsBefore + 1,
    "one undo entry",
  );
  const removedLayout1 = await send("layout.remove", { name: "Layout1" });
  const lastLayout = await send("layout.remove", { name: "Sheet-A" });
  push("the viewportless layout removes; the LAST layout declines (layout_last)", removedLayout1.ok === true && lastLayout.ok === false && lastLayout.code === "layout_last", "layout_last");
  await typed("LAYOUTNEW");
  await typed("Layout2");
  snap = await docState();
  push("LAYOUTNEW 'Layout2' — two layouts for the publish batch", (snap.layouts ?? []).length === 2, "Sheet-A + Layout2");

  // --- The plot preview overlay (the REAL UI surface). -----------------------------------
  await drv("openPlotPreview");
  const overlay = await evaluate("!!document.querySelector('[data-testid=\"pro-plot-preview\"]')");
  const overlayInfo = await evaluate("document.querySelector('[data-testid=\"pro-plot-preview-info\"]') ? document.querySelector('[data-testid=\"pro-plot-preview-info\"]').textContent : null");
  const overlayCanvas = await evaluate("!!document.querySelector('[data-testid=\"pro-plot-preview-canvas\"]')");
  push(
    "PREVIEW — the plot preview overlay (the shared Plot IR + hash)",
    overlay === true && overlayCanvas === true && /IR sha256 [0-9a-f]{16}/.test(overlayInfo ?? ""),
    (overlayInfo ?? "").slice(0, 60),
  );
  await evaluate("document.querySelector('[data-testid=\"pro-plot-preview\"]')?.remove()");

  // --- The deterministic plot exports (the parity artifacts). ------------------------------
  const svg1 = await send("plot.export", { name: "Sheet-A", format: "svg" });
  const svg2 = await send("plot.export", { name: "Sheet-A", format: "svg" });
  const dwg = await send("plot.export", { name: "Sheet-A", format: "dwg" });
  const pdf1 = await send("plot.export", { name: "Sheet-A", format: "pdf" });
  const pdf2 = await send("plot.export", { name: "Sheet-A", format: "pdf" });
  push("plot.export SVG ×2 byte-identical", svg1.ok === true && svg1.value.sha256 === svg2.value.sha256, svg1.value.sha256.slice(0, 16) + "…");
  push("plot.export PDF ×2 byte-identical", pdf1.ok === true && pdf1.value.sha256 === pdf2.value.sha256, pdf1.value.sha256.slice(0, 16) + "…");
  push("proprietary formats are typed declines (plot_unsupported)", dwg.ok === false && dwg.code === "plot_unsupported", dwg.code);

  const published = await send("plot.publish", { format: "pdf" });
  const published2 = await send("plot.publish", { format: "pdf" });
  push(
    "PUBLISH — every layout into ONE multi-page PDF (deterministic)",
    published.ok === true && published.value.pageCount === 2 && published.value.sha256 === published2.value.sha256,
    `${published.value.pageCount} pages`,
  );

  // --- Save/open round-trip. ------------------------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-008-smoke-reopened" });
  snap = await docState();
  push(
    "save/open — the layout/viewport/page-setup state persists exactly",
    (snap.layouts ?? []).length === 2 && (snap.viewports ?? []).length === 2 &&
      (snap.layouts ?? []).find((l) => l.name === "Sheet-A").pageSetup.plotScale === "1:50" &&
      snap.draftingSettings.space === "paper",
    "round-trip ok",
  );
  const svg3 = await send("plot.export", { name: "Sheet-A", format: "svg" });
  push("the SVG export is identical after save/open", svg3.value.sha256 === svg1.value.sha256, "deterministic across open");

  // --- The parity gate: fixture sha + command stream + plot artifacts. ------------------------
  const s1 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const s2 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const sha1 = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
  const sha2 = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
  push("save is deterministic", sha1 === sha2, sha1.slice(0, 16) + "…");
  const sha = sha1;
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  push(
    "CAD-PARITY-008 fixture: save sha256 MATCH",
    fixture.saveSha256 === sha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${sha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-008 fixture: layout/viewport/element counts",
    fixture.layouts === (snap.layouts ?? []).length && fixture.viewports === (snap.viewports ?? []).length && fixture.elements === snap.elements.length,
    `${(snap.layouts ?? []).length} layouts, ${(snap.viewports ?? []).length} viewports, ${snap.elements.length} elements`,
  );
  push(
    "CAD-PARITY-008 fixture: plot SVG sha256 MATCH (the deterministic writer)",
    fixture.plotSvgSha256 === svg1.value.sha256,
    `expected ${fixture.plotSvgSha256.slice(0, 16)}…, got ${svg1.value.sha256.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-008 fixture: plot PDF sha256 MATCH (the deterministic writer)",
    fixture.plotPdfSha256 === pdf1.value.sha256,
    `expected ${fixture.plotPdfSha256.slice(0, 16)}…, got ${pdf1.value.sha256.slice(0, 16)}…`,
  );
  // Sync any remaining driver-logged commands (the two final saves came through
  // cad() directly — push them to mirror the Web stream).
  stream.push("document.save");
  stream.push("document.save");
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-008 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON LAYOUTS SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON LAYOUTS SMOKE: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  if (verbose && err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  cleanup();
}
