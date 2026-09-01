/**
 * CAD-PARITY-014 (Issue #107) — the archival format registry + the exchange
 * classification + the round-trip verification (D6): interop.archivalList,
 * interop.exchangeReport, interop.roundtripReport.
 *
 * The registry rows carry LEGAL classifications (open-standard / published-
 * spec / proprietary-declined) — every carrier RESOLVES on this surface:
 * the native save, the DXF ASCII writer, the Sheet-IR pdf/svg writers
 * (byte-deterministic with sha256 evidence) and the DWG typed declines
 * (both boundary surfaces); the IFC/BCF carriers resolve through the real
 * toolchain (ifcSkip-gated) or fail typed ifc_unavailable on a dummy host
 * (the honest reason — never a silent skip). The dxf round-trip report is
 * pure TS (deterministic reportHash everywhere); the ifc round-trip report
 * composes export→parse→reconcile DRY through the adapter (gated).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

const skipIfc = await ifcSkip();

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "interop-archival",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "interop-archival-test",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = r as unknown as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

/** A handler with the REAL IFC toolchain (the gated carrier checks). */
function ifcHandler(): AppApiHandler {
  return AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
    entityId: "interop-archival-ifc",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "interop-archival-test",
  });
}

interface ArchivalRow {
  readonly format: string;
  readonly legal: string;
  readonly carrier: string;
  readonly determinism: { readonly sha256Available: boolean };
  readonly bounded: string;
}

/** The dummy-bundle documentation surface: geometry + a view + a sheet (the
 *  save/dxf/pdf/svg carriers all need real content). */
async function seeded(): Promise<AppApiHandler> {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "archival-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });
  await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 50 },
    { type: "circle", layer: "0", cx: 50, cy: 60, r: 12.5 },
  ] });
  await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "Plan", storyId: "story-gf", scale: 50 }] });
  await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "S",
      titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" },
      viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }],
    }],
  });
  return h;
}

// --- the registry -------------------------------------------------------------------

test("interop.archivalList: the registry rows with the legal classifications", async () => {
  const h = await seeded();
  const registry = val<{ contract: string; rows: ArchivalRow[] }>(await qq(h, "interop.archivalList", {}));
  assert.equal(registry.contract, "offisos-interop-archival/1");
  assert.deepEqual(registry.rows.map((row) => [row.format, row.legal]), [
    ["offisos-1 JSON", "open-standard"],
    ["IFC STEP", "open-standard"],
    ["DXF ASCII", "published-spec"],
    ["PDF", "open-standard"],
    ["SVG", "open-standard"],
    ["BCF", "open-standard"],
    ["DWG", "proprietary-declined"],
  ]);
  // Every carrier EXCEPT the proprietary decline offers sha256 evidence.
  for (const row of registry.rows) {
    assert.equal(row.determinism.sha256Available, row.format !== "DWG", `sha256 evidence for ${row.format}`);
    assert.ok(row.carrier.length > 0 && row.bounded.length > 0, `the row is documented: ${row.format}`);
  }
  // The registry is static evidence — two calls identical.
  const again = val<{ rows: ArchivalRow[] }>(await qq(h, "interop.archivalList", {}));
  assert.deepEqual(again.rows, registry.rows);
});

