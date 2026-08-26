/**
 * Electron main process — real host bootstrap (CAD-IMPLEMENT-001 / Issue #24
 * remediation for CHANGES_REQUESTED). Architecture v1.1 FROZEN.
 *
 * The chain the Architect required:
 *
 *   Electron main -> BrowserWindow -> shared renderer -> native/local transport
 *     -> shared CAD App API -> dummy adapter
 *
 * What this file proves (all of it runs):
 *
 * - BrowserWindow: `app.whenReady()` creates a real OS window that loads the
 *   shared renderer UI (`dist/renderer/index.html`). Settings are the secure
 *   Electron defaults: `contextIsolation: true`, `nodeIntegration: false`,
 *   `sandbox: false` (so the preload can use the Electron bridge APIs) and a
 *   preload script. The renderer never gets node access (§16).
 *
 * - Shared renderer: the window loads the shared renderer UI
 *   (`apps/electron/src/renderer`), which is the same workspace semantics as
 *   the Web host (`apps/web/src/app/page.tsx`) — SVG canvas + create / add /
 *   undo / redo / save — talking to the App API ONLY through `window.cad.send`
 *   (native IPC), exactly as the Web host talks only through `fetch("/api/cad")`.
 *
 * - Native/local transport: the Electron native IPC boundary
 *   (`ipcRenderer.invoke` -> `ipcMain.handle`). The preload bridge
 *   (`contextBridge`) exposes a tiny `window.cad`; the window's requests cross
 *   the native IPC boundary into this main process.
 *
 * - Shared CAD App API: `ipcMain.handle("cad:send", req => host.transport.send(req))`
 *   where `host = new ElectronHost(new IpcTransport(handler))` — the SAME shared
 *   host-electron layer proven by `app/test/host-parity.test.ts`. The
 *   `IpcTransport` JSON-round-trips the request through the `AppApiHandler`
 *   (the App API) which holds the CADDocument and dispatches to the dummy
 *   `EngineAdapterBundle`.
 *
 * - Dummy adapter: `handler = AppApiHandler.create({ adapterBundle:
 *   DummyAdapterBundle, ... })`. No FreeCAD/OCCT/IfcOpenShell anywhere
 *   (LOCK-003/018); CADDocument is the editor representation (LOCK-019).
 *
 * `createRenderer(host)` (the shared platform-independent renderer core,
 * LOCK-017) is exposed via `cad:render` so the window can ask for the
 * deterministic scene graph for a snapshot — the same scene-hash parity
 * primitive the host-parity test asserts. `cad:contentHash` exposes the
 * handler's current content hash for parity diagnostics.
 *
 * `--smoke` mode: after `did-finish-load`, this main drives the full chain
 * THROUGH the BrowserWindow via `webContents.executeJavaScript("window.cad...")`,
 * asserts each step, writes a JSON result to `$OFFISOS_SMOKE_OUT`, and
 * `app.exit(0|1)`. This is the reproducible Electron smoke evidence.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { AppApiHandler } from "@offisos/cad-app-shell/app-api";
import { createOcctAdapterBundle } from "@offisos/cad-app-shell/adapters/occt";
import { ElectronHost, IpcTransport } from "@offisos/cad-app-shell/host-electron";
import { createRenderer } from "@offisos/cad-app-shell/renderer";
import type { CommandQueryRequest, CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { SceneGraph } from "@offisos/cad-app-shell/contracts/scene";

// CAD-IMPLEMENT-002 / Issue #26: the Electron workspace surface is connected
// to the REAL geometry engine (OCCT 7.8.1.1 via the isolated Python worker —
// the same kernel FreeCAD builds on) behind the frozen EngineAdapterBundle
// boundary. The bundle swap is the ONLY wiring change (LOCK-003). The worker
// spawns lazily per geometry.prepare call (process-per-call isolation,
// wall-clock timeout, typed failures — CAD-005); the CAD-IMPLEMENT-001 smoke
// flow (no geometry.prepare) runs engine-free.
const CONFIG = {
  adapterBundle: createOcctAdapterBundle(),
  entityId: "electron-workspace",
  format: "offisos-occt",
  formatVersion: "1",
  createdBy: "electron-workspace",
};

const isSmoke = process.argv.includes("--smoke");
const isGeometrySmoke = process.argv.includes("--smoke-geometry");
const isModelSmoke = process.argv.includes("--smoke-model");

function createWindow(): BrowserWindow {
  // app.getAppPath() is the directory containing this package's package.json
  // (apps/electron when run via `electron .`). The build emits dist/main/ and
  // dist/renderer/ under it. Using the Electron-native API avoids relying on
  // import.meta.url (empty under CJS) or __dirname (ESM typecheck friction).
  const appRoot = app.getAppPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(appRoot, "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs the Electron contextBridge/ipcRenderer APIs
      spellcheck: false,
    },
  });
  void win.loadFile(join(appRoot, "dist", "renderer", "index.html"));
  return win;
}

/** Wire the native IPC handlers to the shared host + renderer core. */
function registerIpc(): { handler: AppApiHandler; host: ElectronHost } {
  const handler = AppApiHandler.create(CONFIG);
  const host = new ElectronHost(new IpcTransport(handler));
  const renderer = createRenderer(host);

  ipcMain.handle(
    "cad:send",
    (_event, req: CommandQueryRequest): Promise<CommandQueryResponse> => {
      return host.transport.send(req);
    },
  );

  ipcMain.handle(
    "cad:render",
    (_event, snapshot: CADDocumentSnapshot): Promise<SceneGraph> => {
      return Promise.resolve(renderer.render(snapshot));
    },
  );

  ipcMain.handle("cad:contentHash", (): Promise<string> => {
    return Promise.resolve(handler.currentContentHash());
  });

  return { handler, host };
}

