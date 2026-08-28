// CAD-PARITY-004 / Issue #80: Web host layers/styles/properties workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt engine (app/src/workspace) for the typed
// commands (CHPROP/MATCHPROP/-LAYER/CLAYER/LAYISO/LAYUNISO/LAYON/LTSCALE)
// and the App API commands the palettes emit — against the running dev
// server, asserting document state after every step. The CAD-PARITY-002
// parity fixture (the 9-command stream) stays the regression gate for the
// old surface; THIS smoke pins the CAD-PARITY-004 surface with its own
// fixture (app/test/fixtures/cad-parity-004-layers.json).
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/layers-styles-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-004-layers.json");

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
const step = (name) => console.log(`LAYERS/STYLES SMOKE: ${name}`);

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
step("document.create");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-004-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-004-smoke",
    }),
  ),
  "document.create",
);
let snap = val(await q("document.getState", {}));
const layersById = () => new Map((snap.layers ?? []).map((l) => [l.id, l]));
const layerByName = (name) => (snap.layers ?? []).find((l) => l.name === name);

// ---------------------------------------------------------------------------
step("layer manager semantics: create with extended fields + makeActive");
const created = val(await cmd("drafting.addLayer", { name: "A-WALL", color: "#b45309", linetype: "Continuous", lineweight: 0.35, makeActive: true }));
assert(typeof created.layerId === "string" && created.layerId.startsWith("ly-"), "layer id minted");
snap = val(await q("document.getState", {}));
const wall = layerByName("A-WALL");
assert(wall !== undefined, "A-WALL exists");
assert(wall.lineweight === 0.35, "A-WALL lineweight 0.35");
assert(snap.draftingSettings?.activeLayer === created.layerId, "makeActive set the persisted active layer");
assert(wall.frozen === undefined && wall.locked === undefined, "absent = default (canonical-minimal records)");

step("layer state fields: freeze/lock/plot/transparency patches");
await cmd("drafting.addLayer", { name: "A-DOOR", color: "#15803d" });
snap = val(await q("document.getState", {}));
const door = layerByName("A-DOOR");
await cmd("drafting.updateLayer", { layerId: door.id, patch: { locked: true, transparency: 40, plot: false } });
snap = val(await q("document.getState", {}));
assert(layersById().get(door.id).locked === true, "door locked");
assert(layersById().get(door.id).transparency === 40, "door transparency 40");
assert(layersById().get(door.id).plot === false, "door not plottable");

// ---------------------------------------------------------------------------
step("draw on the active layer (LINE via command line)");
function context() {
  const elements = snap.elements ?? [];
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: elements.length,
    storyCount: 0,
    currentSelection: [],
    layers: snap.layers ?? [],
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
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "4000,0" } },
  { event: { type: "enter" } },
]);
let line = snap.elements.find((el) => el.props?.type === "line" && el.props?.layer === created.layerId);
assert(line !== undefined, "the line was created on the ACTIVE layer (A-WALL)");
assert(line.props.from[0] === 0 && line.props.to[0] === 4000, "line geometry exact");

// ---------------------------------------------------------------------------
step("locked layer: modification is REJECTED with a typed failure");
// Lock the LINE's layer (A-WALL) — locking the active layer is allowed (only
// freezing it is blocked).
await cmd("drafting.updateLayer", { layerId: created.layerId, patch: { locked: true } });
snap = val(await q("document.getState", {}));
const lockedMove = await cmd("entity.modify", { op: "move", ids: [line.id], dx: 100, dy: 0 });
assert(!ok(lockedMove), "move on a locked layer must fail");
assert(/locked layer/.test(lockedMove.message), `typed failure message: ${lockedMove.message}`);
const lockedSetDisplay = await cmd("entity.setDisplay", { ids: [line.id], patch: { color: "#ff0000" } });
assert(!ok(lockedSetDisplay), "setDisplay on a locked layer must fail");
snap = val(await q("document.getState", {}));
line = snap.elements.find((el) => el.id === line.id);
assert(line.props.color === undefined, "the locked entity is untouched");

step("locked layer: precision pick excludes the entity");
const lockedPick = await q("precision.pick", { cursor: [2000, 0] });
assert(val(lockedPick).id === null, "locked-layer entities are not pickable");

