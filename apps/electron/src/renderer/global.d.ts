/**
 * Renderer global type declaration for `window.cad` (exposed by the preload
 * contextBridge). Importing this module augments the global Window.
 */

export interface OffisosCadScene {
  readonly documentVersionId: string;
  readonly nodes: ReadonlyArray<{ id: string; meshToken: string; transform: readonly number[] }>;
  readonly hash: string;
}

export interface OffisosCadApi {
  send(req: unknown): Promise<unknown>;
  render(snapshot: unknown): Promise<OffisosCadScene>;
  contentHash(): Promise<string>;
  /** CAD-PARITY-006 (Issue #84): the external-reference file picker (the
   *  main-process dialog) — the typed pick outcome; `content` is the parsed
   *  offisos snapshot object for xref.attach/xref.reload. */
  pickReferenceFile(): Promise<OffisosReferenceFilePick>;
  /** CAD-PARITY-008 (Issue #88): the plot-artifact save flow — pickSavePath
   *  (the main-process showSaveDialog) + savePlotFile (the single fs write
   *  of the deterministic SVG/PDF artifact). Typed outcomes. */
  pickSavePath(defaultPath?: string): Promise<{ status: "canceled" } | { status: "saved"; filePath: string } | { status: "error"; message: string }>;
  savePlotFile(payload: { filePath: string; text?: string; bytesBase64?: string }): Promise<{ status: "saved"; size: number } | { status: "error"; message: string }>;
}

/** The cad:pickReferenceFile outcome (CAD-PARITY-006). */
export type OffisosReferenceFilePick =
  | { readonly status: "canceled" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly fileName: string;
      readonly filePath: string;
      readonly content: unknown;
    };

declare global {
  interface Window {
    cad: OffisosCadApi;
  }
}

export {};
