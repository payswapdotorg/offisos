/**
 * CAD-PARITY-008 model↔paper transform (Issue #88) — the ONE deterministic
 * viewport projection shared by the paper canvas, the plot preview, the
 * Sheet/Plot IR builder and BOTH export writers (LOCK-004 parity by
 * construction: there is exactly ONE transform implementation).
 *
 *   paper = vpCenter + R(rotation) · ((model − camera) / denominator)
 *   model = camera  + R(−rotation) · ((paper − vpCenter) · denominator)
 *
 * `scaleDenominator` is model units per paper mm (50 for 1:50); the
 * rotation is the viewport view twist in degrees CCW. Rectangular clipping
 * to the viewport rectangle is the bounded slice's declared limit
 * (no polygonal viewports — Issue #88 non-goal).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { ViewportRecord } from "../../contracts/caddocument.js";

/** A paper-space point (sheet mm, y-up from the sheet's lower-left). */
export interface PaperPt {
  readonly x: number;
  readonly y: number;
}

/** The normalized paper rectangle of a viewport (x1≤x2, y1≤y2). */
export interface ViewportRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Normalize the viewport corners into a canonical rect. */
export function viewportRect(vp: ViewportRecord): ViewportRect {
  const x1 = Math.min(vp.corner1[0], vp.corner2[0]);
  const x2 = Math.max(vp.corner1[0], vp.corner2[0]);
  const y1 = Math.min(vp.corner1[1], vp.corner2[1]);
  const y2 = Math.max(vp.corner1[1], vp.corner2[1]);
  return { x1, y1, x2, y2 };
}

/** The rect center (where the viewport camera maps). */
export function viewportCenter(rect: ViewportRect): PaperPt {
  return { x: (rect.x1 + rect.x2) / 2, y: (rect.y1 + rect.y2) / 2 };
}

function rot(p: PaperPt, radians: number): PaperPt {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** The model→paper projection of one point through one viewport. */
export function modelToPaper(vp: ViewportRecord, rect: ViewportRect, p: PaperPt): PaperPt {
  const center = viewportCenter(rect);
  const theta = (vp.rotationDeg * Math.PI) / 180;
  const d = rot({ x: (p.x - vp.camera.centerX) / vp.scaleDenominator, y: (p.y - vp.camera.centerY) / vp.scaleDenominator }, theta);
  return { x: center.x + d.x, y: center.y + d.y };
}

/** The paper→model inverse projection (pick-through-the-viewport). */
export function paperToModel(vp: ViewportRecord, rect: ViewportRect, q: PaperPt): PaperPt {
  const center = viewportCenter(rect);
  const theta = (-vp.rotationDeg * Math.PI) / 180;
  const d = rot({ x: q.x - center.x, y: q.y - center.y }, theta);
  return {
    x: vp.camera.centerX + d.x * vp.scaleDenominator,
    y: vp.camera.centerY + d.y * vp.scaleDenominator,
  };
}

/** Point-in-rect (closed boundaries). */
export function rectContains(rect: ViewportRect, p: PaperPt): boolean {
  return p.x >= rect.x1 && p.x <= rect.x2 && p.y >= rect.y1 && p.y <= rect.y2;
}

/** Rect intersection (null when disjoint). */
export function rectIntersect(a: ViewportRect, b: ViewportRect): ViewportRect | null {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

/** Liang–Barsky segment clip against an axis-aligned rect (the drafting
 *  core's clipInfinite precedent). Returns the clipped endpoints or null
 *  when the segment misses the rect entirely. */
export function clipSegment(
  rect: ViewportRect,
  a: PaperPt,
  b: PaperPt,
): { readonly a: PaperPt; readonly b: PaperPt } | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, a.x - rect.x1)) return null;
  if (!clip(dx, rect.x2 - a.x)) return null;
  if (!clip(-dy, a.y - rect.y1)) return null;
  if (!clip(dy, rect.y2 - a.y)) return null;
  return {
    a: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    b: { x: a.x + t1 * dx, y: a.y + t1 * dy },
  };
}

