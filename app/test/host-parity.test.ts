/**
 * Web/Electron host parity (§5.5, LOCK-017).
 *
 * The same semantic command/query sequence through the Web Host and the
 * Electron Host yields identical CADDocument content. The host layer does not
 * introduce divergence; the transport boundary (JSON wire) is lossless for the
 * contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command } from "../src/contracts/app-api.js";
import type { Transport } from "../src/contracts/host.js";
import type { CommandQueryRequest, CommandQueryResponse } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "parity-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "parity-test",
};

const addE1: Command = {
  type: "command",
  name: "document.applyEdit",
  payload: { edit: { type: "addElement", element: { id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } } } },
};
const updateE1: Command = {
  type: "command",
  name: "document.applyEdit",
  payload: { edit: { type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } } },
};
const undo: Command = { type: "command", name: "document.undo", payload: {} };
const redo: Command = { type: "command", name: "document.redo", payload: {} };

async function runSequence(renderer: ReturnType<typeof createRenderer>): Promise<void> {
  await renderer.execute(addE1);
  await renderer.execute(updateE1);
  await renderer.execute(undo);
  await renderer.execute(redo);
}

const noopTransport: Transport = {
  transportId: "noop",
  async send(_r: CommandQueryRequest): Promise<CommandQueryResponse> {
    return { ok: false, code: "noop", message: "parity test uses real transports", retryable: false };
  },
};

test("web and electron hosts converge to identical content hash for the same sequence", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  await runSequence(web);
  await runSequence(electron);
  assert.equal(
    webHandler.currentContentHash(),
    electronHandler.currentContentHash(),
    "Web and Electron hosts diverged on the same command sequence",
  );
});

test("web host exposes no native capabilities (§16)", () => {
  const wh = new WebHost(noopTransport);
  assert.equal(wh.hostId, "web");
  assert.equal(wh.has("file.read"), false);
  assert.equal(wh.has("file.write"), false);
  assert.equal(wh.has("native-worker.exec"), false);
  assert.equal(wh.has("gpu.accelerate"), false);
});

test("electron host exposes the allowlisted native set only (§16)", () => {
  const eh = new ElectronHost(noopTransport);
  assert.equal(eh.hostId, "electron");
  assert.equal(eh.has("file.read"), true);
  assert.equal(eh.has("file.write"), true);
  assert.equal(eh.has("native-worker.exec"), true);
  assert.equal(eh.has("gpu.accelerate"), false); // reserved for a future worker
});

test("transportId differs between hosts (genuine different transports)", () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = new WebHost(new WebSocketTransport(webHandler));
  const electron = new ElectronHost(new IpcTransport(electronHandler));
  assert.notEqual(web.transport.transportId, electron.transport.transportId);
});
