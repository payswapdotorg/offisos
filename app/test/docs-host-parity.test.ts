/**
 * COMPAT-CAD-003 — Web/Electron host parity for the construction-
 * documentation workflow (§5.5, LOCK-017; mirrors bim-host-parity).
 *
 * The SAME documentation command sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * identical semantic results: view content hashes, sheet export IR hashes,
 * parity content hash and revision lineage. Each host drives its OWN
 * handler + bundle instance through its REAL transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "docs-parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

/** The identical documentation sequence on both hosts. */
async function runDocsSequence(r: Renderer): Promise<{
  contentHash: string;
  versionId: string;
  viewHashes: (string | null)[];
  exportHash: string;
  annotations: { measured: number | undefined; label: string | undefined }[];
  historyLength: number;
}> {
  await c(r, "document.create", { entityId: "docs-parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
    ],
  });
  await c(r, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf" },
      { kind: "elevation", title: "Front Elevation", direction: "front" },
      { kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500 },
    ],
  });
  await c(r, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall" },
      { type: "docs.tag", viewId: "vw-000001", targetId: "space-office" },
    ],
  });
  await c(r, "docs.regenerate", {});
  // A model edit + regeneration must flow identically on both hosts.
  await c(r, "bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 });
  await c(r, "docs.regenerate", {});
  await c(r, "docs.createSheets", {
    sheets: [{
      title: "Ground Floor Documentation",
      titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101" },
      viewPlacements: [
        { viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 },
        { viewId: "vw-000002", x: 320, y: 10, w: 300, h: 280 },
      ],
    }],
  });
  await c(r, "document.undo", {});
  await c(r, "document.redo", {});

  const snapEnd = val<CADDocumentSnapshot>(await qq(r, "document.getState", {}));
  const views = val<{ views: { contentHash: string | null }[] }>(await qq(r, "docs.listViews", {}));
  const exportIR = val<{ hash: string }>(await qq(r, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  const geom = val<{ annotations: { measured?: number; label?: string }[] }>(await qq(r, "docs.getViewGeometry", { viewId: "vw-000001" }));
  return {
    contentHash: JSON.stringify(snapEnd.elements) + JSON.stringify(snapEnd.docsViews) + JSON.stringify(snapEnd.docsSheets),
    versionId: snapEnd.version.version_id,
    viewHashes: views.views.map((v) => v.contentHash),
    exportHash: exportIR.hash,
    annotations: geom.annotations.map((a) => ({ measured: (a as { measured?: number }).measured, label: (a as { label?: string }).label })),
    historyLength: snapEnd.modelHistory!.revisions.length,
  };
}

test("documentation workflow: Web and Electron converge to identical semantic drawing results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runDocsSequence(web);
  const electronResult = await runDocsSequence(electron);

  assert.deepEqual(webResult.viewHashes, electronResult.viewHashes, "identical view content hashes");
  assert.equal(webResult.exportHash, electronResult.exportHash, "identical sheet export IR hash");
  assert.equal(webResult.versionId, electronResult.versionId, "identical version lineage");
  assert.equal(webResult.historyLength, electronResult.historyLength);
  assert.deepEqual(webResult.annotations, electronResult.annotations, "identical derived annotation values");
  assert.deepEqual(webResult.annotations, [
    { measured: 5800, label: undefined },
    { measured: undefined, label: "Office 1 (27.00 m²)" },
  ], "the moved wall's dimension refreshed to 5800 on BOTH hosts");
  assert.ok(webResult.viewHashes.every((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)));
});
