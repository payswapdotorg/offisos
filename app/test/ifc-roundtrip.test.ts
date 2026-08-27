/**
 * COMPAT-IFC-001 — IFC export/import round-trip on the REAL IfcOpenShell
 * toolchain (ifcopenshell 0.8.5 worker; mirrors the OCCT engine-test
 * convention). The full acceptance chain of Issue #47:
 *
 *   Offisos BIM → IFC export → external IFC → IFC import → semantic
 *   reconciliation → canonical Offisos BIM → Construction Graph
 *
 * Every assertion is numeric/deterministic: export bytes byte-identical for
 * equal inputs, canonical ids preserved through the round trip, GlobalIds
 * retained as engineId provenance ONLY, units/placements normalized within
 * the declared tolerance, controlled mutations identified exactly, import
 * records persisted + replayable, typed failures explicit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { ifcGuidFor, ifcLengthScale } from "../src/ifc/index.js";
import { ifcSkip } from "./ifc-availability.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const TOL = 1e-3; // declared round-trip tolerance (mm)

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const skipIfc = await ifcSkip();

function handler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "ifc-roundtrip",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "ifc-test",
  });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

/** The representative building (docs/bim precedent + a 30° rotated wall so
 *  the placement-rotation reconstruction is exercised). */
const BUILDING = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-rot", storyId: "story-gf", start: [1000, 2000], end: [1000 + 3000, 2000 + 3000], width: 250, height: 2800, baseOffset: 200 },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
  { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.opening", id: "op-door-rot", hostId: "wall-rot", distance: 1000, width: 800, height: 2000, sill: 100 },
  { type: "bim.door", id: "door-main", openingId: "op-door", swing: "right", leafThickness: 45 },
  { type: "bim.window", id: "window-rot", openingId: "op-door-rot" },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
];

async function seeded(): Promise<{ h: AppApiHandler; ifc: string; sha256: string }> {
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-building" });
  await cmd(h, "bim.createElements", { entities: BUILDING });
  const exported = val<{ ifc: string; sha256: string }>(await cmd(h, "ifc.export", {}));
  return { h, ifc: exported.ifc, sha256: exported.sha256 };
}

// --- length-unit normalization (pure function) --------------------------------

test("ifcLengthScale covers the declared unit vocabulary and rejects others", () => {
  assert.equal(ifcLengthScale("METRE", null), 1000);
  assert.equal(ifcLengthScale("METRE", "MILLI"), 1);
  assert.equal(ifcLengthScale("METRE", "CENTI"), 10);
  assert.equal(ifcLengthScale("METRE", "KILO"), 1_000_000);
  assert.equal(ifcLengthScale("FOOT", null), 304.8);
  assert.equal(ifcLengthScale("INCH", null), 25.4);
  assert.equal(ifcLengthScale("METRE", "MICRO"), null);
  assert.equal(ifcLengthScale("FATHOM", null), null);
  assert.equal(ifcLengthScale(null, null), null);
});

// --- export -------------------------------------------------------------------

test("ifc.export produces a deterministic IFC4 file with the full semantic set", { skip: skipIfc }, async () => {
  const { h, sha256 } = await seeded();
  const again = val<{ ifc: string; sha256: string; size: number; schema: string; counts: Record<string, number> }>(
    await cmd(h, "ifc.export", {}),
  );
  assert.equal(again.sha256, sha256, "export bytes are byte-identical for equal inputs");
  assert.equal(again.schema, "IFC4");
  assert.deepEqual(again.counts, {
    stories: 1, walls: 4, slabs: 1, openings: 2, doors: 1, windows: 1, spaces: 1,
    // COMPAT-BIM-003 (additive): the seed model carries no materials/components
    // and no coordination primitives — the counts report that explicitly.
    materials: 0, components: 0, gridsNotExported: 0, referencePlanesNotExported: 0,
  });
  assert.ok(again.size > 1000);
});

