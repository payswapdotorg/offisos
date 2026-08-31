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
import type { Vec3 } from "./geometry.js";

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

/** A persistent drawing layer (COMPAT-CAD-001, §5.4 editor workspace state;
 *  CAD-PARITY-004 extends the record with the professional state/display
 *  vocabulary — every new field is ADDITIVE + OPTIONAL so legacy snapshots
 *  and the pinned CAD-PARITY-002 parity fixture stay byte-identical: an
 *  absent field means its DEFAULT (unlocked, thawed, Continuous linetype,
 *  ByLayer-effective default lineweight 0.25, opaque, plottable).
 *
 *  Layers are versioned document STRUCTURE: they are edited through the
 *  DocumentEdit command model (addLayer/updateLayer/removeLayer), recorded as
 *  revisions, and persisted with the snapshot (save/open). The layer table is
 *  attached document metadata for version identity: revision content hashes
 *  and version ids remain derived from the element content (the layer table's
 *  lineage lives in the recorded applied edits, inspectable in the history).
 *  `visible` drives rendering AND entity pickability; a `frozen` layer is
 *  additionally excluded from new entity creation (typed failure) and from
 *  precision snapping; a `locked` layer renders but its entities reject
 *  modification through every DocumentEdit path (typed failure — the CAD
 *  document is the single enforcement point, LOCK-007); `id` is the canonical
 *  layer identity referenced by drafting entities' `props.layer`. */
export interface LayerRecord {
  readonly id: string;
  readonly name: string;
  /** Hex color `#RRGGBB` (rendering hint; not semantic). */
  readonly color: string;
  readonly visible: boolean;
  /** CAD-PARITY-004: frozen layers suppress display, creation and snap
   *  (regeneration-class exclusion). Absent = false. */
  readonly frozen?: boolean;
  /** CAD-PARITY-004: locked layers display but reject entity modification.
   *  Absent = false. */
  readonly locked?: boolean;
  /** CAD-PARITY-004: layer linetype name (built-in catalog or a document
   *  linetype). Absent = "Continuous". */
  readonly linetype?: string;
  /** CAD-PARITY-004: layer lineweight in mm (standard set). Absent = 0.25
   *  (the document default lineweight). */
  readonly lineweight?: number;
  /** CAD-PARITY-004: transparency percent 0–90 (0 = opaque). Absent = 0. */
  readonly transparency?: number;
  /** CAD-PARITY-004: plottable flag (honest metadata — plotting is
   *  CAD-PARITY-008 scope; the flag persists and filters). Absent = true. */
  readonly plot?: boolean;
  /** CAD-PARITY-004: free-form description. Absent = none. */
  readonly description?: string;
}

// --- CAD-PARITY-004 (additive): linetypes, text/dimension styles, ----------
// --- layer states and drawing standards ------------------------------------

/** A user-defined linetype (CAD-PARITY-004, CAD-2D-004). The BUILT-IN
 *  deterministic catalog (Continuous/Dashed/Hidden/Center/Phantom/Dot/
 *  DashDot/Divide/Border) is code-resolved (never materialized in the
 *  snapshot — legacy saves stay byte-identical); this record carries only
 *  USER-DEFINED dash patterns. The NAME is the canonical identity — layers
 *  and entities reference linetypes by name (the domain reference model).
 *  `pattern` is the dash/gap length sequence in drawing mm starting with a
 *  dash (positive) and alternating strictly positive dash/gap values; the
 *  pattern repeats along the entity. */
export interface LtypeRecord {
  readonly name: string;
  readonly description: string;
  readonly pattern: readonly number[];
}

/** A text style (CAD-PARITY-004, CAD-2D-004 style tables). The reserved
 *  built-in "Standard" style is code-resolved (never materialized); records
 *  carry user-defined styles, name-keyed. `height` 0 means not fixed
 *  (per-insertion height); fonts are the deterministic renderer families
 *  "sans" | "mono" | "serif". */
export interface TextStyleRecord {
  readonly name: string;
  readonly font: "sans" | "mono" | "serif";
  /** Fixed text height in mm; 0 = not fixed. */
  readonly height: number;
  /** Width scale factor, > 0. */
  readonly widthFactor: number;
  /** Oblique (italic) angle in degrees, −85…85. */
  readonly obliqueAngle: number;
}

/** A dimension style (CAD-PARITY-004, CAD-2D-004 style tables). The reserved
 *  built-in "Standard" style is code-resolved; records carry user-defined
 *  styles, name-keyed. Values are in drawing mm, applied before the drawing
 *  scale. CAD-PARITY-005 (additive + optional): `arrowStyle` selects the
 *  rendered arrowhead kind and `unitSuffix` appends to every formatted
 *  measurement — absent = closed arrows / no suffix (legacy snapshots stay
 *  byte-identical). */
