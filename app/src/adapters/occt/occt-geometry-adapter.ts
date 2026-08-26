/**
 * OCCT geometry engine adapter (CAD-IMPLEMENT-002 / Issue #26).
 *
 * Implements the frozen `GeometryEngineAdapter` contract from
 * app/src/contracts/adapter.ts — byte-unchanged — against the real OCCT
 * kernel (the same kernel FreeCAD builds on), via the isolated Python
 * worker (worker/occt-worker.py + occt-process.ts).
 *
 * The chain the Architect required:
 *
 *   Web / Electron -> Shared Renderer -> CAD/BIM App API -> EngineAdapterBundle
 *     -> FreeCAD/OCCT worker -> Geometry result -> CADDocument
 *     -> Construction Graph boundary
 *
 * This module is the "EngineAdapterBundle -> OCCT worker" hop. It compiles
 * the engine-independent GeometryDescriptor (contracts/geometry.ts) into the
 * worker's flat recipe DAG, runs the disposable subprocess, and returns the
 * deterministic GeometryResult { meshToken, bbox }.
 *
 * Determinism (LOCK-004/005/017): the worker derives meshToken as
 * "occt:" + SHA-256 over a canonical encoding of the tessellated mesh, so
 * identical descriptors produce identical meshTokens across processes,
 * runs and hosts — preserving Web/Electron content-hash parity. The bbox is
 * the tolerance-inclusive OCCT Bnd_Box (declared tolerance: ~1e-7 for
 * primitives, up to ~5e-3 after booleans).
 *
 * Optional capabilities (structural, additive — the protected core checks
 * for the method shapes, never importing this module):
 *   - MeshProvider.describeMesh(meshToken): cached viewport mesh data.
 *   - GeometryMetadataProvider.describeGeometryMetadata(meshToken):
 *     volume + tessellation stats for selection/query metadata.
 */

import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { GeometryEngineAdapter, GeometryResult } from "../../contracts/adapter.js";
import type { Element } from "../../contracts/caddocument.js";
import {
  AdapterFailure,
  isGeometryMetadataProvider,
  isMeshProvider,
} from "../../contracts/geometry.js";
import type {
  GeometryDescriptor,
  GeometryMetadata,
  Matrix4,
  MeshData,
  Vec3,
} from "../../contracts/geometry.js";
import { runOcctWorker } from "./occt-process.js";
import type { OcctProcessOptions } from "./occt-process.js";
import type { WorkerRecipeStep } from "./worker-protocol.js";

const MAX_DESCRIPTOR_DEPTH = 32;
const MAX_RECIPE_STEPS = 256;
const MESH_CACHE_CAPACITY = 64;

export interface OcctGeometryAdapterOptions extends OcctProcessOptions {
  /** Default tessellation quality for prepare calls (worker defaults:
   *  linearDeflection 0.1, angularDeflection 0.5). */
  readonly tessellation?: { readonly linearDeflection?: number; readonly angularDeflection?: number };
}

interface CacheEntry {
  readonly mesh: MeshData;
  readonly metadata: GeometryMetadata;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requirePositive(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be a finite number > 0`, false);
  }
  return value;
}

function optionalVec3(value: unknown, path: string): Vec3 | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be an array of 3 finite numbers`, false);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function requireMatrix(value: unknown, path: string): Matrix4 {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(isFiniteNumber)) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be an array of 16 finite numbers (row-major 4x4)`, false);
  }
  const matrix = value as number[];
  const [b0, b1, b2, b3] = [matrix[12], matrix[13], matrix[14], matrix[15]] as const as readonly [number, number, number, number];
  if (Math.abs(b0) > 1e-9 || Math.abs(b1) > 1e-9 || Math.abs(b2) > 1e-9 || Math.abs(b3 - 1) > 1e-9) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be affine (bottom row [0,0,0,1])`, false);
  }
  return matrix;
}

/**
 * Compile the recursive GeometryDescriptor into the worker's flat, ordered
 * recipe DAG. Compilation IS validation: any malformed descriptor throws
 * engine_malformed_input before a process is spawned.
 */
