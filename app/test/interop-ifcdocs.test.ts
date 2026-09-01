/**
 * CAD-PARITY-014 (Issue #107) — the IFC documentation exchange carrier (D2):
 * the P013 documentation tables round-trip through IfcGroup entities.
 *
 * The full acceptance chain: export with documentation tables (the counts +
 * byte-determinism), export → parse → the documentation records back,
 * reconcile into a FRESH document (minted ids — a foreign file never
 * dictates canonical identity — linkage resolved through the DomainId map,
 * the per-record classification report with exact rows and the documented
 * lossy rows), the identity match into the SAME document (unchanged), and
 * the LEGACY byte-identity guarantee: a model WITHOUT documentation tables
 * exports the byte-identical pre-P014 file (the pinned sha — the no-export-
 * regression proof).
 *
 * Runs on the REAL IfcOpenShell toolchain (ifcSkip-gated, the
 * ifc-roundtrip.test.ts convention).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { ifcGuidFor } from "../src/ifc/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

const skipIfc = await ifcSkip();

function handler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "interop-ifcdocs",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "ifcdocs-test",
  });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
  return (r as OkResult).value as T;
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

/** The ifc-roundtrip.test.ts representative building (the legacy model for
 *  the pinned-sha regression proof). */
const LEGACY_BUILDING = [
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

/** The pinned sha256 of the legacy (no documentation tables) export — the
 *  exact construction of ifc-roundtrip.test.ts's seeded() model, exported
 *  once on the pinned toolchain (IfcOpenShell 0.8.5) and hard-coded. Any
 *  change to the export bytes of the legacy path is a P014 REGRESSION (the
 *  documentation carrier must be strictly additive: absent tables → no
 *  IfcGroup entities → byte-identical output). */
// CAD-PARITY-014 (Issue #107): the pinned sha AFTER the cross-CPU determinism
// fix in the worker (the r9 trig rounding — numpy's SIMD-dispatched ufunc
// inner loops differ in the last bits across CPU families, which made the
// pre-P014 export bytes CPU-dependent; the pinned pre-fix value 933fcbd8…
// reproduced only on some runners). c85e518a… is the CPU-independent value.
const LEGACY_EXPORT_SHA256 = "c85e518a3695711f5081375798779db092e4b72ad4a47bdc97c8cb6099e05baf";

/** The documented documentation surface (the P013 vocabularies, one record
 *  per table + the linkage fields): views (plan + detail-of-plan), a
 *  navigator tree (folder + child + subset), a layout (subset + title block
 *  + revisions), a title block, a schedule, a revision and a publisher set;
 *  ONE sheet stays OUT of IFC by design (the Sheet IR is its carrier). */
async function seedDocumented(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "ifcdocs-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });
  // Views: a plan (story-scoped) + a detail of the plan (the sourceViewId
  // linkage) — the detail crop rides in the region + detailScale fields.
  await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "detail", title: "Wall Detail 1", sourceViewId: "vw-000001", region: { x: 0, y: -300, w: 1500, h: 600 }, detailScale: 2 },
    ],
  });
  // The navigator tree: folder + child folder + subset (the subset grammar).
  val(await cmd(h, "navigator.createFolder", { name: "Plans" })); // nav-000001
  val(await cmd(h, "navigator.createFolder", { name: "Details", parentId: "nav-000001" })); // nav-000002
  val(await cmd(h, "navigator.createSubset", { name: "Structural", prefix: "A", numbering: "custom", customNumber: "01" })); // nav-000003
  // The plan files into the Plans folder; the detail into the child folder.
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: "nav-000001" } }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000002", patch: { folderId: "nav-000002" } }));
  // The layout book: one layout in the subset with a placed title block +
  //  one standalone layout (the publisher items exercise both kinds without
  //  the overlap gate — a subset expands to its layouts).
  val(await cmd(h, "layout.create", { name: "Sheet Layout" })); // lo-000001
  val(await cmd(h, "layout.create", { name: "Standalone" })); // lo-000002
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: "nav-000003" } }));
  val(await cmd(h, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 72, rowHeightMm: 12,
    rows: [{ label: "Sheet", field: "sheetNumber" }, { label: "Layout", field: "layoutName" }],
  })); // tb-000001
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 10, yMm: 10 } } }));
  // The schedule (the elements source + a story filter).
  val(await cmd(h, "schedule.create", {
    name: "Wall Schedule", source: "elements", filter: { storyId: "story-gf" },
    columns: [{ key: "id", label: "Id" }, { key: "material", label: "Material" }],
  })); // sch-000001
  // The revision, linked to the layout.
  val(await cmd(h, "revision.add", { code: "P01", description: "First issue" })); // rev-000001
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { revisionIds: ["rev-000001"] } }));
  // The publisher set (subset + layout items).
  val(await cmd(h, "publisher.create", {
    name: "Issue set",
    items: [
      { kind: "subset", id: "nav-000003", format: "pdf" },
      { kind: "layout", id: "lo-000002", format: "svg" },
    ],
  })); // pub-000001
  // ONE sheet — counted as NOT exported (the bounded decision: sheets stay
  // out of IFC; the Sheet IR + pdf/svg writers are their carrier).
  val(await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "S",
      titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" },
      viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }],
    }],
  }));
}