test("ifc.compare: the export reconciles against its own document with zero loss", { skip: skipIfc }, async () => {
  const { h, ifc } = await seeded();
  const { report, reportHash } = val<{ report: { summary: Record<string, number>; elements: { action: string }[] }; reportHash: string }>(
    await qq(h, "ifc.compare", { ifc }),
  );
  assert.equal(report.summary.lossy, 0, "no lossy fields");
  assert.equal(report.summary.unsupportedFields, 0, "no unsupported fields");
  assert.equal(report.summary.created, 0, "dry-run: nothing created");
  assert.equal(report.summary.reconciled, 0, "nothing changed");
  assert.equal(report.summary.unchanged, BUILDING.length, "every element unchanged");
  assert.ok(/^[0-9a-f]{64}$/.test(reportHash));
});

// --- fresh import (the acceptance chain) ----------------------------------------

test("ifc.import into a fresh document preserves canonical ids and retains GlobalIds as provenance", { skip: skipIfc }, async () => {
  const { ifc } = await seeded();
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-reimport" });
  const result = val<{
    record: { id: string; sourceHash: string; mapping: { canonicalId: string | null; globalId: string }[] };
    report: { summary: Record<string, number> };
  }>(await cmd(h, "ifc.import", { ifc }));

  assert.equal(result.report.summary.created, BUILDING.length, "all elements created");
  assert.equal(result.report.summary.lossy, 0);
  assert.match(result.record.id, /^if-\d{6}$/);
  assert.equal(result.record.mapping.length, BUILDING.length);

  const snap = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  const byId = new Map(snap.elements.map((el) => [el.id, el] as const));
  // every canonical id preserved exactly
  for (const entity of BUILDING) {
    assert.ok(byId.has(entity.id), `canonical id preserved: ${entity.id}`);
  }
  // GlobalIds are engineId provenance ONLY — derived from the canonical id
  for (const entity of BUILDING) {
    const el = byId.get(entity.id)!;
    assert.equal(el.engineId, ifcGuidFor(entity.id), `engineId carries the derived IfcGuid for ${entity.id}`);
  }
  // the import record is persisted
  const listed = val<{ records: { id: string }[] }>(await qq(h, "ifc.listImports", {}));
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0]!.id, result.record.id);
});

test("ifc.import reconstructs geometry within the declared tolerance (incl. rotated walls + hosted openings)", { skip: skipIfc }, async () => {
  const { ifc } = await seeded();
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-geometry" });
  await cmd(h, "ifc.import", { ifc });
  const snap = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  const byId = new Map(snap.elements.map((el) => [el.id, el.props as Record<string, unknown>] as const));

  const wallRot = byId.get("wall-rot")!;
  const start = wallRot.start as [number, number];
  const end = wallRot.end as [number, number];
  assert.ok(Math.abs(start[0] - 1000) <= TOL && Math.abs(start[1] - 2000) <= TOL, "rotated wall start");
  assert.ok(Math.abs(end[0] - 4000) <= TOL && Math.abs(end[1] - 5000) <= TOL, "rotated wall end");
  assert.ok(Math.abs((wallRot.width as number) - 250) <= TOL, "rotated wall width");
  assert.ok(Math.abs((wallRot.height as number) - 2800) <= TOL, "rotated wall height");
  assert.ok(Math.abs((wallRot.baseOffset as number) - 200) <= TOL, "rotated wall baseOffset");

  const opRot = byId.get("op-door-rot")!;
  assert.ok(Math.abs((opRot.distance as number) - 1000) <= TOL, "hosted opening distance on the rotated wall");
  assert.ok(Math.abs((opRot.width as number) - 800) <= TOL, "opening width");
  assert.ok(Math.abs((opRot.height as number) - 2000) <= TOL, "opening height");
  assert.ok(Math.abs((opRot.sill as number) - 100) <= TOL, "opening sill");
  assert.equal(opRot.hostId, "wall-rot");

  const door = byId.get("door-main")!;
  assert.equal(door.swing, "right", "door swing preserved through the params pset");
  assert.equal(door.leafThickness, 45, "door leaf thickness preserved");

  const slab = byId.get("slab-g")!;
  const c1 = slab.corner1 as [number, number];
  const c2 = slab.corner2 as [number, number];
  assert.ok(Math.abs(c1[0] + 300) <= TOL && Math.abs(c1[1] + 300) <= TOL, "slab corner1");
  assert.ok(Math.abs(c2[0] - 6300) <= TOL && Math.abs(c2[1] - 5300) <= TOL, "slab corner2");
  assert.ok(Math.abs((slab.thickness as number) - 200) <= TOL, "slab thickness");
  assert.ok(Math.abs((slab.baseOffset as number) + 200) <= TOL, "slab baseOffset");

  const space = byId.get("space-office")!;
  const fp = space.footprint as [number, number][];
  assert.equal(fp.length, 6);
  assert.ok(Math.abs(fp[1]![0] - 6000) <= TOL && Math.abs(fp[1]![1]) <= TOL, "space footprint round-trips");
  assert.ok(Math.abs((space.area as number) - 27_000_000) <= 1, "space area recomputed (shoelace, mm²)");
});

