/**
 * CADDocument model contracts (§5.4, data-model.md §2, LOCK-019).
 *
 * CADDocument is the canonical working representation of an open CAD/BIM
 * artifact for the editor. It provides document-local object identity, editor
 * state, command/undo/redo semantics, model tree, source artifact lineage and
 * format/version metadata (§5.4).
 *
 * CADDocument is NOT the Construction Graph (LOCK-019, §5.4). Construction
 * Graph IDs remain canonical for domain identity; CADDocument identity is
 * editor/file identity only and maps to Graph entities through explicit
 * versioned contracts/events.
 */

import type { ModelHistory } from "./model.js";

/** Versioned entity metadata per data-model.md §2. */
export interface VersionMeta {
  readonly entity_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly parent_version_id: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly source_snapshot_id: string | null;
  readonly status: "ACTIVE" | "SUPERSEDED";
}

export type ElementKind = "geometry" | "bim" | "annotation";

// --- COMPAT-CAD-001 (additive, api-contract.md §8): drafting layers --------

/** A persistent drawing layer (COMPAT-CAD-001, §5.4 editor workspace state).
 *
 *  Layers are versioned document STRUCTURE: they are edited through the
 *  DocumentEdit command model (addLayer/updateLayer/removeLayer), recorded as
 *  revisions, and persisted with the snapshot (save/open). The layer table is
 *  attached document metadata for version identity: revision content hashes
 *  and version ids remain derived from the element content (the layer table's
 *  lineage lives in the recorded applied edits, inspectable in the history).
 *  `visible` drives rendering AND entity pickability; `id` is the canonical
 *  layer identity referenced by drafting entities' `props.layer`. */
export interface LayerRecord {
  readonly id: string;
  readonly name: string;
  /** Hex color `#RRGGBB` (rendering hint; not semantic). */
  readonly color: string;
  readonly visible: boolean;
}

/** COMPAT-CAD-001 (additive): non-versioned drafting workspace settings
 *  (grid/snap configuration, units, view state). Persisted with the snapshot
 *  so save/open restores the drafting environment; NOT part of the version
 *  content hash (presentation/configuration state, like the ephemeral
 *  selection) and not undoable (document.undo targets content edits). */
export interface DraftingSettings {
  readonly units: "mm";
  readonly grid: { readonly enabled: boolean; readonly size: number };
  readonly snap: {
    readonly enabled: boolean;
    readonly kinds: readonly SnapKind[];
    readonly tolerance: number;
  };
  readonly view: { readonly pan: readonly [number, number]; readonly zoom: number };
}

/** Snap candidate kinds (COMPAT-CAD-001 precision scope). Deterministic
 *  priority order for tie-breaking: endpoint < intersection < center <
 *  midpoint < quadrant < on-object < grid. */
export type SnapKind =
  | "endpoint"
  | "intersection"
  | "center"
  | "midpoint"
  | "quadrant"
  | "on-object"
  | "grid";

/** A document-local element. The `engineId` field is a provenance/source
 *  identifier only; Construction Graph element identity is mapped through
 *  explicit versioned contracts (§5.4, LOCK-019). */
export interface Element {
  readonly id: string;
  readonly kind: ElementKind;
  readonly engineId: string | null;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface EditorState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly commandDepth: number;
}

/** A point-in-time snapshot of an open CAD/BIM artifact for the editor.
 *  `modelHistory` (CAD-IMPLEMENT-003, additive + optional for backward
 *  compatibility) carries the immutable model revision log so save/open
 *  round-trips preserve version lineage, provenance and replayability
 *  (LOCK-005/LOCK-012). It is excluded from the parity content hash
 *  (history has its own canonical hash — see caddocument/history.ts).
 *  COMPAT-CAD-001 (additive + optional): `layers` carries the persistent
 *  drawing layer table; `selection` carries the editor selection so it
 *  survives save/open; `draftingSettings` carries the grid/snap/view
 *  configuration. `selection` is excluded from the parity content hash
 *  (ephemeral editor state, §5.5); `layers` and `draftingSettings` are
 *  included (document/workspace content). */
export interface CADDocumentSnapshot {
  readonly version: VersionMeta;
  readonly format: string;
  readonly formatVersion: string;
  readonly sourceArtifactLineage: readonly string[];
  readonly editorState: EditorState;
  readonly elements: readonly Element[];
  readonly modelHistory?: ModelHistory;
  /** COMPAT-CAD-001: the persistent layer table (absent on legacy snapshots). */
  readonly layers?: readonly LayerRecord[];
  /** COMPAT-CAD-001: the editor selection at snapshot time (persisted so
 *   *  save/open preserves it; absent on legacy snapshots). */
  readonly selection?: readonly string[];
  /** COMPAT-CAD-001: grid/snap/view configuration (absent on legacy). */
  readonly draftingSettings?: DraftingSettings;
}

/** A reversible document edit (undo/redo semantics, §5.4). The inverse is
 *  computed by the CADDocument model so that undo/redo converge identically
 *  across hosts (§5.5, §15).
 *
 *  COMPAT-CAD-001 (additive, api-contract.md §8):
 *  - `applyEdits` — an atomic batch: sub-edits apply in order as ONE versioned
 *    command (one revision, one undo entry). Used by composite drafting
 *    operations (trim produces remove+add+add; multi-entity move/copy/delete).
 *  - `addLayer` / `updateLayer` / `removeLayer` — layer-table edits through
 *    the same command model. `addLayer` with a missing/empty id mints a
 *    canonical `ly-NNNNNN` identity; `removeLayer` is rejected while entities
 *    still reference the layer (no silent cascade). */
export type DocumentEdit =
  | {
      readonly type: "addElement";
      readonly elementId?: undefined;
      readonly element: Element;
      readonly patch?: undefined;
    }
  | {
      readonly type: "removeElement";
      readonly elementId: string;
      readonly element?: undefined;
      readonly patch?: undefined;
    }
  | {
      readonly type: "updateElement";
      readonly elementId: string;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "setProps";
      readonly elementId: string;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
    }
  // --- COMPAT-CAD-001 (additive) ---
  | {
      readonly type: "applyEdits";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly edits: readonly DocumentEdit[];
    }
  | {
      readonly type: "addLayer";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly layer: LayerRecord;
    }
  | {
      readonly type: "updateLayer";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly layerId: string;
    }
  | {
      readonly type: "removeLayer";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly layerId: string;
    };
