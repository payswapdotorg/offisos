/**
 * Web/Electron semantic parity for the downstream impact cascade
 * (RESEARCH-CAD-007 / Issue #32, §5.5, LOCK-017).
 *
 * The same semantic command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) yields identical
 * documents, identical graph events and IDENTICAL impact cascades
 * (byte-identical canonical encoding + events_hash) — with the engine-free
 * reference bundle (always) and with the real OCCT adapter (engine-gated)
 * so quantities carry real engine provenance on both hosts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import { createOcctAdapterBundle } from "../src/adapters/occt/index.js";
import { canonicalStringify } from "../src/caddocument/index.js";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import type { EngineAdapterBundle } from "../src/contracts/adapter.js";
import type { ImpactCascade } from "../src/contracts/impact.js";
import { engineSkip } from "./engine-availability.js";
import { CORPUS, resizedColumnDescriptor } from "./cad007-corpus.js";

const skipEngine = await engineSkip();

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}

interface ParityDriver {
  execute(command: Command): Promise<CommandQueryResponse>;
  query(query: Query): Promise<CommandQueryResponse>;
}

async function valueOf<T>(driver: ParityDriver, request: Command | Query): Promise<T> {
  const response = request.type === "command" ? await driver.execute(request) : await driver.query(request);
  assert.equal(response.ok, true, `expected ok for ${request.name}: ${JSON.stringify(response)}`);
  return (response as { ok: true; value: T }).value;
}

/** Drive BOTH hosts through the REAL transports (wire-equivalent paths).
 *  Each host gets its OWN bundle instance (independent hosts never share an
 *  adapter — LOCK-003: the bundle is a host-level wiring). */
function makeHostPair(bundleOf: () => EngineAdapterBundle, entityId: string) {
  const config = () => ({
    adapterBundle: bundleOf(),
    entityId,
    format: "offisos-parity",
    formatVersion: "1",
    createdBy: "cad007-parity-test",
  });
  const webHandler = AppApiHandler.create(config());
  const electronHandler = AppApiHandler.create(config());
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  type RendererDriver = ReturnType<typeof createRenderer>;
  const driverOf = (r: RendererDriver): ParityDriver => ({
    async execute(command: Command) {
      return r.execute(command);
    },
    async query(query: Query) {
      return r.query(query);
    },
  });
  return { webHandler, electronHandler, web: driverOf(web), electron: driverOf(electron) };
}

async function impactWorkflow(driver: ParityDriver, entityId: string): Promise<void> {
  await valueOf(driver, cmd("document.create", { entityId }));
  for (const item of CORPUS) {
    await valueOf(driver, cmd("document.applyEdit", {
      edit: {
        type: "addElement",
        element: { id: item.id, kind: "geometry", engineId: null, props: { geometry: item.descriptor, category: item.category } },
      },
    }));
  }
  await valueOf(driver, cmd("document.applyEdit", {
    edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: resizedColumnDescriptor() } },
  }));
}

async function assertImpactParity(bundleOf: () => EngineAdapterBundle, entityId: string): Promise<void> {
  const { webHandler, electronHandler, web, electron } = makeHostPair(bundleOf, entityId);
  await impactWorkflow(web, entityId);
  await impactWorkflow(electron, entityId);

  // identical documents
  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash(), "content hash parity");

  // identical impact cascades through the wire transports
  const cascadeWeb = await valueOf<ImpactCascade>(web, q("impact.cascade", { revision_number: 7 }));
  const cascadeElectron = await valueOf<ImpactCascade>(electron, q("impact.cascade", { revision_number: 7 }));
  assert.equal(cascadeWeb.events_hash, cascadeElectron.events_hash, "impact cascade events_hash parity across hosts");
  assert.equal(
    canonicalStringify(cascadeWeb),
    canonicalStringify(cascadeElectron),
    "impact cascades byte-identical across hosts",
  );
  assert.equal(cascadeWeb.estimate.current.total, cascadeElectron.estimate.current.total);
  assert.equal(cascadeWeb.commercial_impact.total_delta, cascadeElectron.commercial_impact.total_delta);

  // the full downstream event chain is identical, and hangs off the same
  // model.version.created graph event on both hosts
  const graphWeb = await valueOf<{ events_hash: string }>(web, q("model.getGraphEvents"));
  const graphElectron = await valueOf<{ events_hash: string }>(electron, q("model.getGraphEvents"));
  assert.equal(graphWeb.events_hash, graphElectron.events_hash, "graph event parity");
  assert.equal(cascadeWeb.model_event_id, cascadeElectron.model_event_id, "same upstream cause on both hosts");
}

test("web and electron hosts produce byte-identical impact cascades (reference engine)", async () => {
  await assertImpactParity(() => createReferenceAdapterBundle(), "cad007-parity-reference");
});

test("web and electron hosts produce byte-identical impact cascades (real OCCT engine)", { skip: skipEngine }, async () => {
  await assertImpactParity(() => createOcctAdapterBundle(), "cad007-parity-occt");
});