interface SmokeStep {
  step: string;
  ok: boolean;
  detail?: unknown;
}
interface SmokeResult {
  ok: boolean;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  steps: SmokeStep[];
  contentHash: unknown;
  sceneHash: unknown;
}

function writeSmokeOut(payload: SmokeResult): void {
  const outPath = process.env.OFFISOS_SMOKE_OUT;
  if (outPath) writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
}

/** Drive the full chain through the BrowserWindow and assert each step. */
async function runSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];
  const exec = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js) as Promise<T>;

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // 1. Preload bridge is exposed in the renderer (window.cad).
  const bridgePresent = await exec<boolean>(
    `(window.cad && typeof window.cad.send === "function" && typeof window.cad.render === "function" && typeof window.cad.contentHash === "function")`,
  );
  steps.push({ step: "preload bridge exposed (window.cad)", ok: !!bridgePresent, detail: !!bridgePresent });
  if (!bridgePresent) {
    writeSmokeOut({ ok: false, electronVersion: process.versions.electron, nodeVersion: process.versions.node, chromeVersion: process.versions.chrome, steps, contentHash: null, sceneHash: null });
    return;
  }

  // 2. document.create through the BrowserWindow -> native IPC -> host -> App API.
  const rCreate = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.create", payload: { entityId: "smoke-doc" } })})`,
  );
  steps.push({ step: "document.create via window.cad", ok: !!(rCreate && rCreate.ok), detail: rCreate && rCreate.ok ? "ok" : rCreate });

  // 3. applyEdit(addElement).
  const rAdd = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement", element: { id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } } } } })})`,
  );
  steps.push({ step: "document.applyEdit(addElement)", ok: !!(rAdd && rAdd.ok), detail: rAdd && rAdd.ok ? "ok" : rAdd });

  // 4. document.getState -> 1 element.
  const rState = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap = rState && rState.ok ? (rState.value as CADDocumentSnapshot | undefined) : undefined;
  const nAfterAdd = snap && Array.isArray(snap.elements) ? snap.elements.length : -1;
  steps.push({ step: "document.getState after add has 1 element", ok: nAfterAdd === 1, detail: `elements=${nAfterAdd}` });

  // 5. window.cad.render(snapshot) -> shared renderer core deterministic scene.
  let sceneHash: string | null = null;
  let sceneNodes = -1;
  if (snap) {
    const scene = await exec<SceneGraph>(`window.cad.render(${JSON.stringify(snap)})`);
    sceneHash = scene && typeof scene.hash === "string" ? scene.hash : null;
    sceneNodes = scene && Array.isArray(scene.nodes) ? scene.nodes.length : -1;
  }
  steps.push({ step: "renderer.render(snapshot) deterministic scene (LOCK-017)", ok: !!sceneHash && sceneNodes === 1, detail: `hash=${sceneHash ? sceneHash.slice(0, 12) : null} nodes=${sceneNodes}` });

  // 6. document.undo -> removes e1.
  const rUndo = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.undo", payload: {} })})`,
  );
  steps.push({ step: "document.undo", ok: !!(rUndo && rUndo.ok), detail: rUndo && rUndo.ok ? "ok" : rUndo });

  // 7. document.getState -> 0 elements (undo reverted content).
  const rState2 = await exec<CommandQueryResponse>(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap2 = rState2 && rState2.ok ? (rState2.value as CADDocumentSnapshot | undefined) : undefined;
  const nAfterUndo = snap2 && Array.isArray(snap2.elements) ? snap2.elements.length : -1;
  steps.push({ step: "document.getState after undo has 0 elements", ok: nAfterUndo === 0, detail: `elements=${nAfterUndo}` });

  // 8. contentHash via native IPC (parity diagnostic).
  const contentHash = await exec<string>(`window.cad.contentHash()`);
  steps.push({ step: "contentHash via native IPC", ok: typeof contentHash === "string" && contentHash.length > 0, detail: typeof contentHash === "string" ? contentHash.slice(0, 12) : contentHash });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: typeof contentHash === "string" ? contentHash : null,
    sceneHash,
  });
}

