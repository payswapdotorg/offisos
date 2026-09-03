// CAD-PARITY-018 / Issue #118 (criterion 14 — the corrective interop
// coverage): Web host specialized-toolsets INTEROP smoke.
//
// Drives the exact App API surface the Architect review 5096872026
// requires evidence for: the IFC/BCF/IDS compatibility of the NEW
// specialized semantics. Through the running dev server:
//
//   - the specialized records (mep run with an in-record connection,
//     mechanical equipment with ports, raster source with lineWork, raster
//     reference with transform+clipping) created through the REAL
//     toolset.* commands;
//   - interop.toolsetsReport — the typed OUTCOME surface (the static
//     concept × surface matrix + the live per-record DRY classification
//     through the REAL carrier codec: exact / lossy / unsupported);
//   - ifc.export carrying the toolsets IfcGroup carrier (deterministic
//     bytes + the additive-optional toolsets counts);
//   - ifc.import into a FRESH document — the records restore byte-exactly
//     with PRESERVED tls- identities (one atomic revision; the import
//     classification report);
//   - the export → import → export byte-identity proof;
//   - the re-import into the SOURCE document (classify-only — the document
//     authority stays);
//   - interop.roundtripReport(format ifc) — the DRY toolsets dimension;
//   - the BCF exchange: references to the toolset-committed canonical
//     elements resolve exactly; a tls- reference declines typed
//     (ifc_invalid "does not exist in the document");
//   - the IDS validation: the two-spec carrier IDS (the identity
//     discipline passes; the domain spec discriminates per record kind)
//     and the element IDS over the toolset-workflow walls;
//   - the typed decline surface (foreign ids, classify-only re-import).
//
// ENGINE BASIS: the pinned fixture is REFERENCE-adapter basis + the IFC
// toolchain bound additively (the P014 reference+ifc binding). Start the
// dev server with OFFISOS_GEOMETRY_ENGINE=reference, OFFISOS_IFC_WORKER
// and OFFISOS_PYTHON (a python with ifcopenshell 0.8.5 + IfcTester 0.8.5).
//
// Reproduce: cd <repo>/apps/web && OFFISOS_GEOMETRY_ENGINE=reference \
//            OFFISOS_IFC_WORKER=<repo>/app/src/adapters/ifc/worker/ifc-worker.py \
//            OFFISOS_PYTHON=<python-with-ifcopenshell> npm run dev -- --webpack -p 3100 &
//            then: node --import tsx apps/web/test/toolsets-interop-p018-smoke.mjs
//            First run: --write-fixture to pin the fixture.
//            Remote deployment: OFFISOS_WEB_URL=https://<host> node --import tsx apps/web/test/toolsets-interop-p018-smoke.mjs
//
// Determinism (the P014/P018 discipline): every pinned value is a pure
// function of the canonical command stream — fixed record data, fixed
// project name, document-minted monotonic tls-/el- identities, and the
// byte-deterministic IFC/BCF writers. Perf budgets are wall-clock
// asserted and NEVER pinned.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-018-toolsets-interop.json");
const IDS_FIRE_RATING_PATH = join(REPO_ROOT, "app", "test", "fixtures", "ids-fire-rating.xml");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

// ifcGuidFor mirrors the wire identity derivation (LOCK-019): BCF/IDS
// speak IfcGuid — the smoke computes the expected guids from the
// canonical ids.
const { ifcGuidFor } = await import(join(REPO_ROOT, "app", "src", "ifc", "identity.ts"));
// canonicalStringify mirrors the app's canonical JSON (sorted keys) — the
// byte-equality comparisons use the canonical form.
const { canonicalStringify } = await import(join(REPO_ROOT, "app", "src", "caddocument", "serialization.ts"));

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

