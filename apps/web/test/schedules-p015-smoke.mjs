// CAD-PARITY-015 / Issue #110: Web host schedules/indexes/properties/
// quantity-workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (PROPDEF/PROPLIST/
// QTO in commands-documentation.ts) plus the App API surface the
// Schedules workbench produces (property.create/update/remove,
// properties.list, schedule.create with the P015 engine powers — pd:
// columns, property-driven conditions, deterministic sort, calculated
// fields, grouping + subtotals/totals, presentation format — schedules.run,
// quantities.run/quantities.rules) — against the running dev server,
// asserting the document state after every step. This is the Web half of
// the Web/Electron semantic-parity evidence (LOCK-004); the app-suite
// schedules-p015-host-parity test proves the same stream through both
// hosts; the pinned fixture
// (app/test/fixtures/cad-parity-015-schedules.json) is the parity basis.
//
// Covers the CAD-PARITY-015 acceptance surface: the document-owned
// property definitions (declarations only — values counted from the
// canonical element property-set overlay, NO parallel source of truth),
// the schedules/indexes engine powers (every one OPT-IN on the saved
// definition — a P013-shaped schedule response stays byte-identical), the
// deterministic revision-bound quantity takeoff over the closed canonical
// rule table (the material BOM with density-derived mass, the honest
// skipped list, the RevisionRef binding that tracks the model head), the
// typed failure codes (schedule_invalid/quantities_invalid/
// property_exists/bad_payload) and the save/open round-trip with stable
// minted ids. Engine-free semantics (LOCK-018): the quantity rules are
// closed-form canonical derivations; no engine call is made.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-015-schedules.json");
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

