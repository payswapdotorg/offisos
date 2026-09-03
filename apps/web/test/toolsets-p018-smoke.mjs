// CAD-PARITY-018 / Issue #118: Web host specialized-toolsets smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (WALLRUN/
// PLACEOPENING/ROOFCREATE/STAIRRUN/SPACEGRID/DIMCHAIN/COMPARRAY +
// MEPRUN/MEPCONNECT + EQUIPADD + RASTERATTACH + the TOOLSETREPORT/
// MEPREPORT/RASTERSTATUS/RASTERTRACE report surfaces in
// commands-toolsets.ts) plus the App API surface the Toolsets workbench
// produces (the toolset.* commands/queries) — against the running dev
// server, asserting the state after every step. This is the Web half of
// the Web/Electron semantic-parity evidence (LOCK-004); the app-suite
// toolsets-p018-host-parity test proves the same stream through both
// hosts; the pinned fixture
// (app/test/fixtures/cad-parity-018-toolsets.json) is the parity basis.
//
// Covers the CAD-PARITY-018 acceptance surface: the versioned typed
// capability discovery table (the closed 26-entry registry — anything not
// listed is the App API's own typed decline, never a fabricated
// semantic); the architecture composition workflows (every command emits
// EXACTLY the element batches the verified bim.createElements /
// drafting.createEntities paths produce — one atomic revision per
// command, document-minted element ids, deterministic per-segment names,
// the REAL P011 host bindings); the bounded MEP routing records
// (document-minted tls- identities, the deterministic route validation,
// the clash/clearance diagnostics against the canonical wall bodies, the
// in-record connections with the typed domain/kind mismatch declines);
// the bounded mechanical equipment records (ordinal ports, the
// deterministic arrays with ports that move); the canonical raster
// records (the fresh ok/stale/missing status derivation, the typed
// NON-AUTHORITATIVE trace with the exact fixed-formula transform, the
// commit-to-canonical path with lineage, the typed stale/missing
// declines); the undo atomicity (one command = one revision, exact
// restore); the save/open round-trip (the specialized records are
// DOCUMENT-OWNED canonical state); and the fresh-document scoping proof.
//
// Determinism (the P016/P017 discipline): the tls- identities are
// document-minted monotonic counters, the element ids are document-minted
// `el-` ids, and the content hashes are functions of the run-unique
// canonical entity id — all normalized in the pinned digests; every
// SEMANTIC field (ids, kinds, names, counts, violations, diagnostics,
// statuses, trace vectors) is pinned verbatim. Perf budgets are
// wall-clock asserted per call and NEVER pinned. Engine boundary
// (LOCK-003/018): no toolsets command makes an engine call — the whole
// stream runs in REFERENCE mode and the specialized derivations are pure
// TypeScript folds over the canonical records.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-018-toolsets.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

// The project key is run-unique — every run starts from a FRESH document
// (document.create) so the pinned fixture pins the run's own lineage, not
// any residue.
const RUN_KEY = `cad-parity-018-smoke-${randomUUID().slice(0, 8)}`;

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