/** Drive the REAL-ENGINE geometry workflow through the BrowserWindow
 *  (CAD-IMPLEMENT-002 / Issue #26 CHAIN):
 *  BrowserWindow -> window.cad.send -> native IPC -> ElectronHost/IpcTransport
 *    -> AppApiHandler geometry.prepare -> EngineAdapterBundle -> OCCT worker
 *    (disposable Python subprocess) -> deterministic GeometryResult
 *    -> applyEdit(addElement) -> CADDocument -> undo/redo + selection.
 *  Requires the pinned toolchain (python3 + cadquery-ocp) in the environment. */
async function runGeometrySmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Call window.cad.<method> through a rejection-capturing wrapper: the raw
  // executeJavaScript rejection hides the real IPC error behind the generic
  // "Script failed to execute" wrapper — this surfaces the renderer-side
  // rejection reason (message + stack) as a normal value.
  const call = async (js: string): Promise<CommandQueryResponse> => {

    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };

  const send = (payload: unknown): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify({ type: "command", name: "geometry.prepare", payload })})`);

  // 1. Box through the full chain (BrowserWindow -> IPC -> App API -> OCCT worker).
  const box = await send({ geometry: { shape: "box", width: 2, depth: 3, height: 4 } });
  const boxValue = box && box.ok ? (box.value as { meshToken: string; bbox: number[]; mesh: { vertices: unknown[] } | null; metadata: { volume: number } | null; engine: { engineId: string; engineVersion: string } }) : null;
  const boxOk = !!boxValue && boxValue.meshToken.startsWith("occt:") && !!boxValue.mesh && boxValue.mesh.vertices.length === 8 * 3;
  steps.push({ step: "geometry.prepare box through the real engine", ok: boxOk, detail: boxValue ? `token=${boxValue.meshToken.slice(0, 14)}… mesh=${boxValue.mesh ? boxValue.mesh.vertices.length / 3 : 0} verts engine=${boxValue.engine.engineId}@${boxValue.engine.engineVersion}` : box });

  // 2. Volume + bbox correctness (box is exact).
  const boxMetaOk = !!boxValue?.metadata && Math.abs(boxValue.metadata.volume - 24) < 1e-9 && Math.abs(boxValue.bbox[3]! - 2) < 0.01;
  steps.push({ step: "box volume 24 + bbox width 2 (deterministic within tolerance)", ok: boxMetaOk, detail: boxValue ? `volume=${boxValue.metadata ? boxValue.metadata.volume : null} bbox=${JSON.stringify(boxValue.bbox)}` : "no result" });

  // 3. Boolean fuse (box + cylinder) through the same chain.
  const fuse = await send({ geometry: { shape: "fuse", a: { shape: "box", width: 4, depth: 3, height: 2 }, b: { shape: "cylinder", radius: 1, height: 5, origin: [2, 1.5, 0], direction: [0, 0, 1] } } });
  const fuseValue = fuse && fuse.ok ? (fuse.value as { meshToken: string; metadata: { volume: number } | null }) : null;
  const fuseOk = !!fuseValue && fuseValue.meshToken.startsWith("occt:") && !!fuseValue.metadata && fuseValue.metadata.volume > 24;
  steps.push({ step: "geometry.prepare fuse(box, cylinder) through the real engine", ok: fuseOk, detail: fuseValue ? `token=${fuseValue.meshToken.slice(0, 14)}… volume=${fuseValue.metadata ? fuseValue.metadata.volume : null}` : fuse });

  // 4. Determinism: repeat the box prepare -> identical meshToken.
  const boxAgain = await send({ geometry: { shape: "box", width: 2, depth: 3, height: 4 } });
  const boxAgainToken = boxAgain && boxAgain.ok ? (boxAgain.value as { meshToken: string }).meshToken : null;
  const deterministic = !!boxValue && boxAgainToken === boxValue.meshToken;
  steps.push({ step: "determinism: repeated prepare yields the identical meshToken", ok: deterministic, detail: boxAgainToken ? `${boxAgainToken.slice(0, 14)}… === ${boxValue ? boxValue.meshToken.slice(0, 14) : "?"}…` : "no token" });

  // 5. Persist the real geometry result into the CADDocument (the EXISTING workflow).
  if (boxValue) {
    const add = await call(
      `window.cad.send(${JSON.stringify({ type: "command", name: "document.applyEdit", payload: { edit: { type: "addElement", element: { id: "real-box", kind: "geometry", engineId: "occt", props: { geometry: { shape: "box", width: 2, depth: 3, height: 4 }, meshToken: boxValue.meshToken } } } } })})`,
    );
    steps.push({ step: "applyEdit(addElement) with the real occt: meshToken", ok: !!(add && add.ok), detail: add && add.ok ? "ok" : add });
  } else {
    steps.push({ step: "applyEdit(addElement) with the real occt: meshToken", ok: false, detail: "box prepare failed earlier" });
  }

  // 6. getState -> 1 element carrying the occt token.
  const state = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snap = state && state.ok ? (state.value as { elements: { id: string; props: { meshToken?: string } }[] }) : null;
  const oneElement = !!snap && snap.elements.length === 1 && snap.elements[0]!.props.meshToken === (boxValue ? boxValue.meshToken : "");
  steps.push({ step: "document.getState has 1 element with the real meshToken", ok: oneElement, detail: `elements=${snap ? snap.elements.length : -1}` });

  // 7. Selection metadata on the real element (ephemeral, non-versioned).
  const select = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.setSelection", payload: { ids: ["real-box"] } })})`,
  );
  const selected = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getSelection", payload: {} })})`,
  );
  const selectionOk = !!(select && select.ok && selected && selected.ok && JSON.stringify(selected.value) === JSON.stringify(["real-box"]));
  steps.push({ step: "setSelection/getSelection metadata on the real element", ok: selectionOk, detail: selected && selected.ok ? JSON.stringify(selected.value) : selected });

  // 8. Undo removes the real element; redo restores it.
  const undo = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.undo", payload: {} })})`,
  );
  const stateAfterUndo = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snapAfterUndo = stateAfterUndo && stateAfterUndo.ok ? (stateAfterUndo.value as { elements: unknown[] }) : null;
  const undoOk = !!(undo && undo.ok && snapAfterUndo && snapAfterUndo.elements.length === 0);
  steps.push({ step: "undo reverts the real geometry element", ok: undoOk, detail: `elements=${snapAfterUndo ? snapAfterUndo.elements.length : -1}` });

  const redo = await call(
    `window.cad.send(${JSON.stringify({ type: "command", name: "document.redo", payload: {} })})`,
  );
  const stateAfterRedo = await call(
    `window.cad.send(${JSON.stringify({ type: "query", name: "document.getState", payload: {} })})`,
  );
  const snapAfterRedo = stateAfterRedo && stateAfterRedo.ok ? (stateAfterRedo.value as { elements: unknown[] }) : null;
  const redoOk = !!(redo && redo.ok && snapAfterRedo && snapAfterRedo.elements.length === 1);
  steps.push({ step: "redo restores the real geometry element", ok: redoOk, detail: `elements=${snapAfterRedo ? snapAfterRedo.elements.length : -1}` });

  // 9. Typed failure: a malformed descriptor is rejected without crashing the host.
  const bad = await send({ geometry: { shape: "box", width: -1, depth: 1, height: 1 } });
  const badOk = !!bad && bad.ok === false && bad.code === "engine_malformed_input";
  steps.push({ step: "typed failure: malformed descriptor -> engine_malformed_input", ok: badOk, detail: bad && !bad.ok ? `${bad.code} (retryable=${bad.retryable})` : bad });

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

