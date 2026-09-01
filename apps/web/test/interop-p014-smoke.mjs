// CAD-PARITY-014 / Issue #107: Web host file-interoperability workflow smoke.
//
// Drives the EXACT App API interop surface the Interoperability workbench's
// transport wrappers call (ifc.export/import/bcfCreate/bcfParse/idsValidate,
// dxf.export/import, docs.exportSheet pdf/svg/sheet-ir, interop.exchangeReport/
// archivalList/roundtripReport) plus the documentation-production seed commands
// (docs.createViews/createSheets, layout.create, navigator.createFolder/
// createSubset, layout.update, titleblock.create, revision.add, schedule.create,
// publisher.create) against the running dev server, asserting the typed result
// after every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004); the pinned fixture
// (app/test/fixtures/cad-parity-014-interop.json) is the parity basis.
//
// Covers the CAD-PARITY-014 acceptance surface: the deterministic IFC export
// carrying the documentation relationships through the IfcGroup carrier
// (identity psets + Pset_OffisosDocs), the in-place identity reconciliation
// import (unchanged, created-per-kind 0), the BCF topic exchange with the REAL
// camera viewpoint + the source-lineage document reference, the bounded DXF
// R2000 export/import (geometry kinds only, the BIM kinds skipped+counted),
// the Sheet IR pdf/svg real writers (bytes + sha, deterministic) with the dwg
// typed decline, the archival registry, the interop exchange classification
// report, the round-trip verification loops and the IDS validation with
// canonical-identity-bound per-entity results.
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis + the IFC
// toolchain bound additively (the P014 reference+ifc binding). Start the dev
// server with OFFISOS_GEOMETRY_ENGINE=reference, OFFISOS_IFC_WORKER and
// OFFISOS_PYTHON (a python with ifcopenshell 0.8.5 + IfcTester 0.8.5).
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference \
//            OFFISOS_IFC_WORKER=<repo>/app/src/adapters/ifc/worker/ifc-worker.py \
//            OFFISOS_PYTHON=<python-with-ifcopenshell> npm run dev -- --webpack -p 3100 &
//            then: node --import tsx apps/web/test/interop-p014-smoke.mjs
//            First run: --write-fixture to pin the fixture.
//            Remote deployment: OFFISOS_WEB_URL=https://<host> node --import tsx apps/web/test/interop-p014-smoke.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-014-interop.json");
const IDS_XML_PATH = join(REPO_ROOT, "app", "test", "fixtures", "ids-fire-rating.xml");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

