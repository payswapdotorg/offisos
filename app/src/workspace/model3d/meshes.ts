/**
 * CAD-PARITY-010 (Issue #93): the engine-neutral bounded surface/mesh
 * entity core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Bounded surface/mesh
 * representations as FIRST-CLASS document entities (Issue #93 §2):
 *
 *  - A mesh entity element (`model3d.mesh`) is the DOCUMENT-OWNED, persisted
 *    tessellation of a source solid at one of the CLOSED quality presets
 *    (LOD). Its props carry the engine-neutral vertex/index payload (bounded
 *    by MESH_ENTITY_MAX_VERTICES/TRIANGLES), the source element provenance
 *    (id + meshToken + quality) and the engine provenance — deterministic
 *    serialization and ownership (save/open/replay round-trip it exactly;
 *    acceptance criterion 4: engine-neutral payloads outside the adapter
 *    boundary).
 *  - The quality presets are the FULL closed vocabulary — callers cannot
 *    request arbitrary deflections (deterministic bounded delivery; Issue
 *    #93 §5 progressive mesh delivery semantics).
 *  - Operations beyond the bounded representation (mesh editing, sculpting,
 *    subdivision) are OUT OF SCOPE and fail at the command layer (the
 *    documented unsupported behavior — never a fabricated approximation).
 *
 * This module stays crypto-free and serialization-free for the browser
 * bundle (the section.ts precedent).
 */

import type { MeshQualityKnobs, MeshQualityPreset } from "../../contracts/geometry.js";

/** The element props type tag of the mesh entity. */
export const MESH_ENTITY_TYPE = "model3d.mesh";

/** The closed quality-preset vocabulary (progressive delivery LODs). `full`
 *  matches the worker's default prepare tessellation (0.1 / 0.5) so the full
 *  preset is exactly the prepare-time mesh. */
export const MESH_QUALITY_PRESETS: Readonly<Record<MeshQualityPreset, MeshQualityKnobs>> = {
  low: { linearDeflection: 0.8, angularDeflection: 0.9 },
  medium: { linearDeflection: 0.4, angularDeflection: 0.7 },
  full: { linearDeflection: 0.1, angularDeflection: 0.5 },
};

/** The canonical preset order (echo/validation surfaces). */
export const MESH_QUALITY_PRESET_NAMES: readonly MeshQualityPreset[] = ["low", "medium", "full"];

/** Parse/validate a quality preset name. */
export function parseMeshQuality(value: string): MeshQualityPreset | null {
  if (value === "low" || value === "medium" || value === "full") return value;
  return null;
}

/** Resolve a preset to its concrete knobs. */
export function meshQualityKnobs(quality: MeshQualityPreset): MeshQualityKnobs {
  return MESH_QUALITY_PRESETS[quality];
}

/** The bounded mesh-entity payload sizes (typed declines beyond — never an
 *  unbounded persisted payload). */
export const MESH_ENTITY_MAX_VERTICES = 150_000;
export const MESH_ENTITY_MAX_TRIANGLES = 300_000;

/** The persisted mesh-entity element props (deterministic serialization:
 *  plain JSON-safe numbers only — the canonical serializer round-trips them
 *  exactly). */
export interface MeshEntityProps {
  readonly type: typeof MESH_ENTITY_TYPE;
  /** The source solid element (document-owned provenance). */
  readonly sourceElementId: string;
  /** The source solid's meshToken at tessellation time (engine result
   *  provenance — binds the entity to the source's realized state). */
  readonly sourceMeshToken: string;
  /** The quality preset the payload was tessellated at. */
  readonly quality: MeshQualityPreset;
  /** Flat world-space x,y,z vertices. */
  readonly vertices: readonly number[];
  /** Flat a,b,c triangle indices into `vertices`. */
  readonly indices: readonly number[];
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Engine provenance. */
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}

/** Validate a mesh payload (finite coordinates, index bounds, count
 *  consistency, budget bounds). Returns a decline reason or null. */
