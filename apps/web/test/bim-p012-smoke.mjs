// CAD-PARITY-012 / Issue #102: Web host BIM P012 workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (STORY/LINE/CIRCLE/
// MATERIAL/MATSET/BLOCK/INSERT/CGRID/REVCLOUD/MATLIST/BOM/CLASH in
// commands.ts + commands-coordination.ts) plus the App API surface the
// Coordination palette produces (material.create/update/remove/assign,
// grid.create/update, block.update, components.list/materials.list/
// materials.bom/grids.list/coordination.clash — the SAME HTTP endpoints the
// palette's transport wrappers call; the palette itself is DOM, this smoke
// proves the wire surface under it) — against the running dev server,
// asserting the document state after every step. This is the Web half of
// the Web/Electron semantic-parity evidence (LOCK-004); the pinned fixture
// (app/test/fixtures/cad-parity-012-coordination.json) is the parity basis.
//
// Covers the CAD-PARITY-012 acceptance surface: the constrained material
// vocabulary with the deterministic category defaults (keyword + full-name
// category resolution, #RRGGBB colors, lineweight), full-record material
// assignment with the EXACT-UNDO-INVERSE discipline (absence restored as
// canonical absence, never an undefined hole), the component library as the
// P006 block system (fromElementIds conversion + insertion + the
// definition materialId default + the reference-checked removal gate), the
// story-hosted grid datums with DERIVED Excel-style labels, the revision
// cloud markup (clash-excluded, unassigned-by-construction), the pairwise
// clash detection over the concrete 2D view (deterministic pairs + points +
// checked/excluded counts), the report surfaces (MATLIST/BOM/CLASH as
// engine commands with the report.* + palette.show ui actions), and the
// save/open round-trip preserving the whole authored state.
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis (the parity
// pattern). Start the dev server with OFFISOS_GEOMETRY_ENGINE=reference.
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference npm run dev -- --webpack -p 3100 &
//            then: node --import tsx apps/web/test/bim-p012-smoke.mjs
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-012-coordination.json");
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
const step = (name) => console.log(`BIM P012 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- document -----------------------------------------------------------------

val(
  await cmd("document.create", {
    entityId: "cad-parity-012-smoke",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-012-smoke",
  }),
);
let snap = val(await q("document.getState", {}));
let activeStoryId = null;
let storyCount = 0;

function context(overrides = {}) {
  // The MaterialContextEntry view the MATSET builder resolves names against
  // (CAD-PARITY-012): the bim.material elements with the parity fields.
  const materials = snap.elements
    .filter((e) => e.props?.type === "bim.material")
    .map((e) => ({
      id: e.id,
      name: e.props.name,
      ...(e.props.category !== undefined ? { category: e.props.category } : {}),
      ...(e.props.color !== undefined ? { color: e.props.color } : {}),
      ...(e.props.lineweight !== undefined ? { lineweight: e.props.lineweight } : {}),
    }));
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
    materials,
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
const byType = (type) => snap.elements.filter((e) => e.props?.type === type);
const elementByType = (type) => byType(type)[0];
const materialsTable = async () => val(await q("materials.list", {}));
const componentsTable = async () => val(await q("components.list", {}));
const gridsTable = async () => val(await q("grids.list", {}));

// --- 1. the story + the source geometry (registry commands) --------------------

step("STORY + LINE + CIRCLE through the shared command registry");
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

  await runScript([
    { event: { type: "typed", text: "LINE" } },
    { event: { type: "typed", text: "0,0" } },
    { event: { type: "typed", text: "400,0" } },
    { event: { type: "enter" } }, // end the chain
  ]);
  await runScript([
    { event: { type: "typed", text: "CIRCLE" } },
    { event: { type: "typed", text: "200,200" } },
    { event: { type: "typed", text: "100" } },
  ]);
  assert(byType("line").length === 1, "one line authored");
  assert(byType("circle").length === 1, "one circle authored");
  globalThis.__p012 = { gf };
}
const { gf } = globalThis.__p012;
const lineEl = elementByType("line");
const circleEl = elementByType("circle");

// --- 2. MATERIAL #1 (registry: keyword category + Enter defaults) --------------

step("MATERIAL 'Concrete C30' (CON keyword, Enter = category default color + 1.4 lineweight)");
await runScript([
  { event: { type: "typed", text: "MATERIAL" } },
  { event: { type: "typed", text: "Concrete C30" } },
  { event: { type: "typed", text: "CON" } }, // the category keyword flag
  { event: { type: "enter" } }, // advance past the category step (the flag wins)
  { event: { type: "enter" } }, // color <category default>
  { event: { type: "enter" } }, // lineweight <1.4>
]);
{
  const rows = (await materialsTable()).materials;
  assert(rows.length === 1, "one material in the table");
  const row = rows[0];
  assert(row.name === "Concrete C30", "material name");
  assert(row.category === "Concrete", "CON keyword resolved to Concrete");
  assert(
    Array.isArray(row.color) && row.color.length === 3 &&
      row.color.every((c, i) => close(c, [168, 162, 158][i])),
    `Concrete category default color [168,162,158] (got ${JSON.stringify(row.color)})`,
  );
  assert(close(row.lineweight, 1.4), "default lineweight 1.4");
  globalThis.__p012.concreteId = row.id;
}
const concreteId = globalThis.__p012.concreteId;

// --- 3. MATSET (registry: previous-selection picks + name) + exact inverse -----

step("MATSET both entities → 'Concrete C30', then undo/redo proves the exact inverse");
{
  // The multi-object pick through the engine's previous-selection path (the
  // professional UI's selection-driven MATSET).
  const sel = [pickOf(lineEl.id), pickOf(circleEl.id)];
  const { result } = await runScript(
    [
      { event: { type: "typed", text: "MATSET" } },
      { event: { type: "typed", text: "P" } }, // objects ← current selection (both)
      { event: { type: "typed", text: "Concrete C30" } },
    ],
    { currentSelection: sel },
  );
  assert(
    result.lines.some((l) => l.includes("2 found")),
    `both entities picked through the previous-selection path: ${result.lines.join(" / ")}`,
  );
  snap = val(await q("document.getState", {}));
  const lineAssigned = snap.elements.find((e) => e.id === lineEl.id);
  const circleAssigned = snap.elements.find((e) => e.id === circleEl.id);
  assert(lineAssigned.props.materialId === concreteId, "the line carries materialId");
  assert(circleAssigned.props.materialId === concreteId, "the circle carries materialId");

  // UNDO: the material.assign inverse restores the PREVIOUS props exactly —
  // the materialId key is canonically ABSENT (never an undefined hole).
  val(await cmd("document.undo", {}));
  snap = val(await q("document.getState", {}));
  for (const id of [lineEl.id, circleEl.id]) {
    const el = snap.elements.find((e) => e.id === id);
    assert(
      !("materialId" in (el.props ?? {})),
      `undo removed the materialId key exactly on '${id}' (canonical absence)`,
    );
  }
  // REDO: restored byte-identically.
  val(await cmd("document.redo", {}));
  snap = val(await q("document.getState", {}));
  for (const id of [lineEl.id, circleEl.id]) {
    const el = snap.elements.find((e) => e.id === id);
    assert(el.props.materialId === concreteId, `redo restored materialId on '${id}'`);
  }
}

// --- 4. MATERIAL #2 (registry: explicit color + lineweight) --------------------

step("MATERIAL 'Steel S355' (STL keyword, #4a5568, lineweight 2)");
await runScript([
  { event: { type: "typed", text: "MATERIAL" } },
  { event: { type: "typed", text: "Steel S355" } },
  { event: { type: "typed", text: "STL" } }, // the category keyword flag
  { event: { type: "enter" } }, // advance past the category step (the flag wins)
  { event: { type: "typed", text: "#4a5568" } },
  { event: { type: "typed", text: "2" } },
]);
{
  const rows = (await materialsTable()).materials;
  assert(rows.length === 2, "two materials in the table");
  const steel = rows.find((m) => m.name === "Steel S355");
  assert(steel !== undefined, "steel row present");
  assert(steel.category === "Steel", "STL keyword resolved to Steel");
  assert(
    Array.isArray(steel.color) && steel.color.every((c, i) => close(c, [0x4a, 0x55, 0x68][i])),
    `explicit #4a5568 color (got ${JSON.stringify(steel.color)})`,
  );
  assert(close(steel.lineweight, 2), "explicit lineweight 2");
  globalThis.__p012.steelId = steel.id;
}
const steelId = globalThis.__p012.steelId;

