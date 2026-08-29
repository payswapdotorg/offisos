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
