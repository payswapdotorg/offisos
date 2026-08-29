/**
 * Reference geometry engine adapter (RESEARCH-CAD-007 / Issue #32).
 *
 * A SECOND, fully independent geometry engine behind the SAME frozen
 * `GeometryEngineAdapter` contract from app/src/contracts/adapter.ts —
 * byte-unchanged. Pure TypeScript analytic solid geometry: no FreeCAD, no
 * OCCT, no IfcOpenShell, no subprocess, no native code anywhere in its
 * dependency graph. Together with the OCCT adapter
 * (CAD-IMPLEMENT-002) this proves LOCK-003/018: a replacement engine
 * satisfies the stable CAD/BIM contracts without renderer, CADDocument,
 * Construction-Graph or App API redesign.
 *
 * EXACTNESS CLASSES (LOCK-007 — nothing inferred is presented as exact fact,
 * and nothing outside the exactness class is guessed; it fails TYPED):
 *
 *   - box                          — exact volume/bbox/mesh; any later affine
 *                                    transform stays exact (parallelepiped
 *                                    corners, volume × |det L|).
 *   - cylinder (origin/direction)  — exact volume π·r²·h and exact world bbox
 *                                    h·|dᵢ| + 2·r·√(1−dᵢ²) per axis; rigid
 *                                    or uniform-scale transforms stay exact;
 *                                    NON-uniform affine transforms of a
 *                                    cylinder leave the exactness class
 *                                    (typed engine_error decline — an
 *                                    affine image of a cylinder is not a
 *                                    cylinder and the reference engine does
 *                                    not approximate).
 *   - extrude (COMPAT-CAD-002)     — exact volume (shoelace × height), exact
 *                                    bbox (profile AABB × Z span) and exact
 *                                    prism mesh; Z-PRESERVING affine
 *                                    transforms stay exact (planar affine on
 *                                    the profile + linear on Z, volume ×
 *                                    |det2D · g|); any transform that tilts
 *                                    the extrusion axis leaves the exactness
 *                                    class (typed decline). The mesh is
 *                                    winding-normalized (CCW), so either
 *                                    winding of the same polygon yields the
 *                                    identical token.
 *   - fuse                         — exact when the operands' world AABBs are
 *                                    disjoint (touching allowed: measure-zero
 *                                    boundary) → volume = sum, mesh = operand
 *                                    concatenation; overlapping AABBs leave
 *                                    the exactness class (typed decline).
 *   - cut                          — exact when both operands reduce to
 *                                    axis-aligned box cell sets (box, cut of
 *                                    boxes, diagonally-transformed boxes):
 *                                    the plane-split cell decomposition
 *                                    subtracts exactly; anything else
 *                                    (cylinders, prisms, rotated boxes) is a
 *                                    typed decline.
 *
 * Determinism (LOCK-004/005/017): every value is IEEE-754 double arithmetic
 * in a fixed evaluation order; meshToken = "ref:" + SHA-256 over the
 * canonical encoding of the tessellated mesh, so identical descriptors
 * produce identical meshTokens on every host, every run, every process —
 * preserving Web/Electron content-hash parity exactly like the OCCT adapter.
 *
 * Optional capabilities (structural, additive — mirrored from the OCCT
 * adapter so downstream consumers treat both engines identically):
 *   - MeshProvider.describeMesh(meshToken)
 *   - GeometryMetadataProvider.describeGeometryMetadata(meshToken)
 */

import { createHash } from "node:crypto";
import { ADAPTER_BOUNDARY_MARK } from "../../contracts/adapter.js";
import type { GeometryEngineAdapter, GeometryResult } from "../../contracts/adapter.js";
import type { Element } from "../../contracts/caddocument.js";
import {
  AdapterFailure,
  isGeometryMetadataProvider,
  isMeshProvider,
} from "../../contracts/geometry.js";
import type { GeometryMetadata, Matrix4, MeshData } from "../../contracts/geometry.js";
import { canonicalStringify } from "../../caddocument/serialization.js";

export const REFERENCE_ENGINE_ID = "reference";
export const REFERENCE_ENGINE_VERSION = "1.1.0";
export const REFERENCE_MESH_PREFIX = "ref:";

const MAX_DESCRIPTOR_DEPTH = 32;
const MAX_EVALUATION_NODES = 256;
const MESH_CACHE_CAPACITY = 64;
/** Cylinder tessellation segment count (fixed → deterministic mesh). */
const CYLINDER_SEGMENTS = 32;

/**
 * CAD-PARITY-009 (Issue #90): the FIXED unit-circle sample table for the
 * cylinder tessellation — cos/sin of the 32 ring angles as EXACT LITERALS.
 * Runtime Math.cos/Math.sin differ by 1 ulp across V8 builds (Node vs
 * Electron/Chromium — caught live by the model3d parity fixture: vertex
 * 3.3258784492101814 vs 3.325878449210182 in the scaled-cylinder ring), so
 * the deterministic reference engine pins the table once — the mesh (and
 * therefore meshToken) is bit-identical on EVERY host/runtime (the work
 * item's cross-host floating-point determinism risk, closed at the source).
 */
