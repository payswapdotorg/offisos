/**
 * BIM viewport projection math (COMPAT-CAD-002 / Issue #39) — Web host.
 *
 * PURE, engine-free orthographic projection helpers for the bounded
 * deterministic 3D visualization. The camera (eye/target/up in mm world
 * coordinates) comes from the shared `bim.camera` query — the SAME pure
 * camera module the server runs (§5.5 parity) — and is turned into a 2D
 * screen basis here. No WebGL, no three.js, no npm additions: SVG polygons
 * only. This is a BOUNDED WIREFRAME presentation of element world extents,
 * not an engine mesh renderer (LOCK-003/018: no engine ever loads in the
 * browser).
 */

export type Vec3 = readonly [number, number, number];

/** An axis-aligned world box [minX, minY, minZ, maxX, maxY, maxZ] (mm). */
export type WorldBox = readonly [number, number, number, number, number, number];

/** Orthographic screen basis derived from a standard camera. */
export interface ProjectionBasis {
  /** Screen-right unit vector (world space). */
  readonly right: Vec3;
  /** Screen-up unit vector (world space). */
  readonly up: Vec3;
  /** Camera forward unit vector (target − eye, normalized). */
  readonly forward: Vec3;
  /** Camera target (world space; the projection origin). */
  readonly target: Vec3;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v)) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Build the screen basis for a camera (eye → target, up hint). Deterministic
 *  fixed operation order — identical inputs give identical bases. */
export function projectionBasis(eye: Vec3, target: Vec3, upHint: Vec3): ProjectionBasis {
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, upHint));
  const up = cross(right, forward);
  return { right, up, forward, target };
}

/** Projected 2D coordinates + view depth of a world point. Depth grows along
 *  the camera forward direction (larger = farther from the camera). */
export interface ProjectedPoint {
  readonly sx: number;
  readonly sy: number;
  readonly depth: number;
}

/** Project one world point into basis-relative 2D + depth (unscaled mm). */
export function projectRelative(basis: ProjectionBasis, p: Vec3): ProjectedPoint {
  const d = sub(p, basis.target);
  return {
    sx: dot(d, basis.right),
    sy: dot(d, basis.up),
    depth: dot(d, basis.forward),
  };
}

/** The 8 corners of an axis-aligned world box (deterministic order). */
export function boxCorners(box: WorldBox): Vec3[] {
  const [minX, minY, minZ, maxX, maxY, maxZ] = box;
  return [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
}

/** The 6 faces of a box as corner-index quadruples (matches boxCorners). */
export const BOX_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3], // bottom (minZ)
  [4, 5, 6, 7], // top (maxZ)
  [0, 1, 5, 4], // minY side
  [2, 3, 7, 6], // maxY side
  [1, 2, 6, 5], // maxX side
  [0, 3, 7, 4], // minX side
];

/** The 12 box edges as corner-index pairs (matches boxCorners). */
export const BOX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom ring
  [4, 5], [5, 6], [6, 7], [7, 4], // top ring
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];

/** Fit transform: uniform scale + screen offset that maps basis-relative mm
 *  coordinates into a w×h viewport with the given margin. Deterministic. */
export interface FitTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function fitTransform(
  basis: ProjectionBasis,
  box: WorldBox,
  width: number,
  height: number,
  margin: number,
): FitTransform {
  const pts = boxCorners(box).map((p) => projectRelative(basis, p));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.sx < minX) minX = p.sx;
    if (p.sx > maxX) maxX = p.sx;
    if (p.sy < minY) minY = p.sy;
    if (p.sy > maxY) maxY = p.sy;
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // SVG y grows downward: screenY = height/2 − (sy − cy)·scale.
  return { scale, offsetX: width / 2 - cx * scale, offsetY: height / 2 + cy * scale };
}

/** Map a basis-relative projection to SVG screen coordinates. */
export function toScreen(
  p: ProjectedPoint,
  fit: FitTransform,
): { readonly x: number; readonly y: number } {
  return {
    x: fit.offsetX + p.sx * fit.scale,
    y: fit.offsetY - p.sy * fit.scale,
  };
}