interface DocCounts {
  readonly views: number;
  readonly layouts: number;
  readonly navigatorNodes: number;
  readonly titleBlocks: number;
  readonly schedules: number;
  readonly revisions: number;
  readonly publisherSets: number;
  readonly sheetsNotExported: number;
}

interface ImportDocsResult {
  readonly documentation: {
    readonly report: {
      readonly summary: Record<string, number>;
      readonly records: { name: string; action: string; ifcClass: string; fields: { field: string; classification: string }[] }[];
    };
    readonly reportHash: string;
    readonly created: Record<string, number>;
  };
}

interface ViewRecord { id: string; kind: string; title: string; storyId?: string; folderId?: string; scale?: number; sourceViewId?: string; region?: { x: number; y: number; w: number; h: number }; detailScale?: number }
interface NavRecord { id: string; kind: string; name: string; parentId: string | null; order: number; prefix?: string; numbering?: string; customNumber?: string }
interface LayoutRecord2 { id: string; name: string; subsetId?: string; revisionIds?: string[]; titleBlockPlacement?: { titleBlockId: string; xMm: number; yMm: number } }
interface TbRecord { id: string; name: string; widthMm: number; heightMm: number; rowHeightMm: number; rows: { label: string; field: string; value?: string }[] }
interface SchRecord { id: string; name: string; source: string; columns: { key: string; label: string }[]; filter?: { storyId?: string } }
interface RevRecord { id: string; code: string; description?: string; issued: boolean; createdAt: string; layoutIds: string[] }
interface PubRecord { id: string; name: string; items: { kind: string; id: string; format: string }[] }

interface SnapshotTables {
  readonly docsViews?: ViewRecord[];
  readonly layouts?: LayoutRecord2[];
  readonly navigatorNodes?: NavRecord[];
  readonly titleBlocks?: TbRecord[];
  readonly schedules?: SchRecord[];
  readonly revisions?: RevRecord[];
  readonly publisherSets?: PubRecord[];
}

async function tables(h: AppApiHandler): Promise<SnapshotTables> {
  return val<SnapshotTables>(await qq(h, "document.getState", {}));
}

// --- export with documentation ----------------------------------------------------

test("ifc.export with documentation tables reports the carrier counts and stays byte-deterministic", { skip: skipIfc }, async () => {
  const h = handler();
  await seedDocumented(h);
  const exported = val<{ sha256: string; size: number; documentation?: DocCounts }>(await cmd(h, "ifc.export", {}));
  // The counts: one IfcGroup per table record; the sheet is counted as NOT
  // exported (the bounded decision).
  assert.deepEqual(exported.documentation, {
    views: 2, layouts: 2, navigatorNodes: 3, titleBlocks: 1, schedules: 1,
    revisions: 1, publisherSets: 1, sheetsNotExported: 1,
  });
  const again = val<{ sha256: string; documentation?: DocCounts }>(await cmd(h, "ifc.export", {}));
  assert.equal(again.sha256, exported.sha256, "two exports → byte-identical (documentation groups are deterministic STEP entities)");
  assert.ok(exported.size > 1000);
});

