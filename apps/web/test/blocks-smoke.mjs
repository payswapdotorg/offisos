// CAD-PARITY-006 / Issue #84: Web host blocks/references workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) —
// against the running dev server, and asserts the document state after
// every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004): the Electron smoke runs the same script through
// the real Electron UI and both must match the pinned fixture
// (app/test/fixtures/cad-parity-006-blocks.json).
//
// Covers the CAD-PARITY-006 acceptance surface: BLOCK conversion (sources
// removed in ONE atomic revision), INSERT with DYNAMIC per-attribute value
// prompts (the prompt engine's rematerializing steps), ATTDEF (definition
// editing — instances propagate), ATTEDIT (per-instance values),
// instance placement transforms (move/rotate/scale/copy + the mirror typed
// decline), EXPLODE one-level materialization + undo/redo, the bounded xref
// lifecycle (attach unresolved through the command line; attach/reload with
// CONTENT through the palette path — provenance hashes; detach cascade),
// the blocks.list/xrefs.list inventories, attribute.update, save/open
// round-trips and the deterministic pinned fixture.
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/blocks-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)
//            First run: --write-fixture to pin the fixture.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-006-blocks.json");

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
const step = (name) => console.log(`BLOCKS SMOKE: ${name}`);

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
step("document.create + source geometry (LINE/CIRCLE/TEXT through the command line)");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-006-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-006-smoke",
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

// Source geometry for the block: a line + a circle + a text label.
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "2000,0" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "CIRCLE" } },
  { event: { type: "typed", text: "1000,600" } },
  { event: { type: "typed", text: "400" } },
]);
await runScript([
  { event: { type: "typed", text: "TEXT" } },
  { event: { type: "typed", text: "0,-300" } },
  { event: { type: "typed", text: "90" } },
  { event: { type: "enter" } },
  { event: { type: "typed", text: "DEMO BLOCK" } },
]);
assert(snap.elements.length === 3, `3 source entities (got ${snap.elements.length})`);
const lineEl = elementByType("line");
const circleEl = elementByType("circle");
const textEl = elementByType("text");
assert(lineEl && circleEl && textEl, "line + circle + text sources exist");

// ---------------------------------------------------------------------------
step("BLOCK: name → base point → object picks → ONE atomic conversion revision");
const revisionsBefore = snap.modelHistory?.revisions?.length ?? 0;
await runScript([
  { event: { type: "typed", text: "BLOCK" } },
  { event: { type: "typed", text: "DEMO-SYMBOL" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "entity", entity: pickOf(lineEl) } },
  { event: { type: "entity", entity: pickOf(circleEl) } },
  { event: { type: "entity", entity: pickOf(textEl) } },
  { event: { type: "enter" } },
]);
assert(snap.elements.length === 0, `sources converted (got ${snap.elements.length} elements)`);
assert((snap.blockDefs ?? []).length === 1, "one block definition");
const def = snap.blockDefs[0];
assert(def.name === "DEMO-SYMBOL", "definition name");
assert(def.entities.length === 3, `3 inline entities (got ${def.entities.length})`);
assert(def.basePoint.x === 0 && def.basePoint.y === 0, "base point");
const revisionsAfterBlock = snap.modelHistory?.revisions?.length ?? 0;
assert(revisionsAfterBlock === revisionsBefore + 1, `BLOCK is ONE revision (Δ=${revisionsAfterBlock - revisionsBefore})`);
// UNDO restores sources + removes the definition together.
assert(ok(await cmd("document.undo", {})), "undo");
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 3 && (snap.blockDefs ?? []).length === 0, "undo restored the conversion atomically");
assert(ok(await cmd("document.redo", {})), "redo");
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 0 && (snap.blockDefs ?? []).length === 1, "redo re-converted");