// --- 5. the palette-path material CRUD (form create / edit / remove) -----------

step("palette path: material.create (form) + material.update + material.remove (clean + reference-checked)");
{
  // The palette's create-form path over the same HTTP endpoint: full category
  // name + absent optional fields (color absent = canonical omission — the
  // host display layer resolves the category default at render time;
  // lineweight defaults server-side to 1.4).
  val(await cmd("material.create", { name: "Glazing DGU", category: "Glass" }));
  {
    const rows = (await materialsTable()).materials;
    assert(rows.length === 3, "three materials after the palette-form create");
    const glazing = rows.find((m) => m.name === "Glazing DGU");
    assert(glazing.category === "Glass", "full category name resolved");
    assert(
      glazing.color === undefined,
      "absent color stays omitted (the palette render layer resolves the Glass category default)",
    );
    assert(close(glazing.lineweight, 1.4), "server-side default lineweight");
    globalThis.__p012.glazingId = glazing.id;
  }
  // The palette's edit path: a full-record patch through material.update.
  val(
    await cmd("material.update", {
      elementId: concreteId,
      patch: { description: "Ready-mix C30/37 structural concrete" },
    }),
  );
  {
    const row = (await materialsTable()).materials.find((m) => m.id === concreteId);
    assert(row.description === "Ready-mix C30/37 structural concrete", "material.update wrote the description");
  }
  // Clean removal (unreferenced).
  val(await cmd("material.remove", { elementId: globalThis.__p012.glazingId }));
  assert((await materialsTable()).materials.length === 2, "two materials after the clean removal");
  snap = val(await q("document.getState", {}));
}

