/**
 * CAD-PARITY-018 (Issue #118, acceptance criterion 14 — the corrective
 * interop coverage): the specialized-toolsets IFC/BCF/IDS compatibility
 * suite.
 *
 * The Architect review (PR #120, review 5096872026) requires DETERMINISTIC
 * interop coverage for the representable P018 specialized semantics and
 * EXPLICIT typed LOSSY/UNSUPPORTED outcomes for the non-representable
 * ones. This suite is that coverage:
 *
 *  - the CARRIER (ifc/toolsetmap.ts): the pure codec — determinism, the
 *    byte-exact encode→decode round-trip of every record kind (including
 *    separator-bearing names and exact float coordinates), the DRY
 *    classification, the classify-only existing match (the document
 *    authority stays), the documented LOSSY row on a changed field, the
 *    typed UNSUPPORTED rows on malformed carrier data, identity
 *    preservation vs minting;
 *  - the OUTCOME SURFACE (interop/toolsets.ts + interop.toolsetsReport):
 *    the static concept × surface matrix (the closed EXACT/LOSSY/
 *    UNSUPPORTED table incl. the explicit refusals) and the live per-record
 *    DRY classification through the REAL codec;
 *  - the LIVE BOUNDARY (engine-gated, real IfcOpenShell): ifc.export
 *    carries the toolsets groups (additive-optional: legacy documents
 *    export byte-identically without them), the full round-trip preserves
 *    the records byte-exactly with preserved tls- identities and ONE
 *    atomic undo, export→import→export is byte-identical, the re-import
 *    into the source document classifies only, interop.roundtripReport
 *    covers the toolsets dimension DRY, IDS validates the toolset-workflow
 *    elements AND the carrier group psets (pass + fail discrimination),
 *    BCF references toolset-committed canonical elements exactly while
 *    tls- references decline typed and resolve to an honest null;
 *  - HOST PARITY (engine-gated): the Web and Electron hosts converge on
 *    the toolsets interop surfaces (the report hash, the export bytes, the
 *    import classification).
 *
 * Determinism discipline: every pinned value in this suite is a pure
 * function of canonical state (no wall-clock, no random, no environment).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AppApiHandler } from "../src/app-api/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type { SpecializedRecord } from "../src/contracts/caddocument.js";
import { ifcGuidFor } from "../src/ifc/identity.js";
import {
  buildIfcToolsetsExport,
  reconcileIfcToolsets,
  type IfcToolsetsReconcileOutcome,
} from "../src/ifc/toolsetmap.js";
import {
  buildToolsetsInteropReport,
  INTEROP_TOOLSETS_CONTRACT,
  TOOLSETS_INTEROP_ROWS,
} from "../src/interop/toolsets.js";
import { canonicalStringify } from "../src/caddocument/serialization.js";
import { ifcSkip } from "./ifc-availability.js";

const skipIfc = await ifcSkip();
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const IDS_XML = readFileSync(`${FIXTURES}/ids-fire-rating.xml`, "utf8");

/** IDS specs over the toolsets CARRIER (IfcGroup + psets): the
 *  representable-toolsets IDS coverage — the carrier entities are
 *  first-class validatable IFC entities. Two specs: the identity spec
 *  (every carrier group must declare its Pset_OffisosIdentity.DomainId —
 *  the LOCK-019 discipline at the IDS boundary) and the domain spec (the
 *  per-entity discrimination: only mep-run records declare Domain). */
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

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "toolsets-interop",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "toolsets-interop",
};

function handler(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

function ifcHandler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "toolsets-interop-ifc",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "toolsets-interop-ifc",
  });
}

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
  return r as { code: string; message: string };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

const BUILDING = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
];

/** The four-kind specialized corpus (deliberately separator-bearing names
 *  and exact float coordinates — the codec's hard cases). */
async function seedToolsets(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "toolsets-interop" });
  await cmd(h, "bim.createElements", { entities: BUILDING });
  await cmd(h, "toolset.mepAddRun", {
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
  });
  await cmd(h, "toolset.mechAddEquipment", {
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
  });
  await cmd(h, "toolset.rasterAddSource", {
    source: {
      sourceRef: "underlay|floor;1.png",
      contentDigest: "sha256:abc123",
      widthPx: 3840,
      heightPx: 2160,
      lineWork: [{ x1: 10.5, y1: 20.25, x2: 30.125, y2: 40.0625 }],
    },
  });
  await cmd(h, "toolset.rasterAttach", {
    reference: {
      sourceRef: "underlay|floor;1.png",
      declaredDigest: "sha256:abc123",
      transform: { origin: { x: 0, y: 0 }, scale: 0.25, rotationDeg: 12.75 },
      clipping: { x: 0, y: 0, w: 3840, h: 2160 },
      visible: true,
    },
  });
  // An in-record connection (the encoded structural array hard case).
  await cmd(h, "toolset.mepConnect", { runId: "tls-000001", at: "start", target: { kind: "endpoint", point: { x: 0, y: 0, z: 3200 } } });
}

