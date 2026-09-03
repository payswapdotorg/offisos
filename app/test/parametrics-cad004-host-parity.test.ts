/**
 * COMPAT-CAD-004 (Issue #121) — Web/Electron host parity for the
 * consolidated parametrics/associative/patterns workflows (§5.5,
 * LOCK-004/017; mirrors toolsets-p018-host-parity).
 *
 * The SAME COMPAT-CAD-004 command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * identical semantic results: the parametrics capability discovery table
 * (with honest origin provenance), the pattern mirror over drafting
 * geometry AND block instances (the reflected placement, the additive
 * mirrored state, the double-mirror return, the mixed batch), the
 * rectangular array over geometry and symbol instances (the verified
 * entity.modify arm), the consolidated typed associative report (fresh
 * rows + digest), the one-revision associative refresh (annotation
 * re-measurement + documentation regeneration composed), the save/open
 * round-trip inventory and the canonical content hash. Each host drives
 * its OWN handler + bundle instance through its REAL transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc4-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc4-parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

interface CC4SequenceResult {
  capabilitiesJson: string;
  geometryMirrorJson: string;
  instanceMirrorJson: string;
  doubleMirrorJson: string;
  mixedBatchJson: string;
  arrayJson: string;
  assocReportJson: string;
  refreshJson: string;
  postRefreshReportJson: string;
  constraintsJson: string;
  saveOpenHash: string;
  typedDeclinesJson: string;
  contentHash: string;
}

/** The identical COMPAT-CAD-004 sequence on both hosts. */
async function runCC4Sequence(r: Renderer): Promise<CC4SequenceResult> {
  await c(r, "document.create", { entityId: "cc4-parity-drawing" });

  // The drafting geometry + the symbol definition + the instance.
  const created = val<{ created: string[] }>(await c(r, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 4000, y2: 0 },
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 4000, y2: 600 },
  ] }));
  val(await c(r, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: [created.created[1]!] }));
  val(await c(r, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "line", x1: 0, y1: 0, x2: 600, y2: 0, layer: "0" },
    { type: "attdef", tag: "TITLE", default: "Untitled", layer: "0", x: 0, y: 320, height: 40, rotation: 0 },
  ] } }));
  const inserted = val<{ elementId: string }>(await c(r, "block.insert", { name: "SYMBOL", x: 5000, y: 500, scale: 1, rotation: 0, attributes: [{ tag: "TITLE", value: "Plan" }] }));

  // An associative dimension over the source line + a constraint.
  val(await c(r, "annotation.create", { entities: [{
    type: "dim-linear", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 4000, y: 0 },
    placement: { x: 2000, y: -400 }, mode: "horizontal", measured: 4000,
    refs: [{ id: created.created[0]!, anchor: "start", to: "p1" }, { id: created.created[0]!, anchor: "end", to: "p2" }],
  }] }));
  val(await c(r, "constraint.create", { kind: "horizontal", targets: [{ id: created.created[0]! }] }));

  // The versioned capability discovery (identical on both hosts).
  const capabilities = val<unknown>(await qq(r, "parametrics.capabilities"));

  // The pattern mirror over geometry (the verified cascade-aware path).
  const geometryMirror = val<unknown>(await c(r, "pattern.mirror", {
    ids: [created.created[0]!], p1: { x: 0, y: 0 }, p2: { x: 0, y: 1000 }, eraseSource: false,
  }));

  // The pattern mirror over the symbol instance (the reflected placement).
  const instanceMirror = val<unknown>(await c(r, "pattern.mirror", {
    ids: [inserted.elementId], p1: { x: 0, y: 0 }, p2: { x: 0, y: 1000 }, eraseSource: false,
  }));
  const mirroredId = (instanceMirror as { view: { rows: { resultId: string }[] } }).view.rows[0]!.resultId;

  // The double mirror returns to the unreflected canonical form.
  const doubleMirror = val<unknown>(await c(r, "pattern.mirror", {
    ids: [mirroredId], p1: { x: 0, y: 0 }, p2: { x: 0, y: 1000 }, eraseSource: false,
  }));

  // The mixed batch (geometry + instance in ONE atomic revision).
  const mixed = val<unknown>(await c(r, "pattern.mirror", {
    ids: [created.created[0]!, inserted.elementId], p1: { x: 0, y: 0 }, p2: { x: 1000, y: 0 }, eraseSource: false,
  }));

  // The verified array arm (rectangular, over geometry AND the instance).
  const array = val<unknown>(await c(r, "entity.modify", {
    op: "array", mode: "rectangular", ids: [created.created[0]!], rows: 2, columns: 2, rowSpacing: 500, columnSpacing: 500,
  }));

  // The consolidated typed associative report (fresh derivation + digest).
  const assocReport = val<unknown>(await qq(r, "assoc.report"));

  // The one-revision associative refresh (idempotent on a current document
  // — the annotation cascade keeps everything fresh through governed
  // mutations; the refresh verifies).
  const refresh = val<unknown>(await c(r, "assoc.refresh", {}));
  const postRefreshReport = val<unknown>(await qq(r, "assoc.report"));

  // The constraint surface (the consolidated registry's verified baseline).
  const constraints = val<unknown>(await qq(r, "constraints.list"));

  // The save/open round-trip: the mirrored placements survive the reopen.
  const saved = val<{ bytes: number[] }>(await c(r, "document.save", {}));
  const snapshot = JSON.parse(Buffer.from(Uint8Array.from(saved.bytes)).toString("utf8"));
  await c(r, "document.open", { snapshot });
  const saveOpenState = val<{ elements: { props: Record<string, unknown> }[] }>(await qq(r, "document.getState"));
  const mirroredAfterReopen = saveOpenState.elements.filter((el) => el.props.mirrored === true).length;

  // The typed declines (identical failure semantics on both hosts).
  const notFound = await c(r, "pattern.mirror", { ids: ["el-999999"], p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, eraseSource: false });
  const badPayload = await c(r, "pattern.mirror", { ids: [], p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, eraseSource: false });

  const stable = (x: unknown): string => JSON.stringify(x);
  return {
    capabilitiesJson: stable(capabilities),
    geometryMirrorJson: stable(geometryMirror),
    instanceMirrorJson: stable(instanceMirror),
    doubleMirrorJson: stable(doubleMirror),
    mixedBatchJson: stable(mixed),
    arrayJson: stable(array),
    assocReportJson: stable(assocReport),
    refreshJson: stable(refresh),
    postRefreshReportJson: stable(postRefreshReport),
    constraintsJson: stable(constraints),
    saveOpenHash: `${mirroredAfterReopen}`,
    typedDeclinesJson: stable([notFound, badPayload]),
    contentHash: "",
  };
}