const step = (name) => console.log(`TOOLSETS P018 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
// The pinned digests normalize the run-unique project identity and the
// content-addressed hashes (both are functions of the run-unique canonical
// entity id). Every SEMANTIC field is pinned verbatim; only the
// run-identity-derived hex is tokenized (documented — never a silent
// masking of semantics).
const normalizePinned = (s) =>
  s
    .split(RUN_KEY)
    .join("«project»")
    .replace(/[0-9a-f]{64}/g, "«sha256»")
    .replace(/[0-9a-f]{12}…/g, "«sha12»");

// The observable performance budgets: wall-clock asserted per call and
// reported to the run log, NEVER pinned.
const perf = [];
async function timed(label, thresholdMs, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  if (ms > thresholdMs) {
    throw new Error(`PERF BUDGET EXCEEDED — ${label}: ${ms}ms > ${thresholdMs}ms`);
  }
  perf.push(`${label}: ${ms}ms <= ${thresholdMs}ms`);
  console.log(`TOOLSETS P018 SMOKE: PERF ${label}: ${ms}ms (budget <= ${thresholdMs}ms)`);
  return out;
}

// --- 1. document + the canonical model seed --------------------------------------

step("document.create + the bim seed (the governed canonical baseline)");
val(
  await cmd("document.create", {
    entityId: RUN_KEY,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-018-smoke",
  }),
);
let snap = val(await q("document.getState", {}));

function context(overrides = {}) {
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    currentSelection: [],
    layers: snap.layers ?? [],
    blocks: snap.blockDefs ?? [],
    ...overrides,
  });
}

const echoLines = [];
const uiActions = [];
async function runScript(steps, overrides = {}) {
  const plans = [];
  const result = runCommandScript(steps, context(overrides), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  for (const plan of plans) {
    for (const action of plan.ui) uiActions.push(action);
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

const seedEntities = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
  { type: "bim.story", id: "story-1", name: "First Floor", level: 3000, height: 3000 },
  { type: "bim.componentDef", id: "def-desk", name: "Workstation Desk", category: "furniture", parameters: { width: 1600, depth: 800, height: 750 } },
];
const seed = val(await cmd("bim.createElements", { entities: seedEntities }));
assert(seed.created.length === 4, `the seed created 4 entities (got ${seed.created.length})`);
snap = val(await q("document.getState", {}));
assert(snap.version.version_number === 2, "the seeded baseline (create + createElements)");
const elementCountAfterSeed = snap.elements.length;

// --- 2. the capability discovery (the closed versioned registry) ------------------

step("toolset.capabilities (the closed 26-entry registry, revision-bound)");
const caps = val(await timed("toolset.capabilities", 1000, () => q("toolset.capabilities", {})));
assert(caps.apiVersion === "1", "the toolsets API version");
assert(caps.capabilities.length === 26, `the closed registry (got ${caps.capabilities.length})`);
assert(caps.capabilities.filter((c) => c.kind === "command").length === 20, "the 20 commands");
assert(caps.capabilities.filter((c) => c.kind === "query").length === 6, "the 6 queries");
const names = new Set(caps.capabilities.map((c) => c.name));
assert(names.size === 26, "no duplicates in the registry");
for (const c of caps.capabilities) {
  assert(["arch", "mep", "mechanical", "raster"].includes(c.toolset), `the toolset of ${c.name}`);
  assert(c.summary.length > 0, `the summary of ${c.name}`);
}
// Revision-bound discovery view (the P017 convention).
assert(caps.documentVersion === snap.version.version_number, "the discovery view is revision-bound");
assert(caps.contentHash.length === 64, "the canonical content hash binding");
// The unknown toolsets request declines typed (the App API's own decline).
const ghost = await q("toolset.archWallRan", {});
assert(!ok(ghost) && ghost.code === "unknown_query", "the unknown toolsets name declines typed (never a fabricated semantic)");

// --- 3. the architecture registry stream (composition over the BIM primitives) ----

step("WALLRUN + PLACEOPENING + ROOFCREATE + STAIRRUN + SPACEGRID + DIMCHAIN + COMPARRAY (the registry stream)");
const { result: wallRunScript } = await runScript([
  { event: { type: "typed", text: "WALLRUN" } },
  { event: { type: "typed", text: "story-gf" } },
  { event: { type: "typed", text: "0,0;6000,0;6000,5000" } },
  { event: { type: "typed", text: "300" } },
  { event: { type: "typed", text: "3000" } },
  { event: { type: "typed", text: "run" } },
  { event: { type: "typed", text: "OPEN" } },
  { event: { type: "enter" } },
]);
assert(
  wallRunScript.lines.includes("WALLRUN: 2 wall segment(s) from 3 vertices (junctions: openings)."),
  `the WALLRUN echo (got ${wallRunScript.lines.join(" / ")})`,
);
// The wall run: 2 walls + 1 junction opening = 3 created elements, ONE revision.
const wallRunValue = val(await q("document.getState", {}));
assert(wallRunValue.elements.length === elementCountAfterSeed + 3, "the wall run created 2 walls + 1 junction opening");
const wallIds = wallRunValue.elements
  .filter((e) => e.props.type === "bim.wall" && (e.props.name === "run-1" || e.props.name === "run-2"))
  .map((e) => e.id);
assert(wallIds.length === 2, "the deterministic per-segment names run-1/run-2");

const { result: openingScript } = await runScript([
  { event: { type: "typed", text: "PLACEOPENING" } },
  { event: { type: "typed", text: "wall-south" } },
  { event: { type: "typed", text: "DOO" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "0.5" } },
  { event: { type: "typed", text: "900" } },
  { event: { type: "typed", text: "2100" } },
  { event: { type: "typed", text: "0" } },
]);
assert(
  openingScript.lines.includes("PLACEOPENING: door hosted in 'wall-south' at t=0.5."),
  `the PLACEOPENING echo (got ${openingScript.lines.join(" / ")})`,
);

const { result: roofScript } = await runScript([
  { event: { type: "typed", text: "ROOFCREATE" } },
  { event: { type: "typed", text: "story-1" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "6000,5000" } },
  { event: { type: "typed", text: "x" } },
  { event: { type: "typed", text: "2000" } },
  { event: { type: "typed", text: "0" } },
]);
assert(
  roofScript.lines.includes(`ROOFCREATE: roof over {"x":0,"y":0}–{"x":6000,"y":5000} (ridge x, 2000mm).`),
  `the ROOFCREATE echo (got ${roofScript.lines.join(" / ")})`,
);

const { result: stairScript } = await runScript([
  { event: { type: "typed", text: "STAIRRUN" } },
  { event: { type: "typed", text: "story-gf" } },
  { event: { type: "typed", text: "story-1" } },
  { event: { type: "typed", text: "1000,1000" } },
  { event: { type: "typed", text: "0" } },
  { event: { type: "typed", text: "1200" } },
  { event: { type: "typed", text: "16" } },
  { event: { type: "typed", text: "280" } },
  { event: { type: "typed", text: "BOTH" } },
  { event: { type: "enter" } },
]);
assert(
  stairScript.lines.includes("STAIRRUN: 16 steps from 'story-gf' to 'story-1' (railings: both)."),
  `the STAIRRUN echo (got ${stairScript.lines.join(" / ")})`,
);

const { result: gridScript } = await runScript([
  { event: { type: "typed", text: "SPACEGRID" } },
  { event: { type: "typed", text: "story-gf" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "4" } },
  { event: { type: "typed", text: "3" } },
  { event: { type: "typed", text: "4000" } },
  { event: { type: "typed", text: "3000" } },
  { event: { type: "typed", text: "ROOM" } },
]);
assert(
  gridScript.lines.includes(`SPACEGRID: 4×3 spaces of 4000×3000mm from {"x":0,"y":0}.`),
  `the SPACEGRID echo (got ${gridScript.lines.join(" / ")})`,
);
// The deterministic prefix-<col>-<row> names.
const gridState = val(await q("document.getState", {}));
const gridNames = gridState.elements.filter((e) => typeof e.props.name === "string" && e.props.name.startsWith("ROOM-")).map((e) => e.props.name).sort();
assert(gridNames.length === 12 && gridNames[0] === "ROOM-1-1" && gridNames[11] === "ROOM-4-3", "the 12 deterministic grid names");

const { result: dimScript } = await runScript([
  { event: { type: "typed", text: "DIMCHAIN" } },
  { event: { type: "typed", text: "0,0;6000,0;6000,5000" } },
  { event: { type: "typed", text: "600" } },
]);
assert(
  dimScript.lines.includes("DIMCHAIN: 3 points at 600mm offset."),
  `the DIMCHAIN echo (got ${dimScript.lines.join(" / ")})`,
);

const { result: arrayScript } = await runScript([
  { event: { type: "typed", text: "COMPARRAY" } },
  { event: { type: "typed", text: "def-desk" } },
  { event: { type: "typed", text: "story-gf" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "2" } },
  { event: { type: "typed", text: "1500" } },
  { event: { type: "typed", text: "1500" } },
]);
assert(
  arrayScript.lines.includes("COMPARRAY: 2×2 instances of 'def-desk'."),
  `the COMPARRAY echo (got ${arrayScript.lines.join(" / ")})`,
);

// The architecture host-boundary declines (typed, never a guess).
const hostMissing = await cmd("toolset.archWallRun", {
  storyId: "no-such-story",
  polyline: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  widthMm: 200,
  heightMm: 3000,
});
assert(!ok(hostMissing) && hostMissing.code === "toolset_host_not_found", "the missing host story declines typed");
const roofMissing = await cmd("toolset.archRoof", {
  storyId: "story-roof-9",
  corner1: { x: 0, y: 0 },
  corner2: { x: 100, y: 100 },
  heightMm: 500,
});
assert(!ok(roofMissing) && roofMissing.code === "toolset_host_not_found", "the roof's missing story declines typed");

// --- 4. the MEP + mechanical registry stream (the tls- records) --------------------

step("MEPRUN + EQUIPADD + MEPCONNECT (the registry stream) + the MEP derivations");
const { result: mepRunScript } = await runScript([
  { event: { type: "typed", text: "MEPRUN" } },
  { event: { type: "typed", text: "DUC" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "round" } },
  { event: { type: "typed", text: "300" } },
  { event: { type: "typed", text: "0,500,0" } },
  { event: { type: "typed", text: "3000,500,0" } },
  { event: { type: "typed", text: "sa-1" } },
]);
assert(
  mepRunScript.lines.includes("MEPRUN: duct run 'sa-1' round Ø300mm."),
  `the MEPRUN echo (got ${mepRunScript.lines.join(" / ")})`,
);
const ductRun = val(await timed("toolset.mepAddRun (registry)", 1000, () => q("toolset.listRecords", { kind: "mep.run" })));
assert(ductRun.records.length === 1 && ductRun.records[0].id === "tls-000001", "the document-minted tls-000001 run identity");

const { result: equipScript } = await runScript([
  { event: { type: "typed", text: "EQUIPADD" } },
  { event: { type: "typed", text: "PUMP" } },
  { event: { type: "typed", text: "pump-a" } },
  { event: { type: "typed", text: "-500,0,0" } },
  { event: { type: "typed", text: "2" } },
]);
assert(
  equipScript.lines.includes(`EQUIPADD: pump 'pump-a' at {"x":-500,"y":0,"z":0} (2 port(s)).`),
  `the EQUIPADD echo (got ${equipScript.lines.join(" / ")})`,
);

const { result: connectScript } = await runScript([
  { event: { type: "typed", text: "MEPCONNECT" } },
  { event: { type: "typed", text: "tls-000001" } },
  { event: { type: "typed", text: "STAR" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "EQU" } },
  { event: { type: "typed", text: "tls-000002" } },
  { event: { type: "typed", text: "p1" } },
  { event: { type: "typed", text: "n/a" } },
  { event: { type: "typed", text: "0,0,0" } },
]);
assert(
  connectScript.lines.includes(`MEPCONNECT: 'tls-000001' start → {"kind":"equipment","equipmentId":"tls-000002","portId":"p1"}.`),
  `the MEPCONNECT echo (got ${connectScript.lines.join(" / ")})`,
);

// The deterministic derivations: route validation + clash report.
const route = val(await timed("toolset.mepValidateRoute", 1000, () => q("toolset.mepValidateRoute", { id: "tls-000001" })));
assert(route.id === "tls-000001" && route.domain === "duct" && route.violations.length === 0, "the duct run route passes the grammar");

// A pipe run through the raw App API (the workbench's add-run path).
const pipeRun = val(
  await timed("toolset.mepAddRun (pipe)", 1000, () =>
    cmd("toolset.mepAddRun", {
      run: {
        domain: "pipe",
        shape: "round",
        nominalSize: 32,
        name: "cw-1",
        segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 0, z: 0 } }],
      },
    }),
  ),
);
assert(pipeRun.record.id === "tls-000003", "the second run mints tls-000003 (monotonic, never reused)");

// The clash report: the pipe run at y=0 intersects the south wall body
// (the deterministic 2D center-line/rectangle distance is exactly 0).
const clash = val(await timed("toolset.mepClashReport", 1000, () => q("toolset.mepClashReport", { clearanceMm: 100 })));
assert(clash.clearanceMm === 100 && clash.runCount === 2, "the clash report covers both runs");
const pipeClash = clash.diagnostics.find((d) => d.runId === "tls-000003" && d.elementId === "wall-south");
assert(pipeClash !== undefined, "the pipe run clashes the south wall");
assert(pipeClash.kindOfClash === "intersection" && pipeClash.distanceMm === 0, "the intersection distance is exactly 0");
const ductClash = clash.diagnostics.find((d) => d.runId === "tls-000001" && d.elementId === "wall-south");
assert(ductClash === undefined, "the duct run at y=500 clears the wall body at 100mm");

// The typed connection declines (domain mismatch — never a guess).
const domainMismatch = await cmd("toolset.mepConnect", {
  runId: "tls-000003",
  at: "start",
  target: { kind: "equipment", equipmentId: "tls-000002", portId: "p1" },
});
assert(!ok(domainMismatch) && domainMismatch.code === "toolset_unsupported", "the pipe run on a duct port declines typed");
const unknownRun = await cmd("toolset.mepConnect", {
  runId: "tls-999999",
  at: "start",
  target: { kind: "endpoint", point: { x: 0, y: 0, z: 0 } },
});
assert(!ok(unknownRun) && unknownRun.code === "toolset_not_found", "the unknown run declines typed");
const nominalBounds = await cmd("toolset.mepAddRun", {
  run: { domain: "duct", shape: "round", nominalSize: 10, segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } }] },
});
assert(!ok(nominalBounds) && nominalBounds.code === "toolset_bad_payload", "the sub-bound nominal size declines typed (no identity burned)");

// The mechanical array (registry command values through the raw path — the
// workbench's array button): 2×2 cells, ports move with each instance.
const mechArray = val(
  await timed("toolset.mechArray", 1000, () => cmd("toolset.mechArray", { equipmentId: "tls-000002", cols: 2, rows: 2, dxMm: 2000, dyMm: 2000 })),
);
assert(mechArray.count === 4 && mechArray.created.length === 4, "the 2×2 equipment array (one atomic revision)");
assert(mechArray.created[0] === "tls-000004" && mechArray.created[3] === "tls-000007", "the array cells mint tls-000004..tls-000007");
// The per-axis bound declines typed.
const axisBounds = await cmd("toolset.mechArray", { equipmentId: "tls-000002", cols: 33, rows: 1, dxMm: 1000, dyMm: 1000 });
assert(!ok(axisBounds) && axisBounds.code === "toolset_out_of_bounds", "the 33-per-axis array declines typed");

// --- 5. the raster/underlay records + the typed trace + the commit ----------------

step("rasterAddSource + RASTERATTACH (registry) + rasterStatus + rasterTrace + rasterCommitTrace");
const SOURCE_DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const rasterSource = val(
  await timed("toolset.rasterAddSource", 1000, () =>
    cmd("toolset.rasterAddSource", {
      source: {
        sourceRef: "underlay/site-plan.png",
        contentDigest: SOURCE_DIGEST,
        widthPx: 1000,
        heightPx: 600,
        lineWork: [
          { x1: 100, y1: 100, x2: 900, y2: 100 },
          { x1: 100, y1: 300, x2: 900, y2: 300 },
        ],
      },
    }),
  ),
);
assert(rasterSource.record.id === "tls-000008" && rasterSource.record.kind === "raster.source", "the source mints tls-000008");

const { result: attachScript } = await runScript([
  { event: { type: "typed", text: "RASTERATTACH" } },
  { event: { type: "typed", text: "underlay/site-plan.png" } },
  { event: { type: "typed", text: SOURCE_DIGEST } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "0.5" } },
  { event: { type: "typed", text: "0" } },
]);
assert(
  attachScript.lines.includes(`RASTERATTACH: 'underlay/site-plan.png' at {"x":0,"y":0} scale 0.5.`),
  `the RASTERATTACH echo (got ${attachScript.lines.join(" / ")})`,
);

const statusOk = val(await timed("toolset.rasterStatus", 1000, () => q("toolset.rasterStatus", {})));
assert(statusOk.referenceCount === 1 && statusOk.statuses[0].status === "ok" && statusOk.statuses[0].referenceId === "tls-000009", "the fresh ok status");
assert(statusOk.statuses[0].reason.includes("matches the declared digest"), "the ok reason cites the digest match");

// The typed non-authoritative trace (the exact fixed-formula transform:
// scale ×0.5 then origin (0,0) — (100,100)→(50,50), (900,100)→(450,50)).
const traceResult = val(await timed("toolset.rasterTrace", 1000, () => q("toolset.rasterTrace", { referenceId: "tls-000009" })));
assert(traceResult.authoritative === false, "the trace is explicitly non-authoritative");
assert(traceResult.notice.includes("non-authoritative trace derived from the raster source 'underlay/site-plan.png' (2/2 vectors kept after clipping)"), "the typed commit notice");
assert(
  JSON.stringify(traceResult.vectors) ===
    JSON.stringify([
      { from: { x: 50, y: 50 }, to: { x: 450, y: 50 } },
      { from: { x: 50, y: 150 }, to: { x: 450, y: 150 } },
    ]),
  "the exact transformed vectors",
);

// The commit: canonical line elements with the trace lineage in props.
const elementsBeforeCommit = (val(await q("document.getState", {}))).elements.length;
const commit = val(await timed("toolset.rasterCommitTrace", 2000, () => cmd("toolset.rasterCommitTrace", { referenceId: "tls-000009" })));
assert(commit.committed === 2 && commit.created.length === 2, "the committed vectors become 2 canonical line elements");
assert(commit.trace.authoritative === false && commit.trace.notice.length > 0, "the commit result carries the non-authoritative notice");
const afterCommit = val(await q("document.getState", {}));
assert(afterCommit.elements.length === elementsBeforeCommit + 2, "exactly 2 elements were added");
const lineage = afterCommit.elements.find((e) => e.id === commit.created[0]).props.trace;
assert(
  lineage.sourceRef === "underlay/site-plan.png" && lineage.referenceId === "tls-000009" && JSON.stringify(lineage.vectorIndices) === "[0]",
  "the trace lineage is recorded in the element props",
);

// The STALE reference (declared digest ≠ the registered source): the fresh
// status derivation + the typed declines.
const staleAttach = val(
  await cmd("toolset.rasterAttach", {
    reference: {
      sourceRef: "underlay/site-plan.png",
      declaredDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
      visible: true,
    },
  }),
);
assert(staleAttach.record.id === "tls-000010", "the stale reference mints tls-000010");
const statusStale = val(await q("toolset.rasterStatus", {}));
assert(
  statusStale.statuses.map((s) => `${s.referenceId}:${s.status}`).join(",") === "tls-000009:ok,tls-000010:stale",
  "the fresh status table (id-sorted: ok + stale)",
);
const staleTrace = await q("toolset.rasterTrace", { referenceId: "tls-000010" });
assert(!ok(staleTrace) && staleTrace.code === "toolset_reference_stale", "the stale trace declines typed");
const staleCommit = await cmd("toolset.rasterCommitTrace", { referenceId: "tls-000010" });
assert(!ok(staleCommit) && staleCommit.code === "toolset_reference_stale", "the stale commit declines typed");
const missingAttach = await cmd("toolset.rasterAttach", {
  reference: {
    sourceRef: "unregistered.png",
    declaredDigest: "x",
    transform: { origin: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 },
    visible: true,
  },
});
assert(!ok(missingAttach) && missingAttach.code === "toolset_reference_missing", "the unregistered source declines typed at attach");

// The MISSING status: remove the source through the canonical document
// edit path (there is deliberately no toolset source-remove command).
val(await cmd("document.applyEdit", { edit: { type: "removeSpecialized", id: "tls-000008" } }));
const statusMissing = val(await q("toolset.rasterStatus", {}));
assert(
  statusMissing.statuses.map((s) => `${s.referenceId}:${s.status}`).join(",") === "tls-000009:missing,tls-000010:missing",
  "both references derive the missing status after the source removal",
);
const missingTrace = await q("toolset.rasterTrace", { referenceId: "tls-000009" });
assert(!ok(missingTrace) && missingTrace.code === "toolset_reference_missing", "the missing trace declines typed");

// The UNDO atomicity: ONE revision per command — undo restores the source
// record and the statuses are recomputed fresh (never stored).
val(await cmd("document.undo", {}));
const statusAfterUndo = val(await q("toolset.rasterStatus", {}));
assert(
  statusAfterUndo.statuses.map((s) => `${s.referenceId}:${s.status}`).join(",") === "tls-000009:ok,tls-000010:stale",
  "undo restores the source; the fresh derivation follows the canonical state",
);

// --- 6. the report surfaces (the registry echoes + the ui actions) ------------------

step("TOOLSETREPORT + MEPREPORT + RASTERSTATUS + RASTERTRACE (the registry report surfaces)");
const { result: reportScript, plans: reportPlans } = await runScript([{ event: { type: "typed", text: "TOOLSETREPORT" } }]);
assert(reportScript.lines.includes("TOOLSETREPORT."), `the TOOLSETREPORT echo (got ${reportScript.lines.join(" / ")})`);
const mepReport = await runScript([
  { event: { type: "typed", text: "MEPREPORT" } },
  { event: { type: "typed", text: "100" } },
]);
assert(mepReport.result.lines.includes("MEPREPORT: clash/clearance diagnostics at 100mm."), "the MEPREPORT echo");
const rasterStatusReport = await runScript([{ event: { type: "typed", text: "RASTERSTATUS" } }]);
assert(rasterStatusReport.result.lines.includes("RASTERSTATUS."), "the RASTERSTATUS echo");
const rasterTraceReport = await runScript([
  { event: { type: "typed", text: "RASTERTRACE" } },
  { event: { type: "typed", text: "tls-000009" } },
]);
assert(rasterTraceReport.result.lines.includes("RASTERTRACE: derived vectors for 'tls-000009' (non-authoritative)."), "the RASTERTRACE echo");
// The deterministic report action payloads (the shell's report.toolsets
// handler renders the REAL query results from these).
const reportUiActions = uiActions.filter((a) => a.action === "report.toolsets");
assert(
  JSON.stringify(reportUiActions) ===
    JSON.stringify([
      { action: "report.toolsets" },
      { action: "report.toolsets", payload: { report: "mep-clash", clearanceMm: 100 } },
      { action: "report.toolsets", payload: { report: "raster-status" } },
      { action: "report.toolsets", payload: { report: "raster-trace", referenceId: "tls-000009" } },
    ]),
  "the report.toolsets ui action payloads are deterministic",
);
const paletteActions = uiActions.filter((a) => a.action === "palette.show" && a.payload?.palette === "toolsets");
assert(paletteActions.length === 4, "every report surface also switches to the toolsets workbench");

// --- 7. the record lifecycle (list + set + remove) -----------------------------------

step("toolset.listRecords + the record lifecycle (set/remove + typed not-found)");
const inventory = val(await q("toolset.listRecords", {}));
assert(inventory.count === 10, `the record inventory (got ${inventory.count})`);
assert(
  inventory.records.map((r) => `${r.id}:${r.kind}`).join(",") ===
    "tls-000001:mep.run,tls-000002:mech.equipment,tls-000003:mep.run,tls-000004:mech.equipment,tls-000005:mech.equipment,tls-000006:mech.equipment,tls-000007:mech.equipment,tls-000008:raster.source,tls-000009:raster.reference,tls-000010:raster.reference",
  "the id-sorted inventory rows (tls-000008 was removed and restored through the canonical path)",
);
const removed = val(await cmd("toolset.mepRemoveRun", { id: "tls-000003" }));
assert(removed.removed === "tls-000003", "the run removal");
const removeAgain = await cmd("toolset.mepRemoveRun", { id: "tls-000003" });
assert(!ok(removeAgain) && removeAgain.code === "toolset_not_found", "the second removal declines typed");
val(await cmd("document.undo", {})); // restore tls-000003 (the inventory is pinned with it)

// --- 8. the save/open round-trip + the fresh-document scoping ------------------------

step("save/open round-trip — the specialized records are DOCUMENT-OWNED canonical state");
const saved = val(await cmd("document.save", {}));
val(await cmd("document.open", { source: saved.bytes }));
snap = val(await q("document.getState", {}));
const recordsAfterReopen = val(await q("toolset.listRecords", {}));
assert(recordsAfterReopen.count === inventory.count, "the specialized records survive the reopen (document-owned state)");
assert(recordsAfterReopen.records[0].id === "tls-000001", "the canonical identities survive the reopen");
// The tls- counter checkpoint: a post-reopen add mints the NEXT identity
// (never reuses a removed one — tls-000008 was removed then restored, the
// counter stayed ahead).
const postReopenRun = val(
  await cmd("toolset.mepAddRun", {
    run: { domain: "conduit", shape: "round", nominalSize: 32, name: "post-reopen", segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 500, y: 0, z: 0 } }] },
  }),
);
assert(postReopenRun.record.id === "tls-000011", "the post-reopen identity is tls-000011 (the counter checkpoint survives the reopen)");
val(await cmd("document.undo", {})); // keep the pinned inventory stable

// A FRESH document starts a FRESH specialized table (the scoping proof).
val(await cmd("document.create", { entityId: `${RUN_KEY}-other` }));
const freshRecords = val(await q("toolset.listRecords", {}));
assert(freshRecords.count === 0, "a new document = a fresh specialized table (no cross-project leakage)");
const freshCaps = val(await q("toolset.capabilities", {}));
assert(freshCaps.capabilities.length === 26, "the capability registry is versioned, not document state");

// --- 9. the pinned fixture (the run's own deterministic lineage) --------------------

step("fixture");

// Re-open the main document (the round-trip proved the reopen; the fixture
// pins the MAIN document's lineage).
val(await cmd("document.open", { source: saved.bytes }));
snap = val(await q("document.getState", {}));
const finalRecords = val(await q("toolset.listRecords", {}));
const finalCaps = val(await q("toolset.capabilities", {}));
const finalClash = val(await q("toolset.mepClashReport", { clearanceMm: 100 }));
const finalStatus = val(await q("toolset.rasterStatus", {}));
const finalTrace = val(await q("toolset.rasterTrace", { referenceId: "tls-000009" }));

const fixture = {
  elementCount: snap.elements.length,
  capabilityCount: finalCaps.capabilities.length,
  recordLineage: finalRecords.records.map((r) => `${r.id}:${r.toolset}:${r.kind}`),
  recordsSha256: sha(normalizePinned(JSON.stringify(finalRecords.records))),
  clashSummary: `${finalClash.runCount} runs @ ${finalClash.clearanceMm}mm: ${finalClash.diagnostics
    .map((d) => `${d.runId}#${d.segmentIndex}vs${d.elementId}:${d.kindOfClash}@${d.distanceMm}`)
    .join(" | ")}`,
  statusSummary: finalStatus.statuses.map((s) => `${s.referenceId}:${s.status}`).join(","),
  statusReasonsSha256: sha(normalizePinned(JSON.stringify(finalStatus.statuses.map((s) => [s.referenceId, s.reason])))),
  traceVectors: JSON.stringify(finalTrace.vectors),
  traceNotice: finalTrace.notice,
  traceAuthoritative: finalTrace.authoritative,
  wallRunNames: ["run-1", "run-2"],
  gridNameBounds: [gridNames[0], gridNames[gridNames.length - 1]],
  capabilitiesSha256: sha(normalizePinned(JSON.stringify(finalCaps.capabilities))),
  contentHash: sha(normalizePinned(finalCaps.contentHash)),
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`TOOLSETS P018 SMOKE: fixture written → ${FIXTURE_PATH}`);
} else {
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  let mismatch = null;
  for (const key of Object.keys(pinned)) {
    const a = JSON.stringify(pinned[key]);
    const b = JSON.stringify(fixture[key]);
    if (a !== b) {
      mismatch = `${key}: pinned ${a.slice(0, 80)} ≠ actual ${b.slice(0, 80)}`;
      break;
    }
  }
  if (mismatch !== null) {
    throw new Error(`FIXTURE MISMATCH — ${mismatch}`);
  }
  console.log(`TOOLSETS P018 SMOKE: fixture match (${pinned.recordLineage.length} records)`);
}

console.log(`TOOLSETS P018 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines, ${perf.length} perf assertions)`);
