/**
 * CAD-PARITY-005 annotation entity types (Issue #82) — the canonical
 * annotation vocabulary: text, mtext, the dimension family, leaders and
 * multileaders.
 *
 * Annotation entities are CADDocument ELEMENTS with `kind: "annotation"`,
 * the `drafting: true` marker and the canonical FLAT props convention
 * (Pt objects `{x, y}` — the CAD-PARITY-003 geometry convention, NOT the
 * COMPAT-CAD-001 tuple convention). They participate in the CAD-PARITY-004
 * layer model exactly like geometry entities (layer name in `props.layer`,
 * display overrides in `props.color/linetype/lineweight/transparency`, the
 * execute() locked/frozen gate applies because the marker + layer are
 * present).
 *
 * Storage layout (per type; every number finite — LOCK-007 rejects
 * otherwise; every optional field is ADDITIVE so legacy snapshots and the
 * pinned CAD-PARITY-002/004 parity fixtures stay byte-identical):
 *
 *   text:         { drafting, annotation, type:"text", layer,
 *                   x, y, height, rotation, value, style?,
 *                   hAlign?, vAlign?, color?, …display }
 *   mtext:        { …, type:"mtext", x, y, height, width, rotation, value,
 *                   style?, attachment? }
 *   dim-linear:   { …, type:"dim-linear", p1:{x,y}, p2:{x,y}, mode, angle?,
 *                   offset, measured, style?, textOverride?, textPos?, refs? }
 *   dim-radius:   { …, type:"dim-radius", target, center:{x,y}, radius,
 *                   at?, measured, style?, textOverride?, textPos? }
 *   dim-diameter: { …, type:"dim-diameter", target, center:{x,y}, radius,
 *                   angle, measured, style?, textOverride?, textPos? }
 *   dim-angular:  { …, type:"dim-angular", vertex:{x,y}, startAngle,
 *                   endAngle, radius, measured, style?, textOverride?,
 *                   textPos?, refs? }
 *   leader:       { …, type:"leader", points:[{x,y}…≥2], value?, style?,
 *                   height? }
 *   mleader:      { …, type:"mleader", arrow:{x,y}, landing:{x,y}, value,
 *                   style?, height? }
 *
 * `measured` is computed deterministically at creation and re-computed by
 * the associative cascade (annotation/assoc.ts) — stored values are the
 * document truth between updates, exactly like the COMPAT-CAD-001 dims
 * (no silent recomputation at render time).
 *
 * `refs` is the associativity record: which measured points derive from
 * which referenced elements. entity.modify cascades a remeasure for every
 * annotation referencing a modified element (one atomic versioned batch).
 *
 * Legacy compatibility: the COMPAT-CAD-001 dim-linear/dim-radius records
 * (tuple points, no style/refs fields) load into the canonical view with
 * defaults — legacy dim-linear keeps its aligned-offset semantics, legacy
 * dim-radius synthesizes center/radius placeholders from its measured
 * value (self-contained rendering; remeasure refreshes when a target
 * resolves).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../../contracts/caddocument.js";
import {
  add,
  dist,
  EPS,
  norm,
  Pt,
  sub,
  TAU,
} from "../geometry/math2d.js";

// ---------------------------------------------------------------------------
// The annotation union.
// ---------------------------------------------------------------------------

export type AnnotationType =
  | "text"
  | "mtext"
  | "dim-linear"
  | "dim-radius"
  | "dim-diameter"
  | "dim-angular"
  | "leader"
  | "mleader";

/** Horizontal justification of a text entity (AutoCAD's hAlign subset). */
export type TextHAlign = "left" | "center" | "right";
/** Vertical justification of a text entity (AutoCAD's vAlign subset). */
export type TextVAlign = "baseline" | "bottom" | "middle" | "top";
/** MTEXT attachment corner (AutoCAD's 9 attachment points). */
export type MTextAttachment =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Linear dimension orientation. `rotated` uses `angle` (radians, the
 *  dimension line direction); the others derive it. */
export type LinearDimMode = "aligned" | "horizontal" | "vertical" | "rotated";

/** The anchor a dimension ref resolves on its target element (canonical
 *  geometry vocabulary: line/ray/xline endpoints + midpoint, circle/arc
 *  centers, arc endpoints, polyline first/last vertex). */
export type RefAnchor = "start" | "end" | "center" | "midpoint";

/** One associativity reference: dimension point `to` derives from the
 *  `anchor` of element `id` (dim-linear p1/p2, dim-angular leg1/leg2).
 *  Radius/diameter dimensions reference their measured circle through the
 *  dedicated `target` field instead. */
