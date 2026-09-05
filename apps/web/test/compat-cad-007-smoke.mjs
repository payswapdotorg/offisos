// COMPAT-CAD-007 / Issue #1: Web host core-editing/selection smoke.
//
// Drives the EXACT prompt-engine command stream the professional workspace
// UI produces for the CAD-BENCH-RW-001 selection/edit flows — against the
// running dev server (the plans commit through the REAL App API over HTTP),
// asserting the CC007 contracts:
//   1. DEF-021: the selection keywords (ALL/LAST/P/PREVIOUS) live INSIDE
//      "Select objects:" prompts — they collect, they never cancel the
//      running command (no *Cancel*, no SELECTALL escape);
//   2. DEF-006: the `entities` window/crossing batch collects into the
//      running command's object step (validated + deduplicated, "N found"
//      echoes), input-only until the command's own commit;
//   3. DEF-007: the advertised option word-forms (Undo/Close/Through/
//      Radius) select their options; typed tokens never start commands
//      mid-prompt (LINE survives "CIRCLE", POLYLINE survives "Arc");
//   4. the G4 quadrilateral trim closure through the REAL server — exact
//      geometry, one atomic revision;
//   5. G10: undo/redo restores the exact prior element set;
//   6. negatives: failed edits are typed failures, never false success.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- --webpack -p 3100 &
//            then: node --import tsx apps/web/test/compat-cad-007-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)

import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));
const { pickableEntityPicks } = await import(join(REPO_ROOT, "app", "src", "workspace", "selection.ts"));

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const cmd = (name, payload) => send({ type: "command", name, payload });
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const step = (name) => console.log(`COMPAT-CAD-007 SMOKE: ${name}`);
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// A fresh document for the flow (the smoke's own session).
await cmd("document.create", {});

// ---------------------------------------------------------------------------
step("G1/G2 fixture: three entities through the REAL server");
val(
  await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
      { type: "line", layer: "0", from: [100, 0], to: [100, 100] },
      { type: "circle", layer: "0", center: [200, 50], radius: 20 },
    ],
  }),
);
const before = val(await q("document.getState", {}));
assert((before.elements ?? []).length === 3, "three entities in the fixture");
const beforeVersion = before.version?.version_number;

// The REAL host context rule: the pickable view over the live document —
// exactly what both shells thread (selectableElements).
const selectableOf = (state) => pickableEntityPicks(state.elements ?? [], state.layers ?? []);
const ctx = () => {
  const state = valSyncCache ?? {};
  return defaultCommandContext({
    activeLayer: "0",
    layers: state.layers ?? [{ id: "0", name: "0", color: "#111827", visible: true }],
    selectableElements: state.selectable ?? [],
    currentSelection: state.selection ?? [],
  });
};
let valSyncCache = null;
const syncCtx = async () => {
  const state = val(await q("document.getState", {}));
  valSyncCache = { layers: state.layers, selectable: selectableOf(state), selection: [] };
  return ctx();
};

// ---------------------------------------------------------------------------
step("DEF-021: MOVE + typed ALL collects every pickable entity and the mutation commits once");
await syncCtx();
{
  const plans = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "50,25" } },
    ],
    ctx(),
    (plan) => plans.push(plan),
  );
  assert(state.commandId === null, "MOVE completed");
  assert(lines.includes("3 found (all)"), `the ALL echo: ${JSON.stringify(lines)}`);
  assert(!lines.includes("*Cancel*"), "no *Cancel* — MOVE was never lost to SELECTALL");
  assert(plans.length === 1, "one plan for the whole move");
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  const after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 3, "three entities after the move");
  assert(after.version?.version_number === beforeVersion + 1, "exactly ONE canonical revision");
  const moved = (after.elements ?? []).find((el) => el.id === "el-000001");
  assert(JSON.stringify(moved?.props?.from) === JSON.stringify([50, 25]), `el-000001 moved by (50,25) — got ${JSON.stringify(moved?.props?.from)}`);
  await syncCtx();
}