export interface DimStyleRecord {
  readonly name: string;
  /** Dimension text height. */
  readonly textHeight: number;
  /** Arrow/tick size. */
  readonly arrowSize: number;
  /** Overall dimension scale multiplier, > 0. */
  readonly scale: number;
  /** Measurement value decimal places, 0…6. */
  readonly precision: number;
  /** CAD-PARITY-005: arrowhead rendering kind. Absent = "closed". */
  readonly arrowStyle?: "closed" | "tick" | "none";
  /** CAD-PARITY-005: unit suffix appended to formatted measurements
   *  (e.g. " mm"). Absent = none. */
  readonly unitSuffix?: string;
}

/** A named layer state (CAD-PARITY-004): the captured layer-table state
 *  (per-layer display/state fields only — identity fields like name/description
 *  are NOT part of a state snapshot). Name-keyed; re-saving an existing name
 *  replaces the state (LAYERSTATE semantics). Restore replays the recorded
 *  fields as one atomic updateLayer batch (versioned, undoable). The reserved
 *  name "*ISOLATE*" is owned by LAYISO/LAYUNISO. */
export interface LayerStateRecord {
  readonly name: string;
  readonly layers: readonly LayerStateEntry[];
}

/** One layer's captured state inside a LayerStateRecord. */
export interface LayerStateEntry {
  readonly layerId: string;
  readonly visible: boolean;
  readonly frozen: boolean;
  readonly locked: boolean;
  readonly color: string;
  readonly linetype: string;
  readonly lineweight: number;
  readonly transparency: number;
  readonly plot: boolean;
}

// --- CAD-PARITY-006 (additive): blocks, components & external references ----

/** One inline entity inside a block definition or a resolved external
 *  reference (CAD-PARITY-006, CAD-2D-007/008 bounded). The record is the
 *  entity's canonical props WITHOUT element identity: the CAD-PARITY-003
 *  flat geometry convention ({type:"line", x1, y1, x2, y2, layer?…}), the
 *  CAD-PARITY-005 text convention ({type:"text", x, y, height, rotation,
 *  value, style?…}), an attribute definition ({type:"attdef", tag, default,
 *  x, y, height…}) or a nested block reference ({type:"block-ref",
 *  blockId, x, y, scale, rotation, attributes?…}). Structural validation
 *  lives in the shared blocks core (workspace/blocks/types.ts) and is
 *  enforced at every DocumentEdit write path (LOCK-007 — reject, never
 *  guess). Inline content carries its own layer/display fields; it has NO
 *  document element identity (identity is the definition's/xref's). */
export type BlockEntityRecord = Readonly<Record<string, unknown>>;

/** A reusable block/component definition (CAD-PARITY-006, CAD-2D-007).
 *  Canonical identity `blk-NNNNNN` is minted by the document (monotonic,
 *  never reused — deletion never permits identity reuse); the NAME is the
 *  user-facing address (unique among definitions; rename is safe —
 *  instances reference the immutable id). Definitions are versioned
 *  document STRUCTURE edited through the DocumentEdit command model
 *  (addBlockDef/updateBlockDef/setBlockDefRecord/removeBlockDef): one
 *  edit = one revision = one undo entry, with reference-checked removal
 *  (a definition referenced by instances OR by another definition's inline
 *  content cannot be removed — no silent cascade). Instance content is
 *  DERIVED at render/pick/explode time from `entities` + `basePoint`
 *  through the ONE shared expansion core (definition → instance
 *  propagation without duplication). */
export interface BlockDefinitionRecord {
  readonly id: string;
  readonly name: string;
  /** The definition's insertion base point in definition coordinates: an
   *  instance at insertion point (x, y) maps p ↦ (x, y) +
   *  R(rotation)·(scale·(p − basePoint)). */
  readonly basePoint: { readonly x: number; readonly y: number };
  /** The definition's inline entity content (see BlockEntityRecord). */
  readonly entities: readonly BlockEntityRecord[];
  /** Free-form description. Absent = none. */
  readonly description?: string;
  /** CAD-PARITY-012 (additive, Issue #102): the definition's DEFAULT
   *  material association — must reference an existing bim.material
   *  element while set (validated at the command layer, where the element
   *  world is visible). An instance's own materialId overrides it. Absent
   *  = no definition default; NEVER undefined-valued in stored records
   *  (the additive-optional contract keeps pre-P012 fixtures
   *  byte-identical). */
  readonly materialId?: string;
  /** Fixed deterministic timestamp (provenance; mirrors the IFC records). */
  readonly createdAt: string;
}

