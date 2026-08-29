// CAD-PARITY-005 / Issue #82: Web host annotation workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt engine (app/src/workspace) for the typed
// annotation commands (TEXT/MTEXT/DIMLINEAR/DIMALIGNED/DIMRADIUS/
// DIMDIAMETER/DIMANGULAR/LEADER/MLEADER/DIMTEDIT/DIMSCALE) and the App API
// commands (annotation.create/update/remeasure) — against the running dev
// server, asserting document state after every step: SERVER-side
// measurement, the associative remeasure cascade, style-driven behavior,
// locked-layer enforcement and save/open persistence. The CAD-PARITY-002
// and CAD-PARITY-004 parity fixtures stay the regression gates for the old
// surfaces; THIS smoke pins the CAD-PARITY-005 surface with its own fixture
// (app/test/fixtures/cad-parity-005-annotation.json).
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/annotation-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-005-annotation.json");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));
const { geomFromElement } = await import(join(REPO_ROOT, "app", "src", "workspace", "geometry", "bridge.ts"));
/** The canonical geometry of an element (both storage conventions). */
const geomOf = (el) => geomFromElement({ id: el.id, kind: el.kind, engineId: null, props: el.props });

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
const step = (name) => console.log(`ANNOTATION SMOKE: ${name}`);

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
step("document.create + geometry (LINE/CIRCLE through the command line)");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-005-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-005-smoke",
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

await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "3000,0" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "0,2000" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "CIRCLE" } },
  { event: { type: "typed", text: "5000,1000" } },
  { event: { type: "typed", text: "800" } },
]);
const baseline = snap.elements.filter((el) => el.kind === "geometry");
assert(baseline.length === 3, `3 geometry elements (got ${baseline.length})`);
const hLine = elementByType("line", 0);
const vLine = elementByType("line", 1);
const circle = elementByType("circle");

// ---------------------------------------------------------------------------
step("TEXT through the command line");
await runScript([
  { event: { type: "typed", text: "TEXT" } },
  { event: { type: "typed", text: "500,500" } },
  { event: { type: "typed", text: "120" } },
  { event: { type: "typed", text: "15" } },
  { event: { type: "typed", text: "OFFISOS ANNOTATION ENGINE" } },
]);
const textEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text");
assert(textEl !== undefined, "TEXT created");
assert(textEl.props.height === 120, "TEXT height 120");
assert(textEl.props.value === "OFFISOS ANNOTATION ENGINE", "TEXT value");
assert(close(textEl.props.rotation, (15 * Math.PI) / 180), "TEXT rotation 15° in radians");
assert(textEl.props.style === "Standard", "TEXT uses the current style");
assert(textEl.kind === "annotation", "TEXT is an annotation element");

// ---------------------------------------------------------------------------
step("MTEXT through the command line (multi-line via \\n escapes)");
await runScript([
  { event: { type: "typed", text: "MT" } },
  { event: { type: "typed", text: "1000,-500" } },
  { event: { type: "typed", text: "2000" } },
  { event: { type: "typed", text: "LINE ONE\\nLINE TWO" } },
]);
const mtextEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "mtext");
assert(mtextEl !== undefined, "MTEXT created");
assert(mtextEl.props.value === "LINE ONE\nLINE TWO", "MTEXT value with the line break expanded");
assert(mtextEl.props.width === 2000, "MTEXT column width");
assert(mtextEl.props.height === 2.5, "MTEXT default height (style not fixed)");

// ---------------------------------------------------------------------------
step("DIMLINEAR auto-mode (placement above → horizontal)");
await runScript([
  { event: { type: "typed", text: "DLI" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "3000,0" } },
  { event: { type: "typed", text: "1500,600" } },
]);
const dimH = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "horizontal");
assert(dimH !== undefined, "horizontal dim created");
assert(dimH.props.measured === 3000, "horizontal measured 3000 (server-side)");
assert(dimH.props.offset === 600, "offset from the placement");

// ---------------------------------------------------------------------------
step("DIMLINEAR V flag + R rotation option");
await runScript([
  { event: { type: "typed", text: "DLI" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "0,2000" } },
  { event: { type: "typed", text: "V" } },
  { event: { type: "typed", text: "-400,1000" } },
]);
const dimV = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "vertical");
assert(dimV !== undefined, "vertical dim created (V flag)");
assert(dimV.props.measured === 2000, "vertical measured 2000");

