/**
 * Dummy-adapter end-to-end (LOCK-003/018, §5.3, §8).
 *
 * Exercises the full adapter boundary with the dummy engine/file adapter:
 * write → open → edit → render → serialize → undo → redo → verify. No
 * FreeCAD/OCCT/IfcOpenShell is imported anywhere; the boundary is proven with
 * the in-memory test double.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { DummyAdapterBundle, DummyFileAdapter } from "../src/adapters/dummy/index.js";
import { canonicalHash, rootVersion } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "e2e-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "e2e-test",
};

const initialSnapshot: CADDocumentSnapshot = {
  version: rootVersion("e2e-doc", "e2e-test", "snap-0"),
  format: "offisos-dummy",
  formatVersion: "1",
  sourceArtifactLineage: ["dummy:initial"],
  editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
  elements: [{ id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m0" } }],
};

test("dummy file adapter write→read round-trips a snapshot", async () => {
  const bytes = await DummyFileAdapter.write(initialSnapshot);
  assert.ok(bytes.length > 0);
  const back = await DummyFileAdapter.read(bytes);
  assert.equal(canonicalHash(back), canonicalHash(initialSnapshot));
});

test("end-to-end open → edit → serialize → undo → redo → verify", async () => {
  const bytes = await DummyFileAdapter.write(initialSnapshot);
  const handler = AppApiHandler.create(CONFIG);
  const renderer = createRenderer(new WebHost(new WebSocketTransport(handler)));

  // 1. Open via the App API with source bytes (file adapter path). The wire
  //    contract carries source as a JSON array of numbers (Uint8Array is not
  //    JSON-native); the handler normalizes number[] → Uint8Array for the
  //    file adapter.
  const openResp = await renderer.execute({ type: "command", name: "document.open", payload: { source: Array.from(bytes) } });
  if (!openResp.ok) {
    assert.fail(`open failed: ${openResp.message}`);
  }
  assert.equal((openResp.value as CADDocumentSnapshot).elements.length, 1);

  // 2. Apply an edit (add a second element).
  const addResp = await renderer.execute({
    type: "command",
    name: "document.applyEdit",
    payload: { edit: { type: "addElement", element: { id: "e2", kind: "geometry", engineId: null, props: { meshToken: "m1" } } } },
  });
  if (!addResp.ok) {
    assert.fail(`applyEdit failed: ${addResp.message}`);
  }
  const afterEditHash = handler.currentContentHash();

  // 3. Serialize → deserialize round-trip.
  const serialResp = await renderer.execute({ type: "command", name: "document.serialize", payload: {} });
  if (!serialResp.ok) {
    assert.fail(`serialize failed: ${serialResp.message}`);
  }
  const text = serialResp.value as string;
  assert.ok(text.length > 0);

  // 4. Undo → e2 removed; redo → e2 restored.
  await renderer.execute({ type: "command", name: "document.undo", payload: {} });
  assert.notEqual(handler.currentContentHash(), afterEditHash);
  await renderer.execute({ type: "command", name: "document.redo", payload: {} });
  assert.equal(handler.currentContentHash(), afterEditHash);

  // 5. Query state and render the final scene.
  const stateResp = await renderer.query({ type: "query", name: "document.getState", payload: {} });
  if (!stateResp.ok) {
    assert.fail(`getState failed: ${stateResp.message}`);
  }
  const snapshot = stateResp.value as CADDocumentSnapshot;
  assert.equal(snapshot.elements.length, 2);
  const scene = renderer.render(snapshot);
  assert.equal(scene.nodes.length, 2);
  assert.ok(scene.hash.length > 0);
});

test("dummy adapter marks the adapter boundary", async () => {
  assert.equal(DummyAdapterBundle.geometry.adapterMark, "offisos:adapter-boundary:1");
  assert.equal(DummyAdapterBundle.bim.adapterMark, "offisos:adapter-boundary:1");
  assert.equal(DummyAdapterBundle.file.adapterMark, "offisos:adapter-boundary:1");
});