/** An attached external reference (CAD-PARITY-006, CAD-2D-008 bounded
 *  first slice). Canonical identity `xr-NNNNNN` is minted by the document.
 *  The bounded lifecycle: attach (with resolved content → "loaded", or
 *  without → "unresolved"), reload (re-resolve with fresh content),
 *  detach (an explicit cascade that removes the record AND its instances
 *  as ONE atomic batch — never a silent cascade). `sourceHash` is the
 *  SHA-256 over the canonical serialization of the external snapshot when
 *  loaded (provenance; null while unresolved). Resolved content is stored
 *  INLINE (`entities`, base point fixed at the origin — external snapshot
 *  coordinates map directly) so save/open stays loaded; `path` is the
 *  user-facing provenance address. No binding/overlay/underlay semantics
 *  in this slice (honest bounds — the workspace commands surface typed
 *  declines). */
export interface XrefRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly status: "loaded" | "unresolved";
  readonly sourceHash: string | null;
  /** Fixed deterministic attach timestamp. */
  readonly attachedAt: string;
  /** The resolved inline content (empty while unresolved). */
  readonly entities: readonly BlockEntityRecord[];
}

// --- CAD-PARITY-007 (additive): parametric constraints ---------------------

/** The anchor vocabulary a constraint may address on an entity — the
 *  canonical geometry view (the CAD-PARITY-005 resolveAnchor precedent).
 *  Which anchors exist depends on the entity type (line: start/end/midpoint;
 *  circle/arc: center (+ arc start/end); point: start). */
export type ConstraintAnchor = "start" | "end" | "center" | "midpoint";

/** The geometric constraint vocabulary (CAD-PARITY-007 bounded first
 *  slice — Issue #86; every kind has a closed-form deterministic
 *  application in the shared solver):
 *  - horizontal / vertical — a line's direction is level / plumb;
 *  - coincident — two anchors occupy the same position;
 *  - parallel / perpendicular — two lines' directions;
 *  - equal — two lines' lengths or two circles'/arcs' radii;
 *  - tangent — line↔circle/arc (distance(center, line) = r) or
 *    circle↔circle (external: d = r1 + r2, internal: d = |r1 − r2| —
 *    the mode is explicit on the record, never guessed);
 *  - fixed — the whole entity (no anchor) or one anchor is pinned;
 *    the solver never moves a fixed anchor. */
export type GeometricConstraintKind =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "fixed";

/** The dimensional constraint vocabulary: value is millimetres for
 *  distance/radius and RADIANS for angle (the document's canonical unit
 *  convention; prompts convert). `distance` addresses a line's length
 *  (one target) or the separation of two anchors (two targets — moved
 *  along the CURRENT separation direction, deterministic);
 *  `angle` addresses two lines (the second rotates);
 *  `radius` addresses one circle/arc. */
export type DimensionalConstraintKind = "distance" | "angle" | "radius";

export type ConstraintKind = GeometricConstraintKind | DimensionalConstraintKind;

/** One constraint address: a canonical element id + (for anchor-addressed
 *  constraints) the anchor. The id is the DOCUMENT identity — constraints
 *  bind canonical identity, never engine ids (LOCK-019). */
export interface ConstraintTarget {
  readonly id: string;
  readonly anchor?: ConstraintAnchor;
}

/** A parametric constraint record (CAD-PARITY-007). Canonical identity
 *  `con-NNNNNN` is minted by the document (monotonic, never reused — the
 *  blk-/xr- pattern). Constraints are versioned document STRUCTURE edited
 *  through the DocumentEdit command model (addConstraint/updateConstraint/
 *  setConstraintRecord/removeConstraint): one edit = one revision = one
 *  undo entry. The stored record is the DECLARED graph only — satisfaction
 *  status is COMPUTED on demand by the shared solver (constraints.diagnostics),
 *  never persisted stale. */
export interface ConstraintRecord {
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly targets: readonly ConstraintTarget[];
  /** The dimensional value (mm; radians for angle) — dimensional kinds only. */
  readonly value?: number;
  /** The tangency configuration — tangent circle↔circle only (absent =
   *  external; line↔circle tangency has no modes). */
  readonly mode?: "external" | "internal";
  /** Fixed deterministic creation timestamp (provenance). */
  readonly createdAt: string;
}

// --- CAD-PARITY-008 (additive): layouts, viewports, page setup, plotting ---

/** The named ISO paper sizes of the bounded layout slice (portrait sheet
 *  dimensions in mm; "CUSTOM" carries explicit widthMm/heightMm). */
export type LayoutPaperSizeName = "A4" | "A3" | "A2" | "A1" | "A0" | "CUSTOM";

/** The page setup of ONE layout (CAD-PARITY-008, CAD-2D-009 bounded).
 *  Embedded per layout (one ACTIVE setup per layout — the named-page-setup
 *  TABLE is an explicit non-goal of this slice). Margins define the
 *  printable area; `plotScale` is the bounded plot policy: "fit" (the
 *  layout plots at exact paper size — the bounded layout-plot equivalence)
 *  or an explicit "N:M" sheet-scale ratio (paper mm : output units).
 *  `plotStyleTable` is an EXPLICIT document setting: a named CTB/STB
 *  reference persists with the record, but applying proprietary
 *  CTB/STB plot styles is a TYPED DECLINE (plot_unsupported) — the
 *  bounded slice plots "as displayed" with plotStyleKind "none"
 *  (honest bounds, LOCK-007). */
