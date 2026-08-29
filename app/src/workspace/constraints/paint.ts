/**
 * CAD-PARITY-007 constraint glyph painter (Issue #86) — the SHARED canvas-2D
 * badge painter for constraint glyphs.
 *
 * Both hosts (Web model-canvas + Electron professional canvas) render the
 * constraint bar badges through THIS module: identical badge geometry,
 * colors and text metrics on every host (LOCK-004 parity by construction —
 * there is exactly ONE painter, the annotation/paint.ts precedent).
 *
 * The glyph descriptors are pure data derived from the declared constraint
 * graph + the element world (deterministic): one badge per constraint,
 * positioned at the constrained entity's primary anchor (line midpoint,
 * circle/arc center, point position; binary constraints sit between the two
 * targets' primary anchors).
 *
 * Host-supplied: the CanvasRenderingContext2D, the world→screen transform
 * and the zoom. Engine-free, host-neutral (LOCK-003/018).
 */

import type { ConstraintRecord, Element } from "../../contracts/caddocument.js";
import type { Geom } from "../geometry/types.js";
import { geomFromElement } from "../geometry/bridge.js";
import { Pt } from "../geometry/math2d.js";
import { CONSTRAINT_GLYPH } from "./types.js";

/** The structural slice of the HTML Canvas 2D context the painter uses (the
 *  annotation/paint.ts contract — the app package compiles without the DOM
 *  lib; every host's real context satisfies this shape structurally). */
export interface GlyphCanvas2DContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  closePath(): void;
  fill(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  strokeStyle: string | object | undefined;
  fillStyle: string | object | undefined;
  lineWidth: number;
  font: string;
  textAlign: "left" | "right" | "center" | "start" | "end" | undefined;
  textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom" | undefined;
}

/** One constraint badge (pure data — deterministic position + label). */
export interface ConstraintGlyph {
  readonly id: string;
  readonly kind: string;
  /** The badge label (the shared CONSTRAINT_GLYPH table). */
  readonly label: string;
  /** World-space badge center. */
  readonly at: Pt;
}

/** The primary anchor of a constrainable geometry (badge position). */
function primaryAnchorOf(geom: Geom): Pt | null {
  switch (geom.type) {
    case "line":
    case "ray":
    case "xline":
      return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
    case "circle":
    case "arc":
    case "ellipse":
      return { x: geom.cx, y: geom.cy };
    case "point":
      return { x: geom.x, y: geom.y };
    default:
      return null;
  }
}

/** Build the glyph descriptors for the declared constraint graph against
 *  the element world (deterministic: constraint-id order; targets that left
 *  the vocabulary are skipped — no badge for a dead constraint). */
export function constraintGlyphs(
  elements: readonly Element[],
  constraints: readonly ConstraintRecord[],
): readonly ConstraintGlyph[] {
  const byId = new Map<string, Element>();
  for (const el of elements) byId.set(el.id, el);
  const out: ConstraintGlyph[] = [];
  for (const c of [...constraints].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const anchors: Pt[] = [];
    for (const t of c.targets) {
      const el = byId.get(t.id);
      if (el === undefined) continue;
      const geom = geomFromElement(el);
      if (geom === null) continue;
      const at = primaryAnchorOf(geom);
      if (at !== null) anchors.push(at);
    }
    if (anchors.length === 0) continue;
    const at =
      anchors.length === 1
        ? anchors[0]!
        : { x: (anchors[0]!.x + anchors[anchors.length - 1]!.x) / 2, y: (anchors[0]!.y + anchors[anchors.length - 1]!.y) / 2 };
    out.push({
      id: c.id,
      kind: c.kind,
      label: CONSTRAINT_GLYPH[c.kind] ?? c.kind,
      at,
    });
  }
  return out;
}

/** The badge radius in device px (zoom-independent — a constant UI size). */
export const GLYPH_RADIUS_PX = 9;
/** The badge font (generic monospace — deterministic on every platform). */
export const GLYPH_FONT = "10px monospace";
/** The badge colors (violated badges render hot; satisfied render neutral). */
export const GLYPH_COLORS: Readonly<Record<"satisfied" | "violated", { stroke: string; fill: string; text: string }>> = {
  satisfied: { stroke: "#7c6f19", fill: "#f5efc6", text: "#4a4210" },
  violated: { stroke: "#a1352c", fill: "#f7d4cf", text: "#6d1f18" },
};

export interface GlyphPaintOptions {
  /** World→screen point transform. */
  readonly toScreen: (p: Pt) => [number, number];
  /** Badge state coloring (satisfied vs violated diagnostics). */
  readonly violated: ReadonlySet<string>;
}

/** Paint every glyph badge (pure w.r.t. the canvas state). */
export function paintConstraintGlyphs(
  ctx: GlyphCanvas2DContext,
  glyphs: readonly ConstraintGlyph[],
  options: GlyphPaintOptions,
): void {
  ctx.save();
  ctx.font = GLYPH_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  for (const g of glyphs) {
    const [sx, sy] = options.toScreen(g.at);
    const colors = options.violated.has(g.id) ? GLYPH_COLORS.violated : GLYPH_COLORS.satisfied;
    ctx.beginPath();
    ctx.arc(sx, sy, GLYPH_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = colors.fill;
    ctx.strokeStyle = colors.stroke;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(g.label, sx, sy);
  }
  ctx.restore();
}