// ---------------------------------------------------------------------------
step("ATTDEF: add two attribute slots to the definition (instances propagate)");
await runScript([
  { event: { type: "typed", text: "ATTDEF" } },
  { event: { type: "typed", text: "DEMO-SYMBOL" } },
  { event: { type: "typed", text: "TITLE" } },
  { event: { type: "typed", text: "Drawing title" } },
  { event: { type: "typed", text: "UNTITLED" } },
  { event: { type: "typed", text: "0,-600" } },
  { event: { type: "typed", text: "90" } },
  { event: { type: "enter" } },
]);
await runScript([
  { event: { type: "typed", text: "ATTDEF" } },
  { event: { type: "typed", text: "DEMO-SYMBOL" } },
  { event: { type: "typed", text: "SHEET_NO" } },
  { event: { type: "enter" } }, // no prompt text
  { event: { type: "typed", text: "A-000" } },
  { event: { type: "typed", text: "0,-800" } },
  { event: { type: "typed", text: "90" } },
  { event: { type: "enter" } },
]);
snap = val(await q("document.getState", {}));
const defWithAttrs = snap.blockDefs[0];
assert(defWithAttrs.entities.length === 5, `definition now has 5 entities (got ${defWithAttrs.entities.length})`);
const attdefs = defWithAttrs.entities.filter((e) => e.type === "attdef");
assert(attdefs.length === 2, "two attribute definitions");
assert(attdefs[0].tag === "TITLE" && attdefs[0].prompt === "Drawing title" && attdefs[0].default === "UNTITLED", "TITLE slot");
assert(attdefs[1].tag === "SHEET_NO" && attdefs[1].default === "A-000", "SHEET_NO slot");

// ---------------------------------------------------------------------------
step("INSERT: dynamic per-attribute value prompts (Enter keeps the default)");
await runScript([
  { event: { type: "typed", text: "INSERT" } },
  { event: { type: "typed", text: "DEMO-SYMBOL" } },
  { event: { type: "typed", text: "3000,3000" } },
  { event: { type: "typed", text: "1.5" } },
  { event: { type: "enter" } }, // rotation 0
  { event: { type: "typed", text: "SITE PLAN A" } }, // TITLE value
  { event: { type: "enter" } }, // SHEET_NO default (nothing stored)
]);
assert(snap.elements.length === 1, "one inserted instance");
const instance = snap.elements[0];
assert(instance.props.type === "block-ref", "block-ref element");
assert(instance.props.blockId === def.id, "references the canonical definition id");
assert(instance.props.x === 3000 && instance.props.y === 3000, "insertion point");
assert(close(instance.props.scale, 1.5), "uniform scale 1.5");
assert(close(instance.props.rotation, 0), "rotation 0");
assert(
  Array.isArray(instance.props.attributes) && instance.props.attributes.length === 1 &&
    instance.props.attributes[0].tag === "TITLE" && instance.props.attributes[0].value === "SITE PLAN A",
  "only the TYPED attribute value is stored (Enter = default)",
);

// ---------------------------------------------------------------------------
step("BLOCKLIST + blocks.list inventory");
const { result: listResult } = await runScript([{ event: { type: "typed", text: "BLOCKLIST" } }]);
assert(
  listResult.lines.some((l) => l.includes("DEMO-SYMBOL") && l.includes("TITLE") && l.includes("SHEET_NO")),
  `BLOCKLIST echo lists the definition + tags: ${listResult.lines.join(" / ")}`,
);
const inventory = val(await q("blocks.list", {}));
assert(inventory.blocks.length === 1, "one definition in the inventory");
assert(inventory.blocks[0].name === "DEMO-SYMBOL", "inventory name");
assert(inventory.blocks[0].entityCount === 5, `inventory entity count (got ${inventory.blocks[0].entityCount})`);
assert(inventory.blocks[0].instances === 1, "inventory instance count");
assert(
  inventory.blocks[0].attributeTags.join(",") === "TITLE,SHEET_NO",
  `inventory tags: ${inventory.blocks[0].attributeTags.join(",")}`,
);