// --- 6. the COMPONENT path (registry BLOCK/INSERT + block.update) ---------------

step("BLOCK 'P-100' from the line+circle, INSERT at (1200,600), block.update def materialId");
{
  const revisionsBefore = snap.modelHistory?.revisions?.length ?? 0;
  await runScript([
    { event: { type: "typed", text: "BLOCK" } },
    { event: { type: "typed", text: "P-100" } },
    { event: { type: "typed", text: "0,0" } }, // insertion base point
    { event: { type: "entity", entity: pickOf(lineEl.id) } },
    { event: { type: "entity", entity: pickOf(circleEl.id) } },
    { event: { type: "enter" } }, // complete the object set
  ]);
  assert((snap.blockDefs ?? []).length === 1, "one block definition");
  const def = snap.blockDefs[0];
  assert(def.name === "P-100", "definition name");
  assert(def.entities.length === 2, "2 inline entities (line + circle)");
  assert(def.materialId === undefined, "no definition materialId yet");
  assert(snap.elements.find((e) => e.id === lineEl.id) === undefined, "line source converted");
  assert(snap.elements.find((e) => e.id === circleEl.id) === undefined, "circle source converted");
  const revisionsAfterBlock = snap.modelHistory?.revisions?.length ?? 0;
  assert(
    revisionsAfterBlock === revisionsBefore + 1,
    `BLOCK is ONE revision (Δ=${revisionsAfterBlock - revisionsBefore})`,
  );
  globalThis.__p012.defId = def.id;

  await runScript([
    { event: { type: "typed", text: "INSERT" } },
    { event: { type: "typed", text: "P-100" } },
    { event: { type: "typed", text: "1200,600" } },
    { event: { type: "typed", text: "1" } }, // scale
    { event: { type: "typed", text: "0" } }, // rotation
  ]);
  const instances = byType("block-ref");
  assert(instances.length === 1, "one inserted instance");
  const instance = instances[0];
  assert(instance.props.blockId === def.id, "instance references the definition");
  assert(close(instance.props.x, 1200) && close(instance.props.y, 600), "insertion point (1200,600)");
  globalThis.__p012.instanceId = instance.id;

  // The palette's component-default path: block.update materialId.
  val(await cmd("block.update", { name: "P-100", patch: { materialId: steelId } }));
  snap = val(await q("document.getState", {}));
  {
    const components = (await componentsTable()).components;
    assert(components.length === 1, "one component in the inventory");
    const comp = components[0];
    assert(comp.name === "P-100", "component name");
    assert(comp.materialId === steelId, "components.list reflects the definition materialId");
    assert(comp.instanceCount === 1, "instanceCount 1");
    assert(
      Array.isArray(comp.instanceIds) && comp.instanceIds.length === 1 && comp.instanceIds[0] === instance.id,
      "instanceIds lists the inserted instance",
    );
    assert(snap.blockDefs[0].materialId === steelId, "snapshot definition materialId");
  }
  // The reference-checked removal gate: Steel is referenced by the definition.
  {
    const res = await cmd("material.remove", { elementId: steelId });
    assert(res.ok === false, "material.remove of a referenced material fails");
    assert(res.code === "material_in_use", `typed failure material_in_use (got ${res.code})`);
    assert(String(res.message).includes(globalThis.__p012.defId), "the failure lists the referencing definition");
    assert((await materialsTable()).materials.length === 2, "nothing changed after the typed failure");
  }
}