await runScript([
  { event: { type: "typed", text: "DLI" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "3000,0" } },
  { event: { type: "typed", text: "R" } },
  { event: { type: "typed", text: "30" } },
  { event: { type: "typed", text: "1500,600" } },
]);
const dimR = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "rotated");
assert(dimR !== undefined, "rotated dim created (R option)");
assert(close(dimR.props.measured, 3000 * Math.cos(Math.PI / 6)), "rotated measured = projection");

// ---------------------------------------------------------------------------
step("DIMALIGNED");
await runScript([
  { event: { type: "typed", text: "DAL" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "3000,2000" } },
  { event: { type: "typed", text: "0,2600" } },
]);
const dimA = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-linear" && el.props?.mode === "aligned");
assert(dimA !== undefined, "aligned dim created");
assert(dimA.props.measured === 3605.551275463989 || close(dimA.props.measured, Math.hypot(3000, 2000)), "aligned measured = distance");

// ---------------------------------------------------------------------------
step("DIMRADIUS on the circle (server-side measured)");
await runScript([
  { event: { type: "typed", text: "DRA" } },
  { event: { type: "entity", entity: pickOf(circle) } },
  { event: { type: "typed", text: "6500,1000" } },
]);
const dimRad = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-radius");
assert(dimRad !== undefined, "radius dim created");
assert(dimRad.props.measured === 800, "radius measured SERVER-side from the target");
assert(dimRad.props.target === circle.id, "radius dim references the circle");
assert(dimRad.props.center.x === 5000 && dimRad.props.center.y === 1000, "center snapshot from the target");

// ---------------------------------------------------------------------------
step("DIMDIAMETER");
await runScript([
  { event: { type: "typed", text: "DDI" } },
  { event: { type: "entity", entity: pickOf(circle) } },
  { event: { type: "typed", text: "5000,2000" } },
]);
const dimDia = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-diameter");
assert(dimDia !== undefined, "diameter dim created");
assert(dimDia.props.measured === 1600, "diameter measured 2r server-side");
assert(close(dimDia.props.angle, Math.PI / 2), "dimension line direction from the placement");

// ---------------------------------------------------------------------------
step("DIMANGULAR between the two lines (entityPoint picks select the legs)");
await runScript([
  { event: { type: "typed", text: "DAN" } },
  { event: { type: "entityPoint", entity: pickOf(hLine), point: [2000, 0] } },
  { event: { type: "entityPoint", entity: pickOf(vLine), point: [0, 1500] } },
  { event: { type: "typed", text: "900,900" } },
]);
const dimAng = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "dim-angular");
assert(dimAng !== undefined, "angular dim created");
assert(close(dimAng.props.measured, Math.PI / 2), "angular measured 90° (in radians)");
assert(close(dimAng.props.startAngle, 0, TOL) && close(dimAng.props.endAngle, Math.PI / 2), "the placement selected the first-quadrant sector");
assert(Array.isArray(dimAng.props.refs) && dimAng.props.refs.length === 2, "both legs referenced (associative)");

// ---------------------------------------------------------------------------
step("LEADER + MLEADER");
await runScript([
  { event: { type: "typed", text: "LE" } },
  { event: { type: "typed", text: "3000,2000" } },
  { event: { type: "typed", text: "3400,2400" } },
  { event: { type: "typed", text: "3800,2400" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "SEE DETAIL A" } },
]);
const leaderEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "leader");
assert(leaderEl !== undefined, "leader created");
assert(leaderEl.props.points.length === 3, "leader spine points");
assert(leaderEl.props.value === "SEE DETAIL A", "leader annotation text");

await runScript([
  { event: { type: "typed", text: "MLD" } },
  { event: { type: "typed", text: "5000,-500" } },
  { event: { type: "typed", text: "5600,-900" } },
  { event: { type: "typed", text: "TWO\\nLINES" } },
]);
const mleaderEl = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "mleader");
assert(mleaderEl !== undefined, "mleader created");
assert(mleaderEl.props.value === "TWO\nLINES", "mleader multi-line content");

