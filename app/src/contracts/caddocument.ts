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

// --- COMPAT-CAD-002 (additive, api-contract.md §8): BIM authoring ----------

/** Standard 3D camera states (COMPAT-CAD-002). The preset is the persisted
 *  BIM camera state; the eye/target/up triple is derived deterministically
 *  from the preset + the model's derived world bounding box by the shared
 *  pure camera module (src/bim/camera.ts) so Web and Electron render from
 *  identical camera parameters (§5.5 parity). */
export type BimCameraPreset = "iso" | "top" | "front" | "right";

/** COMPAT-CAD-002 (additive): non-versioned BIM workspace settings (camera
 *  state), mirrored from the DraftingSettings precedent: persisted with the
 *  snapshot (save/open restores the camera), mutated without a version bump,
 *  NOT part of the revision content hashes, INCLUDED in the parity content
 *  hash (persisted workspace content). */
export interface BimSettings {
  readonly units: "mm";
  readonly camera: { readonly preset: BimCameraPreset };
}

// --- COMPAT-CAD-003 (additive, api-contract.md §8): documentation ---------

/** Drawing view kinds derived from the BIM model (COMPAT-CAD-003).
 *  - plan      — orthographic top view of ONE story (story-local XY).
 *  - elevation — orthographic vertical projection of one story or the whole
 *                building along a canonical direction (no hidden-line
 *                removal — wireframe outlines; documented limitation).
 *  - section   — vertical cut plane (x=offset or y=offset); the projected
 *                outlines of elements whose extent crosses the plane.
 *  - detail    — a magnified crop of another MODEL view (plan/elevation/
 *                section; detail-of-detail is rejected).
 *  View DEFINITIONS are versioned document content (DocumentEdit); the
 *  projected primitives are DERIVED state — pure deterministic functions of
 *  (view definition, current BIM elements), recomputed on demand and never
 *  stored (determinism proven by re-computation + canonical hashing). */
export type DocsViewKind = "plan" | "elevation" | "section" | "detail";

/** Canonical elevation directions (mirror src/bim/camera.ts semantics:
 *  front = viewer at −Y looking +Y, so front projects world X; left =
 *  viewer at −X, projecting world Y; back/right mirror). */
export type DocsElevationDirection = "front" | "back" | "left" | "right";

/** A documentation view definition (COMPAT-CAD-003). Canonical identity
 *  `vw-NNNNNN` is minted by the document (monotonic, never reused). Fields
 *  are validated per kind: plan requires storyId; elevation requires
 *  direction; section requires sectionAxis + sectionOffset; detail requires
 *  sourceViewId + region + detailScale. `scale` is the drawing scale
 *  denominator (e.g. 50 for 1:50; presentation hint, default 50). */
export interface DocsViewRecord {
  readonly id: string;
  readonly kind: DocsViewKind;
  readonly title: string;
  /** Plan: the story shown (required). Elevation/section: optional story
 *   *  scope (absent = the whole building). Detail: unused. */
  readonly storyId?: string;
  /** Elevation (required): canonical direction. */
  readonly direction?: DocsElevationDirection;
  /** Section (required): cut-plane normal axis. */
  readonly sectionAxis?: "x" | "y";
  /** Section (required): cut-plane offset (story-local/world XY, mm). */
  readonly sectionOffset?: number;
  /** Detail (required): the cropped source MODEL view. */
  readonly sourceViewId?: string;
  /** Detail (required): crop region in the source view's coordinates. */
  readonly region?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Detail (required): magnification factor (> 1 enlarges). */
  readonly detailScale?: number;
  /** Drawing scale denominator (1:N); default 50. */
  readonly scale?: number;
}

/** Canonical sheet frame for this slice: A1 landscape (841×594 mm) with a
 *  fixed 200 mm title-block strip on the right edge — the drawable region
 *  is [0, 641]×[0, 594] (mm). All sheets share the frame (single canonical
 *  size — honest scope for this slice). */
export const DOCS_SHEET_FRAME = {
  width: 841,
  height: 594,
  titleBlockWidth: 200,
} as const;

/** Title block fields (COMPAT-CAD-003). Drawn inside the fixed right strip. */
export interface DocsTitleBlock {
  readonly projectName: string;
  readonly sheetTitle: string;
  readonly sheetNumber: string;
  readonly author?: string;
  readonly date?: string;
}

/** A view placement on a sheet: the view's projected content is mapped
 *  into the frame (x, y, w, h) in sheet millimetres. */