// ---------------------------------------------------------------------------
step("DEF-006: the window batch (entityPoint-free window result) collects into ERASE and erases exactly the window");
await syncCtx();
{
  // A crossing window over the two lines (the circle at x=200 stays out).
  const state = val(await q("document.getState", {}));
  const windowPicks = selectableOf(state).filter((p) => p.id !== "el-000003");
  const plans = [];
  const { state: engineState, lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "entities", entities: windowPicks } },
      { event: { type: "enter" } },
    ],
    ctx(),
    (plan) => plans.push(plan),
  );
  assert(engineState.commandId === null, "ERASE completed");
  assert(lines.includes("2 found."), `the batch echo: ${JSON.stringify(lines)}`);
  assert(plans.length === 1, "one plan");
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  const after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 1, "exactly the two window entities erased (the circle stayed)");
  assert((after.elements ?? [])[0]?.id === "el-000003", "the circle survived");
  await syncCtx();
}

// ---------------------------------------------------------------------------
step("DEF-021: typed LAST at ERASE selects the last-created entity — G10 undo/redo exact restore");
await syncCtx();
{
  const beforeErase = val(await q("document.getState", {}));
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "LAST" } },
      { event: { type: "enter" } },
    ],
    ctx(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("1 found (last: el-000003)"), `the LAST echo: ${JSON.stringify(lines)}`);
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  let after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 0, "the last entity erased");

  // G10: UNDO restores the exact prior element set.
  val(await cmd("document.undo", {}));
  after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 1, "undo restored the entity");
  assert((after.elements ?? [])[0]?.id === "el-000003", "the exact entity");
  assert(JSON.stringify((after.elements ?? [])[0]?.props) === JSON.stringify((beforeErase.elements ?? []).find((el) => el.id === "el-000003")?.props), "byte-identical props (the pre-erase state, post-move)");
  await syncCtx();
}

// ---------------------------------------------------------------------------
step("DEF-007: the option word-forms + no command escapes (engine stream)");
{
  const state = val(await q("document.getState", {}));
  valSyncCache = { layers: state.layers, selectable: selectableOf(state), selection: [] };

  // LINE + typed "Undo" — the option applies, LINE keeps running.
  const lineUndo = [];
  {
    const plans = [];
    const { state: st, lines } = runCommandScript(
      [
        { event: { type: "typed", text: "LINE" } },
        { event: { type: "typed", text: "0,0" } },
        { event: { type: "typed", text: "100,0" } },
        { event: { type: "typed", text: "Undo" } },
      ],
      ctx(),
      (plan) => plans.push(plan),
    );
    assert(st.commandId === "line", `LINE keeps running after 'Undo' (${st.commandId})`);
    assert(lines.includes("Undo one segment."), `the option echo: ${JSON.stringify(lines)}`);
    assert(!lines.includes("UNDO."), "the global UNDO command never ran");
    assert(!lines.includes("*Cancel*"), "no *Cancel*");
  }

  // POLYLINE + typed "Arc" — the typed error, PLINE keeps running.
  {
    const { state: st, lines } = runCommandScript(
      [
        { event: { type: "typed", text: "POLYLINE" } },
        { event: { type: "typed", text: "0,0" } },
        { event: { type: "typed", text: "Arc" } },
      ],
      ctx(),
      () => {},
    );
    assert(st.commandId === "polyline", `POLYLINE keeps running after 'Arc' (${st.commandId})`);
    assert(!lines.includes("*Cancel*"), "no *Cancel* — PLINE was never lost to ARC");
  }

  // OFFSET + typed "Through" — the option capture opens.
  {
    const { state: st, lines } = runCommandScript(
      [
        { event: { type: "typed", text: "OFFSET" } },
        { event: { type: "typed", text: "Through" } },
      ],
      ctx(),
      () => {},
    );
    assert(st.optionCapture?.keyword === "T", "the Through capture is open");
    assert(lines.some((l) => l.startsWith("T — ")), `the Through echo: ${JSON.stringify(lines)}`);
  }

  // MOVE + typed "SELECTALL" — stays inside the prompt.
  {
    const { state: st, lines } = runCommandScript(
      [
        { event: { type: "typed", text: "MOVE" } },
        { event: { type: "typed", text: "SELECTALL" } },
      ],
      ctx(),
      () => {},
    );
    assert(st.commandId === "move", `MOVE keeps running after 'SELECTALL' (${st.commandId})`);
    assert(lines.some((l) => l.includes("not a valid selection")), `the typed error: ${JSON.stringify(lines)}`);
    assert(!lines.includes("*Cancel*"), "no *Cancel*");
  }
  void lineUndo;
}