/** Drive the MODEL REVISIONS + Construction Graph bridge workflow through
 *  the BrowserWindow (CAD-IMPLEMENT-003 / Issue #28 CHAIN):
 *  BrowserWindow -> window.cad.send -> native IPC -> ElectronHost/IpcTransport
 *    -> AppApiHandler -> CADDocument (immutable ModelHistory)
 *    -> model.getHistory / model.getGraphEvents / model.replay queries
 *    -> save/open persistence -> revision continuation.
 *  Engine-free (provenance engine ids are plain data), so it runs on any
 *  toolchain. */
async function runModelSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing wrapper (see runGeometrySmoke).
  const call = async (js: string): Promise<CommandQueryResponse> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: CommandQueryResponse } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    call(`window.cad.send(${JSON.stringify(request)})`);

  // 1. document.create with an explicit entity id.
  const create = await send({ type: "command", name: "document.create", payload: { entityId: "model-smoke-doc" } });
  steps.push({ step: "document.create(model-smoke-doc)", ok: !!(create && create.ok), detail: create && create.ok ? "ok" : create });

  // 2-3. Two edits with engine provenance (engineId is data, not an engine call).
  const add1 = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "addElement", element: { id: "e1", kind: "geometry", engineId: "occt", props: { meshToken: "occt:smoke1" } } },
    },
  });
  steps.push({ step: "applyEdit addElement e1 (engine provenance)", ok: !!(add1 && add1.ok), detail: add1 && add1.ok ? "ok" : add1 });
  const add2 = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "addElement", element: { id: "e2", kind: "geometry", engineId: null, props: { meshToken: "dummy-mesh:e2" } } },
    },
  });
  steps.push({ step: "applyEdit addElement e2 (no engine provenance)", ok: !!(add2 && add2.ok), detail: add2 && add2.ok ? "ok" : add2 });

  // 4. undo + redo — both append revisions.
  const undoRes = await send({ type: "command", name: "document.undo", payload: {} });
  const redoRes = await send({ type: "command", name: "document.redo", payload: {} });
  steps.push({ step: "undo + redo through the BrowserWindow", ok: !!(undoRes && undoRes.ok && redoRes && redoRes.ok), detail: "ok" });

  // 5. model.getHistory — 4 immutable revisions with the right notes + linkage.
  const historyRes = await send({ type: "query", name: "model.getHistory", payload: {} });
  type Rev = { revision_number: number; note: string; revision_id: string; from_version_id: string; version: { version_id: string }; delta: { added: string[]; removed: string[]; updated: string[] }; content_hash: string };
  const history = historyRes && historyRes.ok ? (historyRes.value as { entity_id: string; base: { origin: string }; revisions: Rev[] }) : null;
  const notesOk =
    !!history &&
    history.base.origin === "created" &&
    history.revisions.length === 4 &&
    history.revisions.every((r, i) => r.revision_number === i + 1) &&
    history.revisions.map((r) => r.note).join(",") === "edit,edit,undo,redo" &&
    history.revisions[3]!.from_version_id === history.revisions[2]!.version.version_id;
  steps.push({
    step: "model.getHistory: 4 revisions, notes edit,edit,undo,redo, monotonic, linked",
    ok: notesOk,
    detail: history ? `revisions=${history.revisions.length} notes=${history.revisions.map((r) => r.note).join(",")} base=${history.base.origin}` : historyRes,
  });

  // 6. model.getGraphEvents — 1 model.created + 4 model.version.created, chained.
  const eventsRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
  type Evt = { event_id: string; event_type: string; causation_id: string | null; payload: { elements: { element_id: string; change: string; engineId: string | null; uncertainty: { geometry_provenance: string } }[]; revision: { revision_number: number; content_hash: string } } };
  const events = eventsRes && eventsRes.ok ? (eventsRes.value as { events: Evt[]; events_hash: string }) : null;
  const eventsOk =
    !!events &&
    /^[0-9a-f]{64}$/.test(events.events_hash) &&
    events.events.length === 5 &&
    events.events[0]!.event_type === "model.created" &&
    events.events[0]!.causation_id === null &&
    events.events.slice(1).every((e, i) => e.event_type === "model.version.created" && e.causation_id === events.events[i]!.event_id) &&
    events.events[1]!.payload.revision.content_hash === history!.revisions[0]!.content_hash;
  steps.push({
    step: "model.getGraphEvents: model.created + 4 model.version.created, causation-chained",
    ok: eventsOk,
    detail: events ? `events=${events.events.length} hash=${events.events_hash.slice(0, 12)}…` : eventsRes,
  });

  // 7. Graph event provenance: e1 carries engineId occt (OBSERVED), e2 UNKNOWN.
  const e1Add = events?.events.find((e) => e.payload.elements.some((p) => p.element_id === "e1" && p.change === "added"));
  const e2Add = events?.events.find((e) => e.payload.elements.some((p) => p.element_id === "e2" && p.change === "added"));
  const provenanceOk =
    !!e1Add && !!e2Add &&
    e1Add.payload.elements.find((p) => p.element_id === "e1")!.engineId === "occt" &&
    e1Add.payload.elements.find((p) => p.element_id === "e1")!.uncertainty.geometry_provenance === "OBSERVED" &&
    e2Add.payload.elements.find((p) => p.element_id === "e2")!.engineId === null &&
    e2Add.payload.elements.find((p) => p.element_id === "e2")!.uncertainty.geometry_provenance === "UNKNOWN";
  steps.push({ step: "graph events carry engine ids as provenance + uncertainty labels", ok: provenanceOk, detail: provenanceOk ? "e1=OBSERVED e2=UNKNOWN" : "provenance mismatch" });

  // 8. model.replay to revision 2 — verified, elements [e1, e2].
  const replay2 = await send({ type: "query", name: "model.replay", payload: { revision_number: 2 } });
  const replay2Value = replay2 && replay2.ok ? (replay2.value as { revision_number: number; elements: { id: string }[]; content_hash: string; verified: boolean }) : null;
  const replayOk =
    !!replay2Value &&
    replay2Value.verified === true &&
    replay2Value.revision_number === 2 &&
    replay2Value.elements.map((e) => e.id).join(",") === "e1,e2" &&
    replay2Value.content_hash === history!.revisions[1]!.content_hash;
  steps.push({ step: "model.replay(2): verified replay matches the recorded content hash", ok: replayOk, detail: replay2Value ? `elements=${replay2Value.elements.length} hash=${replay2Value.content_hash.slice(0, 12)}…` : replay2 });

  // 9. model.replay out of range — typed bad_payload.
  const replayBad = await send({ type: "query", name: "model.replay", payload: { revision_number: 999 } });
  steps.push({
    step: "model.replay(999) -> typed bad_payload",
    ok: !!(replayBad && replayBad.ok === false && replayBad.code === "bad_payload"),
    detail: replayBad && !replayBad.ok ? replayBad.code : replayBad,
  });

  // 10. save -> open persistence: history + events survive the round-trip.
  const saveRes = await send({ type: "command", name: "document.save", payload: {} });
  const saveBytes = saveRes && saveRes.ok ? (saveRes.value as { bytes: number[] }).bytes : null;
  steps.push({ step: "document.save (bytes carry the revision history)", ok: !!saveBytes && saveBytes.length > 0, detail: `bytes=${saveBytes ? saveBytes.length : 0}` });
  let reopenedOk = false;
  let eventsHashAfter: string | null = null;
  if (saveBytes) {
    const openRes = await send({ type: "command", name: "document.open", payload: { source: saveBytes } });
    const opened = openRes && openRes.ok ? (openRes.value as { modelHistory?: { revisions: unknown[] }; elements: unknown[] }) : null;
    const historyAfterRes = await send({ type: "query", name: "model.getHistory", payload: {} });
    const historyAfter = historyAfterRes && historyAfterRes.ok ? (historyAfterRes.value as { revisions: unknown[] }) : null;
    const eventsAfterRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
    const eventsAfter = eventsAfterRes && eventsAfterRes.ok ? (eventsAfterRes.value as { events_hash: string }) : null;
    eventsHashAfter = eventsAfter ? eventsAfter.events_hash : null;
    reopenedOk =
      !!opened &&
      !!opened.modelHistory &&
      opened.modelHistory.revisions.length === 4 &&
      !!historyAfter && historyAfter.revisions.length === 4 &&
      !!eventsAfter && eventsAfter.events_hash === events!.events_hash;
    steps.push({ step: "document.open(saved bytes): history + events identical after reopen", ok: reopenedOk, detail: reopenedOk ? `revisions=4 events_hash=${eventsHashAfter ? eventsHashAfter.slice(0, 12) : "?"}…` : "mismatch" });
  } else {
    steps.push({ step: "document.open(saved bytes): history + events identical after reopen", ok: false, detail: "save failed" });
  }

  // 11. Revision continuation after reopen: revision 5 links to the reopened head.
  let continuationOk = false;
  if (reopenedOk) {
    const add3 = await send({
      type: "command", name: "document.applyEdit", payload: {
        edit: { type: "addElement", element: { id: "e3", kind: "geometry", engineId: "occt", props: { meshToken: "occt:smoke3" } } },
      },
    });
    const historyFinalRes = await send({ type: "query", name: "model.getHistory", payload: {} });
    const historyFinal = historyFinalRes && historyFinalRes.ok ? (historyFinalRes.value as { revisions: Rev[] }) : null;
    const lastFinal = historyFinal ? historyFinal.revisions[historyFinal.revisions.length - 1] : undefined;
    continuationOk =
      !!(add3 && add3.ok) &&
      !!historyFinal &&
      historyFinal.revisions.length === 5 &&
      !!lastFinal &&
      lastFinal.revision_number === 5 &&
      lastFinal.from_version_id === history!.revisions[3]!.version.version_id &&
      lastFinal.delta.added.join(",") === "e3";
    steps.push({ step: "revision continuation after reopen (r5 links to the reopened head)", ok: continuationOk, detail: continuationOk ? "r5 appended" : historyFinalRes });
  } else {
    steps.push({ step: "revision continuation after reopen (r5 links to the reopened head)", ok: false, detail: "reopen failed" });
  }

  const allOk = steps.every((s) => s.ok);
  writeSmokeOut({
    ok: allOk,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    steps,
    contentHash: null,
    sceneHash: null,
  });
}