const step = (name) => console.log(`TOOLSETS-INTEROP P018 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const isSha = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const sortedJson = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());

// The two-spec carrier IDS (mirrors app/test/toolsets-p018-interop.test.ts):
// spec 1 — every toolsets carrier group declares its Pset_OffisosIdentity.DomainId
// (the LOCK-019 discipline at the IDS boundary); spec 2 — the per-entity
// domain discrimination (only mep-run records declare Pset_OffisosDocs.Domain).
const IDS_TOOLSETS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
    <info><title>Toolset carrier fields declared</title></info>
    <specifications>
        <specification name="Every toolsets carrier declares its Offisos identity" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
            <applicability minOccurs="1" maxOccurs="unbounded">
                <entity><name><simpleValue>IFCGROUP</simpleValue></name></entity>
            </applicability>
            <requirements>
                <property dataType="IFCLABEL" cardinality="required">
                    <propertySet><simpleValue>Pset_OffisosIdentity</simpleValue></propertySet>
                    <baseName><simpleValue>DomainId</simpleValue></baseName>
                </property>
            </requirements>
        </specification>
        <specification name="Toolset groups must declare the domain" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
            <applicability minOccurs="1" maxOccurs="unbounded">
                <entity><name><simpleValue>IFCGROUP</simpleValue></name></entity>
            </applicability>
            <requirements>
                <property dataType="IFCLABEL" cardinality="required">
                    <propertySet><simpleValue>Pset_OffisosDocs</simpleValue></propertySet>
                    <baseName><simpleValue>Domain</simpleValue></baseName>
                </property>
            </requirements>
        </specification>
    </specifications>
</ids>`;

const BUILDING = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
];

// --- 1. the document + the model (the LEGACY export first) -----------------------

step("document.create + bim.createElements + the LEGACY export (no toolsets key)");
val(await cmd("document.create", { entityId: "cad-parity-018-interop" }));
{
  const seed = val(await cmd("bim.createElements", { entities: BUILDING }));
  assert(
    JSON.stringify(seed.created) === JSON.stringify(["story-gf", "wall-south", "wall-east"]),
    `the seed created the story + two walls (got ${JSON.stringify(seed.created)})`,
  );
}
const t0 = Date.now();
const legacyExport = val(await cmd("ifc.export", { projectName: "Offisos Toolsets Interop Export" }));
const exportLegacyMs = Date.now() - t0;
assert(legacyExport.toolsets === undefined, "no toolsets key before the specialized records (additive-optional)");
assert(isSha(legacyExport.sha256), "the legacy export sha");
const legacyAgain = val(await cmd("ifc.export", { projectName: "Offisos Toolsets Interop Export" }));
assert(legacyAgain.sha256 === legacyExport.sha256, "the legacy export is byte-deterministic");

// --- 2. the specialized-toolsets seed ---------------------------------------------

