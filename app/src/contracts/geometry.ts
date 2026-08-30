/**
 * Geometry descriptor + adapter-failure contracts (CAD-IMPLEMENT-002, §5.5).
 *
 * ADDITIVE to the App API contract surface (api-contract.md §8: additive
 * changes preserve backward compatibility; breaking changes create a new API
 * version). The `EngineAdapterBundle` contract in adapter.ts is UNCHANGED —
 * this module adds the vocabulary the new `geometry.prepare` command uses and
 * the typed-failure convention that concrete adapters throw.
 *
 * The geometry descriptor is the App API's engine-independent description of
 * a geometry request (Issue #26 minimum canonical set): box, cylinder,
 * transform (row-major 4x4 affine matrix) and boolean fuse/cut, composed
 * recursively. COMPAT-CAD-002 adds the extrusion-derived solid vocabulary;
 * CAD-PARITY-010 completes the boolean triad with `intersect` (A ∩ B).
 * Concrete adapters compile it to engine-native work; the renderer and
 * CADDocument never see it as anything but element props.
 *
 * No engine imports here (LOCK-018): this file is importable by the protected
 * core (contracts/app-api) — only the concrete adapter/worker layer may
 * import engine modules.
 */

/** Row-major 3-component vector. */
export type Vec3 = readonly [number, number, number];

/** Row-major 2-component vector (planar profile points; COMPAT-CAD-002). */
export type Vec2 = readonly [number, number];

/** Row-major 4x4 affine matrix (16 numbers). The bottom row must be
 *  [0, 0, 0, 1]; v' = M·v (row-times-column). */
export type Matrix4 = readonly number[];

/** Engine-independent geometry descriptor (minimum canonical set, Issue #26;
 *  COMPAT-CAD-002 adds the extrusion-derived solid vocabulary). */
export type GeometryDescriptor =
  | { readonly shape: "box"; readonly width: number; readonly depth: number; readonly height: number }
  | {
      readonly shape: "cylinder";
      readonly radius: number;
      readonly height: number;
      readonly origin?: Vec3;
      readonly direction?: Vec3;
    }
  | {
      /** COMPAT-CAD-002: extrusion of a planar polygon profile in the XY
       *  plane along +Z by `height`, based at `base` (default [0,0,0]). The
       *  profile is a simple (non-self-intersecting) polygon given in order,
       *  implicitly closed (first point NOT repeated at the end), with no
       *  consecutive coincident points and a non-degenerate shoelace area.
       *  Winding order does not affect the resulting solid (engines close the
       *  wire either way); the shoelace magnitude is the validation anchor. */
      readonly shape: "extrude";
      readonly profile: readonly Vec2[];
      readonly height: number;
      readonly base?: Vec3;
    }
  | { readonly shape: "transform"; readonly matrix: Matrix4; readonly target: GeometryDescriptor }
  | { readonly shape: "fuse"; readonly a: GeometryDescriptor; readonly b: GeometryDescriptor }
  | { readonly shape: "cut"; readonly a: GeometryDescriptor; readonly b: GeometryDescriptor }
  | {
      /** CAD-PARITY-010: boolean intersection (A ∩ B) — the third boolean
       *  completing the union/difference/intersection triad. Same recursive
       *  composition as fuse/cut; adapters realize it through their engine's
       *  common-intersection operation (OCCT BRepAlgoAPI_Common) or decline
       *  with a typed failure outside their exactness class. An intersection
       *  with no overlap is a typed `engine_empty_result` failure (see
       *  AdapterFailure) — never a fabricated empty solid. */
      readonly shape: "intersect";
      readonly a: GeometryDescriptor;
      readonly b: GeometryDescriptor;
    };

/** Tessellation quality knobs a geometry.prepare caller may override. */
export interface TessellationOptions {
  readonly linearDeflection?: number;
  readonly angularDeflection?: number;
}

/** `geometry.prepare` command payload (additive App API command). */
export interface GeometryPreparePayload {
  readonly geometry: GeometryDescriptor;
  readonly tessellation?: TessellationOptions;
}

/** Successful `geometry.prepare` response value. `mesh` and `metadata` are
 *  present only when the concrete adapter implements the optional
 *  MeshProvider / GeometryMetadataProvider capabilities (the dummy adapter
 *  implements neither — the fields are null). */
export interface GeometryPrepareResult {
  readonly meshToken: string;
  readonly bbox: readonly [number, number, number, number, number, number];
  readonly mesh: MeshData | null;
  readonly metadata: GeometryMetadata | null;
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}

