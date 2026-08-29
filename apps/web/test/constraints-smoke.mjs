// CAD-PARITY-007 / Issue #86: Web host parametric-constraints workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) —
// against the running dev server, and asserts the document state after
// every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004): the Electron smoke runs the same script through the
// real Electron UI and both must match the pinned fixture
// (app/test/fixtures/cad-parity-007-constraints.json).
//
// Covers the CAD-PARITY-007 acceptance surface: GEOMCONSTRAINT (Horizontal /
// Coincident / Tangent / Fixed through the command line with dynamic
// per-kind steps), DIMCONSTRAINT (Length with the dynamic current-value
// default; value updates re-solve), the associative-dimension remeasure
// composition (a constraint update re-measures a referenced dim in the SAME
// revision), constraint-aware editing (MOVE with the coincident partner
// following; the FIXED circle restored), the deterministic ARRAY pattern,
// undo/redo, the constraint.solve diagnostics surface, severance on delete,
// constraint.remove, save/open round-trips and the deterministic pinned
// fixture.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/constraints-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-007-constraints.json");

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
const errOf = (r) => ({ code: r.code, message: r.message });

const TOL = 1e-6;
const step = (name) => console.log(`CONSTRAINTS SMOKE: ${name}`);

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// ---------------------------------------------------------------------------
step("document.create + the constrained-drawing geometry");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-007-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-007-smoke",
    }),
  ),
  "document.create",
);
let snap = val(await q("document.getState", {}));

function context() {
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    storyCount: 0,
    currentSelection: [],
    layers: snap.layers ?? [],
    textStyles: snap.textStyles ?? [],
    dimStyles: snap.dimStyles ?? [],
    currentTextStyle: snap.draftingSettings?.textStyle ?? "Standard",
    currentDimStyle: snap.draftingSettings?.dimStyle ?? "Standard",
    blocks: snap.blockDefs ?? [],
    xrefs: snap.xrefs ?? [],
    constraints: snap.constraints ?? [],
  });
}
async function runScript(steps) {
  const plans = [];
  const result = runCommandScript(steps, context(), (plan) => plans.push(plan));
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}
const pickOf = (el) => ({ id: el.id, kind: el.kind, props: el.props });
const elementByType = (type, nth = 0) => snap.elements.filter((el) => el.props?.type === type)[nth];

// The base line (sloped — the Horizontal constraint levels it), the diagonal
// (coincident with the base end) and the circle (tangent + fixed).
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "2000,600" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "2000,600" } },
  { event: { type: "typed", text: "3000,1400" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "CIRCLE" } },
  { event: { type: "typed", text: "4200,0" } },
  { event: { type: "typed", text: "400" } },
]);
const baseLine = elementByType("line");
const diagonal = snap.elements.filter((el) => el.props?.type === "line")[1];
const circle = elementByType("circle");
assert(baseLine && diagonal && circle, "the three source entities exist");

// ---------------------------------------------------------------------------
step("GEOMCONSTRAINT Horizontal — the base levels (the closed form applies)");
{
  const { plans } = await runScript([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Horizontal" } },
    { event: { type: "entity", entity: pickOf(baseLine) } },
  ]);
  assert(plans.length === 1 && plans[0].appApi.length === 1, "GC Horizontal emits one constraint.create");
  snap = val(await q("document.getState", {}));
  const leveled = snap.elements.find((el) => el.id === baseLine.id);
  assert(close(leveled.props.y1, 0) && close(leveled.props.y2, 0), "the base line leveled");
  assert((snap.constraints ?? []).length === 1, "one constraint declared");
  assert(snap.constraints[0].kind === "horizontal", "the horizontal record");
}

// ---------------------------------------------------------------------------
step("GEOMCONSTRAINT Coincident — the NEAREST anchors resolve from the picks");
{
  await runScript([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Coincident" } },
    { event: { type: "entityPoint", entity: pickOf(baseLine), point: [2010, 610] } },
    { event: { type: "entityPoint", entity: pickOf(diagonal), point: [1990, 590] } },
  ]);
  snap = val(await q("document.getState", {}));
  assert((snap.constraints ?? []).length === 2, "two constraints declared");
  const coincident = snap.constraints[1];
  assert(coincident.kind === "coincident", "the coincident record");
  assert(coincident.targets[0].anchor === "end" && coincident.targets[1].anchor === "start", "nearest anchors resolved");
  const d = snap.elements.find((el) => el.id === diagonal.id);
  assert(close(d.props.x1, 2000, 1e-6) && close(d.props.y1, 0), "the diagonal start pulled to the base end");
}

