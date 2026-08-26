/**
 * Web/Electron semantic parity for model revisions and the Construction
 * Graph bridge (CAD-IMPLEMENT-003, §5.5, LOCK-017).
 *
 * The same semantic command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) yields identical
 * revision histories, identical graph-facing event streams, identical
 * deterministic replays and identical content hashes — with the dummy
 * adapter, and (engine-gated) with the real OCCT adapter so revisions carry
 * real engine provenance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { canonicalStringify } from "../src/caddocument/index.js";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import type { EngineAdapterBundle } from "../src/contracts/adapter.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { ModelHistory } from "../src/contracts/model.js";
import { engineSkip } from "./engine-availability.js";

const skipEngine = await engineSkip();

function cmd(name: Command["name"], payload: unknown, idempotencyKey?: string): Command {
  return { type: "command", name, payload, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}

interface ParityDriver {
  execute(command: Command): Promise<CommandQueryResponse>;
  query(query: Query): Promise<CommandQueryResponse>;
}

async function valueOf<T>(driver: { execute(c: Command): Promise<CommandQueryResponse>; query(q: Query): Promise<CommandQueryResponse> }, request: Command | Query): Promise<T> {
  const response = request.type === "command" ? await driver.execute(request) : await driver.query(request);
  assert.equal(response.ok, true, `expected ok for ${request.name}: ${JSON.stringify(response)}`);
  return (response as { ok: true; value: T }).value;
}

function handlerDriver(handler: AppApiHandler): ParityDriver {
  return {
    async execute(command: Command) {
      return handler.handle(command);
    },
    async query(query: Query) {
      return handler.handle(query);
    },
  };
}

/** The semantic workflow whose revision/event parity is asserted. */
async function revisionWorkflow(
  driver: ParityDriver,
  entityId: string,
  elements: { id: string; engineId: string | null; meshToken: string }[],
): Promise<void> {
  await valueOf<CADDocumentSnapshot>(driver, cmd("document.create", { entityId }));
  // add all elements
  for (const e of elements) {
    await valueOf<CADDocumentSnapshot>(driver, cmd("document.applyEdit", {
      edit: { type: "addElement", element: { id: e.id, kind: "geometry", engineId: e.engineId, props: { meshToken: e.meshToken } } },
    }));
  }
  // update the first, undo it, redo it
  await valueOf<CADDocumentSnapshot>(driver, cmd("document.applyEdit", {
    edit: { type: "updateElement", elementId: elements[0]?.id ?? "e1", patch: { meshToken: "updated" } },
  }));
  await valueOf<CADDocumentSnapshot>(driver, cmd("document.undo", {}));
  await valueOf<CADDocumentSnapshot>(driver, cmd("document.redo", {}));
  // remove the last element
  const lastId = elements[elements.length - 1]?.id ?? "e2";
  await valueOf<CADDocumentSnapshot>(driver, cmd("document.applyEdit", {
    edit: { type: "removeElement", elementId: lastId },
  }));
}

function assertParity(web: AppApiHandler, electron: AppApiHandler): void {
  assert.equal(
    web.currentContentHash(),
    electron.currentContentHash(),
    "content hash diverged across hosts",
  );
}

async function assertRevisionEventParity(web: AppApiHandler, electron: AppApiHandler): Promise<void> {
  const webDriver = handlerDriver(web);
  const electronDriver = handlerDriver(electron);
  const historyA = await valueOf<ModelHistory>(webDriver, q("model.getHistory"));
  const historyB = await valueOf<ModelHistory>(electronDriver, q("model.getHistory"));
  assert.equal(
    canonicalStringify(historyA),
    canonicalStringify(historyB),
    "revision histories diverged across hosts",
  );

  const eventsA = await valueOf<{ events: unknown[]; events_hash: string }>(webDriver, q("model.getGraphEvents"));
  const eventsB = await valueOf<{ events: unknown[]; events_hash: string }>(electronDriver, q("model.getGraphEvents"));
  assert.equal(eventsA.events_hash, eventsB.events_hash, "graph event streams diverged across hosts");
  assert.equal(canonicalStringify(eventsA.events), canonicalStringify(eventsB.events));

  const n = historyA.revisions.length;
  for (let k = 0; k <= n; k++) {
    const ra = await valueOf<{ content_hash: string; verified: boolean }>(webDriver, q("model.replay", { revision_number: k }));
    const rb = await valueOf<{ content_hash: string; verified: boolean }>(electronDriver, q("model.replay", { revision_number: k }));
    assert.equal(ra.content_hash, rb.content_hash, `replay to ${k} diverged across hosts`);
    assert.equal(ra.verified, true);
    assert.equal(rb.verified, true);
  }
}

test("web and electron hosts converge on identical revisions, graph events and replays (dummy adapter)", async () => {
  const CONFIG = {
    adapterBundle: DummyAdapterBundle,
    entityId: "revision-parity-doc",
    format: "offisos-dummy",
    formatVersion: "1",
    createdBy: "parity-test",
  };
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const elements = [
    { id: "e1", engineId: null, meshToken: "dummy-mesh:e1" },
    { id: "e2", engineId: null, meshToken: "dummy-mesh:e2" },
    { id: "e3", engineId: null, meshToken: "dummy-mesh:e3" },
  ];
  await revisionWorkflow(
    { execute: (c) => web.execute(c), query: (qq) => web.query(qq) },
    "revision-parity-doc",
    elements,
  );
  await revisionWorkflow(
    { execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) },
    "revision-parity-doc",
    elements,
  );

  assertParity(webHandler, electronHandler);
  await assertRevisionEventParity(webHandler, electronHandler);
});