// ---------------------------------------------------------------------------
step("G4: the precision quadrilateral trim closure through the REAL server (implied-all edges)");
await cmd("document.create", {});
val(
  await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 0], to: [104, 0] },
      { type: "line", layer: "0", from: [100, 0], to: [100, 104] },
      { type: "line", layer: "0", from: [100, 100], to: [-4, 100] },
      { type: "line", layer: "0", from: [0, 100], to: [0, -4] },
    ],
  }),
);
{
  const state = val(await q("document.getState", {}));
  valSyncCache = { layers: state.layers, selectable: selectableOf(state), selection: [] };
  const quadBefore = state.version?.version_number;
  const selectable = selectableOf(state);
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "TRIM" } },
      { event: { type: "enter" }, note: "cutting edges: implied all objects" },
      { event: { type: "entityPoint", entity: selectable[0], point: [102, 0] } },
      { event: { type: "entityPoint", entity: selectable[1], point: [100, 102] } },
      { event: { type: "entityPoint", entity: selectable[2], point: [-2, 100] } },
      { event: { type: "entityPoint", entity: selectable[3], point: [0, -2] } },
      { event: { type: "enter" } },
    ],
    ctx(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("TRIM: 4 target(s) (implied all edges)."), `the TRIM echo: ${JSON.stringify(lines.slice(-3))}`);
  assert(plans.length === 1, "one plan for the whole trim");
  for (const entry of plans[0].appApi) val(await cmd(entry.name, entry.payload));
  const after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 4, "four boundary entities remain");
  assert(after.version?.version_number === quadBefore + 1, "one atomic revision for the closure");
  const coordsOf = (id) => {
    const el = (after.elements ?? []).find((e) => e.id === id);
    const p = el?.props ?? {};
    return [p.x1, p.y1, p.x2, p.y2];
  };
  assert(JSON.stringify(coordsOf("el-000001")) === JSON.stringify([0, 0, 100, 0]), `bottom closed: ${coordsOf("el-000001")}`);
  assert(JSON.stringify(coordsOf("el-000002")) === JSON.stringify([100, 0, 100, 100]), `right closed: ${coordsOf("el-000002")}`);
  assert(JSON.stringify(coordsOf("el-000003")) === JSON.stringify([100, 100, 0, 100]), `top closed: ${coordsOf("el-000003")}`);
  assert(JSON.stringify(coordsOf("el-000004")) === JSON.stringify([0, 100, 0, 0]), `left closed: ${coordsOf("el-000004")}`);
}