const step = (name) => console.log(`SCHEDULES P015 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- 1. document + the canonical model seed ------------------------------------

step("document.create + the bim/material/property seed");
val(
  await cmd("document.create", {
    entityId: "cad-parity-015-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-015-smoke",
  }),
);
let snap = val(await q("document.getState", {}));
let activeStoryId = null;
let storyCount = 0;

function context(overrides = {}) {
  // The Schedules workbench feeds the same snapshot tables (engineCtx in
  // shell.tsx) — this smoke mirrors that host contract. The P015 commands
  // (PROPDEF/PROPLIST/QTO) need no registry tables.
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    storyCount,
    currentSelection: [],
    layers: snap.layers ?? [],
    textStyles: snap.textStyles ?? [],
    dimStyles: snap.dimStyles ?? [],
    activeStoryId,
    blocks: snap.blockDefs ?? [],
    layouts: snap.layouts ?? [],
    activeLayoutId: snap.draftingSettings?.activeLayout ?? snap.layouts?.[0]?.id ?? null,
    docsViews: snap.docsViews ?? [],
    navigatorNodes: snap.navigatorNodes ?? [],
    titleBlocks: snap.titleBlocks ?? [],
    publisherSets: snap.publisherSets ?? [],
    ...overrides,
  });
}

const echoLines = [];
async function runScript(steps, overrides = {}) {
  const plans = [];
  const result = runCommandScript(steps, context(overrides), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

const seed = val(
  await cmd("bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.story", id: "story-ff", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
      { type: "bim.roof", id: "roof-main", storyId: "story-ff", corner1: [-300, -300], corner2: [6300, 5300], ridgeAxis: "x", height: 1500 },
      {
        type: "bim.componentDef", id: "def-column", name: "Structural Column", category: "fixture",
        parameters: { width: 300, depth: 300, height: 2600 },
      },
      {
        type: "bim.componentInstance", id: "inst-column", definitionId: "def-column", storyId: "story-gf",
        position: [2000, 2000], rotation: 0,
      },
    ],
  }),
);
assert(
  JSON.stringify(seed.created) === JSON.stringify([
    "story-gf", "story-ff", "wall-south", "wall-east", "op-door", "slab-g", "space-office", "roof-main", "def-column", "inst-column",
  ]),
  `the seed created every entity (got ${JSON.stringify(seed.created)})`,
);
activeStoryId = "story-gf";
storyCount = 2;

val(await cmd("material.create", { name: "Concrete C30", category: "Concrete", color: [128, 128, 128], lineweight: 1.4, density: 2400 }));
val(await cmd("material.assign", { ids: ["wall-south", "wall-east", "slab-g"], materialId: "el-000001" }));
val(await cmd("bim.setPropertySets", {
  elementId: "wall-south",
  propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 90 }, { key: "Finish", value: "paint" }] }],
}));
val(await cmd("bim.setPropertySets", {
  elementId: "wall-east",
  propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 60 }, { key: "Finish", value: "plaster" }] }],
}));

// --- 2. the property-definition registry (direct palette paths) ------------------

step("property.create ×2 + properties.list (the lineage statistics)");
const fireDef = val(
  await cmd("property.create", { name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min", appliesTo: ["bim.wall"] }),
);
assert(/^prd-\d{6}$/.test(fireDef.propertyDef.id), `the minted prd- identity (got ${fireDef.propertyDef.id})`);
const finishDef = val(
  await cmd("property.create", { name: "Finish", set: "PSetA", key: "Finish", type: "text" }),
);
assert(finishDef.propertyDef.id === "prd-000002", `the monotonic mint (got ${finishDef.propertyDef.id})`);

let properties = val(await q("properties.list", {}));
assert(properties.contract === "offisos-properties/1", "the properties contract string");
assert(properties.valueSource === "element-property-set-overlay", "the no-parallel-truth statement");
const frRow = properties.propertyDefs.find((d) => d.name === "Fire rating");
assert(
  JSON.stringify([frRow.elementsWithValue, frRow.typeMatches, frRow.typeMismatches]) === JSON.stringify([2, 2, 0]),
  `the FR lineage stats (got ${JSON.stringify(frRow)})`,
);
const finRow = properties.propertyDefs.find((d) => d.name === "Finish");
assert(
  JSON.stringify([finRow.elementsWithValue, finRow.typeMatches, finRow.typeMismatches]) === JSON.stringify([2, 2, 0]),
  `the Finish lineage stats (got ${JSON.stringify(finRow)})`,
);

// A typed mismatch is REPORTED, never coerced.
val(await cmd("bim.setPropertySets", {
  elementId: "space-office",
  propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: "ninety" }] }],
}));
properties = val(await q("properties.list", {}));
const frMismatch = properties.propertyDefs.find((d) => d.name === "Fire rating");
assert(
  frMismatch.elementsWithValue === 3 && frMismatch.typeMatches === 2 && frMismatch.typeMismatches === 1,
  `the mismatch surfaced (got ${JSON.stringify(frMismatch)})`,
);

// The typed failure codes.
assert((await cmd("property.create", { name: "Fire rating", set: "X", key: "Y", type: "text" })).code === "property_exists");
assert((await cmd("property.create", { name: "Bad", set: "PSetA", key: "bad key!", type: "text" })).code === "property_invalid");
assert((await cmd("property.remove", { id: "prd-999999" })).code === "property_not_found");

// --- 3. the shared prompt-engine registry stream (PROPDEF/PROPLIST/QTO) ----------

step("PROPDEF 'Load rating' + PROPLIST + QTO (the shared command registry)");
const { result: pdScript } = await runScript([
  { event: { type: "typed", text: "PROPDEF" } },
  { event: { type: "typed", text: "Load rating" } },
  { event: { type: "typed", text: "PSetB" } },
  { event: { type: "typed", text: "LoadRating" } },
  { event: { type: "typed", text: "NUM" } }, // the type flag (selected)
  { event: { type: "enter" } }, // completes the type step (the flag wins)
  { event: { type: "typed", text: "kN" } }, // the unit
  { event: { type: "enter" } }, // applies to <all>
]);
assert(
  pdScript.lines.includes("PROPDEF: 'Load rating' PSetB.LoadRating (number, kN)."),
  `the PROPDEF echo (got ${pdScript.lines.join(" / ")})`,
);

const { result: plScript } = await runScript([{ event: { type: "typed", text: "PROPLIST" } }]);
assert(plScript.lines.includes("PROPLIST."), `the PROPLIST echo (got ${plScript.lines.join(" / ")})`);

const { result: qtoScript, plans: qtoPlans } = await runScript([
  { event: { type: "typed", text: "QTO" } },
  { event: { type: "typed", text: "EL" } }, // the source flag (selected)
  { event: { type: "enter" } }, // completes the source step (the flag wins)
  { event: { type: "typed", text: "TY" } }, // the group flag (selected)
  { event: { type: "enter" } }, // completes the group step (the flag wins)
  { event: { type: "enter" } }, // the type filter <none>
]);
assert(
  qtoScript.lines.includes("QTO: elements grouped by type."),
  `the QTO echo (got ${qtoScript.lines.join(" / ")})`,
);
// The QTO command's plan carries ONLY ui actions (a query surface — no
// revision): the host runs quantities.run from the action payload.
assert(
  qtoPlans.length === 1 && qtoPlans[0].appApi.length === 0 && qtoPlans[0].ui.length === 1,
  "the QTO plan is a pure ui-action surface",
);
assert(
  JSON.stringify(qtoPlans[0].ui[0]) === JSON.stringify({
    action: "report.quantities", payload: { source: "elements", groupBy: "type" },
  }),
  `the QTO ui action payload (got ${JSON.stringify(qtoPlans[0].ui[0])})`,
);

// --- 4. the schedules/indexes engine powers ---------------------------------------

step("schedule.create with the full P015 feature set + schedules.run determinism");
const created = val(
  await cmd("schedule.create", {
    name: "Walls — fire rating",
    source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "material", label: "Material" },
      { key: `pd:${fireDef.propertyDef.id}`, label: "Fire rating", format: { unit: "min", align: "right" } },
      { key: "calc:score", label: "Score", formula: { op: "mul", left: { column: `pd:${fireDef.propertyDef.id}` }, right: { value: 2 } } },
    ],
    filter: { type: "bim.wall" },
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: 30 }],
    sort: [{ key: `pd:${fireDef.propertyDef.id}`, direction: "desc" }],
    grouping: ["material"],
  }),
);
assert(created.schedule.id === "sch-000001", `the minted sch- identity (got ${created.schedule.id})`);

const wallRun = val(await q("schedules.run", { id: "sch-000001" }));
assert(wallRun.rowCount === 2, `the conditioned wall rows (got ${wallRun.rowCount})`);
// Sorted desc by the pd: numeric channel: 90 min before 60 min.
assert(
  JSON.stringify(wallRun.rows.map((r) => [r[0], r[2], r[3]])) === JSON.stringify([
    ["wall-south", "90 min", "180"],
    ["wall-east", "60 min", "120"],
  ]),
  `the sorted + formatted + calculated rows (got ${JSON.stringify(wallRun.rows)})`,
);
// Two groups (Concrete C30 for both walls) with subtotals over the numeric
// channels + the grand totals.
assert(
  JSON.stringify(wallRun.groups.map((g) => [g.key, g.rowCount, g.subtotals])) === JSON.stringify([
    [["Concrete C30"], 2, [null, null, 150, 300]],
  ]),
  `the group segments (got ${JSON.stringify(wallRun.groups)})`,
);
assert(JSON.stringify(wallRun.totals) === JSON.stringify([null, null, 150, 300]), "the grand totals");
assert(/^[0-9a-f]{64}$/.test(wallRun.sha256), "the canonical rows sha256");

// Determinism: the same state yields the identical run.
const wallRun2 = val(await q("schedules.run", { id: "sch-000001" }));
assert(JSON.stringify(wallRun) === JSON.stringify(wallRun2), "double-run is identical");

// A P013-shaped schedule stays byte-identical (no groups/totals fields).
val(
  await cmd("schedule.create", {
    name: "All elements (legacy shape)",
    source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "type", label: "Type" },
    ],
  }),
);
const legacyRun = val(await q("schedules.run", { id: "sch-000002" }));
assert(
  !("groups" in legacyRun) && !("totals" in legacyRun),
  "the legacy-shaped response carries no groups/totals",
);

// The typed failure codes.
assert(
  (await cmd("schedule.create", {
    name: "Bad", source: "elements", columns: [{ key: "id", label: "Id" }],
    conditions: [{ set: "PSetA", key: "FireRating", op: "gt", value: "90" }],
  })).code === "schedule_invalid",
  "gt with a string comparand is a typed decline",
);
assert(
  (await cmd("schedule.create", {
    name: "Bad", source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "calc:x", label: "X", formula: { op: "mul", left: { column: "junk" }, right: { value: 2 } } },
    ],
  })).code === "schedule_invalid",
  "an unknown formula operand column is a typed decline",
);

// The schedule.update patch path (grouping removal) + undo/redo.
val(await cmd("schedule.update", { id: "sch-000001", patch: { grouping: null } }));
const ungrouped = val(await q("schedules.run", { id: "sch-000001" }));
assert(!("groups" in ungrouped), "the grouping removal dropped the structured fields");
val(await cmd("document.undo", {}));
const regrouped = val(await q("schedules.run", { id: "sch-000001" }));
assert(JSON.stringify(regrouped) === JSON.stringify(wallRun), "the undo restored the grouped run bit-for-bit");

// --- 5. the quantity workflows ----------------------------------------------------

step("quantities.run (elements grouped by material + components + materials BOM) + quantities.rules");
const rules = val(await q("quantities.rules", {}));
assert(rules.contract === "offisos-quantity-rules/1", "the rules contract string");
assert(rules.rules.length === 7, `the closed rule table (got ${rules.rules.length})`);
assert(rules.liveCounts.find((c) => c.type === "bim.wall").count === 2, "the live wall count");
const rulesJson = JSON.stringify(rules);

let quantities = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
assert(quantities.contract === "offisos-quantities/1", "the takeoff contract string");
// The wall net volumes (gross − the door void) + the slab + the space + the
// roof + the stair-less seed's component, aggregated per material.
const southVolume = 6000 * 300 * 3000 - 900 * 2100 * 300;
const eastVolume = 5000 * 300 * 3000;
const slabVolume = 6600 * 5600 * 200;
const concreteVolume = southVolume + eastVolume + slabVolume;
const unassignedVolume = 6000 * 3000 * 3000 + (5600 * 6600 * 1500) / 2 + 300 * 300 * 2600;
assert(
  JSON.stringify(quantities.groups.map((g) => [g.key, g.count, g.volume])) === JSON.stringify([
    [["Concrete C30"], 3, concreteVolume],
    [["-"], 3, unassignedVolume],
  ]),
  `the per-material groups (got ${JSON.stringify(quantities.groups.map((g) => [g.key, g.count, g.volume]))})`,
);
assert(quantities.totals.volume === concreteVolume + unassignedVolume, "the grand total volume");
assert(quantities.skipped.length === 5, `the honest skipped list (got ${quantities.skipped.length})`);
assert(/^[0-9a-f]{64}$/.test(quantities.reportSha256), "the report sha256");

// The revision binding: bound to the current model head, tracking mutations.
const bindingBefore = quantities.revision.revision_number;
const components = val(await q("quantities.run", { source: "components" }));
assert(
  JSON.stringify(components.rows.map((r) => [r.elementId, r.volume])) === JSON.stringify([["inst-column", 300 * 300 * 2600]]),
  "the components source scopes to componentInstance entities",
);
const bom = val(await q("quantities.run", { source: "materials" }));
assert(
  JSON.stringify(bom.bom.map((r) => [r.materialName, r.count, r.volume, r.mass])) === JSON.stringify([
    ["Concrete C30", 3, concreteVolume, 2400 * concreteVolume * 1e-9],
    ["-", 3, unassignedVolume, null],
  ]),
  `the material BOM with density-derived mass (got ${JSON.stringify(bom.bom)})`,
);

// A canonical mutation moves the binding AND the report (fresh derivation).
val(await cmd("bim.move", { ids: ["wall-east"], dx: 0, dy: 1000, dz: 0 }));
quantities = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
assert(
  quantities.revision.revision_number === bindingBefore + 1,
  `the binding tracks the model head (got ${quantities.revision.revision_number})`,
);
assert(
  quantities.groups.find((g) => g.key[0] === "Concrete C30").volume === concreteVolume,
  "the moved wall keeps its length (the volume is a function of canonical state)",
);
const movedQuantitiesJson = JSON.stringify(quantities);

// The typed failure codes.
assert((await q("quantities.run", {})).code === "bad_payload");
assert((await q("quantities.run", { source: "views" })).code === "quantities_invalid");
assert((await q("quantities.run", { source: "materials", groupBy: "type" })).code === "quantities_invalid");

// --- 6. undo/redo + save/open round-trip --------------------------------------------

step("undo/redo the move (the revision binding moves with the journal) + save/open round-trip");
// The undo appends a journal revision (the inverse edit): the measures are
// the SAME (the move does not change the wall length) but the binding — and
// therefore the report hash — moves with the head. Then redo restores it.
const movedHash = quantities.reportSha256;
const undoRes = val(await cmd("document.undo", {}));
assert(undoRes.undone !== undefined, "the undo journal entry");
let undoneQuantities = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
assert(
  undoneQuantities.revision.revision_number === quantities.revision.revision_number + 1,
  "the binding advanced with the undo journal revision",
);
assert(
  JSON.stringify(undoneQuantities.rows) === JSON.stringify(quantities.rows) &&
    undoneQuantities.reportSha256 !== movedHash,
  "identical measures, a different (revision-bound) report hash",
);
val(await cmd("document.redo", {}));
undoneQuantities = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
// The redo is itself a journal revision — the binding stays on the (new)
// head; the MEASURES are restored exactly and the report at this head is
// deterministic (a re-run yields the identical hash).
assert(
  JSON.stringify(undoneQuantities.rows) === JSON.stringify(quantities.rows),
  "the redo restored the measures exactly",
);
assert(
  undoneQuantities.revision.revision_number === quantities.revision.revision_number + 2,
  "undo + redo advanced the head by two journal revisions",
);
const redoRerun = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
assert(redoRerun.reportSha256 === undoneQuantities.reportSha256, "the report at this head is deterministic");
const redoRerunJson = JSON.stringify(redoRerun);

let registry = val(await q("properties.list", {}));
assert(registry.propertyDefs.length === 3, "the property registry is intact across undo/redo");

const sA = val(await cmd("document.save", {}));
const sB = val(await cmd("document.save", {}));
assert(sha(JSON.stringify(sA.bytes)) === sha(JSON.stringify(sB.bytes)), "double-save is byte-identical");

val(await cmd("document.open", { source: sA.bytes, entityId: "cad-parity-015-smoke-reopened" }));
snap = val(await q("document.getState", {}));
assert(snap.propertyDefs.length === 3, "the property registry survives the round-trip");
const afterOpen = val(await q("schedules.run", { id: "sch-000001" }));
assert(JSON.stringify(afterOpen) === JSON.stringify(regrouped), "the schedule run is identical after the round-trip");
const quantitiesAfter = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
assert(JSON.stringify(quantitiesAfter) === redoRerunJson, "the quantity takeoff is identical after the round-trip");
const propertiesAfter = val(await q("properties.list", {}));
assert(propertiesAfter.propertyDefs[0].id === "prd-000001", "stable minted ids after the round-trip");

// --- 7. the pinned fixture ------------------------------------------------------------

step("fixture");

snap = val(await q("document.getState", {}));

const finalWallRun = val(await q("schedules.run", { id: "sch-000001" }));
const finalProperties = val(await q("properties.list", {}));
const finalQuantities = val(await q("quantities.run", { source: "elements", groupBy: "material" }));
const finalRules = val(await q("quantities.rules", {}));

const fixture = {
  saveSha256: sha(JSON.stringify(sA.bytes)),
  saveSize: sA.bytes.length,
  elements: snap.elements.length,
  propertyDefCount: (snap.propertyDefs ?? []).length,
  scheduleCount: (snap.schedules ?? []).length,
  scheduleRunSha256: sha(JSON.stringify(finalWallRun)),
  propertiesListSha256: sha(JSON.stringify(finalProperties)),
  quantitiesReportSha256: sha(JSON.stringify(finalQuantities)),
  quantitiesRulesSha256: sha(JSON.stringify(finalRules)),
  revisionCount: snap.modelHistory?.revisions?.length ?? 0,
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`SCHEDULES P015 SMOKE: fixture written → ${FIXTURE_PATH}`);
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
  console.log(`SCHEDULES P015 SMOKE: fixture match (${pinned.saveSha256.slice(0, 8)}…, ${executed.length} commands)`);
}

void rulesJson;
console.log(`SCHEDULES P015 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines)`);