app.whenReady().then(() => {
  registerIpc();
  const win = createWindow();

  const smokeRun = isSmoke
    ? runSmoke(win)
    : isGeometrySmoke
      ? runGeometrySmoke(win)
      : isModelSmoke
        ? runModelSmoke(win)
        : null;
  if (smokeRun !== null) {
    smokeRun
      .then(() => {
        // Result written to OFFISOS_SMOKE_OUT inside the smoke; exit code from
        // the result's `ok` is set by the runner via the result file. Quit
        // cleanly either way (the runner reads the file, not the exit code, but
        // we mirror ok -> 0 for hygiene).
        const outPath = process.env.OFFISOS_SMOKE_OUT;
        let ok = true;
        if (outPath) {
          try {
            const data = JSON.parse(readFileSync(outPath, "utf8")) as { ok?: boolean };
            ok = data.ok === true;
          } catch {
            ok = false;
          }
        }
        app.exit(ok ? 0 : 1);
      })
      .catch((e: unknown) => {
        writeSmokeOut({
          ok: false,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
          steps: [{ step: "smoke threw", ok: false, detail: String((e as Error)?.stack || e) }],
          contentHash: null,
          sceneHash: null,
        });
        app.exit(1);
      });
  } else {
    win.webContents.once("did-finish-load", () => win.show());
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
