/**
 * CAD-PARITY-018 (Issue #118) — the specialized-toolsets shared contract
 * types (additive, Architecture v1.1 FROZEN).
 *
 * These are the bounded, versioned, typed contracts for the four
 * specialized professional toolsets composed over the verified CAD/BIM
 * core: the architecture composition vocabulary (wall runs, hosted
 * openings, roofs, stair runs, space grids, component arrays, dimension
 * chains), the bounded MEP routing records (duct/pipe/conduit runs with
 * in-record connections), the bounded mechanical equipment records (ports
 * with connector metadata), and the canonical raster/underlay
 * reference records (identity, transform, clipping, visibility) with the
 * typed non-authoritative trace/vectorization results.
 *
 * Governing boundary (LOCK-019, the P015/P017 precedents): the
 * Construction Graph / CADDocument stays the canonical system of record.
 * Specialized records are DOCUMENT-OWNED rows of the CADDocument
 * specialized table (`tls-NNNNNN` identities minted by the document,
 * monotonic, never reused, checkpointed in the model history) and every
 * specialized mutation flows through `doc.execute(edit)` — ONE atomic
 * revision per mutating command, exact undo/redo/replay. Architecture
 * composition does NOT mint specialized records: it emits EXACTLY the
 * element-creation batches the existing `bim.createElements` /
 * `drafting.createEntities` paths produce (the same builders, the same
 * validation — no parallel element semantics, no fabricated geometry).
 *
 * Engine boundary (LOCK-003/018, unchanged): the toolsets core
 * (app/src/toolsets) is pure TypeScript — no engine imports, no host
 * imports, no environment reads, no wall-clock, no random. MEP clash
 * diagnostics are deterministic 2D center-line/rectangle distances over
 * the canonical wall/slab records; raster traces are exact fixed-formula
 * trigonometry over the declared transform — never an engine call.
 *
 * Determinism convention: every derivation here is a pure function of the
 * canonical records (deterministic ordering, exact distances, fixed
 * violation codes). Repeated execution over identical canonical inputs
 * yields byte-identical declared outputs (the reproducibility contract).
 *
 * Typed failure codes surfaced by the toolsets core (documented here, the
 * module `Error` subclass carries them; the App API maps them typed):
 *  - toolset_bad_payload      — malformed/invalid record or payload data
 *  - toolset_not_found        — unknown specialized record id
 *  - toolset_unsupported      — a requested capability outside the bounded
 *                               model (never a fabricated semantic)
 *  - toolset_route_invalid    — an MEP route that violates the routing
 *                               grammar (continuity/orthogonality/…)
 *  - toolset_reference_missing— a raster reference whose source does not
 *                               exist (missing underlay)
 *  - toolset_reference_stale  — a raster reference whose declared digest
 *                               no longer matches the source (stale)
 *  - toolset_host_not_found   — an architecture composition whose host
 *                               element (wall/story/stair) does not exist
 *  - toolset_out_of_bounds    — a request exceeding the declared bounds
 */

// ---------------------------------------------------------------------------
// The specialized-toolsets API version (API-001: additive-only; breaking
// changes create a new version — the App API §8 convention).
// ---------------------------------------------------------------------------

/** The specialized-toolsets contract version. */
export const TOOLSETS_API_VERSION = "1" as const;
export type ToolsetsApiVersion = typeof TOOLSETS_API_VERSION;

// ---------------------------------------------------------------------------
// Bounds (the closed surface limits — every bound is enforced typed, never
// silently truncated).
// ---------------------------------------------------------------------------

/** Maximum segments per MEP run record. */
export const TOOLSETS_MAX_SEGMENTS_PER_RUN = 64;
/** Maximum retained MEP run records per document. */
export const TOOLSETS_MAX_RUNS = 512;
/** Maximum connections per MEP run (locally-unique ordinal ids). */
export const TOOLSETS_MAX_CONNECTIONS_PER_RUN = 8;
/** Maximum retained mechanical equipment records per document. */
export const TOOLSETS_MAX_EQUIPMENT = 512;
/** Maximum ports per mechanical equipment record (ordinal ids p1..pN). */
export const TOOLSETS_MAX_PORTS_PER_EQUIPMENT = 16;
/** Maximum cells of a mechanical/architecture rectangular array. */
export const TOOLSETS_MAX_ARRAY_CELLS = 1024;
/** Maximum cells of an array along ONE axis (cols/rows bound). */
export const TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS = 32;
/** Maximum retained raster source records per document. */
export const TOOLSETS_MAX_RASTER_SOURCES = 64;
/** Maximum retained raster reference records per document. */
export const TOOLSETS_MAX_RASTER_REFERENCES = 64;
/** Maximum lineWork vectors per raster source record. */
export const TOOLSETS_MAX_LINEWORK_VECTORS = 256;
/** Maximum vertices of an architecture polyline (wall run / grid). */
export const TOOLSETS_MAX_POLYLINE_VERTICES = 64;
/** Maximum cells of a space grid (cols × rows). */
export const TOOLSETS_MAX_GRID_CELLS = 1024;
/** Maximum points of a dimension chain. */
export const TOOLSETS_MAX_DIM_POINTS = 128;