export interface DimRef {
  readonly id: string;
  readonly anchor: RefAnchor;
  readonly to: "p1" | "p2" | "leg1" | "leg2";
}

export interface TextAnnotation {
  readonly type: "text";
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  /** Text height in drawing mm (> 0). Resolved from the text style at
   *  creation when the style has a fixed height; stored per entity. */
  readonly height: number;
  /** Rotation in radians CCW from +X. */
  readonly rotation: number;
  readonly value: string;
  /** Text style name ("Standard" default). Font/widthFactor/oblique are
   *  resolved LIVE from the style at render time. */
  readonly style?: string;
  readonly hAlign?: TextHAlign;
  readonly vAlign?: TextVAlign;
}

export interface MTextAnnotation {
  readonly type: "mtext";
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  /** Text height in drawing mm (> 0) — resolved from the text style at
   *  creation when fixed; stored per entity (same rule as TEXT). */
  readonly height: number;
  /** The drawn text column width in drawing mm (layout hint — no wrapping
   *  in this slice; explicit "\n" line breaks only, documented). */
  readonly width: number;
  readonly rotation: number;
  /** Multi-line content ("\n" separated). */
  readonly value: string;
  readonly style?: string;
  readonly attachment?: MTextAttachment;
}

export interface DimLinearAnnotation {
  readonly type: "dim-linear";
  readonly layer: string;
  /** Extension line origins. */
  readonly p1: Pt;
  readonly p2: Pt;
  readonly mode: LinearDimMode;
  /** Rotated-mode dimension line direction, radians (absent for the
   *  derived modes). */
  readonly angle?: number;
  /** Signed perpendicular offset from the p1→p2 baseline to the dimension
   *  line, measured along the dimension line's left normal (positive =
   *  left of the dimension direction). */
  readonly offset: number;
  /** |(p2−p1) · d| — the projected extent along the dimension direction,
   *  computed at creation (aligned = the true distance). */
  readonly measured: number;
  readonly style?: string;
  readonly textOverride?: string;
  readonly textPos?: Pt;
  readonly refs?: readonly DimRef[];
}

export interface DimRadiusAnnotation {
  readonly type: "dim-radius";
  readonly layer: string;
  /** The measured circle/arc element id (null after disassociation — the
   *  entity then renders from its stored center/radius snapshot). */
  readonly target: string | null;
  /** Render reference: the measured circle's center (kept current by the
   *  associative cascade; the survival snapshot when disassociated). */
  readonly center: Pt;
  /** Render reference: the measured radius in mm. */
  readonly radius: number;
  /** The leader placement point (absent = the AutoCAD "inside" default:
   *  a short leader along +X). */
  readonly at?: Pt;
  readonly measured: number;
  readonly style?: string;
  readonly textOverride?: string;
  readonly textPos?: Pt;
}

export interface DimDiameterAnnotation {
  readonly type: "dim-diameter";
  readonly layer: string;
  readonly target: string | null;
  readonly center: Pt;
  readonly radius: number;
  /** Dimension line direction, radians (through the center). */
  readonly angle: number;
  readonly measured: number;
  readonly style?: string;
  readonly textOverride?: string;
  readonly textPos?: Pt;
}

export interface DimAngularAnnotation {
  readonly type: "dim-angular";
  readonly layer: string;
  /** The angle vertex (the two legs' intersection). */
  readonly vertex: Pt;
  /** Arc start angle, radians (normalized [0, 2π)). */
  readonly startAngle: number;
  /** Arc end angle, radians (normalized [0, 2π)); the CCW sweep from
   *  startAngle to endAngle is the measured angle. */
  readonly endAngle: number;
  /** Arc radius from the vertex (drawing mm, > 0). */
  readonly radius: number;
  /** The measured angle in RADIANS, CCW from startAngle to endAngle
   *  (0 < measured < 2π; rendered in degrees). */
  readonly measured: number;
  readonly style?: string;
  readonly textOverride?: string;
  readonly textPos?: Pt;
  readonly refs?: readonly DimRef[];
}

export interface LeaderAnnotation {
  readonly type: "leader";
  readonly layer: string;
  /** The leader spine: points[0] is the arrowhead tip, the last point is
   *  the annotation end (≥ 2 points, consecutive points distinct). */
  readonly points: readonly Pt[];
  /** Optional single-line annotation at the leader end. */
  readonly value?: string;
  readonly style?: string;
  /** Text height of the annotation (mm; absent = 2.5, the Standard dim
   *  text height). */
  readonly height?: number;
}

