/**
 * CAD-PARITY-014 (Issue #107) — Web/Electron host parity for the file
 * interoperability workflow (§5.5, LOCK-017; mirrors ifc/docs host-parity).
 *
 * The SAME interop stream through the Web Host (WebSocketTransport) and the
 * Electron Host (IpcTransport), each with its OWN handler + adapter bundle,
 * produces IDENTICAL results: byte-identical dxf.export/dxf.import artifacts
 * (sha256 + report hashes + the created ids), byte-identical sheet pdf/svg
 * exports, identical interop.exchangeReport/archivalList/roundtripReport
 * payloads — and, when the IFC toolchain is present (ifcSkip-gated), the
 * identical ifc.export bytes, BCF containers and parsed topics. The pure
 * shared core (LOCK-018) plus the deterministic writers make the results
 * host-independent by construction — this pins it through the REAL
 * transports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

const skipIfc = await ifcSkip();

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

/** The identical interop stream on both hosts (the dummy bundle — the pure
 *  shared core): author → dxf.export → sheet pdf/svg → dxf.import (the
 *  versioned command) → re-export → the report queries. */
async function runInteropSequence(r: Renderer): Promise<{
  dxfSha: string;
  dxfSize: number;
  pdfSha: string;
  svgSha: string;
  importReportHash: string;
  importCreated: number;
  importedIds: string[];
  reexportSha: string;
  exchangeCounts: Record<string, number>;
  archivalRows: [string, string][];
  roundtripHash: string;
}> {
  await c(r, "document.create", { entityId: "interop-parity" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  });
  await c(r, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 50 },
    { type: "circle", layer: "0", cx: 50, cy: 60, r: 12.5 },
    { type: "arc", layer: "0", cx: 0, cy: 0, r: 40, startAngle: 0, endAngle: Math.PI / 2 },
  ] });
  await c(r, "docs.createViews", { views: [{ kind: "plan", title: "Plan", storyId: "story-gf", scale: 50 }] });
  await c(r, "docs.createSheets", {
    sheets: [{
      title: "S",
      titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" },
      viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }],
    }],
  });

  // dxf.export — the bounded deterministic writer.
  const dxf = val<{ sha256: string; size: number; bytesBase64: string; counts: { exported: number } }>(
    await qq(r, "dxf.export", {}),
  );

  // The sheet writers (pdf bytes + svg text).
  const pdf = val<{ sha256: string }>(await qq(r, "docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
  const svg = val<{ sha256: string }>(await qq(r, "docs.exportSheet", { sheetId: "sh-000001", format: "svg" }));

  // dxf.import — ONE versioned command; the imported ids are MINTED by the
  // document authority (identical on both hosts).
  const imported = val<{ reportHash: string; created: number; report: { counts: { elements: number } } }>(
    await c(r, "dxf.import", { dxf: dxf.bytesBase64 }),
  );
  const state = val<{ elements: { id: string }[] }>(await qq(r, "document.getState", {}));
  const importedIds = state.elements.filter((el) => el.id.startsWith("el-")).map((el) => el.id);

  // The re-export after the import (the closed loop — byte-identical by the
  // writer discipline: the imported values re-export as the same bytes).
  const reexported = val<{ sha256: string }>(await qq(r, "dxf.export", {}));

  // The report queries.
  const exchange = val<{ counts: Record<string, number> }>(await qq(r, "interop.exchangeReport", {}));
  const archival = val<{ rows: { format: string; legal: string }[] }>(await qq(r, "interop.archivalList", {}));
  const roundtrip = val<{ reportHash: string }>(await qq(r, "interop.roundtripReport", { format: "dxf" }));

  return {
    dxfSha: dxf.sha256,
    dxfSize: dxf.size,
    pdfSha: pdf.sha256,
    svgSha: svg.sha256,
    importReportHash: imported.reportHash,
    importCreated: imported.created,
    importedIds,
    reexportSha: reexported.sha256,
    exchangeCounts: exchange.counts,
    archivalRows: archival.rows.map((row) => [row.format, row.legal] as [string, string]),
    roundtripHash: roundtrip.reportHash,
  };
}

test("interop workflow: Web and Electron converge to identical DXF/sheet/report results", async () => {
  const makeHandler = (): AppApiHandler =>
    AppApiHandler.create({
      adapterBundle: DummyAdapterBundle,
      entityId: "interop-parity",
      format: "offisos-dummy",
      formatVersion: "1",
      createdBy: "interop-parity",
    });
  const web = createRenderer(new WebHost(new WebSocketTransport(makeHandler())));
  const electron = createRenderer(new ElectronHost(new IpcTransport(makeHandler())));

  const webResult = await runInteropSequence(web);
  const electronResult = await runInteropSequence(electron);

  assert.equal(webResult.dxfSha, electronResult.dxfSha, "byte-identical dxf.export bytes (the pure writer)");
  assert.equal(webResult.dxfSize, electronResult.dxfSize);
  assert.equal(webResult.pdfSha, electronResult.pdfSha, "byte-identical sheet PDF bytes");
  assert.equal(webResult.svgSha, electronResult.svgSha, "byte-identical sheet SVG bytes");
  assert.equal(webResult.importReportHash, electronResult.importReportHash, "identical dxf.import report hashes");
  assert.equal(webResult.importCreated, electronResult.importCreated, "identical created counts");
  assert.deepEqual(webResult.importedIds, electronResult.importedIds, "identical MINTED element ids (the document authority)");
  // The re-export after the import (the document now holds the original +
  // the imported entities — deterministic, host-independent).
  assert.equal(webResult.reexportSha, electronResult.reexportSha, "byte-identical re-exports after the import");
  assert.deepEqual(webResult.exchangeCounts, electronResult.exchangeCounts, "identical exchange report counts");
  assert.deepEqual(webResult.archivalRows, electronResult.archivalRows, "identical archival registry rows");
  assert.equal(webResult.roundtripHash, electronResult.roundtripHash, "identical round-trip report hashes");
  assert.match(webResult.dxfSha, /^[0-9a-f]{64}$/);
  assert.ok(webResult.importCreated > 0, "the import created the drafting entities");
});

/** The identical IFC interop stream on both hosts (the REAL toolchain). */
async function runIfcInteropSequence(r: Renderer): Promise<{
  exportSha: string;
  bcfSha: string;
  parsedTopics: unknown;
  roundtripHash: string;
}> {
  await c(r, "document.create", { entityId: "interop-parity-ifc" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });
  // ifc.export — byte-deterministic through the pinned worker.
  const exported = val<{ sha256: string }>(await c(r, "ifc.export", {}));
  // BCF with the viewpoint + lineage (D3) — the deterministic container.
  const bcf = val<{ bcf: string }>(await c(r, "ifc.bcfCreate", {
    topics: [{
      title: "Parity topic",
      description: "d",
      elementIds: ["wall-south"],
      viewpoint: { cameraViewPoint: [10, 20, 30], cameraDirection: [0, 0, -1], cameraUpVector: [0, 1, 0] },
      sourceRevision: "parity-rev-1",
    }],
  }));
  const parsed = val<{ topics: unknown[] }>(await qq(r, "ifc.bcfParse", { bcf: bcf.bcf }));
  const roundtrip = val<{ reportHash: string }>(await qq(r, "interop.roundtripReport", { format: "ifc" }));
  return {
    exportSha: exported.sha256,
    bcfSha: createHash("sha256").update(Buffer.from(bcf.bcf, "base64")).digest("hex"),
    parsedTopics: parsed.topics,
    roundtripHash: roundtrip.reportHash,
  };
}

test("IFC interop workflow: Web and Electron converge to identical export/BCF/report results", { skip: skipIfc }, async () => {
  const makeHandler = (): AppApiHandler =>
    AppApiHandler.create({
      adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
      entityId: "interop-parity-ifc",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "interop-parity",
    });
  const web = createRenderer(new WebHost(new WebSocketTransport(makeHandler())));
  const electron = createRenderer(new ElectronHost(new IpcTransport(makeHandler())));

  const webResult = await runIfcInteropSequence(web);
  const electronResult = await runIfcInteropSequence(electron);

  assert.equal(webResult.exportSha, electronResult.exportSha, "byte-identical ifc.export files (real IfcOpenShell builds)");
  assert.equal(webResult.bcfSha, electronResult.bcfSha, "byte-identical BCF containers (the fixed-date zip rebuild)");
  assert.deepEqual(webResult.parsedTopics, electronResult.parsedTopics, "identical parsed BCF topics (camera + lineage + refs)");
  assert.equal(webResult.roundtripHash, electronResult.roundtripHash, "identical ifc round-trip report hashes");
  assert.match(webResult.exportSha, /^[0-9a-f]{64}$/);
});