// --- 7. CGRID (registry: name + Enter defaults) + the palette grid paths --------

step("CGRID 'Structural' (Enter defaults 0,6000 / 0,4000) + palette grid.create 3×3 + grid.update");
{
  await runScript([
    { event: { type: "typed", text: "CGRID" } },
    { event: { type: "typed", text: "Structural" } },
    { event: { type: "enter" } }, // uLines <0,6000>
    { event: { type: "enter" } }, // vLines <0,4000>
  ]);
  {
    const grids = (await gridsTable()).grids;
    assert(grids.length === 1, "one grid datum");
    const grid = grids[0];
    assert(grid.name === "Structural", "grid name");
    assert(grid.storyId === gf, "the grid is story-hosted (the active story)");
    assert(
      Array.isArray(grid.uLines) && grid.uLines.length === 2 && close(grid.uLines[0], 0) && close(grid.uLines[1], 6000),
      "uLines 0,6000",
    );
    assert(
      Array.isArray(grid.vLines) && grid.vLines.length === 2 && close(grid.vLines[0], 0) && close(grid.vLines[1], 4000),
      "vLines 0,4000",
    );
    assert(
      JSON.stringify(grid.uLabels) === JSON.stringify(["A", "B"]) && JSON.stringify(grid.vLabels) === JSON.stringify(["1", "2"]),
      `derived labels A,B / 1,2 (one per line, got ${JSON.stringify(grid.uLabels)}/${JSON.stringify(grid.vLabels)})`,
    );
    globalThis.__p012.structuralGridId = grid.id;
  }
  // The palette's grid-create form path: a 3×3 grid on the same story.
  val(
    await cmd("grid.create", {
      name: "Setting Out",
      storyId: gf,
      uLines: [0, 4000, 8000],
      vLines: [0, 3000, 6000],
    }),
  );
  {
    const grids = (await gridsTable()).grids;
    assert(grids.length === 2, "two grid datums");
    const settingOut = grids.find((g) => g.name === "Setting Out");
    assert(settingOut !== undefined, "Setting Out grid present");
    assert(
      JSON.stringify(settingOut.uLabels) === JSON.stringify(["A", "B", "C"]) &&
        JSON.stringify(settingOut.vLabels) === JSON.stringify(["1", "2", "3"]),
      "derived labels A,B,C / 1,2,3",
    );
    globalThis.__p012.settingOutGridId = settingOut.id;
  }
  // The palette's grid edit path: whole-array uLines replacement → the
  // derived labels track the new sorted order.
  val(
    await cmd("grid.update", {
      elementId: globalThis.__p012.settingOutGridId,
      patch: { uLines: [0, 2000, 4000, 6000, 8000] },
    }),
  );
  {
    const settingOut = (await gridsTable()).grids.find((g) => g.name === "Setting Out");
    assert(
      JSON.stringify(settingOut.uLabels) === JSON.stringify(["A", "B", "C", "D", "E"]),
      `derived labels track the grid.update (got ${JSON.stringify(settingOut.uLabels)})`,
    );
  }
}

