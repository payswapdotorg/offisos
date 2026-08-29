// CAD-PARITY-007 / Issue #86: Parametric-constraints Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, typed coordinates), the Model canvas
// (world-coordinate clicks for the ENTITY/ENTITY-POINT picks: the
// constraint targets, the coincident anchors) and window.cad.send — through
// the SAME semantic command sequence the Web host's constraints-smoke.mjs
// runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256 AND the semantic command stream must equal the pinned
// CAD-PARITY-007 fixture (app/test/fixtures/cad-parity-007-constraints.json).
//
// Reproduce: cd apps/electron && node test/smoke-constraints.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-constraints.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-007-constraints.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-constraints-smoke-"));
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
  // The circle props may be EITHER storage convention (the command line
  // draws the legacy {center, radius} form; constraint solves rewrite the
  // canonical {cx, cy, r} form) — read both.
  const circleCx = (el) => (el.props.cx !== undefined ? el.props.cx : el.props.center[0]);
  const circleCy = (el) => (el.props.cy !== undefined ? el.props.cy : el.props.center[1]);
  const circleR = (el) => (el.props.r !== undefined ? el.props.r : el.props.radius);

  // --- Fresh document (the SAME entityId the Web smoke uses). ----------------
  const created = await send("document.create", { entityId: "cad-parity-007-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-007-smoke" });
  push("professional workspace + document.create", created && created.ok === true, "ok");

  // --- The constrained-drawing geometry through the REAL command line. -------
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,0");
  await drv("typedInput", "2000,600");
  await drv("typedInput", "");
  await drv("typedInput", "LINE");
  await drv("typedInput", "2000,600");
  await drv("typedInput", "3000,1400");
  await drv("typedInput", "");
  await drv("typedInput", "CIRCLE");
  await drv("typedInput", "4200,0");
  await drv("typedInput", "400");
  await syncDriverLog();
  let snap = await docState();
  const lines = snap.elements.filter((el) => el.props?.type === "line");
  const circleEl = snap.elements.find((el) => el.props?.type === "circle");
  push("source geometry drawn (LINE ×2 + CIRCLE via the command line)", snap.elements.length === 3, `${snap.elements.length} elements`);

  // --- GEOMCONSTRAINT Horizontal: canvas pick of the base line. --------------
  await drv("typedInput", "ZOOMEXTENTS");
  await drv("typedInput", "GC");
  await drv("typedInput", "Horizontal");
  await clickWorld(1000, 300); // the base line midpoint (pre-level position)
  await sleep(200);
  await syncDriverLog();
  snap = await docState();
  const base = snap.elements.find((el) => el.id === lines[0].id);
  push(
    "GEOMCONSTRAINT Horizontal: the closed form levels the base (canvas pick)",
    (snap.constraints ?? []).length === 1 && snap.constraints[0].kind === "horizontal" && close(base.props.y2, 0),
    "leveled + declared in one revision",
  );

  // --- GEOMCONSTRAINT Coincident: canvas entityPoint picks near the anchors. -
  // Base (0,0)-(2000,0): click near its END; the diagonal (2000,600)-(3000,1400)
  // (pre-solve): click near its START.
  await drv("typedInput", "GC");
  await drv("typedInput", "Coincident");
  await clickWorld(1980, 20);
  await sleep(200);
  await clickWorld(2010, 610);
  await sleep(200);
  await syncDriverLog();
  snap = await docState();
  const diagonal = snap.elements.find((el) => el.id === lines[1].id);
  const coincident = snap.constraints?.find((c) => c.kind === "coincident");
  push(
    "GEOMCONSTRAINT Coincident: nearest anchors resolved from the canvas picks",
    coincident !== undefined && coincident.targets[0].anchor === "end" && coincident.targets[1].anchor === "start" &&
      close(diagonal.props.x1, 2000) && close(diagonal.props.y1, 0),
    "end → start coupled",
  );

  // --- DIMCONSTRAINT Length: canvas pick + Enter keeps the CURRENT length. ---
  await drv("typedInput", "DC");
  await drv("typedInput", "Length");
  await clickWorld(1000, 0); // the leveled base midpoint
  await sleep(200);
  await drv("typedInput", ""); // Enter accepts the dynamic default (2000)
  await syncDriverLog();
  snap = await docState();
  const lengthConstraint = snap.constraints?.find((c) => c.kind === "distance");
  push(
    "DIMCONSTRAINT Length: the dynamic default keeps the current length",
    lengthConstraint !== undefined && close(lengthConstraint.value, 2000),
    `declared ${lengthConstraint && lengthConstraint.value}`,
  );

  // --- Undo/redo converge (one revision each). -------------------------------
  await send("document.undo", {});
  snap = await docState();
  const undoOk = (snap.constraints ?? []).length === 2;
  await send("document.redo", {});
  snap = await docState();
  push("constraint undo/redo converge (declaration + geometry together)", undoOk && (snap.constraints ?? []).length === 3, "atomic");

  // --- constraint.update re-solves (the declared value drives geometry). -----
  const lengthId = snap.constraints.find((c) => c.kind === "distance").id;
  const upd = await send("constraint.update", { id: lengthId, patch: { value: 2500 } });
  snap = await docState();
  const base2500 = snap.elements.find((el) => el.id === lines[0].id);
  const diag2500 = snap.elements.find((el) => el.id === lines[1].id);
  push(
    "constraint.update re-solves: the base extends + the partner follows",
    upd.ok === true && close(base2500.props.x2, 2500) && close(diag2500.props.x1, 2500),
    "propagated",
  );

  // --- The associative dimension re-measures through a constraint update. ----
  const anno = await send("annotation.create", {
    entities: [{
      type: "dim-linear",
      layer: "0",
      p1: { x: 0, y: 0 },
      p2: { x: 2500, y: 0 },
      placement: { x: 1250, y: -400 },
      mode: "horizontal",
      measured: 2500,
      refs: [
        { id: lines[0].id, anchor: "start", to: "p1" },
        { id: lines[0].id, anchor: "end", to: "p2" },
      ],
    }],
  });
  const upd2 = await send("constraint.update", { id: lengthId, patch: { value: 3000 } });
  snap = await docState();
  const dim = snap.elements.find((el) => el.props?.type === "dim-linear");
  push(
    "associative dimension re-measures through the constraint update (one revision)",
    anno.ok === true && upd2.ok === true && close(dim.props.measured, 3000) && close(dim.props.p2.x, 3000),
    `measured ${dim && dim.props.measured}`,
  );

  // --- Constraint-aware MOVE: the coincident partner follows. ----------------
  const move = await send("entity.modify", { op: "move", ids: [lines[0].id], dx: 400, dy: 300 });
  snap = await docState();
  const baseMoved = snap.elements.find((el) => el.id === lines[0].id);
  const diagMoved = snap.elements.find((el) => el.id === lines[1].id);
  push(
    "constraint-aware MOVE: the coincident partner re-couples to the base end",
    move.ok === true && close(baseMoved.props.x1, 400) && close(baseMoved.props.y1, 300) &&
      close(diagMoved.props.x1, baseMoved.props.x2) && close(diagMoved.props.y1, baseMoved.props.y2),
    "partner followed",
  );

  // --- GEOMCONSTRAINT Tangent (diagonal + circle) + Fixed (circle). ----------
  // The picks read the LIVE geometry (post-solve positions): the diagonal
  // (3400,300)-(3000,1400) midpoint and the circle stroke.
  await drv("typedInput", "ZOOMEXTENTS");
  await drv("typedInput", "GC");
  await drv("typedInput", "Tangent");
  await clickWorld(3200, 850); // the diagonal midpoint
  await sleep(200);
  await clickWorld(circleCx(circleEl) + circleR(circleEl), circleCy(circleEl)); // the circle stroke
  await sleep(200);
  await syncDriverLog();
  snap = await docState();
  push(
    "GEOMCONSTRAINT Tangent: line↔circle tangency solved (circle adjusts)",
    (snap.constraints ?? []).some((c) => c.kind === "tangent"),
    "tangent declared + solved",
  );
  // Fixed: read the MOVED circle position for the pick.
  const circleNow = snap.elements.find((el) => el.id === circleEl.id);
  await drv("typedInput", "GC");
  await drv("typedInput", "Fixed");
  await clickWorld(circleCx(circleNow) + circleR(circleNow) * 0.7, circleCy(circleNow) + circleR(circleNow) * 0.7);
  await sleep(200);
  await syncDriverLog();
  snap = await docState();
  push("GEOMCONSTRAINT Fixed: the circle pinned", (snap.constraints ?? []).some((c) => c.kind === "fixed"), "fixed declared");

  // --- A moved FIXED entity restores inside the same revision. ---------------
  const fixedCircleBefore = snap.elements.find((el) => el.id === circleEl.id);
  const fixedMove = await send("entity.modify", { op: "move", ids: [circleEl.id], dx: 1000, dy: 0 });
  snap = await docState();
  const fixedCircleAfter = snap.elements.find((el) => el.id === circleEl.id);
  push(
    "a moved FIXED entity restores inside the same revision",
    fixedMove.ok === true && fixedMove.value.summary.includes("restored to its fixed position") &&
      close(circleCx(fixedCircleAfter), circleCx(fixedCircleBefore)) && close(circleCy(fixedCircleAfter), circleCy(fixedCircleBefore)),
    "restored",
  );

  // --- The deterministic ARRAY pattern + undo. -------------------------------
  const before = snap.elements.length;
  const array = await send("entity.modify", { op: "array", mode: "rectangular", ids: [lines[1].id], rows: 2, columns: 2, rowSpacing: 800, columnSpacing: 600 });
  snap = await docState();
  const arrayOk = array.ok === true && snap.elements.length === before + 3;
  await send("document.undo", {});
  snap = await docState();
  push(
    "ARRAY (rectangular): deterministic copies in ONE revision; undo removes them",
    arrayOk && snap.elements.length === before,
    "3 copies minted + undone",
  );

  // --- constraint.solve: the explicit diagnostics surface. -------------------
  const solve = await send("constraint.solve", {});
  snap = await docState();
  const diag = (await cad({ type: "query", name: "constraints.diagnostics", payload: {} })).value;
  push(
    "constraint.solve + constraints.diagnostics agree (typed outcome + DoF)",
    solve.ok === true && solve.value.outcome === diag.outcome && Array.isArray(diag.dof) && diag.dof.length > 0,
    `outcome ${solve.value.outcome}`,
  );

  // --- Severance: deleting the circle removes its constraints atomically. ----
  const del = await send("drafting.delete", { ids: [circleEl.id] });
  snap = await docState();
  push(
    "severance: drafting.delete removes the circle's constraints in the SAME revision",
    del.ok === true && del.value.summary.includes("2 constraints severed") && (snap.constraints ?? []).length === 3,
    del.value.summary,
  );

  // --- DELCONSTRAINT: release the remaining constraints of the base. ---------
  await drv("typedInput", "DCON");
  await clickWorld(1650, 300); // the base midpoint (current position)
  await sleep(200);
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  push(
    "DELCONSTRAINT: every constraint referencing the base released",
    snap.constraints === undefined || snap.constraints.length === 0,
    "released",
  );

  // --- Save/open round-trip. ---------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-007-smoke-reopened" });
  snap = await docState();
  push(
    "save/open round-trip: the constrained world persists",
    snap.elements.length === 3 && (snap.constraints ?? []).length === 0,
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
    "CAD-PARITY-007 fixture: save sha256 MATCH",
    fixture.saveSha256 === sha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${sha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-007 fixture: element count",
    fixture.elements === snap.elements.length,
    `${snap.elements.length} elements`,
  );
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-007 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON CONSTRAINTS SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON CONSTRAINTS SMOKE: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  if (verbose && err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  cleanup();
}