export interface MLeaderAnnotation {
  readonly type: "mleader";
  readonly layer: string;
  /** Arrowhead tip. */
  readonly arrow: Pt;
  /** The landing point the leader spine ends at; a horizontal landing
   *  segment (length 2 × effective text height) extends from it in the
   *  direction away from the arrow, carrying the content block. */
  readonly landing: Pt;
  /** The content ("\n" separated lines allowed). */
  readonly value: string;
  readonly style?: string;
  /** Text height of the content block (mm; absent = 2.5, the Standard dim
   *  text height). */
  readonly height?: number;
}

export type Annotation =
  | TextAnnotation
  | MTextAnnotation
  | DimLinearAnnotation
  | DimRadiusAnnotation
  | DimDiameterAnnotation
  | DimAngularAnnotation
  | LeaderAnnotation
  | MLeaderAnnotation;

export const ANNOTATION_TYPES: readonly AnnotationType[] = [
  "text",
  "mtext",
  "dim-linear",
  "dim-radius",
  "dim-diameter",
  "dim-angular",
  "leader",
  "mleader",
];

/** Human label for the properties inspector / status bar. */
export const ANNOTATION_LABEL: Readonly<Record<AnnotationType, string>> = {
  text: "Text",
  mtext: "MText",
  "dim-linear": "Linear Dimension",
  "dim-radius": "Radius Dimension",
  "dim-diameter": "Diameter Dimension",
  "dim-angular": "Angular Dimension",
  leader: "Leader",
  mleader: "Multileader",
};

// ---------------------------------------------------------------------------
// Typed failures (stable codes; LOCK-007/008).
// ---------------------------------------------------------------------------

export class AnnotationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AnnotationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function fin(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AnnotationError(`${field} must be a finite number`, "bad_input");
  }
  return v;
}

function pos(v: unknown, field: string): number {
  const n = fin(v, field);
  if (n <= 0) {
    throw new AnnotationError(`${field} must be > 0`, "bad_input");
  }
  return n;
}

function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AnnotationError(`${field} must be a non-empty string`, "bad_input");
  }
  return v;
}

function ptOf(v: unknown, field: string): Pt {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new AnnotationError(`${field} must be {x, y}`, "bad_input");
  }
  const o = v as Record<string, unknown>;
  return { x: fin(o.x, `${field}.x`), y: fin(o.y, `${field}.y`) };
}

function ptListOf(v: unknown, field: string, min: number): readonly Pt[] {
  if (!Array.isArray(v) || v.length < min) {
    throw new AnnotationError(`${field} must be an array of at least ${min} points`, "bad_input");
  }
  const out: Pt[] = [];
  for (const [i, p] of v.entries()) {
    out.push(ptOf(p, `${field}[${i}]`));
  }
  for (let i = 1; i < out.length; i++) {
    if (dist(out[i - 1]!, out[i]!) <= EPS) {
      throw new AnnotationError(`${field}[${i - 1}] and [${i}] must not coincide`, "bad_input");
    }
  }
  return out;
}

function optStyle(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return nonEmpty(v, field);
}

function optTextOverride(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new AnnotationError("textOverride must be a string when present", "bad_input");
  }
  return v.length === 0 ? undefined : v;
}

function optTextPos(v: unknown): Pt | undefined {
  if (v === undefined || v === null) return undefined;
  return ptOf(v, "textPos");
}

function optRefs(v: unknown): readonly DimRef[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new AnnotationError("refs must be an array when present", "bad_input");
  }
  const out: DimRef[] = [];
  for (const [i, r] of v.entries()) {
    if (typeof r !== "object" || r === null) {
      throw new AnnotationError(`refs[${i}] must be an object`, "bad_input");
    }
    const o = r as Record<string, unknown>;
    const anchor = o.anchor;
    const to = o.to;
    if (anchor !== "start" && anchor !== "end" && anchor !== "center" && anchor !== "midpoint") {
      throw new AnnotationError(`refs[${i}].anchor must be start|end|center|midpoint`, "bad_input");
    }
    if (to !== "p1" && to !== "p2" && to !== "leg1" && to !== "leg2") {
      throw new AnnotationError(`refs[${i}].to must be p1|p2|leg1|leg2`, "bad_input");
    }
    out.push({ id: nonEmpty(o.id, `refs[${i}].id`), anchor, to });
  }
  return out.length === 0 ? undefined : out;
}

function layerOf(v: unknown): string {
  return nonEmpty(v, "annotation layer (the canonical default is '0')");
}

