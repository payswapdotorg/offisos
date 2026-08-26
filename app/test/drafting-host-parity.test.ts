/**
 * COMPAT-CAD-001 — Web/Electron host parity for the drafting workflow
 * (§5.5, LOCK-017; mirrors impact-host-parity).
 *
 * The SAME representative drafting command sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * byte-identical semantic results: content hash, history hash, graph events
 * hash, layer table, selection and drafting settings. Each host drives its
 * OWN handler + bundle instance through its REAL transport.
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
  entityId: "drafting-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

/** The representative drafting sequence (identical on both hosts). */
async function runDraftingSequence(r: Renderer): Promise<{
  contentHash: string;
  historyHash: string;
  eventsHash: string;
  layers: unknown;
  selection: unknown;
  settings: unknown;
  versionId: string;
  snapPoint: number[];
}> {
  await c(r, "document.create", { entityId: "parity-doc" });
  await c(r, "drafting.addLayer", { name: "walls", color: "#b91c1c" });
  const walls = val<{ layerId: string }>(await c(r, "drafting.addLayer", { name: "walls2" }));
  await c(r, "drafting.setSettings", { settings: { snap: { tolerance: 0.3 }, view: { pan: [4, 2], zoom: 1.5 } } });
  await c(r, "drafting.createEntities", {
    entities: [
      { type: "line", layer: walls.layerId, from: [0, 0], to: [80, 0] },
      { type: "circle", layer: "0", center: [40, 20], radius: 10 },
      { type: "rectangle", layer: walls.layerId, corner1: [5, 5], corner2: [20, 15] },
      { type: "dim-linear", layer: "0", p1: [0, 0], p2: [80, 0], mode: "aligned", offset: -5 },
    ],
  });
  // snap query through the host transport (deterministic on both hosts)
  const snap = val<{ best: { point: number[] } | null }>(await qq(r, "drafting.snap", {
    point: [80.3, -0.2], tolerance: 0.5, kinds: ["endpoint"],
  }));
  const snapPoint = snap.best?.point ?? [];
  await c(r, "drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: snapPoint, to: [95, 30] }],
  });
  await c(r, "drafting.move", { ids: ["el-000003"], dx: 2, dy: 2 });
  await c(r, "drafting.copy", { ids: ["el-000003"], dx: 30, dy: 0 });
  await c(r, "drafting.trim", { targetId: "el-000001", pick: [60, 0] }); // needs a boundary: none → no-op is fine
  await c(r, "document.setSelection", { ids: ["el-000001", "el-000004"] });
  await c(r, "document.undo", {});
  await c(r, "document.redo", {});
  const snapEnd = val<CADDocumentSnapshot>(await qq(r, "document.getState", {}));
  const events = val<{ events_hash: string }>(await qq(r, "model.getGraphEvents", {}));
  const historyHash = val<{ revisions: unknown[] }>(await qq(r, "model.getHistory", {}), );
  // history hash: canonical hash is exposed via the snapshot's modelHistory
  const hist = snapEnd.modelHistory;
  const histCanonical = JSON.stringify(hist);
  return {
    contentHash: "",
    historyHash: histCanonical.length.toString(10) + ":" + simpleHash(histCanonical),
    eventsHash: events.events_hash,
    layers: snapEnd.layers,
    selection: snapEnd.selection,
    settings: snapEnd.draftingSettings,
    versionId: snapEnd.version.version_id,
    snapPoint,
  };
}

/** FNV-1a (deterministic; used to compare history JSON equality without
 *  importing node:crypto into the comparison path twice). */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

test("drafting workflow: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runDraftingSequence(web);
  const electronResult = await runDraftingSequence(electron);

  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash(), "content hash parity");
  assert.equal(webResult.versionId, electronResult.versionId, "same final version id");
  assert.equal(webResult.historyHash, electronResult.historyHash, "identical revision histories");
  assert.equal(webResult.eventsHash, electronResult.eventsHash, "identical graph event streams");
  assert.deepEqual(webResult.layers, electronResult.layers, "identical layer tables");
  assert.deepEqual(webResult.selection, electronResult.selection, "identical persisted selections");
  assert.deepEqual(webResult.settings, electronResult.settings, "identical drafting settings");
  assert.deepEqual(webResult.snapPoint, electronResult.snapPoint, "identical snap resolution");
});

test("drafting save/open parity across hosts: web-saved bytes open identically on electron", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  await c(web, "document.create", { entityId: "cross-open" });
  await c(web, "drafting.addLayer", { name: "l1" });
  await c(web, "drafting.createEntities", {
    entities: [
      { type: "line", layer: "ly-000001", from: [0, 0], to: [50, 50] },
      { type: "arc", layer: "0", center: [10, 10], radius: 6, startAngle: 0, endAngle: Math.PI },
    ],
  });
  await c(web, "document.setSelection", { ids: ["el-000001"] });
  const saved = val<{ bytes: number[] }>(await c(web, "document.save", {}));

  const electronHandler = AppApiHandler.create(CONFIG);
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  const opened = val<CADDocumentSnapshot>(await c(electron, "document.open", { source: saved.bytes }));
  assert.equal(opened.layers?.length, 2);
  assert.deepEqual(opened.selection, ["el-000001"]);
  assert.equal(electronHandler.currentContentHash(), webHandler.currentContentHash(), "cross-host save/open parity");
});
