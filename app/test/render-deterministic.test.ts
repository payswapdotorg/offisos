/**
 * Renderer determinism (LOCK-017): same snapshot → same hash, across hosts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CADDocumentSnapshot, Element } from "../src/contracts/caddocument.js";
import { rootVersion } from "../src/caddocument/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost } from "../src/host-web/index.js";
import { ElectronHost } from "../src/host-electron/index.js";
import type { Transport } from "../src/contracts/host.js";
import type { CommandQueryRequest, CommandQueryResponse } from "../src/contracts/app-api.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function makeElement(id: string, meshToken: string, transform?: number[]): Element {
  return {
    id,
    kind: "geometry",
    engineId: null,
    props: { meshToken, transform: transform ?? IDENTITY },
  };
}

function makeSnapshot(elements: Element[]): CADDocumentSnapshot {
  return {
    version: rootVersion("render-doc", "render-test", null),
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: ["test:render"],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements,
  };
}

/** A no-op transport (renderer.render does not use the transport). */
const noopTransport: Transport = {
  transportId: "noop",
  async send(_request: CommandQueryRequest): Promise<CommandQueryResponse> {
    return { ok: false, code: "noop", message: "render test does not dispatch", retryable: false };
  },
};

test("rendering the same snapshot twice yields the same hash", () => {
  const snapshot = makeSnapshot([makeElement("a", "mesh-a"), makeElement("b", "mesh-b")]);
  const renderer = createRenderer(new WebHost(noopTransport));
  const first = renderer.render(snapshot);
  const second = renderer.render(snapshot);
  assert.equal(first.hash, second.hash);
  assert.equal(first.nodes.length, 2);
});

test("rendering is deterministic across Web and Electron hosts", () => {
  const snapshot = makeSnapshot([makeElement("a", "mesh-a"), makeElement("b", "mesh-b", IDENTITY)]);
  const web = createRenderer(new WebHost(noopTransport));
  const electron = createRenderer(new ElectronHost(noopTransport));
  assert.equal(web.render(snapshot).hash, electron.render(snapshot).hash);
});

test("different snapshots produce different hashes", () => {
  const renderer = createRenderer(new WebHost(noopTransport));
  const a = renderer.render(makeSnapshot([makeElement("a", "mesh-a")]));
  const b = renderer.render(makeSnapshot([makeElement("a", "mesh-b")]));
  assert.notEqual(a.hash, b.hash);
});

test("elements without meshToken get a deterministic empty token", () => {
  const el: Element = { id: "x", kind: "annotation", engineId: null, props: {} };
  const renderer = createRenderer(new WebHost(noopTransport));
  const scene = renderer.render(makeSnapshot([el]));
  assert.equal(scene.nodes[0]?.meshToken, "empty:x");
});