test("every non-IFC carrier RESOLVES on this surface: save/dxf/pdf/svg ok, DWG typed declines", async () => {
  const h = await seeded();
  // offisos-1 JSON — the native deterministic save.
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const saveSha = createHash("sha256").update(Buffer.from(saved.bytes)).digest("hex");
  assert.match(saveSha, /^[0-9a-f]{64}$/);
  const savedAgain = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  assert.equal(createHash("sha256").update(Buffer.from(savedAgain.bytes)).digest("hex"), saveSha, "the native save is deterministic");

  // DXF ASCII — the bounded deterministic writer.
  const dxf = val<{ format: string; sha256: string; counts: { exported: number } }>(await qq(h, "dxf.export", {}));
  assert.equal(dxf.format, "dxf");
  assert.equal(dxf.counts.exported, 2, "the two drafting entities");
  assert.match(dxf.sha256, /^[0-9a-f]{64}$/);

  // PDF + SVG — the Sheet-IR deterministic writers.
  const pdf = val<{ format: string; sha256: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
  assert.equal(pdf.format, "pdf");
  assert.match(pdf.sha256, /^[0-9a-f]{64}$/);
  const svg = val<{ format: string; sha256: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "svg" }));
  assert.equal(svg.format, "svg");
  assert.match(svg.sha256, /^[0-9a-f]{64}$/);

  // DWG — THE proprietary decline, typed on BOTH boundary surfaces (the
  // sheet writer decline + the import reader magic guard).
  const dwgSheet = errVal(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "dwg" }));
  assert.equal(dwgSheet.code, "docs_unsupported");
  assert.match(dwgSheet.message, /proprietary DWG writer boundary/);
  const dwgImport = errVal(await cmd(h, "dxf.import", { dxf: Buffer.from("AC1015\0\0\0", "latin1").toString("base64") }));
  assert.equal(dwgImport.code, "dwg_unsupported");
  assert.match(dwgImport.message, /proprietary DWG binary/);
});

test("the IFC/BCF carriers fail typed ifc_unavailable on a host without the adapter (the honest reason)", async () => {
  const h = await seeded();
  const exportDecline = errVal(await cmd(h, "ifc.export", {}));
  assert.equal(exportDecline.code, "ifc_unavailable");
  assert.match(exportDecline.message, /no IFC interop adapter is bound/);
  const bcfDecline = errVal(await cmd(h, "ifc.bcfCreate", { topics: [{ title: "T", description: "d" }] }));
  assert.equal(bcfDecline.code, "ifc_unavailable");
  const rtDecline = errVal(await qq(h, "interop.roundtripReport", { format: "ifc" }));
  assert.equal(rtDecline.code, "ifc_unavailable");
});

// --- the exchange classification ------------------------------------------------------

test("interop.exchangeReport: the P014 authoritative classification rows + the current counts", async () => {
  const h = await seeded();
  const report = val<{
    contract: string;
    classifications: { concept: string; classification: string; note: string }[];
    counts: Record<string, number>;
  }>(await qq(h, "interop.exchangeReport", {}));
  assert.equal(report.contract, "offisos-interop-exchange/1");
  // The committed rows in fixed order.
  assert.deepEqual(report.classifications.map((c) => [c.concept, c.classification]), [
    ["model-elements", "exact"],
    ["documentation-metadata", "exact"],
    ["saved-view-content", "tolerance"],
    ["sheets", "exact"],
    ["dxf-geometry", "tolerance"],
    ["dwg", "unsupported"],
    ["bcf-references/viewpoints", "tolerance"],
    ["bcf-lineage", "exact"],
    ["ids-validation", "exact"],
    ["archival-formats", "exact"],
  ]);
  for (const row of report.classifications) {
    assert.ok(row.note.length > 20, `the row is documented: ${row.concept}`);
  }
  // The CURRENT document counts (the P013 exchange report discipline).
  assert.deepEqual(report.counts, {
    elements: 5, layers: 1, views: 1, sheets: 1, layouts: 0, titleBlocks: 0,
    schedules: 0, revisions: 0, publisherSets: 0, navigatorNodes: 0,
  });
  // Deterministic: two calls identical.
  const again = val<{ classifications: unknown[]; counts: Record<string, number> }>(await qq(h, "interop.exchangeReport", {}));
  assert.deepEqual(again.counts, report.counts);
  assert.equal(again.classifications.length, report.classifications.length);
});

// --- the round-trip verification -------------------------------------------------------

