// CAD-PARITY-011 / Issue #97: Web host BIM P011 workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (STORY/WALL/ROOF/
// STAIR/RAILING/ZONE/OPTION/RENOVATE in commands.ts) plus the App API
// lifecycle surface the workbench panels produce (bim.setClassification /
// setPropertySets / setRenovation / setOptionMembership / setActiveOption) —
// against the running dev server, asserting the document state after every
// step. This is the Web half of the Web/Electron semantic-parity evidence
// (LOCK-004): the Electron smoke (apps/electron/test/smoke-bim-p011.mjs)
// runs the same stream through the real Electron UI and both must match the
// pinned fixture (app/test/fixtures/cad-parity-011-bim.json).
//
// Covers the CAD-PARITY-011 acceptance surface: the Archicad-class authoring
// elements with their host/story relationships (the cross-story roof, the
// story-linked stair whose rise DERIVES from the story levels, the hosted
// railings), zones grouping spaces, the design-option registry, the
// classification/property-set/renovation lifecycle edits, the deterministic
// ACTIVE-OPTION build behavior, undo/redo integrity, and the save/open
// round-trip preserving the whole authored state.
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis (the parity
// pattern). Start the dev server with OFFISOS_GEOMETRY_ENGINE=reference.
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/bim-p011-smoke.mjs
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-011-bim.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

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
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const step = (name) => console.log(`BIM P011 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- document -----------------------------------------------------------------

val(
  await cmd("document.create", {
    entityId: "cad-parity-011-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-011-smoke",
  }),
);
let snap = val(await q("document.getState", {}));
let activeStoryId = null;
let storyCount = 0;

function context(overrides = {}) {
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    storyCount,
    currentSelection: [],
    layers: snap.layers ?? [],
    textStyles: snap.textStyles ?? [],
    dimStyles: snap.dimStyles ?? [],
    activeStoryId,
    ...overrides,
  });
}

const echoLines = [];
async function runScript(steps, overrides = {}) {
  const plans = [];
  const result = runCommandScript(steps, context(overrides), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  const createdIds = [];
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
      if (entry.name === "bim.createElements") createdIds.push(...val(res).created);
    }
    for (const ui of plan.ui) {
      if (ui.action === "story.activateCreated" && createdIds.length > 0) {
        activeStoryId = createdIds[createdIds.length - 1];
      }
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans, createdIds };
}

const pickOf = (id) => {
  const el = snap.elements.find((e) => e.id === id);
  if (el === undefined) throw new Error(`no element '${id}' to pick`);
  return { id: el.id, kind: el.kind, props: el.props ?? {} };
};
const byType = (type) => snap.elements.filter((e) => e.props?.type === type).map((e) => e.id);

// --- 1. the two stories + the ground-floor wall (registry commands) -----------

step("STORY ×2 + WALL through the shared command registry");
{
  const { createdIds } = await runScript([
    { event: { type: "typed", text: "STORY" } },
    { event: { type: "typed", text: "Ground Floor" } },
    { event: { type: "typed", text: "0" } },
    { event: { type: "enter" } }, // height <3000>
  ]);
  assert(createdIds.length === 1, "STORY created one story");
  assert(activeStoryId === createdIds[0], "the story became active (the UI action)");
  const gf = createdIds[0];
  storyCount = 1;

  const { createdIds: created2 } = await runScript([
    { event: { type: "typed", text: "STORY" } },
    { event: { type: "typed", text: "First Floor" } },
    { event: { type: "typed", text: "3000" } },
    { event: { type: "enter" } },
  ]);
  assert(created2.length === 1, "second STORY created");
  const ff = created2[0];
  storyCount = 2;

  await runScript([
    { event: { type: "typed", text: "WALL" } },
    { event: { type: "typed", text: "0,0" } },
    { event: { type: "typed", text: "8000,0" } },
  ], { activeStoryId: gf });

  await runScript([
    { event: { type: "typed", text: "WALL" } },
    { event: { type: "typed", text: "0,0" } },
    { event: { type: "typed", text: "0,6000" } },
  ], { activeStoryId: gf });

  assert(byType("bim.wall").length === 2, "two walls authored");
  globalThis.__p011 = { gf, ff };
}

const { gf, ff } = globalThis.__p011;

// --- 2. the spaces (the workbench form stream) --------------------------------

step("two spaces through the workbench's bim.createElements stream");
val(
  await cmd("bim.createElements", {
    entities: [
      { type: "bim.space", id: "space-office", storyId: gf, name: "Office", footprint: [[0, 0], [8000, 0], [8000, 3000], [0, 3000]], height: 3000 },
      { type: "bim.space", id: "space-hall", storyId: gf, name: "Hall", footprint: [[0, 3000], [8000, 3000], [8000, 6000], [0, 6000]], height: 3000 },
    ],
  }),
);
snap = val(await q("document.getState", {}));

// --- 3. the ROOF (registry) — hosted on FF ------------------------------------

step("ROOF through the shared command registry (hosted on the first floor)");
await runScript(
  [
    { event: { type: "typed", text: "ROOF" } },
    { event: { type: "typed", text: "-300,-300" } },
    { event: { type: "typed", text: "8300,6300" } },
    { event: { type: "enter" } }, // ridge axis <x>
    { event: { type: "enter" } }, // height <default 1500>
  ],
  { activeStoryId: ff },
);
assert(byType("bim.roof").length === 1, "one roof authored");

// --- 4. the STAIR (registry) — story-linked with the derived rise -------------

step("STAIR through the shared command registry (GF → FF, derived rise)");
await runScript(
  [
    { event: { type: "typed", text: "STAIR" } },
    { event: { type: "typed", text: "1000,4500" } },
    { event: { type: "typed", text: "5000,4500" } },
    { event: { type: "typed", text: "P" } },
  ],
  { activeStoryId: gf, currentSelection: [pickOf(ff)] },
);
assert(byType("bim.stair").length === 1, "one stair authored");
const stairId = byType("bim.stair")[0];

// --- 5. the RAILINGS (registry) — hosted on the stair -------------------------

step("RAILING ×2 through the shared command registry (hosted on the stair)");
await runScript(
  [
    { event: { type: "typed", text: "RAILING" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "enter" } }, // side <left>
  ],
  { currentSelection: [pickOf(stairId)] },
);
await runScript(
  [
    { event: { type: "typed", text: "RAILING" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "typed", text: "right" } },
  ],
  { currentSelection: [pickOf(stairId)] },
);
assert(byType("bim.railing").length === 2, "two railings authored (deterministic propagation)");

// --- 6. the ZONE (registry) — grouping the spaces -----------------------------

step("ZONE through the shared command registry (grouping both spaces)");
await runScript(
  [
    { event: { type: "typed", text: "ZONE" } },
    { event: { type: "typed", text: "Daylit wing" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "enter" } },
  ],
  { currentSelection: [pickOf("space-office"), pickOf("space-hall")] },
);
assert(byType("bim.zone").length === 1, "one zone authored");

// --- 7. the OPTION GROUP (registry) -------------------------------------------

step("OPTION through the shared command registry (the design-option registry)");
await runScript([
  { event: { type: "typed", text: "OPTION" } },
  { event: { type: "typed", text: "Facade options" } },
  { event: { type: "typed", text: "Glazed, Solid" } },
  { event: { type: "typed", text: "Glazed" } },
]);
assert(byType("bim.optionGroup").length === 1, "one option group authored");
const groupId = byType("bim.optionGroup")[0];

// --- 8. the lifecycle edits (the workbench panel stream) -----------------------

step("classification + property sets + renovation + option membership + active option");
const roofId = byType("bim.roof")[0];
const wallId = byType("bim.wall")[0];
val(await cmd("bim.setClassification", { elementId: roofId, classificationRef: "OFFISOS-ARCH-120" }));
val(
  await cmd("bim.setPropertySets", {
    elementId: roofId,
    propertySets: [
      { name: "Pset_RoofCommon", properties: [{ key: "FireRating", value: "REI30" }, { key: "RidgeHeight", value: 1500 }] },
    ],
  }),
);
val(await cmd("bim.setRenovation", { elementId: stairId, status: "new" }));
val(await cmd("bim.setOptionMembership", { elementId: wallId, optionGroupId: groupId, option: "Glazed" }));

// The lifecycle query reflects the state.
{
  const life = val(await q("bim.getLifecycle", {}));
  const byId = new Map(life.elements.map((x) => [x.elementId, x]));
  assert(byId.get(roofId).classificationRef === "OFFISOS-ARCH-120", "roof classified");
  assert(byId.get(stairId).renovationStatus === "new", "stair renovation = new");
  assert(byId.get(wallId).optionActive === true, "the wall's option is the active one");
}

// The RENOVATE registry command (selection-driven).
await runScript(
  [
    { event: { type: "typed", text: "RENOVATE" } },
    { event: { type: "typed", text: "to-be-demolished" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "enter" } },
  ],
  { currentSelection: [pickOf(wallId)] },
);
{
  const life = val(await q("bim.getLifecycle", { elementId: wallId }));
  assert(life.elements[0].renovationStatus === "to-be-demolished", "RENOVATE applied through the registry");
}

// --- 9. the deterministic ACTIVE-OPTION build behavior -------------------------

step("bim.buildGeometry with the ACTIVE-OPTION behavior (reference basis)");
const built = val(await cmd("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
assert(built.built === 3, `roof + stair + wall built (Glazed is the active option): got ${built.built}`);
assert(built.skipped.length === 0, "no skips while Glazed is active");
assert(built.results.length === 3, "three build results");
// Cross-check the realized volumes against the closed forms through the
// reference engine provenance.
for (const result of built.results) {
  assert(result.engine.engineId === "reference", `the parity fixture is reference-basis (got ${result.engine.engineId})`);
}
// Switch the active option: the wall's build is now skipped with a reason.
val(await cmd("bim.setActiveOption", { optionGroupId: groupId, option: "Solid" }));
const built2 = val(await cmd("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
assert(built2.built === 2, "roof + stair still built");
assert(built2.skipped.length === 1 && built2.skipped[0].elementId === wallId, "the wall is skipped as inactive");
assert(/active option is 'Solid'/.test(built2.skipped[0].reason), "the explicit inactive reason");
// Switch back (the wall rebuilds — nothing was deleted).
val(await cmd("bim.setActiveOption", { optionGroupId: groupId, option: "Glazed" }));
const built3 = val(await cmd("bim.buildGeometry", { ids: [roofId, stairId, wallId] }));
assert(built3.built === 3 && built3.skipped.length === 0, "all three rebuild after switching back");

// --- 10. undo/redo over a lifecycle edit ---------------------------------------

step("undo/redo integrity over a lifecycle edit");
val(await cmd("document.undo", {})); // redo of nothing? the last edit was buildGeometry — undo it
val(await cmd("document.undo", {})); // undo setActiveOption (Glazed)
{
  const opts = val(await q("bim.getOptions", {}));
  assert(opts.groups[0].activeOption === "Solid", "the active option reverted to Solid");
}
val(await cmd("document.redo", {}));
{
  const opts = val(await q("bim.getOptions", {}));
  assert(opts.groups[0].activeOption === "Glazed", "redo restored Glazed");
}

// --- 11. save / open / save -----------------------------------------------------

step("save/open round-trip — the P011 authored state survives exactly");
const saved1 = val(await cmd("document.save", {}));
val(await cmd("document.open", { source: saved1.bytes, entityId: "cad-parity-011-smoke-reopened" }));
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 12, `12 elements after the round-trip (got ${snap.elements.length})`);
{
  const roofEl = snap.elements.find((e) => e.props?.type === "bim.roof");
  assert(roofEl !== undefined && roofEl.props.meta?.classificationRef === "OFFISOS-ARCH-120", "the classification survived");
  const stairEl = snap.elements.find((e) => e.props?.type === "bim.stair");
  assert(stairEl !== undefined && stairEl.props.meta?.renovationStatus === "new", "the renovation status survived");
  const wallEl = snap.elements.find((e) => e.props?.type === "bim.wall");
  assert(wallEl !== undefined && wallEl.props.meta?.optionGroupId !== undefined, "the option membership survived");
  const life = val(await q("bim.getLifecycle", { elementId: "space-office" }));
  assert(life.elements[0].renovationStatus === "existing", "the derived default survives");
}
val(await cmd("document.open", { source: saved1.bytes, entityId: "cad-parity-011-smoke-final" }));

// --- 12. the pinned fixture ------------------------------------------------------

step("fixture");

const sA = val(await cmd("document.save", {}));
const sB = val(await cmd("document.save", {}));
assert(sha(JSON.stringify(sA.bytes)) === sha(JSON.stringify(sB.bytes)), "save must be deterministic");
snap = val(await q("document.getState", {}));

const semantics = val(await q("bim.getSemantics", {}));
const lifecycle = val(await q("bim.getLifecycle", {}));
const options = val(await q("bim.getOptions", {}));

const fixture = {
  saveSha256: sha(JSON.stringify(sA.bytes)),
  saveSize: sA.bytes.length,
  elements: snap.elements.length,
  roofs: byType("bim.roof").length,
  stairs: byType("bim.stair").length,
  railings: byType("bim.railing").length,
  zones: byType("bim.zone").length,
  optionGroups: byType("bim.optionGroup").length,
  builtCount: built3.built,
  buildTokensSha256: sha(built3.results.map((r) => r.meshToken).sort().join("\n")),
  semanticsSha256: sha(JSON.stringify(semantics)),
  lifecycleSha256: sha(JSON.stringify(lifecycle)),
  optionsSha256: sha(JSON.stringify(options)),
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`BIM P011 SMOKE: fixture written → ${FIXTURE_PATH}`);
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
  console.log(`BIM P011 SMOKE: fixture match (${pinned.saveSha256.slice(0, 8)}…, ${executed.length} commands)`);
}

console.log(`BIM P011 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines)`);