export interface PageSetup {
  readonly paperSize: LayoutPaperSizeName;
  /** Portrait sheet width in mm (landscape swaps at use). */
  readonly widthMm: number;
  /** Portrait sheet height in mm. */
  readonly heightMm: number;
  readonly orientation: "portrait" | "landscape";
  /** Sheet margins in mm (top/right/bottom/left of the ORIENTED sheet). */
  readonly marginsMm: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  /** "fit" or "N:M" (N paper mm : M output units) — see interface doc. */
  readonly plotScale: string;
  /** Plot origin offset in mm applied to the plotted layout content
   *  relative to the printable-area origin. */
  readonly plotOriginMm: readonly [number, number];
  /** Center the plotted content in the printable area (overrides the
   *  origin translation when true). */
  readonly centerPlot: boolean;
  /** Named plot style table reference (explicit document setting). */
  readonly plotStyleTable: string | null;
  readonly plotStyleKind: "none" | "ctb" | "stb";
  /** Plot viewport borders. Absent = true. */
  readonly plotViewports?: boolean;
}

/** A paper-space layout (CAD-PARITY-008). Canonical identity `lo-NNNNNN`
 *  is minted by the document (monotonic, never reused — the blk-/xr-/con-
 *  pattern); the NAME is the user-facing address (unique among layouts;
 * rename is safe — viewports reference the immutable id). Layouts are
 *  versioned document STRUCTURE edited through the DocumentEdit command
 *  model (addLayout/updateLayout/setLayoutRecord/removeLayout): one edit =
 *  one revision = one undo entry. A layout's paper-space CONTENT is its
 *  viewport records (a separate table keyed by layoutId) — model geometry
 *  is REFERENCED through viewports, never copied (the sheet/plot IR is
 *  DERIVED state, recomputed on demand and never stored). */
export interface LayoutRecord {
  readonly id: string;
  readonly name: string;
  readonly pageSetup: PageSetup;
  /** Fixed deterministic creation timestamp (provenance). */
  readonly createdAt: string;
}

/** One per-viewport layer visibility override (CAD-PARITY-008 bounded to
 *  the EXISTING layer model — the VPLAYER visibility surface): an absent
 *  field inherits the layer-table value. Per-viewport color/linetype
 *  overrides are an explicit non-goal of this slice. */
export interface ViewportLayerOverride {
  readonly layerId: string;
  /** Absent = inherit the layer table's `visible`. */
  readonly visible?: boolean;
  /** Absent = inherit the layer table's `frozen`. */
  readonly frozen?: boolean;
}

/** A rectangular layout viewport (CAD-PARITY-008). Canonical identity
 *  `vp-NNNNNN` is minted by the document (monotonic, never reused).
 *  `corner1`/`corner2` are the paper-space rectangle corners in sheet mm
 *  (y-up from the sheet's lower-left). The viewport displays model space
 *  through the deterministic model↔paper transform: paper = vpCenter +
 *  R(rotationDeg)·((model − camera) / scaleDenominator) — `camera` is the
 *  model-space view center, `scaleDenominator` the model units per paper
 *  mm (50 for 1:50), `rotationDeg` the view twist (degrees CCW).
 *  `locked` locks the VIEW (camera/scale/rotation reject edits — the frame
 *  still moves/resizes, AutoCAD display-lock semantics); the model content
 *  is clipped to the rectangle (rectangular clipping only — the bounded
 *  slice's declared limit). */
export interface ViewportRecord {
  readonly id: string;
  readonly layoutId: string;
  readonly corner1: readonly [number, number];
  readonly corner2: readonly [number, number];
  readonly camera: { readonly centerX: number; readonly centerY: number };
  /** Model units per paper mm. > 0. */
  readonly scaleDenominator: number;
  /** View twist in degrees CCW. */
  readonly rotationDeg: number;
  /** Absent = false. */
  readonly locked?: boolean;
  /** Absent = inherit the layer table per field. */
  readonly layerOverrides?: readonly ViewportLayerOverride[];
}

// --- CAD-PARITY-009 (additive, Issue #90): the 3D navigation / UCS /
// workplane / bounded-modeling contracts ---------------------------------