// ifcGuidFor mirrors the wire identity derivation (LOCK-019): BCF/IDS speak
// IfcGuid — the smoke computes the expected guids from the canonical ids.
const { ifcGuidFor } = await import(join(REPO_ROOT, "app", "src", "ifc", "identity.ts"));

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
const q = (name, payload) => {
  executed.push(name);
  return send({ type: "query", name, payload });
};
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};
const errOf = (r) => {
  if (ok(r)) throw new Error(`expected a typed error, got ok: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
};

const step = (name) => console.log(`INTEROP P014 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const isSha = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

// --- 1. the document + the model + the documentation seed -----------------------

step("document.create + bim.createElements seed + drafting entities");
val(
  await cmd("document.create", {
    entityId: "cad-parity-014-interop",
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-014-interop",
  }),
);
{
  // The model seed (the ifc-idsbcf building): one story + three walls, ONE
  // atomic payload = one revision.
  const seed = val(
    await cmd("bim.createElements", {
      entities: [
        { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
        { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
        { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
        { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      ],
    }),
  );
  assert(
    JSON.stringify(seed.created) === JSON.stringify(["story-gf", "wall-south", "wall-east", "wall-north"]),
    `the seed created all four entities (got ${JSON.stringify(seed.created)})`,
  );
  // The drafting entities for the DXF surface (line + circle + arc, the
  // default layer, ONE atomic payload).
  val(
    await cmd("entity.create", {
      entities: [
        { type: "line", layer: "0", x1: 1000, y1: 1000, x2: 4000, y2: 1000 },
        { type: "circle", layer: "0", cx: 2500, cy: 2500, r: 800 },
        { type: "arc", layer: "0", cx: 2500, cy: 2500, r: 600, startAngle: 0, endAngle: 1.5707963267948966 },
      ],
    }),
  );
  let snap = val(await q("document.getState", {}));
  assert(snap.elements.length === 7, `seven elements (story + 3 walls + 3 drafting): got ${snap.elements.length}`);
}

step("the documentation seed (views + sheet + navigator + title block + revision + schedule + publisher set)");
{
  const views = val(
    await cmd("docs.createViews", {
      views: [
        { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
        { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
      ],
    }),
  );
  assert(
    JSON.stringify(views.created) === JSON.stringify(["vw-000001", "vw-000002"]),
    `two views minted (got ${JSON.stringify(views.created)})`,
  );
  const sheets = val(
    await cmd("docs.createSheets", {
      sheets: [{
        title: "Ground Floor",
        titleBlock: { projectName: "P014 Interop", sheetTitle: "Ground Floor", sheetNumber: "A-101" },
        viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }],
      }],
    }),
  );
  assert(JSON.stringify(sheets.created) === JSON.stringify(["sh-000001"]), `one sheet (got ${JSON.stringify(sheets.created)})`);

  const folder = val(await cmd("navigator.createFolder", { name: "Plans", parentId: null }));
  assert(folder.node.id === "nav-000001" && folder.node.kind === "folder", "the Plans folder");
  const subset = val(await cmd("navigator.createSubset", { name: "Structural", parentId: null, prefix: "A", numbering: "none" }));
  assert(subset.node.id === "nav-000002" && subset.node.kind === "subset", "the Structural subset");
  const layout = val(await cmd("layout.create", { name: "Ground Floor" }));
  assert(layout.layoutId === "lo-000001", `the layout id (got ${layout.layoutId})`);
  const assigned = val(await cmd("layout.update", { id: "lo-000001", patch: { subsetId: "nav-000002" } }));
  assert(assigned.layout.id === "lo-000001" && assigned.layout.subsetId === "nav-000002", "the layout filed under the subset");
  const tb = val(
    await cmd("titleblock.create", {
      name: "Std",
      widthMm: 180,
      heightMm: 48,
      rowHeightMm: 12,
      rows: [
        { label: "Project", field: "text", value: "P014 Interop" },
        { label: "Layout", field: "layoutName" },
      ],
    }),
  );
  assert(tb.titleBlock.id === "tb-000001", `the title block id (got ${tb.titleBlock.id})`);
  const placed = val(
    await cmd("layout.update", { id: "lo-000001", patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 20, yMm: 20 } } }),
  );
  assert(placed.layout.titleBlockPlacement.titleBlockId === "tb-000001", "the title block placed");
  const revision = val(await cmd("revision.add", { code: "P01", description: "First issue", issued: false, layoutIds: ["lo-000001"] }));
  assert(revision.revision.id === "rev-000001" && revision.revision.issued === false, "the revision record");
  const schedule = val(
    await cmd("schedule.create", {
      name: "Wall List",
      source: "elements",
      filter: { type: "bim.wall" },
      columns: [
        { key: "id", label: "Id" },
        { key: "name", label: "Name" },
      ],
    }),
  );
  assert(schedule.schedule.id === "sch-000001", `the schedule id (got ${schedule.schedule.id})`);
  const pub = val(
    await cmd("publisher.create", {
      name: "Issue Set",
      items: [{ kind: "layout", id: "lo-000001", format: "pdf" }],
    }),
  );
  assert(pub.publisherSet.id === "pub-000001", `the publisher set id (got ${pub.publisherSet.id})`);

  const snap = val(await q("document.getState", {}));
  assert((snap.docsViews ?? []).length === 2, "two views");
  assert((snap.docsSheets ?? []).length === 1, "one sheet");
  assert((snap.navigatorNodes ?? []).length === 2, "two navigator nodes");
  assert((snap.titleBlocks ?? []).length === 1, "one title block");
  assert((snap.schedules ?? []).length === 1, "one schedule");
  assert((snap.revisions ?? []).length === 1, "one revision");
  assert((snap.publisherSets ?? []).length === 1, "one publisher set");
}

// --- 2. the IFC exchange (the IfcGroup documentation carrier) -------------------

step("ifc.export — deterministic bytes carrying the documentation relationships");
let ifcExport = null;
{
  const e1 = val(await cmd("ifc.export", { projectName: "P014 Interop" }));
  assert(isSha(e1.sha256), "the export sha256");
  assert(e1.size > 1000, "a real IFC payload");
  assert(e1.counts.stories === 1 && e1.counts.walls === 3, `the model counts (got ${JSON.stringify(e1.counts)})`);
  assert(
    e1.documentation !== undefined &&
      e1.documentation.views === 2 && e1.documentation.navigatorNodes === 2 &&
      e1.documentation.layouts === 1 && e1.documentation.titleBlocks === 1 &&
      e1.documentation.schedules === 1 && e1.documentation.revisions === 1 &&
      e1.documentation.publisherSets === 1 && e1.documentation.sheetsNotExported === 1,
    `the documentation carrier counts present (got ${JSON.stringify(e1.documentation)})`,
  );
  const e2 = val(await cmd("ifc.export", { projectName: "P014 Interop" }));
  assert(e1.sha256 === e2.sha256, "double-export is byte-identical (determinism)");
  ifcExport = e1;
}

step("ifc.import — in-place identity reconciliation (unchanged; the documentation carrier matches)");
{
  const before = val(await q("document.getState", {}));
  const beforeVersions = before.modelHistory?.revisions?.length ?? 0;
  const imp = val(await cmd("ifc.import", { ifc: ifcExport.ifc }));
  assert(
    imp.record.summary.created === 0 && imp.record.summary.unchanged === 4,
    `the identity reconciliation: 0 created / 4 unchanged (got ${JSON.stringify(imp.record.summary)})`,
  );
  assert(Array.isArray(imp.created) && imp.created.length === 0, "no elements re-created");
  assert(imp.documentation.created.views === 0, "no views re-created");
  assert(imp.documentation.created.layouts === 0, "no layouts re-created");
  assert(isSha(imp.documentation.reportHash), "the documentation report hash");
  const after = val(await q("document.getState", {}));
  assert(after.elements.length === before.elements.length, "no new elements");
  assert(
    (after.modelHistory?.revisions?.length ?? 0) === beforeVersions + 1,
    "the import is ONE atomic revision (the persisted lineage record)",
  );
}

step("interop.roundtripReport ifc — the round-trip verification loop");
let ifcRoundtrip = null;
{
  const rt = val(await q("interop.roundtripReport", { format: "ifc" }));
  assert(isSha(rt.reportHash), "the report hash");
  assert(rt.sourceSha256.length > 0, "the source sha");
  assert(rt.documentation !== undefined, "the documentation dimension");
  ifcRoundtrip = rt;
}

// --- 3. BCF (viewpoint + source lineage) ----------------------------------------

step("ifc.bcfCreate + ifc.bcfParse — the camera viewpoint + the source lineage");
let bcf = null;
{
  const sourceRevision = `p014-smoke:${ifcExport.sha256.slice(0, 16)}`;
  const created = val(
    await cmd("ifc.bcfCreate", {
      topics: [{
        title: "South wall review",
        description: "Check the opening positions on the south wall.",
        author: "p014-smoke",
        type: "Issue",
        status: "Open",
        elementIds: ["wall-south"],
        viewpoint: {
          cameraViewPoint: [3000, 2500, 5000],
          cameraDirection: [-0.5, -0.4, -1],
          cameraUpVector: [0, 0, 1],
        },
        sourceRevision,
      }],
    }),
  );
  assert(created.size > 500, "a real BCF container");
  assert(created.referencedCanonicalIds === 1, "one canonical reference");
  const created2 = val(
    await cmd("ifc.bcfCreate", {
      topics: [{
        title: "South wall review",
        description: "Check the opening positions on the south wall.",
        author: "p014-smoke",
        type: "Issue",
        status: "Open",
        elementIds: ["wall-south"],
        viewpoint: {
          cameraViewPoint: [3000, 2500, 5000],
          cameraDirection: [-0.5, -0.4, -1],
          cameraUpVector: [0, 0, 1],
        },
        sourceRevision,
      }],
    }),
  );
  assert(created.bcf === created2.bcf, "the BCF container is byte-deterministic");
  const parsed = val(await q("ifc.bcfParse", { bcf: created.bcf }));
  assert(parsed.topics.length === 1, `one topic parsed (got ${parsed.topics.length})`);
  const topic = parsed.topics[0];
  assert(topic.title === "South wall review", "the topic title survives");
  assert(
    JSON.stringify(topic.references) === JSON.stringify([ifcGuidFor("wall-south")]),
    `the IfcGuid reference (got ${JSON.stringify(topic.references)})`,
  );
  assert(
    JSON.stringify(topic.resolvedCanonicalIds) === JSON.stringify(["wall-south"]),
    `the reference resolves back to the canonical id (got ${JSON.stringify(topic.resolvedCanonicalIds)})`,
  );
  assert(topic.viewpoint !== null, "the viewpoint survives");
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert(
    near(topic.viewpoint.cameraViewPoint[0], 3000) && near(topic.viewpoint.cameraViewPoint[1], 2500) &&
      near(topic.viewpoint.cameraViewPoint[2], 5000),
    `the camera position (got ${JSON.stringify(topic.viewpoint.cameraViewPoint)})`,
  );
  assert(
    near(topic.viewpoint.cameraDirection[0], -0.5) && near(topic.viewpoint.cameraDirection[1], -0.4) &&
      near(topic.viewpoint.cameraDirection[2], -1),
    `the camera direction (got ${JSON.stringify(topic.viewpoint.cameraDirection)})`,
  );
  assert(
    near(topic.viewpoint.cameraUpVector[0], 0) && near(topic.viewpoint.cameraUpVector[1], 0) &&
      near(topic.viewpoint.cameraUpVector[2], 1),
    `the camera up vector (got ${JSON.stringify(topic.viewpoint.cameraUpVector)})`,
  );
  assert(topic.sourceRevision === sourceRevision, `the source lineage (got ${JSON.stringify(topic.sourceRevision)})`);
  bcf = { ...created, sha256: sha(Buffer.from(created.bcf, "base64")), sourceRevision, parsedRefs: topic.references };
}

// --- 4. IDS (the structured validation bound to canonical identity) -------------

step("ifc.idsValidate — the per-entity structured results");
let idsOutcome = null;
{
  const idsXml = readFileSync(IDS_XML_PATH, "utf8");
  const result = val(await q("ifc.idsValidate", { ids: idsXml, ifc: ifcExport.ifc }));
  assert(result.specs.length >= 1, "at least one spec");
  const spec = result.specs[0];
  assert(spec.status === "fail", `the fire-rating spec fails on the un-rated walls (got ${spec.status})`);
  const failed = spec.entities.filter((e) => e.passed === false).map((e) => e.globalId);
  assert(
    spec.entities.every((e) => e.canonicalId !== null),
    "every entity row is bound to its canonical provenance (the identity pset)",
  );
  const expected = [ifcGuidFor("wall-south"), ifcGuidFor("wall-east"), ifcGuidFor("wall-north")].sort();
  assert(
    JSON.stringify([...failed].sort()) === JSON.stringify(expected),
    `the failed set is the three walls by their derived guids (got ${JSON.stringify(failed)})`,
  );
  idsOutcome = { specCount: result.specs.length, status: spec.status, failed: failed.length };
}

// --- 5. the bounded DXF exchange -------------------------------------------------

step("dxf.export — the bounded R2000 ASCII writer (deterministic; the BIM kinds skipped)");
let dxfExport = null;
{
  const e1 = val(await q("dxf.export", {}));
  assert(isSha(e1.sha256), "the export sha256");
  assert(e1.counts.exported === 3, `the three drafting entities exported (got ${e1.counts.exported})`);
  assert(e1.counts.skipped > 0, `the non-geometry kinds skipped + counted (got ${e1.counts.skipped})`);
  const e2 = val(await q("dxf.export", {}));
  assert(e1.sha256 === e2.sha256, "double-export is byte-identical (determinism)");
  dxfExport = e1;
}

step("dxf.import — the bounded reader (ONE atomic revision; the entities recreated)");
let dxfImport = null;
{
  const before = val(await q("document.getState", {}));
  const beforeVersions = before.modelHistory?.revisions?.length ?? 0;
  const imp = val(await cmd("dxf.import", { dxf: dxfExport.bytesBase64 }));
  assert(imp.created === 3, `three entities created (got ${imp.created})`);
  assert(isSha(imp.reportHash), "the import report hash");
  const after = val(await q("document.getState", {}));
  assert(after.elements.length === before.elements.length + 3, "the imported drafting entities");
  assert(
    (after.modelHistory?.revisions?.length ?? 0) === beforeVersions + 1,
    "the DXF import is ONE atomic revision",
  );
  dxfImport = imp;
}

step("interop.roundtripReport dxf — the pure round-trip loop");
let dxfRoundtrip = null;
{
  const rt = val(await q("interop.roundtripReport", { format: "dxf" }));
  assert(isSha(rt.reportHash), "the report hash");
  dxfRoundtrip = rt;
}

step("the DWG boundary — the typed decline (never fabricated)");
{
  // A minimal binary DWG magic payload (AC + version digits + NUL).
  const dwgMagic = Buffer.from("AC1015\0\x01\x00", "binary").toString("base64");
  const declined = errOf(await cmd("dxf.import", { dxf: dwgMagic }));
  assert(declined.code === "dwg_unsupported", `the typed DWG decline (got ${declined.code})`);
}

// --- 6. the Sheet IR exports (pdf / svg real writers; dwg decline) ---------------

step("docs.exportSheet — sheet-ir unchanged + the real pdf/svg writers");
let sheetExports = null;
{
  const ir = val(await q("docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  assert(isSha(ir.hash), "the Sheet IR hash");
  const pdf1 = val(await q("docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
  assert(isSha(pdf1.sha256) && pdf1.size > 500, "a real PDF document");
  const pdf2 = val(await q("docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
  assert(pdf1.sha256 === pdf2.sha256, "the PDF writer is deterministic");
  const raw = Buffer.from(pdf1.bytesBase64, "base64").toString("latin1");
  assert(raw.startsWith("%PDF-1.4"), "the PDF header");
  assert(raw.includes("%%EOF"), "the PDF EOF marker");
  assert(pdf1.irHash === ir.hash, "the pdf export is bound to the Sheet IR (irHash)");
  const svg1 = val(await q("docs.exportSheet", { sheetId: "sh-000001", format: "svg" }));
  assert(isSha(svg1.sha256) && svg1.size > 500, "a real SVG document");
  const svg2 = val(await q("docs.exportSheet", { sheetId: "sh-000001", format: "svg" }));
  assert(svg1.sha256 === svg2.sha256, "the SVG writer is deterministic");
  assert(svg1.text.startsWith("<svg") || svg1.text.startsWith("<?xml"), "the SVG document");
  assert(svg1.text.includes("Ground Floor Plan"), "the placed view title in the SVG");
  assert(svg1.irHash === ir.hash, "the svg export is bound to the Sheet IR (irHash)");
  const dwg = errOf(await q("docs.exportSheet", { sheetId: "sh-000001", format: "dwg" }));
  assert(dwg.code === "docs_unsupported", `the typed DWG decline (got ${dwg.code})`);
  sheetExports = { irHash: ir.hash, pdf: pdf1, svg: svg1 };
}

// --- 7. the registries + the exchange classification ------------------------------

step("interop.archivalList + interop.exchangeReport");
let archival = null;
let exchange = null;
{
  const reg = val(await q("interop.archivalList", {}));
  assert(reg.rows !== undefined && reg.rows.length === 7, `the 7-row archival registry (got ${reg.rows?.length})`);
  const dwgRow = reg.rows.find((r) => r.format === "DWG");
  assert(dwgRow !== undefined && dwgRow.legal === "proprietary-declined", "the DWG proprietary-declined row");
  const exchangeRep = val(await q("interop.exchangeReport", {}));
  assert(exchangeRep.classifications !== undefined && exchangeRep.classifications.length >= 10, "the classification rows");
  const docRow = exchangeRep.classifications.find((r) => r.concept === "documentation-metadata");
  assert(docRow !== undefined && docRow.classification === "exact", "the documentation-metadata exact row (the IfcGroup carrier)");
  archival = reg;
  exchange = exchangeRep;
}

// --- 8. the pinned fixture ---------------------------------------------------------

step("fixture");

const sA = val(await cmd("document.save", {}));
const sB = val(await cmd("document.save", {}));
assert(sha(JSON.stringify(sA.bytes)) === sha(JSON.stringify(sB.bytes)), "save must be deterministic");
const snap = val(await q("document.getState", {}));

const fixture = {
  saveSha256: sha(JSON.stringify(sA.bytes)),
  saveSize: sA.bytes.length,
  elements: snap.elements.length,
  viewCount: (snap.docsViews ?? []).length,
  sheetCount: (snap.docsSheets ?? []).length,
  layoutCount: (snap.layouts ?? []).length,
  folderCount: (snap.navigatorNodes ?? []).filter((n) => n.kind === "folder").length,
  subsetCount: (snap.navigatorNodes ?? []).filter((n) => n.kind === "subset").length,
  titleBlockCount: (snap.titleBlocks ?? []).length,
  scheduleCount: (snap.schedules ?? []).length,
  revisionCount: (snap.revisions ?? []).length,
  publisherSetCount: (snap.publisherSets ?? []).length,
  versionCount: snap.modelHistory?.revisions?.length ?? 0,
  ifcExportSha256: ifcExport.sha256,
  ifcExportSize: ifcExport.size,
  ifcExportDocumentationTotal:
    (ifcExport.documentation?.views ?? 0) + (ifcExport.documentation?.layouts ?? 0) +
    (ifcExport.documentation?.navigatorNodes ?? 0) + (ifcExport.documentation?.titleBlocks ?? 0) +
    (ifcExport.documentation?.schedules ?? 0) + (ifcExport.documentation?.revisions ?? 0) +
    (ifcExport.documentation?.publisherSets ?? 0),
  ifcImportSummary: { created: 0, unchanged: 4 },
  ifcRoundtripReportHash: ifcRoundtrip.reportHash,
  ifcRoundtripSourceSha256: ifcRoundtrip.sourceSha256,
  bcfSha256: bcf.sha256,
  bcfSize: bcf.size,
  bcfSourceRevision: bcf.sourceRevision,
  bcfReferences: bcf.parsedRefs,
  idsSpecStatus: idsOutcome.status,
  idsFailedCount: idsOutcome.failed,
  dxfExportSha256: dxfExport.sha256,
  dxfExportSize: dxfExport.size,
  dxfExportedCount: dxfExport.counts.exported,
  dxfSkippedCount: dxfExport.counts.skipped,
  dxfImportCreated: dxfImport.created,
  dxfImportReportHash: dxfImport.reportHash,
  dxfRoundtripReportHash: dxfRoundtrip.reportHash,
  sheetIrHash: sheetExports.irHash,
  sheetPdfSha256: sheetExports.pdf.sha256,
  sheetPdfSize: sheetExports.pdf.size,
  sheetSvgSha256: sheetExports.svg.sha256,
  sheetSvgSize: sheetExports.svg.size,
  archivalListSha256: sha(JSON.stringify(archival)),
  exchangeReportSha256: sha(JSON.stringify(exchange)),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`INTEROP P014 SMOKE: fixture written → ${FIXTURE_PATH}`);
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
  console.log(`INTEROP P014 SMOKE: fixture match (${pinned.saveSha256.slice(0, 8)}…, ${executed.length} app-api calls)`);
}

console.log(`INTEROP P014 SMOKE: PASS (${executed.length} app-api calls)`);