/** Does a circle/arc/ellipse's bounding box intersect the rect (the coarse
 *  include gate; the writers apply EXACT native clipping — an SVG clipPath,
 *  a PDF `re W n` clip, a canvas ctx.clip() — so the IR keeps exact curve
 *  geometry and never rasterizes)? */
export function bboxIntersectsRect(
  rect: ViewportRect,
  bbox: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
): boolean {
  return bbox.x2 >= rect.x1 && bbox.x1 <= rect.x2 && bbox.y2 >= rect.y1 && bbox.y1 <= rect.y2;
}

/** The world bounding box of the drafting/annotation model content (model
 *  units) — the deterministic extents the MVIEW "Fit" view computes from
 *  (empty model → the canonical empty extents {0,0,0,0}). */
export interface ModelExtents {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly empty: boolean;
}

export const EMPTY_MODEL_EXTENTS: ModelExtents = { minX: 0, minY: 0, maxX: 0, maxY: 0, empty: true };

/** Compute the view parameters that FIT a model extents rectangle into a
 *  viewport paper rectangle (camera = the extents center; denominator = the
 *  max axis ratio so the whole window shows). The empty model fits at the
 *  canonical 1:1 around the origin. */
export function fitViewToRect(
  extents: ModelExtents,
  rect: ViewportRect,
): { readonly centerX: number; readonly centerY: number; readonly scaleDenominator: number } {
  if (extents.empty) {
    return { centerX: 0, centerY: 0, scaleDenominator: 1 };
  }
  const w = Math.max(extents.maxX - extents.minX, 1e-9);
  const h = Math.max(extents.maxY - extents.minY, 1e-9);
  const vpW = Math.max(rect.x2 - rect.x1, 1e-9);
  const vpH = Math.max(rect.y2 - rect.y1, 1e-9);
  return {
    centerX: (extents.minX + extents.maxX) / 2,
    centerY: (extents.minY + extents.maxY) / 2,
    scaleDenominator: Math.max(w / vpW, h / vpH),
  };
}

/** Compute the view parameters that map a model WINDOW rectangle into a
 *  viewport paper rectangle (camera = the window center; denominator = the
 *  max axis ratio — the MVIEW "Window" mode). */
export function windowViewToRect(
  window: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  rect: ViewportRect,
): { readonly centerX: number; readonly centerY: number; readonly scaleDenominator: number } {
  const w = Math.max(window.x2 - window.x1, 1e-9);
  const h = Math.max(window.y2 - window.y1, 1e-9);
  const vpW = Math.max(rect.x2 - rect.x1, 1e-9);
  const vpH = Math.max(rect.y2 - rect.y1, 1e-9);
  return {
    centerX: (window.x1 + window.x2) / 2,
    centerY: (window.y1 + window.y2) / 2,
    scaleDenominator: Math.max(w / vpW, h / vpH),
  };
}

/** Format a viewport scale as the AutoCAD-class "1:N" ratio. */
export function formatViewportScale(vp: ViewportRecord): string {
  return `1:${vp.scaleDenominator}`;
}

/** Distance from a point to a rect's EDGES (viewport frame hit-testing:
 *  clicking ON the border selects the viewport — the frame, not the
 *  content). */
export function distanceToRectEdges(rect: ViewportRect, p: PaperPt): number {
  const cx = Math.min(Math.max(p.x, rect.x1), rect.x2);
  const cy = Math.min(Math.max(p.y, rect.y1), rect.y2);
  if (cx === p.x && cy === p.y) {
    // Inside: distance to the nearest edge.
    return Math.min(p.x - rect.x1, rect.x2 - p.x, p.y - rect.y1, rect.y2 - p.y);
  }
  return Math.hypot(p.x - cx, p.y - cy);
}