async function recordsOf(h: AppApiHandler): Promise<SpecializedRecord[]> {
  const state = val<{ specialized?: SpecializedRecord[] }>(await qq(h, "document.getState"));
  return state.specialized ?? [];
}

type EncodedGroup = ReturnType<typeof buildIfcToolsetsExport>["groups"][number];
function parsedOf(groups: readonly EncodedGroup[]): unknown {
  return groups.map((g) => ({ globalId: g.guid, name: g.name, identity: g.identity, fields: g.fields }));
}

// ---------------------------------------------------------------------------
// The pure carrier codec (engine-free).
// ---------------------------------------------------------------------------

test("toolsets-interop: the carrier encodes the four kinds deterministically with locked guids", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  const first = buildIfcToolsetsExport(records);
  const second = buildIfcToolsetsExport(records);
  assert.deepEqual(first, second, "repeated builds over equal inputs are byte-equal");
  assert.deepEqual(first.counts, { mepRuns: 1, equipment: 1, rasterSources: 1, rasterReferences: 1 });
  assert.equal(first.groups.length, 4);
  // The locked caller guid discipline: guid = ifcGuidFor(canonical id).
  for (const group of first.groups) {
    assert.equal(group.guid, ifcGuidFor(group.identity.DomainId));
    assert.match(group.identity.DomainKind, /^toolsets\.(mep\.run|mech\.equipment|raster\.source|raster\.reference)$/);
  }
  // The fixed kind-group order: mep run → equipment → source → reference.
  assert.deepEqual(
    first.groups.map((g) => g.identity.DomainKind),
    ["toolsets.mep.run", "toolsets.mech.equipment", "toolsets.raster.source", "toolsets.raster.reference"],
  );
});

test("toolsets-interop: the codec round-trips every kind byte-exactly (values EXACT)", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  // Exercise the optional layer dimension of the reference record too (the
  // drafting-layer id is a document value; the codec question is whether
  // the string survives the carrier — it does, byte-exactly).
  const withLayer = records.map((r) =>
    r.kind === "raster.reference" && r.id === "tls-000004" ? { ...r, data: { ...r.data, layer: "RASTER,UNDERLAY" } } : r,
  ) as SpecializedRecord[];
  const export1 = buildIfcToolsetsExport(withLayer);
  // Parse-shape → reconcile with a mint → the decoded records must be
  // byte-equal to the originals (the value-exactness proof).
  const outcome = reconcileIfcToolsets(parsedOf(export1.groups) as never, [], { specialized: () => "tls-999999" });
  assert.equal(outcome.records.length, 4);
  for (let i = 0; i < records.length; i += 1) {
    assert.equal(
      canonicalStringify(outcome.records[i]),
      canonicalStringify(withLayer[i]),
      `record ${withLayer[i]!.id} round-trips byte-exactly`,
    );
  }
  // Separator-bearing names survive the escaped joined-string codec.
  const equipmentRecord = outcome.records.find((r) => r.id === "tls-000002")!;
  assert.equal(equipmentRecord.kind, "mech.equipment");
  if (equipmentRecord.kind === "mech.equipment") {
    assert.equal(equipmentRecord.data.name, "AHU-01, East");
  }
  const sourceRecord = outcome.records.find((r) => r.id === "tls-000003")!;
  if (sourceRecord.kind === "raster.source") {
    assert.equal(sourceRecord.data.sourceRef, "underlay|floor;1.png");
  }
});

test("toolsets-interop: the DRY reconcile classifies the carried fields exact with zero creations", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  const export1 = buildIfcToolsetsExport(records);
  const dry: IfcToolsetsReconcileOutcome = reconcileIfcToolsets(parsedOf(export1.groups) as never, [], null);
  assert.equal(dry.records.length, 0, "the DRY loop never creates");
  assert.equal(dry.report.records.length, 4);
  assert.deepEqual(dry.report.summary, {
    created: 4, reconciled: 0, unchanged: 0, unsupported: 0,
    exact: 30, tolerance: 0, lossy: 0, unsupportedFields: 0,
  });
  // Deterministic report hash.
  const dry2 = reconcileIfcToolsets(parsedOf(export1.groups) as never, [], null);
  assert.equal(dry.reportHash, dry2.reportHash);
});

