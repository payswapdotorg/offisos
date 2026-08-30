/**
 * CAD-PARITY-009 (Issue #90): the deterministic 3D vector/matrix foundation.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Every operation has a
 * FIXED floating-point operation order (documented per function) so Web,
 * Electron, the App API and every test compute bit-identical results from the
 * same inputs (IEEE-754 double precision; plain scalar arithmetic in the
 * written order only).
 *
 * Coordinates: the ConstructionOS CAD world is Z-up (the drafting plane is XY,
 * Z is elevation — the AutoCAD convention). Vec3/Matrix4 come from the shared
 * contracts; Matrix4 is row-major affine with bottom row [0,0,0,1], v' = M·v.
 */

import type { Matrix4, Vec3 } from "../../contracts/geometry.js";

export type { Vec3 } from "../../contracts/geometry.js";

/** The documented orthonormality tolerance for UCS axis triples: axes must be
 *  unit length and pairwise perpendicular within 1e-9 (relative) — anything
 *  looser is a typed decline at the document boundary, never silently
 *  normalized. */
export const UCS_ORTHONORMAL_TOLERANCE = 1e-9;

/** Smallest length treated as non-degenerate (lengths below this are the zero
 *  vector for normalization/axis purposes — typed declines upstream). */
export const EPS3D = 1e-12;

// --- Vec3 operations (fixed order: x, then y, then z) ----------------------

export function v3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function v3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** a·b — computed as a0*b0 + a1*b1 + a2*b2 (left-to-right additions). */
export function v3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** a×b — the right-handed cross product
 *  (a1*b2 − a2*b1, a2*b0 − a0*b2, a0*b1 − a1*b0). */
export function v3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** |a| = sqrt(a·a). */
export function v3Length(a: Vec3): number {
  return Math.sqrt(v3Dot(a, a));
}

/** a scaled by s (component order x, y, z). */
export function v3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Unit-length a, or null when |a| < EPS3D (the caller decides the typed
 *  decline — never a silent fallback). */
export function v3Normalize(a: Vec3): Vec3 | null {
  const len = v3Length(a);
  if (!(len > EPS3D)) return null;
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Component-wise equality within an absolute tolerance (deterministic
 *  pairwise checks in x, y, z order). */
export function v3Equals(a: Vec3, b: Vec3, tol: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol
  );
}

/** Fixed-format component string (the canonical numeric rendering for
 *  deterministic echo/UI text — 6 decimals, trailing zeros trimmed, −0
 *  normalized to 0). */
export function formatVec3(a: Vec3): string {
  return `(${fmtNum(a[0])}, ${fmtNum(a[1])}, ${fmtNum(a[2])})`;
}

/** Canonical number formatting shared by every CAD-PARITY-009 surface. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity";
  const n6 = Number(n.toFixed(6));
  const norm = Object.is(n6, -0) ? 0 : n6;
  return String(norm);
}

// --- Matrix4 operations (row-major affine) ----------------------------------

export const IDENTITY_MATRIX4: Matrix4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

/** Translation by t. */
export function translationMatrix(t: Vec3): Matrix4 {
  return [
    1, 0, 0, t[0],
    0, 1, 0, t[1],
    0, 0, 1, t[2],
    0, 0, 0, 1,
  ];
}

/** Uniform scale s about the origin. */
export function scaleMatrix(s: number): Matrix4 {
  return [
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, s, 0,
    0, 0, 0, 1,
  ];
}

/** Non-uniform scale about the origin (sx, sy, sz). */
export function scaleMatrix3(sx: number, sy: number, sz: number): Matrix4 {
  return [
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ];
}

/** Rotation by `deg` degrees about the UNIT axis `axis` (Rodrigues formula,
 *  fixed term order). Returns null for a degenerate axis. */
export function rotationMatrix(axis: Vec3, deg: number): Matrix4 | null {
  const n = v3Normalize(axis);
  if (n === null) return null;
  const [x, y, z] = n;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** A matrix with linear rows (xAxis, yAxis, zAxis as the ROW basis) and
 *  translation t — the UCS placement matrix (rows are the UCS axes expressed
 *  in world coordinates; ucsToWorld(p) = M · p with p in UCS coordinates). */
export function basisMatrix(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, t: Vec3): Matrix4 {
  return [
    xAxis[0], xAxis[1], xAxis[2], t[0],
    yAxis[0], yAxis[1], yAxis[2], t[1],
    zAxis[0], zAxis[1], zAxis[2], t[2],
    0, 0, 0, 1,
  ];
}

/** Row-major affine multiply a·b (the composition "apply b first, then a").
 *  Fixed i/j/k loop order; affine rows only (bottom row preserved). */
export function mulMatrix(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[i * 4 + k]! * b[k * 4 + j]!;
      }
      out[i * 4 + j] = sum;
    }
  }
  return out as Matrix4;
}

/** M·p for an affine Matrix4 and a point p (w = 1). */
export function transformPoint(m: Matrix4, p: Vec3): Vec3 {
  const x = m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!;
  const y = m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!;
  const z = m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!;
  return [x, y, z];
}

/** M·d for a DIRECTION (translation dropped — directions are free vectors). */
export function transformDirection(m: Matrix4, d: Vec3): Vec3 {
  const x = m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2];
  const y = m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2];
  const z = m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2];
  return [x, y, z];
}

/** The affine inverse of an affine Matrix4 (exact for the translation+basis
 *  matrices this slice produces; returns null when the linear part is
 *  singular). Computed by cofactor expansion of the 3×3 linear block —
 *  fixed term order. */
export function invertAffine(m: Matrix4): Matrix4 | null {
  const a = m[0]!, b = m[1]!, c = m[2]!;
  const d = m[4]!, e = m[5]!, f = m[6]!;
  const g = m[8]!, h = m[9]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!(Math.abs(det) > EPS3D)) return null;
  const inv = 1 / det;
  // Adjugate / det of the linear block.
  const r00 = (e * i - f * h) * inv;
  const r01 = (c * h - b * i) * inv;
  const r02 = (b * f - c * e) * inv;
  const r10 = (f * g - d * i) * inv;
  const r11 = (a * i - c * g) * inv;
  const r12 = (c * d - a * f) * inv;
  const r20 = (d * h - e * g) * inv;
  const r21 = (b * g - a * h) * inv;
  const r22 = (a * e - b * d) * inv;
  const tx = m[3]!, ty = m[7]!, tz = m[11]!;
  return [
    r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
    r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
    r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
    0, 0, 0, 1,
  ];
}

/** Structural validity: 16 finite entries, bottom row [0,0,0,1]. */
export function isAffineMatrix(m: Matrix4): boolean {
  if (m.length !== 16) return false;
  for (const v of m) if (!Number.isFinite(v)) return false;
  return (
    m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1
  );
}

/** A finite Vec3 guard (structural validation for command payloads). */
export function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}