/** A user coordinate system definition (CAD-PARITY-009). Canonical identity
 *  `ucs-NNNNNN` is minted by the document (monotonic, never reused — the
 *  lo-/vp- pattern); the NAME is the user-facing address (unique among
 *  UCSs). The WORLD UCS is implicit — it is NOT a table record (never
 *  minted, never removable, addressable as "world" / the null active id)
 *  — the AutoCAD WCS precedent. The axis triple must be right-handed
 *  orthonormal (x × y = z, unit lengths, pairwise ⊥ within the documented
 *  tolerance) — validated at the document boundary; degenerate or
 *  non-orthonormal triples are typed declines (never silently normalized).
 *  UCS records are versioned document STRUCTURE edited through the
 *  DocumentEdit command model (addUcs/updateUcs/setUcsRecord/removeUcs):
 *  one edit = one revision = one undo entry. Which UCS is ACTIVE is
 *  non-versioned editor state (draftingSettings.activeUcs — the
 *  activeLayout precedent). */
export interface UcsRecord {
  readonly id: string;
  readonly name: string;
  /** Workplane origin in world coordinates (any finite point). */
  readonly origin: Vec3;
  /** Unit + orthonormal axis triple in world coordinates. */
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
  /** Fixed deterministic creation timestamp (provenance). */
  readonly createdAt: string;
}

/** A section/slice plane definition (CAD-PARITY-009 — the bounded section
 *  PREVIEW foundation). Canonical identity `sp-NNNNNN` is minted by the
 *  document (monotonic, never reused); the NAME is the user-facing address
 *  (unique among section planes). The plane is the set { p : (p − origin)·n
 *  = 0 } with a UNIT normal. Section planes are versioned document
 *  STRUCTURE (addSectionPlane/updateSectionPlane/setSectionPlaneRecord/
 *  removeSectionPlane); the derived preview (the bounded plane∩bbox
 *  intersection surface) is DERIVED state, recomputed on demand and never
 *  stored — the Plot IR precedent. Exact BRep cross-sections are a typed
 *  decline at the adapter boundary in this slice. */
export interface SectionPlaneRecord {
  readonly id: string;
  readonly name: string;
  readonly origin: Vec3;
  /** Unit plane normal (any finite direction; normalized/validated at the
   *  document boundary — the zero vector is a typed decline). */
  readonly normal: Vec3;
  /** Fixed deterministic creation timestamp (provenance). */
  readonly createdAt: string;
}

/** The persisted deterministic 3D camera state (CAD-PARITY-009). Eye/
 *  target/up is the right-handed view frame (up ⊥ (target − eye), both
 *  unit-normalized deterministically by the shared camera module before
 *  persistence). `mode` selects the projection: orthographic uses
 *  `orthoHalfHeight` (world units of the viewport half-height at the
 *  target plane — the zoom handle), perspective uses `fovDeg` (vertical
 *  field of view) with the eye↔target distance as the zoom handle. The
 *  state is persisted as NON-VERSIONED editor settings
 *  (draftingSettings.view3d — the draftingSettings.view precedent): view
 *  state is strictly separated from model history (never in the revision
 *  content hashes, never undoable, restored by save/open on every host). */
export interface Camera3DState {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly mode: "orthographic" | "perspective";
  /** Orthographic zoom handle: world units of the viewport half-height.
 *  > 0. */
  readonly orthoHalfHeight: number;
  /** Perspective vertical field of view in degrees. (0, 180). */
  readonly fovDeg: number;
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
  /** CAD-PARITY-004 (additive + optional): the ACTIVE layer for new drafting
   *  entities (persisted editor state, survives save/open on every host).
   *  Absent = "0" (the canonical default layer). Setting an active layer that
   *  is frozen is rejected (AutoCAD-class rule — you cannot draw on a frozen
   *  layer). */
  readonly activeLayer?: string;
  /** CAD-PARITY-004: lineweight DISPLAY toggle (LWDISPLAY class). Absent =
   *  false (hairline 1px rendering — legacy behavior). */
  readonly lineweightDisplay?: boolean;
  /** CAD-PARITY-004: current text style name (reserved "Standard" or a
   *  document text style). Absent = "Standard". */
  readonly textStyle?: string;
  /** CAD-PARITY-004: current dimension style name. Absent = "Standard". */
  readonly dimStyle?: string;
  /** CAD-PARITY-004: persistent drawing standards (LTSCALE-class globals).
   *  Absent = all defaults (linetypeScale 1, defaultLineweight 0.25, no
   *  layer standard applied). */
  readonly standards?: DrawingStandards;
  /** CAD-PARITY-008: the ACTIVE layout id (persisted editor state — the
   *  activeLayout precedent; survives save/open on every host). Absent =
   *  the first layout in table order when layouts exist (Model space is
   *  the drafting view itself, never a layout). */
  readonly activeLayout?: string;
  /** CAD-PARITY-008: the TILEMODE-class space context. "model" = model
   *  space (TILEMODE 1 — the Model view), "paper" = the active layout
   *  (TILEMODE 0 — MSPACE/PSPACE switch between them). Absent = "model". */
  readonly space?: "model" | "paper";
  /** CAD-PARITY-009: the ACTIVE UCS id — the current-workplane semantics
   *  (non-versioned editor state, the activeLayout precedent; survives
   *  save/open on every host). "world" (or absent) = the implicit World
   *  UCS; any other value must reference an existing ucs table record at
   *  set time (dangling ids are rejected by the command layer and reset to
   *  World on open as a defensive repair). */
  readonly activeUcs?: string;
  /** CAD-PARITY-009: the persisted deterministic 3D camera state
   *  (non-versioned editor settings, the draftingSettings.view precedent —
   *  view state strictly separated from model history). Absent = the
   *  default isometric camera the shared camera module derives. */
  readonly view3d?: Camera3DState;
}