step("the four specialized records + the in-record connection + the committed trace");
const run = val(await cmd("toolset.mepAddRun", {
  run: {
    domain: "duct",
    shape: "rect",
    nominalSize: 400,
    insulationMm: 25,
    name: "Main Supply A",
    segments: [
      { start: { x: 0, y: 0, z: 3200 }, end: { x: 6000, y: 0, z: 3200 } },
      { start: { x: 6000, y: 0, z: 3200 }, end: { x: 6000, y: 5000, z: 3200 } },
    ],
  },
}));
assert(run.record.id === "tls-000001", `the run id (got ${run.record.id})`);
const equipment = val(await cmd("toolset.mechAddEquipment", {
  equipment: {
    kind: "ahu",
    name: "AHU-01, East",
    origin: { x: 1000, y: 1000, z: 0 },
    rotationDeg: 90.5,
    ports: [
      { id: "p1", kind: "supply", position: { x: 1000, y: 1100, z: 500 }, nominal: 400, domain: "duct" },
      { id: "p2", kind: "power", position: { x: 950, y: 1000, z: 200 } },
    ],
  },
}));
assert(equipment.record.id === "tls-000002", `the equipment id (got ${equipment.record.id})`);
const source = val(await cmd("toolset.rasterAddSource", {
  source: {
    sourceRef: "underlay|floor;1.png",
    contentDigest: "sha256:abc123",
    widthPx: 3840,
    heightPx: 2160,
    lineWork: [{ x1: 10.5, y1: 20.25, x2: 30.125, y2: 40.0625 }],
  },
}));
assert(source.record.id === "tls-000003", `the source id (got ${source.record.id})`);
const reference = val(await cmd("toolset.rasterAttach", {
  reference: {
    sourceRef: "underlay|floor;1.png",
    declaredDigest: "sha256:abc123",
    transform: { origin: { x: 0, y: 0 }, scale: 0.25, rotationDeg: 12.75 },
    clipping: { x: 0, y: 0, w: 3840, h: 2160 },
    visible: true,
  },
}));
assert(reference.record.id === "tls-000004", `the reference id (got ${reference.record.id})`);
const connection = val(await cmd("toolset.mepConnect", {
  runId: "tls-000001",
  at: "start",
  target: { kind: "endpoint", point: { x: 0, y: 0, z: 3200 } },
}));
assert(connection.connection.id === "c1", `the connection id (got ${connection.connection.id})`);
// The committed trace — canonical line elements BCF can reference.
const commit = val(await cmd("toolset.rasterCommitTrace", { referenceId: "tls-000004" }));
assert(commit.created.length === 1, `one committed line element (got ${JSON.stringify(commit.created)})`);
// The corpus this document's records must round-trip to, byte-exactly.
const corpusState = val(await q("document.getState", {}));
assert(corpusState.specialized.length === 4, "the seeded corpus");
// The import creates records in guid order (the parse sorts the IfcGroup
// entities by GlobalId) — the corpus comparison is BY RECORD ID.
const byId = (records) => [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const corpusJson = canonicalStringify(byId(corpusState.specialized));

// --- 3. the typed OUTCOME surface (interop.toolsetsReport) ----------------------

step("interop.toolsetsReport — the typed EXACT/LOSSY/UNSUPPORTED classification");
const toolsetsReport = val(await q("interop.toolsetsReport", {}));
assert(toolsetsReport.contract === "offisos-interop-toolsets/1", "the report contract id");
assert(toolsetsReport.rows.length === 12, `the static matrix rows (got ${toolsetsReport.rows.length})`);
// The explicit typed refusals stand in the matrix.
const matrix = new Map(toolsetsReport.rows.map((row) => [`${row.surface}:${row.concept}`, row.classification]));
assert(matrix.get("ifc:mep-native-distribution-elements") === "unsupported", "the native MEP refusal");
assert(matrix.get("ifc:raster-binary-payload") === "unsupported", "the raster payload refusal");
assert(matrix.get("ifc:derived-specialized-surfaces") === "unsupported", "the derived-surfaces refusal");
assert(matrix.get("bcf:bcf-references-to-specialized-records") === "unsupported", "the BCF record-reference refusal");
assert(matrix.get("ifc:specialized-record-structured-arrays") === "lossy", "the structural lossy row");
assert(matrix.get("ifc:specialized-record-identity") === "exact", "the identity row");
// The live per-record DRY classification.
assert(toolsetsReport.records.length === 4, "the four live record rows");
const runRow = toolsetsReport.records.find((r) => r.id === "tls-000001");
assert(runRow.fields.find((f) => f.field === "Segments").classification === "lossy", "Segments is the structural lossy row");
assert(runRow.fields.find((f) => f.field === "Connections").classification === "lossy", "Connections is the structural lossy row");
assert(runRow.fields.find((f) => f.field === "NominalSize").classification === "exact", "NominalSize is exact");
const sourceRow = toolsetsReport.records.find((r) => r.id === "tls-000003");
assert(sourceRow.fields.find((f) => f.field === "content-payload").classification === "unsupported", "the raster payload refusal row");
assert(isSha(toolsetsReport.reportHash), "the report hash");

// --- 4. the IFC export carrying the toolsets groups ------------------------------

step("ifc.export — the toolsets IfcGroup carrier (deterministic bytes)");
const t1 = Date.now();
const exported = val(await cmd("ifc.export", { projectName: "Offisos Toolsets Interop Export" }));
const exportMs = Date.now() - t1;
assert(exported.toolsets !== undefined, "the toolsets export counts are attached");
assert(JSON.stringify(exported.toolsets) === JSON.stringify({ mepRuns: 1, equipment: 1, rasterSources: 1, rasterReferences: 1 }), `the toolsets counts (got ${JSON.stringify(exported.toolsets)})`);
assert(isSha(exported.sha256), "the export sha");
assert(exported.sha256 !== legacyExport.sha256, "the carrier changes the export bytes");
const exportedAgain = val(await cmd("ifc.export", { projectName: "Offisos Toolsets Interop Export" }));
assert(exportedAgain.sha256 === exported.sha256, "the export is byte-deterministic");

// --- 5. the import into a FRESH document (preserved identities) ------------------

step("ifc.import into a fresh document — byte-exact record restoration");
val(await cmd("document.create", { entityId: "cad-parity-018-imported" }));
const t2 = Date.now();
const imported = val(await cmd("ifc.import", { ifc: exported.ifc }));
const importMs = Date.now() - t2;
assert(imported.toolsets !== undefined, "the toolsets import report is attached");
assert(
  JSON.stringify([...imported.toolsets.created].sort()) === JSON.stringify(["tls-000001", "tls-000002", "tls-000003", "tls-000004"]),
  `the preserved tls- identities (got ${JSON.stringify(imported.toolsets.created)})`,
);
assert(imported.toolsets.report.summary.created === 4, "four creation rows");
assert(imported.toolsets.report.summary.unsupported === 0, "zero unsupported rows");
assert(isSha(imported.toolsets.reportHash), "the import classification hash");
// The records restored byte-exactly (the exactness proof at the live boundary).
const importedState = val(await q("document.getState", {}));
assert(importedState.specialized.length === 4, `four restored records (got ${importedState.specialized.length})`);
assert(
  canonicalStringify(byId(importedState.specialized)) === corpusJson,
  "the restored records are byte-equal to the seeded corpus (per record id)",
);
const importedRecordsSha = sha(canonicalStringify(byId(importedState.specialized)));

// --- 6. the export → import → export byte-identity -------------------------------

step("export → import → export is byte-identical");
const reexported = val(await cmd("ifc.export", { projectName: "Offisos Toolsets Interop Export" }));
assert(reexported.sha256 === exported.sha256, "the carrier round-trips to byte-identical export");

// --- 7. the classify-only re-import (the document authority stays) ---------------

step("re-import into the imported document classifies only");
const reimported = val(await cmd("ifc.import", { ifc: exported.ifc }));
assert(reimported.toolsets !== undefined, "the toolsets re-import report");
assert(JSON.stringify(reimported.toolsets.created) === "[]", "zero creation drafts (classify-only)");
assert(reimported.toolsets.report.summary.unchanged === 4, "four unchanged rows");
assert(reimported.toolsets.report.summary.lossy === 0, "zero loss (identical state)");

// --- 8. the round-trip report DRY dimension ---------------------------------------

step("interop.roundtripReport(format ifc) — the DRY toolsets dimension");
const roundtrip = val(await q("interop.roundtripReport", { format: "ifc" }));
assert(roundtrip.toolsets !== undefined, "the toolsets DRY dimension");
assert(roundtrip.toolsets.records.length === 4, "four DRY rows");
assert(roundtrip.toolsets.summary.unchanged === 4, "the DRY loop classifies the same state unchanged");
assert(roundtrip.toolsets.summary.lossy === 0, "the DRY loop is zero-loss by design");

// --- 9. the BCF exchange + the IDS validation (on the imported document) ----------

step("BCF references the re-committed canonical elements; tls- declines typed");
// The committed trace elements did NOT ride the IFC (the derived trace
// vectors are the typed refusal — they are recomputable, never stored);
// re-commit the restored reference's trace in the imported document.
const commit2 = val(await cmd("toolset.rasterCommitTrace", { referenceId: "tls-000004" }));
assert(commit2.created.length === 1, "the re-committed line element");
const bcf = val(await cmd("ifc.bcfCreate", {
  topics: [{ title: "Committed trace review", description: "the committed raster trace", elementIds: [commit2.created[0], "wall-south"] }],
}));
assert(bcf.size > 0, "the BCF container");
const bcfParsed = val(await q("ifc.bcfParse", { bcf: bcf.bcf }));
assert(
  JSON.stringify([...bcfParsed.topics[0].resolvedCanonicalIds].sort()) === JSON.stringify([...[commit2.created[0], "wall-south"]].sort()),
  `the references resolve to the canonical ids (got ${JSON.stringify(bcfParsed.topics[0].resolvedCanonicalIds)})`,
);
// A tls- record id is NOT an element: the typed decline.
const tlsDecline = errOf(await cmd("ifc.bcfCreate", {
  topics: [{ title: "Bad ref", description: "d", elementIds: ["tls-000001"] }],
}));
assert(tlsDecline.code === "ifc_invalid" && /does not exist in the document/.test(tlsDecline.message), `the tls- decline (got ${tlsDecline.code}: ${tlsDecline.message})`);

step("IDS over the toolsets carrier groups + the workflow walls");
// (a) the carrier specs: the identity discipline passes; the domain spec
//     discriminates (only the mep run declares Domain).
const carrierIds = val(await q("ifc.idsValidate", { ids: IDS_TOOLSETS_XML }));
const carrierIdentity = carrierIds.specs.find((s) => s.name.includes("Offisos identity"));
const carrierDomain = carrierIds.specs.find((s) => s.name.includes("declare the domain"));
assert(carrierIdentity.status === "pass", `the carrier identity spec (got ${carrierIdentity.status})`);
assert(carrierIdentity.entities.length === 4, "the four carrier groups are applicable");
assert(carrierDomain.status === "fail", `the carrier domain spec discriminates (got ${carrierDomain.status})`);
assert(carrierDomain.entities.filter((e) => e.passed).length === 1, "only the mep run declares Domain");
assert(carrierDomain.entities.find((e) => e.passed).globalId === ifcGuidFor("tls-000001"), "the passing entity is the run's carrier guid");
// (b) the element IDS over the workflow walls (the fire-rating fixture):
//     without the property all walls fail; with it, the spec passes.
const idsXml = readFileSync(IDS_FIRE_RATING_PATH, "utf8");
const before = val(await q("ifc.idsValidate", { ids: idsXml }));
assert(before.specs[0].status === "fail", "the walls fail without FireRating");
val(await cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "wall-south", patch: { FireRating: "REI60" } } }));
val(await cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "wall-east", patch: { FireRating: "REI30" } } }));
const after = val(await q("ifc.idsValidate", { ids: idsXml }));
assert(after.specs[0].status === "pass", "the walls pass with FireRating");

