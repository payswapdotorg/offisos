"use client";

/**
 * CAD-PARITY-002 professional canvas painting (Web host).
 *
 * Deterministic 2D canvas rendering for the Model viewport: drafting
 * entities (ported from the COMPAT-CAD-001 workbench), BIM plan footprints
 * (walls as thick bands, slabs as filled rectangles), the professional
 * crosshair, snap markers, rubber bands, selection rectangles, grips and
 * the pending-command preview. Pure drawing — no state, no engines.
 */

import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import type { DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import type { Element } from "@offisos/cad-app-shell/contracts/caddocument";
import { parseDraftEntity } from "@/cad/drafting/hit";
import type { GripHandle } from "@offisos/cad-app-shell/workspace/grips";

export interface ScreenTransform {
  readonly toScreen: (p: Vec2) => [number, number];
  readonly zoom: number;
}

// ---------------------------------------------------------------------------
// Drafting entities (COMPAT-CAD-001 rendering, unchanged semantics).
// ---------------------------------------------------------------------------

export function drawEntity(
  ctx: CanvasRenderingContext2D,
  entity: DraftEntity,
  opts: { color: string; selected: boolean; toScreen: (p: Vec2) => [number, number]; zoom: number },
): void {
  const { color, selected, toScreen, zoom } = opts;
  ctx.strokeStyle = selected ? "#0ea5e9" : color;
  ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
  if (entity.type === "line") {
    const a = toScreen(entity.from);
    const b = toScreen(entity.to);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    return;
  }
  if (entity.type === "polyline") {
    if (entity.points.length === 0) return;
    ctx.beginPath();
    const first = toScreen(entity.points[0] as Vec2);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < entity.points.length; i++) {
      const p = toScreen(entity.points[i] as Vec2);
      ctx.lineTo(p[0], p[1]);
    }
    if (entity.closed) ctx.closePath();
    ctx.stroke();
    return;
  }
  if (entity.type === "circle") {
    const c = toScreen(entity.center);
    ctx.beginPath();
    ctx.arc(c[0], c[1], entity.radius * zoom, 0, 2 * Math.PI);
    ctx.stroke();
    return;
  }
  if (entity.type === "arc") {
    const c = toScreen(entity.center);
    const sweep = entity.endAngle - entity.startAngle;
    ctx.beginPath();
    ctx.arc(c[0], c[1], entity.radius * zoom, entity.startAngle, entity.startAngle + sweep);
    ctx.stroke();
    return;
  }
  if (entity.type === "rectangle") {
    const a = toScreen(entity.corner1);
    const b = toScreen(entity.corner2);
    ctx.strokeRect(
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.abs(b[0] - a[0]),
      Math.abs(b[1] - a[1]),
    );
    return;
  }
  if (entity.type === "dim-linear") {
    const a = toScreen(entity.p1);
    const b = toScreen(entity.p2);
    const dx = entity.p2[0] - entity.p1[0];
    const dy = entity.p2[1] - entity.p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = entity.offset;
    const a2 = toScreen([entity.p1[0] + nx * off, entity.p1[1] + ny * off]);
    const b2 = toScreen([entity.p2[0] + nx * off, entity.p2[1] + ny * off]);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(a2[0], a2[1]);
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b2[0], b2[1]);
    ctx.moveTo(a2[0], a2[1]);
    ctx.lineTo(b2[0], b2[1]);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "11px ui-monospace, monospace";
    const mid: [number, number] = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
    ctx.fillText(`${entity.measured.toFixed(1)}`, mid[0] + 4, mid[1] - 4);
    return;
  }
  if (entity.type === "dim-radius") {
    // Radius dims annotate their target (no own geometry) — the label
    // renders in the annotation corner exactly like the COMPAT-CAD-001
    // workbench did (same visual semantics).
    ctx.lineWidth = 1;
    ctx.fillStyle = "#374151";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText(`R${entity.measured.toFixed(2)} → ${entity.target}`, 8, 16);
    return;
  }
}

// ---------------------------------------------------------------------------
// BIM plan footprints.
// ---------------------------------------------------------------------------

function isBimType(el: Element, type: string): boolean {
  const props = el.props as Record<string, unknown>;
  return el.kind === "bim" && props.type === type;
}