// ---------------------------------------------------------------------------
// Measurement (deterministic, pure — the SAME functions the associative
// cascade and the tests use).
// ---------------------------------------------------------------------------

/** The dimension line direction (unit vector) of a linear dimension. */
export function linearDimDirection(
  p1: Pt,
  p2: Pt,
  mode: LinearDimMode,
  angle?: number,
): Pt {
  switch (mode) {
    case "horizontal":
      return { x: 1, y: 0 };
    case "vertical":
      return { x: 0, y: 1 };
    case "rotated": {
      const a = angle ?? 0;
      return { x: Math.cos(a), y: Math.sin(a) };
    }
    case "aligned": {
      const d = sub(p2, p1);
      const n = norm(d);
      if (n === null) {
        throw new AnnotationError("dim-linear: p1 and p2 must not coincide", "bad_input");
      }
      return n;
    }
  }
}

/** The measured value of a linear dimension: the extent of p2−p1 projected
 *  onto the dimension direction (aligned = the true distance). */
export function linearMeasured(
  p1: Pt,
  p2: Pt,
  mode: LinearDimMode,
  angle?: number,
): number {
  const d = linearDimDirection(p1, p2, mode, angle);
  const v = sub(p2, p1);
  return Math.abs(v.x * d.x + v.y * d.y);
}

/** The dimension line endpoints: the feet of the perpendiculars from p1/p2
 *  onto the dimension line (which is parallel to `d` at signed offset from
 *  the p1→p2 baseline along d's left normal). */
export function linearDimLinePoints(anno: DimLinearAnnotation): readonly [Pt, Pt] {
  const d = linearDimDirection(anno.p1, anno.p2, anno.mode, anno.angle);
  const n: Pt = { x: -d.y, y: d.x };
  return [
    add(anno.p1, { x: n.x * anno.offset, y: n.y * anno.offset }),
    add(anno.p2, { x: n.x * anno.offset, y: n.y * anno.offset }),
  ];
}

/** The signed offset of a placement point from the p1→p2 baseline along the
 *  dimension line's left normal (how DIMLINEAR/DIMALIGNED place the line). */
export function linearOffsetForPlacement(
  p1: Pt,
  p2: Pt,
  mode: LinearDimMode,
  angle: number | undefined,
  placement: Pt,
): number {
  const d = linearDimDirection(p1, p2, mode, angle);
  const n: Pt = { x: -d.y, y: d.x };
  return (placement.x - p1.x) * n.x + (placement.y - p1.y) * n.y;
}

/** DIMLINEAR auto-mode rule (documented deterministic convention, the
 *  AutoCAD placement heuristic): horizontal when the placement point is
 *  displaced from the p1/p2 midpoint more in Y than in X, vertical
 *  otherwise. */
export function autoLinearMode(p1: Pt, p2: Pt, placement: Pt): "horizontal" | "vertical" {
  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  return Math.abs(placement.y - cy) >= Math.abs(placement.x - cx) ? "horizontal" : "vertical";
}

/** The angular sector for a DIMANGULAR placement: of the two CCW sectors
 *  between the two leg directions, the one containing the placement point.
 *  Returns [startAngle, endAngle] with the CCW sweep endAngle−startAngle ∈
 *  (0, 2π). */
export function angularSectorForPlacement(
  vertex: Pt,
  leg1Dir: Pt,
  leg2Dir: Pt,
  placement: Pt,
): readonly [number, number] {
  const a1 = Math.atan2(leg1Dir.y, leg1Dir.x);
  const a2 = Math.atan2(leg2Dir.y, leg2Dir.x);
  const p = Math.atan2(placement.y - vertex.y, placement.x - vertex.x);
  const norm2 = (a: number): number => ((a % TAU) + TAU) % TAU;
  const n1 = norm2(a1);
  const sweepA = norm2(a2 - a1);
  const inA = norm2(p - a1) < sweepA;
  if (inA) {
    // The end may exceed 2π — the sweep-correct representation (the
    // constructor normalizes both angles; ccwSweep preserves the sweep).
    return [n1, n1 + sweepA];
  }
  const n2 = norm2(a2);
  return [n2, n2 + (TAU - sweepA)];
}

/** The measured CCW sweep (radians) from startAngle to endAngle. */
export function ccwSweep(startAngle: number, endAngle: number): number {
  return ((endAngle - startAngle) % TAU + TAU) % TAU;
}

// ---------------------------------------------------------------------------
// Constructors (strict validation — LOCK-007: reject, never guess).
// ---------------------------------------------------------------------------

