/**
 * CAD-PARITY-005 annotation picking (Issue #82) — deterministic hit-testing
 * over the annotation render primitives.
 *
 * The pick surface IS the render surface: an annotation is pickable where
 * it paints (segments within the aperture, arrowheads within the aperture,
 * text inside its deterministic metrics box). Because both derive from the
 * SAME primitives (annotation/render.ts), the Web and Electron hosts pick
 * identically (LOCK-004) and the visible surface and the pick surface can
 * never disagree.
 *
 * Text hit boxes use the documented deterministic metrics convention
 * (glyph cell 0.6 × height × widthFactor, line pitch 1.2 × height) — a
 * conservative box around the text run, host-font independent.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import { closestOnSegment, dist, Pt, rotatePt } from "../geometry/math2d.js";
import type { Element } from "../../contracts/caddocument.js";
import { annotationFromElement } from "./types.js";
import {
  annotationPrimitives,
  AnnotationStyleContext,
  RenderPrimitive,
  textWidth,
} from "./render.js";

export interface AnnotationPick {
  readonly id: string;
  /** Distance from the cursor to the picked geometry (mm). */
  readonly d: number;
}

/** Closest distance from `cursor` to one annotation's primitives. */
export function annotationPickDistance(
  primitives: readonly RenderPrimitive[],
  cursor: Pt,
): number | null {
  let best: number | null = null;
  for (const p of primitives) {
    let d: number | null = null;
    if (p.kind === "segment") {
      const r = closestOnSegment(cursor, p.a, p.b);
      d = r.d;
    } else if (p.kind === "arrow") {
      d = dist(cursor, p.at);
    } else {
      d = textBoxDistance(p, cursor);
    }
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/** The deterministic text hit box (axis-aligned in the text's local frame,
 *  then rotated). */
export function textBoxOf(
  p: Extract<RenderPrimitive, { kind: "text" }>,
): { readonly center: Pt; readonly halfW: number; readonly halfH: number; readonly rotation: number } {
  const w = textWidth(p.value, p.height, p.widthFactor);
  // Vertical extent per alignment (the deterministic descender convention:
  // the glyph box spans height above the baseline + 0.25 × height below).
  const desc = p.height * 0.25;
  let halfH: number;
  let cyOff: number;
  switch (p.vAlign) {
    case "baseline":
    case "bottom":
      // Box [at − desc, at + height]: center (height − desc)/2 above `at`.
      halfH = (p.height + desc) / 2;
      cyOff = (p.height - desc) / 2;
      break;
    case "middle":
      halfH = p.height / 2;
      cyOff = 0;
      break;
    case "top":
      // Box [at − (height + desc), at].
      halfH = (p.height + desc) / 2;
      cyOff = -(p.height + desc) / 2;
      break;
  }
  let cxOff: number;
  switch (p.hAlign) {
    case "left":
      cxOff = w / 2;
      break;
    case "center":
      cxOff = 0;
      break;
    case "right":
      cxOff = -w / 2;
      break;
  }
  const cos = Math.cos(p.rotation);
  const sin = Math.sin(p.rotation);
  const center: Pt = {
    x: p.at.x + cxOff * cos - cyOff * sin,
    y: p.at.y + cxOff * sin + cyOff * cos,
  };
  return { center, halfW: w / 2, halfH, rotation: p.rotation };
}

function textBoxDistance(
  p: Extract<RenderPrimitive, { kind: "text" }>,
  cursor: Pt,
): number {
  const box = textBoxOf(p);
  // Transform the cursor into the text's local frame.
  const local = rotatePt(cursor, box.center, -box.rotation);
  const dx = Math.max(Math.abs(local.x - box.center.x) - box.halfW, 0);
  const dy = Math.max(Math.abs(local.y - box.center.y) - box.halfH, 0);
  return Math.hypot(dx, dy);
}

/** Pick the closest annotation at the cursor. Returns the element id and
 *  distance, or null. Mirrors precision-2d's pickAt semantics (aperture
 *  in world mm; closest wins; ties break by element id for determinism). */
export function pickAnnotationAt(
  elements: readonly Element[],
  cursor: Pt,
  aperture: number,
  styleCtx: AnnotationStyleContext,
): AnnotationPick | null {
  let best: AnnotationPick | null = null;
  for (const el of elements) {
    const a = annotationFromElement(el);
    if (a === null) continue;
    const primitives = annotationPrimitives(a, styleCtx);
    const d = annotationPickDistance(primitives, cursor);
    if (d === null) continue;
    if (d <= aperture && (best === null || d < best.d - 1e-12 || (Math.abs(d - best.d) <= 1e-12 && el.id < best.id))) {
      best = { id: el.id, d };
    }
  }
  return best;
}

/** Window/crossing selection over annotation hit boxes: window mode needs
 *  the whole primitive set's bounding box inside the rect; crossing needs
 *  any primitive point inside. Deterministic, same semantics as
 *  precision-2d's selectWindow. */
export function selectAnnotations(
  elements: readonly Element[],
  sel: { readonly mode: "window" | "crossing"; readonly min: Pt; readonly max: Pt },
  styleCtx: AnnotationStyleContext,
): string[] {
  const out: string[] = [];
  for (const el of elements) {
    const a = annotationFromElement(el);
    if (a === null) continue;
    const primitives = annotationPrimitives(a, styleCtx);
    if (sel.mode === "window") {
      // All primitive geometry inside the rect.
      let inside = primitives.length > 0;
      for (const p of primitives) {
        if (!primitiveInsideRect(p, sel)) {
          inside = false;
          break;
        }
      }
      if (inside) out.push(el.id);
    } else {
      for (const p of primitives) {
        if (primitiveIntersectsRect(p, sel)) {
          out.push(el.id);
          break;
        }
      }
    }
  }
  return out;
}

function rectContains(sel: { readonly min: Pt; readonly max: Pt }, p: Pt): boolean {
  return (
    p.x >= sel.min.x - 1e-9 && p.x <= sel.max.x + 1e-9 &&
    p.y >= sel.min.y - 1e-9 && p.y <= sel.max.y + 1e-9
  );
}

function primitiveInsideRect(
  p: RenderPrimitive,
  sel: { readonly min: Pt; readonly max: Pt },
): boolean {
  if (p.kind === "segment") return rectContains(sel, p.a) && rectContains(sel, p.b);
  if (p.kind === "arrow") return rectContains(sel, p.at);
  // Text: all four box corners inside.
  const box = textBoxOf(p);
  const corners: Pt[] = [
    { x: -box.halfW, y: -box.halfH },
    { x: box.halfW, y: -box.halfH },
    { x: box.halfW, y: box.halfH },
    { x: -box.halfW, y: box.halfH },
  ].map((c) => rotatePt({ x: box.center.x + c.x, y: box.center.y + c.y }, box.center, box.rotation));
  return corners.every((c) => rectContains(sel, c));
}

function primitiveIntersectsRect(
  p: RenderPrimitive,
  sel: { readonly min: Pt; readonly max: Pt },
): boolean {
  if (p.kind === "segment") {
    // Conservative: either endpoint inside, or the segment crosses any
    // rect edge (segment-segment test).
    if (rectContains(sel, p.a) || rectContains(sel, p.b)) return true;
    const edges: readonly [Pt, Pt][] = [
      [sel.min, { x: sel.max.x, y: sel.min.y }],
      [{ x: sel.max.x, y: sel.min.y }, sel.max],
      [sel.max, { x: sel.min.x, y: sel.max.y }],
      [{ x: sel.min.x, y: sel.max.y }, sel.min],
    ];
    for (const [e1, e2] of edges) {
      if (segmentsIntersect(p.a, p.b, e1, e2)) return true;
    }
    return false;
  }
  if (p.kind === "arrow") return rectContains(sel, p.at);
  // Text: any box corner inside, or (conservative) the box center inside
  // the rect / the rect center inside the box.
  const box = textBoxOf(p);
  const corners: Pt[] = [
    { x: -box.halfW, y: -box.halfH },
    { x: box.halfW, y: -box.halfH },
    { x: box.halfW, y: box.halfH },
    { x: -box.halfW, y: box.halfH },
  ].map((c) => rotatePt({ x: box.center.x + c.x, y: box.center.y + c.y }, box.center, box.rotation));
  if (corners.some((c) => rectContains(sel, c))) return true;
  return rectContains(
    { min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) }, max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) } },
    { x: (sel.min.x + sel.max.x) / 2, y: (sel.min.y + sel.max.y) / 2 },
  );
}

function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