test("toolsets-interop: the existing match classifies only — the document authority stays", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  const export1 = buildIfcToolsetsExport(records);
  // Reconcile the encoded groups against THE SAME records (unchanged).
  const outcome = reconcileIfcToolsets(parsedOf(export1.groups) as never, records, { specialized: () => "tls-999999" });
  assert.equal(outcome.records.length, 0, "an existing match NEVER becomes a creation draft");
  assert.ok(outcome.report.records.every((row) => row.action === "unchanged"));
  assert.equal(outcome.report.summary.unchanged, 4);
  assert.equal(outcome.report.summary.lossy, 0, "identical records classify all-exact");
});

test("toolsets-interop: a changed field classifies LOSSY at the boundary (the documented lossy row)", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  // Mutate the run's nominal size (the source of truth changes AFTER export).
  const mutated = records.map((r) =>
    r.kind === "mep.run" && r.id === "tls-000001" ? { ...r, data: { ...r.data, nominalSize: 500 } } : r,
  );
  const export1 = buildIfcToolsetsExport(mutated);
  const outcome = reconcileIfcToolsets(parsedOf(export1.groups) as never, records, null);
  const runRow = outcome.report.records.find((row) => row.canonicalId === "tls-000001");
  assert.ok(runRow !== undefined);
  assert.equal(runRow.action, "reconciled");
  const nominal = runRow.fields.find((f) => f.field === "NominalSize");
  assert.ok(nominal !== undefined);
  assert.equal(nominal.classification, "lossy");
  assert.equal(nominal.expected, "400", "expected = the document authority (400)");
  assert.equal(nominal.actual, "500", "actual = the source file (500)");
});

test("toolsets-interop: malformed carrier data is a typed UNSUPPORTED row (never silent)", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  const export1 = buildIfcToolsetsExport(records);
  const parsed = parsedOf(export1.groups) as { globalId: string; name: string; identity: Record<string, unknown>; fields: Record<string, unknown> }[];
  // (a) Segments with the wrong part count.
  const brokenSegments = structuredClone(parsed);
  brokenSegments[0]!.fields["Segments"] = "0,0,3200";
  let outcome = reconcileIfcToolsets(brokenSegments, [], { specialized: () => "tls-999999" });
  assert.equal(outcome.report.records[0]!.action, "unsupported");
  assert.match(outcome.report.records[0]!.fields[0]!.note!, /expected 'start\|end'/);
  // (b) A non-finite encoded number.
  const brokenNumber = structuredClone(parsed);
  brokenNumber[0]!.fields["NominalSize"] = "not-a-number";
  outcome = reconcileIfcToolsets(brokenNumber, [], { specialized: () => "tls-999999" });
  assert.equal(outcome.report.records[0]!.action, "unsupported");
  assert.match(outcome.report.records[0]!.fields[0]!.note!, /NominalSize/);
  // (c) A wrong-vocabulary domain (the grammar validator catches it).
  const brokenDomain = structuredClone(parsed);
  brokenDomain[0]!.fields["Domain"] = "pneumatic";
  outcome = reconcileIfcToolsets(brokenDomain, [], { specialized: () => "tls-999999" });
  assert.equal(outcome.report.records[0]!.action, "unsupported");
  // (d) The typed boolean dimension.
  const brokenBool = structuredClone(parsed);
  if (brokenBool[3]!.fields["Visible"] !== undefined) {
    brokenBool[3]!.fields["Visible"] = "yes";
    outcome = reconcileIfcToolsets(brokenBool, [], { specialized: () => "tls-999999" });
    assert.equal(outcome.report.records[3]!.action, "unsupported");
  }
  // Only the malformed record is refused; the three VALID records create
  // (a malformed row never blocks the batch — it declines typed, alone).
  assert.equal(outcome.records.length, 3);
});

test("toolsets-interop: foreign DomainKind and missing identity are typed UNSUPPORTED rows", async () => {
  const parsed = [
    { globalId: "0AAAAAAAAAAAAAAAAAAAA", name: "x", identity: { DomainId: "x-1", DomainKind: "toolsets.bogus" }, fields: {} },
    { globalId: "0AAAAAAAAAAAAAAAAAAAB", name: "y", identity: null, fields: {} },
  ];
  const outcome = reconcileIfcToolsets(parsed, [], { specialized: () => "tls-999999" });
  assert.ok(outcome.report.records.every((row) => row.action === "unsupported"));
  assert.equal(outcome.report.records[0]!.fields[0]!.classification, "unsupported");
  assert.match(outcome.report.records[0]!.fields[0]!.note!, /outside the toolsets exchange vocabulary/);
  assert.equal(outcome.report.records[1]!.fields[0]!.classification, "unsupported");
  assert.match(outcome.report.records[1]!.fields[0]!.note!, /no Offisos identity/);
});

