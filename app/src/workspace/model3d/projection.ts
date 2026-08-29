/**
 * CAD-PARITY-009 (Issue #90): the deterministic 3D projection + selection
 * math.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — the ONE projection
 * implementation both hosts' 3D viewports and the App API's picking query
 * share (LOCK-004: no host-local navigation/selection math anywhere).
 *
 *  - Orthographic: view coords d = p − eye; xc = d·right, yc = d·up, zc =
 *    d·forward; scale = viewportHeight / (2·orthoHalfHeight);
 *    screenX = cx + xc·scale, screenY = cy − yc·scale (screen y grows down).
 *  - Perspective: focal = (viewportHeight/2) / tan(fov/2);
 *    screenX = cx + xc·focal/zc, screenY = cy − yc·focal/zc (zc > 0 —
 *    points behind the eye plane are clipped, projection returns null).
 *  - Picking rays: orthographic rays start at the unprojected screen point
 *    on the forward plane through the target and run along forward;
 *    perspective rays start at the eye and run through the pixel direction.
 *  - Hit ordering: (entry distance, then canonical element id,
 *    lexicographic) — EXACT deterministic tie-breaking, no ambiguity.
 *  - Sub-entity (face/edge/vertex) picking: a typed decline surfaced by the
 *    callers — the engine boundary exposes no topology mapping, so this
 *    module implements element-granularity only (never a silent
 *    approximation).
 */

import type { Camera3DState } from "../../contracts/caddocument.js";
import type { Vec3 } from "../../contracts/geometry.js";
import { v3Add, v3Normalize, v3Scale, v3Sub } from "./math3d.js";
import { cameraFrame, type BBox3D } from "./camera.js";

/** A screen-space viewport (CSS-pixel coordinates, y down). */
export interface ScreenViewport {
  readonly width: number;
  readonly height: number;
}

/** A projected point (screen x/y in pixels + the view-space depth zc). */
export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
  readonly zc: number;
}

/** Project a world point through a camera onto a viewport. Returns null when
 *  the point is behind the eye plane in perspective mode (clipped). */
export function projectPoint(
  camera: Camera3DState,
  viewport: ScreenViewport,
  p: Vec3,
): ProjectedPoint | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const d = v3Sub(p, camera.eye);
  const xc = d[0] * frame.right[0] + d[1] * frame.right[1] + d[2] * frame.right[2];
  const yc = d[0] * frame.up[0] + d[1] * frame.up[1] + d[2] * frame.up[2];
  const zc = d[0] * frame.forward[0] + d[1] * frame.forward[1] + d[2] * frame.forward[2];
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  if (camera.mode === "orthographic") {
    const scale = viewport.height / (2 * camera.orthoHalfHeight);
    return { x: cx + xc * scale, y: cy - yc * scale, zc };
  }
  if (!(zc > 0)) return null;
  const focal = viewport.height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  return { x: cx + (xc * focal) / zc, y: cy - (yc * focal) / zc, zc };
}

/** A picking ray (origin + unit direction). */
export interface Ray3 {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** Build the picking ray for a screen point (px, py) through a camera. */
export function screenRay(camera: Camera3DState, viewport: ScreenViewport, px: number, py: number): Ray3 | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  if (camera.mode === "orthographic") {
    const scale = viewport.height / (2 * camera.orthoHalfHeight);
    const xc = (px - cx) / scale;
    const yc = (cy - py) / scale;
    const origin = v3Add(
      v3Add(camera.eye, v3Scale(frame.right, xc)),
      v3Scale(frame.up, yc),
    );
    return { origin, direction: frame.forward };
  }
  const focal = viewport.height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  const dx = (px - cx) / focal;
  const dy = (cy - py) / focal;
  const dir = v3Normalize(
    v3Add(
      v3Add(v3Scale(frame.right, dx), v3Scale(frame.up, dy)),
      frame.forward,
    ),
  );
  if (dir === null) return null;
  return { origin: camera.eye, direction: dir };
}

/** Unproject a screen point at a given view-space depth zc back to world
 *  (the exact inverse of projectPoint at that depth). */
export function unprojectAtDepth(
  camera: Camera3DState,
  viewport: ScreenViewport,
  px: number,
  py: number,
  zc: number,
): Vec3 | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  if (camera.mode === "orthographic") {
    const scale = viewport.height / (2 * camera.orthoHalfHeight);
    const xc = (px - cx) / scale;
    const yc = (cy - py) / scale;
    return v3Add(
      v3Add(
        v3Add(camera.eye, v3Scale(frame.right, xc)),
        v3Scale(frame.up, yc),
      ),
      v3Scale(frame.forward, zc),
    );
  }
  if (!(zc > 0)) return null;
  const focal = viewport.height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  const xc = ((px - cx) / focal) * zc;
  const yc = ((cy - py) / focal) * zc;
  return v3Add(
    v3Add(
      v3Add(camera.eye, v3Scale(frame.right, xc)),
      v3Scale(frame.up, yc),
    ),
    v3Scale(frame.forward, zc),
  );
}

