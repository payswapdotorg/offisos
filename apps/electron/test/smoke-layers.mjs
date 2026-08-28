// CAD-PARITY-004 / Issue #80: layers/styles/properties Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput), the Model canvas (world-coordinate clicks), the
// document selection and window.cad.send — through the SAME semantic
// command sequence the Web host's layers-styles-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256 AND the semantic command stream must equal the pinned
// CAD-PARITY-004 fixture (app/test/fixtures/cad-parity-004-layers.json).
//
// Reproduce: cd apps/electron && node test/smoke-layers.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-layers.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-004-layers.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-layers-smoke-"));
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

// 2. Electron (normal mode — the professional workspace mounts on boot; the
// CDP port mirrors the smoke-workspace extension launch).
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
  // 3. Connect over the DevTools protocol (the same discovery the
  // smoke-workspace CP3 extension phase uses: the CDP target list on the
  // chosen port, then a minimal WebSocket client).
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
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("CDP websocket error"));
    });
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
      pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
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

  // The command stream log (parity with the Web smoke): driver commands are
  // recorded by the renderer; direct cad.send commands are recorded here.
  const stream = [];
  let lastLogLen = 0;
  const syncDriverLog = async () => {
    const log = await drv("commandLog");
    for (; lastLogLen < log.length; lastLogLen++) stream.push(log[lastLogLen]);
  };
  const send = async (name, payload) => {
    const res = await cad({ type: "command", name, payload });
    stream.push(name);
    // Direct cad.send bypasses the renderer's command() — refresh the
    // renderer state so subsequent UI steps (typedInput context, canvas
    // picks, rendering) see the new document (the CP3 smoke's pattern).
    await drv("refresh");
    await syncDriverLog();
    return res;
  };
  const clickWorld = (wx, wy) =>
    evaluate(`(async () => {
      const svg = document.querySelector('[data-testid="pro-model-svg"]');
      const rect = svg.getBoundingClientRect();
      const view = window.__offisosWorkspace.viewTransform();
      const sx = (${wx} - view.pan.x) * view.zoom;
      const sy = view.height - (${wy} - view.pan.y) * view.zoom;
      const clientX = Math.round(rect.left + (sx / view.width) * rect.width);
      const clientY = Math.round(rect.top + (sy / view.height) * rect.height);
      svg.dispatchEvent(new MouseEvent("mousedown", { clientX, clientY, button: 0, bubbles: true }));
      svg.dispatchEvent(new MouseEvent("mouseup", { clientX, clientY, button: 0, bubbles: true }));
      return { clientX, clientY };
    })()`);

  const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  // --- Fresh document (the SAME entityId the Web smoke uses). ----------------
  const created = await send("document.create", { entityId: "cad-parity-004-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-004-smoke" });
  await drv("refresh");
  push("professional workspace + document.create", created && created.ok === true, "ok");

  // --- Layer manager semantics. ----------------------------------------------
  const wallRes = await send("drafting.addLayer", { name: "A-WALL", color: "#b45309", linetype: "Continuous", lineweight: 0.35, makeActive: true });
  await send("drafting.addLayer", { name: "A-DOOR", color: "#15803d" });
  let snap = await docState();
  const layersById = new Map((snap.layers ?? []).map((l) => [l.id, l]));
  const wall = layersById.get(wallRes.value.layerId);
  const door = (snap.layers ?? []).find((l) => l.name === "A-DOOR");
  push(
    "layers created with extended fields + makeActive",
    wall !== undefined && wall.lineweight === 0.35 && snap.draftingSettings?.activeLayer === wall.id,
    `lineweight=${wall && wall.lineweight}, active=${snap.draftingSettings?.activeLayer}`,
  );
  await send("drafting.updateLayer", { layerId: door.id, patch: { locked: true, transparency: 40, plot: false } });

  // --- LINE on the active layer via the command line. ------------------------
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,0");
  await drv("typedInput", "4000,0");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  let line = snap.elements.find((el) => el.props?.type === "line" && el.props?.layer === wall.id);
  push("LINE drawn on the ACTIVE layer (A-WALL)", line !== undefined, line ? line.id : "missing");

  // --- Locked-layer enforcement. ----------------------------------------------
  await send("drafting.updateLayer", { layerId: wall.id, patch: { locked: true } });
  const lockedMove = await send("entity.modify", { op: "move", ids: [line.id], dx: 100, dy: 0 });
  const lockedSet = await send("entity.setDisplay", { ids: [line.id], patch: { color: "#ff0000" } });
  const lockedPick = await cad({ type: "query", name: "precision.pick", payload: { cursor: [2000, 0] } });
  snap = await docState();
  line = snap.elements.find((el) => el.id === line.id);
  push(
    "locked layer: modify + setDisplay REJECTED with typed failures; precision pick excludes the entity",
    lockedMove.ok === false && /locked layer/.test(lockedMove.message) &&
      lockedSet.ok === false && lockedPick.value.id === null && line.props.color === undefined,
    lockedMove.message,
  );

  // --- Unlock → setDisplay → move (display preserved). -----------------------
  await send("drafting.updateLayer", { layerId: wall.id, patch: { locked: false } });
  await send("entity.setDisplay", { ids: [line.id], patch: { color: "#dc2626", linetype: "Dashed", lineweight: 0.5 } });
  await send("entity.modify", { op: "move", ids: [line.id], dx: 100, dy: 0 });
  snap = await docState();
  line = snap.elements.find((el) => el.id === line.id);
  push(
    "display overrides PRESERVED through the geometry op",
    line.props.color === "#dc2626" && line.props.linetype === "Dashed" && line.props.lineweight === 0.5 && line.props.x2 === 4100,
    `color=${line.props.color}, linetype=${line.props.linetype}, x2=${line.props.x2}`,
  );

  // --- CHPROP through the REAL command line (preselection → P → C → hex). ----
  await drv("setSelection", [line.id]);
  await drv("typedInput", "CHPROP");
  await drv("typedInput", "P");
  await drv("typedInput", "C");
  await drv("typedInput", "#0e7490");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  line = snap.elements.find((el) => el.id === line.id);
  push("CHPROP via command line (P → Color → hex)", line.props.color === "#0e7490", `color=${line.props.color}`);

  // --- CLAYER to layer 0 + the target line. -----------------------------------
  await drv("typedInput", "CLAYER");
  await drv("typedInput", "0");
  await syncDriverLog();
  snap = await docState();
  push("CLAYER switched the active layer to 0", snap.draftingSettings?.activeLayer === "0", String(snap.draftingSettings?.activeLayer));
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,1000");
  await drv("typedInput", "4000,1000");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const target = snap.elements.find((el) => el.props?.type === "line" && el.props?.layer === "0");
  push("target LINE drawn on layer 0", target !== undefined, target ? target.id : "missing");

  // --- MATCHPROP with canvas picks. -------------------------------------------
  await drv("typedInput", "MATCHPROP");
  await clickWorld(2000, 0); // source (the colored line)
  await clickWorld(2000, 1000); // destination
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const matched = snap.elements.find((el) => el.id === target.id);
  push(
    "MATCHPROP via canvas picks copies display + layer",
    matched.props.color === "#0e7490" && matched.props.linetype === "Dashed" && matched.props.layer === wall.id,
    `color=${matched.props.color}, layer=${matched.props.layer}`,
  );

  // --- Frozen-layer rules. ------------------------------------------------------
  await send("drafting.updateLayer", { layerId: door.id, patch: { frozen: true } });
  const setActiveFrozen = await send("layer.setActive", { layerId: door.id });
  const drawOnFrozen = await send("entity.create", { entities: [{ layer: door.id, type: "point", x: 1, y: 1 }] });
  const activeFreeze = await send("drafting.updateLayer", { layerId: "0", patch: { frozen: true } });
  await send("drafting.updateLayer", { layerId: door.id, patch: { frozen: false } });
  push(
    "frozen layer: setActive + create REJECTED; the ACTIVE layer cannot be frozen",
    setActiveFrozen.ok === false && drawOnFrozen.ok === false && activeFreeze.ok === false,
    setActiveFrozen.message,
  );

  // --- Layer states: save → mutate → restore exact. ----------------------------
  await send("layerState.save", { name: "Setup A" });
  await send("drafting.updateLayer", { layerId: wall.id, patch: { visible: false, color: "#ff0000" } });
  await send("layerState.restore", { name: "Setup A" });
  snap = await docState();
  const wallNow = (snap.layers ?? []).find((l) => l.id === wall.id);
  push("layer state save → mutate → restore exact", wallNow.visible === true && wallNow.color === "#b45309", `visible=${wallNow.visible}, color=${wallNow.color}`);

  // --- LAYISO / LAYUNISO through the command line + canvas pick. ---------------
  await drv("typedInput", "LAYISO");
  await clickWorld(2000, 0);
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const isoOk = (snap.layers ?? []).find((l) => l.id === "0").visible === false && (snap.layers ?? []).find((l) => l.id === wall.id).visible === true;
  const isolateStateSaved = (snap.layerStates ?? []).some((s) => s.name === "*ISOLATE*");
  await send("layer.unisolate", {});
  snap = await docState();
  push(
    "LAYISO canvas pick isolates the layer; LAYUNISO restores exactly",
    isoOk && isolateStateSaved && (snap.layers ?? []).find((l) => l.id === "0").visible === true && !(snap.layerStates ?? []).some((s) => s.name === "*ISOLATE*"),
    `isolated=${isoOk}, stateSaved=${isolateStateSaved}`,
  );

  // --- LAYON. ---------------------------------------------------------------------
  await send("drafting.updateLayer", { layerId: wall.id, patch: { visible: false } });
  await drv("typedInput", "LAYON");
  await syncDriverLog();
  snap = await docState();
  push("LAYON turns every layer on (one atomic batch)", (snap.layers ?? []).every((l) => l.visible === true), `${(snap.layers ?? []).length} layers`);

  // --- -LAYER Make + CLAYER back. --------------------------------------------------
  await drv("typedInput", "-LAYER");
  await drv("typedInput", "M");
  await drv("typedInput", "A-ANNOT");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const annot = (snap.layers ?? []).find((l) => l.name === "A-ANNOT");
  push("-LAYER Make creates + activates A-ANNOT", annot !== undefined && snap.draftingSettings?.activeLayer === annot.id, annot ? annot.id : "missing");
  await drv("typedInput", "CLAYER");
  await drv("typedInput", "0");
  await syncDriverLog();
  snap = await docState();
  push("CLAYER back to 0", snap.draftingSettings?.activeLayer === "0", String(snap.draftingSettings?.activeLayer));

  // --- Linetypes + styles + standards (the same payload sequence). ----------------
  await send("ltype.create", { name: "Fence", description: "fence posts", pattern: [10, 3, 2, 3] });
  await send("drafting.updateLayer", { layerId: annot.id, patch: { linetype: "Fence" } });
  const fenceRemove = await send("ltype.remove", { name: "Fence" });
  await send("drafting.updateLayer", { layerId: annot.id, patch: { linetype: "Continuous" } });
  await send("ltype.remove", { name: "Fence" });
  await send("textStyle.create", { name: "Notes-3mm", font: "mono", height: 3 });
  await send("dimStyle.create", { name: "ISO-25", textHeight: 2.5, arrowSize: 2, scale: 1, precision: 1 });
  await send("drafting.setSettings", { settings: { textStyle: "Notes-3mm", dimStyle: "ISO-25" } });
  await send("dimStyle.update", { name: "ISO-25", patch: { precision: 2 } });
  const removeCurrent = await send("dimStyle.remove", { name: "ISO-25" });
  const badStyle = await send("drafting.setSettings", { settings: { dimStyle: "Ghost" } });
  await send("drafting.setSettings", { settings: { standards: { linetypeScale: 2 } } });
  await send("drafting.setSettings", { settings: { standards: { defaultLineweight: 0.5 } } });
  const applied = (await send("layer.applyStandard", { standard: "mechanical" })).value;
  const reapplied = (await send("layer.applyStandard", { standard: "mechanical" })).value;
  const bogus = await send("layer.applyStandard", { standard: "bogus" });
  snap = await docState();
  push(
    "linetypes/styles/standards: reference checks + partial-merge standards",
    fenceRemove.ok === false && removeCurrent.ok === false && badStyle.ok === false && bogus.ok === false &&
      applied.created.length === 7 && reapplied.created.length === 0 &&
      snap.draftingSettings?.standards?.linetypeScale === 2 && snap.draftingSettings?.standards?.defaultLineweight === 0.5,
    `created=${applied.created.length}, reapplied=${reapplied.created.length}`,
  );

  // --- Undo/redo: one CHPROP batch = one undo. -------------------------------------
  await send("entity.setDisplay", { ids: [line.id], patch: { color: "#525252" } });
  await send("document.undo", {});
  await send("document.redo", {});
  snap = await docState();
  line = snap.elements.find((el) => el.id === line.id);
  push("undo/redo of a display batch", line.props.color === "#525252", `color=${line.props.color}`);

  // --- Active-layer persistence through save/open. ----------------------------------
  await send("layer.setActive", { layerId: annot.id });
  const saved = (await send("document.save", {})).value;
  await send("document.open", { snapshot: saved.snapshot, source: saved.bytes });
  snap = await docState();
  const persisted = snap.draftingSettings?.activeLayer === annot.id && (snap.textStyles ?? []).some((s) => s.name === "Notes-3mm");
  push("active layer + styles persist through save/open", persisted, `active=${snap.draftingSettings?.activeLayer}`);
  await send("layer.setActive", { layerId: "0" });

  // --- PARITY: save sha + command stream vs the pinned CAD-PARITY-004 fixture. ------
  const s1 = (await send("document.save", {})).value;
  await send("document.save", {});
  const sha = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const shaMatch = fixture.saveSha256 === sha;
  const streamMatch = fixture.commandStream.join("|") === stream.join("|");
  push("PARITY: save sha256 equals the Web host fixture", shaMatch, `${sha.slice(0, 16)}… vs ${fixture.saveSha256.slice(0, 16)}…`);
  push(
    "PARITY: semantic command stream equals the fixture",
    streamMatch,
    streamMatch ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n  got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nLAYERS SMOKE: ${failed.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failed.length}/${checks.length} checks; save sha ${sha.slice(0, 16)}…`);
  if (verbose) console.log("stream:", stream.join(" → "));
  cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
} catch (e) {
  console.error(`LAYERS SMOKE: FAIL — ${e.message}`);
  if (verbose) console.error(e.stack);
  cleanup();
  process.exit(1);
}
