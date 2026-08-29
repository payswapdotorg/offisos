/**
 * CAD-PARITY-005 annotation render core (Issue #82) — the deterministic
 * annotation → render-primitive resolution.
 *
 * THE shared semantic core of annotation rendering: an annotation entity +
 * the resolved style tables + the document annotation scale produce a
 * plain list of RENDER PRIMITIVES (segments / arrowheads / text items).
 * BOTH hosts paint exactly these primitives through the shared painter
 * (annotation/paint.ts) — Web and Electron produce identical annotation
 * output by construction (LOCK-004). The SAME primitives drive annotation
 * picking (distance-to-primitive) — the pick surface and the visible
 * surface can never disagree.
 *
 * Style resolution (styles → REAL rendered behavior):
 *  - text/mtext/leader/mleader content: font family / width factor /
 *    oblique angle resolve LIVE from the referenced TEXT STYLE at render
 *    time (changing a style visibly changes every entity that references
 *    it — AutoCAD-class behavior); the HEIGHT is stored per entity
 *    (created from the style when fixed, prompted otherwise);
 *  - dimension entities: text height / arrow size / overall scale /
 *    measurement precision / arrow style / unit suffix resolve LIVE from
 *    the referenced DIM STYLE; the effective geometry is
 *    field × style.scale × document annotationScale (DIMSCALE-class);
 *  - leader/mleader arrowheads use the Standard dim arrow size scaled by
 *    the document annotationScale (documented convention);
 *  - measurement text: stored `measured` + style precision + suffix (the
 *    value is NOT recomputed at render time — the stored document truth;
 *    textOverride replaces it entirely);
 *  - angular measurements render in degrees with the "°" suffix.
 *
 * Deterministic text metrics convention (documented): a glyph cell is
 * 0.6 × height wide (scaled by the style width factor), the line pitch is
 * 1.2 × height. Used for MTEXT block layout and pick boxes — identical on
 * every host, independent of device fonts.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { DimStyleRecord, TextStyleRecord } from "../../contracts/caddocument.js";
import {
  STANDARD_DIM_STYLE,
  STANDARD_TEXT_STYLE,
  resolveDimStyle,
  resolveTextStyle,
} from "../standards/index.js";
import {
  add,
  dist,
  fromPolar,
  Pt,
  sub,
  TAU,
} from "../geometry/math2d.js";
import {
  Annotation,
  linearDimDirection,
  linearDimLinePoints,
} from "./types.js";

// ---------------------------------------------------------------------------
// Style context + formatting.
// ---------------------------------------------------------------------------

/** Everything the render resolution needs from the document (hosts derive
 *  it from the snapshot deterministically). */
export interface AnnotationStyleContext {
  /** User text styles ("Standard" resolves code-side). */
  readonly textStyles: readonly TextStyleRecord[];
  /** User dim styles ("Standard" resolves code-side). */
  readonly dimStyles: readonly DimStyleRecord[];
  /** The document annotation scale (DrawingStandards.annotationScale;
   *  1 when absent). Multiplies dimension annotation geometry. */
  readonly annotationScale: number;
}

export function annotationStyleContext(
  textStyles: readonly TextStyleRecord[],
  dimStyles: readonly DimStyleRecord[],
  annotationScale: number | undefined,
): AnnotationStyleContext {
  return {
    textStyles,
    dimStyles,
    annotationScale: annotationScale !== undefined && annotationScale > 0 ? annotationScale : 1,
  };
}

/** The resolved effective values of a dim style for one annotation. */
export interface EffectiveDimStyle {
  readonly textHeight: number;
  readonly arrowSize: number;
  readonly precision: number;
  readonly arrowStyle: "closed" | "tick" | "none";
  readonly unitSuffix: string;
}

export function effectiveDimStyle(
  name: string | undefined,
  ctx: AnnotationStyleContext,
): EffectiveDimStyle {
  const style: DimStyleRecord = resolveDimStyle(name ?? "Standard", ctx.dimStyles) ?? STANDARD_DIM_STYLE;
  const k = (style.scale > 0 ? style.scale : 1) * ctx.annotationScale;
  return {
    textHeight: style.textHeight * k,
    arrowSize: style.arrowSize * k,
    precision: style.precision,
    arrowStyle: style.arrowStyle ?? "closed",
    unitSuffix: style.unitSuffix ?? "",
  };
}