// --- Deterministic ray/box intersection --------------------------------------

/** The ray–AABB slab test. Returns the entry distance t (>= 0) when the ray
 *  intersects the box, or null. Deterministic: slabs processed in x→y→z
 *  order; degenerate axes (zero direction component) handled by the
 *  standard bounds check (no division — comparisons only). */
export function rayIntersectsBox(ray: Ray3, box: BBox3D): number | null {
  let tmin = 0;
  let tmax = Number.POSITIVE_INFINITY;
  const lo = [box.minX, box.minY, box.minZ];
  const hi = [box.maxX, box.maxY, box.maxZ];
  const o = [ray.origin[0], ray.origin[1], ray.origin[2]];
  const d = [ray.direction[0], ray.direction[1], ray.direction[2]];
  for (let i = 0; i < 3; i += 1) {
    const di = d[i]!;
    const oi = o[i]!;
    if (di === 0) {
      if (oi < lo[i]! || oi > hi[i]!) return null;
      continue;
    }
    const inv = 1 / di;
    let t1 = (lo[i]! - oi) * inv;
    let t2 = (hi[i]! - oi) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** A pickable 3D element surface (the persisted element state the shared
 *  selection consumes — engine-neutral: the engine-produced bbox persisted
 *  in element props). */
export interface PickableElement {
  readonly id: string;
  readonly bbox: BBox3D | null;
}

/** One deterministic hit. */
export interface PickHit {
  readonly elementId: string;
  /** Ray entry distance into the element bbox (world units). */
  readonly distance: number;
}

/** Deterministic element-granularity 3D selection: ray vs each element's
 *  bbox, hit ordering EXACTLY (distance, then element id lexicographic) —
 *  no tie ambiguity. Elements without a bbox are never hit (they have no
 *  realized geometry — the meshToken-less state). */
export function pickElements(ray: Ray3, elements: readonly PickableElement[]): readonly PickHit[] {
  const hits: PickHit[] = [];
  for (const el of elements) {
    if (el.bbox === null) continue;
    const t = rayIntersectsBox(ray, el.bbox);
    if (t === null) continue;
    hits.push({ elementId: el.id, distance: t });
  }
  hits.sort((a, b) => (a.distance === b.distance ? (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0) : a.distance - b.distance));
  return hits;
}

/** The typed decline carried by every sub-entity picking surface in this
 *  slice (the App API query and both hosts surface the same reason — the
 *  engine boundary exposes no face/edge/vertex topology mapping for
 *  tessellated meshes, so sub-entity selection would be an approximation). */
export const SUBENTITY_DECLINE_REASON =
  "sub-entity (face/edge/vertex) selection is not supported in this slice: the adapter boundary provides tessellation without topology mapping; element-granularity selection is the deterministic surface (no silent approximation)";

/** Project an axis-aligned bbox's 8 corners and return the screen-space
 *  2D bounds (the deterministic wireframe-culling basis for both hosts).
 *  Returns null when every corner is clipped (perspective behind-eye). */
export function projectBoxCorners(
  camera: Camera3DState,
  viewport: ScreenViewport,
  box: BBox3D,
): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const sx of [box.minX, box.maxX]) {
    for (const sy of [box.minY, box.maxY]) {
      for (const sz of [box.minZ, box.maxZ]) {
        const p = projectPoint(camera, viewport, [sx, sy, sz]);
        if (p === null) continue;
        any = true;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** The 12 box edges as corner pairs (fixed order — the canonical wireframe
 *  enumeration both hosts and the canonical SVG writer use). */
export function boxEdges(box: BBox3D): readonly (readonly [Vec3, Vec3])[] {
  const c: Vec3[] = [];
  for (const sz of [box.minZ, box.maxZ]) {
    for (const sy of [box.minY, box.maxY]) {
      for (const sx of [box.minX, box.maxX]) {
        c.push([sx, sy, sz]);
      }
    }
  }
  // Corner order: (min,min,min),(max,min,min),(min,max,min),(max,max,min),
  // then the same four at maxZ (indices 0..3 bottom, 4..7 top).
  const pairs: Array<readonly [Vec3, Vec3]> = [
    [c[0]!, c[1]!], [c[1]!, c[3]!], [c[3]!, c[2]!], [c[2]!, c[0]!],
    [c[4]!, c[5]!], [c[5]!, c[7]!], [c[7]!, c[6]!], [c[6]!, c[4]!],
    [c[0]!, c[4]!], [c[1]!, c[5]!], [c[2]!, c[6]!], [c[3]!, c[7]!],
  ];
  return pairs;
}
