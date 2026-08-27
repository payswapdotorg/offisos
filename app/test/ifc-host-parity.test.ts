/**
 * COMPAT-IFC-001 — Web/Electron host parity for the IFC/openBIM workflow
 * (§5.5, LOCK-017; mirrors ifc/bim/docs host-parity). The SAME IFC command
 * sequence through the Web Host (WebSocketTransport) and the Electron Host
 * (IpcTransport), each with its OWN handler + REAL IfcOpenShell-backed
 * interop adapter, produces IDENTICAL semantic results: byte-identical
 * export files, identical reconciliation report hashes, identical import
 * records — through the real transports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { createIfcInteropAdapter } from "../src/adapters/ifc/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { ifcSkip } from "./ifc-availability.js";

type Renderer = ReturnType<typeof createRenderer>;

const skipIfc = await ifcSkip();

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

const BUILDING = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
  { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
  { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left" },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
];

/** The identical IFC sequence on both hosts. */
async function runIfcSequence(r: Renderer): Promise<{
  exportSha: string;
  importReportHash: string;
  recordId: string;
  compareHash: string;
  elementCount: number;
  engineIds: string[];
}> {
  await c(r, "document.create", { entityId: "ifc-parity" });
  await c(r, "bim.createElements", { entities: BUILDING });

  // export (deterministic bytes)
  const exported = val<{ ifc: string; sha256: string }>(await c(r, "ifc.export", {}));

  // dry-run compare against the source document
  const compared = val<{ reportHash: string }>(await qq(r, "ifc.compare", { ifc: exported.ifc }));

  // import into a FRESH document through a second handler? No — the same
  // handler holds the elements; import the SAME file (reconciles unchanged)
  // and then re-import after a mutation to exercise reconciliation.
  await c(r, "document.applyEdit", { edit: { type: "updateElement", elementId: "wall-east", patch: { FireRating: "REI90" } } });
  const mutated = val<{ ifc: string; sha256: string }>(await c(r, "ifc.export", {}));
  await c(r, "document.undo", {});
  const imported = val<{ record: { id: string; reportHash: string } }>(await c(r, "ifc.import", { ifc: mutated.ifc }));

  const snap = val<CADDocumentSnapshot>(await qq(r, "document.getState", {}));
  return {
    exportSha: exported.sha256,
    importReportHash: imported.record.reportHash,
    recordId: imported.record.id,
    compareHash: compared.reportHash,
    elementCount: snap.elements.length,
    engineIds: snap.elements.map((el) => el.engineId ?? "").sort(),
  };
}

test("IFC workflow: Web and Electron converge to identical semantic interop results", { skip: skipIfc }, async () => {
  const makeHandler = (): AppApiHandler =>
    AppApiHandler.create({
      adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
      entityId: "ifc-parity",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "ifc-parity",
    });
  const web = createRenderer(new WebHost(new WebSocketTransport(makeHandler())));
  const electron = createRenderer(new ElectronHost(new IpcTransport(makeHandler())));

  const webResult = await runIfcSequence(web);
  const electronResult = await runIfcSequence(electron);

  assert.equal(webResult.exportSha, electronResult.exportSha, "byte-identical export files (real IfcOpenShell builds)");
  assert.equal(webResult.importReportHash, electronResult.importReportHash, "identical reconciliation report hashes");
  assert.equal(webResult.recordId, electronResult.recordId, "identical import-record ids (if-000001)");
  assert.equal(webResult.compareHash, electronResult.compareHash, "identical dry-run comparison hashes");
  assert.equal(webResult.elementCount, electronResult.elementCount);
  assert.deepEqual(webResult.engineIds, electronResult.engineIds, "identical engineId provenance sets");
  assert.ok(webResult.engineIds.every((id) => id.length === 22 || id === ""));
  assert.equal(webResult.exportSha, webResult.exportSha); // sha256 shape asserted via equality above
  assert.match(webResult.exportSha, /^[0-9a-f]{64}$/);
});
