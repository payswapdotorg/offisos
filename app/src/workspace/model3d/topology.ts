/**
 * CAD-PARITY-010 (Issue #93): the deterministic topology-aware selection core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Topology-aware
 * face/edge/vertex selection ONLY where topology mapping and ordering are
 * deterministic (Issue #93 §4):
 *
 *  - The adapter's TopologyProvider extracts the raw face/edge/vertex
 *    inventory (with per-face triangulation) in ITS canonical order, with
 *    per-entity engine keys as PROVENANCE.
 *  - THIS module owns the CANONICAL mapping: it validates the raw output,
 *    re-sorts every entity class by the canonical encoding of its GEOMETRY
 *    (engine enumeration order is irrelevant), assigns the document-owned
 *    canonical ids (f0.., e0.., v0.. — stable across engines for the same
 *    geometry) and exposes the deterministic sub-entity pick.
 *  - Engine keys NEVER become canonical identity (the acceptance criterion):
 *    they ride along as provenance for adapter-side correlation only.
 *  - The pick is EXACTLY ordered: faces by ray-triangle hit distance then
 *    canonical id; edges by ray-segment distance (world tolerance) then
 *    canonical id; vertices by ray-point distance (tolerance) then canonical
 *    id; the combined result orders faces → edges → vertices (the AutoCAD
 *    subobject filter convention). No tie ambiguity anywhere.
 *
 * This module stays crypto-free and serialization-free for the browser
 * bundle (the section.ts precedent): canonical hashing lives at the App API
 * layer.
 */

import type { Ray3 } from "./projection.js";
import type { TopologyGeometry, TopoEdgeGeometry, TopoFaceGeometry, TopoVertexGeometry, Vec3 } from "../../contracts/geometry.js";
import { v3Dot, v3Sub } from "./math3d.js";

/** The bounded topology inventory (typed validation decline beyond — a
 *  bounded slice, never unbounded engine output). */
export const MAX_TOPOLOGY_FACES = 512;
export const MAX_TOPOLOGY_EDGES = 1_024;
export const MAX_TOPOLOGY_VERTICES = 1_024;

/** The canonical topological face: canonical id + engine provenance key +
 *  the face's own triangulation (flat world x,y,z and local a,b,c indices). */
export interface TopologyFace {
  readonly canonicalId: string;
  readonly engineKey: string;
  readonly surfaceType: string;
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly area: number;
  readonly centroid: Vec3;
}

/** The canonical topological edge: canonical id + provenance key + the
 *  sampled polyline (flat world x,y,z) + length. */
export interface TopologyEdge {
  readonly canonicalId: string;
  readonly engineKey: string;
  readonly curveType: string;
  readonly points: readonly number[];
  readonly length: number;
}

/** The canonical topological vertex: canonical id + provenance key + point. */
export interface TopologyVertex {
  readonly canonicalId: string;
  readonly engineKey: string;
  readonly point: Vec3;
}

/** The derived deterministic topology map (never stored — recomputed on
 *  demand through the adapter; the App API layer adds the canonical hash). */
export interface TopologyMap {
  readonly elementId: string;
  readonly faces: readonly TopologyFace[];
  readonly edges: readonly TopologyEdge[];
  readonly vertices: readonly TopologyVertex[];
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
  readonly counts: { readonly faces: number; readonly edges: number; readonly vertices: number };
}

/** A structural-validation failure (the App API surfaces it as the typed
 *  engine_error decline — the adapter's output did not honor the contract). */
export class TopologyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopologyValidationError";
  }
}

/** Fixed-precision coordinate encoding (the worker canonical convention:
 *  9 decimals, negative zero normalized). */
function fmtCoord(n: number): string {
  const r = Math.round(n * 1e9) / 1e9;
  return (r === 0 ? 0 : r).toFixed(9);
}

/** The canonical encoding of a flat coordinate array. */
function encodeFlat(values: readonly number[]): string {
  return values.map(fmtCoord).join(",");
}

/** The canonical sort key of a raw face: its TRIANGULATION-INDEPENDENT
 *  geometry summary (surface type, area, centroid, the sorted vertex
 *  multiset). Two engines agreeing on the face geometry agree on the order —
 *  even when their internal triangulations (node order / diagonal split)
 *  differ; engine enumeration order is irrelevant. */