export function validateMeshPayload(
  vertices: readonly number[],
  indices: readonly number[],
): string | null {
  if (vertices.length % 3 !== 0) return "mesh vertices must be flat x,y,z triples";
  if (indices.length % 3 !== 0) return "mesh indices must be flat a,b,c triples";
  const vertexCount = vertices.length / 3;
  const triangleCount = indices.length / 3;
  if (vertexCount === 0 || triangleCount === 0) return "mesh payload is empty";
  if (vertexCount > MESH_ENTITY_MAX_VERTICES) {
    return `mesh exceeds the ${MESH_ENTITY_MAX_VERTICES}-vertex entity bound (got ${vertexCount})`;
  }
  if (triangleCount > MESH_ENTITY_MAX_TRIANGLES) {
    return `mesh exceeds the ${MESH_ENTITY_MAX_TRIANGLES}-triangle entity bound (got ${triangleCount})`;
  }
  if (!vertices.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "mesh vertices contain non-finite numbers";
  }
  if (!indices.every((n) => Number.isInteger(n) && n >= 0 && n < vertexCount)) {
    return "mesh indices must be integers within the vertex range";
  }
  return null;
}

/** Build the mesh-entity props (validates; returns a decline reason or the
 *  props — the command layer surfaces the typed decline). */
export function buildMeshEntityProps(input: {
  readonly sourceElementId: string;
  readonly sourceMeshToken: string;
  readonly quality: MeshQualityPreset;
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}): { ok: true; props: MeshEntityProps } | { ok: false; reason: string } {
  if (typeof input.sourceElementId !== "string" || input.sourceElementId.length === 0) {
    return { ok: false, reason: "mesh entity requires a source element id" };
  }
  if (typeof input.sourceMeshToken !== "string" || input.sourceMeshToken.length === 0) {
    return { ok: false, reason: "mesh entity requires the source meshToken" };
  }
  const invalid = validateMeshPayload(input.vertices, input.indices);
  if (invalid !== null) return { ok: false, reason: invalid };
  return {
    ok: true,
    props: {
      type: MESH_ENTITY_TYPE,
      sourceElementId: input.sourceElementId,
      sourceMeshToken: input.sourceMeshToken,
      quality: input.quality,
      vertices: [...input.vertices],
      indices: [...input.indices],
      vertexCount: input.vertices.length / 3,
      triangleCount: input.indices.length / 3,
      engine: { engineId: input.engine.engineId, engineVersion: input.engine.engineVersion },
    },
  };
}

/** Validate persisted mesh-entity props at document-open time (the
 *  serialization layer's structural guard — same rules as creation). */
export function validateMeshEntityProps(props: unknown): string | null {
  if (typeof props !== "object" || props === null) return "mesh entity props must be an object";
  const p = props as Partial<MeshEntityProps>;
  if (p.type !== MESH_ENTITY_TYPE) return `mesh entity type must be '${MESH_ENTITY_TYPE}'`;
  if (typeof p.sourceElementId !== "string" || p.sourceElementId.length === 0) {
    return "mesh entity sourceElementId must be a non-empty string";
  }
  if (typeof p.sourceMeshToken !== "string" || p.sourceMeshToken.length === 0) {
    return "mesh entity sourceMeshToken must be a non-empty string";
  }
  if (p.quality === undefined || parseMeshQuality(p.quality) === null) {
    return "mesh entity quality must be one of low/medium/full";
  }
  if (!Array.isArray(p.vertices) || !Array.isArray(p.indices)) {
    return "mesh entity vertices/indices must be arrays";
  }
  const invalid = validateMeshPayload(p.vertices, p.indices);
  if (invalid !== null) return invalid;
  const vertexCount = p.vertices.length / 3;
  const triangleCount = p.indices.length / 3;
  if (p.vertexCount !== vertexCount) return "mesh entity vertexCount is inconsistent with the payload";
  if (p.triangleCount !== triangleCount) return "mesh entity triangleCount is inconsistent with the payload";
  if (
    typeof p.engine !== "object" || p.engine === null ||
    typeof p.engine.engineId !== "string" || typeof p.engine.engineVersion !== "string"
  ) {
    return "mesh entity engine provenance must be {engineId, engineVersion}";
  }
  return null;
}

/** The typed decline for mesh operations outside the bounded representation
 *  (the documented unsupported behavior — Issue #93 §2). */
export const MESH_OPERATION_DECLINE_REASON =
  "mesh entities are bounded read-only representations (no mesh editing/sculpting/subdivision in this slice) — the source solid's modeling commands remain the editing surface";
