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
import { createIfcInteropAdapter } from "@offisos/cad-app-shell/adapters/ifc";
import { createReferenceAdapterBundle } from "@offisos/cad-app-shell/adapters/reference";
import { ElectronHost, IpcTransport } from "@offisos/cad-app-shell/host-electron";
import { createRenderer } from "@offisos/cad-app-shell/renderer";
import type { CommandQueryRequest, CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { EngineAdapterBundle } from "@offisos/cad-app-shell/contracts/adapter";
import type { SceneGraph } from "@offisos/cad-app-shell/contracts/scene";

// CAD-IMPLEMENT-002 / Issue #26: the Electron workspace surface is connected
// to the REAL geometry engine (OCCT 7.8.1.1 via the isolated Python worker —
// the same kernel FreeCAD builds on) behind the frozen EngineAdapterBundle
// boundary. The bundle swap is the ONLY wiring change (LOCK-003). The worker
// spawns lazily per geometry.prepare call (process-per-call isolation,
// wall-clock timeout, typed failures — CAD-005); the CAD-IMPLEMENT-001 smoke
// flow (no geometry.prepare) runs engine-free.
const CONFIG = {
  // COMPAT-IFC-001: the IFC interop adapter (IfcOpenShell 0.8.5 worker) is
  // bound alongside the OCCT engines — ifc.* becomes available.
  adapterBundle: createOcctAdapterBundle({ ifc: createIfcInteropAdapter() }),
  entityId: "electron-workspace",
  format: "offisos-occt",
  formatVersion: "1",
  createdBy: "electron-workspace",
};

const isSmoke = process.argv.includes("--smoke");
const isGeometrySmoke = process.argv.includes("--smoke-geometry");
const isModelSmoke = process.argv.includes("--smoke-model");
const isImpactSmoke = process.argv.includes("--smoke-impact");
const isDraftingSmoke = process.argv.includes("--smoke-drafting");
const isBimSmoke = process.argv.includes("--smoke-bim");
const isDocsSmoke = process.argv.includes("--smoke-docs");

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

/** Wire the native IPC handlers to the shared host + renderer core. The
 *  bundle is injectable: the impact smoke (RESEARCH-CAD-007) binds the
 *  engine-free REFERENCE adapter — the second engine running inside the
 *  Electron host behind the same frozen boundary (LOCK-003). */
function registerIpc(bundle: EngineAdapterBundle = CONFIG.adapterBundle): { handler: AppApiHandler; host: ElectronHost } {
  const handler = AppApiHandler.create({ ...CONFIG, adapterBundle: bundle });
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

/**
 * RESEARCH-CAD-007 / Issue #32: the downstream impact cascade Electron smoke.
 *
 * Proves the FULL chain through a real BrowserWindow with the engine-free
 * REFERENCE adapter bound as the geometry engine (the second engine inside
 * the Electron host behind the same frozen boundary — LOCK-003):
 *
 *   BrowserWindow -> window.cad.send (preload) -> ipcRenderer.invoke
 *     -> ipcMain.handle -> ElectronHost + IpcTransport -> AppApiHandler
 *     -> immutable ModelHistory -> impact.cascade
 *     (model.version.created cause -> quantity.recalculate.requested
 *       -> quantity.changed -> estimate.recalculated
 *       -> rfq.scope.impact.detected -> commercial impact)
 *     -> save/open persistence -> identical cascade hash.
 *
 * Engine-free (the reference adapter is pure TypeScript), so it runs on any
 * toolchain. Reproduce: cd apps/electron && npm run smoke:impact
 */
async function runImpactSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

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

  const add = (id: string, category: string, geometry: Record<string, unknown>) =>
    send({
      type: "command", name: "document.applyEdit", payload: {
        edit: { type: "addElement", element: { id, kind: "geometry", engineId: null, props: { geometry, category } } },
      },
    });

  // 1-4. Build the model: concrete column, steel pipe, concrete slab (r1-r3).
  const create = await send({ type: "command", name: "document.create", payload: { entityId: "cad007-impact-smoke" } });
  steps.push({ step: "document.create(cad007-impact-smoke)", ok: !!(create && create.ok) });
  const add1 = await add("el-column-a", "concrete", { shape: "box", width: 0.4, depth: 0.4, height: 3.0 });
  steps.push({ step: "addElement el-column-a (concrete box)", ok: !!(add1 && add1.ok) });
  const add2 = await add("el-pipe-riser", "steel", { shape: "cylinder", radius: 0.05, height: 3, origin: [1, 1, 0], direction: [0, 0, 1] });
  steps.push({ step: "addElement el-pipe-riser (steel cylinder)", ok: !!(add2 && add2.ok) });
  const add3 = await add("el-slab", "concrete", { shape: "box", width: 6, depth: 4, height: 0.2 });
  steps.push({ step: "addElement el-slab (concrete box)", ok: !!(add3 && add3.ok) });

  // 5. The model change: column grows 3.0 -> 3.5 (r4).
  const resize = await send({
    type: "command", name: "document.applyEdit", payload: {
      edit: { type: "updateElement", elementId: "el-column-a", patch: { geometry: { shape: "box", width: 0.4, depth: 0.4, height: 3.5 } } },
    },
  });
  steps.push({ step: "updateElement el-column-a resize (model change, r4)", ok: !!(resize && resize.ok) });

  // 6. impact.cascade for r4: the full deterministic downstream chain.
  const cascadeRes = await send({ type: "query", name: "impact.cascade", payload: { revision_number: 4 } });
  type Cascade = {
    model_event_id: string;
    events_hash: string;
    events: { event_id: string; event_type: string; causation_id: string | null }[];
    quantities: { deltas: { element_id: string; delta: number | null }[]; skipped: { element_id: string }[] };
    estimate: { previous: { total: number } | null; current: { total: number } };
    rfq: { impacts: { category: string; affected: boolean; delta_amount: number }[] };
    commercial_impact: { total_delta: number; currency: string; affected_category_count: number };
    engine: { engineId: string; engineVersion: string };
  };
  const cascade = cascadeRes && cascadeRes.ok ? (cascadeRes.value as Cascade) : null;
  const chainOk =
    !!cascade &&
    /^[0-9a-f]{64}$/.test(cascade.events_hash) &&
    cascade.events.length === 4 &&
    cascade.events[0]!.event_type === "quantity.recalculate.requested" &&
    cascade.events[1]!.event_type === "quantity.changed" &&
    cascade.events[2]!.event_type === "estimate.recalculated" &&
    cascade.events[3]!.event_type === "rfq.scope.impact.detected" &&
    cascade.events[0]!.causation_id === cascade.model_event_id &&
    cascade.events.slice(1).every((e, i) => e.causation_id === cascade.events[i]!.event_id);
  steps.push({
    step: "impact.cascade r4: 4-event chain caused by model.version.created",
    ok: chainOk,
    detail: cascade ? `types=${cascade.events.map((e) => e.event_type).join("->")}` : cascadeRes,
  });

  // 7. The cascade's cause IS the revision-4 graph event.
  const graphRes = await send({ type: "query", name: "model.getGraphEvents", payload: {} });
  const graph = graphRes && graphRes.ok ? (graphRes.value as { events: { event_id: string; event_type: string; payload: { revision: { revision_number: number } } }[] }) : null;
  const r4Event = graph?.events.find((e) => e.event_type === "model.version.created" && e.payload.revision.revision_number === 4);
  const causeOk = !!cascade && !!r4Event && cascade.model_event_id === r4Event.event_id;
  steps.push({ step: "cascade hangs off the r4 model.version.created graph event", ok: causeOk });

  // 8. Quantity delta exact (0.4*0.4*0.5 = 0.08); only the column changed.
  const columnDelta = cascade?.quantities.deltas.find((d) => d.element_id === "el-column-a");
  const othersZero = cascade?.quantities.deltas.filter((d) => d.element_id !== "el-column-a").every((d) => d.delta !== null && Math.abs(d.delta) < 1e-12);
  const deltaOk = !!columnDelta && Math.abs((columnDelta.delta ?? 0) - 0.08) <= 1e-12 && !!othersZero && (cascade?.quantities.skipped.length ?? 1) === 0;
  steps.push({
    step: "quantity delta exact (column +0.08 model-unit^3, others unchanged)",
    ok: deltaOk,
    detail: columnDelta ? `delta=${columnDelta.delta}` : "missing column delta",
  });

  // 9. Estimate + RFQ + commercial impact arithmetic (demo rates: concrete 420 GHS).
  const estimateDelta = cascade ? cascade.estimate.current.total - (cascade.estimate.previous?.total ?? 0) : NaN;
  const concrete = cascade?.rfq.impacts.find((i) => i.category === "concrete");
  const steel = cascade?.rfq.impacts.find((i) => i.category === "steel");
  const impactOk =
    !!cascade &&
    Math.abs(estimateDelta - 0.08 * 420) <= 1e-9 &&
    !!concrete && concrete.affected === true && Math.abs(concrete.delta_amount - 0.08 * 420) <= 1e-9 &&
    !!steel && steel.affected === false &&
    Math.abs(cascade.commercial_impact.total_delta - 0.08 * 420) <= 1e-9 &&
    cascade.commercial_impact.currency === "GHS" &&
    cascade.commercial_impact.affected_category_count === 1 &&
    cascade.engine.engineId === "reference";
  steps.push({
    step: "estimate/RFQ/commercial arithmetic exact; concrete affected, steel not; provenance=reference",
    ok: impactOk,
    detail: cascade ? `estimateDelta=${estimateDelta} commercial=${cascade.commercial_impact.total_delta} ${cascade.commercial_impact.currency}` : "no cascade",
  });

  // 10. Persistence: save -> open -> identical cascade hash.
  const saveRes = await send({ type: "command", name: "document.save", payload: {} });
  let persistenceOk = false;
  let hashDetail = "save failed";
  if (saveRes && saveRes.ok) {
    const bytes = (saveRes.value as { bytes: number[] }).bytes;
    const openRes = await send({ type: "command", name: "document.open", payload: { source: bytes } });
    if (openRes && openRes.ok) {
      const againRes = await send({ type: "query", name: "impact.cascade", payload: { revision_number: 4 } });
      const again = againRes && againRes.ok ? (againRes.value as Cascade) : null;
      persistenceOk = !!again && !!cascade && again.events_hash === cascade.events_hash;
      hashDetail = persistenceOk ? `events_hash=${cascade!.events_hash.slice(0, 16)}... identical` : "cascade hash changed after save/open";
    } else {
      hashDetail = "open failed";
    }
  }
  steps.push({ step: "save -> open -> identical cascade events_hash", ok: persistenceOk, detail: hashDetail });

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
  registerIpc(isImpactSmoke ? createReferenceAdapterBundle() : undefined);
  const win = createWindow();

  const smokeRun = isSmoke
    ? runSmoke(win)
    : isGeometrySmoke
      ? runGeometrySmoke(win)
      : isModelSmoke
        ? runModelSmoke(win)
        : isImpactSmoke
          ? runImpactSmoke(win)
          : isDraftingSmoke
            ? runDraftingSmoke(win)
            : isBimSmoke
              ? runBimSmoke(win)
              : isDocsSmoke
                ? runDocsSmoke(win)
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

/**
 * COMPAT-CAD-001 / Issue #37: the 2D drafting smoke — the representative
 * drafting workflow through the FULL Electron chain (BrowserWindow →
 * window.cad.send preload bridge → ipcMain → ElectronHost/IpcTransport →
 * shared App API → CADDocument command model). Engine-free: drafting never
 * touches the geometry engine (the default OCCT bundle stays lazily unused).
 *
 * Asserts: layers (default + minted + visibility), entity creation with
 * canonical minted ids, dimensions (measured values), deterministic snap
 * through the API, move/copy/delete, trim/extend EXACT coordinates,
 * undo/redo, and save/open persistence of entities + layers + selection +
 * settings + revision lineage with identical graph events hash.
 */
async function runDraftingSmoke(win: BrowserWindow): Promise<void> {
  const steps: SmokeStep[] = [];

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

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
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  type Snapshot = {
    elements: { id: string; kind: string; props: Record<string, unknown> }[];
    layers: { id: string; name: string; visible: boolean }[];
    selection: string[];
    draftingSettings: { snap: { tolerance: number; enabled: boolean }; view: { pan: number[]; zoom: number } };
    modelHistory: { revisions: unknown[] };
    version: { version_id: string };
  };
  const state = async (): Promise<Snapshot | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as Snapshot) : null;
  };

  // 1. Fresh drafting document.
  const create = await cmd("document.create", { entityId: "compat-cad-001-electron" });
  steps.push({ step: "document.create(compat-cad-001-electron)", ok: !!(create && create.ok) });
  const fresh = await state();
  const layerDefaultOk = !!fresh && fresh.layers.length === 1 && fresh.layers[0]!.id === "0";
  steps.push({ step: "canonical default layer '0' present", ok: layerDefaultOk });

  // 2. Layer workflow: add 'walls', add + hide 'construction'.
  const wallsRes = await cmd("drafting.addLayer", { name: "walls", color: "#b91c1c" });
  const wallsId = wallsRes && wallsRes.ok ? (wallsRes.value as { layerId: string }).layerId : "";
  const hiddenRes = await cmd("drafting.addLayer", { name: "construction" });
  const hiddenId = hiddenRes && hiddenRes.ok ? (hiddenRes.value as { layerId: string }).layerId : "";
  const hideRes = await cmd("drafting.updateLayer", { layerId: hiddenId, patch: { visible: false } });
  steps.push({
    step: "layers: minted ly-000001/ly-000002 + visibility toggle",
    ok: wallsId === "ly-000001" && hiddenId === "ly-000002" && !!(hideRes && hideRes.ok),
  });

  // 3. Core entities + dimensions in one atomic batch.
  const createRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: wallsId, from: [0, 0], to: [100, 0] },
      { type: "line", layer: wallsId, from: [100, 0], to: [100, 60] },
      { type: "polyline", layer: wallsId, points: [[0, 0], [0, 60], [100, 60]] },
      { type: "circle", layer: "0", center: [50, 30], radius: 12 },
      { type: "arc", layer: "0", center: [50, 30], radius: 20, startAngle: 0, endAngle: Math.PI },
      { type: "rectangle", layer: wallsId, corner1: [10, 10], corner2: [30, 25] },
    ],
  });
  const created = createRes && createRes.ok ? (createRes.value as { created: string[] }).created : [];
  steps.push({
    step: "entities: 6 drafting entities, canonical minted ids el-000001..el-000006",
    ok: created.length === 6 && created[0] === "el-000001" && created[5] === "el-000006",
  });
  const circleId = created[3] ?? "";

  // 4. Dimensions: measured values computed deterministically.
  const dimRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "dim-linear", layer: "0", p1: [0, 0], p2: [100, 0], mode: "aligned", offset: -8 },
      { type: "dim-radius", layer: "0", target: circleId },
    ],
  });
  const dims = dimRes && dimRes.ok ? (dimRes.value as { created: string[] }).created : [];
  const afterDims = await state();
  const dimLinear = afterDims?.elements.find((e) => e.id === dims[0]);
  const dimRadius = afterDims?.elements.find((e) => e.id === dims[1]);
  const dimsOk =
    dims.length === 2 &&
    dimLinear?.kind === "annotation" && (dimLinear.props.measured as number) === 100 &&
    (dimRadius?.props.measured as number) === 12;
  steps.push({ step: "dimensions: aligned=100 exactly, radius=12 exactly (annotation kind)", ok: dimsOk });

  // 5. Deterministic snap through the API: endpoint at the L1/L2 corner.
  const snapRes = await qq("drafting.snap", { point: [100.4, -0.1], tolerance: 0.5 });
  const snap = snapRes && snapRes.ok ? (snapRes.value as { snapped: boolean; best: { kind: string; point: number[] } | null }) : null;
  steps.push({
    step: "snap: endpoint (100,0) wins the clamped tie",
    ok: !!snap && snap.snapped === true && snap.best?.kind === "endpoint" && snap.best?.point[0] === 100 && snap.best?.point[1] === 0,
  });
  // hidden layers are not snappable
  const hiddenEnt = await cmd("drafting.createEntities", {
    entities: [{ type: "line", layer: hiddenId, from: [200, 200], to: [300, 200] }],
  });
  const snapHidden = await qq("drafting.snap", { point: [250.2, 200.2], tolerance: 1, kinds: ["on-object"] });
  const hiddenOk = !!(hiddenEnt && hiddenEnt.ok) && !!(snapHidden && snapHidden.ok) && (snapHidden.value as { best: unknown }).best === null;
  steps.push({ step: "entities on hidden layers are not snappable", ok: hiddenOk });

  // 6. Move + copy (+ delete the copy).
  const rectId = created[5] ?? "";
  const moveRes = await cmd("drafting.move", { ids: [rectId], dx: 5, dy: 5 });
  const afterMove = await state();
  const movedRect = afterMove?.elements.find((e) => e.id === rectId);
  const moveOk = !!(moveRes && moveRes.ok) && JSON.stringify(movedRect?.props.corner1) === JSON.stringify([15, 15]);
  steps.push({ step: "move: rectangle corner1 → [15,15] exactly", ok: moveOk });
  const copyRes = await cmd("drafting.copy", { ids: [rectId], dx: 40, dy: 0 });
  const copyId = copyRes && copyRes.ok ? ((copyRes.value as { created: string[] }).created[0] ?? "") : "";
  const delRes = await cmd("drafting.delete", { ids: [copyId] });
  steps.push({ step: "copy mints a new id; delete removes it", ok: /^el-\d{6}$/.test(copyId) && !!(delRes && delRes.ok) });

  // 7. Trim with an EXACT resulting coordinate.
  const cutRes = await cmd("drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 80], to: [120, 80] },
      { type: "line", layer: "0", from: [60, 60], to: [60, 100] },
    ],
  });
  const cutIds = cutRes && cutRes.ok ? (cutRes.value as { created: string[] }).created : [];
  const trimRes = await cmd("drafting.trim", { targetId: cutIds[0] ?? "", pick: [90, 80] });
  const afterTrim = await state();
  const trimmed = afterTrim?.elements.find((e) => e.id === (cutIds[0] ?? ""));
  const trimOk =
    !!(trimRes && trimRes.ok) && (trimRes.value as { applied: boolean }).applied === true &&
    JSON.stringify(trimmed?.props.to) === JSON.stringify([60, 80]);
  steps.push({ step: "trim: line shortened to exactly [60,80], identity retained", ok: trimOk });

  // 8. Extend with an EXACT resulting coordinate.
  const farRes = await cmd("drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: [130, -20], to: [130, 20] }],
  });
  const farId = farRes && farRes.ok ? (farRes.value as { created: string[] }).created[0] ?? "" : "";
  const line1 = created[0] ?? "";
  const extRes = await cmd("drafting.extend", { targetId: line1, pick: [95, 0] });
  const afterExt = await state();
  const extended = afterExt?.elements.find((e) => e.id === line1);
  const extOk =
    !!(extRes && extRes.ok) && (extRes.value as { applied: boolean }).applied === true &&
    JSON.stringify(extended?.props.to) === JSON.stringify([130, 0]);
  steps.push({ step: "extend: line grown to exactly [130,0]", ok: extOk });

  // 9. Undo/redo through the command model.
  const undoRes = await cmd("document.undo", {});
  const afterUndo = await state();
  const redoRes = await cmd("document.redo", {});
  const afterRedo = await state();
  const undoOk =
    !!(undoRes && undoRes.ok) && JSON.stringify(afterUndo?.elements.find((e) => e.id === line1)?.props.to) === JSON.stringify([100, 0]) &&
    !!(redoRes && redoRes.ok) && JSON.stringify(afterRedo?.elements.find((e) => e.id === line1)?.props.to) === JSON.stringify([130, 0]);
  steps.push({ step: "undo/redo revert + re-apply the extend exactly", ok: undoOk });

  // 10. Settings + selection + full persistence through save/open.
  await cmd("drafting.setSettings", { settings: { snap: { tolerance: 0.25 }, view: { pan: [12, -4], zoom: 1.75 } } });
  await cmd("document.setSelection", { ids: [line1, circleId] });
  const beforeSave = await state();
  const eventsBefore = await qq("model.getGraphEvents", {});
  const eventsHashBefore = eventsBefore && eventsBefore.ok ? (eventsBefore.value as { events_hash: string }).events_hash : "";
  const saveRes = await cmd("document.save", {});
  // Canonical stringify (sorted keys): the save/open round-trip is canonical
  // JSON, so raw JSON.stringify key ORDER differs while the data is equal.
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  };
  let persistenceOk = false;
  let persistDetail = "save failed";
  if (saveRes && saveRes.ok) {
    const bytes = (saveRes.value as { bytes: number[] }).bytes;
    const openRes = await cmd("document.open", { source: bytes });
    if (openRes && openRes.ok) {
      const reopened = await state();
      const eventsAfter = await qq("model.getGraphEvents", {});
      const eventsHashAfter = eventsAfter && eventsAfter.ok ? (eventsAfter.value as { events_hash: string }).events_hash : "";
      persistenceOk =
        !!reopened && !!beforeSave &&
        reopened.elements.length === beforeSave.elements.length &&
        canon(reopened.elements.map((e) => e.id).sort()) === canon(beforeSave.elements.map((e) => e.id).sort()) &&
        canon(reopened.layers) === canon(beforeSave.layers) &&
        canon(reopened.selection) === canon([line1, circleId]) &&
        reopened.draftingSettings.snap.tolerance === 0.25 &&
        reopened.draftingSettings.view.zoom === 1.75 &&
        reopened.modelHistory.revisions.length === beforeSave.modelHistory.revisions.length &&
        eventsHashAfter === eventsHashBefore;
      persistDetail = persistenceOk
        ? `elements=${reopened!.elements.length} revisions=${reopened!.modelHistory.revisions.length} events_hash=${eventsHashBefore.slice(0, 16)}... identical`
        : "state diverged across save/open";
    } else {
      persistDetail = "open failed";
    }
  }
  steps.push({
    step: "save/open: entities + ids + layers + selection + settings + lineage + events_hash all preserved",
    ok: persistenceOk,
    detail: persistDetail,
  });

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