test("toolsets-interop: creation preserves well-formed declared ids and mints malformed ones", async () => {
  const h = handler();
  await seedToolsets(h);
  const records = await recordsOf(h);
  const export1 = buildIfcToolsetsExport(records);
  const parsed = structuredClone(parsedOf(export1.groups)) as { globalId: string; name: string; identity: Record<string, unknown>; fields: Record<string, unknown> }[];
  // A well-formed foreign DomainId is PRESERVED (LOCK-019: the canonical
  // identity is authoritative, the file only declares it).
  parsed[0]!.identity["DomainId"] = "ext-01";
  // A malformed (too long) DomainId is MINTED.
  parsed[1]!.identity["DomainId"] = "a-very-long-foreign-id-exceeding-the-bound";
  const outcome = reconcileIfcToolsets(parsed, [], { specialized: () => "tls-999999" });
  assert.deepEqual(
    outcome.records.map((r) => r.id).sort(),
    ["ext-01", "tls-000003", "tls-000004", "tls-999999"],
  );
});

// ---------------------------------------------------------------------------
// The typed outcome surface (interop.toolsetsReport).
// ---------------------------------------------------------------------------

test("toolsets-interop: the static matrix is closed and typed (the explicit LOSSY/UNSUPPORTED refusals)", async () => {
  // The durable concept × surface classification — exactly the 12 rows.
  assert.equal(TOOLSETS_INTEROP_ROWS.length, 12);
  const map = new Map(TOOLSETS_INTEROP_ROWS.map((row) => [`${row.surface}:${row.concept}`, row.classification]));
  // The EXACT representable semantics.
  assert.equal(map.get("ifc:specialized-record-identity"), "exact");
  assert.equal(map.get("ifc:specialized-record-scalar-properties"), "exact");
  assert.equal(map.get("bcf:bcf-references-to-canonical-elements"), "exact");
  assert.equal(map.get("bcf:bcf-viewpoints-on-toolset-workflows"), "exact");
  assert.equal(map.get("ids:ids-validation-over-toolset-elements"), "exact");
  assert.equal(map.get("ids:ids-validation-over-toolsets-carrier"), "exact");
  // The LOSSY structural boundary.
  assert.equal(map.get("ifc:specialized-record-structured-arrays"), "lossy");
  // The typed UNSUPPORTED refusals (never fabricated, never silent).
  assert.equal(map.get("ifc:mep-native-distribution-elements"), "unsupported");
  assert.equal(map.get("ifc:mechanical-native-equipment-classes"), "unsupported");
  assert.equal(map.get("ifc:raster-binary-payload"), "unsupported");
  assert.equal(map.get("ifc:derived-specialized-surfaces"), "unsupported");
  assert.equal(map.get("bcf:bcf-references-to-specialized-records"), "unsupported");
  // Every row carries a durable note.
  assert.ok(TOOLSETS_INTEROP_ROWS.every((row) => row.note.length > 40));
});

test("toolsets-interop: the live report classifies the document's records (exact / lossy / unsupported)", async () => {
  const h = handler();
  await seedToolsets(h);
  const report = val<Awaited<ReturnType<typeof buildToolsetsInteropReport>>>(
    await qq(h, "interop.toolsetsReport", {}),
  );
  assert.equal(report.contract, INTEROP_TOOLSETS_CONTRACT);
  assert.deepEqual(report.counts, { records: 4, mepRuns: 1, equipment: 1, rasterSources: 1, rasterReferences: 1 });
  assert.equal(report.records.length, 4);
  // The run: scalar fields EXACT, the Segments/Connections arrays LOSSY
  // (values exact, structure flattened).
  const run = report.records.find((r) => r.id === "tls-000001")!;
  assert.equal(run.fields.find((f) => f.field === "Domain")!.classification, "exact");
  assert.equal(run.fields.find((f) => f.field === "NominalSize")!.classification, "exact");
  assert.equal(run.fields.find((f) => f.field === "Segments")!.classification, "lossy");
  assert.equal(run.fields.find((f) => f.field === "Connections")!.classification, "lossy");
  // The equipment ports array.
  const equipment = report.records.find((r) => r.id === "tls-000002")!;
  assert.equal(equipment.fields.find((f) => f.field === "Ports")!.classification, "lossy");
  assert.equal(equipment.fields.find((f) => f.field === "RotationDeg")!.classification, "exact");
  // The raster source: lineWork LOSSY + the binary payload REFUSAL.
  const source = report.records.find((r) => r.id === "tls-000003")!;
  assert.equal(source.fields.find((f) => f.field === "LineWork")!.classification, "lossy");
  const refusal = source.fields.find((f) => f.field === "content-payload")!;
  assert.equal(refusal.classification, "unsupported");
  assert.match(refusal.note!, /never fabricated/);
  // The reference: all flat scalars exact (the transform + clipping).
  const reference = report.records.find((r) => r.id === "tls-000004")!;
  assert.ok(reference.fields.every((f) => f.classification === "exact"));
  // The live summary: 26 exact fields, 4 lossy structural arrays,
  // 1 unsupported payload refusal.
  assert.deepEqual(report.summary, { exact: 26, lossy: 4, unsupported: 1 });
  // Determinism: the report hash is stable across calls.
  const again = val<Awaited<ReturnType<typeof buildToolsetsInteropReport>>>(
    await qq(h, "interop.toolsetsReport", {}),
  );
  assert.equal(report.reportHash, again.reportHash);
});

