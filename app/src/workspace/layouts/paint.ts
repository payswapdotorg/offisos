/**
 * CAD-PARITY-008 paper-space painter (Issue #88) — the SHARED canvas-2D
 * painter for the Plot IR.
 *
 * Both hosts (Web paper canvas + plot preview, Electron professional paper
 * canvas + preview) render the sheet composition through THIS module: the
 * sheet frame, the printable-area boundary, the viewport borders (locked
 * state visibly distinct, selected viewport highlighted) and every
 * viewport's projected model content clipped to its rectangle — identical
 * output on every host (LOCK-004 parity by construction; the
 * constraints/paint.ts + annotation/paint.ts precedent).
 *
 * The painter consumes the SAME Plot IR the export writers consume, so the
 * live paper canvas and the plot preview use the exact same semantic
 * transforms as the final export path (Issue #88 acceptance #4).
 *
 * Host-supplied: the CanvasRenderingContext2D, the sheet→screen transform
 * and the device px per output mm. Engine-free, host-neutral (LOCK-003/018).
 */

import { ANNOTATION_FONT_FAMILY } from "../annotation/paint.js";
import type { PaperPt, ViewportRect } from "./transform.js";
import type { PlotIR, PlotPrimitive, PlotStroke } from "./ir.js";

/** The structural slice of the HTML Canvas 2D context the painter uses (the
 *  annotation/paint.ts contract — the app package compiles without the DOM
 *  lib; every host's real context satisfies this shape structurally). */
export interface PaperCanvas2DContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  closePath(): void;
  fill(): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  ellipse?(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  clip(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: readonly number[]): void;
  strokeStyle: string | object | undefined;
  fillStyle: string | object | undefined;
  lineWidth: number;
  font: string;
  textAlign: "left" | "right" | "center" | "start" | "end" | undefined;
  textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom" | undefined;
  globalAlpha: number;
}

export interface PaperPaintOptions {
  /** Sheet mm → device px (applies the sheet scale + the host's paper view). */
  readonly toScreen: (p: PaperPt) => [number, number];
  /** Device px per OUTPUT mm (lineweight/dash/text sizing). */
  readonly pxPerMm: number;
  /** Highlight this viewport's border as selected (null = none). */
  readonly selectedViewportId?: string | null;
}

/** The selected-viewport highlight color (device styling, deterministic). */
export const PAPER_SELECTION_COLOR = "#0f766e";
/** The locked-viewport accent color (shared with the IR border writer). */
export const PAPER_LOCKED_COLOR = "#b45309";

function applyStroke(ctx: PaperCanvas2DContext, stroke: PlotStroke, opts: PaperPaintOptions): void {
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = Math.max(0.5, stroke.lineweightMm * opts.pxPerMm);
  if (stroke.dashMm.length > 0) {
    ctx.setLineDash(stroke.dashMm.map((d) => d * opts.pxPerMm));
  } else {
    ctx.setLineDash([]);
  }
}

/** Paint one primitive (screen-space transform only — no clipping here; the
 *  caller scopes the viewport clip). */
