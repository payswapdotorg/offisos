/**
 * COMPAT-CAD-010 (Issue #18) — deterministic hatch hit-testing over the
 * hatch render primitives.
 *
 * The pick surface IS the render surface (the CAD-PARITY-005 annotation
 * convention): a hatch is pickable where it paints AND anywhere strictly
 * inside its boundary region (AutoCAD-class: clicking the filled area
 * selects the hatch — the inside test is exact even-odd over the STORED
 * loops, so SOLID hatches with no strokes are fully pickable). Distance 0
 * inside the region; otherwise the closest pattern stroke/dot distance.
 * Web and Electron pick identically (LOCK-004).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import { closestOnSegment, dist, segmentSegment, Pt } from "../geometry/math2d.js";
import type { Element } from "../../contracts/caddocument.js";
import { hatchFromElement } from "./types.js";
import { hatchPrimitives, pointInRegion, type HatchRenderContext } from "./render.js";

export interface HatchPick {
  readonly id: string;
  /** Distance from the cursor to the hatch (0 inside the region). */
  readonly d: number;
}

/** The hatch pick at `cursor` (exact inside-region test + primitive
 *  distances), or null when nothing is within the aperture. */
export function pickHatchAt(
  elements: readonly Element[],
  cursor: Pt,
  aperture: number,
  ctx: HatchRenderContext,
): HatchPick | null {
  let best: HatchPick | null = null;
  for (const el of elements) {
    const h = hatchFromElement(el);
    if (h === null) continue;
    const loops = h.boundary.map((ref) => ref.loop);
    let d: number | null = null;
    if (pointInRegion(cursor, loops)) {
      d = 0;
    } else {
      const primitives = hatchPrimitives(h, ctx);
      let bestD: number | null = null;
      for (const p of primitives) {
        let pd: number | null = null;
        if (p.kind === "segment") {
          pd = closestOnSegment(cursor, p.a, p.b).d;
        } else if (p.kind === "dot") {
          pd = dist(cursor, p.at);
        }
        if (pd !== null && (bestD === null || pd < bestD)) bestD = pd;
      }
      d = bestD;
    }
    if (d === null) continue;
    if (d <= aperture && (best === null || d < best.d - 1e-12 || (Math.abs(d - best.d) <= 1e-12 && el.id < best.id))) {
      best = { id: el.id, d };
    }
  }
  return best;
}

/** Window/crossing selection over hatches: window mode needs the whole
 *  region bbox inside the rect; crossing needs any pick surface (or the
 *  region interior) to intersect the rect. Deterministic. */
export function selectHatches(
  elements: readonly Element[],
  sel: { readonly mode: "window" | "crossing"; readonly min: Pt; readonly max: Pt },
  ctx: HatchRenderContext,
): string[] {
  const out: string[] = [];
  for (const el of elements) {
    const h = hatchFromElement(el);
    if (h === null) continue;
    const loops = h.boundary.map((ref) => ref.loop);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const loop of loops) {
      if (loop.kind === "polygon") {
        for (const p of loop.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      } else {
        minX = Math.min(minX, loop.center.x - loop.radius);
        minY = Math.min(minY, loop.center.y - loop.radius);
        maxX = Math.max(maxX, loop.center.x + loop.radius);
        maxY = Math.max(maxY, loop.center.y + loop.radius);
      }
    }
    if (sel.mode === "window") {
      if (minX >= sel.min.x && minY >= sel.min.y && maxX <= sel.max.x && maxY <= sel.max.y) out.push(el.id);
    } else {
      // Crossing: the rect intersects the REGION (exact tests — the
      // deterministic crossing contract: any rect corner inside the region,
      // any region anchor inside the rect, a loop edge crossing a rect
      // edge, a circle overlapping the rect, or any stroke/dot point
      // inside the rect).
      const overlaps = minX <= sel.max.x && maxX >= sel.min.x && minY <= sel.max.y && maxY >= sel.min.y;
      if (!overlaps) continue;
      let hit = false;
      const rectCorners = [sel.min, { x: sel.max.x, y: sel.min.y }, sel.max, { x: sel.min.x, y: sel.max.y }];
      // Rect corners inside the region?
      for (const c of rectCorners) {
        if (pointInRegion(c, loops)) {
          hit = true;
          break;
        }
      }
      // Exact loop↔rect intersection tests.
      if (!hit) {
        const rectEdges: [Pt, Pt][] = [
          [sel.min, { x: sel.max.x, y: sel.min.y }],
          [{ x: sel.max.x, y: sel.min.y }, sel.max],
          [sel.max, { x: sel.min.x, y: sel.max.y }],
          [{ x: sel.min.x, y: sel.max.y }, sel.min],
        ];
        for (const loop of loops) {
          if (loop.kind === "circle") {
            // Closest rect point to the circle center inside the radius.
            const cx = Math.max(sel.min.x, Math.min(loop.center.x, sel.max.x));
            const cy = Math.max(sel.min.y, Math.min(loop.center.y, sel.max.y));
            if (dist({ x: cx, y: cy }, loop.center) < loop.radius) {
              hit = true;
              break;
            }
            continue;
          }
          const pts = loop.points;
          const n = pts.length;
          for (let i = 0; i < n; i++) {
            const a = pts[i]!;
            const b = pts[(i + 1) % n]!;
            // A polygon vertex inside the rect?
            if (a.x >= sel.min.x && a.x <= sel.max.x && a.y >= sel.min.y && a.y <= sel.max.y) {
              hit = true;
              break;
            }
            // A polygon edge crossing a rect edge?
            for (const [r1, r2] of rectEdges) {
              if (segmentSegment(a, b, r1, r2) !== null) {
                hit = true;
                break;
              }
            }
            if (hit) break;
          }
          if (hit) break;
        }
      }
      if (!hit) {
        // Any stroke endpoint or dot inside the rect (SOLID hatches with
        // no strokes are covered by the region tests above).
        for (const p of hatchPrimitives(h, ctx)) {
          if (p.kind === "segment") {
            for (const e of [p.a, p.b]) {
              if (e.x >= sel.min.x && e.x <= sel.max.x && e.y >= sel.min.y && e.y <= sel.max.y) {
                hit = true;
                break;
              }
            }
          } else if (p.kind === "dot") {
            if (p.at.x >= sel.min.x && p.at.x <= sel.max.x && p.at.y >= sel.min.y && p.at.y <= sel.max.y) hit = true;
          }
          if (hit) break;
        }
      }
      if (hit) out.push(el.id);
    }
  }
  return out;
}