test("toolsets-interop: the report surface is honest on an empty document", async () => {
  const h = handler();
  await cmd(h, "document.create", { entityId: "empty" });
  const report = val<Awaited<ReturnType<typeof buildToolsetsInteropReport>>>(
    await qq(h, "interop.toolsetsReport", {}),
  );
  assert.deepEqual(report.counts, { records: 0, mepRuns: 0, equipment: 0, rasterSources: 0, rasterReferences: 0 });
  assert.deepEqual(report.records, []);
  assert.deepEqual(report.summary, { exact: 0, lossy: 0, unsupported: 0 });
  // The static matrix is ALWAYS present (the durable refusals stand even
  // when the document carries no records).
  assert.equal(report.rows.length, 12);
  assert.match(report.reportHash, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// The live boundary (real IfcOpenShell; skipped when the worker is absent).
// ---------------------------------------------------------------------------

test("toolsets-interop: ifc.export carries the toolsets groups deterministically (additive-optional)", { skip: skipIfc }, async () => {
  // A legacy document (no specialized records) exports WITHOUT the
  // toolsets key — the byte-identity invariant.
  const legacy = ifcHandler();
  await cmd(legacy, "document.create", { entityId: "legacy" });
  await cmd(legacy, "bim.createElements", { entities: BUILDING });
  const legacyExport = val<{ ifc: string; sha256: string; toolsets?: unknown }>(await cmd(legacy, "ifc.export", {}));
  assert.equal(legacyExport.toolsets, undefined, "no toolsets key without specialized records");

  // The same element model WITH the specialized records: the key appears,
  // the bytes change, the export stays deterministic.
  const h = ifcHandler();
  await seedToolsets(h);
  const first = val<{ ifc: string; sha256: string; size: number; toolsets?: { mepRuns: number; equipment: number; rasterSources: number; rasterReferences: number } }>(
    await cmd(h, "ifc.export", {}),
  );
  assert.deepEqual(first.toolsets, { mepRuns: 1, equipment: 1, rasterSources: 1, rasterReferences: 1 });
  assert.notEqual(first.sha256, legacyExport.sha256, "the carrier changes the export bytes");
  const second = val<{ sha256: string }>(await cmd(h, "ifc.export", {}));
  assert.equal(first.sha256, second.sha256, "the export is byte-deterministic");
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
});

test("toolsets-interop: the live round-trip preserves the records byte-exactly with preserved identities and ONE atomic undo", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  const original = await recordsOf(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));

  // Import into a FRESH document.
  const fresh = ifcHandler();
  await cmd(fresh, "document.create", { entityId: "imported" });
  const imported = val<{
    created: string[];
    toolsets?: { report: { records: { canonicalId: string | null; action: string }[] }; reportHash: string; created: string[] };
  }>(await cmd(fresh, "ifc.import", { ifc: exported.ifc }));
  // The canonical elements came along.
  assert.deepEqual(imported.created.sort(), ["story-gf", "wall-east", "wall-south"].sort());
  // The toolsets records: 4 creations, PRESERVED tls- identities.
  assert.ok(imported.toolsets !== undefined);
  assert.deepEqual(imported.toolsets.created.sort(), ["tls-000001", "tls-000002", "tls-000003", "tls-000004"].sort());
  assert.equal(imported.toolsets.report.records.length, 4);
  assert.ok(imported.toolsets.report.records.every((row) => row.action === "created"));
  // The records are byte-equal to the originals (the exactness proof).
  const roundTripped = await recordsOf(fresh);
  assert.equal(roundTripped.length, 4);
  for (const record of original) {
    const restored = roundTripped.find((r) => r.id === record.id);
    assert.ok(restored !== undefined, `record ${record.id} restored`);
    assert.equal(canonicalStringify(restored), canonicalStringify(record), `record ${record.id} byte-equal`);
  }
  // ONE atomic revision: undo removes the records AND the elements.
  await cmd(fresh, "document.undo", {});
  assert.deepEqual(await recordsOf(fresh), []);
  const listed = val<{ records: unknown[] }>(await qq(fresh, "toolset.listRecords"));
  assert.equal(listed.records.length, 0);
  // The import classification is deterministic.
  const fresh2 = ifcHandler();
  await cmd(fresh2, "document.create", { entityId: "imported-2" });
  const imported2 = val<{ toolsets?: { reportHash: string } }>(await cmd(fresh2, "ifc.import", { ifc: exported.ifc }));
  assert.equal(imported.toolsets!.reportHash, imported2.toolsets!.reportHash);
});

test("toolsets-interop: export → import → export is byte-identical", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  const exported = val<{ ifc: string; sha256: string }>(await cmd(h, "ifc.export", {}));
  const fresh = ifcHandler();
  await cmd(fresh, "document.create", { entityId: "reexport" });
  await cmd(fresh, "ifc.import", { ifc: exported.ifc });
  const reexported = val<{ sha256: string }>(await cmd(fresh, "ifc.export", {}));
  assert.equal(exported.sha256, reexported.sha256, "the toolsets carrier round-trips to byte-identical export");
});