const CYLINDER_RING_TABLE: readonly (readonly [number, number])[] = [
  [1.0, 0.0],
  [0.9807852804032304, 0.19509032201612825],
  [0.9238795325112867, 0.3826834323650898],
  [0.8314696123025452, 0.5555702330196022],
  [0.7071067811865476, 0.7071067811865475],
  [0.5555702330196023, 0.8314696123025452],
  [0.38268343236508984, 0.9238795325112867],
  [0.19509032201612833, 0.9807852804032304],
  [6.123233995736766e-17, 1.0],
  [-0.1950903220161282, 0.9807852804032304],
  [-0.3826834323650897, 0.9238795325112867],
  [-0.555570233019602, 0.8314696123025455],
  [-0.7071067811865475, 0.7071067811865476],
  [-0.8314696123025453, 0.5555702330196022],
  [-0.9238795325112867, 0.3826834323650899],
  [-0.9807852804032304, 0.1950903220161286],
  [-1.0, 1.2246467991473532e-16],
  [-0.9807852804032304, -0.19509032201612836],
  [-0.9238795325112868, -0.38268343236508967],
  [-0.8314696123025455, -0.555570233019602],
  [-0.7071067811865477, -0.7071067811865475],
  [-0.5555702330196022, -0.8314696123025452],
  [-0.38268343236509034, -0.9238795325112865],
  [-0.19509032201612866, -0.9807852804032303],
  [-1.8369701987210297e-16, -1.0],
  [0.1950903220161283, -0.9807852804032304],
  [0.38268343236509, -0.9238795325112866],
  [0.5555702330196018, -0.8314696123025455],
  [0.7071067811865474, -0.7071067811865477],
  [0.8314696123025452, -0.5555702330196022],
  [0.9238795325112865, -0.3826834323650904],
  [0.9807852804032303, -0.19509032201612872],
];

/** Matrix-class tolerance (absolute, per component). */
const EPS_ALIGN = 1e-12;
/** Extrusion profile bounds (mirror the OCCT adapter; COMPAT-CAD-002). */
const MAX_PROFILE_POINTS = 64;
const PROFILE_AREA_EPS = 1e-9;
const PROFILE_COINCIDENCE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// Small vector / matrix helpers (pure, fixed operation order for determinism)
// ---------------------------------------------------------------------------

type V3 = readonly [number, number, number];

function matVec(m: Matrix4, v: V3): V3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2] + m[3]!,
    m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2] + m[7]!,
    m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2] + m[11]!,
  ];
}

/** Linear part only (no translation). */
function matDir(m: Matrix4, v: V3): V3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2],
    m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2],
  ];
}

function det3(m: Matrix4): number {
  const a = m[0]!, b = m[1]!, c = m[2]!;
  const d = m[4]!, e = m[5]!, f = m[6]!;
  const g = m[8]!, h = m[9]!, i = m[10]!;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function norm3(v: V3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function scale3(v: V3, s: number): V3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add3(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Deterministic orthonormal frame (u, v) ⟂ dir (dir must be unit length).
 *  Pick the world axis least aligned with dir as the helper, then
 *  Gram-Schmidt — a fixed rule, so the tessellation is reproducible. */
function frameFor(dir: V3): { u: V3; v: V3 } {
  const ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
  const helper: V3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const dot = helper[0] * dir[0] + helper[1] * dir[1] + helper[2] * dir[2];
  const uRaw: V3 = [helper[0] - dot * dir[0], helper[1] - dot * dir[1], helper[2] - dot * dir[2]];
  const uLen = norm3(uRaw);
  const u: V3 = scale3(uRaw, 1 / uLen);
  const vRaw: V3 = [
    dir[1] * u[2] - dir[2] * u[1],
    dir[2] * u[0] - dir[0] * u[2],
    dir[0] * u[1] - dir[1] * u[0],
  ];
  const vLen = norm3(vRaw);
  const v: V3 = scale3(vRaw, 1 / vLen);
  return { u, v };
}

// ---------------------------------------------------------------------------
// Validation (mirrors the OCCT adapter's compile-time validation: same typed
// failure codes and messages for equivalent malformed input — the contract's
// error surface stays engine-independent too)
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requirePositive(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be a finite number > 0`, false);
  }
  return value;
}

function optionalVec3(value: unknown, path: string): V3 | undefined {
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
  const b0 = matrix[12]!, b1 = matrix[13]!, b2 = matrix[14]!, b3 = matrix[15]!;
  if (Math.abs(b0) > 1e-9 || Math.abs(b1) > 1e-9 || Math.abs(b2) > 1e-9 || Math.abs(b3 - 1) > 1e-9) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be affine (bottom row [0,0,0,1])`, false);
  }
  return matrix;
}

/** COMPAT-CAD-002: validate a planar extrusion profile (same rules as the
 *  OCCT adapter's requireProfile — the error surface stays engine-
 *  independent). */
function requireProfile(value: unknown, path: string): readonly (readonly [number, number])[] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new AdapterFailure("engine_malformed_input", `${path} must be an array of at least 3 [x, y] points`, false);
  }
  if (value.length > MAX_PROFILE_POINTS) {
    throw new AdapterFailure("engine_malformed_input", `${path} exceeds the ${MAX_PROFILE_POINTS}-point bound`, false);
  }
  const points: [number, number][] = value.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(isFiniteNumber)) {
      throw new AdapterFailure("engine_malformed_input", `${path}[${i}] must be [x, y] finite numbers`, false);
    }
    return [p[0] as number, p[1] as number];
  });
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= PROFILE_COINCIDENCE_EPS) {
      throw new AdapterFailure(
        "engine_malformed_input",
        `${path}: point ${i % points.length} coincides with its successor (implicit closure — do not repeat the first point at the end)`,
        false,
      );
    }
  }
  if (shoelaceMagnitude(points) <= PROFILE_AREA_EPS) {
    throw new AdapterFailure(
      "engine_malformed_input",
      `${path} must span a non-degenerate area (shoelace magnitude > ${PROFILE_AREA_EPS})`,
      false,
    );
  }
  return points;
}

