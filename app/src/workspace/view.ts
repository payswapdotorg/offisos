// COMPAT-CAD-006 (Issue #138): the ONE shared, explicit, deterministic
// screen↔world view-transform contract for the Model viewport — the single
// module Web AND Electron construct their transforms through, for every pick
// and render path (LOCK-004/017/018).
//
// CONTRACT
// - A ViewTransform is the pure value { pan, zoom, viewport }:
//     pan      — the world coordinate at the viewport's bottom-left screen
//                corner (the Y axis points UP in world space, DOWN on
//                screen — the canvas/SVG flip is encoded exactly once here);
//     zoom     — device pixels per world unit;
//     viewport — the device pixel size of the viewport (w × h).
// - toScreen/toWorld are exact inverse functions of one another for every
//   finite input (round-trip is asserted by test within 1e-9).
// - Every navigation transform (zoom window, zoom scale, zoom about point,
//   pan, fit-extents) is a PURE function ViewTransform → ViewTransform: the
//   same inputs always produce the same outputs, on every host.
// - View state is PRESENTATION state: nothing here touches CADDocument
//   entities, version or undo history. The presentation-only persistence
//   path is the host's existing drafting.setSettings { view } patch
//   (non-versioned by the document contract).
//
// CLIPPING (the DEF-004 root discipline)
// - clipSegment is the Liang–Barsky viewport clip of one world segment; it
//   returns null when NO part is visible and the clipped endpoints when part
//   is. Pre-clipping segments before rasterization bounds every screen
//   coordinate to the viewport (huge/real-scale world coordinates can never
//   degrade raster precision) and gives the render loops a deterministic
//   partial-clip fast path instead of relying on implicit host clipping.
// - rectsIntersect is the bbox gate for entity-level culling (skip fully
//   off-screen entities) — the caller expands the visible rect by a device-px
//   margin first so stroke widths/dashes near the edge are never culled.
//
// Determinism: no Date, no randomness, no host globals. Identical inputs →
// identical outputs, both hosts, every pick/render path.

import type { Vec2 } from "../drafting/precision.js";

/** Axis-aligned world rectangle (min/max inclusive). */
export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Device pixel size of a viewport. */
export interface ViewportSize {
  readonly w: number;
  readonly h: number;
}

/** The one shared view transform value (see the module contract). */
export interface ViewTransform {
  readonly pan: { readonly x: number; readonly y: number };
  readonly zoom: number;
  readonly viewport: ViewportSize;
}

/** Declared zoom limits (device px per world unit) per host viewport model:
 *  the Web canvas measures live CSS pixels; the Desktop (Electron) viewport
 *  is the fixed 900×620 SVG user space. Different px-per-unit scales need
 *  different numeric clamps for the same world-span sanity bounds. These
 *  govern the INTERACTIVE wheel zoom (the shipped policy). */
export const WEB_ZOOM_LIMITS: Readonly<{ min: number; max: number }> = { min: 0.5, max: 400 };
export const DESKTOP_ZOOM_LIMITS: Readonly<{ min: number; max: number }> = { min: 0.005, max: 20 };

/** Guard bounds for COMMAND-driven scale zooms (ZOOM S): effectively
 *  unbounded for practical drawings — 1e-6 px/unit shows a ~1e9-unit span,
 *  1e6 px/unit is a sub-pixel world. They only reject degenerate extremes;
 *  the user-specified factor is otherwise honored exactly (a real-scale
 *  view at zoom 0.02 must be able to double, not jump to the wheel's
 *  interactive floor). */
export const SCALE_ZOOM_LIMITS: Readonly<{ min: number; max: number }> = { min: 1e-6, max: 1e6 };

/** The device-px margin the cull gate expands the visible rect by (covers
 *  every stroke width this build renders: lineweight display caps at 12 px,
 *  selection boost ~3.6 px, hover emphasis ~2.5 px, dash caps — 16 px is the
 *  conservative band so an edge stroke is never culled). */
export const CULL_MARGIN_PX = 16;

/** Clamp a zoom into the declared limits (pure). */
export function clampZoom(z: number, limits: Readonly<{ min: number; max: number }>): number {
  if (!Number.isFinite(z)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, z));
}

