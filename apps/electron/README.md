# @offisos/electron-host

CAD-IMPLEMENT-001 / Issue #24 remediation for **CHANGES REQUESTED** review on PR #25.
Architecture v1.1 FROZEN.

The Architect required Electron to be a first-class runnable host:

```
Electron main -> BrowserWindow -> shared renderer -> native/local transport
  -> shared CAD App API -> dummy adapter
```

This package delivers exactly that chain, reusing the canonical shared contracts
from `@offisos/cad-app-shell/*` (`../../app/src/*` via a tsconfig `paths` alias —
single source of truth, no duplicated contract copy).

## What runs

- **Electron main** (`src/main/main.ts`): `app.whenReady()` creates a
  `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: false`, preload script) that loads the shared renderer HTML.
  `ipcMain.handle("cad:send" | "cad:render" | "cad:contentHash")` is wired to
  the **same** shared host layer proven by `app/test/host-parity.test.ts`:
  `new ElectronHost(new IpcTransport(handler))` + `createRenderer(host)`, where
  `handler = AppApiHandler.create({ adapterBundle: DummyAdapterBundle, ... })`.
- **Preload** (`src/main/preload.ts`): `contextBridge.exposeInMainWorld("cad",
  { send, render, contentHash })`. The renderer never gets node access (§16).
- **Shared renderer UI** (`src/renderer/index.html` + `workspace.ts`): SVG canvas
  + New / Add box / Add circle / Undo / Redo / Save controls — the same
  workspace semantics as the Web host (`apps/web/src/app/page.tsx`). It talks
  to the App API **only** through `window.cad.send` (native IPC), exactly as
  the Web host talks only through `fetch("/api/cad")`.

The native IPC boundary (`ipcRenderer.invoke` -> `ipcMain.handle`) is the
"native/local transport"; the shared `IpcTransport` (JSON round-trip through the
handler) is the host-layer transport already proven by the parity tests.

## No engine coupling (LOCK-003/018)

The dummy adapter is the only engine. No FreeCAD/OCCT/IfcOpenShell anywhere in
the dependency graph. CADDocument is the editor representation, not the
Construction Graph (LOCK-019).

## Reproduce

```bash
cd apps/electron
npm install
npm run typecheck     # tsc --noEmit
npm run build         # esbuild -> dist/main/main.cjs + dist/main/preload.cjs + dist/renderer/*
npm start             # electron . --no-sandbox  (opens the OS window)
npm run smoke         # xvfb-run -a electron . --no-sandbox --disable-gpu --smoke  (headless smoke)
```

The smoke runs the full chain through the BrowserWindow:
`document.create` -> `applyEdit(addElement)` -> `getState` (1 element) ->
`render(snapshot)` (deterministic scene hash) -> `undo` -> `getState`
(0 elements) -> `contentHash`. It writes a JSON result to
`$OFFISOS_SMOKE_OUT` and exits 0/1.