/** Duct nominal size bounds (mm). */
export const TOOLSETS_DUCT_NOMINAL_MIN_MM = 50;
export const TOOLSETS_DUCT_NOMINAL_MAX_MM = 2000;
/** Pipe nominal size bounds (mm). */
export const TOOLSETS_PIPE_NOMINAL_MIN_MM = 15;
export const TOOLSETS_PIPE_NOMINAL_MAX_MM = 600;
/** Conduit nominal size bounds (mm). */
export const TOOLSETS_CONDUIT_NOMINAL_MIN_MM = 16;
export const TOOLSETS_CONDUIT_NOMINAL_MAX_MM = 300;

/** Raster transform scale bounds (document-mm per raster-pixel). */
export const TOOLSETS_RASTER_SCALE_MIN = 0.01;
export const TOOLSETS_RASTER_SCALE_MAX = 100;

// ---------------------------------------------------------------------------
// The MEP domain vocabulary + the run record payload.
// ---------------------------------------------------------------------------

/** The closed MEP domain vocabulary. */
export type MepDomain = "duct" | "pipe" | "conduit";

/** A 3D point in the toolsets grammar (document mm; plain object form —
 *  the deterministic payload shape the wire/table carry). */
export interface ToolsetPoint3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The run cross-section shape vocabulary. */
export type MepRunShape = "round" | "rect";

/** One straight route segment (start → end, document mm). */
export interface MepSegment {
  readonly start: ToolsetPoint3;
  readonly end: ToolsetPoint3;
}

/** The connection target grammar (a discriminated union): an equipment
 *  port, another run's end, or a free endpoint in space. */
export type MepConnectionTarget =
  | { readonly kind: "equipment"; readonly equipmentId: string; readonly portId: string }
  | { readonly kind: "run"; readonly runId: string; readonly end: "start" | "end" }
  | { readonly kind: "endpoint"; readonly point: ToolsetPoint3 };

/** One connection declared ON a run (bounded, in-record — no separate
 *  connection table). The id is LOCALLY unique within the run and
 *  deterministic (ordinal `c1`, `c2`, …); the canonical identity of the
 *  run itself is the document-minted `tls-NNNNNN` record id. */
export type MepConnectionEnd = "start" | "end";

export interface MepConnection {
  readonly id: string;
  /** Which end of THIS run the connection attaches to. */
  readonly at: "start" | "end";
  readonly target: MepConnectionTarget;
  /** The domain the connection declares (domain-neutral placement — a
   *  mismatch with the run/target domain is the typed unsupported
   *  decline, never a guess). */
  readonly domain: MepDomain;
}

/** The `mep.run` specialized-record data payload. */
export interface MepRunData {
  readonly domain: MepDomain;
  readonly shape: MepRunShape;
  /** Nominal size (mm): the diameter for round, the larger side for rect
   *  (the domain bounds above are enforced typed). */
  readonly nominalSize: number;
  /** Optional insulation thickness (mm, ≥ 0). */
  readonly insulationMm?: number;
  readonly name?: string;
  readonly segments: readonly MepSegment[];
  readonly connections?: readonly MepConnection[];
}

// ---------------------------------------------------------------------------
// The mechanical equipment record payload.
// ---------------------------------------------------------------------------

/** The closed port kind vocabulary (connector metadata). */
export type MechPortKind = "supply" | "return" | "drain" | "vent" | "power" | "signal";

/** One equipment port: locally-unique ordinal id (`p1`, `p2`, …), the
 *  connector kind, the position (document mm, moves WITH the equipment)
 *  and optional nominal/domain metadata for fluid ports. */
