/**
 * Deterministic scene graph — the renderer's output (LOCK-017).
 *
 * The renderer produces a deterministic scene graph from a CADDocument
 * snapshot. Determinism (same snapshot → same hash) is required for
 * reproducibility evidence and for Web/Electron parity: both hosts render the
 * same snapshot to the same scene graph.
 */

export interface SceneNode {
  readonly id: string;
  readonly meshToken: string;
  /** Row-major 4x4 transform (16 numbers). */
  readonly transform: readonly number[];
}

export interface SceneGraph {
  readonly documentVersionId: string;
  readonly nodes: readonly SceneNode[];
  /** Stable SHA-256 over the canonical encoding. Same snapshot → same hash. */
  readonly hash: string;
}