// ---------------------------------------------------------------------------
step("DIMCONSTRAINT Length — the dynamic default keeps the CURRENT length");
{
  // The current base length is 2000 — Enter accepts the dynamic default.
  // The pick carries the CURRENT geometry snapshot (fresh from snap — the
  // same fresh-pick semantics the real UI has after the earlier solves).
  const freshBase = snap.elements.find((el) => el.id === baseLine.id);
  const { plans } = await runScript([
    { event: { type: "typed", text: "DC" } },
    { event: { type: "typed", text: "Length" } },
    { event: { type: "entity", entity: pickOf(freshBase) } },
    { event: { type: "enter" } },
  ]);
  assert(plans.length === 1, "DC Length emits one plan");
  const payload = plans[0].appApi[0].payload;
  assert(payload.kind === "distance" && close(payload.value, 2000), `Enter keeps the current length (${payload.value})`);
  snap = val(await q("document.getState", {}));
  assert((snap.constraints ?? []).length === 3, "three constraints declared");
}

// ---------------------------------------------------------------------------
step("undo/redo converge (one revision each)");
assert(ok(await cmd("document.undo", {})), "undo");
snap = val(await q("document.getState", {}));
assert((snap.constraints ?? []).length === 2, "the length constraint reverted with its geometry");
assert(ok(await cmd("document.redo", {})), "redo");
snap = val(await q("document.getState", {}));
assert((snap.constraints ?? []).length === 3, "redo restored the constraint");

// ---------------------------------------------------------------------------
step("constraint.update re-solves (the declared value drives the geometry)");
{
  const lengthId = snap.constraints.find((c) => c.kind === "distance").id;
  const r = val(await cmd("constraint.update", { id: lengthId, patch: { value: 2500 } }));
  assert(close(r.value, 2500), "the update response carries the new value");
  snap = val(await q("document.getState", {}));
  const base = snap.elements.find((el) => el.id === baseLine.id);
  assert(close(base.props.x2, 2500) && close(base.props.y2, 0), "the base extended to the declared length");
  const d = snap.elements.find((el) => el.id === diagonal.id);
  assert(close(d.props.x1, 2500) && close(d.props.y1, 0), "the coincident partner followed");
}

// ---------------------------------------------------------------------------
step("the associative dimension re-measures through a constraint update");
{
  // A dim-linear referencing the base line's endpoints (associative refs —
  // the annotation.create payload the palette/005 flows produce).
  assert(
    ok(
      await cmd("annotation.create", {
        entities: [{
          type: "dim-linear",
          layer: "0",
          p1: { x: 0, y: 0 },
          p2: { x: 2500, y: 0 },
          placement: { x: 1250, y: -400 },
          mode: "horizontal",
          measured: 2500,
          refs: [
            { id: baseLine.id, anchor: "start", to: "p1" },
            { id: baseLine.id, anchor: "end", to: "p2" },
          ],
        }],
      }),
    ),
    "annotation.create dim-linear with refs",
  );
  const lengthId = snap.constraints.find((c) => c.kind === "distance").id;
  val(await cmd("constraint.update", { id: lengthId, patch: { value: 3000 } }));
  snap = val(await q("document.getState", {}));
  const dim = snap.elements.find((el) => el.props?.type === "dim-linear");
  assert(close(dim.props.measured, 3000, 1e-6), `the dimension re-measured to the constrained length (${dim.props.measured})`);
  assert(close(dim.props.p2.x, 3000, 1e-6), "the referenced endpoint followed");
}

// ---------------------------------------------------------------------------
step("constraint-aware MOVE — the coincident partner follows");
{
  assert(ok(await cmd("entity.modify", { op: "move", ids: [baseLine.id], dx: 400, dy: 300 })), "move the base");
  snap = val(await q("document.getState", {}));
  const base = snap.elements.find((el) => el.id === baseLine.id);
  const d = snap.elements.find((el) => el.id === diagonal.id);
  assert(close(base.props.x1, 400) && close(base.props.y1, 300), "the base moved");
  assert(close(d.props.x1, base.props.x2) && close(d.props.y1, base.props.y2), "the diagonal start re-coupled to the base end");
}

