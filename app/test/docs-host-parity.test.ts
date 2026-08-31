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

// --- CAD-PARITY-013 (additive, Issue #104): the documentation production
// stack through BOTH hosts — the navigator tree, the Layout Book (master +
// custom subset numbering), title blocks, schedules and publisher runs must
// converge to identical semantic results on the Web and Electron hosts
// (same handler construction as the docs sequence above; the SAME pure
// shared-core derivations serve both, LOCK-004/017). ------------------------

/** The identical P013 documentation-production sequence on both hosts. */
async function runP013Sequence(r: Renderer): Promise<{
  saveSha: string;
  treeJson: string;
  scheduleSha: string;
  runJson: string;
  versionId: string;
}> {
  await c(r, "document.create", { entityId: "p013-parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 3300], thickness: 200, baseOffset: -200 },
    ],
  });
  await c(r, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
    ],
  });
  const folder = val<{ node: { id: string } }>(await c(r, "navigator.createFolder", { name: "Plans" }));
  await c(r, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } });
  await c(r, "layout.create", { name: "Master Sheet" });
  await c(r, "layout.create", { name: "Ground Floor" });
  const subset = val<{ node: { id: string } }>(await c(r, "navigator.createSubset", {
    name: "Structural", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  await c(r, "layout.update", { id: "lo-000002", patch: { subsetId: subset.node.id } });
  await c(r, "layout.update", { id: "lo-000002", patch: { masterId: "lo-000001" } });
  await c(r, "titleblock.create", {
    name: "Standard",
    widthMm: 180,
    heightMm: 48,
    rowHeightMm: 12,
    rows: [
      { label: "Project", field: "text", value: "Offisos Demo" },
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
    ],
  });
  await c(r, "layout.update", {
    id: "lo-000002",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 10, yMm: 10 } },
  });
  await c(r, "revision.add", { code: "P01", description: "First issue", layoutIds: ["lo-000002"] });
  await c(r, "layout.update", { id: "lo-000002", patch: { revisionIds: ["rev-000001"] } });
  const elementsSchedule = val<{ schedule: { id: string } }>(await c(r, "schedule.create", {
    name: "Element Index",
    source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "type", label: "Type" },
      { key: "story", label: "Story" },
    ],
  }));
  const viewsSchedule = val<{ schedule: { id: string } }>(await c(r, "schedule.create", {
    name: "View Index",
    source: "views",
    columns: [
      { key: "id", label: "Id" },
      { key: "title", label: "Title" },
      { key: "folder", label: "Folder" },
    ],
  }));
  await c(r, "publisher.create", {
    name: "Issue Set",
    items: [
      { kind: "subset", id: subset.node.id, format: "pdf" },
      { kind: "layout", id: "lo-000001", format: "svg" },
    ],
  });

  // The semantic convergence evidence (all FRESH derivations — identical
  // inputs through the SAME shared-core modules).
  const tree = val<Record<string, unknown>>(await qq(r, "navigator.tree", {}));
  const elementsRun = val<{ rows: readonly (readonly string[])[]; sha256: string }>(
    await qq(r, "schedules.run", { id: elementsSchedule.schedule.id }),
  );
  const viewsRun = val<{ rows: readonly (readonly string[])[]; sha256: string }>(
    await qq(r, "schedules.run", { id: viewsSchedule.schedule.id }),
  );
  const run = val<{ pages: unknown[]; pdfSha256: string; pdfSize: number }>(
    await c(r, "publisher.run", { id: "pub-000001" }),
  );
  const saved = val<{ bytes: number[] }>(await c(r, "document.save", {}));
  const snapEnd = val<CADDocumentSnapshot>(await qq(r, "document.getState", {}));

  // The schedule sha256s are canonical-rows hashes: fold them with the row
  // COUNTS so the comparison covers both shape and content.
  const scheduleSha = JSON.stringify([
    [elementsRun.rows.length, elementsRun.sha256],
    [viewsRun.rows.length, viewsRun.sha256],
  ]);
  return {
    saveSha: JSON.stringify(saved.bytes),
    treeJson: JSON.stringify(tree),
    scheduleSha,
    runJson: JSON.stringify([run.pages, run.pdfSha256, run.pdfSize]),
    versionId: snapEnd.version.version_id,
  };
}

test("P013 documentation production: Web and Electron converge to identical navigator/book/schedule/publisher results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runP013Sequence(web);
  const electronResult = await runP013Sequence(electron);

  assert.equal(webResult.versionId, electronResult.versionId, "identical version lineage through the P013 stack");
  assert.equal(webResult.treeJson, electronResult.treeJson, "identical navigator tree (project map + view map + layout book + registry)");
  assert.equal(webResult.scheduleSha, electronResult.scheduleSha, "identical fresh schedule rows + sha256 on both hosts");
  assert.equal(webResult.runJson, electronResult.runJson, "identical publisher run pages + pdf hash/size");
  assert.equal(webResult.saveSha, electronResult.saveSha, "byte-identical saves");
});