export function makeText(input: Record<string, unknown>): TextAnnotation {
  const x = fin(input.x, "text.x");
  const y = fin(input.y, "text.y");
  const height = pos(input.height, "text.height");
  const rotation = fin(input.rotation ?? 0, "text.rotation");
  const value = nonEmpty(input.value, "text.value");
  const hAlign = input.hAlign ?? "left";
  if (hAlign !== "left" && hAlign !== "center" && hAlign !== "right") {
    throw new AnnotationError("text.hAlign must be left|center|right", "bad_input");
  }
  const vAlign = input.vAlign ?? "baseline";
  if (vAlign !== "baseline" && vAlign !== "bottom" && vAlign !== "middle" && vAlign !== "top") {
    throw new AnnotationError("text.vAlign must be baseline|bottom|middle|top", "bad_input");
  }
  const style = optStyle(input.style, "text.style");
  return {
    type: "text",
    layer: layerOf(input.layer),
    x,
    y,
    height,
    rotation,
    value,
    ...(style !== undefined ? { style } : {}),
    hAlign,
    vAlign,
  };
}

export function makeMText(input: Record<string, unknown>): MTextAnnotation {
  const x = fin(input.x, "mtext.x");
  const y = fin(input.y, "mtext.y");
  const height = pos(input.height, "mtext.height");
  const width = pos(input.width, "mtext.width");
  const rotation = fin(input.rotation ?? 0, "mtext.rotation");
  const value = nonEmpty(input.value, "mtext.value");
  const attachment = input.attachment ?? "top-left";
  const ok = [
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
  ].includes(attachment as string);
  if (!ok) {
    throw new AnnotationError("mtext.attachment must be one of the 9 attachment points", "bad_input");
  }
  const style = optStyle(input.style, "mtext.style");
  return {
    type: "mtext",
    layer: layerOf(input.layer),
    x,
    y,
    height,
    width,
    rotation,
    value,
    ...(style !== undefined ? { style } : {}),
    attachment: attachment as MTextAttachment,
  };
}

export function makeDimLinear(input: Record<string, unknown>): DimLinearAnnotation {
  const p1 = ptOf(input.p1, "dim-linear.p1");
  const p2 = ptOf(input.p2, "dim-linear.p2");
  if (dist(p1, p2) <= EPS) {
    throw new AnnotationError("dim-linear.p1 and p2 must not coincide", "bad_input");
  }
  const mode = input.mode ?? "aligned";
  if (mode !== "aligned" && mode !== "horizontal" && mode !== "vertical" && mode !== "rotated") {
    throw new AnnotationError("dim-linear.mode must be aligned|horizontal|vertical|rotated", "bad_input");
  }
  let angle: number | undefined;
  if (mode === "rotated") {
    angle = fin(input.angle, "dim-linear.angle (required for rotated mode)");
  } else if (input.angle !== undefined && input.angle !== null) {
    angle = fin(input.angle, "dim-linear.angle");
  }
  const offset = fin(input.offset ?? 0, "dim-linear.offset");
  const measured = linearMeasured(p1, p2, mode, angle);
  if (measured <= EPS) {
    throw new AnnotationError(
      "dim-linear: the projected extent along the dimension direction is zero — use a mode that matches a non-zero extent",
      "bad_input",
    );
  }
  // Trust no client measurement: when supplied, it must match (1e-9).
  if (input.measured !== undefined && Math.abs((input.measured as number) - measured) > EPS) {
    throw new AnnotationError(
      "dim-linear.measured does not match the recomputed value (measurements are computed, not trusted)",
      "bad_input",
    );
  }
  const style = optStyle(input.style, "dim-linear.style");
  const textOverride = optTextOverride(input.textOverride);
  const textPos = optTextPos(input.textPos);
  const refs = optRefs(input.refs);
  return {
    type: "dim-linear",
    layer: layerOf(input.layer),
    p1,
    p2,
    mode,
    ...(angle !== undefined ? { angle } : {}),
    offset,
    measured,
    ...(style !== undefined ? { style } : {}),
    ...(textOverride !== undefined ? { textOverride } : {}),
    ...(textPos !== undefined ? { textPos } : {}),
    ...(refs !== undefined ? { refs } : {}),
  };
}