test("toolsets-interop: re-import into the source document classifies only (zero creations)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  const before = (await recordsOf(h)).length;
  const reimported = val<{ toolsets?: { created: string[]; report: { summary: { unchanged: number; created: number; reconciled: number; lossy: number } } } }>(
    await cmd(h, "ifc.import", { ifc: exported.ifc }),
  );
  assert.ok(reimported.toolsets !== undefined);
  assert.deepEqual(reimported.toolsets.created, [], "the document authority stays — no creation drafts");
  assert.equal(reimported.toolsets.report.summary.unchanged, 4);
  assert.equal(reimported.toolsets.report.summary.reconciled, 0);
  assert.equal(reimported.toolsets.report.summary.lossy, 0);
  assert.equal((await recordsOf(h)).length, before);
});

test("toolsets-interop: a changed record classifies LOSSY at the LIVE boundary", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  // Change the run's nominal size AFTER the export (the source of truth).
  const exported = val<{ ifc: string }>(await cmd(h, "ifc.export", {}));
  await cmd(h, "toolset.mepSetRun", {
    id: "tls-000001",
    run: {
      domain: "duct",
      shape: "rect",
      nominalSize: 500,
      insulationMm: 25,
      name: "Main Supply A",
      segments: [
        { start: { x: 0, y: 0, z: 3200 }, end: { x: 6000, y: 0, z: 3200 } },
        { start: { x: 6000, y: 0, z: 3200 }, end: { x: 6000, y: 5000, z: 3200 } },
      ],
    },
  });
  await cmd(h, "toolset.mepConnect", { runId: "tls-000001", at: "start", target: { kind: "endpoint", point: { x: 0, y: 0, z: 3200 } } });
  const reimported = val<{ toolsets?: { report: { records: { canonicalId: string | null; action: string; fields: { field: string; classification: string; expected?: unknown; actual?: unknown }[] }[] } } }>(
    await cmd(h, "ifc.import", { ifc: exported.ifc }),
  );
  const runRow = reimported.toolsets!.report.records.find((row) => row.canonicalId === "tls-000001")!;
  assert.equal(runRow.action, "reconciled");
  const nominal = runRow.fields.find((f) => f.field === "NominalSize")!;
  assert.equal(nominal.classification, "lossy");
  assert.equal(nominal.expected, "500");
  assert.equal(nominal.actual, "400");
});

test("toolsets-interop: interop.roundtripReport covers the toolsets dimension DRY (legacy shape preserved)", { skip: skipIfc }, async () => {
  // A legacy document: the ifc round-trip report has NO toolsets key.
  const legacy = ifcHandler();
  await cmd(legacy, "document.create", { entityId: "legacy" });
  await cmd(legacy, "bim.createElements", { entities: BUILDING });
  const legacyReport = val<{ format: string; toolsets?: unknown; reportHash: string }>(
    await qq(legacy, "interop.roundtripReport", { format: "ifc" }),
  );
  assert.equal(legacyReport.format, "ifc");
  assert.equal(legacyReport.toolsets, undefined, "the legacy round-trip report shape is unchanged");

  // The toolsets document: the DRY toolsets dimension reconciles the
  // exported carrier against the SAME records → all unchanged, zero loss.
  const h = ifcHandler();
  await seedToolsets(h);
  const report = val<{ toolsets?: { records: { canonicalId: string | null; action: string }[]; summary: { created: number; unchanged: number; reconciled: number; lossy: number } }; reportHash: string }>(
    await qq(h, "interop.roundtripReport", { format: "ifc" }),
  );
  assert.ok(report.toolsets !== undefined);
  assert.equal(report.toolsets.records.length, 4);
  assert.ok(report.toolsets.records.every((row) => row.action === "unchanged"), "the DRY loop reconciles against the same document — classify-only");
  assert.equal(report.toolsets.summary.unchanged, 4);
  assert.equal(report.toolsets.summary.reconciled, 0);
  assert.equal(report.toolsets.summary.lossy, 0, "the DRY loop is zero-loss by design");
  // Determinism.
  const again = val<{ reportHash: string }>(await qq(h, "interop.roundtripReport", { format: "ifc" }));
  assert.equal(report.reportHash, again.reportHash);
});