export function paintPlotPrimitive(
  ctx: PaperCanvas2DContext,
  p: PlotPrimitive,
  opts: PaperPaintOptions,
): void {
  switch (p.kind) {
    case "segment": {
      const a = opts.toScreen(p.a);
      const b = opts.toScreen(p.b);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      applyStroke(ctx, p.stroke, opts);
      ctx.stroke();
      return;
    }
    case "polyline": {
      if (p.points.length < 2) return;
      ctx.beginPath();
      const first = opts.toScreen(p.points[0]!);
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < p.points.length; i += 1) {
        const s = opts.toScreen(p.points[i]!);
        ctx.lineTo(s[0], s[1]);
      }
      if (p.closed) ctx.closePath();
      applyStroke(ctx, p.stroke, opts);
      ctx.stroke();
      return;
    }
    case "circle": {
      const c = opts.toScreen(p.c);
      const r = p.r * opts.pxPerMm;
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
      applyStroke(ctx, p.stroke, opts);
      ctx.stroke();
      return;
    }
    case "arc": {
      const c = opts.toScreen(p.c);
      const r = p.r * opts.pxPerMm;
      // Canvas Y is down: a paper-space CCW arc (start→end) draws as the
      // mirrored sweep — arc(-start → -end, counterclockwise).
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, -p.start, -p.end, true);
      applyStroke(ctx, p.stroke, opts);
      ctx.stroke();
      return;
    }
    case "ellipse": {
      const c = opts.toScreen(p.c);
      if (ctx.ellipse === undefined) {
        // Structural fallback: a 64-gon approximation (deterministic).
        const rx = p.rx * opts.pxPerMm;
        const ry = p.ry * opts.pxPerMm;
        ctx.beginPath();
        for (let i = 0; i <= 64; i += 1) {
          const t = (i / 64) * Math.PI * 2;
          const ex = p.rx * Math.cos(t);
          const ey = p.ry * Math.sin(t);
          const cth = Math.cos(p.rotation);
          const sth = Math.sin(p.rotation);
          const px = ex * cth - ey * sth;
          const py = ex * sth + ey * cth;
          const s = opts.toScreen({ x: p.c.x + px, y: p.c.y + py });
          if (i === 0) ctx.moveTo(s[0], s[1]);
          else ctx.lineTo(s[0], s[1]);
        }
        applyStroke(ctx, p.stroke, opts);
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      ctx.ellipse(c[0], c[1], p.rx * opts.pxPerMm, p.ry * opts.pxPerMm, -p.rotation, 0, Math.PI * 2);
      applyStroke(ctx, p.stroke, opts);
      ctx.stroke();
      return;
    }
    case "text": {
      const at = opts.toScreen(p.at);
      const heightPx = Math.max(1, p.height * opts.pxPerMm);
      ctx.save();
      ctx.translate(at[0], at[1]);
      ctx.rotate(-p.rotation);
      const wf = p.widthFactor > 0 ? p.widthFactor : 1;
      const obliqueRad = (Math.max(-85, Math.min(85, p.oblique)) * Math.PI) / 180;
      ctx.transform(wf, 0, Math.tan(obliqueRad), 1, 0, 0);
      ctx.font = `${heightPx.toFixed(2)}px ${ANNOTATION_FONT_FAMILY[p.font]}`;
      ctx.fillStyle = p.fill;
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
      return;
    }
    case "arrow": {
      if (p.style === "none") return;
      const tip = opts.toScreen(p.at);
      const sizePx = Math.max(2, p.size * opts.pxPerMm);
      // Sheet dir → screen dir (canvas Y is down).
      const dx = p.dir.x;
      const dy = -p.dir.y;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * p.stroke.alpha;
      if (p.style === "tick") {
        const half = sizePx * 0.6;
        const px = -dy;
        const py = dx;
        const cos45 = Math.SQRT1_2;
        const sin45 = Math.SQRT1_2;
        const o1x = px * cos45 - py * sin45;
        const o1y = px * sin45 + py * cos45;
        ctx.beginPath();
        ctx.moveTo(tip[0] - o1x * half, tip[1] - o1y * half);
        ctx.lineTo(tip[0] + o1x * half, tip[1] + o1y * half);
        ctx.strokeStyle = p.stroke.color;
        ctx.lineWidth = Math.max(1, p.stroke.lineweightMm * opts.pxPerMm);
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
        return;
      }
      const wing = sizePx * 0.35;
      const back: [number, number] = [tip[0] - dx * sizePx, tip[1] - dy * sizePx];
      const p1: [number, number] = [back[0] - dy * wing, back[1] + dx * wing];
      const p2: [number, number] = [back[0] + dy * wing, back[1] - dx * wing];
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.closePath();
      ctx.fillStyle = p.stroke.color;
      ctx.setLineDash([]);
      ctx.fill();
      ctx.restore();
      return;
    }
    default:
      return;
  }
}

/** Paint the paper-space composition of one Plot IR: the frame furniture
 *  (sheet boundary, printable area, viewport borders — selected/locked
 *  styling), then each viewport's content clipped to its rectangle in table
 *  order (later viewports on top — the deterministic z-order). */
export function paintPlotIR(
  ctx: PaperCanvas2DContext,
  ir: PlotIR,
  opts: PaperPaintOptions,
): void {
  // Frame furniture first (the paper composition, visually distinct from
  // model geometry by construction). Selected viewport border repaints on
  // top with the selection accent.
  for (const p of ir.frame.primitives) {
    paintPlotPrimitive(ctx, p, opts);
  }
  if (opts.selectedViewportId != null) {
    const selected = ir.viewports.find((v) => v.id === opts.selectedViewportId);
    if (selected !== undefined) {
      const a = opts.toScreen({ x: selected.rect.x1, y: selected.rect.y1 });
      const b = opts.toScreen({ x: selected.rect.x2, y: selected.rect.y2 });
      const x = Math.min(a[0], b[0]);
      const y = Math.min(a[1], b[1]);
      const w = Math.abs(b[0] - a[0]);
      const h = Math.abs(b[1] - a[1]);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 2, y - 2, w + 4, h + 4);
      ctx.strokeStyle = PAPER_SELECTION_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    }
  }
  // Viewport content, clipped.
  for (const entry of ir.viewports) {
    const a = opts.toScreen({ x: entry.rect.x1, y: entry.rect.y1 });
    const b = opts.toScreen({ x: entry.rect.x2, y: entry.rect.y2 });
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.clip();
    ctx.setLineDash([]);
    for (const p of entry.primitives) {
      const prevAlpha = ctx.globalAlpha;
      if (p.kind !== "text" && p.stroke.alpha < 1) ctx.globalAlpha = prevAlpha * p.stroke.alpha;
      try {
        paintPlotPrimitive(ctx, p, opts);
      } finally {
        ctx.globalAlpha = prevAlpha;
      }
    }
    ctx.restore();
  }
}

/** Paint a LOCKED/selection badge-free paper backdrop: the gray desk + the
 *  white sheet. Hosts call this before paintPlotIR for the canvas framing. */
export function paintSheetBackdrop(
  ctx: PaperCanvas2DContext,
  ir: PlotIR,
  opts: PaperPaintOptions,
): void {
  const a = opts.toScreen({ x: 0, y: 0 });
  const b = opts.toScreen({ x: ir.sheet.widthMm, y: ir.sheet.heightMm });
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  ctx.fill();
  ctx.restore();
}