// ---------------------------------------------------------------------------
step("styles → real annotation behavior: text/dim style tables drive creation");
val(await cmd("textStyle.create", { name: "Notes-Mono", font: "mono", height: 90, widthFactor: 0.8, obliqueAngle: 12 }));
val(await cmd("dimStyle.create", { name: "ISO-25", textHeight: 60, arrowSize: 45, scale: 1, precision: 1, arrowStyle: "tick", unitSuffix: " mm" }));
val(await cmd("drafting.setSettings", { settings: { textStyle: "Notes-Mono", dimStyle: "ISO-25" } }));
snap = val(await q("document.getState", {}));

await runScript([
  { event: { type: "typed", text: "TEXT" } },
  { event: { type: "typed", text: "2000,1500" } },
  { event: { type: "typed", text: "50" } },
  { event: { type: "typed", text: "0" } },
  { event: { type: "typed", text: "STYLE-DRIVEN" } },
]);
const styledText = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text" && el.props?.value === "STYLE-DRIVEN");
assert(styledText !== undefined, "styled TEXT created");
assert(styledText.props.height === 90, "the style's FIXED height won over the typed 50");
assert(styledText.props.style === "Notes-Mono", "references the text style");

await runScript([
  { event: { type: "typed", text: "DLI" } },
  { event: { type: "typed", text: "0,-1000" } },
  { event: { type: "typed", text: "3000,-1000" } },
  { event: { type: "typed", text: "1500,-1600" } },
]);
const styledDim = snap.elements.filter((el) => el.props?.annotation === true && el.props?.type === "dim-linear").at(-1);
assert(styledDim.props.style === "ISO-25", "dimension references the dim style");

// ---------------------------------------------------------------------------
step("annotation.update: textOverride + DIMTEDIT text placement");
const r1 = val(await cmd("annotation.update", { ids: [styledDim.id], patch: { textOverride: "≈3000" } }));
assert(r1.applied === true, "textOverride update");
snap = val(await q("document.getState", {}));
assert(snap.elements.find((el) => el.id === styledDim.id).props.textOverride === "≈3000", "textOverride stored");

const dimForTedit = dimH;
await runScript([
  { event: { type: "typed", text: "DIMTED" } },
  { event: { type: "entity", entity: pickOf(dimForTedit) } },
  { event: { type: "typed", text: "1500,1200" } },
]);
snap = val(await q("document.getState", {}));
const teditDim = snap.elements.find((el) => el.id === dimForTedit.id);
assert(teditDim.props.textPos !== undefined, "DIMTEDIT stored the text position");
assert(teditDim.props.textPos.x === 1500 && teditDim.props.textPos.y === 1200, "DIMTEDIT position");

// ---------------------------------------------------------------------------
step("DIMSCALE: the document annotation scale standard");
await runScript([
  { event: { type: "typed", text: "DIMSCALE" } },
  { event: { type: "typed", text: "2" } },
]);
snap = val(await q("document.getState", {}));
assert(snap.draftingSettings?.standards?.annotationScale === 2, "annotationScale persisted");

// ---------------------------------------------------------------------------
step("ASSOCIATIVE: scaling the circle re-measures the radius dim atomically");
const versionBefore = snap.version.version_number;
val(await cmd("entity.modify", { op: "scale", ids: [circle.id], base: { x: 5000, y: 1000 }, factor: 1.5 }));
snap = val(await q("document.getState", {}));
assert(snap.version.version_number === versionBefore + 1, "ONE atomic revision (geometry + re-measure)");
const scaledRad = snap.elements.find((el) => el.id === dimRad.id);
assert(scaledRad.props.measured === 1200, "radius dim re-measured to 1200");
assert(scaledRad.props.center.x === 5000, "center snapshot refreshed");
const scaledDia = snap.elements.find((el) => el.id === dimDia.id);
assert(scaledDia.props.measured === 2400, "diameter dim re-measured to 2400");