// ---------------------------------------------------------------------------
step("ATTEDIT: pick the instance → tag → new value");
await runScript([
  { event: { type: "typed", text: "ATTEDIT" } },
  { event: { type: "entity", entity: pickOf(instance) } },
  { event: { type: "typed", text: "TITLE" } },
  { event: { type: "typed", text: "SITE PLAN B" } },
]);
snap = val(await q("document.getState", {}));
assert(
  snap.elements[0].props.attributes[0].value === "SITE PLAN B",
  "ATTEDIT rewrote the instance value",
);
// attribute.update through the API (the inspector write path) + clear-to-default.
assert(ok(await cmd("attribute.update", { id: instance.id, tag: "SHEET_NO", value: "A-101" })), "attribute.update");
snap = val(await q("document.getState", {}));
assert(
  snap.elements[0].props.attributes.some((a) => a.tag === "SHEET_NO" && a.value === "A-101"),
  "inspector path stored SHEET_NO",
);
assert(ok(await cmd("attribute.update", { id: instance.id, tag: "SHEET_NO", value: null })), "attribute.update clear");
snap = val(await q("document.getState", {}));
assert(
  !snap.elements[0].props.attributes.some((a) => a.tag === "SHEET_NO"),
  "cleared value leaves NO stored key (default renders)",
);
// The API write is in the executed stream: fetch state again.
snap = val(await q("document.getState", {}));

// ---------------------------------------------------------------------------
step("instance placement transforms (MOVE/ROTATE/SCALE/COPY) + the MIRROR typed decline");
assert(ok(await cmd("entity.modify", { op: "move", ids: [instance.id], dx: 1000, dy: -500 })), "move");
snap = val(await q("document.getState", {}));
assert(snap.elements[0].props.x === 4000 && snap.elements[0].props.y === 2500, "moved insertion");
assert(ok(await cmd("entity.modify", { op: "rotate", ids: [instance.id], base: { x: 0, y: 0 }, angle: Math.PI / 2 })), "rotate");
snap = val(await q("document.getState", {}));
assert(close(snap.elements[0].props.x, -2500) && close(snap.elements[0].props.y, 4000), "rotated insertion");
assert(close(snap.elements[0].props.rotation, Math.PI / 2), "instance rotation composed");
assert(ok(await cmd("entity.modify", { op: "scale", ids: [instance.id], base: { x: 0, y: 0 }, factor: 2 })), "scale");
snap = val(await q("document.getState", {}));
assert(close(snap.elements[0].props.scale, 3), "instance scale multiplied (1.5 × 2)");
assert(ok(await cmd("entity.modify", { op: "copy", ids: [instance.id], dx: 500, dy: 500 })), "copy");
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 2, "two instances after copy");
const mirrorDecline = await cmd("entity.modify", { op: "mirror", ids: [instance.id], p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } });
assert(!ok(mirrorDecline) && errOf(mirrorDecline).code === "mirror_unsupported", "MIRROR on instances is the typed decline");

// ---------------------------------------------------------------------------
step("EXPLODE: one-level materialization + the undo/redo walk");
const exploded = val(await cmd("entity.modify", { op: "explode", ids: [instance.id] }));
assert(exploded.applied === true, "explode applied");
snap = val(await q("document.getState", {}));
// 5 materialized content entities (line, circle, text + 2 attribute texts)
// + the surviving COPY instance.
assert(snap.elements.length === 6, `exploded content materialized (got ${snap.elements.length})`);
const materializedTexts = snap.elements.filter((el) => el.kind === "annotation" && el.props?.type === "text");
assert(materializedTexts.length === 3, `text + 2 attribute texts (got ${materializedTexts.length})`);
assert(
  materializedTexts.some((t) => t.props.value === "SITE PLAN B"),
  "the instance's attribute VALUE materialized",
);
assert(
  materializedTexts.some((t) => t.props.value === "A-000"),
  "the CLEARED SHEET_NO slot renders the definition default (the clear semantics)",
);
assert(ok(await cmd("document.undo", {})), "undo explode");
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 2 && snap.elements.every((el) => el.props.type === "block-ref"), "undo restored the instance");
assert(ok(await cmd("document.redo", {})), "redo explode");
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 6, "redo re-materialized");