test("interop.roundtripReport dxf: the DRY verification loop with a deterministic reportHash", async () => {
  const h = await seeded();
  const rt = val<{
    format: string;
    sourceSha256: string;
    reportHash: string;
    report: {
      source: { sha256: string; unit: string; scaleToMm: number; exported: number; skipped: number };
      elements: { canonicalId: string; action: string; fields: { field: string; classification: string }[] }[];
      layers: { matched: number; created: number };
      summary: Record<string, number>;
    };
  }>(await qq(h, "interop.roundtripReport", { format: "dxf" }));
  assert.equal(rt.format, "dxf");
  // The source sha equals the dxf.export bytes sha (the SAME writer input).
  const dxf = val<{ sha256: string }>(await qq(h, "dxf.export", {}));
  assert.equal(rt.sourceSha256, dxf.sha256, "the round-trip source is the dxf.export bytes");
  assert.equal(rt.report.source.sha256, dxf.sha256);
  assert.equal(rt.report.source.unit, "mm");
  assert.equal(rt.report.source.exported, 2);
  // Every exported element re-imported and classified — the fields exact
  // (authored values cross the 6-decimal format exactly).
  assert.equal(rt.report.elements.length, 2);
  for (const row of rt.report.elements) {
    assert.equal(row.action, "unchanged", `${row.canonicalId} round-trips unchanged`);
  }
  // The layer table matched by name (the DXF exchange key).
  assert.equal(rt.report.layers.matched, 1, "the default layer 0 matched");
  // Deterministic reportHash.
  const rt2 = val<{ reportHash: string }>(await qq(h, "interop.roundtripReport", { format: "dxf" }));
  assert.equal(rt2.reportHash, rt.reportHash);
  assert.match(rt.reportHash, /^[0-9a-f]{64}$/);
  // The payload guard.
  const bad = errVal(await qq(h, "interop.roundtripReport", { format: "step" }));
  assert.equal(bad.code, "bad_payload");
});

test("interop.roundtripReport ifc: the composed export→parse→reconcile DRY loop (toolchain)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await cmd(h, "document.create", { entityId: "archival-ifc" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });
  // Documentation records ride the IfcGroup carrier — the report gains the
  // documentation dimension.
  await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "Plan", storyId: "story-gf", scale: 50 }] });

  const rt = val<{
    format: string;
    sourceSha256: string;
    reportHash: string;
    elements: { summary: Record<string, number>; elements: { action: string }[] };
    documentation?: { records: { action: string }[]; summary: Record<string, number> };
  }>(await qq(h, "interop.roundtripReport", { format: "ifc" }));
  assert.equal(rt.format, "ifc");
  // Zero-loss DRY: every element unchanged, the documentation record
  // matched unchanged (the export's own state).
  assert.equal(rt.elements.summary.unchanged, 3);
  assert.equal(rt.elements.summary.lossy, 0);
  assert.equal(rt.elements.summary.created, 0);
  assert.equal(rt.documentation?.records.length, 1);
  assert.equal(rt.documentation?.records[0]!.action, "unchanged");
  assert.equal(rt.documentation?.summary.lossy, 0);
  // The source sha equals the equivalent ifc.export bytes (the same
  // deterministic construction — the round-trip composes the real carriers).
  const exported = val<{ sha256: string }>(await cmd(h, "ifc.export", { projectName: "Offisos Round-trip" }));
  assert.equal(rt.sourceSha256, exported.sha256, "the round-trip source is the ifc.export bytes");
  // Deterministic reportHash.
  const rt2 = val<{ reportHash: string }>(await qq(h, "interop.roundtripReport", { format: "ifc" }));
  assert.equal(rt2.reportHash, rt.reportHash);
  assert.match(rt.reportHash, /^[0-9a-f]{64}$/);
});

test("the IFC/BCF carriers resolve with the real toolchain (the registry rows are honest)", { skip: skipIfc }, async () => {
  const h = ifcHandler();
  await cmd(h, "document.create", { entityId: "archival-ifc-carrier" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  });
  // IFC STEP — byte-deterministic with the sha256 evidence.
  const exported = val<{ sha256: string; size: number }>(await cmd(h, "ifc.export", {}));
  assert.match(exported.sha256, /^[0-9a-f]{64}$/);
  assert.ok(exported.size > 1000);
  // BCF — the coordination channel builds a real container.
  const bcf = val<{ bcf: string; size: number }>(await cmd(h, "ifc.bcfCreate", {
    topics: [{ title: "T", description: "d", elementIds: ["wall-south"] }],
  }));
  assert.ok(bcf.size > 500);
  assert.match(
    createHash("sha256").update(Buffer.from(bcf.bcf, "base64")).digest("hex"),
    /^[0-9a-f]{64}$/,
  );
});
