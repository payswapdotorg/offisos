// CAD-PARITY-011 / Issue #97: BIM P011 Electron smoke runner.
//
// Launches a headless Xvfb display, then the Electron host in NORMAL mode
// (the professional workspace mounts on boot), and drives the REAL UI over
// the DevTools protocol — the command line (typedInput: STORY/WALL/ROOF/
// STAIR/RAILING/ZONE/OPTION/RENOVATE, the P011 registry vocabulary) and
// window.cad.send (the lifecycle API surface the workbench panels produce) —
// through the SAME semantic command sequence the Web host's
// bim-p011-smoke.mjs runs.
//
// Web/Electron parity is the acceptance criterion (LOCK-004): the document
// save sha256, the semantic command stream, the echo digest, the
// semantics/lifecycle/options digests, the build token digest and the
// element counts must equal the pinned CAD-PARITY-011 fixture
// (app/test/fixtures/cad-parity-011-bim.json).
//
// Reproduce: cd apps/electron && node test/smoke-bim-p011.mjs
// Verbose:   OFFISOS_SMOKE_VERBOSE=1 node test/smoke-bim-p011.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const APP = join(import.meta.dirname, "..");
const REPO_ROOT = join(APP, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-011-bim.json");

const electronExe =
  existsSync(join(APP, "node_modules", "electron", "dist", "electron"))
    ? join(APP, "node_modules", "electron", "dist", "electron")
    : "electron";

const tmp = mkdtempSync(join(tmpdir(), "offisos-electron-bim-p011-smoke-"));
const displayNum = 500 + Math.floor(Math.random() * 100);
const display = `:${displayNum}`;

const env = {
  ...process.env,
  DISPLAY: display,
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  ELECTRON_RUN_AS_NODE: "",
  // The parity-fixture basis — the deterministic reference adapter.
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
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error).slice(0, 200)}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  const waitForEval = async (predicate, what, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await evaluate(`(async () => (${predicate}))()`)) === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
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
    for (; lastLogLen < log.length; lastLogLen++) {
      // document.setSelection is non-versioned EDITOR-STATE plumbing the
      // driver emits while staging the entity picks ("P") — the Web smoke
      // carries the same information as prompt-engine context overrides
      // without a command. The SEMANTIC command stream excludes it.
      if (log[lastLogLen] !== "document.setSelection") stream.push(log[lastLogLen]);
    }
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

  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const ok = (r) => r && r.ok === true;
  const val = (r) => {
    if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 300));
    return r.value;
  };

  // --- Boot + document (the SAME create payload the Web smoke runs — parity).
  push("professional workspace mounts (the CAD-PARITY-002 shell)", true, "driver present");
  const created = await send("document.create", {
    entityId: "cad-parity-011-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-011-smoke",
  });
  push("document.create", created && created.ok === true, "ok");

  // --- The two stories through the REAL command line. ---------------------------
  await typed("STORY");
  await typed("Ground Floor");
  await typed("0");
  await typed("");
  await typed("STORY");
  await typed("First Floor");
  await typed("3000");
  await typed("");
  let snap = await docState();
  const stories = snap.elements.filter((e) => e.props?.type === "bim.story").sort((a, b) => a.props.level - b.props.level);
  push("STORY ×2 through the command line", stories.length === 2, stories.map((s) => `${s.id}@${s.props.level}`).join(", "));
  const gf = stories[0].id;
  const ff = stories[1].id;

  // --- Walls on GF (the active story switched through the driver — the same
  //     context the Web smoke overrode).
  await drv("setActiveStory", gf);
  await typed("WALL");
  await typed("0,0");
  await typed("8000,0");
  await typed("WALL");
  await typed("0,0");
  await typed("0,6000");
  snap = await docState();
  push("WALL ×2 on the ground story", snap.elements.filter((e) => e.props?.type === "bim.wall").length === 2, "ok");

  // --- The spaces (the workbench form stream — same batch as the Web smoke).
  val(
    await send("bim.createElements", {
      entities: [
        { type: "bim.space", id: "space-office", storyId: gf, name: "Office", footprint: [[0, 0], [8000, 0], [8000, 3000], [0, 3000]], height: 3000 },
        { type: "bim.space", id: "space-hall", storyId: gf, name: "Hall", footprint: [[0, 3000], [8000, 3000], [8000, 6000], [0, 6000]], height: 3000 },
      ],
    }),
  );
  push("spaces ×2 (the workbench form stream)", true, "ok");

  // --- The ROOF on FF through the REAL command line.
  await drv("setActiveStory", ff);
  await typed("ROOF");
  await typed("-300,-300");
  await typed("8300,6300");
  await typed(""); // ridge axis <x>
  await typed(""); // height <default>
  snap = await docState();
  const roofs = snap.elements.filter((e) => e.props?.type === "bim.roof");
  push("ROOF on the first floor (ridge ∥ x)", roofs.length === 1 && roofs[0].props.ridgeAxis === "x", roofs[0]?.id);

  // --- The STAIR GF → FF through the REAL command line (typed entity pick).
  await drv("setActiveStory", gf);
  await drv("setSelection", [ff]);
  await typed("STAIR");
  await typed("1000,4500");
  await typed("5000,4500");
  await typed("P");
  snap = await docState();
  const stairs = snap.elements.filter((e) => e.props?.type === "bim.stair");
  push("STAIR GF → FF (the story-linked rise)", stairs.length === 1 && stairs[0].props.topStoryId === ff, stairs[0]?.id);
  const stairId = stairs[0].id;

  // --- The RAILINGS through the REAL command line (hosted on the stair).
  await drv("setSelection", [stairId]);
  await typed("RAILING");
  await typed("P");
  await typed(""); // side <left>
  await typed("RAILING");
  await typed("P");
  await typed("right");
  snap = await docState();
  const railings = snap.elements.filter((e) => e.props?.type === "bim.railing");
  push("RAILING ×2 hosted on the stair", railings.length === 2, railings.map((r) => r.props.side).join("+"));

  // --- The ZONE through the REAL command line (typed entity picks).
  await drv("setSelection", ["space-office", "space-hall"]);
  await typed("ZONE");
  await typed("Daylit wing");
  await typed("P");
  await typed("");
  snap = await docState();
  const zones = snap.elements.filter((e) => e.props?.type === "bim.zone");
  push("ZONE grouping both spaces", zones.length === 1 && zones[0].props.spaceIds.length === 2, zones[0]?.id);

  // --- The OPTION GROUP through the REAL command line.
  await typed("OPTION");
  await typed("Facade options");
  await typed("Glazed, Solid");
  await typed("Glazed");
  snap = await docState();
  const groups = snap.elements.filter((e) => e.props?.type === "bim.optionGroup");
  push("OPTION group (Glazed active)", groups.length === 1 && groups[0].props.activeOption === "Glazed", groups[0]?.id);
  const groupId = groups[0].id;
  const roofId = roofs[0].id;
  const wallId = snap.elements.find((e) => e.props?.type === "bim.wall").id;

  // --- The lifecycle edits (the workbench panel stream — same commands).
  val(await send("bim.setClassification", { elementId: roofId, classificationRef: "OFFISOS-ARCH-120" }));
  val(
    await send("bim.setPropertySets", {
      elementId: roofId,
      propertySets: [
        { name: "Pset_RoofCommon", properties: [{ key: "FireRating", value: "REI30" }, { key: "RidgeHeight", value: 1500 }] },
      ],
    }),
  );
  val(await send("bim.setRenovation", { elementId: stairId, status: "new" }));
  val(await send("bim.setOptionMembership", { elementId: wallId, optionGroupId: groupId, option: "Glazed" }));

  // The RENOVATE registry command through the REAL command line.
  await drv("setSelection", [wallId]);
  await typed("RENOVATE");
  await typed("to-be-demolished");
  await typed("P");
  await typed("");
  {
    const life = val(await cad({ type: "query", name: "bim.getLifecycle", payload: { elementId: wallId } }));
    push(
      "RENOVATE through the command line",
      life.elements[0].renovationStatus === "to-be-demolished",
      life.elements[0].renovationStatus,
    );
  }

  // --- The deterministic ACTIVE-OPTION build behavior. ---------------------------
  const built = val(await send("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
  push(
    "buildGeometry — all three built (Glazed active)",
    built.built === 3 && built.skipped.length === 0 && built.results[0].engine.engineId === "reference",
    `reference provenance`,
  );
  val(await send("bim.setActiveOption", { optionGroupId: groupId, option: "Solid" }));
  const built2 = val(await send("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
  push(
    "the inactive option is skipped with the explicit reason",
    built2.built === 2 && built2.skipped.length === 1 && built2.skipped[0].elementId === wallId && /active option is 'Solid'/.test(built2.skipped[0].reason),
    built2.skipped[0]?.reason.slice(0, 60),
  );
  val(await send("bim.setActiveOption", { optionGroupId: groupId, option: "Glazed" }));
  const built3 = val(await send("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
  push("switching back rebuilds (never deleted)", built3.built === 3 && built3.skipped.length === 0, "ok");

  // --- Undo/redo over the lifecycle edits. ---------------------------------------
  await send("document.undo", {});
  await send("document.undo", {});
  {
    const opts = val(await cad({ type: "query", name: "bim.getOptions", payload: {} }));
    push("undo reverted the active option", opts.groups[0].activeOption === "Solid", opts.groups[0].activeOption);
  }
  await send("document.redo", {});
  {
    const opts = val(await cad({ type: "query", name: "bim.getOptions", payload: {} }));
    push("redo restored the active option", opts.groups[0].activeOption === "Glazed", opts.groups[0].activeOption);
  }

  // --- Save/open round-trip (the same tail as the Web smoke). --------------------
  // Reset the editor selection to the Web document's empty state (the
  // selection persists in the snapshot — the save must be byte-identical).
  await drv("setSelection", []);
  const saved1 = val(await send("document.save", {}));
  val(await send("document.open", { source: saved1.bytes, entityId: "cad-parity-011-smoke-reopened" }));
  snap = await docState();
  push(
    "save/open round-trip — the P011 state survives",
    snap.elements.length === 12,
    `${snap.elements.length} elements`,
  );
  val(await send("document.open", { source: saved1.bytes, entityId: "cad-parity-011-smoke-final" }));
  const sA = val(await send("document.save", {}));
  const sB = val(await send("document.save", {}));
  const saveSha = sha(JSON.stringify(sA.bytes));
  push("save deterministic", saveSha === sha(JSON.stringify(sB.bytes)), saveSha.slice(0, 16) + "…");

  // --- The pinned fixture (Web/Electron parity). ---------------------------------
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const semantics = val(await cad({ type: "query", name: "bim.getSemantics", payload: {} }));
  const lifecycle = val(await cad({ type: "query", name: "bim.getLifecycle", payload: {} }));
  const options = val(await cad({ type: "query", name: "bim.getOptions", payload: {} }));
  const echoLog = await drv("echoLog");
  const echoDigest = sha(echoLog.join("\n"));

  push(
    "CAD-PARITY-011 fixture: save sha256 MATCH",
    fixture.saveSha256 === saveSha,
    `expected ${fixture.saveSha256.slice(0, 16)}…, got ${saveSha.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-011 fixture: element counts MATCH",
    fixture.elements === snap.elements.length &&
      fixture.roofs === snap.elements.filter((e) => e.props?.type === "bim.roof").length &&
      fixture.stairs === snap.elements.filter((e) => e.props?.type === "bim.stair").length &&
      fixture.railings === snap.elements.filter((e) => e.props?.type === "bim.railing").length &&
      fixture.zones === snap.elements.filter((e) => e.props?.type === "bim.zone").length &&
      fixture.optionGroups === snap.elements.filter((e) => e.props?.type === "bim.optionGroup").length,
    `${snap.elements.length} elements`,
  );
  push(
    "CAD-PARITY-011 fixture: build token digest MATCH",
    fixture.buildTokensSha256 === sha(built3.results.map((r) => r.meshToken).sort().join("\n")),
    `expected ${fixture.buildTokensSha256.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-011 fixture: semantics digest MATCH",
    fixture.semanticsSha256 === sha(JSON.stringify(semantics)),
    `expected ${fixture.semanticsSha256.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-011 fixture: lifecycle digest MATCH",
    fixture.lifecycleSha256 === sha(JSON.stringify(lifecycle)),
    `expected ${fixture.lifecycleSha256.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-011 fixture: options digest MATCH",
    fixture.optionsSha256 === sha(JSON.stringify(options)),
    `expected ${fixture.optionsSha256.slice(0, 16)}…`,
  );
  push(
    "CAD-PARITY-011 fixture: echo digest MATCH",
    fixture.echoDigest === echoDigest,
    `expected ${fixture.echoDigest.slice(0, 16)}…, got ${echoDigest.slice(0, 16)}…`,
  );
  const streamOk = fixture.commandStream.join("|") === stream.join("|");
  push(
    "CAD-PARITY-011 fixture: semantic command stream MATCH (Web/Electron parity)",
    streamOk,
    streamOk ? `${stream.length} commands` : `expected ${fixture.commandStream.join("|")}\n           got      ${stream.join("|")}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nELECTRON BIM P011 SMOKE: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  if (failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`ELECTRON BIM P011 SMOKE: ERROR — ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