export function makeDimRadius(input: Record<string, unknown>): DimRadiusAnnotation {
  const target = input.target === null || input.target === undefined ? null : nonEmpty(input.target, "dim-radius.target");
  const center = ptOf(input.center, "dim-radius.center");
  const radius = pos(input.radius, "dim-radius.radius");
  const measured = pos(input.measured, "dim-radius.measured");
  if (Math.abs(measured - radius) > EPS) {
    throw new AnnotationError("dim-radius.measured must equal the radius", "bad_input");
  }
  const at = input.at === undefined || input.at === null ? undefined : ptOf(input.at, "dim-radius.at");
  const style = optStyle(input.style, "dim-radius.style");
  const textOverride = optTextOverride(input.textOverride);
  const textPos = optTextPos(input.textPos);
  return {
    type: "dim-radius",
    layer: layerOf(input.layer),
    target,
    center,
    radius,
    ...(at !== undefined ? { at } : {}),
    measured,
    ...(style !== undefined ? { style } : {}),
    ...(textOverride !== undefined ? { textOverride } : {}),
    ...(textPos !== undefined ? { textPos } : {}),
  };
}

export function makeDimDiameter(input: Record<string, unknown>): DimDiameterAnnotation {
  const target = input.target === null || input.target === undefined ? null : nonEmpty(input.target, "dim-diameter.target");
  const center = ptOf(input.center, "dim-diameter.center");
  const radius = pos(input.radius, "dim-diameter.radius");
  const angle = fin(input.angle, "dim-diameter.angle");
  const measured = pos(input.measured, "dim-diameter.measured");
  if (Math.abs(measured - 2 * radius) > EPS) {
    throw new AnnotationError("dim-diameter.measured must equal twice the radius", "bad_input");
  }
  const style = optStyle(input.style, "dim-diameter.style");
  const textOverride = optTextOverride(input.textOverride);
  const textPos = optTextPos(input.textPos);
  return {
    type: "dim-diameter",
    layer: layerOf(input.layer),
    target,
    center,
    radius,
    angle,
    measured,
    ...(style !== undefined ? { style } : {}),
    ...(textOverride !== undefined ? { textOverride } : {}),
    ...(textPos !== undefined ? { textPos } : {}),
  };
}

export function makeDimAngular(input: Record<string, unknown>): DimAngularAnnotation {
  const vertex = ptOf(input.vertex, "dim-angular.vertex");
  const startAngle = fin(input.startAngle, "dim-angular.startAngle");
  const endAngle = fin(input.endAngle, "dim-angular.endAngle");
  const radius = pos(input.radius, "dim-angular.radius");
  const measured = ccwSweep(startAngle, endAngle);
  if (measured <= EPS || measured >= TAU - EPS) {
    throw new AnnotationError("dim-angular: the sweep must be in (0, 2π) — coincident/opposite zero sweeps are rejected", "bad_input");
  }
  if (input.measured !== undefined && Math.abs((input.measured as number) - measured) > EPS) {
    throw new AnnotationError("dim-angular.measured does not match the recomputed sweep", "bad_input");
  }
  const style = optStyle(input.style, "dim-angular.style");
  const textOverride = optTextOverride(input.textOverride);
  const textPos = optTextPos(input.textPos);
  const refs = optRefs(input.refs);
  return {
    type: "dim-angular",
    layer: layerOf(input.layer),
    vertex,
    startAngle: ((startAngle % TAU) + TAU) % TAU,
    endAngle: ((endAngle % TAU) + TAU) % TAU,
    radius,
    measured,
    ...(style !== undefined ? { style } : {}),
    ...(textOverride !== undefined ? { textOverride } : {}),
    ...(textPos !== undefined ? { textPos } : {}),
    ...(refs !== undefined ? { refs } : {}),
  };
}