/** Shoelace area magnitude of an implicitly-closed polygon. */
function shoelaceMagnitude(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** Structural validation of the descriptor BEFORE evaluation (validation IS
 *  compilation — identical principle to the OCCT adapter). Throws typed
 *  failures for malformed input. */
function validateDescriptor(descriptor: unknown, depth = 0): void {
  if (depth > MAX_DESCRIPTOR_DEPTH) {
    throw new AdapterFailure(
      "engine_malformed_input",
      `geometry descriptor nesting exceeds the ${MAX_DESCRIPTOR_DEPTH}-level bound`,
      false,
    );
  }
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new AdapterFailure("engine_malformed_input", "geometry descriptor must be an object", false);
  }
  const d = descriptor as { shape?: unknown; [key: string]: unknown };
  switch (d.shape) {
    case "box": {
      requirePositive(d.width, "geometry.width");
      requirePositive(d.depth, "geometry.depth");
      requirePositive(d.height, "geometry.height");
      return;
    }
    case "cylinder": {
      requirePositive(d.radius, "geometry.radius");
      requirePositive(d.height, "geometry.height");
      const direction = optionalVec3(d.direction, "geometry.direction");
      if (direction !== undefined) {
        const norm = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
        if (norm <= 1e-12) {
          throw new AdapterFailure("engine_malformed_input", "geometry.direction must be a non-null vector", false);
        }
      }
      return;
    }
    case "extrude": {
      requirePositive(d.height, "geometry.height");
      requireProfile(d.profile, "geometry.profile");
      optionalVec3(d.base, "geometry.base");
      return;
    }
    case "transform": {
      requireMatrix(d.matrix, "geometry.matrix");
      validateDescriptor(d.target, depth + 1);
      return;
    }
    case "fuse":
    case "cut": {
      validateDescriptor(d.a, depth + 1);
      validateDescriptor(d.b, depth + 1);
      return;
    }
    default:
      throw new AdapterFailure(
        "engine_malformed_input",
        `geometry.shape must be one of box/cylinder/extrude/transform/fuse/cut, got ${JSON.stringify(d.shape)}`,
        false,
      );
  }
}

// ---------------------------------------------------------------------------
// Analytic solid evaluation
// ---------------------------------------------------------------------------

/** An axis-aligned world-space cell (an open box). */
interface Cell {
  readonly min: V3;
  readonly max: V3;
}

/** A cylinder in world space (origin = BASE center, height extends along the
 *  unit direction — the same gp_Ax2 placement semantics the OCCT adapter
 *  documents for `cylinder.origin/direction`). */
interface WorldCylinder {
  readonly origin: V3;
  readonly dir: V3; // unit
  readonly radius: number;
  readonly height: number;
}

/** A parallelepiped in world space (8 corners in canonical box-corner order —
 *  the image of a cell under an affine map). Exact volume/bbox; produced
 *  when a box cell set meets a non-diagonal affine transform. */
interface Polyhedron {
  readonly corners: readonly V3[];
  readonly volume: number;
}

/** A Z-extruded polygon prism in world space (COMPAT-CAD-002): a planar
 *  polygon profile in world XY between zMin and zMax. Exact volume
 *  (shoelace × Z span), exact bbox (profile AABB × Z span) and an exact
 *  prism mesh (winding-normalized CCW caps + side quads). */