function faceSortKey(f: { surfaceType: string; vertices: readonly number[]; indices: readonly number[]; area: number; centroid: readonly number[] }): string {
  const points: string[] = [];
  for (let i = 0; i < f.vertices.length; i += 3) {
    points.push(`${fmtCoord(f.vertices[i]!)};${fmtCoord(f.vertices[i + 1]!)};${fmtCoord(f.vertices[i + 2]!)}`);
  }
  points.sort();
  return `${f.surfaceType}|${fmtCoord(f.area)}|${encodeFlat(f.centroid)}|${points.join("~")}`;
}

/** The canonical sort key of a raw edge: curve type + length + the sorted
 *  point multiset (direction-independent — engines may report the same
 *  curve in opposite orientations). */
function edgeSortKey(e: { curveType: string; points: readonly number[]; length: number }): string {
  const points: string[] = [];
  for (let i = 0; i < e.points.length; i += 3) {
    points.push(`${fmtCoord(e.points[i]!)};${fmtCoord(e.points[i + 1]!)};${fmtCoord(e.points[i + 2]!)}`);
  }
  points.sort();
  return `${e.curveType}|${fmtCoord(e.length)}|${points.join("~")}`;
}

function vertexSortKey(v: { point: readonly number[] }): string {
  return encodeFlat(v.point);
}

function validateFiniteFlat(values: readonly number[], what: string): void {
  if (!values.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new TopologyValidationError(`${what} contains non-finite coordinates`);
  }
}

/** Validate + canonicalize the adapter's raw topology output into the
 *  deterministic TopologyMap (canonical ids assigned in canonical order). */