export function drawBimPlanElement(
  ctx: CanvasRenderingContext2D,
  el: Element,
  opts: { selected: boolean; toScreen: (p: Vec2) => [number, number]; zoom: number },
): void {
  const props = el.props as Record<string, unknown>;
  const { selected, toScreen, zoom } = opts;

  if (isBimType(el, "bim.wall")) {
    const start = props.start as Vec2 | undefined;
    const end = props.end as Vec2 | undefined;
    const width = props.width as number | undefined;
    if (!Array.isArray(start) || !Array.isArray(end) || typeof width !== "number") return;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const half = width / 2;
    const corners: Vec2[] = [
      [start[0] + nx * half, start[1] + ny * half],
      [end[0] + nx * half, end[1] + ny * half],
      [end[0] - nx * half, end[1] - ny * half],
      [start[0] - nx * half, start[1] - ny * half],
    ];
    const pts = corners.map(toScreen);
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
    ctx.closePath();
    ctx.fillStyle = selected ? "rgba(14,165,233,0.25)" : "rgba(120,113,108,0.18)";
    ctx.fill();
    ctx.strokeStyle = selected ? "#0ea5e9" : "#57534e";
    ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
    ctx.stroke();
    return;
  }

  if (isBimType(el, "bim.slab")) {
    const corner1 = props.corner1 as Vec2 | undefined;
    const corner2 = props.corner2 as Vec2 | undefined;
    if (!Array.isArray(corner1) || !Array.isArray(corner2)) return;
    const a = toScreen(corner1);
    const b = toScreen(corner2);
    ctx.fillStyle = selected ? "rgba(14,165,233,0.15)" : "rgba(161,98,7,0.10)";
    ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.strokeStyle = selected ? "#0ea5e9" : "#a16207";
    ctx.lineWidth = Math.max(1, (selected ? 1.8 : 1) * Math.min(2, zoom));
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    return;
  }
}

// ---------------------------------------------------------------------------
// Professional workspace overlays.
// ---------------------------------------------------------------------------

/** Full-viewport crosshair (AutoCAD-class) through the cursor position. */
export function drawCrosshair(ctx: CanvasRenderingContext2D, screen: [number, number], w: number, h: number): void {
  ctx.strokeStyle = "rgba(37,99,235,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(screen[0], 0);
  ctx.lineTo(screen[0], h);
  ctx.moveTo(0, screen[1]);
  ctx.lineTo(w, screen[1]);
  ctx.stroke();
}

/** Small square marker at a snap point. */
export function drawSnapMarker(ctx: CanvasRenderingContext2D, screen: [number, number], color = "#0d9488"): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(screen[0] - 5, screen[1] - 5, 10, 10);
}

/** Rubber band from a base point to the (constrained) cursor. */
export function drawRubberBand(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  to: Vec2,
  toScreen: (p: Vec2) => [number, number],
  color = "#f59e0b",
): void {
  const a = toScreen(from);
  const b = toScreen(to);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Window (blue) / crossing (green) selection rectangle. */
export function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  a: [number, number],
  b: [number, number],
  mode: "window" | "crossing",
): void {
  ctx.strokeStyle = mode === "window" ? "#2563eb" : "#16a34a";
  ctx.fillStyle = mode === "window" ? "rgba(37,99,235,0.08)" : "rgba(22,163,74,0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash(mode === "crossing" ? [4, 3] : []);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/** Grip squares for the selected entity. */
export function drawGrips(
  ctx: CanvasRenderingContext2D,
  grips: readonly GripHandle[],
  toScreen: (p: Vec2) => [number, number],
  hot: string | null,
): void {
  for (const grip of grips) {
    const s = toScreen(grip.point);
    const isHot = grip.id === hot;
    ctx.fillStyle = isHot ? "#f97316" : "#ffffff";
    ctx.strokeStyle = isHot ? "#c2410c" : "#2563eb";
    ctx.lineWidth = 1.25;
    ctx.fillRect(s[0] - 4, s[1] - 4, 8, 8);
    ctx.strokeRect(s[0] - 4, s[1] - 4, 8, 8);
  }
}

/** Pending polyline preview (collected vertices + cursor). */
export function drawPendingPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly Vec2[],
  cursor: Vec2 | null,
  toScreen: (p: Vec2) => [number, number],
): void {
  if (points.length === 0) return;
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  const first = toScreen(points[0] as Vec2);
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length; i++) {
    const p = toScreen(points[i] as Vec2);
    ctx.lineTo(p[0], p[1]);
  }
  if (cursor !== null) {
    const c = toScreen(cursor);
    ctx.lineTo(c[0], c[1]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Grid (drafting settings aware). */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  opts: { size: number; pan: { x: number; y: number }; zoom: number; w: number; h: number; toScreen: (p: Vec2) => [number, number] },
): void {
  const { size, pan, zoom, w, h, toScreen } = opts;
  if (!(size > 0)) return;
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  const startX = Math.floor(pan.x / size) * size;
  const startY = Math.floor(pan.y / size) * size;
  ctx.beginPath();
  for (let x = startX; x <= pan.x + w / zoom; x += size) {
    const [sx] = toScreen([x, 0]);
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let y = startY; y <= pan.y + h / zoom; y += size) {
    const [, sy] = toScreen([0, y]);
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();
}

export { parseDraftEntity };
