/**
 * CAD-PARITY-005 annotation painter (Issue #82) — the SHARED canvas-2D
 * painter for annotation render primitives.
 *
 * Both hosts (Web model-canvas + Electron professional canvas) paint the
 * annotation render primitives (annotation/render.ts) through THIS module:
 * identical strokes, arrowheads, text placement, fonts, width factors and
 * oblique skews on every host (LOCK-004 parity by construction — there is
 * exactly ONE painter).
 *
 * Host-supplied: the CanvasRenderingContext2D, the world→screen transform,
 * the zoom (px per world mm) and the stroke color. Everything else
 * (geometry, text runs, arrow styles) comes from the deterministic
 * primitives — the painter adds NO policy.
 *
 * Engine-free, host-neutral (uses only the HTML Canvas 2D API available in
 * every renderer; LOCK-003/018 — no engine, no Node, no DOM queries).
 */

import type { Pt } from "../geometry/math2d.js";
import type { RenderPrimitive } from "./render.js";

/**
 * The structural slice of the HTML Canvas 2D context the painter uses. The
 * app package compiles without the DOM lib (LOCK-018 engine-free core);
 * every host's real CanvasRenderingContext2D satisfies this shape
 * structurally, so the SAME painter runs on Web and Electron unchanged.
 */
export interface Canvas2DContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  closePath(): void;
  fill(): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: readonly number[]): void;
  fillText(text: string, x: number, y: number): void;
  /** Stroke/fill style slots. The painter only ever ASSIGNS plain strings;
   *  the wide `object` member keeps a real DOM CanvasRenderingContext2D
   *  (whose styles may be CanvasGradient | CanvasPattern) structurally
   *  assignable to this interface under the DOM lib. */
  strokeStyle: string | object | undefined;
  fillStyle: string | object | undefined;
  lineWidth: number;
  font: string;
  textAlign: "left" | "right" | "center" | "start" | "end" | undefined;
  textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom" | undefined;
  globalAlpha: number;
}

export interface AnnotationPaintOptions {
  /** World→screen point transform. */
  readonly toScreen: (p: Pt) => [number, number];
  /** Device px per world mm (text/arrow device sizing). */
  readonly zoom: number;
  /** Stroke color (the resolved entity/layer color). */
  readonly color: string;
  /** Stroke width in device px (the resolved lineweight). */
  readonly weightPx: number;
  /** Dash pattern in device px (null = solid). */
  readonly dash: readonly number[] | null;
  /** Alpha multiplier (transparency/locked fade), 0–1. */
  readonly alpha: number;
}

/** The generic font family per text-style font. Generic CSS families map
 *  deterministically on every platform (no webfont dependency). */
export const ANNOTATION_FONT_FAMILY: Readonly<Record<"sans" | "mono" | "serif", string>> = {
  sans: "sans-serif",
  mono: "monospace",
  serif: "serif",
};

/** Paint one annotation's primitives. Pure w.r.t. the canvas state: saves
 *  and restores the context around every primitive group. */
export function paintAnnotationPrimitives(
  ctx: Canvas2DContext,
  primitives: readonly RenderPrimitive[],
  opts: AnnotationPaintOptions,
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
        if (opts.dash !== null && opts.dash.length > 0) {
          ctx.setLineDash([...opts.dash]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      } else if (p.kind === "arrow") {
        paintArrow(ctx, p, opts);
      } else {
        paintText(ctx, p, opts);
      }
    }
  } finally {
    if (alpha < 1) ctx.globalAlpha = prevAlpha;
    ctx.setLineDash([]);
  }
}

function paintArrow(
  ctx: Canvas2DContext,
  p: Extract<RenderPrimitive, { kind: "arrow" }>,
  opts: AnnotationPaintOptions,
): void {
  if (p.style === "none") return;
  const tip = opts.toScreen(p.at);
  const sizePx = Math.max(2, p.size * opts.zoom);
  const dx = p.dir.x;
  const dy = p.dir.y;
  if (p.style === "tick") {
    // A short 45° tick across the direction at the tip (the architectural
    // tick: a stroke from one side to the other, rotated 45°).
    const half = sizePx * 0.6;
    const px = -dy;
    const py = dx;
    const cos45 = Math.SQRT1_2;
    const sin45 = Math.SQRT1_2;
    // Rotate the perpendicular by +45° around the direction.
    const o1x = px * cos45 - py * sin45;
    const o1y = px * sin45 + py * cos45;
    ctx.beginPath();
    ctx.moveTo(tip[0] - o1x * half, tip[1] - o1y * half);
    ctx.lineTo(tip[0] + o1x * half, tip[1] + o1y * half);
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = Math.max(1, opts.weightPx);
    ctx.setLineDash([]);
    ctx.stroke();
    return;
  }
  // closed: a filled triangle — tip at `at`, wings back along ±perp.
  const wing = sizePx * 0.35;
  const back: [number, number] = [tip[0] - dx * sizePx, tip[1] - dy * sizePx];
  const p1: [number, number] = [back[0] - dy * wing, back[1] + dx * wing];
  const p2: [number, number] = [back[0] + dy * wing, back[1] - dx * wing];
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.closePath();
  ctx.fillStyle = opts.color;
  ctx.setLineDash([]);
  ctx.fill();
}

function paintText(
  ctx: Canvas2DContext,
  p: Extract<RenderPrimitive, { kind: "text" }>,
  opts: AnnotationPaintOptions,
): void {
  const at = opts.toScreen(p.at);
  const heightPx = Math.max(1, p.height * opts.zoom);
  const family = ANNOTATION_FONT_FAMILY[p.font];
  ctx.save();
  ctx.translate(at[0], at[1]);
  // Canvas Y is down: world CCW rotation → negative screen angle.
  ctx.rotate(-p.rotation);
  // Width factor (horizontal scale) + oblique (shear along the baseline).
  const wf = p.widthFactor > 0 ? p.widthFactor : 1;
  const obliqueRad = (Math.max(-85, Math.min(85, p.oblique)) * Math.PI) / 180;
  ctx.transform(wf, 0, Math.tan(obliqueRad), 1, 0, 0);
  ctx.font = `${heightPx.toFixed(2)}px ${family}`;
  ctx.fillStyle = opts.color;
  if (p.hAlign === "center") ctx.textAlign = "center";
  else if (p.hAlign === "right") ctx.textAlign = "right";
  else ctx.textAlign = "left";
  switch (p.vAlign) {
    case "baseline":
      ctx.textBaseline = "alphabetic";
      break;
    case "bottom":
      ctx.textBaseline = "bottom";
      break;
    case "middle":
      ctx.textBaseline = "middle";
      break;
    case "top":
      ctx.textBaseline = "top";
      break;
  }
  ctx.fillText(p.value, 0, 0);
  ctx.restore();
}