/** CAD-PARITY-004 persistent drawing standards: the document-wide display
 *  standards that govern linetype pattern scaling and the default lineweight
 *  for layers/entities that do not specify one. Persisted with the snapshot
 *  (non-versioned settings — same class as grid/snap/view). */
export interface DrawingStandards {
  /** Linetype pattern scale (LTSCALE): dash/gap lengths multiply by this.
   *  > 0. Absent/default = 1. */
  readonly linetypeScale?: number;
  /** Default lineweight (mm) for ByLayer resolution when a layer does not
   *  specify one. Must be a standard lineweight. Absent/default = 0.25. */
  readonly defaultLineweight?: number;
  /** CAD-PARITY-005 (additive + optional): the document-wide ANNOTATION
   *  scale (DIMSCALE-class). Multiplies every dimension annotation's
   *  effective text height / arrow size (field × style.scale × this).
   *  > 0. Absent/default = 1 — legacy snapshots stay byte-identical. */
  readonly annotationScale?: number;
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
  /** CAD-PARITY-004: user-defined linetypes (absent on legacy snapshots and
 *   *  while empty — the built-in catalog is code-resolved so legacy saves
 *   *  stay byte-identical; versioned through the addLtype/updateLtype/
 *   *  removeLtype command model). */
  readonly ltypes?: readonly LtypeRecord[];
  /** CAD-PARITY-004: user-defined text styles (absent while empty; the
 *   *  reserved "Standard" style is code-resolved). */
  readonly textStyles?: readonly TextStyleRecord[];
  /** CAD-PARITY-004: user-defined dimension styles (absent while empty; the
 *   *  reserved "Standard" style is code-resolved). */
  readonly dimStyles?: readonly DimStyleRecord[];
  /** CAD-PARITY-004: named layer states (absent while empty; versioned
 *   *  through the addLayerState/removeLayerState command model). */
  readonly layerStates?: readonly LayerStateRecord[];
  /** CAD-PARITY-006: reusable block/component definitions (absent while
 *   *  empty so legacy snapshots and the pinned CAD-PARITY-002/004/005
 *   *  fixtures stay byte-identical; versioned through the addBlockDef/
 *   *  updateBlockDef/removeBlockDef command model). */
  readonly blockDefs?: readonly BlockDefinitionRecord[];
  /** CAD-PARITY-006: attached external references (absent while empty;
 *   *  same additive-optional + versioned-command-model contract). */
  readonly xrefs?: readonly XrefRecord[];
  /** CAD-PARITY-007: parametric constraints (absent while empty so legacy
 *   *  snapshots and the pinned CAD-PARITY-002/004/005/006 fixtures stay
 *   *  byte-identical; versioned through the addConstraint/updateConstraint/
 *   *  setConstraintRecord/removeConstraint command model). The declared
 *   *  constraint graph only — satisfaction is computed on demand, never
 *   *  stored stale. */
  readonly constraints?: readonly ConstraintRecord[];
  /** CAD-PARITY-008: paper-space layouts (absent while empty so legacy
   *  snapshots and the pinned CAD-PARITY-002/004/005/006/007 fixtures stay
   *  byte-identical; versioned through the addLayout/updateLayout/
   *  setLayoutRecord/removeLayout command model). */
  readonly layouts?: readonly LayoutRecord[];
  /** CAD-PARITY-008: rectangular layout viewports (absent while empty;
   *  versioned through the addViewport/updateViewport/setViewportRecord/
   *  removeViewport command model — model geometry is referenced, never
   *  copied; the sheet/plot IR is derived state, never stored). */
  readonly viewports?: readonly ViewportRecord[];
  /** CAD-PARITY-009: named UCS/workplane definitions (absent while empty
   *  so legacy snapshots and the pinned CAD-PARITY-002..008 fixtures stay
   *  byte-identical; versioned through the addUcs/updateUcs/setUcsRecord/
   *  removeUcs command model; the World UCS is implicit, never a record). */
  readonly ucs?: readonly UcsRecord[];
  /** CAD-PARITY-009: section/slice plane definitions (absent while empty;
   *  versioned through the addSectionPlane/updateSectionPlane/
   *  setSectionPlaneRecord/removeSectionPlane command model — the derived
   *  bounded preview is recomputed on demand, never stored). */
  readonly sectionPlanes?: readonly SectionPlaneRecord[];
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
    }
  // --- CAD-PARITY-004 (additive): linetype / text-style / dim-style -------
  // --- tables and layer states (name-keyed: the domain reference model) ----
  | {
      readonly type: "addLtype";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly ltype: LtypeRecord;
    }
  | {
      readonly type: "updateLtype";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly ltypeName: string;
    }
  | {
      readonly type: "removeLtype";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly ltypeName: string;
    }
  | {
      readonly type: "addTextStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly style: TextStyleRecord;
    }
  | {
      readonly type: "updateTextStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly styleName: string;
    }
  | {
      readonly type: "removeTextStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly styleName: string;
    }
  | {
      readonly type: "addDimStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly style: DimStyleRecord;
    }
  | {
      readonly type: "updateDimStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly styleName: string;
    }
  | {
      readonly type: "removeDimStyle";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly styleName: string;
    }
  | {
      /** Add-or-replace a named layer state (same name → replace, the
       *  LAYERSTATE re-save semantics). */
      readonly type: "addLayerState";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly state: LayerStateRecord;
    }
  | {
      readonly type: "removeLayerState";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly stateName: string;
    }
  // --- CAD-PARITY-006 (additive): block definitions + external references ---
  | {
      /** Add a block definition. A missing/empty id mints a canonical
       *  `blk-NNNNNN` identity (the addElement/addLayer pattern); a
       *  duplicate name or id is rejected. Inline entities are validated
       *  against the block-content vocabulary; cyclic references and
       *  over-depth nesting are rejected at this gate. */
      readonly type: "addBlockDef";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly block: BlockDefinitionRecord;
    }
  | {
      /** Patch a block definition (name/basePoint/description/entities —
       *  entities replaces the whole inline array). */
      readonly type: "updateBlockDef";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly blockId: string;
    }
  | {
      /** Full-record definition restore (exact inverse semantics — mirrors
       *  setProps/setViewRecord: used as the updateBlockDef inverse when a
       *  patch added a key, so absence of keys is representable on
       *  undo/replay). */
      readonly type: "setBlockDefRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly blockId: string;
      readonly block: BlockDefinitionRecord;
    }
  | {
      /** Remove a block definition. Rejected while instances or other
       *  definitions' inline content still reference it (no silent
       *  cascade). */
      readonly type: "removeBlockDef";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly blockId: string;
    }
  | {
      /** Attach an external reference (minting `xr-NNNNNN` when the id is
       *  missing). status "loaded" requires inline entities + sourceHash;
       * "unresolved" carries empty entities + null hash. */
      readonly type: "addXref";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly xref: XrefRecord;
    }
  | {
      /** Patch an external reference (name/path/status/sourceHash/
       *  entities — reload rewrites status + sourceHash + entities
       *  together). */
      readonly type: "updateXref";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly xrefId: string;
    }
  | {
      /** Full-record xref restore (setBlockDefRecord semantics for xrefs). */
      readonly type: "setXrefRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly xrefId: string;
      readonly xref: XrefRecord;
    }
  | {
      /** Remove an external reference record. Rejected while instance
       *  elements still reference it — the DETACH command removes the
       *  instances and the record as ONE atomic batch (the explicit
       *  cascade lives at the command layer, never silently here). */
      readonly type: "removeXref";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly xrefId: string;
    }
  // --- CAD-PARITY-007 (additive): the parametric constraint table ----------
  | {
      /** Add a constraint record. A missing/empty id mints a canonical
       *  `con-NNNNNN` identity (the addElement/addBlockDef pattern); a
       *  duplicate id is rejected. The record's kind/targets/value
       *  combination is validated against the constraint vocabulary (the
       *  shared workspace core); target ELEMENTS need not exist at the
       *  raw-edit level (the command layer severs dead constraints
       *  explicitly — the CAD-PARITY-005 dead-ref precedent), but the
       *  structural record shape is enforced here. */
      readonly type: "addConstraint";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly constraint: ConstraintRecord;
    }
  | {
      /** Patch a constraint (value/mode — the declaration semantics).
       *  Geometry consequences (the re-solve) are computed by the command
       *  layer and travel as element edits in the SAME atomic batch — this
       *  edit only rewrites the declared record. */
      readonly type: "updateConstraint";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly constraintId: string;
    }
  | {
      /** Full-record constraint restore (exact inverse semantics — mirrors
       *  setBlockDefRecord: used as the updateConstraint inverse so absence
       *  of keys is representable on undo/replay). */
      readonly type: "setConstraintRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly constraintId: string;
      readonly constraint: ConstraintRecord;
    }
  | {
      /** Remove a constraint record (the solver's graph forgets it). */
      readonly type: "removeConstraint";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly constraintId: string;
    }
  // --- CAD-PARITY-008 (additive): the layout + viewport tables ----------
  | {
      /** Add a paper-space layout. A missing/empty id mints a canonical
       *  `lo-NNNNNN` identity (the addBlockDef pattern); duplicate ids and
       *  duplicate names are rejected. The embedded page setup is
       *  validated as a whole. */
      readonly type: "addLayout";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly layout: LayoutRecord;
    }
  | {
      /** Patch a layout (name — kept unique — and/or the whole pageSetup
       *  object; id/createdAt are immutable). */
      readonly type: "updateLayout";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly layoutId: string;
    }
  | {
      /** Full-record layout restore (exact inverse semantics — mirrors
       *  setConstraintRecord: used as the updateLayout inverse so absence
       *  of keys is representable on undo/replay). */
      readonly type: "setLayoutRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly layoutId: string;
      readonly layout: LayoutRecord;
    }
  | {
      /** Remove a layout record. Rejected while viewport records still
       *  reference it — the LAYOUTDELETE command removes the viewports and
       *  the record as ONE atomic batch (the explicit cascade lives at the
       *  command layer, the xref.detach precedent — never silently here).
       *  The LAST remaining layout is rejected (a document always keeps at
       *  least one layout once one exists — the AutoCAD last-tab rule). */
      readonly type: "removeLayout";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly layoutId: string;
    }
  | {
      /** Add a rectangular layout viewport. A missing/empty id mints a
       *  canonical `vp-NNNNNN` identity; the layoutId must reference an
       *  existing layout at apply time; the camera/scale/rotation/rect
       *  combination is validated as a whole. */
      readonly type: "addViewport";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly viewport: ViewportRecord;
    }
  | {
      /** Patch a viewport (corner1/corner2/camera/scaleDenominator/
       *  rotationDeg/locked/layerOverrides — id/layoutId are immutable).
       *  The merged record re-validates as a whole. */
      readonly type: "updateViewport";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly viewportId: string;
    }
  | {
      /** Full-record viewport restore (setLayoutRecord semantics). */
      readonly type: "setViewportRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly viewportId: string;
      readonly viewport: ViewportRecord;
    }
  | {
      /** Remove a viewport record (the layout forgets it; model geometry
       *  is untouched — viewports reference, never own). */
      readonly type: "removeViewport";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly viewportId: string;
    }
  // --- CAD-PARITY-009 (additive): the UCS + section-plane tables ------
  | {
      /** Add a named UCS/workplane definition. A missing/empty id mints a
       *  canonical `ucs-NNNNNN` identity (the addLayout pattern); duplicate
       *  ids and duplicate names are rejected; the origin + axis triple is
       *  validated as a whole (right-handed orthonormal within tolerance —
       *  degenerate/non-orthonormal triples are rejected, never silently
       *  normalized). */
      readonly type: "addUcs";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly ucs: UcsRecord;
    }
  | {
      /** Patch a UCS (name — kept unique — and/or origin/axes; id/createdAt
       *  are immutable). The merged record re-validates as a whole. */
      readonly type: "updateUcs";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly ucsId: string;
    }
  | {
      /** Full-record UCS restore (exact inverse semantics — mirrors
       *  setLayoutRecord: used as the updateUcs inverse so absence of keys
       *  is representable on undo/replay). */
      readonly type: "setUcsRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly ucsId: string;
      readonly ucs: UcsRecord;
    }
  | {
      /** Remove a UCS record. Rejected while section-plane records still
       *  reference it? — NO: section planes are self-contained (origin +
       *  normal), so there is no dangling-reference gate; removing the
       *  ACTIVE UCS is a command-layer typed decline (ucs_active —
       *  activate World first), never silently here. */
      readonly type: "removeUcs";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly ucsId: string;
    }
  | {
      /** Add a section/slice plane definition. A missing/empty id mints a
       *  canonical `sp-NNNNNN` identity; duplicate ids and duplicate names
       *  are rejected; origin + unit normal validated as a whole. */
      readonly type: "addSectionPlane";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sectionPlane: SectionPlaneRecord;
    }
  | {
      /** Patch a section plane (name/origin/normal; id/createdAt immutable).
       *  The merged record re-validates as a whole. */
      readonly type: "updateSectionPlane";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly sectionPlaneId: string;
    }
  | {
      /** Full-record section-plane restore (setLayoutRecord semantics). */
      readonly type: "setSectionPlaneRecord";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sectionPlaneId: string;
      readonly sectionPlane: SectionPlaneRecord;
    }
  | {
      /** Remove a section-plane record (the derived preview recomputes on
       *  demand — nothing stored references it). */
      readonly type: "removeSectionPlane";
      readonly elementId?: undefined;
      readonly element?: undefined;
      readonly patch?: undefined;
      readonly sectionPlaneId: string;
    };