interface WorldPrism {
  readonly profile: readonly (readonly [number, number])[];
  readonly zMin: number;
  readonly zMax: number;
}

type Part =
  | { readonly kind: "cells"; readonly cells: readonly Cell[] }
  | { readonly kind: "cylinder"; readonly cylinder: WorldCylinder }
  | { readonly kind: "poly"; readonly poly: Polyhedron }
  | { readonly kind: "prism"; readonly prism: WorldPrism };

interface Solid {
  readonly parts: readonly Part[];
  readonly volume: number;
  readonly bbox: readonly [number, number, number, number, number, number];
  readonly mesh: MeshData;
}

/** Typed exactness-class decline (LOCK-007: never guess, fail honestly). */
function decline(reason: string): never {
  throw new AdapterFailure("engine_error", `reference adapter exactness class: ${reason}`, false);
}

function cellVolume(c: Cell): number {
  return (c.max[0] - c.min[0]) * (c.max[1] - c.min[1]) * (c.max[2] - c.min[2]);
}

/** Exact world AABB of a cylinder from its frame (no tessellation involved):
 *  per axis i the extent is h·|dᵢ| + 2·r·√(1−dᵢ²). */
function cylinderBBox(c: WorldCylinder): readonly [number, number, number, number, number, number] {
  const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 3; i++) {
    const di = c.dir[i]!;
    const radial = c.radius * Math.sqrt(Math.max(0, 1 - di * di));
    const a = c.origin[i]! - radial;
    const b = c.origin[i]! + c.height * di + radial;
    out[i] = Math.min(a, b);
    out[i + 3] = Math.max(a, b);
  }
  return out;
}

function unionBBox(
  a: readonly [number, number, number, number, number, number],
  b: readonly [number, number, number, number, number, number],
): readonly [number, number, number, number, number, number] {
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
  ];
}

// --- deterministic tessellation ---------------------------------------------

const BOX_INDICES: readonly number[] = [
  0, 3, 2, 0, 2, 1, // z-
  4, 5, 6, 4, 6, 7, // z+
  0, 1, 5, 0, 5, 4, // y-
  2, 3, 7, 2, 7, 6, // y+
  0, 4, 7, 0, 7, 3, // x-
  1, 2, 6, 1, 6, 5, // x+
];

/** Canonical box-corner enumeration order (matches BOX_INDICES): */
function cellCorners(c: Cell): V3[] {
  const { min, max } = c;
  return [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]],
  ];
}

function cellMesh(c: Cell): MeshData {
  const vertices: number[] = [];
  for (const p of cellCorners(c)) vertices.push(p[0], p[1], p[2]);
  return { vertices, indices: [...BOX_INDICES] };
}

/** Tessellate a cylinder directly in its world frame (base ring, top ring,
 *  two cap centers; fixed CCW angle order → deterministic). */
function cylinderMesh(c: WorldCylinder): MeshData {
  const { u, v } = frameFor(c.dir);
  const top = add3(c.origin, scale3(c.dir, c.height));
  const vertices: number[] = [c.origin[0], c.origin[1], c.origin[2]]; // 0: base center
  vertices.push(top[0], top[1], top[2]); // 1: top center
  // CAD-PARITY-009: the ring samples come from the FIXED literal table —
  // never runtime Math.cos/Math.sin (1-ulp divergence across V8 builds would
  // fork the meshToken per host; the fixture caught exactly that).
  for (let s = 0; s < CYLINDER_SEGMENTS; s++) {
    const [ringCos, ringSin] = CYLINDER_RING_TABLE[s]!;
    const p = add3(add3(c.origin, scale3(u, c.radius * ringCos)), scale3(v, c.radius * ringSin));
    vertices.push(p[0], p[1], p[2]);
  }
  for (let s = 0; s < CYLINDER_SEGMENTS; s++) {
    const [ringCos, ringSin] = CYLINDER_RING_TABLE[s]!;
    const p = add3(add3(top, scale3(u, c.radius * ringCos)), scale3(v, c.radius * ringSin));
    vertices.push(p[0], p[1], p[2]);
  }
  const indices: number[] = [];
  const base0 = 2;
  const top0 = 2 + CYLINDER_SEGMENTS;
  for (let s = 0; s < CYLINDER_SEGMENTS; s++) {
    const s2 = (s + 1) % CYLINDER_SEGMENTS;
    // side quad (two triangles)
    indices.push(base0 + s, base0 + s2, top0 + s2, base0 + s, top0 + s2, top0 + s);
    // caps
    indices.push(0, base0 + s2, base0 + s);
    indices.push(1, top0 + s, top0 + s2);
  }
  return { vertices, indices };
}

