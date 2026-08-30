/**
 * OCCT worker protocol types (CAD-IMPLEMENT-002 / Issue #26).
 *
 * The JSON protocol spoken over stdio with the isolated Python worker
 * (worker/occt-worker.py). One request per process — the worker is a
 * disposable subprocess per prepare call (CAD-005 §7 process-per-call
 * isolation). This module is TYPES ONLY: it imports nothing and is safe to
 * reference from anywhere (the concrete adapter lives behind the boundary).
 */

/** A single step of the flat, ordered recipe DAG the worker executes. */
export type WorkerRecipeStep =
  | { readonly id: string; readonly make: "box"; readonly width: number; readonly depth: number; readonly height: number }
  | {
      readonly id: string;
      readonly make: "cylinder";
      readonly radius: number;
      readonly height: number;
      readonly origin?: readonly [number, number, number];
      readonly direction?: readonly [number, number, number];
    }
  | {
      /** COMPAT-CAD-002: extrusion of a planar polygon profile (XY, implicitly
       *  closed, simple, no repeated closing point) along +Z by `height`,
       *  based at `base` (default [0,0,0]). */
      readonly id: string;
      readonly make: "extrude";
      readonly profile: readonly (readonly [number, number])[];
      readonly height: number;
      readonly base?: readonly [number, number, number];
    }
  | { readonly id: string; readonly bool: WorkerBoolOp; readonly a: string; readonly b: string }
  | { readonly id: string; readonly transform: string; readonly matrix: readonly number[] };

/** The boolean operation vocabulary (CAD-PARITY-010 adds `intersect` —
 *  OCCT BRepAlgoAPI_Common — completing the union/difference/intersection
 *  triad). */
export type WorkerBoolOp = "fuse" | "cut" | "intersect";

export interface WorkerTessellation {
  readonly linearDeflection?: number;
  readonly angularDeflection?: number;
}

export interface WorkerPrepareRequest {
  readonly op: "prepare";
  readonly recipe: readonly WorkerRecipeStep[];
  readonly result: string;
  readonly tessellation?: WorkerTessellation;
}

export interface WorkerPingRequest {
  readonly op: "ping";
}

export interface WorkerMesh {
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
}

export interface WorkerOkResponse {
  readonly ok: true;
  readonly engine: "occt";
  readonly engineVersion: string;
  readonly meshToken: string;
  readonly bbox: readonly [number, number, number, number, number, number];
  readonly volume: number;
  readonly stats: { readonly vertices: number; readonly triangles: number };
  readonly mesh: WorkerMesh;
}

export interface WorkerErrResponse {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type WorkerResponse = WorkerOkResponse | WorkerErrResponse;

/** Any worker request (CAD-PARITY-010 adds the section and topology ops). */
export type WorkerRequest = WorkerPrepareRequest | WorkerPingRequest | WorkerSectionRequest | WorkerTopologyRequest;

export interface WorkerPingOk extends WorkerOkResponse {
  // ping responses omit meshToken/bbox/mesh/volume/stats; the structural
  // validator in occt-process.ts treats them specially.
}

// ---------------------------------------------------------------------------
// CAD-PARITY-010 (Issue #93): the section and topology ops. Same recipe-DAG
// shape evaluation; different result extraction with canonical deterministic
// ordering. Typed failures include engine_empty_result (a boolean that
// annihilates all material) and engine_non_manifold (a boolean result the
// engine's shape-validity check rejects).
// ---------------------------------------------------------------------------

/** The section op request: plane ∩ result-step-shape intersection curves. */
export interface WorkerSectionRequest {
  readonly op: "section";
  readonly recipe: readonly WorkerRecipeStep[];
  readonly result: string;
  /** The infinite section plane (unit normal). */
  readonly plane: {
    readonly origin: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
  };
}

/** The topology op request: the face/edge/vertex inventory of the
 *  result-step shape (default tessellation quality — documented). */
export interface WorkerTopologyRequest {
  readonly op: "topology";
  readonly recipe: readonly WorkerRecipeStep[];
  readonly result: string;
}

/** One extracted face (own triangulation, world-space). */
export interface WorkerTopoFace {
  readonly surfaceType: string;
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly area: number;
  readonly centroid: readonly [number, number, number];
  readonly engineKey: string;
}

/** One extracted edge (sampled polyline, world-space). */
export interface WorkerTopoEdge {
  readonly curveType: string;
  readonly points: readonly number[];
  readonly length: number;
  readonly engineKey: string;
}

/** One extracted vertex. */
export interface WorkerTopoVertex {
  readonly point: readonly [number, number, number];
  readonly engineKey: string;
}

/** A successful section op response (empty polylines = the plane misses the
 *  solid — a legal exact result). */
export interface WorkerSectionOk {
  readonly ok: true;
  readonly engine: "occt";
  readonly engineVersion: string;
  readonly polylines: readonly { readonly points: readonly number[] }[];
}

/** A successful topology op response. */
export interface WorkerTopologyOk {
  readonly ok: true;
  readonly engine: "occt";
  readonly engineVersion: string;
  readonly faces: readonly WorkerTopoFace[];
  readonly edges: readonly WorkerTopoEdge[];
  readonly vertices: readonly WorkerTopoVertex[];
}