test("toolsets-interop: IDS validates toolset-workflow element properties with canonical provenance", { skip: skipIfc }, async () => {
  // The wallRun-authored walls behave like every canonical wall at the IDS
  // boundary: the spec over Pset_OffisosCustom.FireRating discriminates
  // pass/fail with canonical provenance.
  const h = ifcHandler();
  await seedToolsets(h);
  await cmd(h, "document.applyEdit", { edit: { type: "updateElement", elementId: "wall-south", patch: { FireRating: "REI60" } } });
  const passing = val<{ specs: { name: string; status: string; entities: { canonicalId: string | null; passed: boolean }[] }[] }>(
    await qq(h, "ifc.idsValidate", { ids: IDS_XML }),
  );
  const spec = passing.specs[0]!;
  assert.equal(spec.status, "fail");
  const south = spec.entities.find((e) => e.canonicalId === "wall-south")!;
  assert.equal(south.passed, true);
  const east = spec.entities.find((e) => e.canonicalId === "wall-east")!;
  assert.equal(east.passed, false);
  // The controlled mutation flips the spec.
  await cmd(h, "document.applyEdit", { edit: { type: "updateElement", elementId: "wall-east", patch: { FireRating: "REI30" } } });
  const flipped = val<{ specs: { status: string }[] }>(await qq(h, "ifc.idsValidate", { ids: IDS_XML }));
  assert.equal(flipped.specs[0]!.status, "pass");
});

test("toolsets-interop: IDS validates the toolsets CARRIER group psets (pass + fail discrimination)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  const result = val<{ specs: { name: string; status: string; entities: { globalId: string; canonicalId: string | null; passed: boolean }[] }[] }>(
    await qq(h, "ifc.idsValidate", { ids: IDS_TOOLSETS_XML }),
  );
  // Spec 1 — the identity discipline: EVERY carrier group declares its
  // Pset_OffisosIdentity.DomainId → pass.
  const identity = result.specs.find((sp) => sp.name.includes("Offisos identity"))!;
  assert.equal(identity.status, "pass");
  assert.equal(identity.entities.length, 4, "the four carrier groups are applicable");
  assert.ok(identity.entities.every((e) => e.passed));
  assert.ok(identity.entities.some((e) => e.globalId === ifcGuidFor("tls-000001")));
  // Spec 2 — the per-entity discrimination: only the mep-run record
  // declares Pset_OffisosDocs.Domain → fail with one passing entity.
  const domain = result.specs.find((sp) => sp.name.includes("declare the domain"))!;
  assert.equal(domain.status, "fail");
  assert.equal(domain.entities.length, 4);
  assert.equal(domain.entities.filter((e) => e.passed).length, 1);
  assert.equal(domain.entities.find((e) => e.passed)!.globalId, ifcGuidFor("tls-000001"));
  // Determinism of the IDS surface over the carrier.
  const again = val<{ specs: { name: string; status: string }[] }>(await qq(h, "ifc.idsValidate", { ids: IDS_TOOLSETS_XML }));
  assert.deepEqual(again.specs.map((sp) => sp.status), result.specs.map((sp) => sp.status));
});