// --- 8. REVCLOUD (registry: two corners) ----------------------------------------

step("REVCLOUD two corner picks — the closed scalloped markup polyline");
await runScript([
  { event: { type: "typed", text: "REVCLOUD" } },
  { event: { type: "typed", text: "300,400" } },
  { event: { type: "typed", text: "900,700" } },
]);
let revcloudEl;
{
  const revclouds = snap.elements.filter((e) => e.props?.marker === "revcloud");
  assert(revclouds.length === 1, "one revision cloud");
  revcloudEl = revclouds[0];
  assert(revcloudEl.props.type === "polyline", "revcloud is a polyline");
  assert(revcloudEl.props.closed === true, "revcloud is closed");
  assert(revcloudEl.props.drafting === true, "revcloud is drafting content");
  // Deterministic sampling: edges 600/300/600/300 → 10/5/10/5 scallops × 8
  // samples = 240 vertices.
  assert(
    Array.isArray(revcloudEl.props.vertices) && revcloudEl.props.vertices.length === 240,
    `240 scallop vertices (got ${revcloudEl.props.vertices?.length})`,
  );
}

// --- 9. the clash scene (a crossing line) + undo/redo determinism ---------------

step("crossing LINE + coordination.clash (deterministic pairs, checked/excluded) + undo/redo");
let clashJsonFull;
{
  // The inserted instance expands to the line (1200,600)→(1600,600) and the
  // circle center (1400,800) r100; a horizontal line through the circle
  // center crosses it at (1300,800) and (1500,800).
  await runScript([
    { event: { type: "typed", text: "LINE" } },
    { event: { type: "typed", text: "1100,800" } },
    { event: { type: "typed", text: "1700,800" } },
    { event: { type: "enter" } }, // end the chain
  ]);
  const crossingLine = elementByType("line");
  assert(crossingLine !== undefined, "the crossing line exists");
  globalThis.__p012.crossLineId = crossingLine.id;

  const clash = val(await q("coordination.clash", {}));
  const clash2 = val(await q("coordination.clash", {}));
  const j1 = JSON.stringify(clash);
  const j2 = JSON.stringify(clash2);
  assert(j1 === j2, "coordination.clash is deterministic across double-run");
  clashJsonFull = j1;
  assert(clash.checked === 3, `checked 3 participants (instance line + circle + crossing line): got ${clash.checked}`);
  assert(clash.excluded === 1, `excluded 1 (the revision cloud): got ${clash.excluded}`);
  assert(clash.pairs.length === 1, "one clash pair");
  const pair = clash.pairs[0];
  assert(
    (pair.a === globalThis.__p012.instanceId && pair.b === globalThis.__p012.crossLineId) ||
      (pair.a === globalThis.__p012.crossLineId && pair.b === globalThis.__p012.instanceId),
    `the pair is instance ↔ crossing line (got ${pair.a} ↔ ${pair.b})`,
  );
  assert(pair.points.length === 2, "two intersection points");
  const pts = [...pair.points].sort((p, qq) => p.x - qq.x);
  assert(close(pts[0].x, 1300) && close(pts[0].y, 800), `point 1 (1300,800): got (${pts[0].x},${pts[0].y})`);
  assert(close(pts[1].x, 1500) && close(pts[1].y, 800), `point 2 (1500,800): got (${pts[1].x},${pts[1].y})`);

  // Undo the crossing line → the clash scene drops to the instance alone.
  val(await cmd("document.undo", {}));
  snap = val(await q("document.getState", {}));
  assert(snap.elements.find((e) => e.id === globalThis.__p012.crossLineId) === undefined, "undo removed the crossing line");
  {
    const clashAfterUndo = val(await q("coordination.clash", {}));
    assert(clashAfterUndo.pairs.length === 0, "no pairs after the undo");
    assert(clashAfterUndo.checked === 2, "checked 2 (the instance pieces alone)");
    assert(clashAfterUndo.excluded === 1, "the revision cloud stays excluded");
  }
  val(await cmd("document.redo", {}));
  snap = val(await q("document.getState", {}));
  assert(
    snap.elements.some((e) => e.id === globalThis.__p012.crossLineId),
    "redo restored the crossing line",
  );
  {
    const clashAfterRedo = val(await q("coordination.clash", {}));
    assert(JSON.stringify(clashAfterRedo) === clashJsonFull, "the clash result after redo is identical");
  }
}