// ---------------------------------------------------------------------------
step("ASSOCIATIVE: rotating a leg re-measures the angular dim");
val(await cmd("entity.modify", { op: "rotate", ids: [vLine.id], base: { x: 0, y: 0 }, angle: -Math.PI / 4 }));
snap = val(await q("document.getState", {}));
const rotatedAng = snap.elements.find((el) => el.id === dimAng.id);
assert(close(rotatedAng.props.measured, Math.PI / 4, 1e-6), `angular re-measured to 45° (got ${rotatedAng.props.measured})`);

// ---------------------------------------------------------------------------
step("undo restores the geometry AND the re-measured dims (one entry)");
val(await cmd("document.undo", {}));
snap = val(await q("document.getState", {}));
const restoredLeg = geomOf(snap.elements.find((el) => el.id === vLine.id));
assert(restoredLeg.type === "line" && close(restoredLeg.x2, 0), `leg restored (got ${JSON.stringify(restoredLeg)})`);
assert(close(snap.elements.find((el) => el.id === dimAng.id).props.measured, Math.PI / 2), "angular dim restored");

// ---------------------------------------------------------------------------
step("ASSOCIATIVE: deleting the target disassociates (value survives)");
val(await cmd("drafting.delete", { ids: [circle.id] }));
snap = val(await q("document.getState", {}));
const disassociated = snap.elements.find((el) => el.id === dimRad.id);
assert(disassociated !== undefined, "the dimension survives");
assert(disassociated.props.target === null, "target cleared");
assert(disassociated.props.measured === 1200, "last known value survives");
const remeasure = val(await cmd("annotation.remeasure", { ids: [dimRad.id] }));
assert(remeasure.applied === false, "remeasure on a disassociated dim is a no-op");

// ---------------------------------------------------------------------------
step("locked layer: annotation creation allowed, modification typed-failed");
val(await cmd("drafting.addLayer", { name: "A-ANNO-LOCKED", color: "#374151" }));
snap = val(await q("document.getState", {}));
const lockedLayer = (snap.layers ?? []).find((l) => l.name === "A-ANNO-LOCKED");
val(await cmd("drafting.updateLayer", { layerId: lockedLayer.id, patch: { locked: true } }));
const lockedCreate = val(await cmd("annotation.create", {
  entities: [{ type: "text", layer: lockedLayer.id, x: 0, y: -2000, height: 100, rotation: 0, value: "LOCKED" }],
}));
assert(lockedCreate.applied === true, "creating on a locked layer is allowed");
snap = val(await q("document.getState", {}));
const lockedText = snap.elements.find((el) => el.props?.value === "LOCKED");
const lockedUpdate = await cmd("annotation.update", { ids: [lockedText.id], patch: { value: "CHANGED" } });
assert(!ok(lockedUpdate), "locked-layer annotation modification rejected");
assert(lockedUpdate.message.includes("locked"), "the failure names the lock");

// ---------------------------------------------------------------------------
step("save/open round-trip: every annotation field persists");
const saved = val(await cmd("document.save", {}));
val(await cmd("document.open", { source: saved.bytes, entityId: "roundtrip" }));
snap = val(await q("document.getState", {}));
const roundTripText = snap.elements.find((el) => el.props?.annotation === true && el.props?.type === "text" && el.props?.value === "STYLE-DRIVEN");
assert(roundTripText !== undefined, "styled text survived");
assert(roundTripText.props.height === 90 && roundTripText.props.style === "Notes-Mono", "style-driven fields survived");
assert(snap.draftingSettings?.standards?.annotationScale === 2, "annotationScale survived");
assert((snap.dimStyles ?? []).some((s) => s.name === "ISO-25" && s.arrowStyle === "tick" && s.unitSuffix === " mm"), "dim style with the new fields persisted");

// ---------------------------------------------------------------------------
step("deterministic save + pinned CAD-PARITY-005 fixture");
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const sha = shaA;
console.log(`ANNOTATION SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    annotations: snap.elements.filter((el) => el.kind === "annotation").length,
    elements: snap.elements.length,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`ANNOTATION SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.annotations === snap.elements.filter((el) => el.kind === "annotation").length, "fixture annotation count");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(`ANNOTATION SMOKE: PASS — ${executed.length} commands; ${snap.elements.filter((el) => el.kind === "annotation").length} annotations; save sha ${sha.slice(0, 16)}… (CAD-PARITY-005 fixture)`);
