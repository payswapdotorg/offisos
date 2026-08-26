/**
 * Electron main-process integration note (§5.3, §16, LOCK-017/018).
 *
 * The shared host layer that lives in this package (`ElectronHost` +
 * `IpcTransport`) is platform-independent and testable without the Electron
 * runtime installed — `app/test/host-parity.test.ts` proves Web/Electron
 * parity through it. This file re-exports an integration note only; it does
 * NOT import `electron`, so the canonical `@offisos/cad-app-shell` package
 * stays free of the Electron runtime dependency (the Web host and the
 * forbidden-import static check remain clean).
 *
 * The REAL Electron main-process bootstrap — `app.whenReady()` ->
 * `BrowserWindow` (contextIsolation + nodeIntegration:false + preload) ->
 * `loadFile(shared renderer)` -> `ipcMain.handle("cad:send"|"cad:render")`
 * wired to `new ElectronHost(new IpcTransport(handler))` + `createRenderer`
 * + `AppApiHandler` + the dummy adapter — lives in the deployable host package
 * `apps/electron/` (see `apps/electron/src/main/main.ts`). It is reproducibly
 * built (esbuild) and smoke-tested under xvfb (`npm run smoke`), proving the
 * full chain through a real OS window. No FreeCAD/OCCT/IfcOpenShell coupling
 * (LOCK-003/018); CADDocument is the editor representation (LOCK-019).
 */

export const ELECTRON_HOST_INTEGRATION_NOTE =
  "Real Electron main bootstrap lives in apps/electron/src/main/main.ts (BrowserWindow + native IPC + shared renderer + App API + dummy adapter); the shared host layer (ElectronHost + IpcTransport) here is proven by app/test/host-parity.test.ts.";
