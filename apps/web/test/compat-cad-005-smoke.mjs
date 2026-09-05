// COMPAT-CAD-005 / Issue #135: Web host drafting-foundation smoke.
//
// Drives the EXACT App API + shared-prompt-engine command stream the
// professional workspace UI produces for the CAD-BENCH-RW-001 golden
// foundation flows — layer identity (addLayer makeActive → create on the
// non-'0' layer → CLAYER), NEW full reset, entity-count integrity
// (SELECTALL-class setSelection over repeated NEW/draw cycles), the
// live-pruned selection after undo, and the typed failure of a create whose
// layer id belongs to another document session — against the running dev
// server, asserting the authoritative document state after every step.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/compat-cad-005-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)

import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

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
const cmd = (name, payload) => send({ type: "command", name, payload });
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const step = (name) => console.log(`COMPAT-CAD-005 SMOKE: ${name}`);
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// ---------------------------------------------------------------------------
step("the -LAYER M flow: create + activate a non-'0' layer through the shared prompt engine");
const ctxLayers = defaultCommandContext({ activeLayer: "0", layers: [{ id: "0", name: "0", color: "#111827", visible: true }] });
const layerPlans = [];
const layerScript = runCommandScript(
  [
    { event: { type: "typed", text: "-LAYER" } },
    { event: { type: "typed", text: "M" } },
    { event: { type: "typed", text: "A-WALL-TEST" } },
    { event: { type: "typed", text: "X" } },
  ],
  ctxLayers,
  (plan) => layerPlans.push(plan),
);
{
  const plan = layerPlans[layerPlans.length - 1];
  assert(plan.appApi.some((e) => e.name === "drafting.addLayer"), "the -LAYER M plan commits drafting.addLayer");
  assert(
    layerScript.lines.some((l) => l.includes("A-WALL-TEST") && l.includes("created and set current")),
    "the outcome echo names the layer (deferred by the host until the commit lands)",
  );
}
// Commit it for real through the running server.
const addLayer = val(await cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true }));
assert(/^ly-\d{6}$/.test(addLayer.layerId), "the canonical minted layer id");
assert(addLayer.active === true, "the layer is active in the response");
assert(
  (addLayer.snapshot.layers ?? []).some((l) => l.name === "A-WALL-TEST"),
  "the RESPONSE SNAPSHOT carries the authoritative layer table (the host adopts it — DEF-001/002)",
);

// ---------------------------------------------------------------------------
step("entity creation on the non-'0' layer (the DEF-001 'everything lands on 0' defect)");
const created = val(await cmd("drafting.createEntities", { entities: [{ type: "line", layer: addLayer.layerId, from: [0, 0], to: [300, 0] }] }));
assert(Array.isArray(created.created) && created.created.length === 1, "one entity created");
let snap = val(await q("document.getState", {}));
assert((snap.elements ?? []).length === 1, "the entity is in the canonical document");
assert(
  (snap.elements ?? []).every((el) => (el.props ?? {}).layer === addLayer.layerId),
  "the entity is on the non-'0' layer (active-layer changes affect creation)",
);
assert(
  snap.draftingSettings?.activeLayer === addLayer.layerId,
  "the active layer is the created layer",
);

// ---------------------------------------------------------------------------
step("the shared prompt engine's LINE echo names the layer (not the raw id)");
{
  const ctx = defaultCommandContext({
    activeLayer: addLayer.layerId,
    layers: snap.layers ?? [],
  });
  const plans = [];
  const script = runCommandScript(
    [
      { event: { type: "start", commandId: "line" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "300,0" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  const echo = script.lines.find((l) => l.startsWith("LINE:"));
  assert(echo !== undefined && echo.includes("on layer 'A-WALL-TEST'."), `the echo shows the layer NAME — got: ${echo}`);
}

// ---------------------------------------------------------------------------
step("selection integrity: setSelection counts only live elements; undo prunes (DEF-008/014)");
const elId = (snap.elements ?? [])[0].id;
await cmd("document.setSelection", { ids: [elId, "ghost-id"] });
let sel = val(await q("document.getSelection", {}));
assert(Array.isArray(sel) && sel.length === 1 && sel[0] === elId, "phantom ids are dropped server-side (no Sel inflation)");
// undo removes the entity → the selection is pruned
await cmd("document.undo", {});
sel = val(await q("document.getSelection", {}));
assert(Array.isArray(sel) && sel.length === 0, "undo prunes the removed entity from the selection (no 'Sel 1' + 'No selection' desync)");
await cmd("document.redo", {});
sel = val(await q("document.getSelection", {}));
assert(Array.isArray(sel) && sel.length === 0, "redo does not resurrect the pruned selection");
snap = val(await q("document.getState", {}));
assert((snap.elements ?? []).length === 1, "the redo re-created the entity");

// ---------------------------------------------------------------------------
step("typed failure of a create whose layer belongs to another document session (DEF-027 authoritative failure)");
const foreign = await cmd("drafting.createEntities", { entities: [{ type: "line", layer: "ly-999999", from: [0, 0], to: [1, 0] }] });
assert(foreign.ok === false, "the create fails typed");
assert(foreign.code === "drafting_invalid", `drafting_invalid — got: ${foreign.code}`);
assert(/does not exist in the document layer table/.test(foreign.message ?? ""), "the typed message names the canonical gate");
const afterForeign = val(await q("document.getState", {}));
assert((afterForeign.elements ?? []).length === 1, "the rejected transaction did not mutate the document");

// ---------------------------------------------------------------------------
step("NEW: full reset driven by the canonical create response (DEF-003/DEF-014)");
const fresh = val(await cmd("document.create", {}));
assert((fresh.layers ?? []).map((l) => l.name).join(",") === "0", "the layer table resets to the default layer");
assert(fresh.draftingSettings?.activeLayer === undefined, "no dangling active-layer reference");
assert((fresh.elements ?? []).length === 0, "no phantom entities");
assert(Array.isArray(fresh.selection) && fresh.selection.length === 0, "the selection resets");
assert(fresh.version?.version_number === 1, "the version counter resets");
// Draw IMMEDIATELY after NEW (the benchmark's exact undrawable-document sequence).
const drawAfterNew = await cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [300, 0] }] });
assert(drawAfterNew.ok === true, "creation on the fresh document succeeds");

// ---------------------------------------------------------------------------
step("repeated NEW/draw cycles keep Sel == drawn entities (the benchmark's exact count-inflation probe)");
for (let cycle = 0; cycle < 3; cycle += 1) {
  await cmd("document.create", {});
  for (let i = 0; i < 2; i += 1) {
    await cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [i * 10, 0], to: [i * 10 + 5, 0] }] });
  }
  const cycleSnap = val(await q("document.getState", {}));
  assert((cycleSnap.elements ?? []).length === 2, `cycle ${cycle}: exactly 2 elements`);
  const ids = (cycleSnap.elements ?? []).map((el) => el.id);
  const selRes = val(await cmd("document.setSelection", { ids }));
  assert((selRes.selection ?? []).length === 2, `cycle ${cycle}: Sel == 2 (no phantom ids, no inflation)`);
  const selQ = val(await q("document.getSelection", {}));
  assert(selQ.length === 2, `cycle ${cycle}: getSelection round-trips the live selection`);
}

console.log("COMPAT-CAD-005 SMOKE: PASS — layer identity, NEW reset, selection integrity, authoritative failures, count integrity.");
