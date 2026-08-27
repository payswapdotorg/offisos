/**
 * COMPAT-CAD-002 — Web/Electron host parity for the BIM authoring workflow
 * (§5.5, LOCK-017; mirrors drafting-host-parity).
 *
 * The SAME representative BIM command sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * byte-identical semantic results: content hash, history hash, graph events
 * hash, BIM settings and camera derivation. Each host drives its OWN
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
  entityId: "bim-parity",
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

/** The representative BIM sequence (identical on both hosts). */
async function runBimSequence(r: Renderer): Promise<{
  historyHash: string;
  eventsHash: string;
  settings: unknown;
  versionId: string;
  building: unknown;
  camera: unknown;
  semantics: unknown;
}> {
  await c(r, "document.create", { entityId: "parity-building" });
  await c(r, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
    ],
  });
  await c(r, "bim.move", { ids: ["op-door"], dx: 600, dy: 0, dz: 0 });
  await c(r, "bim.copy", { ids: ["wall-south"], dx: 0, dy: 5000, dz: 0 });
  await c(r, "bim.setProperties", { elementId: "space-office", patch: { name: "Office 1A" } });
  await c(r, "bim.setSettings", { settings: { camera: { preset: "front" } } });
  await c(r, "bim.buildGeometry", {});
  await c(r, "document.setSelection", { ids: ["wall-south"] });
  await c(r, "document.undo", {});
  await c(r, "document.redo", {});

  const snapEnd = val<CADDocumentSnapshot>(await qq(r, "document.getState", {}));
  const events = val<{ events_hash: string }>(await qq(r, "model.getGraphEvents", {}));
  const building = val<unknown>(await qq(r, "bim.getBuilding", {}));
  const camera = val<unknown>(await qq(r, "bim.camera", { preset: "iso" }));
  const semantics = val<unknown>(await qq(r, "bim.getSemantics", {}));
  const hist = snapEnd.modelHistory;
  const histCanonical = JSON.stringify(hist);
  return {
    historyHash: histCanonical.length.toString(10) + ":" + simpleHash(histCanonical),
    eventsHash: events.events_hash,
    settings: snapEnd.bimSettings,
    versionId: snapEnd.version.version_id,
    building,
    camera,
    semantics,
  };
}

/** FNV-1a (deterministic; mirrors the drafting parity test). */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

test("BIM workflow: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runBimSequence(web);
  const electronResult = await runBimSequence(electron);

  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash(), "content hash parity");
  assert.equal(webResult.versionId, electronResult.versionId, "same final version id");
  assert.equal(webResult.historyHash, electronResult.historyHash, "identical revision histories");
  assert.equal(webResult.eventsHash, electronResult.eventsHash, "identical graph event streams");
  assert.deepEqual(webResult.settings, electronResult.settings, "identical BIM settings (camera preset)");
  assert.deepEqual(webResult.building, electronResult.building, "identical building structure");
  assert.deepEqual(webResult.camera, electronResult.camera, "identical camera derivation");
  assert.deepEqual(webResult.semantics, electronResult.semantics, "identical semantic records");
});

test("BIM save/open parity across hosts: web-saved bytes open identically on electron", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  await c(web, "document.create", { entityId: "cross-open" });
  await c(web, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "s1", name: "GF", level: 0, height: 3000 },
      { type: "bim.wall", id: "w1", storyId: "s1", start: [0, 0], end: [5000, 0], width: 300, height: 3000 },
      { type: "bim.opening", id: "o1", hostId: "w1", distance: 1000, width: 900, height: 2100, sill: 0 },
      { type: "bim.window", id: "win1", openingId: "o1" },
    ],
  });
  await c(web, "bim.buildGeometry", {});
  await c(web, "bim.setSettings", { settings: { camera: { preset: "right" } } });
  await c(web, "document.setSelection", { ids: ["w1"] });
  const saved = val<{ bytes: number[] }>(await c(web, "document.save", {}));

  const electronHandler = AppApiHandler.create(CONFIG);
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  const opened = val<CADDocumentSnapshot>(await c(electron, "document.open", { source: saved.bytes }));
  assert.equal(opened.elements.length, 4);
  assert.equal(opened.bimSettings?.camera.preset, "right", "camera preset persists through save/open");
  assert.deepEqual(opened.selection, ["w1"]);
  assert.equal(electronHandler.currentContentHash(), webHandler.currentContentHash(), "cross-host save/open parity");
});
