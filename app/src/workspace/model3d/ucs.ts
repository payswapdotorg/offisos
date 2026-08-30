/**
 * CAD-PARITY-009 (Issue #90): the deterministic UCS/workplane semantics.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts and the App API so UCS semantics are THE SAME everywhere (LOCK-004).
 *
 *  - The World UCS is implicit (never a table record; identity "world").
 *  - Named UCS records carry origin + an orthonormal right-handed axis
 *    triple (x × y = z) validated within UCS_ORTHONORMAL_TOLERANCE —
 *    degenerate/non-orthonormal triples are typed declines, never silently
 *    normalized.
 *  - world↔UCS transforms are EXACT inverses (orthonormal basis — the
 *    inverse is the transpose; implemented through basisMatrix/
 *    invertAffine with bit-identical round trips asserted in the suites).
 *  - Grid/snap projection: snapping a world point to the active workplane's
 *    grid happens in UCS coordinates (the grid is a UCS-XY construct) and
 *    maps back exactly.
 *  - UCS-aware numeric input: "x,y,z" triples resolve through the ACTIVE
 *    UCS (typed input in the active workplane — the AutoCAD convention).
 */

import type { UcsRecord } from "../../contracts/caddocument.js";
import type { Matrix4, Vec3 } from "../../contracts/geometry.js";
import {
  UCS_ORTHONORMAL_TOLERANCE,
  basisMatrix,
  invertAffine,
  v3Cross,
  v3Dot,
  v3Length,
  transformPoint,
} from "./math3d.js";

/** The World UCS as a record-shaped value (never persisted as a table
 *  record — this is the implicit default both hosts and the App API address
 *  as "world"). */
export const UCS_WORLD_ID = "world";