function polyMesh(p: Polyhedron): MeshData {
  const vertices: number[] = [];
  for (const c of p.corners) vertices.push(c[0], c[1], c[2]);
  return { vertices, indices: [...BOX_INDICES] };
}

/** Deterministic prism tessellation: CCW-normalized profile, bottom cap fan,
 * top cap fan, side quads (two triangles each, fixed order). */
function prismMesh(p: WorldPrism): MeshData {
  const n = p.profile.length;
  const profile = [...p.profile];
  // Winding normalization: signed shoelace < 0 → reverse to CCW so either
  // winding of the same polygon yields the identical canonical mesh.
  let signed = 0;
  for (let i = 0; i < n; i++) {
    const a = profile[i]!;
    const b = profile[(i + 1) % n]!;
    signed += a[0] * b[1] - b[0] * a[1];
  }
  if (signed < 0) profile.reverse();
  const vertices: number[] = [];
  for (const [x, y] of profile) vertices.push(x, y, p.zMin);
  for (const [x, y] of profile) vertices.push(x, y, p.zMax);
  const indices: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    // bottom cap fan (0, i+1, i) — CW seen from +Z (outward normal down)
    indices.push(0, i + 1, i);
    // top cap fan
    indices.push(n, n + i, n + i + 1);
  }
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    indices.push(i, i2, n + i2, i, n + i2, n + i);
  }
  return { vertices, indices };
}

function concatMesh(a: MeshData, b: MeshData): MeshData {
  const offset = a.vertices.length / 3;
  return {
    vertices: [...a.vertices, ...b.vertices],
    indices: [...a.indices, ...b.indices.map((i) => i + offset)],
  };
}

// --- per-part exact properties ----------------------------------------------

function partVolume(part: Part): number {
  switch (part.kind) {
    case "cells":
      return part.cells.reduce((sum, c) => sum + cellVolume(c), 0);
    case "cylinder":
      return Math.PI * part.cylinder.radius * part.cylinder.radius * part.cylinder.height;
    case "poly":
      return part.poly.volume;
    case "prism":
      return shoelaceMagnitude(part.prism.profile) * (part.prism.zMax - part.prism.zMin);
  }
}

function partBBox(part: Part): readonly [number, number, number, number, number, number] {
  switch (part.kind) {
    case "cells": {
      const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const c of part.cells) {
        for (let i = 0; i < 3; i++) {
          out[i] = Math.min(out[i]!, c.min[i]!);
          out[i + 3] = Math.max(out[i + 3]!, c.max[i]!);
        }
      }
      return out;
    }
    case "cylinder":
      return cylinderBBox(part.cylinder);
    case "poly": {
      const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const c of part.poly.corners) {
        for (let i = 0; i < 3; i++) {
          out[i] = Math.min(out[i]!, c[i]!);
          out[i + 3] = Math.max(out[i + 3]!, c[i]!);
        }
      }
      return out;
    }
    case "prism": {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of part.prism.profile) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return [minX, minY, part.prism.zMin, maxX, maxY, part.prism.zMax];
    }
  }
}

function partMesh(part: Part): MeshData {
  switch (part.kind) {
    case "cells": {
      // one mesh per cell, cells in canonical (min-lexicographic) order
      const cells = [...part.cells].sort((x, y) =>
        x.min[0] < y.min[0] ? -1 : x.min[0] > y.min[0] ? 1 :
        x.min[1] < y.min[1] ? -1 : x.min[1] > y.min[1] ? 1 :
        x.min[2] < y.min[2] ? -1 : x.min[2] > y.min[2] ? 1 : 0,
      );
      let mesh: MeshData | null = null;
      for (const c of cells) mesh = mesh === null ? cellMesh(c) : concatMesh(mesh, cellMesh(c));
      return mesh ?? { vertices: [], indices: [] };
    }
    case "cylinder":
      return cylinderMesh(part.cylinder);
    case "poly":
      return polyMesh(part.poly);
    case "prism":
      return prismMesh(part.prism);
  }
}

function solidOf(parts: readonly Part[]): Solid {
  let volume = 0;
  let bbox: readonly [number, number, number, number, number, number] | null = null;
  let mesh: MeshData | null = null;
  for (const part of parts) {
    volume += partVolume(part);
    const pb = partBBox(part);
    bbox = bbox === null ? pb : unionBBox(bbox, pb);
    const pm = partMesh(part);
    mesh = mesh === null ? pm : concatMesh(mesh, pm);
  }
  if (bbox === null || mesh === null) decline("empty solid has no exact representation");
  return { parts, volume, bbox, mesh };
}

// --- transform matrix classification ----------------------------------------

interface MatrixClass {
  readonly diagonal: boolean;       // linear part diagonal (± entries)
  readonly rigidOrUniform: boolean; // orthonormal columns, possibly × uniform scale
  readonly uniformScale: number;    // |det|^(1/3) when rigidOrUniform
}