/** World → device screen. The Y axis flips (world up, screen down) exactly
 *  once, here. Deterministic inverse of toWorld. */
export function toScreen(vt: ViewTransform, p: Vec2): [number, number] {
  return [(p[0] - vt.pan.x) * vt.zoom, vt.viewport.h - (p[1] - vt.pan.y) * vt.zoom];
}

/** Device screen → world. Deterministic inverse of toScreen. */
export function toWorld(vt: ViewTransform, sx: number, sy: number): Vec2 {
  return [sx / vt.zoom + vt.pan.x, (vt.viewport.h - sy) / vt.zoom + vt.pan.y];
}

/** Build a ViewTransform from host state (pan world coords, zoom px/unit,
 *  viewport device size). */
export function viewTransformOf(
  pan: { x: number; y: number },
  zoom: number,
  viewport: ViewportSize,
): ViewTransform {
  return { pan: { x: pan.x, y: pan.y }, zoom, viewport };
}

/** The world rectangle currently visible (screen 0..w, 0..h). */
export function visibleWorldRect(vt: ViewTransform): WorldRect {
  return {
    minX: vt.pan.x,
    minY: vt.pan.y,
    maxX: vt.pan.x + vt.viewport.w / vt.zoom,
    maxY: vt.pan.y + vt.viewport.h / vt.zoom,
  };
}

/** Expand a world rect by a device-px margin under the transform (the cull
 *  gate's safety band so edge strokes never cull). */
export function expandRect(rect: WorldRect, marginPx: number, zoom: number): WorldRect {
  const m = marginPx / zoom;
  return { minX: rect.minX - m, minY: rect.minY - m, maxX: rect.maxX + m, maxY: rect.maxY + m };
}

/** True when the two world rects share at least one point (touching counts
 *  — the margin expansion makes the gate conservative). */
export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Liang–Barsky clip of the world segment a→b to `rect`. Returns the clipped
 *  endpoints (both on the rect boundary when the segment crosses out) or
 *  null when no part is visible. Exact, deterministic, allocation-light. */
export function clipSegment(rect: WorldRect, a: Vec2, b: Vec2): readonly [Vec2, Vec2] | null {
  let tMin = 0;
  let tMax = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // [p, q] pairs: p = -dx (left), dx (right), -dy (bottom), dy (top).
  const edges: readonly (readonly [number, number])[] = [
    [-dx, a[0] - rect.minX],
    [dx, rect.maxX - a[0]],
    [-dy, a[1] - rect.minY],
    [dy, rect.maxY - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel and outside this edge
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > tMax) return null;
      if (t > tMin) tMin = t;
    } else {
      if (t < tMin) return null;
      if (t < tMax) tMax = t;
    }
  }
  // Degenerate zero-length segment: visible iff the point is inside.
  if (tMax < tMin) return null;
  const clampedA: Vec2 = [a[0] + dx * tMin, a[1] + dy * tMin];
  const clampedB: Vec2 = [a[0] + dx * tMax, a[1] + dy * tMax];
  return [clampedA, clampedB];
}

/** Zoom about a world anchor point: the anchor stays at the SAME screen
 *  position after the zoom (the wheel-zoom / real-time-zoom invariant).
 *  Pure; the zoom is clamped to the declared limits. */
export function zoomAboutPoint(
  vt: ViewTransform,
  factor: number,
  worldPoint: Vec2,
  limits: Readonly<{ min: number; max: number }>,
): ViewTransform {
  const z = clampZoom(vt.zoom * factor, limits);
  // Keep (p - pan) * zoom invariant in x; (p - pan) * zoom invariant in y
  // (through the flip): pan' = p - (p - pan) * zoom / z'.
  const keepX = (worldPoint[0] - vt.pan.x) * vt.zoom / z;
  const keepY = (worldPoint[1] - vt.pan.y) * vt.zoom / z;
  return { pan: { x: worldPoint[0] - keepX, y: worldPoint[1] - keepY }, zoom: z, viewport: vt.viewport };
}

/** Zoom by a factor about the viewport CENTER (ZOOM Scale nX mode). Pure. */
export function zoomScaleAboutCenter(
  vt: ViewTransform,
  factor: number,
  limits: Readonly<{ min: number; max: number }>,
): ViewTransform {
  const center: Vec2 = toWorld(vt, vt.viewport.w / 2, vt.viewport.h / 2);
  return zoomAboutPoint(vt, factor, center, limits);
}