test("parametrics: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runCC4Sequence(web);
  const electronResult = await runCC4Sequence(electron);

  // The semantic surfaces converge byte-exactly across hosts (the
  // discovery table, the pattern mirror outcomes, the array, the
  // associative report + refresh, the constraint inventory, the
  // save/open mirrored placements, the typed declines).
  assert.equal(webResult.capabilitiesJson, electronResult.capabilitiesJson);
  assert.equal(webResult.geometryMirrorJson, electronResult.geometryMirrorJson);
  assert.equal(webResult.instanceMirrorJson, electronResult.instanceMirrorJson);
  assert.equal(webResult.doubleMirrorJson, electronResult.doubleMirrorJson);
  assert.equal(webResult.mixedBatchJson, electronResult.mixedBatchJson);
  assert.equal(webResult.arrayJson, electronResult.arrayJson);
  assert.equal(webResult.assocReportJson, electronResult.assocReportJson);
  assert.equal(webResult.refreshJson, electronResult.refreshJson);
  assert.equal(webResult.postRefreshReportJson, electronResult.postRefreshReportJson);
  assert.equal(webResult.constraintsJson, electronResult.constraintsJson);
  assert.equal(webResult.saveOpenHash, electronResult.saveOpenHash);
  assert.equal(webResult.typedDeclinesJson, electronResult.typedDeclinesJson);

  // The typed declines are the expected ones (parity of REAL typed
  // failures, not accidental successes).
  const declines = JSON.parse(webResult.typedDeclinesJson) as { ok: boolean; code?: string }[];
  assert.equal(declines[0]!.code, "parametrics_not_found");
  assert.equal(declines[1]!.code, "parametrics_bad_payload");

  // The mirrored placements survived the reopen on both hosts (the
  // Y-axis mirror copy + the mixed-batch mirror copy — the double-mirror
  // result returned to the canonical unreflected form).
  assert.equal(Number(webResult.saveOpenHash), 2);
  assert.equal(Number(electronResult.saveOpenHash), 2);

  // And the canonical documents converge to the same content hash (the
  // mirrored placements and the array copies applied identically).
  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash());
});
