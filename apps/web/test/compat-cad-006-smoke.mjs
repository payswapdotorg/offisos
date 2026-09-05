// COMPAT-CAD-006 / Issue #138: Web host viewport/navigation smoke.
//
// Drives the EXACT App API + shared-prompt-engine command stream the
// professional workspace UI produces for the CAD-BENCH-RW-001 navigation
// flows — the ZOOM vocabulary (window corners, E extents, S scale nX/n,
// P previous), PAN (base+second / displacement-on-Enter), REGEN (pure
// redraw) — against the running dev server, asserting:
//   1. every navigation plan is ui-actions + echo ONLY (zero App API
//      commands — navigation can never mutate the canonical document);
//   2. the presentation-only view persist (drafting.setSettings { view })
//      leaves the document's elements/version byte-identical (the negative
//      no-mutation probe through the REAL host transport);
//   3. the G2 real-scale site-plan flow: an endpoint far outside the
//      initial viewport commits, the ZOOM E fit reaches it, and the ZOOM W
//      window plan carries the exact corners.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/compat-cad-006-smoke.mjs
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

const step = (name) => console.log(`COMPAT-CAD-006 SMOKE: ${name}`);
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
step("G2 real-scale site-plan: an endpoint far outside the initial viewport commits");
const site = val(
  await cmd("drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: [0, 0], to: [50000, 30000] }],
  }),
);
assert(Array.isArray(site.created) && site.created.length === 1, "the site-scale boundary line committed");
const before = val(await q("document.getState", {}));
assert((before.elements ?? []).length === 1, "one entity before navigation");
const beforeVersion = before.version?.version_number;

// ---------------------------------------------------------------------------
step("the ZOOM window flow emits view.zoomWindow with the exact corners (ZERO App API)");
const ctx = () =>
  defaultCommandContext({
    activeLayer: "0",
    layers: [{ id: "0", name: "0", color: "#111827", visible: true }],
    elementCount: 1,
  });
const zoomWindowPlans = [];
const zoomWindow = runCommandScript(
  [
    { event: { type: "typed", text: "ZOOM" } },
    { event: { type: "typed", text: "10000,6000" } },
    { event: { type: "typed", text: "40000,24000" } },
  ],
  ctx(),
  (plan) => zoomWindowPlans.push(plan),
);
{
  const plan = zoomWindowPlans[zoomWindowPlans.length - 1];
  assert(plan !== undefined, "the ZOOM window plan emitted");
  assert(plan.appApi.length === 0, "ZOOM W never emits App API commands");
  assert(plan.ui.length === 1 && plan.ui[0].action === "view.zoomWindow", "the view.zoomWindow ui action");
  const payload = plan.ui[0].payload;
  assert(payload.corner1[0] === 10000 && payload.corner1[1] === 6000, "corner1 exact");
  assert(payload.corner2[0] === 40000 && payload.corner2[1] === 24000, "corner2 exact");
  assert(zoomWindow.lines.some((l) => l.includes("ZOOM: window (10000,6000) → (40000,24000)")), "the window echo");
}

// ---------------------------------------------------------------------------
step("ZOOM E / S 2x / P / PAN / REGEN — the full vocabulary through the prompt engine");
const navPlans = [];
const nav = runCommandScript(
  [
    { event: { type: "typed", text: "ZOOM" } },
    { event: { type: "typed", text: "E" } },
    { event: { type: "typed", text: "ZOOM" } },
    { event: { type: "typed", text: "S" } },
    { event: { type: "typed", text: "2x" } },
    { event: { type: "typed", text: "ZOOM" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "typed", text: "PAN" } },
    { event: { type: "typed", text: "500,250" } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "REGEN" } },
  ],
  ctx(),
  (plan) => navPlans.push(plan),
);
{
  assert(navPlans.length === 5, `five navigation plans (got ${navPlans.length})`);
  for (const plan of navPlans) {
    assert(plan.appApi.length === 0, "navigation plans are ui+echo only");
  }
  assert(navPlans[0].ui[0].action === "view.zoomExtents", "ZOOM E");
  assert(navPlans[1].ui[0].action === "view.zoomScale" && navPlans[1].ui[0].payload.factor === 2 && navPlans[1].ui[0].payload.relative === true, "ZOOM S 2x");
  assert(navPlans[2].ui[0].action === "view.zoomPrevious", "ZOOM P");
  assert(navPlans[3].ui[0].action === "view.pan" && navPlans[3].ui[0].payload.delta[0] === 500 && navPlans[3].ui[0].payload.delta[1] === 250, "PAN displacement mode (Enter at second)");
  assert(navPlans[4].ui[0].action === "view.regen", "REGEN");
  assert(nav.lines.some((l) => l.includes("ZOOM: fitting extents")), "the E echo");
  assert(nav.lines.some((l) => l.includes("2× the current view")), "the S echo");
  assert(nav.lines.some((l) => l.includes("restoring previous view")), "the P echo");
  assert(nav.lines.some((l) => l.includes("displacement (500,250)")), "the PAN echo");
  assert(nav.lines.includes("Regenerating model."), "the REGEN echo");
  assert(nav.lines.some((l) => l.includes("no document change")), "the REGEN no-mutation disclosure");
}

// ---------------------------------------------------------------------------
step("NEGATIVE PROBE: the view persist through the REAL host leaves the document byte-identical");
// The host's presentation-only persist path, applied for every navigation
// above (exactly what the shell does after each view change):
for (const view of [
  { pan: [24066, 14582], zoom: 0.018 }, // the ZOOM E fit
  { pan: [0, 0], zoom: 1 },
  { pan: [500, 250], zoom: 1 },
]) {
  val(await cmd("drafting.setSettings", { settings: { view } }));
}
const after = val(await q("document.getState", {}));
assert((after.elements ?? []).length === 1, "navigation added/removed no entities");
assert(after.version?.version_number === beforeVersion, `navigation never bumped the version (${after.version?.version_number} vs ${beforeVersion})`);
assert(JSON.stringify(after.elements) === JSON.stringify(before.elements), "entity content byte-identical after navigation");

// ---------------------------------------------------------------------------
step("PASS — ZOOM/PAN/REGEN vocabulary, real-scale G2 flow, zero document mutation.");