// ---------------------------------------------------------------------------
step("GEOMCONSTRAINT Tangent + Fixed on the circle");
{
  await runScript([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Tangent" } },
    { event: { type: "entity", entity: pickOf(snap.elements.find((el) => el.id === diagonal.id)) } },
    { event: { type: "entity", entity: pickOf(snap.elements.find((el) => el.id === circle.id)) } },
  ]);
  snap = val(await q("document.getState", {}));
  const tangent = (snap.constraints ?? []).find((c) => c.kind === "tangent");
  assert(tangent, "the tangent record declared");
  await runScript([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Fixed" } },
    { event: { type: "entity", entity: pickOf(snap.elements.find((el) => el.id === circle.id)) } },
  ]);
  snap = val(await q("document.getState", {}));
  assert((snap.constraints ?? []).some((c) => c.kind === "fixed"), "the fixed record declared");
  // The tangent solved: the line↔circle distance == r (the circle adjusted —
  // target[1] of tangent(diagonal, circle)).
  const c = snap.elements.find((el) => el.id === circle.id);
  const d = snap.elements.find((el) => el.id === diagonal.id);
  const dx = d.props.x2 - d.props.x1;
  const dy = d.props.y2 - d.props.y1;
  const len = Math.hypot(dx, dy);
  const dist = Math.abs((c.props.cx - d.props.x1) * (dy / len) - (c.props.cy - d.props.y1) * (dx / len));
  assert(close(dist, c.props.r, 1e-6), `the line is tangent to the circle (distance ${dist} == r ${c.props.r})`);
}

// ---------------------------------------------------------------------------
step("a moved FIXED entity restores inside the same revision");
{
  const before = val(await q("document.getState", {}));
  const fixedCircle = before.elements.find((el) => el.id === circle.id);
  const r = val(await cmd("entity.modify", { op: "move", ids: [circle.id], dx: 1000, dy: 0 }));
  assert(r.summary.includes("restored to its fixed position"), `the fixed restore echo (${r.summary})`);
  snap = val(await q("document.getState", {}));
  const after = snap.elements.find((el) => el.id === circle.id);
  assert(
    close(after.props.cx, fixedCircle.props.cx) && close(after.props.cy, fixedCircle.props.cy),
    "the circle returned to its pinned position",
  );
}

// ---------------------------------------------------------------------------
step("the deterministic ARRAY pattern (rectangular) + undo");
{
  const before = snap.elements.length;
  const r = val(await cmd("entity.modify", {
    op: "array",
    mode: "rectangular",
    ids: [diagonal.id],
    rows: 2,
    columns: 2,
    rowSpacing: 800,
    columnSpacing: 600,
  }));
  assert(r.created === 3, `3 copies created (${r.created})`);
  snap = val(await q("document.getState", {}));
  assert(snap.elements.length === before + 3, "the copies minted");
  assert(ok(await cmd("document.undo", {})), "undo the array");
  snap = val(await q("document.getState", {}));
  assert(snap.elements.length === before, "undo removed the copies (one revision)");
}

// ---------------------------------------------------------------------------
step("constraint.solve — the explicit diagnostics surface");
{
  const r = val(await cmd("constraint.solve", {}));
  assert(typeof r.outcome === "string", "the typed outcome");
  assert(Array.isArray(r.statuses) && r.statuses.length === (snap.constraints ?? []).length, "one status per constraint");
  const diag = val(await q("constraints.diagnostics", {}));
  assert(diag.outcome === r.outcome, "the query agrees with the command");
  assert(Array.isArray(diag.dof) && diag.dof.length > 0, "the DoF accounting");
}

// ---------------------------------------------------------------------------
step("severance — deleting the circle removes its constraints atomically");
{
  const before = (snap.constraints ?? []).length;
  const r = val(await cmd("drafting.delete", { ids: [circle.id] }));
  assert(r.summary.includes("2 constraints severed"), `the severance echo (${r.summary})`);
  snap = val(await q("document.getState", {}));
  assert((snap.constraints ?? []).length === before - 2, "tangent + fixed severed");
}

// ---------------------------------------------------------------------------
step("DELCONSTRAINT — release the remaining constraints of the base line");
{
  await runScript([
    { event: { type: "typed", text: "DCON" } },
    { event: { type: "entity", entity: pickOf(snap.elements.find((el) => el.id === baseLine.id)) } },
    { event: { type: "enter" } },
  ]);
  snap = val(await q("document.getState", {}));
  assert(snap.constraints === undefined || snap.constraints.length === 0, "every constraint referencing the base released");
}

// ---------------------------------------------------------------------------
step("save/open round-trip (the constrained world survives)");
const saved = val(await cmd("document.save", {}));
assert(ok(await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-007-smoke-reopened" })), "reopen");
snap = val(await q("document.getState", {}));
assert((snap.constraints ?? []).length === 0, "the released graph stays empty after reopen");

// ---------------------------------------------------------------------------
step("deterministic save + pinned CAD-PARITY-007 fixture");
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const sha = shaA;
console.log(`CONSTRAINTS SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    constraints: snap.constraints?.length ?? 0,
    elements: snap.elements.length,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`CONSTRAINTS SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.elements === snap.elements.length, "fixture element count");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(
  `CONSTRAINTS SMOKE: PASS — ${executed.length} commands; ${snap.elements.length} elements; save sha ${sha.slice(0, 16)}… (CAD-PARITY-007 fixture)`,
);