// --- 10. the palette assign-to-selection + the MATSET unassign grammar ----------

step("palette material.assign (assign-to-selection) + MATSET Enter-unassign + re-assign + unknown-name decline");
{
  // The palette's assign-to-selection path over the same HTTP endpoint.
  val(await cmd("material.assign", { ids: [globalThis.__p012.crossLineId], materialId: concreteId }));
  snap = val(await q("document.getState", {}));
  assert(
    snap.elements.find((e) => e.id === globalThis.__p012.crossLineId).props.materialId === concreteId,
    "the palette assign wrote materialId",
  );

  // The MATSET unassign grammar: Enter on the name step UNASSIGNS.
  const sel = [pickOf(globalThis.__p012.crossLineId)];
  await runScript(
    [
      { event: { type: "typed", text: "MATSET" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "enter" } }, // material name <Enter = unassign>
    ],
    { currentSelection: sel },
  );
  snap = val(await q("document.getState", {}));
  assert(
    !("materialId" in snap.elements.find((e) => e.id === globalThis.__p012.crossLineId).props),
    "MATSET Enter-unassign restored canonical absence",
  );

  // Re-assign through the engine.
  await runScript(
    [
      { event: { type: "typed", text: "MATSET" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "Concrete C30" } },
    ],
    { currentSelection: sel },
  );
  snap = val(await q("document.getState", {}));
  assert(
    snap.elements.find((e) => e.id === globalThis.__p012.crossLineId).props.materialId === concreteId,
    "MATSET re-assigned the material",
  );

  // Unknown material name: the typed failure is ECHOED, nothing changes.
  const before = JSON.stringify(snap.elements.find((e) => e.id === globalThis.__p012.crossLineId).props);
  const { result } = await runScript(
    [
      { event: { type: "typed", text: "MATSET" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "Nonexistent" } },
    ],
    { currentSelection: sel },
  );
  assert(
    result.lines.some((l) => l.includes("'Nonexistent' not found")),
    `the unknown-material decline is echoed: ${result.lines.join(" / ")}`,
  );
  snap = val(await q("document.getState", {}));
  const after = JSON.stringify(snap.elements.find((e) => e.id === globalThis.__p012.crossLineId).props);
  assert(before === after, "the unknown-name MATSET changed nothing");
}

// --- 11. the report surfaces (engine commands with report.* ui actions) ---------

step("MATLIST / BOM / CLASH as engine commands (report ui actions + palette focus)");
{
  const { plans: matlistPlans, result: matlistResult } = await runScript([{ event: { type: "typed", text: "MATLIST" } }]);
  assert(matlistPlans.length === 1, "MATLIST is instant (one plan)");
  assert(JSON.stringify(matlistPlans[0].ui) === JSON.stringify([
    { action: "report.matlist" },
    { action: "palette.show", payload: { palette: "coordination" } },
  ]), `MATLIST ui actions (got ${JSON.stringify(matlistPlans[0].ui)})`);
  assert(matlistPlans[0].appApi.length === 0, "MATLIST emits no app-api commands");
  assert(matlistResult.lines.includes("MATLIST."), "the MATLIST echo line");

  const { plans: bomPlans, result: bomResult } = await runScript([{ event: { type: "typed", text: "BOM" } }]);
  assert(JSON.stringify(bomPlans[0].ui) === JSON.stringify([
    { action: "report.bom" },
    { action: "palette.show", payload: { palette: "coordination" } },
  ]), "BOM ui actions");
  assert(bomResult.lines.includes("BOM."), "the BOM echo line");

  const { plans: clashPlans, result: clashResult } = await runScript([{ event: { type: "typed", text: "CLASH" } }]);
  assert(JSON.stringify(clashPlans[0].ui) === JSON.stringify([
    { action: "report.clash" },
    { action: "palette.show", payload: { palette: "coordination" } },
  ]), "CLASH ui actions");
  assert(clashResult.lines.includes("CLASH."), "the CLASH echo line");
}