/** Flat triangle-mesh data for viewport rendering (flat x,y,z + a,b,c). */
export interface MeshData {
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
}

/** Selection/query metadata for a prepared geometry (Issue #26 scope). */
export interface GeometryMetadata {
  readonly volume: number;
  readonly vertices: number;
  readonly triangles: number;
}

/**
 * Typed adapter failure (CAD-005 §5: typed failures at the engine boundary).
 *
 * Concrete adapters throw this; the App API maps it to the wire
 * `ErrResult { ok: false, code, message, retryable }` convention. Recognized
 * engine codes (the App API passes the code through verbatim):
 *
 *   engine_malformed_input — the geometry request failed validation or was
 *                            rejected at construction (not retryable).
 *   engine_error           — the engine itself failed (not retryable; the
 *                            disposable-worker model recovers structurally:
 *                            the next call starts a fresh process).
 *   engine_timeout         — the wall-clock budget expired at the process
 *                            boundary and the worker was killed (retryable).
 *   engine_unavailable     — the engine runtime is not present/importable in
 *                            this environment (not retryable).
 *
 * CAD-PARITY-010 (Issue #93) adds two boolean-outcome codes (typed failures
 * for invalid/non-manifold/unsupported combinations — acceptance criterion
 * 2; never a silent approximation):
 *   engine_empty_result    — the operation is well-formed but annihilates all
 *                            material (disjoint intersection, subtracting
 *                            everything). The caller surfaces the typed
 *                            domain decline (e.g. boolean_empty); no empty
 *                            solid is fabricated (not retryable).
 *   engine_non_manifold    — the operation produced a result the engine's
 *                            shape-validity check rejects (non-manifold or
 *                            self-intersecting). The caller surfaces the
 *                            typed boolean_invalid decline (not retryable).
 */
export class AdapterFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "AdapterFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Structural check (robust across bundlers/duplicated module instances). */
export function isAdapterFailure(e: unknown): e is AdapterFailure {
  if (typeof e !== "object" || e === null) return false;
  const candidate = e as { code?: unknown; retryable?: unknown };
  return e instanceof Error && typeof candidate.code === "string" && typeof candidate.retryable === "boolean";
}

/**
 * Optional geometry-adapter capability: viewport mesh data by meshToken.
 * Satisfied structurally — the protected core never imports a concrete
 * adapter; it only checks for the method's shape.
 */
export interface MeshProvider {
  describeMesh(meshToken: string): Promise<MeshData | null>;
}

export function isMeshProvider(adapter: unknown): adapter is MeshProvider {
  if (typeof adapter !== "object" || adapter === null) return false;
  const candidate = adapter as { describeMesh?: unknown };
  return typeof candidate.describeMesh === "function";
}

/**
 * Optional geometry-adapter capability: selection/query metadata by
 * meshToken (volume, tessellation stats).
 */
export interface GeometryMetadataProvider {
  describeGeometryMetadata(meshToken: string): Promise<GeometryMetadata | null>;
}

export function isGeometryMetadataProvider(adapter: unknown): adapter is GeometryMetadataProvider {
  if (typeof adapter !== "object" || adapter === null) return false;
  const candidate = adapter as { describeGeometryMetadata?: unknown };
  return typeof candidate.describeGeometryMetadata === "function";
}

// ---------------------------------------------------------------------------
// CAD-PARITY-010 (Issue #93): exact sections, deterministic topology and
// bounded quality-mesh delivery — engine-neutral contracts. All ADDITIVE
// optional capabilities following the MeshProvider precedent: the protected
// core checks for the method's SHAPE structurally and never imports a
// concrete adapter. Raw engine output crosses the boundary in canonical
// deterministic form (the adapters sort/normalize before responding); the
// engine-free shared core (workspace/model3d) owns canonical identity,
// ordering and hashes — engine entity keys ride along as PROVENANCE only
// (never canonical identity; the acceptance criterion).
// ---------------------------------------------------------------------------

/** An infinite section plane specification (origin + UNIT normal). The
 *  command layer normalizes non-unit input explicitly; adapters receive (and
 *  must validate as) a unit normal. */
export interface SectionPlaneSpec {
  readonly origin: Vec3;
  readonly normal: Vec3;
}

/** One section intersection curve as a sampled polyline (flat x,y,z triples,
 *  ≥ 2 points). Engines sample curved intersections (e.g. a cylinder's
 *  ellipse arc) with a fixed deflection so identical inputs produce
 *  identical polylines; straight intersections are exact 2-point segments. */
export interface SectionPolyline {
  readonly points: readonly number[];
}

