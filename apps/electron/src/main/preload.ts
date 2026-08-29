/**
 * Electron preload — contextBridge (§16). Exposes a tiny `window.cad` API to
 * the shared renderer UI. The renderer never gets node process/filesystem
 * privileges: `contextIsolation: true`, `nodeIntegration: false` in main. All
 * CAD work crosses the native IPC boundary into the main process, where the
 * shared CAD App API (AppApiHandler + dummy adapter) actually runs.
 *
 * The same v1 wire contract the Web host uses over fetch("/api/cad") crosses
 * this native IPC boundary — transport independence (§5.5).
 */

import { contextBridge, ipcRenderer } from "electron";

const api = {
  send: (req: unknown): Promise<unknown> => ipcRenderer.invoke("cad:send", req),
  render: (snapshot: unknown): Promise<unknown> => ipcRenderer.invoke("cad:render", snapshot),
  contentHash: (): Promise<string> => ipcRenderer.invoke("cad:contentHash"),
  // CAD-PARITY-006 (Issue #84): the external-reference file picker — the
  // main-process showOpenDialog (.offisos/.json) + read + parse. Returns the
  // typed pick outcome; the parsed snapshot object is the xref.attach
  // `content` payload (the renderer never touches node/fs).
  pickReferenceFile: (): Promise<unknown> => ipcRenderer.invoke("cad:pickReferenceFile"),
  // CAD-PARITY-008 (Issue #88): the plot-artifact save flow — pickSavePath
  // (the showSaveDialog) + savePlotFile (the one fs write). Typed outcomes;
  // the renderer never touches node/fs (§16).
  pickSavePath: (defaultPath?: string): Promise<unknown> =>
    ipcRenderer.invoke("cad:pickSavePath", { defaultPath }),
  savePlotFile: (payload: { filePath: string; text?: string; bytesBase64?: string }): Promise<unknown> =>
    ipcRenderer.invoke("cad:savePlotFile", payload),
};

contextBridge.exposeInMainWorld("cad", api);

export type OffisosCadApi = typeof api;
