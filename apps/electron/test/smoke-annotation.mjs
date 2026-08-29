// CAD-PARITY-005 / Issue #82: Annotation Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, typed coordinates), the Model canvas
// (world-coordinate clicks for the ENTITY/entityPoint picks: the
// DIMRADIUS/DIMDIAMETER circle, the DIMANGULAR legs, the DIMTEDIT
// dimension) and window.cad.send — through the SAME semantic command
// sequence the Web host's annotation-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256 AND the semantic command stream must equal the pinned
// CAD-PARITY-005 fixture (app/test/fixtures/cad-parity-005-annotation.json).
//
// Reproduce: cd apps/electron && node test/smoke-annotation.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-annotation.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-005-annotation.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-annotation-smoke-"));
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
  const created = await send("document.create", { entityId: "cad-parity-005-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-005-smoke" });
  push("professional workspace + document.create", created && created.ok === true, "ok");

  // --- Geometry through the REAL command line (LINE ×2 + CIRCLE). ------------
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,0");
  await drv("typedInput", "3000,0");
  await drv("typedInput", "");
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,0");
  await drv("typedInput", "0,2000");
  await drv("typedInput", "");
  await drv("typedInput", "CIRCLE");
  await drv("typedInput", "5000,1000");
  await drv("typedInput", "800");
  await syncDriverLog();
  let snap = await docState();
  const geom = snap.elements.filter((el) => el.kind === "geometry");
  push("geometry drawn (LINE ×2 + CIRCLE via the command line)", geom.length === 3, `${geom.length} elements`);
  const hLine = snap.elements.filter((el) => el.props?.type === "line")[0];
  const vLine = snap.elements.filter((el) => el.props?.type === "line")[1];
  const circle = snap.elements.find((el) => el.props?.type === "circle");

  // --- TEXT / MTEXT through the command line. --------------------------------
  await drv("typedInput", "TEXT");
  await drv("typedInput", "500,500");
  await drv("typedInput", "120");
  await drv("typedInput", "15");
  await drv("typedInput", "OFFISOS ANNOTATION ENGINE");
  await drv("typedInput", "MT");
  await drv("typedInput", "1000,-500");
  await drv("typedInput", "2000");
  await drv("typedInput", "LINE ONE\\nLINE TWO");
  await syncDriverLog();
  snap = await docState();
  const textEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text");
  const mtextEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "mtext");
  push(
    "TEXT + MTEXT created (height 120, rotation 15°, \\n expanded)",
    textEl !== undefined && textEl.props.height === 120 && Math.abs(textEl.props.rotation - (15 * Math.PI) / 180) < 1e-6 &&
      mtextEl !== undefined && mtextEl.props.value === "LINE ONE\nLINE TWO",
    textEl ? `text ok; mtext=${mtextEl && mtextEl.props.value}` : "missing",
  );

  // --- The dimension family through the command line (typed coordinates). ---
  await drv("typedInput", "DLI");
  await drv("typedInput", "0,0");
  await drv("typedInput", "3000,0");
  await drv("typedInput", "1500,600");
  await drv("typedInput", "DLI");
  await drv("typedInput", "0,0");
  await drv("typedInput", "0,2000");
  await drv("typedInput", "V");
  await drv("typedInput", "-400,1000");
  await drv("typedInput", "DLI");
  await drv("typedInput", "0,0");
  await drv("typedInput", "3000,0");
  await drv("typedInput", "R");
  await drv("typedInput", "30");
  await drv("typedInput", "1500,600");
  await drv("typedInput", "DAL");
  await drv("typedInput", "0,0");
  await drv("typedInput", "3000,2000");
  await drv("typedInput", "0,2600");
  await syncDriverLog();
  snap = await docState();
  const dimH = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "horizontal");
  const dimV = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "vertical");
  const dimR = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "rotated");
  const dimA = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "aligned");
  push(
    "DIMLINEAR auto/H/V/R + DIMALIGNED measured server-side",
    dimH?.props.measured === 3000 && dimV?.props.measured === 2000 &&
      close(dimR?.props.measured, 3000 * Math.cos(Math.PI / 6)) && close(dimA?.props.measured, Math.hypot(3000, 2000)),
    `H=${dimH && dimH.props.measured} V=${dimV && dimV.props.measured} R=${dimR && dimR.props.measured}`,
  );

  // --- DIMRADIUS / DIMDIAMETER: canvas ENTITY picks on the circle. -----------
  await drv("typedInput", "DRA");
  await clickWorld(5800, 1000); // ON the circle OUTLINE (+X quadrant) — the entity pick
  await drv("typedInput", "6500,1000"); // leader placement
  await drv("typedInput", "DDI");
  await clickWorld(4200, 1000); // the circle's −X quadrant (the +X side now carries the radius dim's leader)
  await drv("typedInput", "5000,2000"); // dimension line direction
  await syncDriverLog();
  snap = await docState();
  const dimRad = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-radius");
  const dimDia = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-diameter");
  push(
    "DIMRADIUS + DIMDIAMETER: canvas picks on the circle, measured SERVER-side",
    dimRad?.props.measured === 800 && dimRad?.props.target === circle.id &&
      dimDia?.props.measured === 1600 && close(dimDia?.props.angle, Math.PI / 2),
    `R=${dimRad && dimRad.props.measured} D=${dimDia && dimDia.props.measured}`,
  );

  // --- DIMANGULAR: entityPoint canvas picks on the two legs. -----------------
  await drv("typedInput", "DAN");
  await clickWorld(2000, 0); // ON the horizontal line
  await clickWorld(0, 1500); // ON the vertical line
  await drv("typedInput", "900,900"); // the arc placement selects the sector
  await syncDriverLog();
  snap = await docState();
  const dimAng = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-angular");
  push(
    "DIMANGULAR: leg picks + sector placement (associative refs)",
    dimAng !== undefined && close(dimAng.props.measured, Math.PI / 2) && dimAng.props.refs?.length === 2,
    `measured=${dimAng && dimAng.props.measured}`,
  );

  // --- LEADER + MLEADER. ------------------------------------------------------
  await drv("typedInput", "LE");
  await drv("typedInput", "3000,2000");
  await drv("typedInput", "3400,2400");
  await drv("typedInput", "3800,2400");
  await drv("typedInput", "");
  await drv("typedInput", "SEE DETAIL A");
  await drv("typedInput", "MLD");
  await drv("typedInput", "5000,-500");
  await drv("typedInput", "5600,-900");
  await drv("typedInput", "TWO\\nLINES");
  await syncDriverLog();
  snap = await docState();
  const leaderEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "leader");
  const mleaderEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "mleader");
  push(
    "LEADER + MLEADER created",
    leaderEl?.props.points?.length === 3 && leaderEl?.props.value === "SEE DETAIL A" && mleaderEl?.props.value === "TWO\nLINES",
    `leader=${leaderEl && leaderEl.props.points?.length} pts`,
  );

  // --- Styles → real annotation behavior. ------------------------------------
  await send("textStyle.create", { name: "Notes-Mono", font: "mono", height: 90, widthFactor: 0.8, obliqueAngle: 12 });
  await send("dimStyle.create", { name: "ISO-25", textHeight: 60, arrowSize: 45, scale: 1, precision: 1, arrowStyle: "tick", unitSuffix: " mm" });
  await send("drafting.setSettings", { settings: { textStyle: "Notes-Mono", dimStyle: "ISO-25" } });
  await drv("typedInput", "TEXT");
  await drv("typedInput", "2000,1500");
  await drv("typedInput", "50");
  await drv("typedInput", "0");
  await drv("typedInput", "STYLE-DRIVEN");
  await drv("typedInput", "DLI");
  await drv("typedInput", "0,-1000");
  await drv("typedInput", "3000,-1000");
  await drv("typedInput", "1500,-1600");
  await syncDriverLog();
  snap = await docState();
  const styledText = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text" && el.props?.value === "STYLE-DRIVEN");
  const styledDim = snap.elements.filter((el) => el.props?.annotation === true && el.props?.type === "dim-linear").at(-1);
  push(
    "styles drive creation: the style's FIXED height wins; dims reference the style",
    styledText?.props.height === 90 && styledText?.props.style === "Notes-Mono" && styledDim?.props.style === "ISO-25",
    `height=${styledText && styledText.props.height}`,
  );

  // --- annotation.update + DIMTEDIT (canvas pick on the dimension). ----------
  await send("annotation.update", { ids: [styledDim.id], patch: { textOverride: "≈3000" } });
  await drv("typedInput", "DIMTED");
  await clickWorld(1500, 600); // ON the horizontal dim line
  await drv("typedInput", "1500,1200");
  await syncDriverLog();
  snap = await docState();
  const teditDim = snap.elements.find((el) => el.id === dimH.id);
  push(
    "annotation.update textOverride + DIMTEDIT canvas pick stores textPos",
    snap.elements.find((el) => el.id === styledDim.id).props.textOverride === "≈3000" &&
      teditDim?.props.textPos?.x === 1500 && teditDim?.props.textPos?.y === 1200,
    `textPos=${JSON.stringify(teditDim && teditDim.props.textPos)}`,
  );

  // --- DIMSCALE. ---------------------------------------------------------------
  await drv("typedInput", "DIMSCALE");
  await drv("typedInput", "2");
  await syncDriverLog();
  snap = await docState();
  push("DIMSCALE: annotationScale standard persisted", snap.draftingSettings?.standards?.annotationScale === 2, "annotationScale=2");

  // --- The associative cascade through entity.modify. --------------------------
  const versionBefore = snap.version.version_number;
  await send("entity.modify", { op: "scale", ids: [circle.id], base: { x: 5000, y: 1000 }, factor: 1.5 });
  snap = await docState();
  const scaledRad = snap.elements.find((el) => el.id === dimRad.id);
  const scaledDia = snap.elements.find((el) => el.id === dimDia.id);
  push(
    "ASSOCIATIVE: scaling the circle re-measures radius + diameter in ONE revision",
    snap.version.version_number === versionBefore + 1 && scaledRad?.props.measured === 1200 && scaledDia?.props.measured === 2400,
    `R=${scaledRad && scaledRad.props.measured} D=${scaledDia && scaledDia.props.measured}`,
  );
  await send("entity.modify", { op: "rotate", ids: [vLine.id], base: { x: 0, y: 0 }, angle: -Math.PI / 4 });
  snap = await docState();
  const rotatedAng = snap.elements.find((el) => el.id === dimAng.id);
  push("ASSOCIATIVE: rotating a leg re-measures the angular dim", close(rotatedAng?.props.measured, Math.PI / 4, 1e-6), `measured=${rotatedAng && rotatedAng.props.measured}`);

  await send("document.undo", {});
  snap = await docState();
  const restoredAng = snap.elements.find((el) => el.id === dimAng.id);
  push("undo restores the geometry AND the dimension (one entry)", close(restoredAng?.props.measured, Math.PI / 2), `measured=${restoredAng && restoredAng.props.measured}`);

  // --- Disassociation through drafting.delete. ---------------------------------
  await send("drafting.delete", { ids: [circle.id] });
  snap = await docState();
  const disassociated = snap.elements.find((el) => el.id === dimRad.id);
  const remeasure = await send("annotation.remeasure", { ids: [dimRad.id] });
  push(
    "deleting the target disassociates; remeasure is a no-op",
    disassociated !== undefined && disassociated.props.target === null && disassociated.props.measured === 1200 && remeasure.value?.applied === false,
    `target=${disassociated && disassociated.props.target}`,
  );

  // --- Locked-layer enforcement. -------------------------------------------------
  const layerRes = await send("drafting.addLayer", { name: "A-ANNO-LOCKED", color: "#374151" });
  snap = await docState();
  const lockedLayer = (snap.layers ?? []).find((l) => l.name === "A-ANNO-LOCKED");
  await send("drafting.updateLayer", { layerId: lockedLayer.id, patch: { locked: true } });
  const lockedCreate = await send("annotation.create", {
    entities: [{ type: "text", layer: lockedLayer.id, x: 0, y: -2000, height: 100, rotation: 0, value: "LOCKED" }],
  });
  snap = await docState();
  const lockedText = snap.elements.find((el) => el.props?.value === "LOCKED");
  const lockedUpdate = await send("annotation.update", { ids: [lockedText.id], patch: { value: "CHANGED" } });
  push(
    "locked layer: creation allowed, modification typed-failed",
    lockedCreate.ok === true && lockedUpdate.ok === false && /locked/.test(lockedUpdate.message),
    lockedUpdate.message,
  );

  // --- Save/open round-trip. ------------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "roundtrip" });
  snap = await docState();
  const roundTripText = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text" && el.props?.value === "STYLE-DRIVEN");
  push(
    "save/open round-trip: every annotation field persists",
    roundTripText !== undefined && roundTripText.props.height === 90 &&
      (snap.dimStyles ?? []).some((s) => s.name === "ISO-25" && s.arrowStyle === "tick" && s.unitSuffix === " mm") &&
      snap.draftingSettings?.standards?.annotationScale === 2,
    "round-trip ok",
  );

  // --- The parity gate: fixture sha + command stream. ------------------------------
  stream.push("document.save");
  const s1 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  stream.push("document.save");
  const s2 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const sha1 = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
  const sha2 = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
  push("save is deterministic", sha1 === sha2, sha1.slice(0, 16) + "…");
  const sha = sha1;
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  push(
    "CAD-PARITY-005 fixture: save sha256 MATCH",
    fixture.saveSha256 === sha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${sha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-005 fixture: annotation count",
    fixture.annotations === snap.elements.filter((el) => el.kind === "annotation").length,
    `${snap.elements.filter((el) => el.kind === "annotation").length} annotations`,
  );
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-005 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON ANNOTATION SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON ANNOTATION SMOKE: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  if (verbose && err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  cleanup();
}