export const WORLD_UCS: UcsRecord = {
  id: UCS_WORLD_ID,
  name: "World",
  origin: [0, 0, 0],
  xAxis: [1, 0, 0],
  yAxis: [0, 1, 0],
  zAxis: [0, 0, 1],
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** Validate a UCS axis triple: every axis finite + unit length, pairwise
 *  perpendicular, and right-handed (x × y = z) — all within
 *  UCS_ORTHONORMAL_TOLERANCE. Returns the first failing invariant's message
 *  or null when the triple is a valid orthonormal right-handed basis. */
export function validateUcsAxes(x: Vec3, y: Vec3, z: Vec3): string | null {
  const tol = UCS_ORTHONORMAL_TOLERANCE;
  for (const [label, v] of [["xAxis", x], ["yAxis", y], ["zAxis", z]] as const) {
    if (v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return `${label} must be a finite 3-vector`;
    }
    const len = v3Length(v);
    if (Math.abs(len - 1) > tol) {
      return `${label} must be unit length (|v| = ${len})`;
    }
  }
  if (Math.abs(v3Dot(x, y)) > tol) return "xAxis and yAxis must be perpendicular";
  if (Math.abs(v3Dot(x, z)) > tol) return "xAxis and zAxis must be perpendicular";
  if (Math.abs(v3Dot(y, z)) > tol) return "yAxis and zAxis must be perpendicular";
  const cx = v3Cross(x, y);
  if (
    Math.abs(cx[0] - z[0]) > tol ||
    Math.abs(cx[1] - z[1]) > tol ||
    Math.abs(cx[2] - z[2]) > tol
  ) {
    return "the axis triple must be right-handed (xAxis × yAxis = zAxis)";
  }
  return null;
}

/** Validate a whole UcsRecord (axes + origin + name shape). */
export function validateUcsRecord(ucs: UcsRecord): string | null {
  if (typeof ucs.id !== "string" || ucs.id.length === 0) return "ucs id must be a non-empty string";
  if (typeof ucs.name !== "string" || ucs.name.trim().length === 0) return "ucs name must be a non-empty string";
  if (ucs.origin.length !== 3 || !ucs.origin.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "ucs origin must be a finite 3-vector";
  }
  return validateUcsAxes(ucs.xAxis, ucs.yAxis, ucs.zAxis);
}

/** The UCS→world placement matrix (rows = the UCS axes in world coordinates;
 *  ucsToWorld(p) = M·p). */
export function ucsToWorldMatrix(ucs: UcsRecord): Matrix4 {
  return basisMatrix(ucs.xAxis, ucs.yAxis, ucs.zAxis, ucs.origin);
}

/** The world→UCS matrix (the exact affine inverse). Returns null only for a
 *  non-orthonormal record (validate first — the document boundary does). */
export function worldToUcsMatrix(ucs: UcsRecord): Matrix4 | null {
  return invertAffine(ucsToWorldMatrix(ucs));
}

/** Map a point from UCS coordinates to world coordinates. */
export function ucsToWorld(ucs: UcsRecord, p: Vec3): Vec3 {
  return transformPoint(ucsToWorldMatrix(ucs), p);
}

/** Map a point from world coordinates to UCS coordinates. */
export function worldToUcs(ucs: UcsRecord, p: Vec3): Vec3 | null {
  const m = worldToUcsMatrix(ucs);
  if (m === null) return null;
  return transformPoint(m, p);
}

/** Map a direction (free vector) from UCS to world (rotation only). */
export function ucsDirectionToWorld(ucs: UcsRecord, d: Vec3): Vec3 {
  return [
    ucs.xAxis[0] * d[0] + ucs.yAxis[0] * d[1] + ucs.zAxis[0] * d[2],
    ucs.xAxis[1] * d[0] + ucs.yAxis[1] * d[1] + ucs.zAxis[1] * d[2],
    ucs.xAxis[2] * d[0] + ucs.yAxis[2] * d[1] + ucs.zAxis[2] * d[2],
  ];
}

/** Map a direction from world to UCS. */
export function worldDirectionToUcs(ucs: UcsRecord, d: Vec3): Vec3 {
  return [v3Dot(d, ucs.xAxis), v3Dot(d, ucs.yAxis), v3Dot(d, ucs.zAxis)];
}

// --- Grid/snap projection onto the active workplane ---------------------------

/** Snap a UCS-plane point to the UCS grid (grid size in world units; the
 *  grid lives on the UCS XY plane). The Z coordinate in UCS coordinates is
 *  preserved (grid snapping is a plane construct). */
export function snapToUcsGrid(ucsPoint: Vec3, gridSize: number): Vec3 {
  const snap1 = (v: number): number => {
    if (!(gridSize > 0)) return v;
    return Math.round(v / gridSize) * gridSize;
  };
  return [snap1(ucsPoint[0]), snap1(ucsPoint[1]), ucsPoint[2]];
}

/** Snap a WORLD point onto the active workplane's grid: world→UCS, snap in
 *  UCS XY, back to world (exact round trip through the orthonormal basis). */
export function snapWorldToUcsGrid(ucs: UcsRecord, worldPoint: Vec3, gridSize: number): Vec3 | null {
  const local = worldToUcs(ucs, worldPoint);
  if (local === null) return null;
  return ucsToWorld(ucs, snapToUcsGrid(local, gridSize));
}

/** One deterministic grid segment on the UCS XY plane (world-space
 *  endpoints). */
export interface UcsGridSegment {
  readonly a: Vec3;
  readonly b: Vec3;
}

/** Enumerate the workplane grid segments within the given world bounding
 *  box: the UCS-XY extent of the box is gridded at `gridSize` (major every
 *  `majorEvery` cells, minor otherwise) and mapped back to world. Fixed
 *  deterministic order: X-parallel segments first (increasing offset), then
 *  Y-parallel. Capped at maxSegments (a typed decline upstream when the
 *  grid would exceed it — never a silent truncation). */
export function ucsGridSegments(
  ucs: UcsRecord,
  box: { readonly minX: number; readonly minY: number; readonly minZ: number; readonly maxX: number; readonly maxY: number; readonly maxZ: number },
  gridSize: number,
  majorEvery: number,
  maxSegments: number,
): { readonly segments: readonly UcsGridSegment[]; readonly truncated: boolean } {
  const corners: Vec3[] = [
    [box.minX, box.minY, box.minZ],
    [box.maxX, box.minY, box.minZ],
    [box.minX, box.maxY, box.minZ],
    [box.maxX, box.maxY, box.minZ],
    [box.minX, box.minY, box.maxZ],
    [box.maxX, box.minY, box.maxZ],
    [box.minX, box.maxY, box.maxZ],
    [box.maxX, box.maxY, box.maxZ],
  ];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const c of corners) {
    const local = worldToUcs(ucs, c);
    if (local === null) return { segments: [], truncated: false };
    if (local[0] < minX) minX = local[0];
    if (local[1] < minY) minY = local[1];
    if (local[0] > maxX) maxX = local[0];
    if (local[1] > maxY) maxY = local[1];
  }
  if (!(gridSize > 0)) return { segments: [], truncated: false };
  const i0 = Math.floor(minX / gridSize);
  const i1 = Math.ceil(maxX / gridSize);
  const j0 = Math.floor(minY / gridSize);
  const j1 = Math.ceil(maxY / gridSize);
  const segments: UcsGridSegment[] = [];
  let truncated = false;
  for (let i = i0; i <= i1 && !truncated; i += 1) {
    if (segments.length + (j1 - j0 + 1) > maxSegments) { truncated = true; break; }
    for (let j = j0; j <= j1; j += 1) {
      if (segments.length >= maxSegments) { truncated = true; break; }
      if (i % majorEvery !== 0 && j % majorEvery !== 0) {
        // Minor interior crossing points only carry lines when either the
        // row or column is major — bounded, deterministic output size.
        continue;
      }
      const a = ucsToWorld(ucs, [i * gridSize, j * gridSize, 0]);
      const b = ucsToWorld(ucs, [i * gridSize + gridSize, j * gridSize, 0]);
      segments.push({ a, b });
      if (segments.length >= maxSegments) { truncated = true; break; }
      const c = ucsToWorld(ucs, [i * gridSize, j * gridSize + gridSize, 0]);
      segments.push({ a, b: c });
    }
  }
  return { segments, truncated };
}