test("export → import → export is byte-identical for exactly-representable geometry", { skip: skipIfc }, async () => {
  // Axis-aligned integer geometry reconstructs BIT-EXACTLY through the
  // mm→m→mm normalization, so the full cycle is byte-identical. (The rotated
  // wall below reconstructs within the declared tolerance but not
  // bit-exactly — its cycle is asserted SEMANTICALLY, which is the honest
  // claim; see the next test.)
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-cycle" });
  await cmd(h, "bim.createElements", { entities: BUILDING.filter((e) => e.id !== "wall-rot" && e.id !== "op-door-rot" && e.id !== "window-rot") });
  const first = val<{ ifc: string; sha256: string }>(await cmd(h, "ifc.export", {}));
  const h2 = handler();
  await cmd(h2, "document.create", { entityId: "ifc-cycle-2" });
  await cmd(h2, "ifc.import", { ifc: first.ifc });
  const reexported = val<{ sha256: string }>(await cmd(h2, "ifc.export", {}));
  assert.equal(reexported.sha256, first.sha256, "the re-exported file is byte-identical to the original");
});

test("the rotated-wall cycle is semantically stable (re-import reconciles unchanged)", { skip: skipIfc }, async () => {
  const { h, ifc } = await seeded();
  await cmd(h, "ifc.import", { ifc });
  const reexported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const again = val<{ report: { summary: Record<string, number> } }>(await cmd(h, "ifc.import", { ifc: reexported.ifc }));
  assert.equal(again.report.summary.created, 0, "the cycle has converged: nothing new");
  assert.equal(again.report.summary.reconciled, 0, "nothing drifted beyond tolerance");
  assert.equal(again.report.summary.unchanged, BUILDING.length);
});

// --- reconciliation ------------------------------------------------------------

test("ifc.import into the SAME document reconciles to unchanged (identity-based)", { skip: skipIfc }, async () => {
  const { h, ifc } = await seeded();
  const before = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  const result = val<{ report: { summary: Record<string, number> } }>(await cmd(h, "ifc.import", { ifc }));
  assert.equal(result.report.summary.created, 0, "nothing created (all matched by identity)");
  assert.equal(result.report.summary.reconciled, 0, "nothing changed");
  assert.equal(result.report.summary.unchanged, BUILDING.length);
  const after = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  assert.equal(after.elements.length, before.elements.length, "no duplicate elements");
});

