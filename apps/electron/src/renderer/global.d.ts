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
}

declare global {
  interface Window {
    cad: OffisosCadApi;
  }
}

export {};