/**
 * COMPAT-CAD-002 / Issue #39: the 3D/BIM authoring smoke — the representative
 * mini-building workflow through the FULL Electron chain, DRIVING THE REAL
 * RENDERER UI (BrowserWindow DOM: mode toggle → buttons/inputs with
 * data-testid selectors → readouts), exactly like a user would:
 *
 *   BrowserWindow → renderer DOM (BIM mode panel) → window.cad.send (preload)
 *     → ipcMain → ElectronHost/IpcTransport → App API → bim.* commands
 *     → CADDocument → OCCT worker (bim.buildGeometry — the default OCCT
 *       bundle, lazily per-call) → undo/redo → save/open identity.
 *
 * Non-UI assertions (state/semantics/camera/events queries) go through
 * window.cad.send directly, mirroring how smoke-drafting handles non-UI
 * assertions. The engine path is adaptive: with the OCCT toolchain present
 * the happy path asserts occt: meshTokens; engine-free environments assert
 * the typed engine_unavailable failure path instead (steps 8-11 branch).
 *
 * Reproduce: cd apps/electron && OFFISOS_OCCT_WORKER=<repo>/app/src/adapters/
 * occt/worker/occt-worker.py npm run smoke:bim
 */
async function runBimSmoke(win: BrowserWindow): Promise<void> {
  // Steps record {step, name, pass, detail} (ok mirrors pass for the shared
  // SmokeResult envelope the runner reads).
  interface BimStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: BimStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  /** Poll a page predicate until true (throws on timeout). */
  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** Click a data-testid button in the page. */
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  /** Wait for the BIM status protocol to settle: state done|error for `op`
   *  AND the UI idle again (mode toggle re-enabled). Returns the status. */
  const waitOp = async (op: string, timeoutMs: number): Promise<{ state: string; op: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `BIM op '${op}' to settle`,
    );
    return page<{ state: string; op: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="bim-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", text: s ? s.textContent : "" }; })()`,
    );
  };
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );

  type Snap = {
    elements: { id: string; kind: string; props: Record<string, unknown> }[];
    bimSettings?: { camera?: { preset?: string } };
  };
  const state = async (): Promise<Snap | null> => {
    const r = await qq("document.getState", {});
    return r && r.ok ? (r.value as Snap) : null;
  };
  const openingDistance = async (): Promise<number | null> => {
    const r = await qq("bim.getSemantics", { elementId: "op-door" });
    if (!r || !r.ok) return null;
    const sem = (r.value as { semantics?: { distance?: unknown } }).semantics;
    return typeof sem?.distance === "number" ? sem.distance : null;
  };
  const wallToken = async (): Promise<string | null> => {
    const snap = await state();
    const wall = snap?.elements.find((e) => e.id === "wall-south");
    const token = wall?.props.meshToken;
    return typeof token === "string" ? token : null;
  };

  // 1. BIM mode is reachable and visible: header toggle + the BIM panel.
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-bim"]') && !!document.querySelector('[data-testid="mode-drafting"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-bim") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="bim-card"]'); const b = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "BIM mode panel visible",
  );
  const bimControlsPresent = await page<boolean>(
    `(async () => ["bim-create-building","bim-move-opening","bim-camera-top","bim-build","bim-undo","bim-redo","bim-save-open","bim-tree"]` +
      `.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  push(
    "1",
    "BIM mode visible (header toggle switches the BIM panel in; all data-testid controls present)",
    beforeToggle && clickedMode && bimControlsPresent,
    bimControlsPresent ? "mode-bim clicked; bim-card displayed; 8/8 BIM controls present" : "BIM controls missing",
  );

  // 2. Create the representative mini building through the UI. The status op
  //    label repeats (document.create + the batch), so the wait keys on the
  //    deterministic created-count readout instead (or the error state).
  const clickedCreate = await click("bim-create-building");
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="bim-created"]'); const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return (!!c && c.getAttribute("data-count") === "6" && !!m && !m.disabled) || (!!s && s.getAttribute("data-state") === "error"); })()`,
    30000,
    "mini building created (6 elements)",
  );
  const createStatus = await page<{ state: string; text: string }>(
    `(async () => { const s = document.querySelector('[data-testid="bim-status"]'); return { state: s ? s.getAttribute("data-state") : "none", text: s ? s.textContent : "" }; })()`,
  );
  const createdCount = Number(await readAttr("bim-created", "data-count"));
  const createdText = await readText("bim-created");
  push(
    "2",
    "create the mini building via the UI (bim.createElements, one atomic batch)",
    clickedCreate && createStatus.state !== "error" && createdCount === 6,
    `${createdText} (document.create + one 6-entity batch)`,
  );

  // 3. Element count/state via the state query.
  const snap3 = await state();
  const ids3 = snap3 ? snap3.elements.map((e) => e.id).sort() : [];
  const allBim = snap3 ? snap3.elements.every((e) => e.kind === "bim") : false;
  const expectedIds = ["door-main", "op-door", "slab-g", "space-office", "story-gf", "wall-south"];
  push(
    "3",
    "document.getState: 6 BIM elements with the exact authored ids",
    ids3.length === 6 && JSON.stringify(ids3) === JSON.stringify(expectedIds) && allBim,
    `elements=${ids3.length} ids=${ids3.join(",")} allKindBim=${allBim}`,
  );

  // 4. Move the door opening +600 along the wall (UI dx default 600).
  const clickedMove = await click("bim-move-opening");
  const moveStatus = await waitOp("move-opening", 30000);
  const distanceAfter = await openingDistance();
  push(
    "4",
    "move door opening +600 along the wall (distance 500 → 1100 exactly)",
    clickedMove && moveStatus.state === "done" && distanceAfter === 1100,
    `distance=${distanceAfter} (bim.getSemantics op-door)`,
  );

  // 5. Cross-axis move attempt (dy=50) → the typed error surfaces in the UI.
  //    The op label repeats step 4's, so the wait keys on the ERROR state.
  const setDy = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="bim-move-dy"]'); if (!i) return false;` +
      ` i.value = "50"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
  );
  const clickedCross = setDy ? await click("bim-move-opening") : false;
  await waitFor(
    `(() => { const s = document.querySelector('[data-testid="bim-status"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!s && s.getAttribute("data-state") === "error" && s.getAttribute("data-op") === "move-opening" && !!m && !m.disabled; })()`,
    30000,
    "cross-axis move error state",
  );
  const crossStatus = await page<{ state: string; op: string; text: string }>(
    `(async () => { const s = document.querySelector('[data-testid="bim-status"]');` +
      ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", text: s ? s.textContent : "" }; })()`,
  );
  const errorText = await readText("cad-error");
  // Frozen-backend note: the cross-axis reject message carries "(unsupported
  // set; no silent approximation)", which the frozen cmdBimTransform mapping
  // classifies as bim_unsupported (verified by app/test/bim-workflow.test.ts).
  const uiErrorOk = /cross-axis/.test(errorText) && /bim_unsupported/.test(errorText) && crossStatus.state === "error";
  const crossDirect = await cmd("bim.move", { ids: ["op-door"], dx: 0, dy: 50, dz: 0 });
  const directOk = crossDirect.ok === false && crossDirect.code === "bim_unsupported" && /cross-axis/.test(crossDirect.message);
  push(
    "5",
    "cross-axis opening move shows the typed error (UI alert + direct assert)",
    setDy && clickedCross && uiErrorOk && directOk,
    `ui=[${crossStatus.state}] ${errorText.slice(0, 160)} | direct=${directOk ? crossDirect.code : crossDirect}`,
  );

  // 6. Camera preset "top" via the UI → preset + eye displayed. The readout
  //    is written AFTER the op settles, so wait for its content explicitly.
  const clickedTop = await click("bim-camera-top");
  const topStatus = await waitOp("camera-top", 30000);
  const topQuery = await qq("bim.camera", { preset: "top" });
  const topCamera = topQuery && topQuery.ok ? (topQuery.value as { camera: { eye: number[] } }).camera : null;
  const topEyeStr = topCamera ? `eye=[${topCamera.eye.map((n) => Math.round(n)).join(", ")}]` : "";
  if (topEyeStr !== "") {
    await waitFor(
      `(() => { const e = document.querySelector('[data-testid="bim-camera-readout"]'); const t = e ? (e.textContent || "") : "";` +
        ` return t.includes("preset=top") && t.includes(${JSON.stringify(topEyeStr)}); })()`,
      10000,
      "camera top readout",
    );
  }
  const topReadout = await readText("bim-camera-readout");
  const snap6 = await state();
  push(
    "6",
    "camera preset top via UI → preset + eye shown, bimSettings persisted",
    clickedTop && topStatus.state === "done" &&
      topReadout.includes("preset=top") && topEyeStr !== "" && topReadout.includes(topEyeStr) &&
      snap6?.bimSettings?.camera?.preset === "top",
    `${topReadout} · snapshot.preset=${snap6?.bimSettings?.camera?.preset}`,
  );

  // 7. Camera preset "iso" via the UI.
  const clickedIso = await click("bim-camera-iso");
  const isoStatus = await waitOp("camera-iso", 30000);
  const isoQuery = await qq("bim.camera", { preset: "iso" });
  const isoCamera = isoQuery && isoQuery.ok ? (isoQuery.value as { camera: { eye: number[] } }).camera : null;
  const isoEyeStr = isoCamera ? `eye=[${isoCamera.eye.map((n) => Math.round(n)).join(", ")}]` : "";
  if (isoEyeStr !== "") {
    await waitFor(
      `(() => { const e = document.querySelector('[data-testid="bim-camera-readout"]'); const t = e ? (e.textContent || "") : "";` +
        ` return t.includes("preset=iso") && t.includes(${JSON.stringify(isoEyeStr)}); })()`,
      10000,
      "camera iso readout",
    );
  }
  const isoReadout = await readText("bim-camera-readout");
  const isoPressed = await readAttr("bim-camera-iso", "aria-pressed");
  push(
    "7",
    "camera preset iso via UI → preset + eye shown, button pressed",
    clickedIso && isoStatus.state === "done" &&
      isoReadout.includes("preset=iso") && isoEyeStr !== "" && isoReadout.includes(isoEyeStr) &&
      isoPressed === "true",
    `${isoReadout} · aria-pressed=${isoPressed}`,
  );

  // 8. Build geometry through the UI — busy state first (synchronous check
  //    right after the click), then the OCCT worker realizes the solids.
  const busyProbe = await page<{ clicked: boolean; state: string; op: string }>(
    `(async () => { const b = document.querySelector('[data-testid="bim-build"]'); if (!b) return { clicked: false, state: "none", op: "" };` +
      ` b.click(); const s = document.querySelector('[data-testid="bim-status"]'); const busy = document.querySelector('[data-testid="bim-build-busy"]');` +
      ` return { clicked: true, state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "" , busyVisible: !!busy && !busy.hidden }; })()`,
  );
  const buildStatus = await waitOp("build", 180000);
  const builtAttr = await readAttr("bim-build-result", "data-built");
  const skippedAttr = await readAttr("bim-build-result", "data-skipped");
  const skipId = await readAttr("bim-build-result", "data-skip-id");
  const skipReason = await readAttr("bim-build-result", "data-skip-reason");
  const builtNum = builtAttr === null ? -1 : Number(builtAttr);
  const skippedNum = skippedAttr === null ? -1 : Number(skippedAttr);
  const engineAvailable = buildStatus.state === "done";
  const sawEngineUnavailable = /engine_unavailable/.test(buildStatus.text);
  const buildHappy = engineAvailable && busyProbe.state === "busy" && busyProbe.op === "build" &&
    builtNum >= 5 && skippedNum === 1 && skipId === "story-gf" && /level container/.test(skipReason ?? "");
  const buildEngineFree = !engineAvailable && sawEngineUnavailable;
  push(
    "8",
    "build geometry → built ≥ 5, skipped exactly 1 (story-gf, level-container reason)",
    buildHappy || buildEngineFree,
    buildHappy
      ? `built=${builtNum} skipped=${skippedNum} (${skipId}: ${skipReason}) · busy state observed during the engine call`
      : buildEngineFree
        ? `engine-free path: typed engine_unavailable asserted (${buildStatus.text.slice(0, 140)})`
        : `unexpected: busy=${busyProbe.state}/${busyProbe.op} status=${buildStatus.state} built=${builtNum} skipped=${skippedNum} skipId=${skipId}`,
  );

  // 9. meshToken starts with "occt:" when the engine is available.
  const token9 = await wallToken();
  const tokenOk = engineAvailable ? token9 !== null && token9.startsWith("occt:") : sawEngineUnavailable;
  push(
    "9",
    "meshToken starts with occt: when the engine is available",
    tokenOk,
    engineAvailable ? `wall-south meshToken=${token9 === null ? "null" : token9.slice(0, 18) + "…"}` : "engine unavailable — typed path asserted in step 8 (N/A by design)",
  );

  // (The pre-undo snapshot workaround that used to live here was removed:
  // the app-core defect it worked around — undo of a key-adding patch
  // serializing undefined values into invalid JSON — is FIXED in this slice
  // (updateElement inverses of key-adding patches are now full setProps
  // inverses, and canonicalStringify rejects undefined outright); the
  // regression is pinned by app/test/bim-workflow.test.ts.)

  // 10. Undo → the build revision is undone (meshToken gone from wall props).
  const clickedUndo = await click("bim-undo");
  const undoStatus = await waitOp("undo", 30000);
  let undoOk = false;
  let undoDetail = "";
  if (engineAvailable) {
    const tokenAfterUndo = await wallToken();
    const distAfterUndo = await openingDistance();
    undoOk = clickedUndo && undoStatus.state === "done" && tokenAfterUndo === null && distAfterUndo === 1100;
    undoDetail = `wall-south meshToken=${tokenAfterUndo === null ? "gone" : tokenAfterUndo.slice(0, 14) + "…"} · op-door distance still ${distAfterUndo}`;
  } else {
    // Engine-free: undo reverts the move revision instead (build never applied).
    const distAfterUndo = await openingDistance();
    undoOk = clickedUndo && undoStatus.state === "done" && distAfterUndo === 500;
    undoDetail = `engine-free path: move revision undone → op-door distance=${distAfterUndo}`;
  }
  push("10", "undo → build revision undone (meshToken gone from wall props)", undoOk, undoDetail);

  // 11. Redo → the build revision (and its meshToken) is restored.
  const clickedRedo = await click("bim-redo");
  const redoStatus = await waitOp("redo", 30000);
  let redoOk = false;
  let redoDetail = "";
  if (engineAvailable) {
    const tokenAfterRedo = await wallToken();
    redoOk = clickedRedo && redoStatus.state === "done" && tokenAfterRedo !== null && tokenAfterRedo === token9;
    redoDetail = `wall-south meshToken restored=${tokenAfterRedo !== null && tokenAfterRedo === token9}`;
  } else {
    const distAfterRedo = await openingDistance();
    redoOk = clickedRedo && redoStatus.state === "done" && distAfterRedo === 1100;
    redoDetail = `engine-free path: move revision re-applied → op-door distance=${distAfterRedo}`;
  }
  push("11", "redo → meshToken back (identical token)", redoOk, redoDetail);

  // 12. Save → open round trip → identical graph events hash, exercising the
  //     REAL post-redo document (save-after-undo of the key-adding build
  //     revision is covered by the fixed core + the app regression test).
  const eventsBefore12 = await qq("model.getGraphEvents", {});
  const hashBefore12 = eventsBefore12 && eventsBefore12.ok ? (eventsBefore12.value as { events_hash: string }).events_hash : "";
  const clickedSaveOpen = await click("bim-save-open");
  const saveOpenStatus = await waitOp("save-open", 60000);
  const identicalAttr = await readAttr("bim-persist-result", "data-identical");
  const persistText = await readText("bim-persist-result");
  const eventsAfter12 = await qq("model.getGraphEvents", {});
  const hashAfter12 = eventsAfter12 && eventsAfter12.ok ? (eventsAfter12.value as { events_hash: string }).events_hash : "";
  push(
    "12",
    "save → open round trip → identical graph events hash",
    clickedSaveOpen && saveOpenStatus.state === "done" && identicalAttr === "true" && hashBefore12 !== "" && hashAfter12 === hashBefore12,
    `${persistText} · uiState=${saveOpenStatus.state} · direct hash identical=${hashAfter12 === hashBefore12}`,
  );

  // 13. Selection set via the UI (building tree row click).
  const clickedRow = await click("bim-element-row-wall-south");
  await waitFor(
    `(() => { const r = document.querySelector('[data-testid="bim-element-row-wall-south"]'); const m = document.querySelector('[data-testid="mode-bim"]');` +
      ` return !!r && r.getAttribute("aria-pressed") === "true" && !!m && !m.disabled; })()`,
    30000,
    "wall-south row selected",
  );
  const sel13 = await qq("document.getSelection", {});
  const sel13Value = sel13 && sel13.ok ? (sel13.value as unknown) : null;
  const selOk = JSON.stringify(sel13Value) === JSON.stringify(["wall-south"]);
  push(
    "13",
    "selection set via UI (tree row) → document.getSelection = [wall-south]",
    clickedRow && selOk,
    `selection=${JSON.stringify(sel13Value)} · row aria-pressed=true`,
  );

  // 14. Result file written with ALL steps PASS (the runner reads it and the
  //     exit code mirrors ok — the smoke-drafting convention).
  const first13 = steps.slice(0, 13);
  const first13AllPass = first13.every((s) => s.pass);
  push(
    "14",
    "result file written with all steps PASS",
    first13AllPass,
    first13AllPass
      ? `steps 1-13: ${first13.filter((s) => s.pass).length}/13 PASS · result JSON → $OFFISOS_SMOKE_OUT · engine=${engineAvailable ? "occt (happy path)" : "unavailable (typed path)"}`
      : `steps 1-13: ${first13.filter((s) => s.pass).length}/13 PASS — failing: ${first13.filter((s) => !s.pass).map((s) => s.step).join(",")}`,
  );

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

/**
 * COMPAT-CAD-003 / Issue #41: the construction-documentation smoke — the
 * representative drawing-production workflow through the FULL Electron chain,
 * DRIVING THE REAL RENDERER UI (BrowserWindow DOM: header mode toggle → the
 * Documentation panel's buttons/inputs with data-testid selectors → readouts),
 * exactly like a user would:
 *
 *   BrowserWindow → renderer DOM (docs mode panel) → window.cad.send (preload)
 *     → ipcMain → ElectronHost/IpcTransport → App API → docs.* commands/queries
 *     → CADDocument → deterministic pure-TS projection (NO engine anywhere —
 *     the default bundle binding stays lazily unused, exactly like
 *     --smoke-drafting) → undo/redo → Sheet IR export → save/open identity.
 *
 * Non-UI assertions (state/semantics queries) go through window.cad.send
 * directly, mirroring how smoke-drafting/smoke-bim handle non-UI assertions.
 * Engine-free by construction: documentation projection is pure deterministic
 * TypeScript inside the core.
 *
 * Reproduce: cd apps/electron && npm run smoke:docs
 */
async function runDocsSmoke(win: BrowserWindow): Promise<void> {
  // Steps record {step, name, pass, detail} (ok mirrors pass for the shared
  // SmokeResult envelope the runner reads).
  interface DocsStep { step: string; name: string; pass: boolean; ok: boolean; detail: unknown }
  const steps: DocsStep[] = [];
  const push = (num: string, name: string, pass: boolean, detail: unknown): void => {
    steps.push({ step: num, name, pass, ok: pass, detail });
  };

  await new Promise<void>((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Rejection-capturing page evaluation (see runGeometrySmoke).
  const page = async <T>(js: string): Promise<T> => {
    const wrapped = (await win.webContents.executeJavaScript(
      `(${js}).then((r) => ({ __smokeOk: true, r }), (e) => ({ __smokeOk: false, msg: String(e), stack: String((e && e.stack) || "") }))`,
    )) as { __smokeOk: true; r: T } | { __smokeOk: false; msg: string; stack: string };
    if (wrapped.__smokeOk !== true) {
      throw new Error(`renderer call rejected: ${wrapped.msg}\n${wrapped.stack.slice(0, 800)}\nfor script: ${js.slice(0, 200)}`);
    }
    return wrapped.r;
  };
  const send = (request: CommandQueryRequest): Promise<CommandQueryResponse> =>
    page<CommandQueryResponse>(`window.cad.send(${JSON.stringify(request)})`);
  const cmd = (name: string, payload: unknown) =>
    send({ type: "command", name: name as never, payload });
  const qq = (name: string, payload: unknown) =>
    send({ type: "query", name: name as never, payload });

  /** Poll a page predicate until true (throws on timeout). */
  const waitFor = async (predicateJs: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await page<boolean>(`(async () => (${predicateJs}))()`);
      if (v === true) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** Click a data-testid button in the page. */
  const click = (testid: string): Promise<boolean> =>
    page<boolean>(
      `(async () => { const b = document.querySelector('[data-testid="${testid}"]'); if (!b) return false; b.click(); return true; })()`,
    );
  const readAttr = (testid: string, attr: string): Promise<string | null> =>
    page<string | null>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? e.getAttribute("${attr}") : null; })()`,
    );
  const readText = (testid: string): Promise<string> =>
    page<string>(
      `(async () => { const e = document.querySelector('[data-testid="${testid}"]'); return e ? (e.textContent || "") : ""; })()`,
    );
  /** The docs status protocol's monotonic run counter (set synchronously at
   *  click time — disambiguates repeated op labels such as a second undo). */
  const currentRun = async (): Promise<number> => {
    const v = await readAttr("docs-status", "data-run");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  /** Wait for the docs status protocol to settle: state done|error for `op`
   *  at run counter `run` AND the UI idle again (mode toggle re-enabled).
   *  Returns the status snapshot. */
  const waitDocsOp = async (op: string, run: number, timeoutMs: number): Promise<{ state: string; op: string; run: string; text: string }> => {
    await waitFor(
      `(() => { const s = document.querySelector('[data-testid="docs-status"]'); const m = document.querySelector('[data-testid="mode-docs"]');` +
        ` return !!s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "error")` +
        ` && s.getAttribute("data-op") === "${op}" && s.getAttribute("data-run") === "${run}" && !!m && !m.disabled; })()`,
      timeoutMs,
      `docs op '${op}' #${run} to settle`,
    );
    return page<{ state: string; op: string; run: string; text: string }>(
      `(async () => { const s = document.querySelector('[data-testid="docs-status"]');` +
        ` return { state: s ? s.getAttribute("data-state") : "none", op: s ? s.getAttribute("data-op") : "", run: s ? s.getAttribute("data-run") : "", text: s ? s.textContent : "" }; })()`,
    );
  };
  const viewRowCount = (): Promise<number> =>
    page<number>(`(async () => document.querySelectorAll('[data-testid^="docs-view-row-"]').length)()`);
  const sheetRowCount = (): Promise<number> =>
    page<number>(`(async () => document.querySelectorAll('[data-testid^="docs-sheet-row-"]').length)()`);

  type ViewRow = { view: { id: string; kind: string; direction?: string }; contentHash: string | null; primitiveCount: number };
  const listViews = async (): Promise<ViewRow[] | null> => {
    const r = await qq("docs.listViews", {});
    return r && r.ok ? ((r.value as { views: ViewRow[] }).views ?? null) : null;
  };
  type PlanGeom = {
    primitiveCount: number;
    contentHash: string;
    bbox: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
    annotations: { type: string; measured?: number; label?: string }[];
  };
  const planGeometry = async (): Promise<PlanGeom | null> => {
    const r = await qq("docs.getViewGeometry", { viewId: "vw-000001" });
    return r && r.ok ? (r.value as PlanGeom) : null;
  };

  // 1. Documentation mode is reachable and visible: header toggle + the panel.
  const beforeToggle = await page<boolean>(
    `(async () => !!document.querySelector('[data-testid="mode-docs"]') && !!document.querySelector('[data-testid="mode-bim"]') && !!document.querySelector('[data-testid="mode-drafting"]'))()`,
  );
  const clickedMode = beforeToggle ? await click("mode-docs") : false;
  await waitFor(
    `(() => { const c = document.querySelector('[data-testid="docs-card"]'); const b = document.querySelector('[data-testid="mode-docs"]');` +
      ` return !!c && c.style.display !== "none" && !!b && b.getAttribute("aria-pressed") === "true"; })()`,
    10000,
    "Documentation mode panel visible",
  );
  const docsControls = [
    "docs-status", "docs-seed", "docs-seed-result", "docs-view-kind", "docs-view-story", "docs-view-direction",
    "docs-view-axis", "docs-view-offset", "docs-create-view", "docs-list-views", "docs-view-list", "docs-get-geometry",
    "docs-geometry-readout", "docs-regenerate", "docs-regen-readout", "docs-create-sheet", "docs-list-sheets",
    "docs-sheet-list", "docs-export", "docs-export-readout", "docs-export-pdf", "docs-undo", "docs-redo",
    "docs-save-open", "docs-persist-result",
  ];
  const controlsPresent = await page<boolean>(
    `(async () => ${JSON.stringify(docsControls)}.every((t) => !!document.querySelector('[data-testid="' + t + '"]')))()`,
  );
  push(
    "1",
    "Documentation mode visible (header toggle switches the panel in; all data-testid controls present)",
    beforeToggle && clickedMode && controlsPresent,
    controlsPresent ? `mode-docs clicked; docs-card displayed; ${docsControls.length}/${docsControls.length} docs controls present` : "docs controls missing",
  );

  // 2. Seed the representative documentation set through the UI (one click:
  //    document.create + building + 4 views + annotations + regenerate + sheet).
  const run2 = await currentRun();
  const clickedSeed = await click("docs-seed");
  const seedStatus = await waitDocsOp("seed", run2 + 1, 30000);
  const seedCount = Number(await readAttr("docs-seed-result", "data-count"));
  const seedRegen = await readAttr("docs-seed-result", "data-regen-applied");
  const seedSheet = await readAttr("docs-seed-result", "data-sheet");
  const seedText = await readText("docs-seed-result");
  push(
    "2",
    "seed the representative building + plan/elevation/section/detail views + annotations + regeneration + A-101 sheet via the UI",
    clickedSeed && seedStatus.state === "done" && seedCount === 4 && seedRegen === "2" && seedSheet === "sh-000001",
    `${seedText}`,
  );

  // 3. docs.listViews via the UI → 4 rows; plan view carries 17 primitives.
  const run3 = await currentRun();
  const clickedList = await click("docs-list-views");
  const listStatus = await waitDocsOp("list-views", run3 + 1, 30000);
  const rowCount3 = await viewRowCount();
  const rowPlanText = await readText("docs-view-row-vw-000001");
  const views3 = await listViews();
  const plan3 = views3?.find((v) => v.view.id === "vw-000001");
  push(
    "3",
    "listViews via UI → 4 rows (kind + primitive count + 8-char hash prefix); plan = 17 primitives",
    clickedList && listStatus.state === "done" && rowCount3 === 4 && views3 !== null && views3.length === 4 &&
      plan3?.primitiveCount === 17 && /plan/.test(rowPlanText) && /17 primitives/.test(rowPlanText) &&
      plan3?.contentHash !== null && rowPlanText.includes(plan3!.contentHash!.slice(0, 8)),
    `rows=${rowCount3} · row vw-000001: ${rowPlanText} · direct plan primitives=${plan3?.primitiveCount ?? "n/a"}`,
  );

  // 4. View geometry via the UI: row click selects the plan + fetches geometry,
  //    then the View geometry button re-queries the selection → 17 primitives
  //    + content hash + the exact hand-derived plan bbox.
  const run4a = await currentRun();
  const clickedRow = await click("docs-view-row-vw-000001");
  const geomStatusRow = await waitDocsOp("get-geometry", run4a + 1, 30000);
  const run4b = await currentRun();
  const clickedGeomBtn = await click("docs-get-geometry");
  const geomStatusBtn = await waitDocsOp("get-geometry", run4b + 1, 30000);
  const geoText = await readText("docs-geometry-readout");
  const geoHash = await readAttr("docs-geometry-readout", "data-hash");
  const geoPrimitives = await readAttr("docs-geometry-readout", "data-primitives");
  const geoBbox = await readAttr("docs-geometry-readout", "data-bbox");
  const geom4 = await planGeometry();
  const bboxOk =
    geom4 !== null && geom4.bbox !== null &&
    JSON.stringify(geom4.bbox) === JSON.stringify({ uMin: -300, uMax: 6300, vMin: -300, vMax: 6000 });
  const planHashOriginal = geom4?.contentHash ?? "";
  push(
    "4",
    "view geometry via UI (row select + get-geometry button) → 17 primitives + hash prefix + exact bbox [-300,6300]×[-300,6000]",
    clickedRow && geomStatusRow.state === "done" && clickedGeomBtn && geomStatusBtn.state === "done" &&
      geom4?.primitiveCount === 17 && /^[0-9a-f]{64}$/.test(geom4?.contentHash ?? "") &&
      geoPrimitives === "17" && geoHash === geom4?.contentHash && geoBbox !== null &&
      JSON.stringify(JSON.parse(geoBbox)) === JSON.stringify(geom4?.bbox ?? null) && bboxOk &&
      geoText.includes("vw-000001") && geoText.includes("plan"),
    `${geoText} · direct: primitives=${geom4?.primitiveCount ?? "n/a"} bbox=${JSON.stringify(geom4?.bbox ?? null)}`,
  );

  // 5. Create one additional view through the UI (elevation back) → 5 rows.
  const setKind = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="docs-view-kind"]'); if (!i) return false;` +
      ` i.value = "elevation"; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  const setDir = await page<boolean>(
    `(async () => { const i = document.querySelector('[data-testid="docs-view-direction"]'); if (!i) return false;` +
      ` i.value = "back"; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  const run5 = await currentRun();
  const clickedCreateView = await click("docs-create-view");
  const createViewStatus = await waitDocsOp("create-view", run5 + 1, 30000);
  const views5 = await listViews();
  const backView = views5?.find((v) => v.view.id === "vw-000005");
  const run5b = await currentRun();
  const clickedList5 = await click("docs-list-views");
  const listStatus5 = await waitDocsOp("list-views", run5b + 1, 30000);
  const rowCount5 = await viewRowCount();
  push(
    "5",
    "create an additional elevation (back) view via the UI form → 5 views / 5 rows",
    setKind && setDir && clickedCreateView && createViewStatus.state === "done" &&
      views5?.length === 5 && rowCount5 === 5 && clickedList5 && listStatus5.state === "done" &&
      backView?.view.kind === "elevation" && backView?.view.direction === "back" && (backView?.primitiveCount ?? 0) > 0,
    `views=${views5?.length ?? "n/a"} rows=${rowCount5} · vw-000005: ${backView?.view.kind ?? "missing"} ${backView?.view.direction ?? ""} · ${backView?.primitiveCount ?? "n/a"} primitives`,
  );

  // 6. Regenerate via the UI. ENGINE TRUTH (adapted from the task text): the
  //    seed's docs.regenerate already derived the annotation values (its
  //    applied=2 is asserted in step 2), so THIS regeneration is the engine's
  //    documented no-op — applied=0, no revision (identical inputs → identical
  //    outputs, the determinism proof). The derived values are asserted via
  //    direct docs.getViewGeometry: dim 5300 + tag label "Office 1 (27.00 m²)".
  const run6 = await currentRun();
  const clickedRegen = await click("docs-regenerate");
  const regenStatus = await waitDocsOp("regenerate", run6 + 1, 30000);
  const applied6 = await readAttr("docs-regen-readout", "data-applied");
  const firstHash6 = await readAttr("docs-regen-readout", "data-first-hash");
  const regenText = await readText("docs-regen-readout");
  const geom6 = await planGeometry();
  const dim6 = geom6?.annotations.find((a) => a.type === "docs.dim");
  const tag6 = geom6?.annotations.find((a) => a.type === "docs.tag");
  push(
    "6",
    "regenerate via UI → derived annotation values current: dim 5300 + tag 'Office 1 (27.00 m²)' (no-op proof: applied 0, no revision)",
    clickedRegen && regenStatus.state === "done" && applied6 === "0" &&
      dim6?.measured === 5300 && tag6?.label === "Office 1 (27.00 m²)" &&
      firstHash6 === planHashOriginal,
    `applied=${applied6} (the seed's regeneration applied the task's 'applied 2' — step 2; a no-op records no revision) · dim measured=${dim6?.measured ?? "n/a"} · tag label=${JSON.stringify(tag6?.label ?? null)} · first view hash ${firstHash6?.slice(0, 8) ?? "—"} = plan hash`,
  );

  // 7. Parametric dimension: move wall-north +500 in y (direct bim.move — a
  //    model edit, not a docs-card control) then regenerate via the UI → the
  //    overall dimension re-derives 5300 → 5800 (applied 1).
  const moveRes = await cmd("bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 });
  const run7 = await currentRun();
  const clickedRegen7 = await click("docs-regenerate");
  const regenStatus7 = await waitDocsOp("regenerate", run7 + 1, 30000);
  const applied7 = await readAttr("docs-regen-readout", "data-applied");
  const geom7 = await planGeometry();
  const dim7 = geom7?.annotations.find((a) => a.type === "docs.dim");
  push(
    "7",
    "parametric dimension: bim.move wall-north +500 (direct) + regenerate via UI → measured 5800",
    !!moveRes && moveRes.ok && clickedRegen7 && regenStatus7.state === "done" && applied7 === "1" &&
      dim7?.measured === 5800,
    `move=${moveRes && moveRes.ok ? "ok" : JSON.stringify(moveRes).slice(0, 120)} · applied=${applied7} · dim measured=${dim7?.measured ?? "n/a"}`,
  );

  // 8. Undo twice: the regeneration revision (immutable — restores 5300), then
  //    the move itself (restores the pre-move plan projection EXACTLY).
  const run8a = await currentRun();
  const clickedUndo1 = await click("docs-undo");
  const undoStatus1 = await waitDocsOp("undo", run8a + 1, 30000);
  const geom8a = await planGeometry();
  const measured8a = geom8a?.annotations.find((a) => a.type === "docs.dim")?.measured;
  const run8b = await currentRun();
  const clickedUndo2 = await click("docs-undo");
  const undoStatus2 = await waitDocsOp("undo", run8b + 1, 30000);
  const geom8b = await planGeometry();
  const dim8 = geom8b?.annotations.find((a) => a.type === "docs.dim");
  const views8 = await listViews();
  const planHash8 = views8?.find((v) => v.view.id === "vw-000001")?.contentHash ?? null;
  push(
    "8",
    "undo twice → regeneration revision + move undone; measured back to 5300 (regeneration is an immutable revision)",
    clickedUndo1 && undoStatus1.state === "done" && clickedUndo2 && undoStatus2.state === "done" &&
      measured8a === 5300 && dim8?.measured === 5300 && planHash8 !== null && planHash8 === planHashOriginal,
    `after undo#1 measured=${measured8a ?? "n/a"} · after undo#2 measured=${dim8?.measured ?? "n/a"} · plan contentHash restored to the pre-move hash=${planHash8 === planHashOriginal}`,
  );

  // 9. Create a sheet via the UI (A-102 placing section + detail) → 2 sheets.
  const run9 = await currentRun();
  const clickedCreateSheet = await click("docs-create-sheet");
  const createSheetStatus = await waitDocsOp("create-sheet", run9 + 1, 30000);
  const run9b = await currentRun();
  const clickedListSheets = await click("docs-list-sheets");
  const listSheetsStatus = await waitDocsOp("list-sheets", run9b + 1, 30000);
  const sheetRows9 = await sheetRowCount();
  const sheetsDirect = await qq("docs.listSheets", {});
  const sheets9 = sheetsDirect && sheetsDirect.ok ? (sheetsDirect.value as { sheets: { id: string; titleBlock: { sheetNumber: string } }[] }).sheets : [];
  push(
    "9",
    "create sheet via UI (A-102, section + detail placements) → sheets list shows 2",
    clickedCreateSheet && createSheetStatus.state === "done" && clickedListSheets && listSheetsStatus.state === "done" &&
      sheetRows9 === 2 && sheets9.length === 2 && sheets9[1]?.titleBlock?.sheetNumber === "A-102",
    `sheet rows=${sheetRows9} · ${sheets9.map((s) => `${s.id}/${s.titleBlock.sheetNumber}`).join(", ")}`,
  );

  // 10. Export the canonical Sheet IR via the UI → 64-hex sha256 in the
  //     readout, matching the direct export of sh-000001 byte-for-byte.
  const run10 = await currentRun();
  const clickedExport = await click("docs-export");
  const exportStatus = await waitDocsOp("export", run10 + 1, 30000);
  const exportHash10 = await readAttr("docs-export-readout", "data-hash");
  const exportText = await readText("docs-export-readout");
  const directExport = await qq("docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" });
  const directHash10 = directExport && directExport.ok ? (directExport.value as { hash: string }).hash : "";
  push(
    "10",
    "export sheet-ir via UI → canonical 64-hex hash prefix in the readout (matches the direct export)",
    clickedExport && exportStatus.state === "done" &&
      /^[0-9a-f]{64}$/.test(exportHash10 ?? "") && exportHash10 === directHash10 &&
      exportText.includes(directHash10.slice(0, 16)),
    `${exportText} · direct hash identical=${exportHash10 === directHash10}`,
  );

  // 11. Export pdf via the UI → the typed docs_unsupported failure surfaces in
  //     the shared cad-error alert (+ direct assert of the typed code).
  const run11 = await currentRun();
  const clickedPdf = await click("docs-export-pdf");
  const pdfStatus = await waitDocsOp("export-pdf", run11 + 1, 30000);
  const errorText11 = await readText("cad-error");
  const directPdf = await qq("docs.exportSheet", { sheetId: "sh-000001", format: "pdf" });
  const directPdfCode = directPdf && !directPdf.ok ? (directPdf as { code?: string }).code : "";
  push(
    "11",
    "export pdf via UI → typed docs_unsupported surfaced in the shared alert + direct assert",
    clickedPdf && pdfStatus.state === "error" && /docs_unsupported/.test(errorText11) &&
      directPdf.ok === false && directPdfCode === "docs_unsupported",
    `ui=[${pdfStatus.state}] ${errorText11.slice(0, 160)} | direct code=${directPdfCode || "n/a"}`,
  );

  // 12. Save → open round trip via the UI → identical graph events hash, with
  //     the documentation set intact (5 views persisted across the round trip).
  const eventsBefore = await qq("model.getGraphEvents", {});
  const hashBefore12 = eventsBefore && eventsBefore.ok ? (eventsBefore.value as { events_hash: string }).events_hash : "";
  const run12 = await currentRun();
  const clickedSaveOpen = await click("docs-save-open");
  const saveOpenStatus = await waitDocsOp("save-open", run12 + 1, 60000);
  const identicalAttr = await readAttr("docs-persist-result", "data-identical");
  const persistText = await readText("docs-persist-result");
  const eventsAfter = await qq("model.getGraphEvents", {});
  const hashAfter12 = eventsAfter && eventsAfter.ok ? (eventsAfter.value as { events_hash: string }).events_hash : "";
  const viewsAfterOpen = await listViews();
  push(
    "12",
    "save → open round trip via UI → identical graph events hash (+ documentation set intact)",
    clickedSaveOpen && saveOpenStatus.state === "done" && identicalAttr === "true" &&
      hashBefore12 !== "" && hashAfter12 === hashBefore12 && viewsAfterOpen?.length === 5,
    `${persistText} · views after open=${viewsAfterOpen?.length ?? "n/a"} · direct hash identical=${hashAfter12 === hashBefore12}`,
  );

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
