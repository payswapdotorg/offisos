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
import { DummyAdapterBundle } from "@offisos/cad-app-shell/adapters/dummy";
import { ElectronHost, IpcTransport } from "@offisos/cad-app-shell/host-electron";
import { createRenderer } from "@offisos/cad-app-shell/renderer";
import type { CommandQueryRequest, CommandQueryResponse } from "@offisos/cad-app-shell/contracts/app-api";
import type { CADDocumentSnapshot } from "@offisos/cad-app-shell/contracts/caddocument";
import type { SceneGraph } from "@offisos/cad-app-shell/contracts/scene";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "electron-workspace",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "electron-workspace",
};

const isSmoke = process.argv.includes("--smoke");

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

app.whenReady().then(() => {
  registerIpc();
  const win = createWindow();

  if (isSmoke) {
    runSmoke(win)
      .then(() => {
        // Result written to OFFISOS_SMOKE_OUT inside runSmoke; exit code from
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
          steps: [{ step: "runSmoke threw", ok: false, detail: String((e as Error)?.stack || e) }],
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
