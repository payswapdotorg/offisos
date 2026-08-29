// CAD-PARITY-009 / Issue #90: model3d Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, typed UCS/point/number inputs), the 3D Model
// view surface (the shared camera/projection viewport) and window.cad.send —
// through the SAME semantic command sequence the Web host's
// model3d-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256, the semantic command stream, the engine echo digest AND the
// canonical 3D scene SVG hash must equal the pinned CAD-PARITY-009 fixture
// (app/test/fixtures/cad-parity-009-model3d.json).
//
// Reproduce: cd apps/electron && node test/smoke-model3d.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-model3d.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-009-model3d.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-model3d-smoke-"));
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
  const created = await send("document.create", { entityId: "cad-parity-009-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-009-smoke" });
  push("document.create", created && created.ok === true, "ok");

  // --- The UCS lifecycle through the REAL command line. ---------------------------
  await typed("UCSNEW");
  await typed("East-Plan");
  await typed("10,0,0");
  await typed("10,1,0");
  await typed("9,0,0");
  let snap = await docState();
  push(
    "UCSNEW 'East-Plan' — the typed world triples + the right-handed completion",
    (snap.ucs ?? []).length === 1 && snap.ucs[0].id === "ucs-000001" &&
      close(snap.ucs[0].origin[0], 10) && close(snap.ucs[0].xAxis[1], 1) && close(snap.ucs[0].yAxis[0], -1) && close(snap.ucs[0].zAxis[2], 1),
    `origin ${snap.ucs[0].origin.join(",")} X ${snap.ucs[0].xAxis.join(",")}`,
  );
  await typed("UCSACT");
  await typed("East-Plan");
  snap = await docState();
  push("UCSACT — the non-versioned current-workplane switch", snap.draftingSettings.activeUcs === "ucs-000001", "East-Plan active");
  const activeRemoval = await send("ucs.remove", { name: "East-Plan" });
  push("removing the ACTIVE UCS declines (typed ucs_active)", activeRemoval.ok === false && activeRemoval.code === "ucs_active", activeRemoval.code);

  // --- Solid creation through the ACTIVE UCS + the World UCS. ---------------------
  await typed("BOX");
  await typed("2");
  await typed("3");
  await typed("4");
  await typed("");
  snap = await docState();
  push(
    "BOX through the ACTIVE UCS — one atomic revision with the engine provenance",
    snap.elements.length === 1 && snap.elements[0].props.type === "model3d.solid" &&
      typeof snap.elements[0].props.meshToken === "string" && snap.elements[0].props.meshToken.length > 0 &&
      snap.elements[0].props.ucsId === "ucs-000001",
    `${snap.elements[0].props.geometryEngine.engineId} provenance`,
  );
  await typed("UCSW");
  snap = await docState();
  push("UCSW — World active again", snap.draftingSettings.activeUcs === "world", "world");
  await typed("BOX");
  await typed("10");
  await typed("10");
  await typed("10");
  await typed("");
  await typed("CYLINDER");
  await typed("2");
  await typed("5");
  await typed("");
  await typed("EXTRUDE");
  await typed("0,0");
  await typed("4,0");
  await typed("4,3");
  await typed("0,3");
  await typed("");
  await typed("5");
  await typed("");
  snap = await docState();
  push(
    "BOX/CYLINDER/EXTRUDE through the World UCS — four solids, five revisions",
    snap.elements.length === 4 && snap.modelHistory.revisions.length === 5,
    "4 solids",
  );
  const degenerate = await send("model3d.extrude", { profile: [[0, 0], [1, 0], [2, 0]], height: 1 });
  push("the degenerate extrusion profile declines (model3d_invalid)", degenerate.ok === false && degenerate.code === "model3d_invalid", degenerate.code);
  const unknown = await send("model3d.move", { elementId: "el-999999", delta: [1, 0, 0] });
  push("the unknown element declines (bad_id)", unknown.ok === false && unknown.code === "bad_id", unknown.code);

  // --- The UCS-aware 3D transforms. -------------------------------------------------
  const box2Before = [...snap.elements[1].props.meshBBox];
  const box2TokenBefore = snap.elements[1].props.meshToken;
  await typed("MOVE3D");
  await typed("el-000002");
  await typed("5,0,0");
  snap = await docState();
  const movedB = snap.elements[1].props.meshBBox;
  push(
    "MOVE3D — the bbox shifts by exactly 5 in X",
    close(movedB[0], box2Before[0] + 5) && close(movedB[3], box2Before[3] + 5),
    `minX ${box2Before[0]} → ${movedB[0]}`,
  );
  await typed("ROTATE3D");
  await typed("el-000002");
  await typed("0,0,1");
  await typed("90");
  await typed("");
  await typed("SCALE3D");
  await typed("el-000003");
  await typed("2");
  await typed("0,0,0");
  snap = await docState();
  const cylB = snap.elements[2].props.meshBBox;
  push(
    "ROTATE3D + SCALE3D — the re-prepared engine result (scale 2 doubles the cylinder extents)",
    close(cylB[3] - cylB[0], 8, 0.1) && close(cylB[4] - cylB[1], 8, 0.1) &&
      snap.elements[1].props.meshToken !== box2TokenBefore && snap.modelHistory.revisions.length === 8,
    "one atomic revision per transform",
  );

  // --- The bounded view commands (non-versioned view state). -------------------------
  const depthBeforeViews = snap.modelHistory.revisions.length;
  await typed("VPOINT");
  await typed("");
  await typed("VPOINT");
  await typed("Top");
  await typed("ZOOM3D");
  await typed("");
  snap = await docState();
  const camera = snap.draftingSettings.view3d;
  push(
    "VPOINT Top + ZOOM3D Fit — the deterministic camera persisted, NO revision",
    camera !== undefined && close(camera.eye[0], camera.target[0]) && close(camera.eye[1], camera.target[1]) &&
      camera.eye[2] > camera.target[2] && snap.modelHistory.revisions.length === depthBeforeViews,
    "view ≠ model",
  );

  // --- The section-preview foundation. ------------------------------------------------
  await typed("SECTIONPLANE");
  await typed("Mid-Z");
  await typed("0,0,2");
  await typed("0,0,3");
  snap = await docState();
  const sp = (snap.sectionPlanes ?? [])[0];
  push(
    "SECTIONPLANE 'Mid-Z' — the un-normalized normal normalized exactly",
    (snap.sectionPlanes ?? []).length === 1 && sp.id === "sp-000001" && close(sp.normal[0], 0) && close(sp.normal[1], 0) && close(sp.normal[2], 1),
    "normal [0,0,1]",
  );
  const previewA = (await cad({ type: "query", name: "model3d.sectionPreview", payload: {} })).value;
  const previewB = (await cad({ type: "query", name: "model3d.sectionPreview", payload: {} })).value;
  push("model3d.sectionPreview — the stable canonical hash (non-mutating)", previewA.hash === previewB.hash && previewA.preview.facets.length >= 1, previewA.hash.slice(0, 16) + "…");
  const exact = await cad({ type: "query", name: "model3d.sectionPreview", payload: { exact: true } });
  push("the exact BRep cross-section declines (section_exact_unsupported)", exact.ok === false && exact.code === "section_exact_unsupported", exact.code);

  // --- Deterministic 3D selection + the mesh. ------------------------------------------
  const pick = (await cad({ type: "query", name: "model3d.pick", payload: { screenX: 400, screenY: 300, viewport: { width: 800, height: 600 } } })).value;
  let ordered = true;
  for (let i = 1; i < pick.hits.length; i += 1) {
    const a = pick.hits[i - 1];
    const b = pick.hits[i];
    if (!(a.distance < b.distance || (a.distance === b.distance && a.elementId < b.elementId))) ordered = false;
  }
  push("model3d.pick — the exactly-ordered hit list (distance, then canonical id)", Array.isArray(pick.hits) && ordered, `${pick.hits.length} hits`);
  const subEntity = await cad({ type: "query", name: "model3d.pick", payload: { screenX: 10, screenY: 10, viewport: { width: 800, height: 600 }, subEntity: true } });
  push("the sub-entity selection declines (subentity_unsupported)", subEntity.ok === false && subEntity.code === "subentity_unsupported", subEntity.code);
  const mesh = (await cad({ type: "query", name: "model3d.mesh", payload: { elementId: "el-000001" } })).value;
  push("model3d.mesh — the MeshProvider surface", mesh.meshToken.length > 0 && typeof mesh.meshAvailable === "boolean", mesh.meshAvailable ? "mesh available" : "extent-level fallback");

  // --- The 3D Model view surface (the REAL UI). ------------------------------------------
  await drv("setModel3dView", true);
  const info = await drv("model3dInfo");
  push(
    "the 3D Model view surface — the shared camera/projection viewport",
    info.active === true && info.ucsOptions.includes("World") && info.ucsOptions.includes("East-Plan") && info.solidCount === 4,
    `${info.ucsOptions.length} UCS options, ${info.solidCount} solids`,
  );
  const sceneSvg = await drv("model3dSceneSvg", ["el-000001"], true);
  const svgSha = sceneSvg === null ? null : createHash("sha256").update(sceneSvg).digest("hex");
  push("the canonical 3D scene SVG renders (the SHARED deterministic writer)", sceneSvg !== null && sceneSvg.startsWith("<svg") && /data-format="offisos-scene3d-svg"/.test(sceneSvg), (svgSha ?? "").slice(0, 16) + "…");

  // --- Undo/redo integrity. ---------------------------------------------------------------
  const cylTokenAfterScale = snap.elements[2].props.meshToken;
  await send("document.undo", {});
  await send("document.undo", {});
  snap = await docState();
  const cylBack = snap.elements[2].props.meshBBox;
  push(
    "undo — the exact inverses restore the engine state",
    (snap.sectionPlanes ?? []).length === 0 && close(cylBack[3] - cylBack[0], 4, 0.1) && snap.elements[2].props.meshToken !== cylTokenAfterScale,
    "the section plane + scale undone",
  );
  await send("document.redo", {});
  await send("document.redo", {});
  snap = await docState();
  push("redo — the transforms re-applied deterministically", (snap.sectionPlanes ?? []).length === 1 && snap.elements.length === 4, "round-trip ok");

  // --- Save/open round-trip. -----------------------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-009-smoke-reopened" });
  snap = await docState();
  push(
    "save/open — the UCS/camera/solids/section state persists exactly",
    (snap.ucs ?? []).length === 1 && snap.draftingSettings.activeUcs === "world" && snap.draftingSettings.view3d !== undefined &&
      snap.elements.length === 4 && (snap.sectionPlanes ?? []).length === 1 &&
      snap.elements.every((e) => e.props.type === "model3d.solid" && e.props.meshToken.length > 0),
    "round-trip ok",
  );
  const previewReopened = (await cad({ type: "query", name: "model3d.sectionPreview", payload: {} })).value;
  push("the section preview hash is identical after save/open", previewReopened.hash === previewA.hash, previewReopened.hash.slice(0, 16) + "…");

  // --- The parity gate: fixture sha + command stream + scene SVG + echo digest. ---------------
  const s1 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const s2 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const sha1 = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
  const sha2 = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
  push("save is deterministic", sha1 === sha2, sha1.slice(0, 16) + "…");
  const saveSha = sha1;
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  push(
    "CAD-PARITY-009 fixture: save sha256 MATCH",
    fixture.saveSha256 === saveSha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${saveSha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-009 fixture: ucs/section-plane/element counts",
    fixture.ucs === (snap.ucs ?? []).length && fixture.sectionPlanes === (snap.sectionPlanes ?? []).length && fixture.elements === snap.elements.length,
    `${(snap.ucs ?? []).length} UCS, ${(snap.sectionPlanes ?? []).length} planes, ${snap.elements.length} solids`,
  );
  push(
    "CAD-PARITY-009 fixture: canonical 3D scene SVG sha256 MATCH (the shared deterministic renderer)",
    svgSha !== null && fixture.sceneSvgSha256 === svgSha,
    `expected ${fixture.sceneSvgSha256.slice(0, 16)}…, got ${(svgSha ?? "").slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-009 fixture: section preview sha256 MATCH",
    fixture.sectionPreviewSha256 === previewA.hash,
    `expected ${fixture.sectionPreviewSha256.slice(0, 16)}…, got ${previewA.hash.slice(0, 16)}…`,
  );
  // The engine echo digest (the prompt engine's own output — the same lines
  // the Web host's runCommandScript collects).
  const echoLines = await drv("echoLog");
  const echoDigest = createHash("sha256").update(echoLines.join("\n")).digest("hex");
  push(
    "CAD-PARITY-009 fixture: engine echo digest MATCH (the semantic command stream echoes)",
    fixture.echoDigest === echoDigest,
    `expected ${fixture.echoDigest.slice(0, 16)}…, got ${echoDigest.slice(0, 16)}…`,
  );
  // Sync any remaining driver-logged commands (the final saves came through
  // cad() directly — push them to mirror the Web stream).
  await syncDriverLog();
  stream.push("document.save");
  stream.push("document.save");
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-009 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON MODEL3D SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON MODEL3D SMOKE: ERROR — ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