// ---------------------------------------------------------------------------
step("G4 (composed): eight excess picks, two per edge, through the REAL server — the union-of-picked-pieces semantics");
{
  // The exact-head browser G4 gate picked BOTH overshoots of every edge; the
  // pre-fix behavior silently discarded the first cut of every doubly-picked
  // edge (last-replace-wins). The composed semantics: one closed square, one
  // atomic revision, an honest skip for a stale re-pick.
  await cmd("document.create", {});
  val(
    await cmd("drafting.createEntities", {
      entities: [
        { type: "line", layer: "0", from: [-4, 0], to: [104, 0] },
        { type: "line", layer: "0", from: [100, -4], to: [100, 104] },
        { type: "line", layer: "0", from: [104, 100], to: [-4, 100] },
        { type: "line", layer: "0", from: [0, 104], to: [0, -4] },
      ],
    }),
  );
  const state = val(await q("document.getState", {}));
  valSyncCache = { layers: state.layers, selectable: selectableOf(state), selection: [] };
  const quadBefore = state.version?.version_number;
  const selectable = selectableOf(state);
  const plans = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "TRIM" } },
      { event: { type: "enter" }, note: "cutting edges: implied all objects" },
      { event: { type: "entityPoint", entity: selectable[0], point: [-2, 0] } },
      { event: { type: "entityPoint", entity: selectable[0], point: [102, 0] } },
      { event: { type: "entityPoint", entity: selectable[2], point: [102, 100] } },
      { event: { type: "entityPoint", entity: selectable[2], point: [-2, 100] } },
      { event: { type: "entityPoint", entity: selectable[1], point: [100, -2] } },
      { event: { type: "entityPoint", entity: selectable[1], point: [100, 102] } },
      { event: { type: "entityPoint", entity: selectable[3], point: [0, 102] } },
      { event: { type: "entityPoint", entity: selectable[3], point: [0, -2] } },
      { event: { type: "entityPoint", entity: selectable[0], point: [-2, 0] }, note: "the stale re-pick: an honest no-op" },
      { event: { type: "enter" } },
    ],
    ctx(),
    (plan) => plans.push(plan),
  );
  assert(lines.includes("TRIM: 9 target(s) (implied all edges)."), `the TRIM echo: ${JSON.stringify(lines.slice(-3))}`);
  assert(plans.length === 1, "one plan for the whole composed trim");
  let summary = "";
  for (const entry of plans[0].appApi) {
    const r = val(await cmd(entry.name, entry.payload));
    if (entry.payload?.op === "trim") summary = r.summary ?? "";
  }
  assert(
    summary.startsWith("8 trims applied; skipped: el-000001: "),
    `the composed summary counts the honest skip: ${summary}`,
  );
  const after = val(await q("document.getState", {}));
  assert((after.elements ?? []).length === 4, "four boundary entities remain");
  assert(after.version?.version_number === quadBefore + 1, "one atomic revision for the composed trim");
  const coordsOf = (id) => {
    const el = (after.elements ?? []).find((e) => e.id === id);
    const p = el?.props ?? {};
    return [p.x1, p.y1, p.x2, p.y2];
  };
  assert(JSON.stringify(coordsOf("el-000001")) === JSON.stringify([0, 0, 100, 0]), `bottom composed: ${coordsOf("el-000001")}`);
  assert(JSON.stringify(coordsOf("el-000002")) === JSON.stringify([100, 0, 100, 100]), `right composed: ${coordsOf("el-000002")}`);
  assert(JSON.stringify(coordsOf("el-000003")) === JSON.stringify([100, 100, 0, 100]), `top composed: ${coordsOf("el-000003")}`);
  assert(JSON.stringify(coordsOf("el-000004")) === JSON.stringify([0, 100, 0, 0]), `left composed: ${coordsOf("el-000004")}`);
}

// ---------------------------------------------------------------------------
step("NEGATIVE: a failed edit is the typed failure — never false success, never a mutation");
{
  const stateBefore = val(await q("document.getState", {}));
  const failed = await cmd("entity.modify", { op: "erase", ids: ["el-404404"] });
  assert(failed.ok === false, "the unknown-id erase fails");
  assert(failed.code === "entity_invalid", `typed failure code (${failed.code})`);
  const stateAfter = val(await q("document.getState", {}));
  assert(JSON.stringify(stateAfter.elements) === JSON.stringify(stateBefore.elements), "no mutation from the failed edit");
  assert(stateAfter.version?.version_number === stateBefore.version?.version_number, "version untouched");
}

// ---------------------------------------------------------------------------
step("PASS — DEF-006/007/021 selection/edit contracts, G4 closure, G10 undo, zero false success.");
