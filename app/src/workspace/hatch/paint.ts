/**
 * COMPAT-CAD-010 (Issue #18) — the SHARED canvas-2d painter for hatch
 * render primitives.
 *
 * Both hosts (Web model-canvas + Electron professional canvas) paint the
 * hatch render primitives (hatch/render.ts) through THIS module: identical
 * pattern strokes, dots and solid fills on every host (LOCK-004 parity by
 * construction — exactly ONE painter, the CAD-PARITY-005 annotation
 * precedent).
 *
 * Host-supplied: the CanvasRenderingContext2D, the world→screen transform,
 * the zoom (px per world mm), the stroke color and alpha. Everything else
 * comes from the deterministic primitives — the painter adds NO policy.
 * The solid fill uses the even-odd rule so island loops XOR exactly like
 * the semantic region (render == semantics, never a second opinion).
 *
 * Engine-free, host-neutral (uses only the HTML Canvas 2D API available in
 * every renderer; LOCK-003/018 — no engine, no Node, no DOM queries).
 */

import type { Pt } from "../geometry/math2d.js";
import type { Canvas2DContext } from "../annotation/paint.js";
import type { HatchPrimitive } from "./render.js";

/** The structural canvas slice the hatch painter needs (the annotation
 *  painter's interface + arc and the fill-rule overload — every host's
 *  real CanvasRenderingContext2D satisfies this shape structurally). */
export interface HatchCanvas2DContext extends Canvas2DContext {
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(fillRule?: "nonzero" | "evenodd"): void;
}

export interface HatchPaintOptions {
  /** World→screen point transform. */
  readonly toScreen: (p: Pt) => [number, number];
  /** Device px per world mm (dot device sizing). */
  readonly zoom: number;
  /** Stroke color (the resolved entity/layer color). */
  readonly color: string;
  /** Stroke width in device px (the resolved lineweight). */
  readonly weightPx: number;
  /** Alpha multiplier (transparency/locked fade), 0–1. */
  readonly alpha: number;
}

/** Paint one hatch's primitives. Pure w.r.t. the canvas state: saves and
 *  restores alpha around the group; line dash left solid (pattern strokes
 *  ARE the dash semantics — a dashed hatch stroke would double-encode). */
export function paintHatchPrimitives(
  ctx: HatchCanvas2DContext,
  primitives: readonly HatchPrimitive[],
  opts: HatchPaintOptions,
): void {
  const prevAlpha = ctx.globalAlpha;
  const alpha = Math.max(0, Math.min(1, opts.alpha));
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
  try {
    for (const p of primitives) {
      if (p.kind === "segment") {
        const a = opts.toScreen(p.a);
        const b = opts.toScreen(p.b);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.strokeStyle = opts.color;
        ctx.lineWidth = opts.weightPx;
        ctx.setLineDash([]);
        ctx.stroke();
      } else if (p.kind === "dot") {
        const at = opts.toScreen(p.at);
        const r = Math.max(0.75, p.radius * opts.zoom);
        ctx.beginPath();
        ctx.arc(at[0], at[1], r, 0, Math.PI * 2);
        ctx.fillStyle = opts.color;
        ctx.setLineDash([]);
        ctx.fill();
      } else {
        // Solid fill: ONE path over every loop, even-odd (island XOR —
        // the same semantics as the pick region).
        ctx.beginPath();
        for (const loop of p.loops) {
          if (loop.kind === "polygon") {
            const first = opts.toScreen(loop.points[0]!);
            ctx.moveTo(first[0], first[1]);
            for (let i = 1; i < loop.points.length; i++) {
              const s = opts.toScreen(loop.points[i]!);
              ctx.lineTo(s[0], s[1]);
            }
            ctx.closePath();
          } else {
            const c = opts.toScreen(loop.center);
            const r = Math.max(0.1, loop.radius * opts.zoom);
            ctx.moveTo(c[0] + r, c[1]);
            ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
            ctx.closePath();
          }
        }
        ctx.fillStyle = opts.color;
        ctx.setLineDash([]);
        ctx.fill("evenodd");
      }
    }
  } finally {
    if (alpha < 1) ctx.globalAlpha = prevAlpha;
    ctx.setLineDash([]);
  }
}
