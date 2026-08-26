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
 * recursively. Concrete adapters compile it to engine-native work; the
 * renderer and CADDocument never see it as anything but element props.
 *
 * No engine imports here (LOCK-018): this file is importable by the protected
 * core (contracts/app-api) — only the concrete adapter/worker layer may
 * import engine modules.
 */

/** Row-major 3-component vector. */
export type Vec3 = readonly [number, number, number];

/** Row-major 4x4 affine matrix (16 numbers). The bottom row must be
 *  [0, 0, 0, 1]; v' = M·v (row-times-column). */
export type Matrix4 = readonly number[];

/** Engine-independent geometry descriptor (minimum canonical set, Issue #26). */
export type GeometryDescriptor =
  | { readonly shape: "box"; readonly width: number; readonly depth: number; readonly height: number }
  | {
      readonly shape: "cylinder";
      readonly radius: number;
      readonly height: number;
      readonly origin?: Vec3;
      readonly direction?: Vec3;
    }
  | { readonly shape: "transform"; readonly matrix: Matrix4; readonly target: GeometryDescriptor }
  | { readonly shape: "fuse"; readonly a: GeometryDescriptor; readonly b: GeometryDescriptor }
  | { readonly shape: "cut"; readonly a: GeometryDescriptor; readonly b: GeometryDescriptor };

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