export function compileDescriptor(
  descriptor: unknown,
  steps: WorkerRecipeStep[] = [],
  depth = 0,
): { readonly steps: readonly WorkerRecipeStep[]; readonly resultId: string } {
  if (depth > MAX_DESCRIPTOR_DEPTH) {
    throw new AdapterFailure(
      "engine_malformed_input",
      `geometry descriptor nesting exceeds the ${MAX_DESCRIPTOR_DEPTH}-level bound`,
      false,
    );
  }
  if (steps.length >= MAX_RECIPE_STEPS) {
    throw new AdapterFailure(
      "engine_malformed_input",
      `geometry descriptor compiles to more than ${MAX_RECIPE_STEPS} recipe steps`,
      false,
    );
  }
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new AdapterFailure("engine_malformed_input", "geometry descriptor must be an object", false);
  }
  const d = descriptor as { shape?: unknown; [key: string]: unknown };
  switch (d.shape) {
    case "box": {
      const width = requirePositive(d.width, "geometry.width");
      const depth = requirePositive(d.depth, "geometry.depth");
      const height = requirePositive(d.height, "geometry.height");
      const id = `s${steps.length}`;
      steps.push({ id, make: "box", width, depth, height });
      return { steps, resultId: id };
    }
    case "cylinder": {
      const radius = requirePositive(d.radius, "geometry.radius");
      const height = requirePositive(d.height, "geometry.height");
      const origin = optionalVec3(d.origin, "geometry.origin");
      const direction = optionalVec3(d.direction, "geometry.direction");
      if (direction !== undefined) {
        const norm = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
        if (norm <= 1e-12) {
          throw new AdapterFailure("engine_malformed_input", "geometry.direction must be a non-null vector", false);
        }
      }
      const id = `s${steps.length}`;
      steps.push(origin === undefined && direction === undefined
        ? { id, make: "cylinder", radius, height }
        : { id, make: "cylinder", radius, height, origin: origin ?? [0, 0, 0], direction: direction ?? [0, 0, 1] });
      return { steps, resultId: id };
    }
    case "transform": {
      const matrix = requireMatrix(d.matrix, "geometry.matrix");
      const target = compileDescriptor(d.target, steps, depth + 1);
      const id = `s${steps.length}`;
      steps.push({ id, transform: target.resultId, matrix: [...matrix] });
      return { steps, resultId: id };
    }
    case "fuse":
    case "cut": {
      const a = compileDescriptor(d.a, steps, depth + 1);
      const b = compileDescriptor(d.b, steps, depth + 1);
      const id = `s${steps.length}`;
      steps.push({ id, bool: d.shape, a: a.resultId, b: b.resultId });
      return { steps, resultId: id };
    }
    default:
      throw new AdapterFailure(
        "engine_malformed_input",
        `geometry.shape must be one of box/cylinder/transform/fuse/cut, got ${JSON.stringify(d.shape)}`,
        false,
      );
  }
}

/**
 * Create the OCCT geometry adapter. `engineVersion` is discovered from the
 * first worker response (a getter — the contract's readonly property is
 * satisfied while staying live).
 */
export function createOcctGeometryAdapter(
  options: OcctGeometryAdapterOptions = {},
): GeometryEngineAdapter & {
  describeMesh(meshToken: string): Promise<MeshData | null>;
  describeGeometryMetadata(meshToken: string): Promise<GeometryMetadata | null>;
} {
  const cache = new Map<string, CacheEntry>();
  let engineVersion = "unknown";

  function remember(response: {
    meshToken: string;
    volume: number;
    stats: { vertices: number; triangles: number };
    mesh: { vertices: readonly number[]; indices: readonly number[] };
  }): void {
    cache.set(response.meshToken, {
      mesh: { vertices: [...response.mesh.vertices], indices: [...response.mesh.indices] },
      metadata: {
        volume: response.volume,
        vertices: response.stats.vertices,
        triangles: response.stats.triangles,
      },
    });
    if (cache.size > MESH_CACHE_CAPACITY) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  const adapter = {
    adapterMark: ADAPTER_BOUNDARY_MARK,
    engineId: "occt",
    get engineVersion(): string {
      return engineVersion;
    },

    async prepareGeometry(element: Element): Promise<GeometryResult> {
      const compiled = compileDescriptor(element.props);
      const request = {
        op: "prepare" as const,
        recipe: compiled.steps,
        result: compiled.resultId,
        ...(options.tessellation === undefined ? {} : { tessellation: options.tessellation }),
      };
      const response = await runOcctWorker(request, options);
      engineVersion = response.engineVersion;
      remember(response);
      return { meshToken: response.meshToken, bbox: response.bbox };
    },

    async describeMesh(meshToken: string): Promise<MeshData | null> {
      return cache.get(meshToken)?.mesh ?? null;
    },

    async describeGeometryMetadata(meshToken: string): Promise<GeometryMetadata | null> {
      return cache.get(meshToken)?.metadata ?? null;
    },
  };

  // Capability self-checks (fail fast if the shapes drift from the structural
  // checks the App API performs).
  if (!isMeshProvider(adapter) || !isGeometryMetadataProvider(adapter)) {
    throw new Error("occt adapter capability shape regression");
  }
  return adapter;
}