// ---------------------------------------------------------------------------
step("nested blocks: block-from-instance conversion + nested explode");
const survivingInstance = snap.elements.find((el) => el.props.type === "block-ref");
await runScript([
  { event: { type: "typed", text: "BLOCK" } },
  { event: { type: "typed", text: "NESTED-HOLDER" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "entity", entity: pickOf(survivingInstance) } },
  { event: { type: "enter" } },
]);
snap = val(await q("document.getState", {}));
const nestedDef = snap.blockDefs.find((b) => b.name === "NESTED-HOLDER");
assert(nestedDef, "NESTED-HOLDER created from the instance");
assert(nestedDef.entities.length === 1 && nestedDef.entities[0].type === "block-ref", "the nested reference is inline content");
await runScript([
  { event: { type: "typed", text: "INSERT" } },
  { event: { type: "typed", text: "NESTED-HOLDER" } },
  { event: { type: "typed", text: "-5000,-5000" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
]);
snap = val(await q("document.getState", {}));
const nestedInstance = snap.elements.find((el) => el.props.type === "block-ref" && el.props.x === -5000);
assert(nestedInstance, "nested holder instance placed");
const nestedExplode = val(await cmd("entity.modify", { op: "explode", ids: [nestedInstance.id] }));
assert(nestedExplode.applied === true, "nested explode applied");
snap = val(await q("document.getState", {}));
const innerRef = snap.elements.find((el) => el.props.type === "block-ref" && el.props.blockId === def.id);
assert(innerRef, "one level per explode: the INNER reference became an independent instance");

// ---------------------------------------------------------------------------
step("the bounded xref lifecycle: attach unresolved → list → attach with content → reload → detach");
// XATTACH through the command line: UNRESOLVED (the command line cannot read files).
const attachLines = await runScript([
  { event: { type: "typed", text: "XATTACH" } },
  { event: { type: "typed", text: "MISSING-REF" } },
  { event: { type: "typed", text: "missing.offisos" } },
  { event: { type: "typed", text: "20000,0" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
]);
assert(attachLines.result.lines.some((l) => l.includes("UNRESOLVED")), `XATTACH echo is honest: ${attachLines.result.lines.join(" / ")}`);
snap = val(await q("document.getState", {}));
assert((snap.xrefs ?? []).length === 1 && snap.xrefs[0].status === "unresolved", "unresolved record");
const xrefRef = snap.elements.find((el) => el.props.type === "xref-ref");
assert(xrefRef && xrefRef.props.x === 20000, "unresolved instance placed (placeholder rendering)");
// XRELOAD is the typed decline pointing at the palette.
const { result: reloadDecline } = await runScript([{ event: { type: "typed", text: "XRELOAD" } }]);
assert(
  reloadDecline.lines.some((l) => l.includes("References palette")),
  `XRELOAD typed decline: ${reloadDecline.lines.join(" / ")}`,
);
// XLIST statuses.
const { result: xlist } = await runScript([{ event: { type: "typed", text: "XLIST" } }]);
assert(xlist.lines.some((l) => l.includes("MISSING-REF") && l.includes("unresolved")), "XLIST lists the status");
// The palette path: attach WITH content (an offisos snapshot object).
const externalState = {
  version: snap.version,
  format: snap.format,
  formatVersion: snap.formatVersion,
  sourceArtifactLineage: [],
  editorState: snap.editorState,
  elements: [
    { id: "ext-1", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", x1: 0, y1: 0, x2: 5000, y2: 0 } },
    { id: "ext-2", kind: "annotation", engineId: null, props: { drafting: true, annotation: true, type: "text", layer: "0", x: 0, y: 500, height: 200, rotation: 0, value: "EXTERNAL SITE" } },
  ],
};
const attached = val(await cmd("xref.attach", { name: "SITE", path: "site.offisos", x: 30000, y: 0, scale: 2, rotation: 0, content: externalState }));
assert(attached.status === "loaded" && attached.resolved === 2 && attached.skipped === 0, "loaded with 2 resolved entities");
assert(/^[0-9a-f]{64}$/.test(attached.sourceHash), "provenance source hash");
snap = val(await q("document.getState", {}));
const siteRecord = snap.xrefs.find((x) => x.name === "SITE");
assert(siteRecord.status === "loaded" && siteRecord.entities.length === 2, "SITE record stored inline");
// Reload with FRESH content (a changed snapshot).
const externalStateV2 = { ...externalState, elements: [...externalState.elements, { id: "ext-3", kind: "geometry", engineId: null, props: { drafting: true, type: "circle", layer: "0", cx: 2500, cy: 1000, r: 800 } }] };
const reloaded = val(await cmd("xref.reload", { name: "SITE", content: externalStateV2 }));
assert(reloaded.resolved === 3, `reload re-resolved 3 entities (got ${reloaded.resolved})`);
snap = val(await q("document.getState", {}));
assert(snap.xrefs.find((x) => x.name === "SITE").entities.length === 3, "reloaded content stored");
// The xrefs.list inventory with instance counts.
const xrefInventory = val(await q("xrefs.list", {}));
assert(xrefInventory.xrefs.length === 2, "two references in the inventory");
const siteInv = xrefInventory.xrefs.find((x) => x.name === "SITE");
assert(siteInv.instances === 1 && siteInv.status === "loaded", "SITE inventory row");
// Detach: record + instances removed in ONE atomic revision.
const revisionsBeforeDetach = snap.modelHistory?.revisions?.length ?? 0;
const detached = val(await cmd("xref.detach", { name: "SITE" }));
assert(detached.removedInstances === 1, "detach removed the instance");
snap = val(await q("document.getState", {}));
assert(!snap.xrefs.some((x) => x.name === "SITE"), "SITE record removed");
assert((snap.modelHistory?.revisions?.length ?? 0) === revisionsBeforeDetach + 1, "detach is ONE atomic revision");

// ---------------------------------------------------------------------------
step("save/open round-trip (the blocks world survives)");
const saved = val(await cmd("document.save", {}));
assert(ok(await cmd("document.open", { source: saved.bytes, entityId: "cad-parity-006-smoke-reopened" })), "reopen");
snap = val(await q("document.getState", {}));
assert((snap.blockDefs ?? []).length === 2, "both definitions survived");
assert((snap.xrefs ?? []).length === 1 && snap.xrefs[0].name === "MISSING-REF", "the unresolved reference survived");
assert(
  snap.elements.some((el) => el.props.type === "xref-ref" && el.props.xrefId === snap.xrefs[0].id),
  "the unresolved instance survived with its canonical reference",
);

// ---------------------------------------------------------------------------
step("deterministic save + pinned CAD-PARITY-006 fixture");
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
const shaA = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
const shaB = createHash("sha256").update(Buffer.from(s2.bytes)).digest("hex");
assert(shaA === shaB, "save must be deterministic");
const sha = shaA;
console.log(`BLOCKS SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    blockDefs: snap.blockDefs.length,
    xrefs: snap.xrefs.length,
    elements: snap.elements.length,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`BLOCKS SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.saveSize === s1.bytes.length, "fixture save size");
  assert(fixture.blockDefs === snap.blockDefs.length, "fixture definition count");
  assert(fixture.xrefs === snap.xrefs.length, "fixture xref count");
  assert(
    fixture.commandStream.join("|") === executed.join("|"),
    `fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`,
  );
}

console.log(`BLOCKS SMOKE: PASS — ${executed.length} commands; ${snap.blockDefs.length} definitions; ${snap.xrefs.length} xrefs; save sha ${sha.slice(0, 16)}… (CAD-PARITY-006 fixture)`);