export interface MechPort {
  readonly id: string;
  readonly kind: MechPortKind;
  readonly position: ToolsetPoint3;
  /** Fluid ports: the nominal size (mm, domain bounds enforced). */
  readonly nominal?: number;
  /** Fluid ports: the domain the connector serves. */
  readonly domain?: MepDomain;
}

/** The closed equipment kind vocabulary. */
export type MechEquipmentKind = "machine" | "pump" | "fan" | "ahu" | "panel" | "tank";

/** The `mech.equipment` specialized-record data payload. */
export interface MechEquipmentData {
  readonly kind: MechEquipmentKind;
  readonly name?: string;
  readonly origin: ToolsetPoint3;
  readonly rotationDeg?: number;
  readonly ports: readonly MechPort[];
}

// ---------------------------------------------------------------------------
// The raster/underlay records + the derived status/trace views.
// ---------------------------------------------------------------------------

/** One vector in RASTER PIXEL space (the source's lineWork). */
export interface RasterLineVector {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The reference placement transform: pixel space → document space
 *  (scale first, then rotate about the pixel origin, then translate to
 *  the document origin — fixed formula, deterministic). */
export interface RasterTransform {
  readonly origin: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly rotationDeg: number;
}

/** A pixel-space clipping rectangle. */
export interface RasterClipping {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The reference visibility state. */
export type RasterVisibility = boolean;

/** The derived reference status vocabulary. */
export type RasterReferenceStatus = "ok" | "stale" | "missing";

/** One reference's derived status row (computed fresh, never stored). */
export interface RasterStatusReport {
  readonly referenceId: string;
  readonly sourceRef: string;
  readonly status: RasterReferenceStatus;
  /** The deterministic reason text (typed, one per status). */
  readonly reason: string;
}

/** The `raster.source` specialized-record data payload: the underlay's
 *  identity by reference (`sourceRef`), its content digest (the staleness
 *  basis), its pixel dimensions and the optional bounded lineWork vector
 *  set (the trace source — typed non-authoritative). */
export interface RasterSourceData {
  readonly sourceRef: string;
  readonly contentDigest: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly lineWork?: readonly RasterLineVector[];
}

/** The `raster.reference` specialized-record data payload: the declared
 *  source (by sourceRef + declaredDigest), the placement transform, the
 *  optional pixel-space clipping, the visibility and the optional layer. */
export interface RasterReferenceData {
  readonly sourceRef: string;
  readonly declaredDigest: string;
  readonly transform: RasterTransform;
  readonly clipping?: RasterClipping;
  readonly visible: RasterVisibility;
  readonly layer?: string;
}

// ---------------------------------------------------------------------------
// The derived query views (computed fresh every call, never stored stale).
// ---------------------------------------------------------------------------

/** One capability-discovery row: every specialized App API request, its
 *  kind and one-line summary (the discovery surface of the toolsets). */
export interface ToolsetCapabilityView {
  /** The capability id — exactly the governed App API request name. */
  readonly name: string;
  readonly kind: "command" | "query";
  readonly toolset: "arch" | "mep" | "mechanical" | "raster";
  readonly summary: string;
}

/** One route-validation violation (deterministic codes, ordered by
 *  segment index). */
export interface MepRouteViolation {
  readonly code: string;
  readonly message: string;
  readonly segmentIndex?: number;
}

/** One clash/clearance diagnostic of an MEP run segment against a BIM
 *  element body (deterministic 2D distance, exact mm values, ordered by
 *  runId → segmentIndex → elementId). */
export interface MepClashDiagnostic {
  readonly runId: string;
  readonly segmentIndex: number;
  readonly elementId: string;
  readonly kindOfClash: "clearance" | "intersection";
  /** The exact center-line-to-body distance (mm; 0 on intersection). */
  readonly distanceMm: number;
  /** The required clearance (mm) that was violated. */
  readonly clearanceMm: number;
  readonly message: string;
}

/** One traced vector in DOCUMENT space (mm). */
export interface RasterTraceVector {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

/** The typed non-authoritative raster trace result: the source lineWork
 *  mapped through the reference transform (clipping applied, midpoint
 *  containment rule) — committing is REQUIRED for canonical geometry
 *  (rasterCommitTrace); this derivation is never itself authority. */
export interface RasterTraceResult {
  readonly referenceId: string;
  readonly sourceRef: string;
  readonly vectors: readonly RasterTraceVector[];
  readonly authoritative: false;
  readonly notice: string;
}
