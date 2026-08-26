/**
 * geometry.prepare App API command tests (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Exercises the additive `geometry.prepare` command through the shared
 * AppApiHandler — with the DUMMY bundle (the permanent test double: the
 * command degrades gracefully — mesh/metadata null) and with the real OCCT
 * bundle (meshToken/bbox/mesh/metadata + typed failures).
 *
 * The final test is the directive's host-parity requirement: the same
 * representative geometry workflow (geometry.prepare -> applyEdit ->
 * getState -> render) through BOTH the Web Host (WebSocketTransport) and the
 * Electron Host (IpcTransport) yields IDENTICAL meshTokens AND identical
 * CADDocument content hashes — the real engine introduces no host
 * divergence (LOCK-017, §5.5).
 *
 * Error-path and dummy-path tests run without the engine; real-engine tests
 * skip (with the recorded reason) when the pinned toolchain is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { engineSkip } from "./engine-availability.js";

const skipEngine = await engineSkip();

const DUMMY_CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "geometry-prepare-dummy",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "geometry-prepare-test",
};

function prepareCommand(geometry: unknown): Command {
  return { type: "command", name: "geometry.prepare", payload: { geometry } };
}

interface Prepared {
  meshToken: string;
  bbox: readonly number[];
  mesh: { vertices: readonly number[]; indices: readonly number[] } | null;
  metadata: { volume: number; vertices: number; triangles: number } | null;
  engine: { engineId: string; engineVersion: string };
}

async function run(handler: AppApiHandler, command: Command): Promise<CommandQueryResponse> {
  return handler.handle(command);
}

// --- Dummy bundle: the command works without any engine (graceful degrade) ---

test("geometry.prepare on the dummy bundle returns the dummy result with null mesh/metadata", async () => {
  const handler = AppApiHandler.create(DUMMY_CONFIG);
  const response = await run(handler, prepareCommand({ shape: "box", width: 1, depth: 2, height: 3 }));
  assert.equal(response.ok, true);
  const value = response.value as Prepared;
  assert.equal(value.meshToken, "dummy-mesh:geometry:prepare");
  assert.deepEqual([...value.bbox], [0, 0, 0, 1, 1, 1]);
  assert.equal(value.mesh, null, "dummy implements no MeshProvider");
  assert.equal(value.metadata, null, "dummy implements no GeometryMetadataProvider");
  assert.equal(value.engine.engineId, "dummy-geometry");
  assert.equal(value.engine.engineVersion, "0.1.0");
});

test("geometry.prepare does NOT mutate the document (content hash unchanged)", async () => {
  const handler = AppApiHandler.create(DUMMY_CONFIG);
  const before = handler.currentContentHash();
  await run(handler, prepareCommand({ shape: "cylinder", radius: 1, height: 1 }));
  assert.equal(handler.currentContentHash(), before, "prepare is non-mutating");
});

test("geometry.prepare rejects a missing geometry payload with bad_payload", async () => {
  const handler = AppApiHandler.create(DUMMY_CONFIG);
  const response = await handler.handle({ type: "command", name: "geometry.prepare", payload: {} });
  assert.equal(response.ok, false);
  assert.equal(response.code, "bad_payload");
});

test("geometry.prepare on the OCCT bundle maps compile failures to engine_malformed_input (no engine needed)", async () => {
  const handler = AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle(),
    entityId: "geometry-prepare-occt",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "geometry-prepare-test",
  });
  const cases: unknown[] = [
    { shape: "box", width: -1, depth: 1, height: 1 },
    { shape: "extrude" },
    { shape: "transform", matrix: [1, 2], target: { shape: "box", width: 1, depth: 1, height: 1 } },
  ];
  for (const geometry of cases) {
    const response = await run(handler, prepareCommand(geometry));
    assert.equal(response.ok, false, `descriptor ${JSON.stringify(geometry)} must be rejected`);
    assert.equal(response.code, "engine_malformed_input");
    assert.equal(response.retryable, false);
  }
});

test("geometry.prepare with an idempotency key is applied at most once", async () => {
  const handler = AppApiHandler.create(DUMMY_CONFIG);
  const command: Command = {
    type: "command",
    name: "geometry.prepare",
    payload: { geometry: { shape: "box", width: 1, depth: 1, height: 1 } },
    idempotencyKey: "prepare-once",
  };
  const first = await handler.handle(command);
  const second = await handler.handle(command);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, "idempotent replay returns the cached response");
});

// --- Real engine: geometry flows through the shared App API ---

test("geometry.prepare on the OCCT bundle returns the real deterministic result", { skip: skipEngine }, async () => {
  const handler = AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle(),
    entityId: "geometry-prepare-occt",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "geometry-prepare-test",
  });
  const response = await run(handler, prepareCommand({ shape: "box", width: 2, depth: 3, height: 4 }));
  assert.equal(response.ok, true);
  const value = response.value as Prepared;
  assert.ok(value.meshToken.startsWith("occt:"), "real meshToken");
  assert.equal(value.meshToken.length, 5 + 64);
  value.bbox.forEach((v, i) => {
    const expected = [0, 0, 0, 2, 3, 4];
    assert.ok(Math.abs(v - expected[i]!) <= 0.01, `bbox[${i}] = ${v} ~ ${expected[i]}`);
  });
  assert.ok(value.mesh !== null, "MeshProvider attaches viewport mesh data");
  assert.equal(value.mesh!.vertices.length, 8 * 3);
  assert.equal(value.mesh!.indices.length, 12 * 3);
  assert.ok(value.metadata !== null, "GeometryMetadataProvider attaches metadata");
  assert.equal(value.metadata!.volume, 24);
  assert.equal(value.engine.engineId, "occt");
  assert.notEqual(value.engine.engineVersion, "unknown");
  // Determinism through the command layer.
  const repeat = await run(handler, prepareCommand({ shape: "box", width: 2, depth: 3, height: 4 }));
  if (repeat.ok !== true) throw new Error("repeat prepare failed");
  assert.equal((repeat.value as Prepared).meshToken, value.meshToken);
  // The result persists through the EXISTING document workflow: applyEdit
  // addElement with the real meshToken, then getState + render.
  const add: Command = {
    type: "command",
    name: "document.applyEdit",
    payload: {
      edit: {
        type: "addElement",
        element: { id: "e1", kind: "geometry", engineId: "occt", props: { geometry: { shape: "box", width: 2, depth: 3, height: 4 }, meshToken: value.meshToken } },
      },
    },
  };
  const added = await run(handler, add);
  assert.equal(added.ok, true);
  const stateResponse = await handler.handle({ type: "query", name: "document.getState", payload: {} });
  if (stateResponse.ok !== true) throw new Error("getState failed");
  const snapshot = stateResponse.value as { elements: { id: string; props: { meshToken?: string } }[] };
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0]!.props.meshToken, value.meshToken);
});

test("geometry.prepare typed failures surface the engine codes verbatim", { skip: skipEngine }, async () => {
  const handler = AppApiHandler.create({
    adapterBundle: createOcctAdapterBundle({ timeoutMs: 10 }),
    entityId: "geometry-prepare-occt-timeout",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "geometry-prepare-test",
  });
  const response = await run(handler, prepareCommand({ shape: "box", width: 1, depth: 1, height: 1 }));
  assert.equal(response.ok, false);
  assert.equal(response.code, "engine_timeout", "wall-clock budget expired at the process boundary");
  assert.equal(response.retryable, true);
});

// --- The directive's host-parity requirement through the REAL adapter ---

test("Web and Electron hosts converge to identical meshTokens and content hashes through the real OCCT adapter", { skip: skipEngine }, async () => {
  const OCCT_CONFIG = {
    adapterBundle: createOcctAdapterBundle(),
    entityId: "parity-occt-doc",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "parity-occt-test",
  };
  const webHandler = AppApiHandler.create(OCCT_CONFIG);
  const electronHandler = AppApiHandler.create(OCCT_CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  // The representative geometry workflow (Issue #26): prepare real geometry,
  // add it, prepare a boolean over it, add that, undo, redo.
  const boxDescriptor = { shape: "box", width: 4, depth: 3, height: 2 };
  const cylinderDescriptor = { shape: "cylinder", radius: 1, height: 5, origin: [2, 1.5, 0], direction: [0, 0, 1] };

  async function workflow(handler: AppApiHandler, renderer: ReturnType<typeof createRenderer>): Promise<{ boxToken: string; fuseToken: string }> {
    const boxResponse = await renderer.execute(prepareCommand(boxDescriptor));
    assert.equal(boxResponse.ok, true, "box prepare through the host transport");
    const boxValue = boxResponse.value as Prepared;
    const addBox: Command = {
      type: "command",
      name: "document.applyEdit",
      payload: {
        edit: {
          type: "addElement",
          element: { id: "box1", kind: "geometry", engineId: "occt", props: { geometry: boxDescriptor, meshToken: boxValue.meshToken } },
        },
      },
    };
    assert.equal((await renderer.execute(addBox)).ok, true);

    const fuseResponse = await renderer.execute(
      prepareCommand({ shape: "fuse", a: boxDescriptor, b: cylinderDescriptor }),
    );
    assert.equal(fuseResponse.ok, true, "boolean fuse prepare through the host transport");
    const fuseValue = fuseResponse.value as Prepared;
    const addFuse: Command = {
      type: "command",
      name: "document.applyEdit",
      payload: {
        edit: {
          type: "addElement",
          element: { id: "fuse1", kind: "geometry", engineId: "occt", props: { geometry: { shape: "fuse", a: boxDescriptor, b: cylinderDescriptor }, meshToken: fuseValue.meshToken } },
        },
      },
    };
    assert.equal((await renderer.execute(addFuse)).ok, true);

    // Selection metadata on the fused element (ephemeral, non-versioned).
    const select: Command = { type: "command", name: "document.setSelection", payload: { ids: ["fuse1"] } };
    assert.equal((await renderer.execute(select)).ok, true);

    // Undo the fuse add, redo it — the versioned workflow stays intact.
    assert.equal((await renderer.execute({ type: "command", name: "document.undo", payload: {} })).ok, true);
    assert.equal((await renderer.execute({ type: "command", name: "document.redo", payload: {} })).ok, true);

    return { boxToken: boxValue.meshToken, fuseToken: fuseValue.meshToken };
  }

  const webResult = await workflow(webHandler, web);
  const electronResult = await workflow(electronHandler, electron);

  assert.equal(webResult.boxToken, electronResult.boxToken, "box meshToken identical across hosts");
  assert.equal(webResult.fuseToken, electronResult.fuseToken, "fuse meshToken identical across hosts");
  assert.equal(
    webHandler.currentContentHash(),
    electronHandler.currentContentHash(),
    "Web and Electron hosts diverged on the same geometry workflow (real adapter)",
  );

  // And the renderer produces the deterministic scene for the real tokens.
  const webState = await webHandler.handle({ type: "query", name: "document.getState", payload: {} });
  const electronState = await electronHandler.handle({ type: "query", name: "document.getState", payload: {} });
  if (webState.ok !== true || electronState.ok !== true) throw new Error("getState failed");
  const webScene = web.render(webState.value as Parameters<typeof web.render>[0]);
  const electronScene = electron.render(electronState.value as Parameters<typeof electron.render>[0]);
  assert.equal(webScene.hash, electronScene.hash, "deterministic scene hash parity (LOCK-017) with real engine tokens");
  assert.equal(webScene.nodes.length, 2);
});