export interface DocsViewPlacement {
  readonly viewId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A documentation sheet/layout (COMPAT-CAD-003). Canonical identity
 *  `sh-NNNNNN` is minted by the document (monotonic, never reused).
 *  Placements are validated: inside the drawable region, pairwise
 *  non-overlapping (open-interval semantics — touching edges allowed). */
export interface DocsSheetRecord {
  readonly id: string;
  readonly title: string;
  readonly titleBlock: DocsTitleBlock;
  readonly viewPlacements: readonly DocsViewPlacement[];
}

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
  /** COMPAT-CAD-002: BIM workspace camera state (absent on legacy snapshots;
 *   *   a legacy snapshot opens with the canonical default preset). */
  readonly bimSettings?: BimSettings;
  /** COMPAT-CAD-003: documentation view definitions (absent on legacy
 *   *  snapshots; versioned through the addView/updateView/removeLayer-style
 *   *  command model — view lineage lives in the recorded applied edits). */
  readonly docsViews?: readonly DocsViewRecord[];
  /** COMPAT-CAD-003: documentation sheets/layouts (absent on legacy
 *   *  snapshots; same versioned-command-model contract as docsViews). */
  readonly docsSheets?: readonly DocsSheetRecord[];
  /** COMPAT-IFC-001: deterministic IFC import records (absent on legacy
 *   *  snapshots; append-only through the addIfcImport edit — every import
 *   *  is ONE versioned command carrying its provenance record). */
  readonly ifcImports?: readonly IfcImportRecordView[];
}

/** One canonical↔GlobalId provenance mapping entry of an IFC import
 *  (COMPAT-IFC-001). GlobalIds are provenance ONLY — canonical identity is
 *  the DomainId carried in the identity psets (LOCK-019). */
export interface IfcImportMappingEntry {
  readonly canonicalId: string | null;
  readonly globalId: string;
  readonly ifcClass: string;
  readonly action: "created" | "reconciled" | "unchanged" | "unsupported";
}

/** The persisted deterministic record of one IFC import (COMPAT-IFC-001):
 *  source file hash + schema + declared unit normalization + the
 *  reconciliation report hash + summary + the per-element provenance
 *  mapping. `if-NNNNNN` ids are minted by the document (monotonic, never
 *  reused); `at` is a fixed deterministic timestamp. */
export interface IfcImportRecordView {
  readonly id: string;
  readonly at: string;
  /** SHA-256 of the imported IFC file bytes. */
  readonly sourceHash: string;
  readonly schema: string;
  readonly lengthUnitName: string | null;
  readonly lengthUnitPrefix: string | null;
  /** Declared factor file-length-units → canonical mm. */
  readonly scaleToMm: number;
  /** SHA-256 of the canonical reconciliation report. */
  readonly reportHash: string;
  readonly summary: {
    readonly created: number;
    readonly reconciled: number;
    readonly unchanged: number;
    readonly unsupported: number;
    readonly exact: number;
    readonly tolerance: number;
    readonly lossy: number;
    readonly unsupportedFields: number;
  };
  readonly mapping: readonly IfcImportMappingEntry[];
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
    }
  // --- COMPAT-CAD-003 (additive) ---
  | {
      readonly type: "addView";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly view: DocsViewRecord;
    }
  | {
      readonly type: "updateView";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly viewId: string;
    }
  | {
      readonly type: "removeView";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly viewId: string;
    }
  | {
      readonly type: "addSheet";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sheet: DocsSheetRecord;
    }
  | {
      readonly type: "updateSheet";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly sheetId: string;
    }
  | {
      readonly type: "removeSheet";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sheetId: string;
    }
  | {
      /** Full-record view restore (exact inverse semantics — mirrors setProps:
       *  used as the updateView inverse when a patch added a key, so absence
       *  of keys is representable on undo/replay; COMPAT-CAD-003). */
      readonly type: "setViewRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly viewId: string;
      readonly view: DocsViewRecord;
    }
  | {
      /** Full-record sheet restore (setViewRecord semantics for sheets). */
      readonly type: "setSheetRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sheetId: string;
      readonly sheet: DocsSheetRecord;
    }
  // --- COMPAT-IFC-001 (additive) ---
  | {
      /** Append one deterministic IFC import record (part of the ONE atomic
       *  versioned batch that also adds/reconciles the imported elements —
       *  undo removes both together). */
      readonly type: "addIfcImport";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly record: IfcImportRecordView;
    }
  | {
      /** Remove an import record (the addIfcImport inverse for undo/replay). */
      readonly type: "removeIfcImport";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly recordId: string;
    };