// --- UCS-aware numeric input ---------------------------------------------------

/** Parsed UCS-relative typed input (CAD-PARITY-009 command line). */
export interface TypedPoint3D {
  readonly point: Vec3;
  readonly relative: boolean;
}

/** Parse UCS-aware numeric input "x,y,z" (or "@x,y,z" for relative — the
 *  relative base is resolved by the caller against the last point in the
 *  ACTIVE UCS). Whitespace-tolerant; components must be finite numbers.
 *  Returns null for anything else (the prompt engine falls back to other
 *  input kinds — a typed decline is surfaced for invalid triples). */
export function parseTypedPoint3D(text: string): TypedPoint3D | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let relative = false;
  let body = trimmed;
  if (body.startsWith("@")) {
    relative = true;
    body = body.slice(1).trim();
  }
  const parts = body.split(",");
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return { point: [nums[0]!, nums[1]!, nums[2]!], relative };
}

/** Resolve a typed 3D point against the active UCS: absolute input maps
 *  UCS→world; relative input adds to `base` in UCS coordinates first. */
export function resolveTypedPoint3D(
  ucs: UcsRecord,
  typed: TypedPoint3D,
  base: Vec3 | null,
): Vec3 | null {
  if (typed.relative) {
    if (base === null) return null;
    const local = worldToUcs(ucs, base);
    if (local === null) return null;
    const moved: Vec3 = [local[0] + typed.point[0], local[1] + typed.point[1], local[2] + typed.point[2]];
    return ucsToWorld(ucs, moved);
  }
  return ucsToWorld(ucs, typed.point);
}