test("the exported file carries the IfcGroup entities with identity + docs psets", { skip: skipIfc }, async () => {
  const h = handler();
  await seedDocumented(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const text = Buffer.from(exported.ifc, "base64").toString("utf8");
  // One IfcGroup per record: the guids derive deterministically from the
  // canonical record ids (the locked-caller-guid discipline).
  const guids = ["vw-000001", "vw-000002", "lo-000001", "lo-000002", "nav-000001", "nav-000002", "nav-000003", "tb-000001", "sch-000001", "rev-000001", "pub-000001"]
    .map((id) => ifcGuidFor(id));
  for (const guid of guids) {
    assert.ok(text.includes(guid), `the IfcGroup guid ${guid} is in the STEP file`);
  }
  assert.ok(text.includes("IFCGROUP"), "the IfcGroup entity class");
  assert.ok(text.includes("Pset_OffisosDocs"), "the docs pset");
  assert.ok(text.includes("Pset_OffisosIdentity"), "the identity pset");
  // A field value rides as a pset property.
  assert.ok(text.includes("'Ground Floor Plan'"), "the view title property value");
});

// --- the fresh reconcile (the acceptance chain) -------------------------------------

test("ifc.import into a FRESH document recreates the tables with MINTED ids + resolved linkage", { skip: skipIfc }, async () => {
  const source = handler();
  await seedDocumented(source);
  const exported = val<{ ifc: string }>(await cmd(source, "ifc.export", {}));

  // A FRESH target holding the SAME BIM elements (the story scope resolves;
  // NO pre-existing documentation records — the minted-id evidence below is
  // unambiguous: the record mints come out GUID-Sorted, NOT in the source's
  // document order, and the linkage fields follow the mint map).
  const target = handler();
  await cmd(target, "document.create", { entityId: "ifcdocs-target" });
  await cmd(target, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });

  const result = val<ImportDocsResult>(await cmd(target, "ifc.import", { ifc: exported.ifc }));
  // The documentation dimension of the import result: the created counts +
  // the classification report (per-record rows).
  assert.deepEqual(result.documentation.created, {
    views: 2, layouts: 2, navigatorNodes: 3, titleBlocks: 1, schedules: 1,
    revisions: 1, publisherSets: 1,
  });
  const summary = result.documentation.report.summary;
  assert.equal(summary.created, 11, "11 documentation records created");
  assert.equal(summary.unchanged, 0);
  assert.equal(summary.reconciled, 0);
  assert.equal(summary.unsupported, 0);
  assert.equal(summary.lossy, 0, "no lossy fields — the metadata round-trips exactly");
  assert.equal(summary.unsupportedFields, 0);
  assert.ok((summary.exact ?? 0) > 0, "the exact field evidence");
  assert.match(result.documentation.reportHash, /^[0-9a-f]{64}$/);

  const snap = await tables(target);
  // The MINTED ids differ from the source's (the parsed records arrive
  // guid-sorted, so the per-kind mints permute): the source's plan
  // (vw-000001) mints vw-000002 and its detail (vw-000002) mints vw-000001 —
  // a foreign file NEVER dictates canonical identity (LOCK-019).
  const views = snap.docsViews ?? [];
  assert.deepEqual(views.map((v) => v.id), ["vw-000002", "vw-000001"], "the ids are minted (permuted), never reused");
  const plan = views.find((v) => v.title === "Ground Floor Plan")!;
  assert.equal(plan.kind, "plan");
  assert.equal(plan.id, "vw-000002");
  assert.equal(plan.storyId, "story-gf", "the story linkage resolved to the TARGET element");
  assert.equal(plan.scale, 50);
  const detail = views.find((v) => v.title === "Wall Detail 1")!;
  assert.equal(detail.id, "vw-000001");
  assert.equal(detail.sourceViewId, "vw-000002", "the detail's sourceView linkage resolved through the mint map");
  assert.deepEqual(detail.region, { x: 0, y: -300, w: 1500, h: 600 });
  assert.equal(detail.detailScale, 2);

  // The navigator tree: parents before children, minted ids, the subset grammar.
  const nodes = snap.navigatorNodes ?? [];
  assert.equal(nodes.length, 3);
  const folder = nodes.find((n) => n.name === "Plans")!;
  assert.equal(folder.kind, "folder");
  assert.equal(folder.parentId, null);
  const child = nodes.find((n) => n.name === "Details")!;
  assert.equal(child.parentId, folder.id, "the child folder's parent linkage resolved through the mint map");
  const subset = nodes.find((n) => n.name === "Structural")!;
  assert.equal(subset.kind, "subset");
  assert.equal(subset.id, "nav-000002", "the subset minted a DIFFERENT id than its source (nav-000003)");
  assert.equal(subset.prefix, "A");
  assert.equal(subset.numbering, "custom");
  assert.equal(subset.customNumber, "01");
  // The views file into the MINTED folder ids (the detail's source folder was
  // nav-000002 — it resolves to the child's minted nav-000003).
  assert.equal(plan.folderId, folder.id);
  assert.equal(detail.folderId, child.id);
  assert.equal(detail.folderId, "nav-000003", "the folder linkage followed the mint map (not the foreign id)");

  // The layout book: the subset layout + the standalone one.
  const layouts = snap.layouts ?? [];
  assert.equal(layouts.length, 2);
  const layout = layouts.find((l) => l.name === "Sheet Layout")!;
  assert.equal(layout.subsetId, subset.id, "the layout's subset linkage resolved (nav-000002, not the foreign nav-000003)");
  const blocks = snap.titleBlocks ?? [];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.name, "Std");
  assert.equal(blocks[0]!.widthMm, 180);
  assert.deepEqual(blocks[0]!.rows, [{ label: "Sheet", field: "sheetNumber" }, { label: "Layout", field: "layoutName" }]);
  assert.deepEqual(layout.titleBlockPlacement, { titleBlockId: blocks[0]!.id, xMm: 10, yMm: 10 });
  const revisions = snap.revisions ?? [];
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.code, "P01");
  assert.equal(revisions[0]!.description, "First issue");
  assert.equal(revisions[0]!.issued, false);
  assert.equal(revisions[0]!.createdAt, "2026-01-01T00:00:00.000Z", "the fixed revision timestamp round-trips");
  assert.deepEqual(layout.revisionIds, [revisions[0]!.id], "the layout's revision linkage resolved");

  // The schedule: columns + the story filter resolved to the target element.
  const schedules = snap.schedules ?? [];
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0]!.name, "Wall Schedule");
  assert.equal(schedules[0]!.source, "elements");
  assert.deepEqual(schedules[0]!.columns.map((c) => [c.key, c.label]), [["id", "Id"], ["material", "Material"]]);
  assert.equal(schedules[0]!.filter?.storyId, "story-gf");

  // The publisher set: items' kind:id:format triplets with the ids resolved
  // through the mint map (the subset item follows the subset's minted id).
  const sets = snap.publisherSets ?? [];
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0]!.items, [
    { kind: "subset", id: subset.id, format: "pdf" },
    { kind: "layout", id: layouts.find((l) => l.name === "Standalone")!.id, format: "svg" },
  ]);
});