test("toolsets-interop: BCF references toolset-committed canonical elements exactly; tls- references decline typed", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  // Commit the raster trace → canonical line elements (the committed
  // geometry BCF can reference).
  const committed = val<{ elements: { id: string }[] } | { created: string[] } | Record<string, unknown>>(
    await cmd(h, "toolset.rasterCommitTrace", { referenceId: "tls-000004" }),
  );
  const committedIds = "elements" in (committed as Record<string, unknown>)
    ? ((committed as { elements: { id: string }[] }).elements.map((e) => e.id))
    : ((committed as { created: string[] }).created);
  assert.equal(committedIds.length, 1, "one line element per traced vector");
  // A topic referencing the committed element + a wallRun wall resolves
  // exactly through the real BCF container.
  const created = val<{ bcf: string; size: number }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{ title: "Committed trace", description: "d", elementIds: [committedIds[0]!, "wall-south"] }],
  }));
  const parsed = val<{ topics: { resolvedCanonicalIds: (string | null)[] }[] }>(
    await qq(h, "ifc.bcfParse", { bcf: created.bcf }),
  );
  assert.deepEqual(parsed.topics[0]!.resolvedCanonicalIds.sort(), [committedIds[0]!, "wall-south"].sort());
  // A tls- record id is NOT an element: the typed decline at create.
  const declined = errVal(await cmd(h, "ifc.bcfCreate", {
    topics: [{ title: "Bad ref", description: "d", elementIds: ["tls-000001"] }],
  }));
  assert.equal(declined.code, "ifc_invalid");
  assert.match(declined.message, /does not exist in the document/);
});

test("toolsets-interop: BCF resolves a foreign tls- guid to an honest null (records are not products)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await seedToolsets(h);
  // Build a topic through the adapter whose references carry the tls-
  // record's guid — the record EXISTS in the document, but BCF references
  // products: the parse must resolve an explicit null, never a guess.
  const adapter = createIfcInteropAdapter();
  const built = await adapter.buildBcf([
    {
      title: "Record ref",
      description: "d",
      author: "probe",
      type: "issue",
      status: "open",
      references: [ifcGuidFor("tls-000001")],
      comment: "c",
      commentAuthor: "probe",
    },
  ]);
  const parsed = val<{ topics: { resolvedCanonicalIds: (string | null)[] }[] }>(
    await qq(h, "ifc.bcfParse", { bcf: built.bcf }),
  );
  assert.deepEqual(parsed.topics[0]!.resolvedCanonicalIds, [null], "unresolvable record reference → explicit null");
});

// ---------------------------------------------------------------------------
// Host parity (LOCK-004/017; engine-gated).
// ---------------------------------------------------------------------------

test("toolsets-interop: Web and Electron hosts converge on the toolsets interop surfaces", { skip: skipIfc }, async () => {
  type InteropResults = {
    reportHash: string;
    exportSha256: string;
    importReportHash: string;
  };
  async function runSequence(host: "web" | "electron"): Promise<InteropResults> {
    const bundle = createOcctAdapterBundle({ ifc: createIfcInteropAdapter() });
    const handlerLocal = AppApiHandler.create({
      adapterBundle: bundle,
      entityId: `toolsets-interop-${host}`,
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: `toolsets-interop-${host}`,
    });
    const transport = host === "web"
      ? new WebSocketTransport(handlerLocal)
      : new IpcTransport(handlerLocal);
    const rendererHost = host === "web" ? new WebHost(transport) : new ElectronHost(transport);
    const r = createRenderer(rendererHost);
    await r.execute({ type: "command", name: "document.create" as never, payload: { entityId: `parity-${host}` } });
    await r.execute({ type: "command", name: "bim.createElements" as never, payload: { entities: BUILDING } });
    await r.execute({ type: "command", name: "toolset.mepAddRun" as never, payload: {
      run: { domain: "duct", shape: "rect", nominalSize: 400, segments: [{ start: { x: 0, y: 0, z: 3200 }, end: { x: 6000, y: 0, z: 3200 } }] },
    } });
    await r.execute({ type: "command", name: "toolset.rasterAddSource" as never, payload: {
      source: { sourceRef: "u1", contentDigest: "d1", widthPx: 100, heightPx: 100, lineWork: [{ x1: 0, y1: 0, x2: 10, y2: 0 }] },
    } });
    const report = val<unknown>(await r.query({ type: "query", name: "interop.toolsetsReport" as never, payload: {} }));
    const exported = val<{ ifc: string; sha256: string }>(await r.execute({ type: "command", name: "ifc.export" as never, payload: {} }));
    // Import the exported bytes into a FRESH document through the SAME host.
    await r.execute({ type: "command", name: "document.create" as never, payload: { entityId: `parity-${host}-2` } });
    const imported = val<{ toolsets?: { reportHash: string } }>(await r.execute({ type: "command", name: "ifc.import" as never, payload: { ifc: exported.ifc } }));
    return {
      reportHash: (report as { reportHash: string }).reportHash,
      exportSha256: exported.sha256,
      importReportHash: imported.toolsets!.reportHash,
    };
  }
  const web = await runSequence("web");
  const electron = await runSequence("electron");
  assert.equal(web.reportHash, electron.reportHash, "the toolsets interop report converges");
  assert.equal(web.exportSha256, electron.exportSha256, "the export bytes converge");
  assert.equal(web.importReportHash, electron.importReportHash, "the import classification converges");
});