export function buildTopologyMap(elementId: string, raw: TopologyGeometry): TopologyMap {
  if (raw.faces.length > MAX_TOPOLOGY_FACES) {
    throw new TopologyValidationError(`topology exceeds the ${MAX_TOPOLOGY_FACES}-face bound`);
  }
  if (raw.edges.length > MAX_TOPOLOGY_EDGES) {
    throw new TopologyValidationError(`topology exceeds the ${MAX_TOPOLOGY_EDGES}-edge bound`);
  }
  if (raw.vertices.length > MAX_TOPOLOGY_VERTICES) {
    throw new TopologyValidationError(`topology exceeds the ${MAX_TOPOLOGY_VERTICES}-vertex bound`);
  }

  const faces: TopologyFace[] = raw.faces.map((f, i) => {
    if (f.vertices.length % 3 !== 0) {
      throw new TopologyValidationError(`face ${i}: vertices must be flat x,y,z triples`);
    }
    if (f.indices.length % 3 !== 0) {
      throw new TopologyValidationError(`face ${i}: indices must be flat a,b,c triples`);
    }
    const vertexCount = f.vertices.length / 3;
    if (vertexCount === 0 || f.indices.length === 0) {
      throw new TopologyValidationError(`face ${i}: empty triangulation`);
    }
    validateFiniteFlat(f.vertices, `face ${i} vertices`);
    for (const idx of f.indices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
        throw new TopologyValidationError(`face ${i}: index ${idx} out of range [0, ${vertexCount})`);
      }
    }
    validateFiniteFlat(f.centroid, `face ${i} centroid`);
    if (typeof f.area !== "number" || !Number.isFinite(f.area) || f.area < 0) {
      throw new TopologyValidationError(`face ${i}: area must be a finite number ≥ 0`);
    }
    if (typeof f.surfaceType !== "string" || f.surfaceType.length === 0) {
      throw new TopologyValidationError(`face ${i}: surfaceType must be a non-empty string`);
    }
    if (typeof f.engineKey !== "string" || f.engineKey.length === 0) {
      throw new TopologyValidationError(`face ${i}: engineKey must be a non-empty string`);
    }
    return {
      canonicalId: "",
      engineKey: f.engineKey,
      surfaceType: f.surfaceType,
      vertices: [...f.vertices],
      indices: [...f.indices],
      area: f.area,
      centroid: [f.centroid[0], f.centroid[1], f.centroid[2]] as unknown as Vec3,
    };
  });
  faces.sort((a, b) => {
    const ka = faceSortKey(a);
    const kb = faceSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  faces.forEach((f, i) => {
    (f as { canonicalId: string }).canonicalId = `f${i}`;
  });

  const edges: TopologyEdge[] = raw.edges.map((e, i) => {
    if (e.points.length < 6 || e.points.length % 3 !== 0) {
      throw new TopologyValidationError(`edge ${i}: points must be ≥ 2 flat x,y,z triples`);
    }
    validateFiniteFlat(e.points, `edge ${i} points`);
    if (typeof e.length !== "number" || !Number.isFinite(e.length) || e.length < 0) {
      throw new TopologyValidationError(`edge ${i}: length must be a finite number ≥ 0`);
    }
    if (typeof e.curveType !== "string" || e.curveType.length === 0) {
      throw new TopologyValidationError(`edge ${i}: curveType must be a non-empty string`);
    }
    if (typeof e.engineKey !== "string" || e.engineKey.length === 0) {
      throw new TopologyValidationError(`edge ${i}: engineKey must be a non-empty string`);
    }
    return {
      canonicalId: "",
      engineKey: e.engineKey,
      curveType: e.curveType,
      points: [...e.points],
      length: e.length,
    };
  });
  edges.sort((a, b) => {
    const ka = edgeSortKey(a);
    const kb = edgeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  edges.forEach((e, i) => {
    (e as { canonicalId: string }).canonicalId = `e${i}`;
  });

  const vertices: TopologyVertex[] = raw.vertices.map((v, i) => {
    if (v.point.length !== 3 || !v.point.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new TopologyValidationError(`vertex ${i}: point must be a finite 3-vector`);
    }
    if (typeof v.engineKey !== "string" || v.engineKey.length === 0) {
      throw new TopologyValidationError(`vertex ${i}: engineKey must be a non-empty string`);
    }
    return { canonicalId: "", engineKey: v.engineKey, point: [v.point[0], v.point[1], v.point[2]] as unknown as Vec3 };
  });
  vertices.sort((a, b) => {
    const ka = vertexSortKey(a);
    const kb = vertexSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  vertices.forEach((v, i) => {
    (v as { canonicalId: string }).canonicalId = `v${i}`;
  });

  return {
    elementId,
    faces,
    edges,
    vertices,
    engine: { engineId: raw.engine.engineId, engineVersion: raw.engine.engineVersion },
    counts: { faces: faces.length, edges: edges.length, vertices: vertices.length },
  };
}

// ---------------------------------------------------------------------------
// The deterministic sub-entity pick.
// ---------------------------------------------------------------------------

/** The sub-entity kinds (the AutoCAD subobject filter vocabulary). */
export type SubEntityKind = "face" | "edge" | "vertex";

/** The default world-space pick tolerance for edges/vertices (faces are
 *  exact ray-triangle hits — no tolerance needed). Documented; the App API
 *  may override per viewport scale. */
export const DEFAULT_SUBENTITY_PICK_TOLERANCE = 0.5;

/** One ordered sub-entity hit. */
export interface SubEntityHit {
  readonly kind: SubEntityKind;
  readonly canonicalId: string;
  readonly engineKey: string;
  /** Faces: the ray parameter at the triangle hit. Edges/vertices: the
   *  perpendicular distance from the ray to the entity. */
  readonly distance: number;
  /** The world hit point (triangle hit for faces; the closest point on the
   *  entity for edges/vertices). */
  readonly point: Vec3;
}

/** Ray-triangle intersection (Möller–Trumbore, deterministic; degenerate
 *  triangles return null). Returns the ray parameter t or null. */
export function rayTriangle(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const e1 = v3Sub(b, a);
  const e2 = v3Sub(c, a);
  const p = [
    direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0],
  ] as const;
  const det = e1[0]! * p[0] + e1[1]! * p[1] + e1[2]! * p[2];
  if (det === 0) return null;
  const invDet = 1 / det;
  const t0 = v3Sub(origin, a);
  const u = (t0[0]! * p[0] + t0[1]! * p[1] + t0[2]! * p[2]) * invDet;
  if (u < 0 || u > 1) return null;
  const q = [
    t0[1]! * e1[2]! - t0[2]! * e1[1]!,
    t0[2]! * e1[0]! - t0[0]! * e1[2]!,
    t0[0]! * e1[1]! - t0[1]! * e1[0]!,
  ] as const;
  const v = (direction[0]! * q[0] + direction[1]! * q[1] + direction[2]! * q[2]) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2[0]! * q[0] + e2[1]! * q[1] + e2[2]! * q[2]) * invDet;
  if (t < 0) return null;
  return t;
}

/** The perpendicular distance between a ray and a segment, with the closest
 *  points — the deterministic edge-pick primitive. Both parameters are
 *  clamped to their domains (s ≥ 0 on the ray; t ∈ [0, 1] on the segment),
 *  then re-solved in clamped order (the standard clamped least-squares
 *  solution). Returns null when the segment is degenerate. */
export function raySegmentDistance(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
): { readonly distance: number; readonly rayPoint: Vec3; readonly segPoint: Vec3 } | null {
  const ab = v3Sub(b, a);
  const ao = v3Sub(a, origin);
  const abLen2 = v3Dot(ab, ab);
  const dD = v3Dot(direction, direction);
  if (abLen2 === 0 || dD === 0) return null;
  const dAb = v3Dot(direction, ab);
  const dAo = v3Dot(direction, ao);
  const abAo = v3Dot(ab, ao);
  const denom = dD * abLen2 - dAb * dAb;
  if (Math.abs(denom) < 1e-15) {
    // Parallel: the nearest ray point to the segment's origin.
    const s = Math.max(0, -dAo / dD);
    const rayPoint: Vec3 = [origin[0] + direction[0] * s, origin[1] + direction[1] * s, origin[2] + direction[2] * s];
    const segPoint: Vec3 = [a[0], a[1], a[2]];
    const delta = v3Sub(rayPoint, segPoint);
    return { distance: Math.sqrt(v3Dot(delta, delta)), rayPoint, segPoint };
  }
  // Unclamped solution.
  let s = (dAo * abLen2 - dAb * abAo) / denom;
  let t = (abAo * dD - dAo * dAb) / denom;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  // Re-solve s for the clamped t (s ≥ 0).
  s = (abAo + t * abLen2) / dAb;
  if (s < 0) {
    s = 0;
    // Re-solve t for the clamped s.
    t = -abAo / abLen2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const rayPoint: Vec3 = [origin[0] + direction[0] * s, origin[1] + direction[1] * s, origin[2] + direction[2] * s];
  const segPoint: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const delta = v3Sub(rayPoint, segPoint);
  return { distance: Math.sqrt(v3Dot(delta, delta)), rayPoint, segPoint };
}

/** The perpendicular distance from a ray to a point (the vertex-pick
 *  primitive): the distance from the point to its closest ray point (s ≥ 0). */
export function rayPointDistance(origin: Vec3, direction: Vec3, p: Vec3): { readonly distance: number; readonly closest: Vec3 } {
  const d = v3Sub(p, origin);
  const dd = v3Dot(direction, direction);
  const s = dd === 0 ? 0 : Math.max(0, v3Dot(d, direction) / dd);
  const closest: Vec3 = [origin[0] + direction[0] * s, origin[1] + direction[1] * s, origin[2] + direction[2] * s];
  const delta = v3Sub(p, closest);
  return { distance: Math.sqrt(v3Dot(delta, delta)), closest };
}

/** The deterministic sub-entity pick over a topology map. Faces are exact
 *  ray-triangle hits (each face's nearest hit; faces ordered by distance
 *  then canonical id); edges/vertices are tolerance picks (ordered by
 *  distance then canonical id). The combined result lists face hits, then
 *  edge hits, then vertex hits (the subobject filter convention). `filter`
 *  restricts the kinds (undefined = all three). */
export function pickSubEntity(
  ray: Ray3,
  map: TopologyMap,
  options: { readonly filter?: SubEntityKind; readonly tolerance?: number } = {},
): readonly SubEntityHit[] {
  const tolerance = options.tolerance ?? DEFAULT_SUBENTITY_PICK_TOLERANCE;
  const filter = options.filter;
  const hits: SubEntityHit[] = [];

  if (filter === undefined || filter === "face") {
    const faceHits: SubEntityHit[] = [];
    for (const face of map.faces) {
      let best: number | null = null;
      let bestPoint: Vec3 | null = null;
      const vs = face.vertices;
      for (let i = 0; i < face.indices.length; i += 3) {
        const ia = face.indices[i]! * 3;
        const ib = face.indices[i + 1]! * 3;
        const ic = face.indices[i + 2]! * 3;
        const a: Vec3 = [vs[ia]!, vs[ia + 1]!, vs[ia + 2]!];
        const b: Vec3 = [vs[ib]!, vs[ib + 1]!, vs[ib + 2]!];
        const c: Vec3 = [vs[ic]!, vs[ic + 1]!, vs[ic + 2]!];
        const t = rayTriangle(ray.origin, ray.direction, a, b, c);
        if (t !== null && (best === null || t < best)) {
          best = t;
          bestPoint = [
            ray.origin[0] + ray.direction[0] * t,
            ray.origin[1] + ray.direction[1] * t,
            ray.origin[2] + ray.direction[2] * t,
          ];
        }
      }
      if (best !== null && bestPoint !== null) {
        faceHits.push({ kind: "face", canonicalId: face.canonicalId, engineKey: face.engineKey, distance: best, point: bestPoint });
      }
    }
    faceHits.sort((x, y) =>
      x.distance === y.distance
        ? (x.canonicalId < y.canonicalId ? -1 : x.canonicalId > y.canonicalId ? 1 : 0)
        : x.distance - y.distance,
    );
    hits.push(...faceHits);
  }

  if (filter === undefined || filter === "edge") {
    const edgeHits: SubEntityHit[] = [];
    for (const edge of map.edges) {
      let best: { distance: number; segPoint: Vec3 } | null = null;
      for (let i = 0; i + 6 <= edge.points.length; i += 3) {
        const a: Vec3 = [edge.points[i]!, edge.points[i + 1]!, edge.points[i + 2]!];
        const b: Vec3 = [edge.points[i + 3]!, edge.points[i + 4]!, edge.points[i + 5]!];
        const d = raySegmentDistance(ray.origin, ray.direction, a, b);
        if (d !== null && (best === null || d.distance < best.distance)) {
          best = { distance: d.distance, segPoint: d.segPoint };
        }
      }
      if (best !== null && best.distance <= tolerance) {
        edgeHits.push({ kind: "edge", canonicalId: edge.canonicalId, engineKey: edge.engineKey, distance: best.distance, point: best.segPoint });
      }
    }
    edgeHits.sort((x, y) =>
      x.distance === y.distance
        ? (x.canonicalId < y.canonicalId ? -1 : x.canonicalId > y.canonicalId ? 1 : 0)
        : x.distance - y.distance,
    );
    hits.push(...edgeHits);
  }

  if (filter === undefined || filter === "vertex") {
    const vertexHits: SubEntityHit[] = [];
    for (const vertex of map.vertices) {
      const d = rayPointDistance(ray.origin, ray.direction, vertex.point);
      if (d.distance <= tolerance) {
        vertexHits.push({ kind: "vertex", canonicalId: vertex.canonicalId, engineKey: vertex.engineKey, distance: d.distance, point: vertex.point });
      }
    }
    vertexHits.sort((x, y) =>
      x.distance === y.distance
        ? (x.canonicalId < y.canonicalId ? -1 : x.canonicalId > y.canonicalId ? 1 : 0)
        : x.distance - y.distance,
    );
    hits.push(...vertexHits);
  }

  return hits;
}

/** The typed decline surfaced when topology-aware picking is requested for
 *  an element whose topology cannot be mapped deterministically (no realized
 *  geometry, or the active engine declines the descriptor's class). The
 *  element-granularity pick remains available (P009). */
export const TOPOLOGY_DECLINE_REASON =
  "topology-aware sub-entity selection requires a solid with deterministically mappable topology — the active engine declines this geometry's class; element-granularity picking (model3d.pick) remains available";

/** The typed decline when sub-entity picking is requested without naming an
 *  element (the global pick stays element-granularity — the P009 semantics
 *  are unchanged; sub-entity picking is per-element where proven). */
export const SUBENTITY_PER_ELEMENT_DECLINE_REASON =
  "sub-entity (face/edge/vertex) picking is per-element: name the solid with elementId and optionally filter by subEntity kind — the global pick remains element-granularity only";