test("controlled mutations survive the round trip and identify EXACTLY the changed canonical element", { skip: skipIfc }, async () => {
  const { h, ifc } = await seeded();
  // v1 file imported into a document holding v0 state? No — the chain here:
  // doc holds v1; mutate the doc (v2); export v2; import v2 into the v1 doc →
  // exactly the mutated wall reconciles, everything else unchanged.
  const h2 = handler();
  await cmd(h2, "document.create", { entityId: "ifc-mutation" });
  await cmd(h2, "bim.createElements", { entities: BUILDING });
  // a custom property enters through the low-level updateElement (the bim.*
  // vocabulary is closed by design — LOCK-007; custom props are the escape
  // hatch that flows through Pset_OffisosCustom on export)
  await cmd(h2, "document.applyEdit", { edit: { type: "updateElement", elementId: "wall-east", patch: { FireRating: "REI120" } } });
  await cmd(h2, "bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 });
  const mutatedExport = val<{ ifc: string }>(await cmd(h2, "ifc.export", {}));

  const result = val<{
    report: {
      elements: { canonicalId: string | null; action: string; fields: { field: string; classification: string }[] }[];
      summary: Record<string, number>;
    };
    patched: string[];
  }>(await cmd(h, "ifc.import", { ifc: mutatedExport.ifc }));

  const reconciled = result.report.elements.filter((e) => e.action === "reconciled").map((e) => e.canonicalId);
  assert.deepEqual([...reconciled].sort(), ["wall-east", "wall-north"], "exactly the two mutated elements reconciled");
  assert.equal(result.report.summary.created, 0);
  const unchanged = result.report.elements.filter((e) => e.action === "unchanged");
  assert.equal(unchanged.length, BUILDING.length - 2);
  assert.ok(result.patched.includes("wall-north"));
  assert.ok(result.patched.includes("wall-east"), "the custom FireRating prop flows through Pset_OffisosCustom");

  const north = result.report.elements.find((e) => e.canonicalId === "wall-north")!;
  const startField = north.fields.find((f) => f.field === "start.y")!;
  assert.equal(startField.classification, "lossy", "the moved wall's changed field is classified lossy (beyond tolerance)");
});

// --- undo / persistence ---------------------------------------------------------

test("ifc.import is ONE atomic versioned command — undo removes elements AND the record", { skip: skipIfc }, async () => {
  const { ifc } = await seeded();
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-undo" });
  await cmd(h, "ifc.import", { ifc });
  const withImport = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  assert.equal(withImport.elements.length, BUILDING.length);

  await cmd(h, "document.undo", {});
  const undone = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  assert.equal(undone.elements.length, 0, "imported elements removed");
  const listed = val<{ records: unknown[] }>(await qq(h, "ifc.listImports", {}));
  assert.equal(listed.records.length, 0, "import record removed with the same undo");

  await cmd(h, "document.redo", {});
  const redone = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  assert.equal(redone.elements.length, BUILDING.length, "redo restores everything");
  const listed2 = val<{ records: unknown[] }>(await qq(h, "ifc.listImports", {}));
  assert.equal(listed2.records.length, 1);
});

test("import records persist through save/open with identical content", { skip: skipIfc }, async () => {
  const { ifc } = await seeded();
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-persist" });
  await cmd(h, "ifc.import", { ifc });
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const opened = handler();
  await cmd(opened, "document.open", { source: saved.bytes });
  const snap = val<CADDocumentSnapshot>(await qq(opened, "document.getState", {}));
  assert.equal(snap.elements.length, BUILDING.length);
  assert.ok((snap.ifcImports ?? []).length === 1, "the import record survived save/open");
  assert.match(snap.ifcImports![0]!.id, /^if-\d{6}$/);
  // re-import after open still reconciles to unchanged (identity survived)
  const reimport = val<{ report: { summary: Record<string, number> } }>(await cmd(opened, "ifc.import", { ifc }));
  assert.equal(reimport.report.summary.unchanged, BUILDING.length);
  assert.equal(reimport.report.summary.created, 0);
});

// --- external files (no identity psets) ------------------------------------------

test("external IFC without identity psets imports with minted ids + GlobalId provenance", { skip: skipIfc }, async () => {
  const externalBytes = readFileSync(`${FIXTURES}/external-no-identity.ifc`);
  const external = externalBytes.toString("base64");
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-external" });
  const result = val<{
    report: { summary: Record<string, number>; elements: { action: string; ifcClass: string; fields: { field: string; classification: string }[] }[] };
    record: { mapping: { canonicalId: string | null; globalId: string; ifcClass: string; action: string }[] };
    created: string[];
  }>(await cmd(h, "ifc.import", { ifc: external, defaultStoryHeight: 3000, defaultSpaceHeight: 3000 }));

  assert.equal(result.report.summary.created, 6, "storey + wall + opening + door + slab + space created");
  assert.ok(result.created.every((id) => /^el-\d{6}$/.test(id)), "all ids minted by the document");
  // GlobalIds retained as provenance
  const snap = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  for (const el of snap.elements) {
    if (el.props.type !== "bim.story") {
      assert.ok(typeof el.engineId === "string" && el.engineId.length === 22, `engineId provenance on ${el.id}`);
    }
  }
  // geometry from the external file (mm domain)
  const byId = new Map(snap.elements.map((el) => [el.id, el.props as Record<string, unknown>] as const));
  const wall = [...byId.values()].find((p) => p.type === "bim.wall")!;
  assert.ok(Math.abs((wall.width as number) - 300) <= TOL, "external wall thickness (0.3 m → 300 mm)");
  assert.ok(Math.abs((wall.height as number) - 3000) <= TOL, "external wall height");
  const space = [...byId.values()].find((p) => p.type === "bim.space")!;
  assert.equal(space.name, "Living Room");
  assert.ok(Math.abs((space.area as number) - 36_190_000) <= 1000, "external space area (36.19 m²)");
  // the declared story-height fallback is RECORDED, never silent
  const storyEl = result.report.elements.find((e) => e.ifcClass === "IfcBuildingStorey")!;
  const heightField = storyEl.fields.find((f) => f.field === "height")!;
  assert.equal(heightField.classification, "lossy", "story height fell back — declared, recorded");
  // the door defaults are DECLARED lossy (no params pset in the external file)
  const door = result.report.elements.find((e) => e.ifcClass === "IfcDoor")!;
  const swing = door.fields.find((f) => f.field === "swing")!;
  assert.equal(swing.classification, "lossy", "door swing default declared lossy, never silent");
});

// --- typed failures ---------------------------------------------------------------

test("ifc.* fails typed ifc_unavailable when the host binds no interop adapter", async () => {
  const h = AppApiHandler.create({
    adapterBundle: DummyAdapterBundle,
    entityId: "ifc-noadapter",
    format: "offisos-dummy",
    formatVersion: "1",
    createdBy: "ifc-test",
  });
  await cmd(h, "document.create", { entityId: "x" });
  const r1 = await cmd(h, "ifc.export", {});
  assert.equal(r1.ok, false);
  assert.equal((r1 as { code: string }).code, "ifc_unavailable");
  const r2 = await cmd(h, "ifc.import", { ifc: "aGVsbG8=" });
  assert.equal((r2 as { code: string }).code, "ifc_unavailable");
});

test("ifc.import rejects garbage payloads typed (ifc_invalid)", { skip: skipIfc }, async () => {
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-bad" });
  const r = await cmd(h, "ifc.import", { ifc: Buffer.from("this is not an ifc file").toString("base64") });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "ifc_invalid");
  const r2 = await cmd(h, "ifc.import", {});
  assert.equal((r2 as { code: string }).code, "bad_payload");
});

test("ifc.import fails typed ifc_unsupported for unsupported source units", { skip: skipIfc }, async () => {
  const { ifc } = await seeded();
  // synthetic external file: swap the length unit to an unsupported one
  const text = Buffer.from(ifc, "base64").toString("utf8");
  const mutated = text.replace(/\.METRE\./, ".ANGSTROM.");
  assert.notEqual(mutated, text, "fixture mutated");
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-units" });
  const r = await cmd(h, "ifc.import", { ifc: Buffer.from(mutated).toString("base64") });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "ifc_unsupported");
  assert.match((r as { message: string }).message, /unsupported length unit/i);
});

// --- probe ---------------------------------------------------------------------

test("ifc.probe reports the real toolchain availability and version", { skip: skipIfc }, async () => {
  const h = handler();
  const probe = val<{ available: boolean; engineVersion: string | null }>(await qq(h, "ifc.probe", {}));
  assert.equal(probe.available, true);
  assert.equal(probe.engineVersion, "0.8.5");
});