function classifyMatrix(m: Matrix4): MatrixClass {
  const offDiag = [m[1]!, m[2]!, m[4]!, m[6]!, m[8]!, m[9]!];
  const diagonal = offDiag.every((x) => Math.abs(x) <= EPS_ALIGN);
  const c0 = norm3([m[0]!, m[4]!, m[8]!]);
  const c1 = norm3([m[1]!, m[5]!, m[9]!]);
  const c2 = norm3([m[2]!, m[6]!, m[10]!]);
  const uniformCols =
    Math.abs(c0 - c1) <= 1e-9 * Math.max(1, c0) &&
    Math.abs(c1 - c2) <= 1e-9 * Math.max(1, c1);
  const dot01 = m[0]! * m[1]! + m[4]! * m[5]! + m[8]! * m[9]!;
  const dot02 = m[0]! * m[2]! + m[4]! * m[6]! + m[8]! * m[10]!;
  const dot12 = m[1]! * m[2]! + m[5]! * m[6]! + m[9]! * m[10]!;
  const orthogonal =
    Math.abs(dot01) <= 1e-9 * Math.max(1, c0 * c1) &&
    Math.abs(dot02) <= 1e-9 * Math.max(1, c0 * c2) &&
    Math.abs(dot12) <= 1e-9 * Math.max(1, c1 * c2);
  const det = Math.abs(det3(m));
  const rigidOrUniform = uniformCols && orthogonal && det > 1e-12;
  const uniformScale = rigidOrUniform ? Math.cbrt(det) : 0;
  return { diagonal, rigidOrUniform, uniformScale };
}

// --- cell subtraction (exact plane-split decomposition) ----------------------

function intersectCells(a: Cell, b: Cell): Cell | null {
  const min: V3 = [Math.max(a.min[0]!, b.min[0]!), Math.max(a.min[1]!, b.min[1]!), Math.max(a.min[2]!, b.min[2]!)];
  const max: V3 = [Math.min(a.max[0]!, b.max[0]!), Math.min(a.max[1]!, b.max[1]!), Math.min(a.max[2]!, b.max[2]!)];
  if (max[0]! - min[0]! <= 0 || max[1]! - min[1]! <= 0 || max[2]! - min[2]! <= 0) return null;
  return { min, max };
}

/** a \ b for axis-aligned cells via the plane-split decomposition. */
function subtractCell(a: Cell, b: Cell): Cell[] {
  const inter = intersectCells(a, b);
  if (inter === null) return [a];
  const xs = [a.min[0], inter.min[0], inter.max[0], a.max[0]];
  const ys = [a.min[1], inter.min[1], inter.max[1], a.max[1]];
  const zs = [a.min[2], inter.min[2], inter.max[2], a.max[2]];
  const out: Cell[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        const min: V3 = [xs[i]!, ys[j]!, zs[k]!];
        const max: V3 = [xs[i + 1]!, ys[j + 1]!, zs[k + 1]!];
        if (max[0]! - min[0]! <= 0 || max[1]! - min[1]! <= 0 || max[2]! - min[2]! <= 0) continue;
        // skip the single decomposition cell inside the intersection
        if (
          min[0] >= inter.min[0] && max[0] <= inter.max[0] &&
          min[1] >= inter.min[1] && max[1] <= inter.max[1] &&
          min[2] >= inter.min[2] && max[2] <= inter.max[2]
        ) continue;
        out.push({ min, max });
      }
    }
  }
  return out;
}

// --- recursive evaluation -----------------------------------------------------

interface EvalState {
  nodes: number;
}

