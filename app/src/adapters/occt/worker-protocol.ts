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
  | { readonly id: string; readonly bool: "fuse" | "cut"; readonly a: string; readonly b: string }
  | { readonly id: string; readonly transform: string; readonly matrix: readonly number[] };

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

export type WorkerRequest = WorkerPrepareRequest | WorkerPingRequest;

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

export interface WorkerPingOk extends WorkerOkResponse {
  // ping responses omit meshToken/bbox/mesh/volume/stats; the structural
  // validator in occt-process.ts treats them specially.
}