test("web and electron hosts converge on identical revisions and events through the REAL OCCT adapter (engine provenance)", { skip: skipEngine }, async () => {
  const OCCT_CONFIG = (bundle: EngineAdapterBundle) => ({
    adapterBundle: bundle,
    entityId: "revision-parity-occt-doc",
    format: "offisos-occt",
    formatVersion: "1",
    createdBy: "parity-occt-test",
  });
  const webHandler = AppApiHandler.create(OCCT_CONFIG(createOcctAdapterBundle()));
  const electronHandler = AppApiHandler.create(OCCT_CONFIG(createOcctAdapterBundle()));
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  // Prepare REAL geometry first so the elements carry genuine deterministic
  // mesh tokens + engine provenance (the same workflow the UI drives).
  const boxDescriptor = { shape: "box", width: 4, depth: 3, height: 2 };
  const prepare = async (renderer: ReturnType<typeof createRenderer>): Promise<{ meshToken: string; engineId: string }> => {
    const response = await renderer.execute({
      type: "command",
      name: "geometry.prepare",
      payload: { geometry: boxDescriptor },
    });
    assert.equal(response.ok, true, "real geometry.prepare through the transport");
    const value = response.ok ? (response.value as { meshToken: string; engine: { engineId: string } }) : null;
    assert.ok(value);
    return { meshToken: value.meshToken, engineId: value.engine.engineId };
  };
  const webPrepared = await prepare(web);
  const electronPrepared = await prepare(electron);
  assert.equal(webPrepared.meshToken, electronPrepared.meshToken, "real mesh tokens identical across hosts");
  assert.equal(webPrepared.engineId, electronPrepared.engineId);

  const elements = [
    { id: "box1", engineId: webPrepared.engineId, meshToken: webPrepared.meshToken },
    { id: "note1", engineId: null, meshToken: "annotation-only" },
  ];
  await revisionWorkflow(
    { execute: (c) => web.execute(c), query: (qq) => web.query(qq) },
    "revision-parity-occt-doc",
    elements,
  );
  await revisionWorkflow(
    { execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) },
    "revision-parity-occt-doc",
    elements,
  );

  assertParity(webHandler, electronHandler);
  await assertRevisionEventParity(webHandler, electronHandler);

  // The revision events must carry the real engine id as PROVENANCE with
  // OBSERVED geometry provenance for the engine-linked element.
  const events = await valueOf<{ events: { event_type: string; payload: { elements: { element_id: string; change: string; engineId: string | null; uncertainty: { geometry_provenance: string } }[] } }[] }>(
    handlerDriver(webHandler),
    q("model.getGraphEvents"),
  );
  const boxAddEvent = events.events.find(
    (e) => e.event_type === "model.version.created" && e.payload.elements.some((p) => p.element_id === "box1" && p.change === "added"),
  );
  assert.ok(boxAddEvent, "the box1 add must appear in the event stream");
  const boxProjection = boxAddEvent.payload.elements.find((p) => p.element_id === "box1");
  assert.ok(boxProjection);
  assert.equal(boxProjection.engineId, "occt");
  assert.equal(boxProjection.uncertainty.geometry_provenance, "OBSERVED");
});

test("save/open parity across hosts: the persisted artifact carries identical history", async () => {
  const CONFIG = {
    adapterBundle: DummyAdapterBundle,
    entityId: "persist-parity-doc",
    format: "offisos-dummy",
    formatVersion: "1",
    createdBy: "parity-test",
  };
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const elements = [
    { id: "e1", engineId: null, meshToken: "dummy-mesh:e1" },
    { id: "e2", engineId: null, meshToken: "dummy-mesh:e2" },
  ];
  await revisionWorkflow({ execute: (c) => web.execute(c), query: (qq) => web.query(qq) }, "persist-parity-doc", elements);
  await revisionWorkflow({ execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) }, "persist-parity-doc", elements);

  // Save on the web host, open on the electron host — the persisted bytes
  // (including the revision history) are semantically interchangeable.
  const webSave = await valueOf<{ bytes: number[] }>({ execute: (c) => web.execute(c), query: (qq) => web.query(qq) }, cmd("document.save", {}));
  const opened = await valueOf<CADDocumentSnapshot>({ execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) }, cmd("document.open", { source: webSave.bytes }));
  assert.equal(opened.elements.length, 1);
  assert.ok(opened.modelHistory !== undefined);
  assert.equal(opened.modelHistory.revisions.length, 6);

  const eventsElectron = await valueOf<{ events_hash: string }>({ execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) }, q("model.getGraphEvents"));
  const eventsWeb = await valueOf<{ events_hash: string }>({ execute: (c) => web.execute(c), query: (qq) => web.query(qq) }, q("model.getGraphEvents"));
  assert.equal(eventsElectron.events_hash, eventsWeb.events_hash, "graph events survive the cross-host save/open round-trip");
  // Content equality at the head revision via the deterministic replay (the
  // ephemeral editorState legitimately differs after open).
  const headElectron = await valueOf<{ content_hash: string }>({ execute: (c) => electron.execute(c), query: (qq) => electron.query(qq) }, q("model.replay", { revision_number: 6 }));
  const headWeb = await valueOf<{ content_hash: string }>({ execute: (c) => web.execute(c), query: (qq) => web.query(qq) }, q("model.replay", { revision_number: 6 }));
  assert.equal(headElectron.content_hash, headWeb.content_hash, "head-revision content identical across the cross-host save/open round-trip");
});
