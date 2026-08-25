/**
 * CI reproducibility (LOCK-004, LOCK-005, §15).
 *
 * Deterministic scene-graph + canonical-serialization hashes. Two fresh
 * handler instances given the same command sequence produce identical content
 * hashes (no hidden nondeterminism). Serialize∘deserialize = serialize
 * (canonical form is a fixed point).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { canonicalHash, deserialize, rootVersion, serialize } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "repro-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "repro-test",
};

const addE1 = {
  type: "command" as const,
  name: "document.applyEdit" as const,
  payload: { edit: { type: "addElement" as const, element: { id: "e1", kind: "geometry" as const, engineId: null, props: { meshToken: "m1" } } } },
};
const updateE1 = {
  type: "command" as const,
  name: "document.applyEdit" as const,
  payload: { edit: { type: "updateElement" as const, elementId: "e1", patch: { meshToken: "m2" } } },
};

test("two fresh handler instances given the same sequence produce identical content hashes", async () => {
  const h1 = AppApiHandler.create(CONFIG);
  const h2 = AppApiHandler.create(CONFIG);
  for (const h of [h1, h2]) {
    await h.handle(addE1);
    await h.handle(updateE1);
  }
  assert.equal(h1.currentContentHash(), h2.currentContentHash());
});

test("serialize∘deserialize is a fixed point (canonical form)", () => {
  const snapshot: CADDocumentSnapshot = {
    version: rootVersion("repro-doc", "repro-test", null),
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: ["repro"],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements: [{ id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } }],
  };
  const once = serialize(snapshot);
  const twice = serialize(deserialize(once));
  assert.equal(once, twice);
  assert.equal(canonicalHash(deserialize(once)), canonicalHash(snapshot));
});

test("renderer.render is stable across two invocations of fresh renderer instances", async () => {
  const snap: CADDocumentSnapshot = {
    version: rootVersion("repro-render", "repro-test", null),
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: ["repro-render"],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements: [
      { id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } },
      { id: "e2", kind: "bim", engineId: null, props: { meshToken: "m2" } },
    ],
  };
  const r1 = createRenderer(new WebHost(new WebSocketTransport(AppApiHandler.create(CONFIG))));
  const r2 = createRenderer(new WebHost(new WebSocketTransport(AppApiHandler.create(CONFIG))));
  assert.equal(r1.render(snap).hash, r2.render(snap).hash);
});
