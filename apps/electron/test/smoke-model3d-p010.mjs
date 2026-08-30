// CAD-PARITY-010 / Issue #93: model3d P010 Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode,
// and drives the REAL professional UI over the DevTools protocol — the
// command line (typedInput, the boolean/section/tessellate command
// vocabulary) and window.cad.send — through the SAME semantic command
// sequence the Web host's model3d-p010-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256, the semantic command stream, the engine echo digest, the
// EXACT-section sha, the canonical topology sha, the sub-entity pick face,
// the LOD vertex count, the cache counters AND the canonical 3D scene SVG
// hash (with the exact-section loops as the section facets) must equal the
// pinned CAD-PARITY-010 fixture (app/test/fixtures/cad-parity-010-model3d.json).
//
// Reproduce: cd apps/electron && node test/smoke-model3d-p010.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-model3d-p010.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-010-model3d.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-model3d-p010-smoke-"));
const displayNum = 200 + Math.floor(Math.random() * 100);
const display = `:${displayNum}`;

const env = {
  ...process.env,
  DISPLAY: display,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  ELECTRON_RUN_AS_NODE: "",
  // CAD-PARITY-010: the parity-fixture basis — the deterministic reference
  // adapter (the work item's engine-availability pattern: the command/parity
  // suites run over the reference engine; real-OCCT coverage runs in the CI
  // workspace-shell app tests + the local desktop default).
  OFFISOS_GEOMETRY_ENGINE: "reference",
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

  // --- Boot + document (the SAME create payload the Web smoke runs — parity).
  push("professional workspace mounts (the CAD-PARITY-002 shell)", true, "driver present");
  const created = await send("document.create", {
    entityId: "cad-parity-010-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-010-smoke",
  });
  push("document.create", created && created.ok === true, "ok");

  // --- The boolean triad through the REAL command line. ---------------------------
  await typed("BOX");
  await typed("4");
  await typed("4");
  await typed("4");
  await typed("");
  await typed("BOX");
  await typed("4");
  await typed("4");
  await typed("4");
  await typed("2,0,0");
  await typed("BOX");
  await typed("2");
  await typed("2");
  await typed("2");
  await typed("10,0,0");
  let snap = await docState();
  push(
    "BOX ×3 through the World UCS — the overlapping pair + the disjoint one",
    snap.elements.length === 3 && snap.elements[0].props.geometryEngine?.engineId === "reference",
    `${snap.elements[0].props.geometryEngine?.engineId} provenance`,
  );
  const revisionsAfterBoxes = snap.modelHistory.revisions.length;

  await typed("UNION");
  await typed("el-000001");
  await typed("el-000003");
  snap = await docState();
  const u = snap.elements.find((e) => e.id === "el-000004");
  push(
    "UNION — the operands consumed into ONE result solid (an atomic revision, provenance persisted)",
    snap.elements.length === 2 && u !== undefined && u.props.shape === "boolean" && u.props.op === "union" &&
      u.props.operands.length === 2 && u.props.operands[0].elementId === "el-000001" &&
      snap.modelHistory.revisions.length === revisionsAfterBoxes + 1 &&
      close(u.props.meshBBox[3], 12),
    "bbox x ∈ [0,12] exact",
  );

  await typed("INTERSECT");
  await typed("el-000002");
  await typed("el-000004");
  snap = await docState();
  const i = snap.elements.find((e) => e.id === "el-000005");
  push(
    "INTERSECT — the exact common cell of the union and the overlapping box",
    snap.elements.length === 1 && i !== undefined && i.props.op === "intersection" &&
      close(i.props.meshBBox[0], 2) && close(i.props.meshBBox[3], 4),
    "x ∈ [2,4] exact",
  );

  await typed("BOX");
  await typed("1");
  await typed("4");
  await typed("4");
  await typed("3,0,0");
  await typed("SUBTRACT");
  await typed("el-000005");
  await typed("el-000006");
  snap = await docState();
  const s = snap.elements.find((e) => e.id === "el-000007");
  push(
    "SUBTRACT — the composite minus the slab, ONE composite solid remains",
    snap.elements.length === 1 && s !== undefined && s.props.op === "difference" &&
      close(s.props.meshBBox[0], 2) && close(s.props.meshBBox[3], 3),
    "x ∈ [2,3] exact",
  );

  await typed("BOX");
  await typed("1");
  await typed("1");
  await typed("1");
  await typed("");
  await typed("BOX");
  await typed("1");
  await typed("1");
  await typed("1");
  await typed("50,0,0");
  const beforeDecline = await docState();
  const declined = await send("model3d.boolean", { op: "intersection", elementIds: ["el-000008", "el-000009"] });
  const afterDecline = await docState();
  push(
    "the disjoint intersection declines typed boolean_empty — the document untouched",
    declined.ok === false && declined.code === "boolean_empty" && afterDecline.elements.length === beforeDecline.elements.length,
    declined.code,
  );

  // --- The exact section + the section overlay through the REAL UI. -----------------
  await typed("SECTIONPLANE");
  await typed("Mid-X");
  await typed("2.5,0,0");
  await typed("1,0,0");
  await typed("SECTIONEXACT");
  await typed("Mid-X");
  snap = await docState();
  const section = (await cad({ type: "query", name: "model3d.section", payload: {} })).value;
  let onPlane = true;
  for (const facet of section.section.facets) {
    for (const loop of facet.loops) for (const p of loop) if (!close(p[0], 2.5)) onPlane = false;
  }
  push(
    "SECTIONPLANE + SECTIONEXACT — the exact adapter-backed section (canonical loops on the plane)",
    (snap.sectionPlanes ?? []).length === 1 && section.exact === true && section.section.facets.length >= 1 && onPlane &&
      section.section.missedElementIds.length >= 1,
    `${section.section.facets.length} facet(s), hash ${section.hash.slice(0, 12)}…`,
  );

  // --- Deterministic topology-aware picking. ------------------------------------------
  await typed("VPOINT");
  await typed("Top");
  const topo = (await cad({ type: "query", name: "model3d.topology", payload: { elementId: "el-000007" } })).value;
  const b = topo ? null : null;
  snap = await docState();
  const bbox = snap.elements[0].props.meshBBox;
  const pr = await drv("model3dProjectPoint", [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, bbox[5]]);
  const subPick = (await cad({ type: "query", name: "model3d.pick", payload: { elementId: "el-000007", subEntityKind: "face", screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 } } })).value;
  const globalPick = (await cad({ type: "query", name: "model3d.pick", payload: { screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 } } })).value;
  const globalDecline = await cad({ type: "query", name: "model3d.pick", payload: { screenX: pr.x, screenY: pr.y, viewport: { width: 800, height: 600 }, subEntity: true } });
  push(
    "topology + the per-element sub-entity face pick (exactly ordered) + the P009 global surface preserved",
    topo.counts.faces >= 6 && topo.hash.length === 64 && subPick.count >= 1 && subPick.hits[0].kind === "face" &&
      close(subPick.hits[0].point[2], bbox[5]) && globalPick.hits[0].elementId === "el-000007" &&
      globalDecline.ok === false && globalDecline.code === "subentity_unsupported",
    `face ${subPick.hits[0].canonicalId}, ${topo.counts.faces} faces`,
  );

  // --- The mesh entity + progressive LOD delivery. --------------------------------------
  await typed("TESSELLATE");
  await typed("el-000007");
  await typed("low");
  snap = await docState();
  const meshEntity = snap.elements.find((e) => e.props?.type === "model3d.mesh");
  const full = (await cad({ type: "query", name: "model3d.mesh", payload: { elementId: "el-000007", quality: "full" } })).value;
  const low = (await cad({ type: "query", name: "model3d.mesh", payload: { elementId: "el-000007", quality: "low" } })).value;
  const cached = (await cad({ type: "query", name: "model3d.mesh", payload: { elementId: "el-000007", quality: "full" } })).value;
  const stats = (await cad({ type: "query", name: "model3d.cacheStats", payload: {} })).value;
  push(
    "TESSELLATE — the persisted model3d.mesh entity + the bounded LOD cache evidence",
    meshEntity !== undefined && meshEntity.props.quality === "low" && meshEntity.props.sourceElementId === "el-000007" &&
      full.withinBudget === true && low.withinBudget === true && cached.meshToken === full.meshToken &&
      stats.cache.hits >= 2 && stats.cache.misses >= 2 && stats.budgets.meshLodMaxVertices === 150000,
    `${full.vertices} verts @full, cache ${stats.cache.hits}/${stats.cache.misses}/${stats.cache.entries}`,
  );

  // --- The 3D Model view surface (the REAL UI, with the exact-section overlay). ---------
  await drv("setModel3dView", true);
  const info = await drv("model3dInfo");
  const sceneSvg = await drv("model3dExactSectionSvg", ["el-000007"]);
  const svgSha = sceneSvg === null ? null : createHash("sha256").update(sceneSvg).digest("hex");
  push(
    "the 3D Model view — the shared viewport + the canonical EXACT-section scene",
    info.active === true && info.solidCount === 3 && sceneSvg !== null && sceneSvg.startsWith("<svg") && /data-format="offisos-scene3d-svg"/.test(sceneSvg),
    (svgSha ?? "").slice(0, 16) + "…",
  );

  // --- Undo/redo integrity (five revisions deep). -----------------------------------------
  await send("document.undo", {});
  await send("document.undo", {});
  await send("document.undo", {});
  await send("document.undo", {});
  await send("document.undo", {});
  snap = await docState();
  push(
    "undo ×5 — the boolean batch inverse restores BOTH operands",
    snap.elements.some((e) => e.id === "el-000005") && snap.elements.some((e) => e.id === "el-000006") &&
      (snap.sectionPlanes ?? []).length === 0,
    "el-000005 + el-000006 back",
  );
  await send("document.redo", {});
  snap = await docState();
  const redone = snap.elements.find((e) => e.id === "el-000007");
  push("redo — the composite solid reproduced with its provenance", redone !== undefined && redone.props.shape === "boolean" && redone.props.op === "difference", "el-000007");
  await send("document.redo", {});
  await send("document.redo", {});
  await send("document.redo", {});
  await send("document.redo", {});
  snap = await docState();
  push("redo ×5 — the full pre-undo state restored", snap.elements.length === 4 && (snap.sectionPlanes ?? []).length === 1, "4 elements + 1 plane");

  // --- Save/open round-trip. -----------------------------------------------------------------
  const saved = await send("document.save", {});
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-010-smoke-reopened" });
  snap = await docState();
  const reopenedSolid = snap.elements.find((e) => e.id === "el-000007");
  const reopenedMesh = snap.elements.find((e) => e.props?.type === "model3d.mesh");
  const sectionReopened = (await cad({ type: "query", name: "model3d.section", payload: {} })).value;
  push(
    "save/open — the boolean/mesh/section state persists exactly",
    reopenedSolid !== undefined && reopenedSolid.props.shape === "boolean" && reopenedMesh !== undefined && reopenedMesh.props.quality === "low" &&
      (snap.sectionPlanes ?? []).length === 1 && sectionReopened.hash === section.hash,
    "round-trip ok",
  );
  await send("document.open", { source: saved.value.bytes, entityId: "cad-parity-010-smoke-final" });

  // --- The parity gate: fixture sha + command stream + scene SVG + echo digest. ---------------
  const s1 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const s2 = (await cad({ type: "command", name: "document.save", payload: {} })).value;
  const sha1 = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
  const sha2 = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
  push("save is deterministic", sha1 === sha2, sha1.slice(0, 16) + "…");
  const saveSha = sha1;
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  push(
    "CAD-PARITY-010 fixture: save sha256 MATCH",
    fixture.saveSha256 === saveSha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${saveSha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-010 fixture: element/solid/mesh/plane counts",
    fixture.elements === snap.elements.length && fixture.solids === snap.elements.filter((e) => e.props?.type === "model3d.solid").length &&
      fixture.meshEntities === snap.elements.filter((e) => e.props?.type === "model3d.mesh").length && fixture.sectionPlanes === (snap.sectionPlanes ?? []).length,
    `${snap.elements.length} elements, ${(snap.sectionPlanes ?? []).length} planes`,
  );
  push(
    "CAD-PARITY-010 fixture: canonical 3D scene SVG sha256 MATCH (the exact-section facets)",
    svgSha !== null && fixture.sceneSvgSha256 === svgSha,
    `expected ${fixture.sceneSvgSha256.slice(0, 16)}…, got ${(svgSha ?? "").slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-010 fixture: exact-section sha256 MATCH",
    fixture.sectionSha256 === section.hash,
    `expected ${fixture.sectionSha256.slice(0, 16)}…, got ${section.hash.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-010 fixture: topology sha256 + sub-entity face MATCH",
    fixture.topologySha256 === topo.hash && fixture.subPickFace === subPick.hits[0].canonicalId,
    `face ${subPick.hits[0].canonicalId}, ${topo.hash.slice(0, 12)}…`,
  );
  push(
    "CAD-PARITY-010 fixture: LOD vertex count + cache counters MATCH",
    fixture.lodFullVertices === full.vertices && fixture.cacheStats === `${stats.cache.hits}/${stats.cache.misses}/${stats.cache.entries}`,
    `${full.vertices} verts, ${stats.cache.hits}/${stats.cache.misses}/${stats.cache.entries}`,
  );
  const echoLines = await drv("echoLog");
  const echoDigest = createHash("sha256").update(echoLines.join("\n")).digest("hex");
  push(
    "CAD-PARITY-010 fixture: engine echo digest MATCH (the semantic command stream echoes)",
    fixture.echoDigest === echoDigest,
    `expected ${fixture.echoDigest.slice(0, 16)}…, got ${echoDigest.slice(0, 16)}…`,
  );
  await syncDriverLog();
  stream.push("document.save");
  stream.push("document.save");
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-010 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON MODEL3D P010 SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON MODEL3D P010 SMOKE: ERROR — ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