/** Window zoom: fit the world rect spanned by the two corners into the
 *  viewport (aspect-preserving, the window's min corner at the viewport's
 *  bottom-left). Returns null for a degenerate (empty) window — the caller
 *  echoes the honest typed failure. `limits` is OPTIONAL: the explicit
 *  window target is honored exactly (like the fit — a real-scale window
 *  zooms to whatever it needs); the interactive zooms pass the declared
 *  limits. Pure. */
export function zoomWindow(
  vt: ViewTransform,
  corner1: Vec2,
  corner2: Vec2,
  limits?: Readonly<{ min: number; max: number }>,
): ViewTransform | null {
  const minX = Math.min(corner1[0], corner2[0]);
  const minY = Math.min(corner1[1], corner2[1]);
  const maxX = Math.max(corner1[0], corner2[0]);
  const maxY = Math.max(corner1[1], corner2[1]);
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return null;
  const z = limits === undefined ? Math.min(vt.viewport.w / w, vt.viewport.h / h) : clampZoom(Math.min(vt.viewport.w / w, vt.viewport.h / h), limits);
  return { pan: { x: minX, y: minY }, zoom: z, viewport: vt.viewport };
}

/** Pan by a world-space delta (pure). */
export function panBy(vt: ViewTransform, delta: Vec2): ViewTransform {
  return { pan: { x: vt.pan.x + delta[0], y: vt.pan.y + delta[1] }, zoom: vt.zoom, viewport: vt.viewport };
}

/** The reference "fit" zoom for content bounds (device px per world unit,
 *  aspect-preserving over the viewport, with the declared world-unit padding
 *  on every side) — the ZOOM Scale plain-number ("n", non-X) reference and
 *  the fit-extents zoom computation. Pure. */
export function fitZoomOf(
  viewport: ViewportSize,
  bounds: WorldRect,
  padWorld: number,
): number {
  const spanX = Math.max(bounds.maxX - bounds.minX + padWorld * 2, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY + padWorld * 2, 1);
  return Math.min(viewport.w / spanX, viewport.h / spanY);
}

/** Fit the content bounds into the viewport (the ZOOMEXTENTS transform —
 *  byte-exact extraction of the shipped fit formula: pad on every side,
 *  aspect-preserving zoom, centered in the slack axis). Pure. */
export function fitExtents(
  viewport: ViewportSize,
  bounds: WorldRect,
  padWorld: number,
  limits?: Readonly<{ min: number; max: number }>,
): ViewTransform {
  const spanX = Math.max(bounds.maxX - bounds.minX + padWorld * 2, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY + padWorld * 2, 1);
  const z = limits === undefined ? Math.min(viewport.w / spanX, viewport.h / spanY) : clampZoom(Math.min(viewport.w / spanX, viewport.h / spanY), limits);
  // Center the bounds in the slack axis (the shipped ZOOMEXTENTS centering).
  const panX = bounds.minX - padWorld - (viewport.w / z - spanX) / 2;
  const panY = bounds.minY - padWorld - (viewport.h / z - spanY) / 2;
  return { pan: { x: panX, y: panY }, zoom: z, viewport };
}

/** COMPAT-CAD-006: ONE navigation request vocabulary shared by both hosts —
 *  the ui-action payloads the ZOOM/PAN/REGEN command builders emit and both
 *  host shells translate into ViewTransform applications. Host-agnostic by
 *  construction (the same request produces the same transform on Web and
 *  Desktop through the functions above). */
export type ViewNavigationRequest =
  | { readonly kind: "zoomExtents" }
  | { readonly kind: "zoomWindow"; readonly corner1: Vec2; readonly corner2: Vec2 }
  | { readonly kind: "zoomScale"; readonly factor: number; readonly relative: boolean }
  | { readonly kind: "pan"; readonly delta: Vec2 }
  | { readonly kind: "zoomPrevious" }
  | { readonly kind: "regen" };

/** One navigation request + its monotonic sequence number (the host hands
 *  this to the view-owning component; the seq drives the effect). */
export interface ViewNavigation {
  readonly seq: number;
  readonly request: ViewNavigationRequest;
}