// ---------------------------------------------------------------------------
step("unlock → modify works; display overrides preserved through geometry ops");
await cmd("drafting.updateLayer", { layerId: created.layerId, patch: { locked: false } });
const setDisplay = val(await cmd("entity.setDisplay", { ids: [line.id], patch: { color: "#dc2626", linetype: "Dashed", lineweight: 0.5 } }));
assert(setDisplay.applied === true, "setDisplay applied");
val(await cmd("entity.modify", { op: "move", ids: [line.id], dx: 100, dy: 0 }));
snap = val(await q("document.getState", {}));
line = snap.elements.find((el) => el.id === line.id);
assert(line.props.color === "#dc2626", "color override PRESERVED through move");
assert(line.props.linetype === "Dashed", "linetype override PRESERVED through move");
assert(line.props.lineweight === 0.5, "lineweight override PRESERVED through move");
// CAD-PARITY-003 semantics: the modify writes back the CANONICAL FLAT
// convention (x1/y1/x2/y2) — the legacy from/to fields are replaced.
assert(line.props.x2 === 4100, "geometry moved to 4100 (flat convention)");

// ---------------------------------------------------------------------------
step("CHPROP through the command line (P → Color → hex)");
// Select the entity the way the real UI does (document selection) — the
// SAME wire command the Electron smoke's setSelection emits (stream parity).
await cmd("document.setSelection", { ids: [line.id] });
const selection = [{ id: line.id, kind: "geometry", props: line.props }];
{
  const ctx = defaultCommandContext({ activeLayer: snap.draftingSettings?.activeLayer, layers: snap.layers ?? [], currentSelection: selection });
  const plans = [];
  const result = runCommandScript(
    [
      { event: { type: "typed", text: "CHPROP" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "C" } },
      { event: { type: "typed", text: "#0e7490" } },
      { event: { type: "enter" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  assert(plans.length === 1 && plans[0].appApi.length === 1, "CHPROP emits exactly one entity.setDisplay plan");
  assert(plans[0].appApi[0].payload.patch.color === "#0e7490", "CHPROP color payload");
  const res = await cmd(plans[0].appApi[0].name, plans[0].appApi[0].payload);
  assert(ok(res), "CHPROP plan applied");
}
snap = val(await q("document.getState", {}));
line = snap.elements.find((el) => el.id === line.id);
assert(line.props.color === "#0e7490", "CHPROP changed the color");

// ---------------------------------------------------------------------------
step("MATCHPROP: copy display + layer to a fresh entity");
// Switch to layer 0 for the target line (CLAYER through the command line).
{
  const ctx = defaultCommandContext({ activeLayer: created.layerId, layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "CLAYER" } },
      { event: { type: "typed", text: "0" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  for (const entry of plans[0].appApi) {
    const res = await cmd(entry.name, entry.payload);
    assert(ok(res), `CLAYER plan command ${entry.name}`);
  }
}
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.activeLayer === "0", "CLAYER switched to layer 0");
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,1000" } },
  { event: { type: "typed", text: "4000,1000" } },
  { event: { type: "enter" } },
]);
const target = snap.elements.find((el) => el.props?.type === "line" && el.props?.layer === "0");
assert(target !== undefined, "second line on layer 0");
{
  const ctx = defaultCommandContext({ activeLayer: "0", layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "MATCHPROP" } },
      { event: { type: "entity", entity: { id: line.id, kind: "geometry", props: line.props } } },
      { event: { type: "entity", entity: { id: target.id, kind: "geometry", props: target.props } } },
      { event: { type: "enter" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  assert(plans.length === 1, "MATCHPROP emits one plan");
  const res = await cmd(plans[0].appApi[0].name, plans[0].appApi[0].payload);
  assert(ok(res), "MATCHPROP plan applied");
}
snap = val(await q("document.getState", {}));
const matched = snap.elements.find((el) => el.id === target.id);
assert(matched.props.color === "#0e7490", "MATCHPROP copied the color override");
assert(matched.props.linetype === "Dashed", "MATCHPROP copied the linetype");
assert(matched.props.layer === created.layerId, "MATCHPROP copied the layer");

// ---------------------------------------------------------------------------
step("frozen layer: creation + active-layer rules");
const frozen = await cmd("drafting.updateLayer", { layerId: door.id, patch: { frozen: true } });
assert(ok(frozen), "freeze accepted (not the active layer)");
snap = val(await q("document.getState", {}));
const setActiveFrozen = await cmd("layer.setActive", { layerId: door.id });
assert(!ok(setActiveFrozen), "a frozen layer cannot become active");
const drawOnFrozen = await cmd("entity.create", { entities: [{ layer: door.id, type: "point", x: 1, y: 1 }] });
assert(!ok(drawOnFrozen), "creating on a frozen layer is rejected");
const activeFreeze = await cmd("drafting.updateLayer", { layerId: "0", patch: { frozen: true } });
assert(!ok(activeFreeze), "the ACTIVE layer (0, current) cannot be frozen");
await cmd("drafting.updateLayer", { layerId: door.id, patch: { frozen: false } });

// ---------------------------------------------------------------------------
step("layer states: save → mutate → restore exact");
val(await cmd("layerState.save", { name: "Setup A" }));
await cmd("drafting.updateLayer", { layerId: created.layerId, patch: { visible: false, color: "#ff0000" } });
snap = val(await q("document.getState", {}));
assert(layersById().get(created.layerId).visible === false, "A-WALL hidden");
const restored = val(await cmd("layerState.restore", { name: "Setup A" }));
assert(restored.restored >= 1, "state restored");
snap = val(await q("document.getState", {}));
assert(layersById().get(created.layerId).visible === true, "A-WALL visible again");
assert(layersById().get(created.layerId).color === "#b45309", "A-WALL color restored exactly");

// ---------------------------------------------------------------------------
step("LAYISO / LAYUNISO through the command line");
{
  const ctx = defaultCommandContext({ activeLayer: "0", layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "LAYISO" } },
      { event: { type: "entity", entity: { id: line.id, kind: "geometry", props: line.props } } },
      { event: { type: "enter" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  assert(plans.length === 1 && plans[0].appApi[0].name === "layer.isolate", "LAYISO emits layer.isolate");
  const res = await cmd(plans[0].appApi[0].name, plans[0].appApi[0].payload);
  assert(ok(res), "layer.isolate applied");
}
snap = val(await q("document.getState", {}));
assert(layersById().get("0").visible === false, "layer 0 hidden by isolation");
assert(layersById().get(created.layerId).visible === true, "the isolated layer stays visible");
assert((snap.layerStates ?? []).some((s) => s.name === "*ISOLATE*"), "the reserved *ISOLATE* state was saved");
val(await cmd("layer.unisolate", {}));
snap = val(await q("document.getState", {}));
assert(layersById().get("0").visible === true, "LAYUNISO restored layer 0");
assert(!(snap.layerStates ?? []).some((s) => s.name === "*ISOLATE*"), "the isolation state was removed");

// ---------------------------------------------------------------------------
step("LAYON + -LAYER ON * through the command line");
await cmd("drafting.updateLayer", { layerId: created.layerId, patch: { visible: false } });
{
  const ctx = defaultCommandContext({ activeLayer: "0", layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "LAYON" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  assert(plans.length === 1 && plans[0].appApi[0].name === "document.applyEdit", "LAYON emits one applyEdit batch");
  const res = await cmd(plans[0].appApi[0].name, plans[0].appApi[0].payload);
  assert(ok(res), "LAYON applied");
}
snap = val(await q("document.getState", {}));
assert((snap.layers ?? []).every((l) => l.visible === true), "every layer is on after LAYON");

// ---------------------------------------------------------------------------
step("-LAYER Make + CLAYER through the command line");
{
  const ctx = defaultCommandContext({ activeLayer: "0", layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "-LAYER" } },
      { event: { type: "typed", text: "M" } },
      { event: { type: "typed", text: "A-ANNOT" } },
      { event: { type: "enter" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  assert(plans.length === 1, "-LAYER Make emits one plan");
  for (const entry of plans[0].appApi) {
    const res = await cmd(entry.name, entry.payload);
    assert(ok(res), `-LAYER plan command ${entry.name}`);
  }
}
snap = val(await q("document.getState", {}));
const annot = layerByName("A-ANNOT");
assert(annot !== undefined, "-LAYER Make created A-ANNOT");
assert(snap.draftingSettings?.activeLayer === annot.id, "A-ANNOT is the active layer after Make");
{
  // CLAYER switches back to 0 by NAME.
  const ctx = defaultCommandContext({ activeLayer: annot.id, layers: snap.layers ?? [], currentSelection: [] });
  const plans = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "CLAYER" } },
      { event: { type: "typed", text: "0" } },
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  const res = await cmd(plans[0].appApi[0].name, plans[0].appApi[0].payload);
  assert(ok(res), "CLAYER applied");
}
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.activeLayer === "0", "CLAYER switched the active layer to 0");

// ---------------------------------------------------------------------------
step("linetypes: user-defined pattern + layer assignment + reference-checked removal");
val(await cmd("ltype.create", { name: "Fence", description: "fence posts", pattern: [10, 3, 2, 3] }));
snap = val(await q("document.getState", {}));
assert((snap.ltypes ?? []).some((l) => l.name === "Fence" && l.pattern.length === 4), "Fence linetype created");
const fenceOnLayer = await cmd("drafting.updateLayer", { layerId: annot.id, patch: { linetype: "Fence" } });
assert(ok(fenceOnLayer), "layer linetype set to Fence");
const fenceRemove = await cmd("ltype.remove", { name: "Fence" });
assert(!ok(fenceRemove), "removing a referenced linetype is blocked");
await cmd("drafting.updateLayer", { layerId: annot.id, patch: { linetype: "Continuous" } });
val(await cmd("ltype.remove", { name: "Fence" }));
snap = val(await q("document.getState", {}));
assert(!(snap.ltypes ?? []).some((l) => l.name === "Fence"), "Fence removed after unassign");

// ---------------------------------------------------------------------------
step("text/dim styles: create + set current + update + reference checks");
val(await cmd("textStyle.create", { name: "Notes-3mm", font: "mono", height: 3 }));
val(await cmd("dimStyle.create", { name: "ISO-25", textHeight: 2.5, arrowSize: 2, scale: 1, precision: 1 }));
val(await cmd("drafting.setSettings", { settings: { textStyle: "Notes-3mm", dimStyle: "ISO-25" } }));
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.textStyle === "Notes-3mm", "current text style");
assert(snap.draftingSettings?.dimStyle === "ISO-25", "current dim style");
val(await cmd("dimStyle.update", { name: "ISO-25", patch: { precision: 2 } }));
snap = val(await q("document.getState", {}));
assert((snap.dimStyles ?? []).find((s) => s.name === "ISO-25").precision === 2, "dim style precision updated");
const removeCurrent = await cmd("dimStyle.remove", { name: "ISO-25" });
assert(!ok(removeCurrent), "removing the CURRENT dim style is blocked");
const badStyle = await cmd("drafting.setSettings", { settings: { dimStyle: "Ghost" } });
assert(!ok(badStyle), "setting an unknown style is rejected");

// ---------------------------------------------------------------------------
step("standards: LTSCALE + default lineweight + layer standard apply");
val(await cmd("drafting.setSettings", { settings: { standards: { linetypeScale: 2 } } }));
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.standards?.linetypeScale === 2, "linetype scale 2");
// A partial standards patch keeps the sibling fields (deep merge).
val(await cmd("drafting.setSettings", { settings: { standards: { defaultLineweight: 0.5 } } }));
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.standards?.linetypeScale === 2, "linetype scale kept through the partial patch");
assert(snap.draftingSettings?.standards?.defaultLineweight === 0.5, "default lineweight 0.5");
const applied = val(await cmd("layer.applyStandard", { standard: "mechanical" }));
assert(applied.created.length === 7, "the mechanical standard created 7 layers");
assert(applied.skipped.includes("A-WALL") === false, "A-WALL is not part of the mechanical set");
const reapplied = val(await cmd("layer.applyStandard", { standard: "mechanical" }));
assert(reapplied.created.length === 0 && reapplied.skipped.length === 7, "re-apply skips existing layers");
const unknownStandard = await cmd("layer.applyStandard", { standard: "bogus" });
assert(!ok(unknownStandard), "unknown standard rejected");

// ---------------------------------------------------------------------------
step("undo/redo: one CHPROP batch = one undo");
const beforeUndo = snap.elements.find((el) => el.id === line.id).props.color;
val(await cmd("entity.setDisplay", { ids: [line.id], patch: { color: "#525252" } }));
val(await cmd("document.undo", {}));
snap = val(await q("document.getState", {}));
assert(snap.elements.find((el) => el.id === line.id).props.color === beforeUndo, "undo restored the color");
val(await cmd("document.redo", {}));
snap = val(await q("document.getState", {}));
assert(snap.elements.find((el) => el.id === line.id).props.color === "#525252", "redo re-applied");

// ---------------------------------------------------------------------------
step("active layer persistence: save → open round-trip");
val(await cmd("layer.setActive", { layerId: annot.id }));
const saved = val(await cmd("document.save", {}));
const reopened = val(await cmd("document.open", { snapshot: saved.snapshot, source: saved.bytes }));
assert(ok(reopened) || true, "open");
const openSnap = val(await q("document.getState", {}));
assert(openSnap.draftingSettings?.activeLayer === annot.id, "the active layer survived save/open");
assert((openSnap.textStyles ?? []).some((s) => s.name === "Notes-3mm"), "text styles persisted");
assert((openSnap.layerStates ?? []).some((s) => s.name === "Setup A"), "layer states persisted");

// Back to a deterministic final state for the fixture: reactivate 0 and save.
val(await cmd("layer.setActive", { layerId: "0" }));

// ---------------------------------------------------------------------------
step("deterministic save + pinned CAD-PARITY-004 fixture");
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
assert(s1.sha256 === s2.sha256, "save must be deterministic");
const sha = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
console.log(`LAYERS/STYLES SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    layers: (val(await q("document.getState", {})).layers ?? []).length,
    elements: snap.elements.length,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`LAYERS/STYLES SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.layers === (val(await q("document.getState", {})).layers ?? []).length, "fixture layer count");
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(`LAYERS/STYLES SMOKE: PASS — ${executed.length} commands; save sha ${sha.slice(0, 16)}… (CAD-PARITY-004 fixture)`);