export function makeLeader(input: Record<string, unknown>): LeaderAnnotation {
  const points = ptListOf(input.points, "leader.points", 2);
  const value = input.value === undefined || input.value === null || (input.value as string).length === 0
    ? undefined
    : nonEmpty(input.value, "leader.value");
  const height = input.height === undefined || input.height === null ? undefined : pos(input.height, "leader.height");
  const style = optStyle(input.style, "leader.style");
  return {
    type: "leader",
    layer: layerOf(input.layer),
    points,
    ...(value !== undefined ? { value } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

export function makeMLeader(input: Record<string, unknown>): MLeaderAnnotation {
  const arrow = ptOf(input.arrow, "mleader.arrow");
  const landing = ptOf(input.landing, "mleader.landing");
  if (dist(arrow, landing) <= EPS) {
    throw new AnnotationError("mleader.arrow and landing must not coincide", "bad_input");
  }
  const value = nonEmpty(input.value, "mleader.value");
  const height = input.height === undefined || input.height === null ? undefined : pos(input.height, "mleader.height");
  const style = optStyle(input.style, "mleader.style");
  return {
    type: "mleader",
    layer: layerOf(input.layer),
    arrow,
    landing,
    value,
    ...(style !== undefined ? { style } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

// ---------------------------------------------------------------------------
// Element ⇄ annotation mapping.
// ---------------------------------------------------------------------------

function isTuplePt(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";
}

function tupleToPt(v: unknown): Pt | null {
  return isTuplePt(v) ? { x: v[0], y: v[1] } : null;
}

/** Soft check: is this element a CAD-PARITY-005 annotation? */
export function isAnnotationElement(el: Element): boolean {
  if (el.kind !== "annotation") return false;
  const p = el.props as Record<string, unknown>;
  if (p.annotation === true) return true;
  // Legacy COMPAT-CAD-001 dims (drafting:true + dim-* types, tuple points).
  return p.drafting === true && (p.type === "dim-linear" || p.type === "dim-radius");
}

/** Write an annotation to element props (flat canonical convention). */
export function annotationToProps(a: Annotation): Record<string, unknown> {
  const props: Record<string, unknown> = {
    drafting: true,
    annotation: true,
    type: a.type,
    layer: a.layer,
  };
  switch (a.type) {
    case "text":
      props.x = a.x; props.y = a.y; props.height = a.height;
      props.rotation = a.rotation; props.value = a.value;
      if (a.style !== undefined) props.style = a.style;
      if (a.hAlign !== undefined && a.hAlign !== "left") props.hAlign = a.hAlign;
      if (a.vAlign !== undefined && a.vAlign !== "baseline") props.vAlign = a.vAlign;
      break;
    case "mtext":
      props.x = a.x; props.y = a.y; props.height = a.height; props.width = a.width;
      props.rotation = a.rotation; props.value = a.value;
      if (a.style !== undefined) props.style = a.style;
      if (a.attachment !== undefined && a.attachment !== "top-left") props.attachment = a.attachment;
      break;
    case "dim-linear":
      props.p1 = a.p1; props.p2 = a.p2; props.mode = a.mode;
      if (a.angle !== undefined) props.angle = a.angle;
      props.offset = a.offset; props.measured = a.measured;
      if (a.style !== undefined) props.style = a.style;
      if (a.textOverride !== undefined) props.textOverride = a.textOverride;
      if (a.textPos !== undefined) props.textPos = a.textPos;
      if (a.refs !== undefined) props.refs = a.refs;
      break;
    case "dim-radius":
      props.target = a.target; props.center = a.center; props.radius = a.radius;
      if (a.at !== undefined) props.at = a.at;
      props.measured = a.measured;
      if (a.style !== undefined) props.style = a.style;
      if (a.textOverride !== undefined) props.textOverride = a.textOverride;
      if (a.textPos !== undefined) props.textPos = a.textPos;
      break;
    case "dim-diameter":
      props.target = a.target; props.center = a.center; props.radius = a.radius;
      props.angle = a.angle; props.measured = a.measured;
      if (a.style !== undefined) props.style = a.style;
      if (a.textOverride !== undefined) props.textOverride = a.textOverride;
      if (a.textPos !== undefined) props.textPos = a.textPos;
      break;
    case "dim-angular":
      props.vertex = a.vertex; props.startAngle = a.startAngle;
      props.endAngle = a.endAngle; props.radius = a.radius; props.measured = a.measured;
      if (a.style !== undefined) props.style = a.style;
      if (a.textOverride !== undefined) props.textOverride = a.textOverride;
      if (a.textPos !== undefined) props.textPos = a.textPos;
      if (a.refs !== undefined) props.refs = a.refs;
      break;
    case "leader":
      props.points = a.points;
      if (a.value !== undefined) props.value = a.value;
      if (a.style !== undefined) props.style = a.style;
      if (a.height !== undefined) props.height = a.height;
      break;
    case "mleader":
      props.arrow = a.arrow; props.landing = a.landing; props.value = a.value;
      if (a.style !== undefined) props.style = a.style;
      if (a.height !== undefined) props.height = a.height;
      break;
  }
  return props;
}

/** Strict parse of an annotation element (LOCK-007: throws on malformed
 *  props — re-validated through the constructors). Legacy COMPAT-CAD-001
 *  dims load with defaults. */
export function elementToAnnotation(el: Element): Annotation {
  if (!isAnnotationElement(el)) {
    throw new AnnotationError(`element '${el.id}' is not a CAD-PARITY-005 annotation`, "bad_input");
  }
  const p = el.props as Record<string, unknown>;
  switch (p.type) {
    case "text":
      return makeText(p);
    case "mtext":
      return makeMText(p);
    case "dim-linear": {
      // Legacy convention: tuple points, mode without angle.
      const p1 = isTuplePt(p.p1) ? tupleToPt(p.p1)! : ptOf(p.p1, "dim-linear.p1");
      const p2 = isTuplePt(p.p2) ? tupleToPt(p.p2)! : ptOf(p.p2, "dim-linear.p2");
      const mode = p.mode === "horizontal" || p.mode === "vertical" || p.mode === "rotated" ? p.mode : "aligned";
      const angle = typeof p.angle === "number" ? p.angle : undefined;
      const offset = typeof p.offset === "number" ? p.offset : 0;
      const measured = linearMeasured(p1, p2, mode, angle);
      if (measured <= EPS) {
        throw new AnnotationError(`element '${el.id}': dim-linear projected extent is zero`, "bad_input");
      }
      const styleL = optStyle(p.style, "dim-linear.style");
      const textOverrideL = optTextOverride(p.textOverride);
      const textPosL = optTextPos(p.textPos);
      const refsL = optRefs(p.refs);
      return {
        type: "dim-linear",
        layer: layerOf(p.layer),
        p1,
        p2,
        mode,
        ...(angle !== undefined ? { angle } : {}),
        offset,
        measured,
        ...(styleL !== undefined ? { style: styleL } : {}),
        ...(textOverrideL !== undefined ? { textOverride: textOverrideL } : {}),
        ...(textPosL !== undefined ? { textPos: textPosL } : {}),
        ...(refsL !== undefined ? { refs: refsL } : {}),
      };
    }
    case "dim-radius": {
      // Legacy convention: target + measured only (self-contained render
      // snapshot synthesized from the measured radius at the origin).
      const target = typeof p.target === "string" && p.target.length > 0 ? p.target : null;
      const center = p.center === undefined
        ? { x: 0, y: 0 }
        : isTuplePt(p.center)
          ? tupleToPt(p.center)!
          : ptOf(p.center, "dim-radius.center");
      const radius = typeof p.radius === "number" ? p.radius : pos(p.measured, "dim-radius.measured");
      const measured = typeof p.measured === "number" ? p.measured : radius;
      if (Math.abs(measured - radius) > EPS) {
        throw new AnnotationError(`element '${el.id}': dim-radius.measured must equal the radius`, "bad_input");
      }
      const at = p.at === undefined || p.at === null
        ? undefined
        : isTuplePt(p.at)
          ? tupleToPt(p.at)!
          : ptOf(p.at, "dim-radius.at");
      const styleR = optStyle(p.style, "dim-radius.style");
      const textOverrideR = optTextOverride(p.textOverride);
      const textPosR = optTextPos(p.textPos);
      return {
        type: "dim-radius",
        layer: layerOf(p.layer),
        target,
        center,
        radius,
        ...(at !== undefined ? { at } : {}),
        measured,
        ...(styleR !== undefined ? { style: styleR } : {}),
        ...(textOverrideR !== undefined ? { textOverride: textOverrideR } : {}),
        ...(textPosR !== undefined ? { textPos: textPosR } : {}),
      };
    }
    case "dim-diameter":
      return makeDimDiameter(p);
    case "dim-angular":
      return makeDimAngular(p);
    case "leader":
      return makeLeader({
        ...p,
        points: Array.isArray(p.points)
          ? p.points.map((q) => (isTuplePt(q) ? tupleToPt(q)! : q))
          : p.points,
      });
    case "mleader":
      return makeMLeader(p);
    default:
      throw new AnnotationError(`element '${el.id}': unknown annotation type '${String(p.type)}'`, "bad_input");
  }
}

/** Soft load: the annotation view of an element, or null (malformed props
 *  read as "not an annotation" — honest readers never throw; write paths
 *  validate strictly). */
export function annotationFromElement(el: Element): Annotation | null {
  if (!isAnnotationElement(el)) return null;
  try {
    return elementToAnnotation(el);
  } catch {
    return null;
  }
}

/** Which element ids does this annotation reference (associativity)? */
export function annotationRefIds(a: Annotation): readonly string[] {
  switch (a.type) {
    case "dim-radius":
      return a.target !== null ? [a.target] : [];
    case "dim-diameter":
      return a.target !== null ? [a.target] : [];
    case "dim-linear":
      return (a.refs ?? []).map((r) => r.id);
    case "dim-angular":
      return (a.refs ?? []).map((r) => r.id);
    default:
      return [];
  }
}