/** The resolved live text-style properties for one annotation. */
export interface EffectiveTextStyle {
  readonly font: "sans" | "mono" | "serif";
  readonly widthFactor: number;
  readonly oblique: number;
}

export function effectiveTextStyle(
  name: string | undefined,
  ctx: AnnotationStyleContext,
): EffectiveTextStyle {
  const style: TextStyleRecord = resolveTextStyle(name ?? "Standard", ctx.textStyles) ?? STANDARD_TEXT_STYLE;
  return {
    font: style.font,
    widthFactor: style.widthFactor > 0 ? style.widthFactor : 1,
    oblique: style.obliqueAngle,
  };
}

/** Format a linear/radius/diameter measurement per a dim style. */
export function formatLinearValue(value: number, eff: EffectiveDimStyle): string {
  return value.toFixed(eff.precision) + eff.unitSuffix;
}

/** Format an angular measurement (radians → degrees + °). */
export function formatAngleValue(radians: number, eff: EffectiveDimStyle): string {
  return ((radians * 180) / Math.PI).toFixed(eff.precision) + "°";
}

/** The rendered measurement label of a dimension annotation. */
export function dimensionLabel(a: Annotation, ctx: AnnotationStyleContext): string {
  const eff = effectiveDimStyle(a.style, ctx);
  const override =
    (a.type === "dim-linear" || a.type === "dim-radius" || a.type === "dim-diameter" || a.type === "dim-angular")
      ? a.textOverride
      : undefined;
  if (override !== undefined) return override;
  switch (a.type) {
    case "dim-linear":
      return formatLinearValue(a.measured, eff);
    case "dim-radius":
      return `R${formatLinearValue(a.measured, eff)}`;
    case "dim-diameter":
      return `\u2300${formatLinearValue(a.measured, eff)}`;
    case "dim-angular":
      return formatAngleValue(a.measured, eff);
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Text metrics (deterministic convention — see module doc).
// ---------------------------------------------------------------------------

export const TEXT_GLYPH_ASPECT = 0.6;
export const TEXT_LINE_PITCH = 1.2;

/** Default annotation text height when an entity does not carry one
 *  (leaders/mleaders): the Standard dim style's text height. */
export const DEFAULT_LEADER_TEXT_HEIGHT = 2.5;

export function textWidth(value: string, height: number, widthFactor: number): number {
  return value.length * height * TEXT_GLYPH_ASPECT * widthFactor;
}

export function textLinePitch(height: number): number {
  return height * TEXT_LINE_PITCH;
}

// ---------------------------------------------------------------------------
// Render primitives.
// ---------------------------------------------------------------------------

export type RenderPrimitive =
  | { readonly kind: "segment"; readonly a: Pt; readonly b: Pt }
  | {
      readonly kind: "arrow";
      /** The arrow TIP point. */
      readonly at: Pt;
      /** Unit vector the tip points ALONG (tip → tail direction). */
      readonly dir: Pt;
      readonly size: number;
      readonly style: "closed" | "tick" | "none";
    }
  | {
      readonly kind: "text";
      readonly at: Pt;
      readonly value: string;
      readonly height: number;
      readonly rotation: number;
      readonly font: "sans" | "mono" | "serif";
      readonly widthFactor: number;
      readonly oblique: number;
      readonly hAlign: "left" | "center" | "right";
      readonly vAlign: "baseline" | "bottom" | "middle" | "top";
    };

/** AutoCAD-class text readability: a text run reading "upside down" (its
 *  direction in the left half-plane, or straight down) flips 180°. */
export function readableRotation(angle: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (c < -1e-12 || (Math.abs(c) <= 1e-12 && s < 0)) {
    return angle + Math.PI;
  }
  return angle;
}

/** Offset of a text baseline above a dimension line (the text sits on the
 *  side the dimension reads from — half the text height above the line). */
const DIM_TEXT_GAP = 0.5;

/** Extension line overshoot past the dimension line (× effective arrow size). */
const EXT_OVERSHOOT = 0.5;

/** Extension line gap from the measured origin (× effective arrow size). */
const EXT_GAP = 0.25;

/** Resolve one annotation to its render primitives. Pure + deterministic:
 *  the same annotation + style context produces the same primitives on
 *  every host, every run (LOCK-004). */
export function annotationPrimitives(
  a: Annotation,
  ctx: AnnotationStyleContext,
): readonly RenderPrimitive[] {
  switch (a.type) {
    case "text": {
      const eff = effectiveTextStyle(a.style, ctx);
      return [{
        kind: "text",
        at: { x: a.x, y: a.y },
        value: a.value,
        height: a.height,
        rotation: readableRotation(a.rotation),
        font: eff.font,
        widthFactor: eff.widthFactor,
        oblique: eff.oblique,
        hAlign: a.hAlign ?? "left",
        vAlign: a.vAlign ?? "baseline",
      }];
    }
    case "mtext":
      return mtextPrimitives(a, ctx);
    case "dim-linear":
      return dimLinearPrimitives(a, ctx);
    case "dim-radius":
      return dimRadiusPrimitives(a, ctx);
    case "dim-diameter":
      return dimDiameterPrimitives(a, ctx);
    case "dim-angular":
      return dimAngularPrimitives(a, ctx);
    case "leader":
      return leaderPrimitives(a, ctx);
    case "mleader":
      return mleaderPrimitives(a, ctx);
  }
}

// --- MTEXT -----------------------------------------------------------------

function mtextPrimitives(a: Extract<Annotation, { type: "mtext" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const eff = effectiveTextStyle(a.style, ctx);
  const lines = a.value.split("\n");
  const attachment = a.attachment ?? "top-left";
  const pitch = textLinePitch(a.height);
  const blockH = lines.length * pitch;
  const out: RenderPrimitive[] = [];
  const [vert, horiz] = attachment.split("-") as [string, string];
  // The attachment corner of the (width × blockH) box sits at (x, y).
  const offsetX = horiz === "left" ? 0 : horiz === "center" ? -a.width / 2 : -a.width;
  const offsetY = vert === "top" ? 0 : vert === "middle" ? -blockH / 2 : -blockH;
  const cos = Math.cos(a.rotation);
  const sin = Math.sin(a.rotation);
  lines.forEach((line, i) => {
    // The line's baseline within the block (top-down, pitch spacing; the
    // baseline sits 0.8 × height below the line's top — the deterministic
    // cell convention).
    const localX = a.x + offsetX;
    const localY = a.y + offsetY + pitch * i + a.height * 0.8;
    const at: Pt = {
      x: a.x + (localX - a.x) * cos - (localY - a.y) * sin,
      y: a.y + (localX - a.x) * sin + (localY - a.y) * cos,
    };
    out.push({
      kind: "text",
      at,
      value: line,
      height: a.height,
      rotation: readableRotation(a.rotation),
      font: eff.font,
      widthFactor: eff.widthFactor,
      oblique: eff.oblique,
      hAlign: "left",
      vAlign: "baseline",
    });
  });
  return out;
}

// --- DIM-LINEAR ------------------------------------------------------------

function dimLinearPrimitives(a: Extract<Annotation, { type: "dim-linear" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const eff = effectiveDimStyle(a.style, ctx);
  const d = linearDimDirection(a.p1, a.p2, a.mode, a.angle);
  const n: Pt = { x: -d.y, y: d.x };
  const [q1, q2] = linearDimLinePoints(a);
  const label = dimensionLabel(a, ctx);
  const textW = textWidth(label, eff.textHeight, 1);
  const out: RenderPrimitive[] = [];

  // Extension lines: from each origin (small gap) to just past the dim line.
  const over = eff.arrowSize * EXT_OVERSHOOT;
  for (const [origin, foot] of [[a.p1, q1], [a.p2, q2]] as const) {
    const seg = sub(foot, origin);
    const len = Math.hypot(seg.x, seg.y);
    if (len > eff.arrowSize * 0.25) {
      const u: Pt = { x: seg.x / len, y: seg.y / len };
      const from = add(origin, { x: u.x * eff.arrowSize * EXT_GAP, y: u.y * eff.arrowSize * EXT_GAP });
      const to = add(foot, { x: u.x * over, y: u.y * over });
      out.push({ kind: "segment", a: from, b: to });
    }
  }

  // Dimension line + arrows. When the arrows do not fit between the
  // extension lines (measured < 2·arrow + text width), the arrows flip
  // outside (AutoCAD behavior) and the dimension line extends by one
  // arrow length on both sides.
  const span = dist(q1, q2);
  const fits = span >= 2 * eff.arrowSize + textW;
  if (fits) {
    out.push({ kind: "segment", a: q1, b: q2 });
    out.push({ kind: "arrow", at: q1, dir: { x: -d.x, y: -d.y }, size: eff.arrowSize, style: eff.arrowStyle });
    out.push({ kind: "arrow", at: q2, dir: d, size: eff.arrowSize, style: eff.arrowStyle });
  } else {
    const ext: Pt = { x: d.x * eff.arrowSize, y: d.y * eff.arrowSize };
    out.push({ kind: "segment", a: add(q1, { x: -ext.x, y: -ext.y }), b: add(q2, ext) });
    out.push({ kind: "arrow", at: q1, dir: d, size: eff.arrowSize, style: eff.arrowStyle });
    out.push({ kind: "arrow", at: q2, dir: { x: -d.x, y: -d.y }, size: eff.arrowSize, style: eff.arrowStyle });
  }

  // Text: at the dim line midpoint (or the DIMTEDIT override), half the
  // text height above the line, rotated along the (readable) direction.
  const mid: Pt = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
  const base: Pt = a.textPos ?? mid;
  const along = a.textPos !== undefined
    ? { x: 0, y: 0 }
    : { x: n.x * eff.textHeight * DIM_TEXT_GAP, y: n.y * eff.textHeight * DIM_TEXT_GAP };
  out.push({
    kind: "text",
    at: { x: base.x + along.x, y: base.y + along.y },
    value: label,
    height: eff.textHeight,
    rotation: readableRotation(Math.atan2(d.y, d.x)),
    font: "mono",
    widthFactor: 1,
    oblique: 0,
    hAlign: "center",
    vAlign: "baseline",
  });
  return out;
}

// --- DIM-RADIUS ------------------------------------------------------------

function dimRadiusPrimitives(a: Extract<Annotation, { type: "dim-radius" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const eff = effectiveDimStyle(a.style, ctx);
  const out: RenderPrimitive[] = [];
  const label = dimensionLabel(a, ctx);
  // Leader direction: toward the placement point (default +X).
  let u: Pt = { x: 1, y: 0 };
  if (a.at !== undefined) {
    const v = sub(a.at, a.center);
    const len = Math.hypot(v.x, v.y);
    if (len > 1e-12) u = { x: v.x / len, y: v.y / len };
  }
  // Arrow tip ON the circle, pointing toward the center.
  const boundary = add(a.center, { x: u.x * a.radius, y: u.y * a.radius });
  out.push({ kind: "arrow", at: boundary, dir: { x: -u.x, y: -u.y }, size: eff.arrowSize, style: eff.arrowStyle });
  // Leader to the placement point (never shorter than r + 2·arrow).
  const minEnd = a.radius + 2 * eff.arrowSize;
  const placementDist = a.at !== undefined ? Math.max(dist(a.at, a.center), minEnd) : minEnd;
  const end = add(a.center, { x: u.x * placementDist, y: u.y * placementDist });
  out.push({ kind: "segment", a: boundary, b: end });
  // Label at the leader end (or the DIMTEDIT override), above the leader,
  // left-aligned along the readable leader direction.
  const textAt = a.textPos ?? add(end, { x: 0, y: eff.textHeight * 0.3 });
  out.push({
    kind: "text",
    at: textAt,
    value: label,
    height: eff.textHeight,
    rotation: readableRotation(Math.atan2(u.y, u.x)),
    font: "mono",
    widthFactor: 1,
    oblique: 0,
    hAlign: "left",
    vAlign: "baseline",
  });
  return out;
}

// --- DIM-DIAMETER ----------------------------------------------------------

function dimDiameterPrimitives(a: Extract<Annotation, { type: "dim-diameter" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const eff = effectiveDimStyle(a.style, ctx);
  const out: RenderPrimitive[] = [];
  const label = dimensionLabel(a, ctx);
  const d: Pt = { x: Math.cos(a.angle), y: Math.sin(a.angle) };
  const b1 = add(a.center, { x: -d.x * a.radius, y: -d.y * a.radius });
  const b2 = add(a.center, { x: d.x * a.radius, y: d.y * a.radius });
  out.push({ kind: "segment", a: b1, b: b2 });
  // Arrowheads at the circle, tips pointing outward.
  out.push({ kind: "arrow", at: b1, dir: { x: -d.x, y: -d.y }, size: eff.arrowSize, style: eff.arrowStyle });
  out.push({ kind: "arrow", at: b2, dir: d, size: eff.arrowSize, style: eff.arrowStyle });
  // Text centered above the dimension line midpoint; when it does not fit
  // inside the circle, the line extends on the +d side and the text moves
  // beyond the circle edge.
  const textW = textWidth(label, eff.textHeight, 1);
  const n: Pt = { x: -d.y, y: d.x };
  if (2 * a.radius >= textW + 2 * eff.arrowSize) {
    const mid = a.center;
    const at = a.textPos ?? add(mid, { x: n.x * eff.textHeight * DIM_TEXT_GAP, y: n.y * eff.textHeight * DIM_TEXT_GAP });
    out.push({
      kind: "text",
      at,
      value: label,
      height: eff.textHeight,
      rotation: readableRotation(a.angle),
      font: "mono",
      widthFactor: 1,
      oblique: 0,
      hAlign: "center",
      vAlign: "baseline",
    });
  } else {
    const extension = eff.arrowSize + textW + eff.arrowSize * 0.5;
    const extEnd = add(b2, { x: d.x * extension, y: d.y * extension });
    out.push({ kind: "segment", a: b2, b: extEnd });
    const at = a.textPos ?? add(extEnd, { x: 0, y: eff.textHeight * 0.3 });
    out.push({
      kind: "text",
      at,
      value: label,
      height: eff.textHeight,
      rotation: 0,
      font: "mono",
      widthFactor: 1,
      oblique: 0,
      hAlign: "left",
      vAlign: "baseline",
    });
  }
  return out;
}

// --- DIM-ANGULAR -----------------------------------------------------------

function dimAngularPrimitives(a: Extract<Annotation, { type: "dim-angular" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const eff = effectiveDimStyle(a.style, ctx);
  const out: RenderPrimitive[] = [];
  const label = dimensionLabel(a, ctx);
  const arcStart = fromPolar(a.vertex, a.startAngle, a.radius);
  const arcEnd = fromPolar(a.vertex, a.endAngle, a.radius);
  const over = eff.arrowSize * EXT_OVERSHOOT;

  // Extension lines along the two legs, from the vertex to just past the arc.
  for (const angle of [a.startAngle, a.endAngle]) {
    const u: Pt = { x: Math.cos(angle), y: Math.sin(angle) };
    const from = add(a.vertex, { x: u.x * eff.arrowSize * EXT_GAP, y: u.y * eff.arrowSize * EXT_GAP });
    const to = add(a.vertex, { x: u.x * (a.radius + over), y: u.y * (a.radius + over) });
    out.push({ kind: "segment", a: from, b: to });
  }

  // Arc: sampled into segments at a fixed 6° chord (deterministic; ≤ 60
  // segments for a full sweep) — every host draws the same polyline.
  const sweep = ((a.endAngle - a.startAngle) % TAU + TAU) % TAU;
  const steps = Math.max(2, Math.ceil(((sweep * 180) / Math.PI) / 6));
  let prev = arcStart;
  for (let i = 1; i <= steps; i++) {
    const angle = a.startAngle + (sweep * i) / steps;
    const p = fromPolar(a.vertex, angle, a.radius);
    out.push({ kind: "segment", a: prev, b: p });
    prev = p;
  }

  // Arrows at the arc ends, tangent to the arc, pointing INTO the sweep.
  const t1: Pt = { x: -Math.sin(a.startAngle), y: Math.cos(a.startAngle) };
  const t2: Pt = { x: Math.sin(a.endAngle), y: -Math.cos(a.endAngle) };
  out.push({ kind: "arrow", at: arcStart, dir: t1, size: eff.arrowSize, style: eff.arrowStyle });
  out.push({ kind: "arrow", at: arcEnd, dir: t2, size: eff.arrowSize, style: eff.arrowStyle });

  // Text at the arc midpoint, tangentially aligned, above the arc.
  const midAngle = a.startAngle + sweep / 2;
  const midPt = fromPolar(a.vertex, midAngle, a.radius);
  const radial: Pt = { x: Math.cos(midAngle), y: Math.sin(midAngle) };
  const textAt = a.textPos ?? add(midPt, { x: radial.x * eff.textHeight * DIM_TEXT_GAP, y: radial.y * eff.textHeight * DIM_TEXT_GAP });
  out.push({
    kind: "text",
    at: textAt,
    value: label,
    height: eff.textHeight,
    rotation: readableRotation(midAngle + Math.PI / 2),
    font: "mono",
    widthFactor: 1,
    oblique: 0,
    hAlign: "center",
    vAlign: "baseline",
  });
  return out;
}

// --- LEADER ----------------------------------------------------------------

function leaderPrimitives(a: Extract<Annotation, { type: "leader" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const out: RenderPrimitive[] = [];
  const points = a.points;
  const first = points[0]!;
  const second = points[1]!;
  const spine = sub(second, first);
  const len = Math.hypot(spine.x, spine.y);
  const u: Pt = len > 1e-12 ? { x: spine.x / len, y: spine.y / len } : { x: 1, y: 0 };
  // Arrowhead: the Standard dim arrow scaled by the document annotation
  // scale (documented convention — leaders carry a text style, not a dim
  // style; the annotation scale still applies).
  out.push({ kind: "arrow", at: first, dir: { x: -u.x, y: -u.y }, size: effectiveDimStyle(undefined, ctx).arrowSize, style: "closed" });
  for (let i = 1; i < points.length; i++) {
    out.push({ kind: "segment", a: points[i - 1]!, b: points[i]! });
  }
  const height = a.height ?? DEFAULT_LEADER_TEXT_HEIGHT;
  if (a.value !== undefined) {
    const eff = effectiveTextStyle(a.style, ctx);
    // Landing: from the last point, horizontally in the direction the last
    // segment travels (default +X), length 2 × the text height.
    const last = points[points.length - 1]!;
    const prev = points[points.length - 2]!;
    const tail = sub(last, prev);
    const dirX = Math.abs(tail.x) > 1e-12 ? Math.sign(tail.x) : 1;
    const landingEnd = add(last, { x: dirX * 2 * height, y: 0 });
    out.push({ kind: "segment", a: last, b: landingEnd });
    out.push({
      kind: "text",
      at: add(landingEnd, { x: dirX * height * 0.2, y: 0 }),
      value: a.value,
      height,
      rotation: 0,
      font: eff.font,
      widthFactor: eff.widthFactor,
      oblique: eff.oblique,
      hAlign: dirX > 0 ? "left" : "right",
      vAlign: "baseline",
    });
  }
  return out;
}

// --- MLEADER ---------------------------------------------------------------

function mleaderPrimitives(a: Extract<Annotation, { type: "mleader" }>, ctx: AnnotationStyleContext): readonly RenderPrimitive[] {
  const out: RenderPrimitive[] = [];
  const eff = effectiveTextStyle(a.style, ctx);
  const height = a.height ?? DEFAULT_LEADER_TEXT_HEIGHT;
  const away = sub(a.landing, a.arrow);
  const len = Math.hypot(away.x, away.y);
  const u: Pt = len > 1e-12 ? { x: away.x / len, y: away.y / len } : { x: 1, y: 0 };
  // Spine + arrowhead at the target (Standard dim arrow × annotationScale).
  out.push({ kind: "segment", a: a.arrow, b: a.landing });
  out.push({ kind: "arrow", at: a.arrow, dir: u, size: effectiveDimStyle(undefined, ctx).arrowSize, style: "closed" });
  // Horizontal landing away from the arrow, length 2 × text height.
  const dirX = Math.abs(away.x) > 1e-12 ? Math.sign(away.x) : 1;
  const landingEnd = add(a.landing, { x: dirX * 2 * height, y: 0 });
  out.push({ kind: "segment", a: a.landing, b: landingEnd });
  // Content: multi-line block starting at the landing end, baseline
  // centered on the landing line, pitch 1.2 × height.
  const lines = a.value.split("\n");
  const totalH = lines.length * textLinePitch(height);
  const startY = a.landing.y - totalH / 2 + height * 0.8;
  lines.forEach((line, i) => {
    out.push({
      kind: "text",
      at: { x: landingEnd.x + dirX * height * 0.2, y: startY + i * textLinePitch(height) },
      value: line,
      height,
      rotation: 0,
      font: eff.font,
      widthFactor: eff.widthFactor,
      oblique: eff.oblique,
      hAlign: dirX > 0 ? "left" : "right",
      vAlign: "baseline",
    });
  });
  return out;
}