function evalDescriptor(descriptor: unknown, state: EvalState): Solid {
  state.nodes += 1;
  if (state.nodes > MAX_EVALUATION_NODES) {
    throw new AdapterFailure(
      "engine_malformed_input",
      `geometry descriptor compiles to more than ${MAX_EVALUATION_NODES} evaluation nodes`,
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
      const cell: Cell = { min: [0, 0, 0], max: [width, depth, height] };
      return solidOf([{ kind: "cells", cells: [cell] }]);
    }
    case "cylinder": {
      const radius = requirePositive(d.radius, "geometry.radius");
      const height = requirePositive(d.height, "geometry.height");
      const origin = optionalVec3(d.origin, "geometry.origin") ?? [0, 0, 0];
      const dirRaw = optionalVec3(d.direction, "geometry.direction") ?? [0, 0, 1];
      const dirLen = norm3(dirRaw);
      if (dirLen <= 1e-12) {
        throw new AdapterFailure("engine_malformed_input", "geometry.direction must be a non-null vector", false);
      }
      const dir = scale3(dirRaw, 1 / dirLen);
      return solidOf([{ kind: "cylinder", cylinder: { origin, dir, radius, height } }]);
    }
    case "extrude": {
      // COMPAT-CAD-002: exact prism part.
      const height = requirePositive(d.height, "geometry.height");
      const profile = requireProfile(d.profile, "geometry.profile");
      const base = optionalVec3(d.base, "geometry.base") ?? [0, 0, 0];
      const z0 = base[2];
      const z1 = base[2] + height;
      return solidOf([
        { kind: "prism", prism: { profile, zMin: Math.min(z0, z1), zMax: Math.max(z0, z1) } },
      ]);
    }
    case "transform": {
      const matrix = requireMatrix(d.matrix, "geometry.matrix");
      const target = evalDescriptor(d.target, state);
      return transformSolid(target, matrix);
    }
    case "fuse": {
      const a = evalDescriptor(d.a, state);
      const b = evalDescriptor(d.b, state);
      // Exact only when every cross part pair has disjoint AABBs (touching
      // allowed — measure-zero boundary). Conservative and honest.
      for (const pa of a.parts) {
        const ba = partBBox(pa);
        for (const pb of b.parts) {
          const bb = partBBox(pb);
          const overlap =
            ba[0] < bb[3] && bb[0] < ba[3] &&
            ba[1] < bb[4] && bb[1] < ba[4] &&
            ba[2] < bb[5] && bb[2] < ba[5];
          if (overlap) {
            decline("fuse with overlapping operand bounding boxes (disjoint operands only; the reference engine never approximates a boolean)");
          }
        }
      }
      return solidOf([...a.parts, ...b.parts]);
    }
    case "cut": {
      const a = evalDescriptor(d.a, state);
      const b = evalDescriptor(d.b, state);
      const cellsA = asCellSet(a);
      const cellsB = asCellSet(b);
      if (cellsA === null || cellsB === null) {
        decline("cut requires both operands to be axis-aligned box combinations (cells)");
      }
      let surviving: Cell[] = [...cellsA];
      for (const cb of cellsB) {
        const next: Cell[] = [];
        for (const ca of surviving) next.push(...subtractCell(ca, cb));
        surviving = next;
      }
      if (surviving.length === 0) {
        decline("cut removes all material (empty result)");
      }
      return solidOf([{ kind: "cells", cells: surviving }]);
    }
    default:
      throw new AdapterFailure(
        "engine_malformed_input",
        `geometry.shape must be one of box/cylinder/extrude/transform/fuse/cut, got ${JSON.stringify(d.shape)}`,
        false,
      );
  }
}

/** Reduce a solid to its axis-aligned cell list, or null when it contains
 *  cylinders/polyhedra/prisms (out of the cut exactness class). */
function asCellSet(solid: Solid): readonly Cell[] | null {
  const cells: Cell[] = [];
  for (const part of solid.parts) {
    if (part.kind !== "cells") return null;
    cells.push(...part.cells);
  }
  return cells;
}

function transformSolid(solid: Solid, m: Matrix4): Solid {
  const cls = classifyMatrix(m);
  const det = Math.abs(det3(m));
  if (det <= 1e-12) decline("singular transform matrix (zero-volume image)");
  const parts: Part[] = [];
  for (const part of solid.parts) {
    switch (part.kind) {
      case "cells": {
        if (cls.diagonal) {
          // stays axis-aligned: transform each cell's 8 corners and normalize
          const cells: Cell[] = part.cells.map((c) => {
            const corners = cellCorners(c).map((p) => matVec(m, p));
            const min: V3 = [
              Math.min(...corners.map((p) => p[0])),
              Math.min(...corners.map((p) => p[1])),
              Math.min(...corners.map((p) => p[2])),
            ];
            const max: V3 = [
              Math.max(...corners.map((p) => p[0])),
              Math.max(...corners.map((p) => p[1])),
              Math.max(...corners.map((p) => p[2])),
            ];
            return { min, max };
          });
          parts.push({ kind: "cells", cells });
        } else {
          // parallelepipeds: exact corners (canonical order preserved), volume × |det|
          for (const c of part.cells) {
            parts.push({
              kind: "poly",
              poly: {
                corners: cellCorners(c).map((p) => matVec(m, p)),
                volume: cellVolume(c) * det,
              },
            });
          }
        }
        break;
      }
      case "cylinder": {
        if (!cls.rigidOrUniform) {
          decline("non-rigid, non-uniform affine transform of a cylinder (the image is not a cylinder; the reference engine never approximates)");
        }
        const s = cls.uniformScale;
        const cy = part.cylinder;
        const dirT = matDir(m, cy.dir);
        const dirLen = norm3(dirT);
        parts.push({
          kind: "cylinder",
          cylinder: {
            origin: matVec(m, cy.origin),
            dir: scale3(dirT, 1 / dirLen),
            radius: cy.radius * s,
            height: cy.height * s,
          },
        });
        break;
      }
      case "poly": {
        // affine image of a parallelepiped: still a parallelepiped
        parts.push({
          kind: "poly",
          poly: {
            corners: part.poly.corners.map((c) => matVec(m, c)),
            volume: part.poly.volume * det,
          },
        });
        break;
      }
      case "prism": {
        // COMPAT-CAD-002: EXACT only under a Z-PRESERVING affine map —
        // x' = m00·x + m01·y + m03, y' = m10·x + m11·y + m13 (no z term),
        // z' = m22·z + m23 (no x/y term). The profile maps by the planar
        // 2×2, the span maps linearly; volume scales by |det2D · m22|.
        // Anything that tilts the extrusion axis leaves the exactness class.
        if (
          Math.abs(m[2]!) > EPS_ALIGN || Math.abs(m[6]!) > EPS_ALIGN ||
          Math.abs(m[8]!) > EPS_ALIGN || Math.abs(m[9]!) > EPS_ALIGN ||
          Math.abs(m[10]!) <= EPS_ALIGN
        ) {
          decline("non-Z-preserving affine transform of an extrusion (the image is not a Z prism; the reference engine never approximates)");
        }
        const g = m[10]!;
        const pr = part.prism;
        const z0 = g * pr.zMin + m[11]!;
        const z1 = g * pr.zMax + m[11]!;
        const profile = pr.profile.map((p) => [
          m[0]! * p[0] + m[1]! * p[1] + m[3]!,
          m[4]! * p[0] + m[5]! * p[1] + m[7]!,
        ] as [number, number]);
        parts.push({
          kind: "prism",
          prism: { profile, zMin: Math.min(z0, z1), zMax: Math.max(z0, z1) },
        });
        break;
      }
    }
  }
  return solidOf(parts);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly mesh: MeshData;
  readonly metadata: GeometryMetadata;
}