test("ifc.import into the SAME document matches the documentation records unchanged (identity)", { skip: skipIfc }, async () => {
  const h = handler();
  await seedDocumented(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const result = val<ImportDocsResult>(await cmd(h, "ifc.import", { ifc: exported.ifc }));
  const summary = result.documentation.report.summary;
  assert.equal(summary.created, 0, "every record matched by identity (DomainId)");
  assert.equal(summary.unchanged, 11, "all 11 records unchanged");
  assert.equal(summary.reconciled, 0);
  assert.equal(summary.lossy, 0);
  const snap = await tables(h);
  assert.equal(snap.docsViews?.length, 2, "no duplicate views");
});

test("a changed field classifies lossy per record (the documented lossy row)", { skip: skipIfc }, async () => {
  const h = handler();
  await seedDocumented(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  // Mutate the source view's title AFTER the export (the file holds the old
  // value) → the imported record classifies the Title field LOSSY (the
  // difference is REPORTED, never silently applied or dropped).
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { title: "Renamed Plan" } }));
  const result = val<ImportDocsResult>(await cmd(h, "ifc.import", { ifc: exported.ifc }));
  const row = result.documentation.report.records.find((r) => r.name === "Ground Floor Plan")!;
  assert.equal(row.action, "reconciled", "the changed record classifies reconciled");
  const titleField = row.fields.find((f) => f.field === "Title")!;
  assert.equal(titleField.classification, "lossy");
  assert.equal(result.documentation.report.summary.reconciled, 1);
  // The document is NOT patched (the bounded decision — the classification
  // reports the difference, the document authority stays the writer).
  const snap = await tables(h);
  assert.equal(snap.docsViews?.find((v) => v.id === "vw-000001")?.title, "Renamed Plan");
});

// --- the legacy byte-identity guarantee ----------------------------------------------

test("the LEGACY model (no documentation tables) exports the CPU-independent pinned bytes (the r9 determinism fix)", { skip: skipIfc }, async () => {
  // The exact ifc-roundtrip.test.ts seeded() construction — no views, no
  // tables, no sheets: the documentation key is absent and the bytes match
  // the pinned pre-P014 sha (the no-export-regression proof).
  const h = handler();
  await cmd(h, "document.create", { entityId: "ifc-building" });
  await cmd(h, "bim.createElements", { entities: LEGACY_BUILDING });
  const exported = val<{ sha256: string; documentation?: DocCounts }>(await cmd(h, "ifc.export", {}));
  assert.equal(exported.documentation, undefined, "the legacy ok value carries NO documentation key");
  assert.equal(
    exported.sha256,
    LEGACY_EXPORT_SHA256,
    "byte-identical to the pinned CPU-independent export (the IfcGroup carrier is strictly additive + the r9 trig fix)",
  );
  // And the re-export after importing the legacy file is byte-stable too
  // (the documented-model identity discipline holds for the legacy path).
  const imported = val<{ report: { summary: Record<string, number> } }>(await cmd(h, "ifc.import", { ifc: val<{ ifc: string }>(await cmd(h, "ifc.export", {})).ifc }));
  assert.equal(imported.report.summary.unchanged, LEGACY_BUILDING.length);
});