// --- 12. the bill of materials (palette path, closed-form quantities) -----------

step("materials.bom — deterministic takeoff with the unassigned row LAST");
let bomJson;
{
  const bom = val(await q("materials.bom", {}));
  bomJson = JSON.stringify(bom);
  assert(bom.unit === "document units", "document units");
  assert(bom.rows.length === 3, `3 rows (got ${bom.rows.length})`);
  // Row 0 — Concrete: the crossing line (600 long, no area).
  const concreteRow = bom.rows[0];
  assert(concreteRow.materialId === concreteId, "row 0 is Concrete");
  assert(concreteRow.name === "Concrete C30", "row 0 name");
  assert(concreteRow.count === 1, "Concrete count 1 (the crossing line)");
  assert(close(concreteRow.length, 600), `Concrete length 600 (got ${concreteRow.length})`);
  assert(close(concreteRow.area, 0), "Concrete area 0");
  // Row 1 — Steel: the instance measures its EXPANDED content as ONE element
  // (line 400 + circle 2πr, area πr²).
  const steelRow = bom.rows[1];
  assert(steelRow.materialId === steelId, "row 1 is Steel");
  assert(steelRow.count === 1, "Steel count 1 (the expanded instance)");
  assert(close(steelRow.length, 400 + 2 * Math.PI * 100), `Steel length 400+2πr (got ${steelRow.length})`);
  assert(close(steelRow.area, Math.PI * 100 * 100), `Steel area πr² (got ${steelRow.area})`);
  // Row 2 — the unassigned bucket LAST: the revision-cloud markup.
  const unRow = bom.rows[2];
  assert(unRow.materialId === null, "the unassigned row is LAST with materialId null");
  assert(unRow.name === "(unassigned)", "unassigned row name");
  assert(unRow.count === 1, "unassigned count 1 (the revision cloud)");
  // The scalloped boundary measures: an independent re-implementation of the
  // deterministic sampling (same constants) cross-checks the takeoff.
  const { perimeter, area } = revcloudMeasures(300, 400, 900, 700);
  assert(close(unRow.length, perimeter), `revcloud perimeter (got ${unRow.length}, expected ${perimeter})`);
  assert(close(unRow.area, area), `revcloud area (got ${unRow.area}, expected ${area})`);
}

/** Independent port of the deterministic revision-cloud sampling (8 samples
 *  per scallop, 4..24 scallops per edge at target span 60, outward bulge
 *  0.85·r) — the closed-form cross-check for the BOM row. */
function revcloudMeasures(x0, y0, x1, y1) {
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const maxX = Math.max(x0, x1);
  const maxY = Math.max(y0, y1);
  const corners = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  const vertices = [];
  for (let i = 0; i < 4; i++) {
    const from = corners[i];
    const to = corners[(i + 1) % 4];
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const count = Math.max(4, Math.min(24, Math.round(len / 60)));
    for (let s = 0; s < count; s++) {
      const t0 = s / count;
      const t1 = (s + 0.5) / count;
      const r = len / count / 2;
      const bulge = r * 0.85;
      const dx = (to[0] - from[0]) / len;
      const dy = (to[1] - from[1]) / len;
      const bx = from[0] + (to[0] - from[0]) * t0;
      const by = from[1] + (to[1] - from[1]) * t0;
      const ax = from[0] + (to[0] - from[0]) * t1 + dy * bulge;
      const ay = from[1] + (to[1] - from[1]) * t1 - dx * bulge;
      const nx = from[0] + (to[0] - from[0]) * ((s + 1) / count);
      const ny = from[1] + (to[1] - from[1]) * ((s + 1) / count);
      for (let k = 0; k < 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        vertices.push([u * u * bx + 2 * u * t * ax + t * t * nx, u * u * by + 2 * u * t * ay + t * t * ny]);
      }
    }
  }
  let perimeter = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let twiceArea = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i];
    const qq = vertices[(i + 1) % vertices.length];
    twiceArea += p[0] * qq[1] - qq[0] * p[1];
  }
  return { perimeter, area: Math.abs(twiceArea / 2) };
}

