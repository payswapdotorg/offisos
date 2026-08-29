// CAD-PARITY-006 / Issue #84: Blocks/References Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, typed coordinates), the Model canvas
// (world-coordinate clicks for the ENTITY picks: the BLOCK source objects,
// the ATTEDIT instance) and window.cad.send — through the SAME semantic
// command sequence the Web host's blocks-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256 AND the semantic command stream must equal the pinned
// CAD-PARITY-006 fixture (app/test/fixtures/cad-parity-006-blocks.json).
//
// Reproduce: cd apps/electron && node test/smoke-blocks.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-blocks.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-006-blocks.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-blocks-smoke-"));
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
  const created = await send("document.create", { entityId: "cad-parity-006-smoke", format: "offisos-occt", formatVersion: "1", createdBy: "cad-parity-006-smoke" });
  push("professional workspace + document.create", created && created.ok === true, "ok");

  // --- Source geometry through the REAL command line (LINE + CIRCLE + TEXT). -
  await drv("typedInput", "LINE");
  await drv("typedInput", "0,0");
  await drv("typedInput", "2000,0");
  await drv("typedInput", "");
  await drv("typedInput", "CIRCLE");
  await drv("typedInput", "1000,600");
  await drv("typedInput", "400");
  await drv("typedInput", "TEXT");
  await drv("typedInput", "0,-300");
  await drv("typedInput", "90");
  await drv("typedInput", "");
  await drv("typedInput", "DEMO BLOCK");
  await syncDriverLog();
  let snap = await docState();
  push("source geometry drawn (LINE + CIRCLE + TEXT via the command line)", snap.elements.length === 3, `${snap.elements.length} elements`);

  // --- BLOCK through the command line with REAL canvas ENTITY picks. --------
  await drv("typedInput", "ZOOMEXTENTS");
  await drv("typedInput", "BLOCK");
  await drv("typedInput", "DEMO-SYMBOL");
  await drv("typedInput", "0,0");
  await clickWorld(1000, 0); // the LINE
  await sleep(120);
  await clickWorld(1400, 600); // the CIRCLE stroke
  await sleep(120);
  await clickWorld(200, -250); // the TEXT
  await sleep(120);
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const def = snap.blockDefs?.[0];
  push(
    "BLOCK: 3 sources converted into ONE atomic revision (definition + removal)",
    snap.elements.length === 0 && def !== undefined && def.name === "DEMO-SYMBOL" && def.entities.length === 3,
    def ? `${def.name}: ${def.entities.length} entities` : "no definition",
  );
  const revisionsBefore = snap.modelHistory.revisions.length;
  const undone = await send("document.undo", {});
  snap = await docState();
  push("BLOCK undo restores sources + definition together", undone.ok === true && snap.elements.length === 3 && (snap.blockDefs ?? []).length === 0, "atomic");
  const redone = await send("document.redo", {});
  snap = await docState();
  push("BLOCK redo re-converts", redone.ok === true && snap.elements.length === 0 && (snap.blockDefs ?? []).length === 1, "converged");
  void revisionsBefore;

  // --- ATTDEF ×2 through the command line (definition editing). -------------
  await drv("typedInput", "ATTDEF");
  await drv("typedInput", "DEMO-SYMBOL");
  await drv("typedInput", "TITLE");
  await drv("typedInput", "Drawing title");
  await drv("typedInput", "UNTITLED");
  await drv("typedInput", "0,-600");
  await drv("typedInput", "90");
  await drv("typedInput", "");
  await drv("typedInput", "ATTDEF");
  await drv("typedInput", "DEMO-SYMBOL");
  await drv("typedInput", "SHEET_NO");
  await drv("typedInput", "");
  await drv("typedInput", "A-000");
  await drv("typedInput", "0,-800");
  await drv("typedInput", "90");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const attdefs = (snap.blockDefs?.[0]?.entities ?? []).filter((e) => e.type === "attdef");
  push(
    "ATTDEF ×2: attribute slots added to the definition",
    attdefs.length === 2 && attdefs[0].tag === "TITLE" && attdefs[0].default === "UNTITLED" && attdefs[1].tag === "SHEET_NO",
    attdefs.map((a) => a.tag).join(","),
  );

  // --- INSERT with the DYNAMIC per-attribute value prompts. ------------------
  await drv("typedInput", "INSERT");
  await drv("typedInput", "DEMO-SYMBOL");
  await drv("typedInput", "3000,3000");
  await drv("typedInput", "1.5");
  await drv("typedInput", "");
  await drv("typedInput", "SITE PLAN A");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const instance = snap.elements[0];
  push(
    "INSERT: instance placed with the typed attribute value only (Enter = default)",
    instance !== undefined && instance.props.type === "block-ref" && close(instance.props.scale, 1.5) &&
      instance.props.attributes?.length === 1 && instance.props.attributes[0].tag === "TITLE" && instance.props.attributes[0].value === "SITE PLAN A",
    instance ? `at (${instance.props.x},${instance.props.y}) ×${instance.props.scale}` : "missing",
  );

  // --- BLOCKLIST through the command line. -----------------------------------
  await drv("typedInput", "BLOCKLIST");
  await syncDriverLog();
  const status = await drv("status");
  push(
    "BLOCKLIST echoes the definition inventory",
    (status.history ?? []).some((l) => String(l).includes("DEMO-SYMBOL") && String(l).includes("TITLE")),
    "inventory echoed",
  );

  // --- ATTEDIT: pick the instance on the canvas → tag → new value. -----------
  // The instance content circle: (3000,3000) + 1.5·(1000,600) = (4500,3900),
  // r = 600 → click the stroke at (5100,3900).
  await drv("typedInput", "ZOOMEXTENTS");
  await drv("typedInput", "ATTEDIT");
  await clickWorld(5100, 3900);
  await sleep(150);
  await drv("typedInput", "TITLE");
  await drv("typedInput", "SITE PLAN B");
  await syncDriverLog();
  snap = await docState();
  push(
    "ATTEDIT: canvas pick of the instance + value rewrite",
    snap.elements[0].props.attributes?.[0]?.value === "SITE PLAN B",
    "value rewritten",
  );

  // --- attribute.update through the API (the inspector write path). ----------
  const upd = await send("attribute.update", { id: instance.id, tag: "SHEET_NO", value: "A-101" });
  const clear = await send("attribute.update", { id: instance.id, tag: "SHEET_NO", value: null });
  snap = await docState();
  push(
    "attribute.update: set + clear-to-default through the inspector path",
    upd.ok === true && clear.ok === true && !snap.elements[0].props.attributes?.some((a) => a.tag === "SHEET_NO"),
    "cleared key absent",
  );

  // --- Instance placement transforms + the MIRROR typed decline. -------------
  const moved = await send("entity.modify", { op: "move", ids: [instance.id], dx: 1000, dy: -500 });
  const rotated = await send("entity.modify", { op: "rotate", ids: [instance.id], base: { x: 0, y: 0 }, angle: Math.PI / 2 });
  const scaled = await send("entity.modify", { op: "scale", ids: [instance.id], base: { x: 0, y: 0 }, factor: 2 });
  const copied = await send("entity.modify", { op: "copy", ids: [instance.id], dx: 500, dy: 500 });
  snap = await docState();
  const copyEl = snap.elements.find((el) => el.props.type === "block-ref" && close(el.props.x, -4500));
  push(
    "instance MOVE/ROTATE/SCALE/COPY transform the placement exactly",
    moved.ok && rotated.ok && scaled.ok && copied.ok &&
      close(snap.elements.find((el) => el.id === instance.id).props.x, -5000) &&
      close(snap.elements.find((el) => el.id === instance.id).props.scale, 3) &&
      copyEl !== undefined,
    "placement composed",
  );
  const mirrorDecline = await cad({ type: "command", name: "entity.modify", payload: { op: "mirror", ids: [instance.id], p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } } });
  stream.push("entity.modify");
  push("MIRROR on instances is the typed decline", mirrorDecline.ok === false && mirrorDecline.code === "mirror_unsupported", mirrorDecline.message);

  // --- EXPLODE (one level) + the undo/redo walk. -----------------------------
  const exploded = await send("entity.modify", { op: "explode", ids: [instance.id] });
  snap = await docState();
  const materializedTexts = snap.elements.filter((el) => el.kind === "annotation" && el.props?.type === "text");
  push(
    "EXPLODE: one-level materialization (attributes become text)",
    exploded.ok === true && exploded.value.applied === true && snap.elements.length === 6 && materializedTexts.length === 3 &&
      materializedTexts.some((t) => t.props.value === "SITE PLAN B") && materializedTexts.some((t) => t.props.value === "A-000"),
    `${snap.elements.length} elements`,
  );
  await send("document.undo", {});
  snap = await docState();
  const undoOk = snap.elements.length === 2 && snap.elements.every((el) => el.props.type === "block-ref");
  await send("document.redo", {});
  snap = await docState();
  push("EXPLODE undo/redo walk converges", undoOk && snap.elements.length === 6, "atomic");

  // --- Nested blocks: BLOCK from the surviving instance (canvas pick). -------
  // After the walk the surviving block-ref is the COPY at (-4500, 8500),
  // scale 3, rotation π/2 — its content circle center is (-6300, 11500),
  // r = 1200 → click the stroke at (-5100, 11500).
  await drv("typedInput", "ZOOMEXTENTS");
  await drv("typedInput", "BLOCK");
  await drv("typedInput", "NESTED-HOLDER");
  await drv("typedInput", "0,0");
  await clickWorld(-5100, 11500);
  await sleep(150);
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const nestedDef = snap.blockDefs?.find((b) => b.name === "NESTED-HOLDER");
  push(
    "nested BLOCK: an instance becomes inline block-ref content",
    nestedDef !== undefined && nestedDef.entities.length === 1 && nestedDef.entities[0].type === "block-ref",
    nestedDef ? "nested reference stored" : "missing",
  );
  await drv("typedInput", "INSERT");
  await drv("typedInput", "NESTED-HOLDER");
  await drv("typedInput", "-5000,-5000");
  await drv("typedInput", "");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  const nestedInstance = snap.elements.find((el) => el.props.type === "block-ref" && close(el.props.x, -5000));
  push("nested INSERT placed", nestedInstance !== undefined, `at ${nestedInstance && nestedInstance.props.x}`);
  const nestedExplode = await send("entity.modify", { op: "explode", ids: [nestedInstance.id] });
  snap = await docState();
  push(
    "nested EXPLODE: one level per explode (the inner reference becomes independent)",
    nestedExplode.ok === true && snap.elements.some((el) => el.props.type === "block-ref" && el.props.blockId === def.id),
    "inner reference independent",
  );

  // --- The bounded xref lifecycle. --------------------------------------------
  await drv("typedInput", "XATTACH");
  await drv("typedInput", "MISSING-REF");
  await drv("typedInput", "missing.offisos");
  await drv("typedInput", "20000,0");
  await drv("typedInput", "");
  await drv("typedInput", "");
  await syncDriverLog();
  snap = await docState();
  push(
    "XATTACH: unresolved reference + instance (the command-line bound)",
    (snap.xrefs ?? []).length === 1 && snap.xrefs[0].status === "unresolved" && snap.elements.some((el) => el.props.type === "xref-ref" && el.props.x === 20000),
    "placeholder rendering",
  );
  await drv("typedInput", "XRELOAD");
  await syncDriverLog();
  const status2 = await drv("status");
  push(
    "XRELOAD: the typed decline points at the References palette",
    (status2.history ?? []).some((l) => String(l).includes("References palette")),
    "declined",
  );
  await drv("typedInput", "XLIST");
  await syncDriverLog();
  const status3 = await drv("status");
  push(
    "XLIST: status diagnostics through the command line",
    (status3.history ?? []).some((l) => String(l).includes("MISSING-REF") && String(l).includes("unresolved")),
    "listed",
  );
  // The palette path: attach WITH content + reload with fresh content.
  snap = await docState();
  const externalState = {
    version: snap.version,
    format: snap.format,
    formatVersion: snap.formatVersion,
    sourceArtifactLineage: [],
    editorState: snap.editorState,
    elements: [
      { id: "ext-1", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", x1: 0, y1: 0, x2: 5000, y2: 0 } },
      { id: "ext-2", kind: "annotation", engineId: null, props: { drafting: true, annotation: true, type: "text", layer: "0", x: 0, y: 500, height: 200, rotation: 0, value: "EXTERNAL SITE" } },
    ],
  };
  const attached = await send("xref.attach", { name: "SITE", path: "site.offisos", x: 30000, y: 0, scale: 2, rotation: 0, content: externalState });
  snap = await docState();
  push(
    "xref.attach with content: loaded + provenance hash + instance (one revision)",
    attached.ok === true && attached.value.status === "loaded" && attached.value.resolved === 2 && /^[0-9a-f]{64}$/.test(attached.value.sourceHash),
    `sourceHash ${attached.value.sourceHash.slice(0, 12)}…`,
  );
  const externalStateV2 = { ...externalState, elements: [...externalState.elements, { id: "ext-3", kind: "geometry", engineId: null, props: { drafting: true, type: "circle", layer: "0", cx: 2500, cy: 1000, r: 800 } }] };
  const reloaded = await send("xref.reload", { name: "SITE", content: externalStateV2 });
  snap = await docState();
  push(
    "xref.reload: fresh content re-resolved",
    reloaded.ok === true && reloaded.value.resolved === 3 && snap.xrefs.find((x) => x.name === "SITE").entities.length === 3,
    "3 entities",
  );
  const detached = await send("xref.detach", { name: "SITE" });
  snap = await docState();
  push(
    "xref.detach: record + instances removed in ONE atomic revision",
    detached.ok === true && detached.value.removedInstances === 1 && !snap.xrefs.some((x) => x.name === "SITE"),
    "cascade atomic",
  );

  // --- Save/open round-trip. ---------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-006-smoke-reopened" });
  snap = await docState();
  push(
    "save/open round-trip: the blocks world persists",
    (snap.blockDefs ?? []).length === 2 && (snap.xrefs ?? []).length === 1 && snap.xrefs[0].name === "MISSING-REF" &&
      snap.elements.some((el) => el.props.type === "xref-ref" && el.props.xrefId === snap.xrefs[0].id),
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
    "CAD-PARITY-006 fixture: save sha256 MATCH",
    fixture.saveSha256 === sha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${sha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-006 fixture: blocks/xrefs counts",
    fixture.blockDefs === snap.blockDefs.length && fixture.xrefs === snap.xrefs.length,
    `${snap.blockDefs.length} definitions; ${snap.xrefs.length} xrefs`,
  );
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-006 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON BLOCKS SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON BLOCKS SMOKE: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  if (verbose && err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  cleanup();
}