/** Raw exact-section engine output for one prepared geometry: the plane ∩
 *  shape intersection curves in the engine's canonical order (sorted by the
 *  canonical encoding of the polylines — order-independent of internal
 *  explorer enumeration) plus provenance. Empty when the plane misses the
 *  solid entirely (a legal exact result — distinct from a failure). */
export interface SectionGeometry {
  readonly polylines: readonly SectionPolyline[];
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}

/** One face's raw topology: its OWN triangulation (flat world-space x,y,z +
 *  local a,b,c indices), a surface-type vocabulary string, area, centroid,
 *  and the engine's per-entity key (deterministic provenance — a hash over
 *  the face's canonical encoding; NEVER the canonical identity). */
export interface TopoFaceGeometry {
  readonly surfaceType: string;
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly area: number;
  readonly centroid: Vec3;
  readonly engineKey: string;
}

/** One edge's raw topology: a curve-type vocabulary string, a sampled
 *  polyline (flat x,y,z), its length, and the engine key (provenance). */
export interface TopoEdgeGeometry {
  readonly curveType: string;
  readonly points: readonly number[];
  readonly length: number;
  readonly engineKey: string;
}

/** One vertex's raw topology: its point and the engine key (provenance). */
export interface TopoVertexGeometry {
  readonly point: Vec3;
  readonly engineKey: string;
}

/** Raw topology engine output for one prepared geometry: faces, edges and
 *  vertices each sorted by their canonical geometry encoding (the engine
 *  normalizes enumeration order away) with bounded counts. */
export interface TopologyGeometry {
  readonly faces: readonly TopoFaceGeometry[];
  readonly edges: readonly TopoEdgeGeometry[];
  readonly vertices: readonly TopoVertexGeometry[];
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}

/** Bounded quality presets for progressive mesh delivery (LOD). The presets
 *  are the FULL closed vocabulary — callers cannot request arbitrary
 *  deflections through the LOD surface (deterministic bounded delivery). */
export type MeshQualityPreset = "low" | "medium" | "full";

/** A named quality preset resolved to concrete tessellation knobs. */
export interface MeshQualityKnobs {
  readonly linearDeflection: number;
  readonly angularDeflection: number;
}

/** The bounded per-mesh vertex budget the LOD surface enforces (typed
 *  engine failure beyond — never an unbounded mesh). */
export const MESH_LOD_MAX_VERTICES = 150_000;

/**
 * Optional geometry-adapter capability (CAD-PARITY-010): exact section
 * computation — plane ∩ descriptor intersection curves through the engine's
 * deterministic section operation. Adapters outside their exactness class
 * throw the typed AdapterFailure decline rather than approximating.
 */
export interface SectionProvider {
  computeSection(descriptor: GeometryDescriptor, plane: SectionPlaneSpec): Promise<SectionGeometry>;
}

export function isSectionProvider(adapter: unknown): adapter is SectionProvider {
  if (typeof adapter !== "object" || adapter === null) return false;
  const candidate = adapter as { computeSection?: unknown };
  return typeof candidate.computeSection === "function";
}

/**
 * Optional geometry-adapter capability (CAD-PARITY-010): deterministic
 * topology extraction — the face/edge/vertex inventory of a descriptor with
 * per-face triangulation, in the engine's canonical order, with engine keys
 * as provenance. Adapters outside their exactness class throw the typed
 * AdapterFailure decline.
 */
export interface TopologyProvider {
  describeTopology(descriptor: GeometryDescriptor): Promise<TopologyGeometry>;
}

export function isTopologyProvider(adapter: unknown): adapter is TopologyProvider {
  if (typeof adapter !== "object" || adapter === null) return false;
  const candidate = adapter as { describeTopology?: unknown };
  return typeof candidate.describeTopology === "function";
}

/**
 * Optional geometry-adapter capability (CAD-PARITY-010): bounded quality-
 * preset mesh delivery — the descriptor tessellated at one of the closed
 * LOD presets (progressive delivery with deterministic per-preset output).
 */
export interface QualityMeshProvider {
  prepareMeshAtQuality(
    descriptor: GeometryDescriptor,
    quality: MeshQualityPreset,
  ): Promise<{ readonly mesh: MeshData; readonly metadata: GeometryMetadata; readonly meshToken: string }>;
}

export function isQualityMeshProvider(adapter: unknown): adapter is QualityMeshProvider {
  if (typeof adapter !== "object" || adapter === null) return false;
  const candidate = adapter as { prepareMeshAtQuality?: unknown };
  return typeof candidate.prepareMeshAtQuality === "function";
}