// --- 13. save / open round-trip — the authored state survives exactly -----------

step("save/open round-trip — the P012 coordination state survives exactly");
const saved1 = val(await cmd("document.save", {}));
val(await cmd("document.open", { source: saved1.bytes, entityId: "cad-parity-012-smoke-reopened" }));
snap = val(await q("document.getState", {}));
{
  assert(snap.elements.length === 8, `8 elements after the round-trip (got ${snap.elements.length})`);
  assert(byType("bim.material").length === 2, "both materials survive");
  assert(byType("bim.grid").length === 2, "both grids survive");
  assert(
    snap.elements.filter((e) => e.props?.marker === "revcloud").length === 1,
    "the revision cloud survives",
  );
  const reopenedDef = (snap.blockDefs ?? []).find((d) => d.name === "P-100");
  assert(reopenedDef !== undefined && reopenedDef.materialId === steelId, "the definition materialId survives");
  const components = (await componentsTable()).components;
  assert(
    components.length === 1 && components[0].materialId === steelId && components[0].instanceCount === 1,
    "components.list survives the round-trip",
  );
  const grids = (await gridsTable()).grids;
  assert(
    grids.length === 2 &&
      JSON.stringify(grids.find((g) => g.name === "Structural").uLabels) === JSON.stringify(["A", "B"]) &&
      JSON.stringify(grids.find((g) => g.name === "Setting Out").uLabels) === JSON.stringify(["A", "B", "C", "D", "E"]),
    "the derived grid labels survive",
  );
  const crossing = snap.elements.find((e) => e.id === globalThis.__p012.crossLineId);
  assert(crossing !== undefined && crossing.props.materialId === concreteId, "the assignment survives");
  assert(JSON.stringify(val(await q("materials.bom", {}))) === bomJson, "the bill of materials is identical");
  assert(JSON.stringify(val(await q("coordination.clash", {}))) === clashJsonFull, "the clash result is identical");
}
val(await cmd("document.open", { source: saved1.bytes, entityId: "cad-parity-012-smoke-final" }));

// --- 14. the pinned fixture ------------------------------------------------------

step("fixture");

const sA = val(await cmd("document.save", {}));
const sB = val(await cmd("document.save", {}));
assert(sha(JSON.stringify(sA.bytes)) === sha(JSON.stringify(sB.bytes)), "save must be deterministic");
snap = val(await q("document.getState", {}));

const materials = await materialsTable();
const components = await componentsTable();
const grids = await gridsTable();
const bom = val(await q("materials.bom", {}));
const clash = val(await q("coordination.clash", {}));

const fixture = {
  saveSha256: sha(JSON.stringify(sA.bytes)),
  saveSize: sA.bytes.length,
  elements: snap.elements.length,
  materialCount: materials.materials.length,
  componentCount: components.components.length,
  gridCount: grids.grids.length,
  revcloudCount: snap.elements.filter((e) => e.props?.marker === "revcloud").length,
  bomSha256: sha(JSON.stringify(bom)),
  clashSha256: sha(JSON.stringify(clash)),
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`BIM P012 SMOKE: fixture written → ${FIXTURE_PATH}`);
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
  console.log(`BIM P012 SMOKE: fixture match (${pinned.saveSha256.slice(0, 8)}…, ${executed.length} commands)`);
}

console.log(`BIM P012 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines)`);