/** Deterministic meshToken over the canonical mesh encoding. */
function meshTokenOf(mesh: MeshData): string {
  const digest = createHash("sha256")
    .update(
      canonicalStringify({
        engine: `${REFERENCE_ENGINE_ID}@${REFERENCE_ENGINE_VERSION}`,
        segments: CYLINDER_SEGMENTS,
        vertices: mesh.vertices,
        indices: mesh.indices,
      }),
    )
    .digest("hex");
  return `${REFERENCE_MESH_PREFIX}${digest}`;
}

/**
 * Create the reference geometry adapter — the second, engine-free
 * implementation of the frozen `GeometryEngineAdapter` contract. Pure
 * in-process analytic evaluation: no subprocess, no native dependency.
 */
export function createReferenceGeometryAdapter(): GeometryEngineAdapter & {
  describeMesh(meshToken: string): Promise<MeshData | null>;
  describeGeometryMetadata(meshToken: string): Promise<GeometryMetadata | null>;
} {
  const cache = new Map<string, CacheEntry>();

  function remember(solid: Solid, token: string): void {
    cache.set(token, {
      mesh: { vertices: [...solid.mesh.vertices], indices: [...solid.mesh.indices] },
      metadata: {
        volume: solid.volume,
        vertices: solid.mesh.vertices.length / 3,
        triangles: solid.mesh.indices.length / 3,
      },
    });
    if (cache.size > MESH_CACHE_CAPACITY) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  const adapter = {
    adapterMark: ADAPTER_BOUNDARY_MARK,
    engineId: REFERENCE_ENGINE_ID,
    engineVersion: REFERENCE_ENGINE_VERSION,

    async prepareGeometry(element: Element): Promise<GeometryResult> {
      validateDescriptor(element.props);
      const solid = evalDescriptor(element.props, { nodes: 0 });
      const meshToken = meshTokenOf(solid.mesh);
      remember(solid, meshToken);
      return { meshToken, bbox: [...solid.bbox] as [number, number, number, number, number, number] };
    },

    async describeMesh(meshToken: string): Promise<MeshData | null> {
      return cache.get(meshToken)?.mesh ?? null;
    },

    async describeGeometryMetadata(meshToken: string): Promise<GeometryMetadata | null> {
      return cache.get(meshToken)?.metadata ?? null;
    },
  };

  if (!isMeshProvider(adapter) || !isGeometryMetadataProvider(adapter)) {
    throw new Error("reference adapter capability shape regression");
  }
  return adapter;
}

/** Exact analytic evaluation of a descriptor (volume + world bbox) without
 *  touching adapter caches. Throws the same typed exactness-class failures
 *  as `prepareGeometry`. Used by evidence tooling and tests. */
export function evaluateDescriptorAnalytically(descriptor: unknown): {
  readonly volume: number;
  readonly bbox: readonly [number, number, number, number, number, number];
} {
  validateDescriptor(descriptor);
  const solid = evalDescriptor(descriptor, { nodes: 0 });
  return { volume: solid.volume, bbox: [...solid.bbox] as [number, number, number, number, number, number] };
}