// --- 10. perf budgets (asserted, never pinned) --------------------------------------

const PERF_BUDGETS_MS = { export: 4000, import: 6000, report: 2000 };
assert(exportMs <= PERF_BUDGETS_MS.export, `export within budget (${exportMs}ms)`);
assert(importMs <= PERF_BUDGETS_MS.import, `import within budget (${importMs}ms)`);

// --- the fixture ---------------------------------------------------------------------

const fixture = {
  legacyExportSha256: legacyExport.sha256,
  legacyExportSize: legacyExport.size,
  ifcExportSha256: exported.sha256,
  ifcExportSize: exported.size,
  toolsetsExportCounts: exported.toolsets,
  toolsetsInteropReportHash: toolsetsReport.reportHash,
  toolsetsInteropSummary: toolsetsReport.summary,
  toolsetsInteropCounts: toolsetsReport.counts,
  importToolsetsReportHash: imported.toolsets.reportHash,
  importCreatedIds: imported.toolsets.created,
  importRecordsSha256: importedRecordsSha,
  reexportSha256: reexported.sha256,
  reimportClassifySummary: reimported.toolsets.report.summary,
  roundtripToolsetsSummary: roundtrip.toolsets.summary,
  bcfSourceRevision: bcfParsed.topics[0].sourceRevision,
  bcfResolvedCanonicalIds: bcfParsed.topics[0].resolvedCanonicalIds,
  carrierIdsStatuses: [carrierIdentity.status, carrierDomain.status],
  carrierIdsPassingGuids: carrierDomain.entities.filter((e) => e.passed).map((e) => e.globalId),
  elementIdsStatuses: [before.specs[0].status, after.specs[0].status],
  tlsDeclineCode: tlsDecline.code,
  commandStream: executed,
};

if (WRITE_FIXTURE) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`TOOLSETS-INTEROP P018 SMOKE: fixture written (${FIXTURE_PATH})`);
} else {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`fixture missing: ${FIXTURE_PATH} (run once with --write-fixture)`);
  }
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  for (const [key, pinnedValue] of Object.entries(pinned)) {
    const actualValue = fixture[key];
    const actualJson = sortedJson(actualValue);
    const pinnedJson = sortedJson(pinnedValue);
    if (actualJson !== pinnedJson) {
      throw new Error(`FIXTURE MISMATCH at '${key}':\n  pinned: ${pinnedJson}\n  actual: ${actualJson}`);
    }
  }
  console.log(`TOOLSETS-INTEROP P018 SMOKE: fixture match (${Object.keys(pinned).length} fields)`);
}

console.log(`TOOLSETS-INTEROP P018 SMOKE: PASS (${executed.length} commands, ${exportMs}ms export, ${importMs}ms import)`);
