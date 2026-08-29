/**
 * CAD-PARITY-008 Sheet/Plot IR (Issue #88) — the canonical, engine-independent
 * intermediate representation of ONE layout's plotted sheet.
 *
 * The IR is the ADAPTER CONTRACT (the docs/export.ts Sheet-IR precedent):
 * the plot PREVIEW, the SVG writer, the PDF writer and both hosts' paper
 * canvases all consume THIS representation, so the preview uses the exact
 * same semantic transforms as the final export path (Issue #88 acceptance
 * #4 — parity by construction, LOCK-004).
 *
 * Pure + deterministic (LOCK-003/018): identical (layout, viewports,
 * elements, layers, styles) → byte-identical IR → byte-identical exports.
 * Model geometry is REFERENCED through the viewports and projected on
 * demand — never copied into document state; the IR is DERIVED state,
 * recomputed fresh every call and never stored (the constraints-satisfaction
 * precedent: nothing derived is persisted stale).
 *
 * Plot semantics (bounded, documented):
 * - Each viewport projects model space through the shared transform
 *   (transform.ts): paper = vpCenter + R(θ)·((model − camera) / denominator).
 * - Lineweights plot as LITERAL paper mm; dash patterns scale with the
 *   viewport (dash_model / denominator — the PSLTSCALE 0 behavior); text
 *   height scales with the viewport (model height / denominator).
 * - The page-setup plot policy maps the sheet onto the output page:
 *   "fit" ≡ 1:1 (a layout IS the paper); "N:M" scales the whole sheet by
 *   M/N about the sheet origin. The plot offset (or "center the plot")
 *   translates the sheet CONTENT (viewport frames + projected geometry)
 *   relative to the sheet before scaling; the sheet frame/margins are
 *   paper furniture and stay anchored.
 * - Curve primitives stay EXACT (circles/arcs/ellipses are curves, not
 *   polylines); every writer applies NATIVE rectangular clipping (SVG
 *   clipPath, PDF re W n, canvas clip) — the IR only carries a coarse
 *   bbox inclusion gate per primitive so unbounded geometry (rays/xlines)
 *   and far-away content stay bounded.
 */

import type {
  DimStyleRecord,
  DrawingStandards,
  Element,
  LayerRecord,
  LayoutRecord,
  LtypeRecord,
  TextStyleRecord,
  ViewportRecord,
} from "../../contracts/caddocument.js";
import { geomFromElement } from "../geometry/bridge.js";
import { splineToPolyline } from "../geometry/spline.js";
import type { Geom } from "../geometry/types.js";
import { annotationFromElement } from "../annotation/types.js";
import { annotationPrimitives, annotationStyleContext } from "../annotation/render.js";
import type { RenderPrimitive } from "../annotation/render.js";
import { displayOverridesOf, resolveDisplay } from "../standards/index.js";
import { orientedSheetSize, parsePlotScale, printableArea, type SheetRect } from "./paper.js";
import {
  bboxIntersectsRect,
  clipSegment,
  modelToPaper,
  viewportRect,
  type PaperPt,
  type ViewportRect,
} from "./transform.js";

/** The Plot IR format identity (additive versioning per api-contract.md §8). */
export const PLOT_IR_FORMAT = "offisos-plot-ir" as const;
export const PLOT_IR_FORMAT_VERSION = "1" as const;

/** A resolved plot stroke (paper-space values). */
export interface PlotStroke {
  /** Hex color `#RRGGBB`. */
  readonly color: string;
  /** Lineweight in paper mm (literal — the documented plot policy). */
  readonly lineweightMm: number;
  /** Dash/gap pattern in paper mm (empty = solid). */
  readonly dashMm: readonly number[];
  /** Alpha 0–1 (resolved transparency). */
  readonly alpha: number;
}

/** One plot primitive in SHEET millimetres (y-up from the sheet's lower-left;
 *  the plot offset is already applied — writers only apply the sheet scale). */
export type PlotPrimitive =
  | { readonly kind: "segment"; readonly a: PaperPt; readonly b: PaperPt; readonly stroke: PlotStroke }
  | { readonly kind: "polyline"; readonly points: readonly PaperPt[]; readonly closed: boolean; readonly stroke: PlotStroke }
  | { readonly kind: "circle"; readonly c: PaperPt; readonly r: number; readonly stroke: PlotStroke }
  | { readonly kind: "arc"; readonly c: PaperPt; readonly r: number; readonly start: number; readonly end: number; readonly stroke: PlotStroke }
  | { readonly kind: "ellipse"; readonly c: PaperPt; readonly rx: number; readonly ry: number; readonly rotation: number; readonly stroke: PlotStroke }
  | {
      readonly kind: "text";
      readonly at: PaperPt;
      readonly value: string;
      readonly height: number;
      /** Radians CCW in sheet coordinates. */
      readonly rotation: number;
      readonly font: "sans" | "mono" | "serif";
      readonly widthFactor: number;
      readonly oblique: number;
      readonly hAlign: "left" | "center" | "right";
      readonly vAlign: "baseline" | "bottom" | "middle" | "top";
      readonly fill: string;
    }
  | {
      readonly kind: "arrow";
      readonly at: PaperPt;
      /** Unit direction the tip points along (sheet coords). */
      readonly dir: PaperPt;
      readonly size: number;
      readonly style: "closed" | "tick" | "none";
      readonly stroke: PlotStroke;
    };

/** One viewport's projected content inside the IR. */
export interface PlotViewportEntry {
  readonly id: string;
  /** The paper rectangle (plot offset applied — the clip rectangle). */
  readonly rect: ViewportRect;
  readonly locked: boolean;
  readonly scaleDenominator: number;
  readonly rotationDeg: number;
  readonly primitiveCount: number;
  readonly primitives: readonly PlotPrimitive[];
}

/** The resolved plot policy of the page setup. */
export interface PlotPolicy {
  /** The declared ratio (1,1 for "fit"). */
  readonly scaleN: number;
  readonly scaleM: number;
  /** Output mm per paper mm (M/N; 1 for "fit"). */
  readonly sheetScale: number;
  /** The content translation in paper mm (plot origin / centering). */
  readonly offsetXMm: number;
  readonly offsetYMm: number;
  /** The output page size (sheet × sheetScale). */
  readonly outputWidthMm: number;
  readonly outputHeightMm: number;
  readonly styleKind: "none" | "ctb" | "stb";
  readonly styleTable: string | null;
  readonly plotViewports: boolean;
}

/** The canonical Plot IR artifact of ONE layout. */
export interface PlotIR {
  readonly format: typeof PLOT_IR_FORMAT;
  readonly formatVersion: typeof PLOT_IR_FORMAT_VERSION;
  readonly layout: { readonly id: string; readonly name: string };
  readonly sheet: { readonly widthMm: number; readonly heightMm: number; readonly printable: SheetRect };
  readonly plot: PlotPolicy;
  /** Paper-space composition furniture (sheet boundary + printable-area
   *  frame): visually distinct from model geometry by construction. */
  readonly frame: { readonly primitives: readonly PlotPrimitive[] };
  readonly viewports: readonly PlotViewportEntry[];
  readonly primitiveCount: number;
}

/** The document inputs the IR is derived from (pure data — no document
 *  dependency so BOTH hosts build the identical IR client/server-side). */
export interface PlotIRInput {
  readonly layout: LayoutRecord;
  readonly viewports: readonly ViewportRecord[];
  readonly elements: readonly Element[];
  readonly layers: readonly LayerRecord[];
  readonly ltypes: readonly LtypeRecord[];
  readonly textStyles: readonly TextStyleRecord[];
  readonly dimStyles: readonly DimStyleRecord[];
  readonly standards?: DrawingStandards;
}

// --- Frame furniture constants (deterministic, documented) -------------------

const FRAME_COLOR = "#64748b";
const FRAME_LINEWEIGHT = 0.1;
const FRAME_DASH: readonly number[] = [2, 1.5, 2, 1.5];
const VIEWPORT_BORDER_COLOR = "#1f2937";
const VIEWPORT_BORDER_LOCKED_COLOR = "#b45309";
const VIEWPORT_BORDER_LINEWEIGHT = 0.18;

function frameStroke(color: string): PlotStroke {
  return { color, lineweightMm: FRAME_LINEWEIGHT, dashMm: [], alpha: 1 };
}

/** Effective per-layer plot visibility inside one viewport (the layer table
 *  composed with the viewport's overrides — the VPLAYER surface). */
function layerPlotsInViewport(
  vp: ViewportRecord,
  layerId: string,
  layer: LayerRecord | undefined,
): boolean {
  if (layer === undefined) return true;
  const override = (vp.layerOverrides ?? []).find((o) => o.layerId === layerId);
  const visible = override?.visible ?? layer.visible;
  const frozen = override?.frozen ?? layer.frozen === true;
  if (!visible || frozen) return false;
  if (layer.plot === false) return false;
  return true;
}

/** Project one model geometry into paper primitives through a viewport
 *  (coarse bbox gate per primitive; exact curves kept — writers clip). */
function projectGeometry(geom: Geom, vp: ViewportRecord, rect: ViewportRect, stroke: PlotStroke): PlotPrimitive[] {
  const d = vp.scaleDenominator;
  const out: PlotPrimitive[] = [];
  const T = (x: number, y: number): PaperPt => modelToPaper(vp, rect, { x, y });
  switch (geom.type) {
    case "line": {
      const a = T(geom.x1, geom.y1);
      const b = T(geom.x2, geom.y2);
      if (clipSegment(rect, a, b) !== null) out.push({ kind: "segment", a, b, stroke });
      return out;
    }
    case "polyline": {
      if (geom.vertices.length < 2) return out;
      const pts = geom.vertices.map((v) => T(v.x, v.y));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (bboxIntersectsRect(rect, { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) })) {
        out.push({ kind: "polyline", points: pts, closed: geom.closed, stroke });
      }
      return out;
    }
    case "circle": {
      const c = T(geom.cx, geom.cy);
      const r = geom.r / d;
      if (bboxIntersectsRect(rect, { x1: c.x - r, y1: c.y - r, x2: c.x + r, y2: c.y + r })) {
        out.push({ kind: "circle", c, r, stroke });
      }
      return out;
    }
    case "arc": {
      const c = T(geom.cx, geom.cy);
      const r = geom.r / d;
      if (bboxIntersectsRect(rect, { x1: c.x - r, y1: c.y - r, x2: c.x + r, y2: c.y + r })) {
        // The view twist rotates the arc's angular window (radians CCW).
        const theta = (vp.rotationDeg * Math.PI) / 180;
        out.push({ kind: "arc", c, r, start: geom.startAngle + theta, end: geom.endAngle + theta, stroke });
      }
      return out;
    }
    case "ellipse": {
      const c = T(geom.cx, geom.cy);
      const rx = geom.rx / d;
      const ry = geom.ry / d;
      const rr = Math.max(rx, ry);
      if (bboxIntersectsRect(rect, { x1: c.x - rr, y1: c.y - rr, x2: c.x + rr, y2: c.y + rr })) {
        const theta = (vp.rotationDeg * Math.PI) / 180;
        out.push({ kind: "ellipse", c, rx, ry, rotation: geom.rotation + theta, stroke });
      }
      return out;
    }
    case "spline": {
      const sampled = splineToPolyline(geom.controlPoints, geom.degree);
      if (sampled.length < 2) return out;
      const pts = sampled.map((v) => T(v.x, v.y));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (bboxIntersectsRect(rect, { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) })) {
        out.push({ kind: "polyline", points: pts, closed: false, stroke });
      }
      return out;
    }
    case "point":
      // Points are editor construction aids in this slice — not plotted
      // (documented bounded rule).
      return out;
    case "ray":
    case "xline": {
      // Infinite lines clip to the viewport rectangle (the bounded
      // ray/xline plotting rule — a finite plotted segment).
      const base = T(geom.x1, geom.y1);
      const dirPt = T(geom.x2, geom.y2);
      const dx = dirPt.x - base.x;
      const dy = dirPt.y - base.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-18) return out;
      const big = 1e7;
      const clipped = clipSegment(rect, { x: base.x - dx * big, y: base.y - dy * big }, { x: base.x + dx * big, y: base.y + dy * big });
      if (clipped !== null) out.push({ kind: "segment", a: clipped.a, b: clipped.b, stroke });
      return out;
    }
    case "region": {
      const boundary = geom.boundary;
      if (boundary.kind === "circle") {
        return projectGeometry({ type: "circle", cx: boundary.cx, cy: boundary.cy, r: boundary.r }, vp, rect, stroke);
      }
      if (boundary.kind === "ellipse") {
        return projectGeometry(
          { type: "ellipse", cx: boundary.cx, cy: boundary.cy, rx: boundary.rx, ry: boundary.ry, rotation: boundary.rotation },
          vp,
          rect,
          stroke,
        );
      }
      return projectGeometry(
        { type: "polyline", vertices: boundary.vertices, closed: true },
        vp,
        rect,
        stroke,
      );
    }
    default:
      return out;
  }
}

/** Project one annotation's render primitives into paper primitives. */
function projectAnnotationPrimitives(
  primitives: readonly RenderPrimitive[],
  vp: ViewportRecord,
  rect: ViewportRect,
  stroke: PlotStroke,
): PlotPrimitive[] {
  const d = vp.scaleDenominator;
  const theta = (vp.rotationDeg * Math.PI) / 180;
  const out: PlotPrimitive[] = [];
  for (const p of primitives) {
    if (p.kind === "segment") {
      const a = modelToPaper(vp, rect, p.a);
      const b = modelToPaper(vp, rect, p.b);
      if (clipSegment(rect, a, b) !== null) out.push({ kind: "segment", a, b, stroke });
    } else if (p.kind === "arrow") {
      const at = modelToPaper(vp, rect, p.at);
      if (at.x >= rect.x1 && at.x <= rect.x2 && at.y >= rect.y1 && at.y <= rect.y2) {
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const dir = { x: p.dir.x * c - p.dir.y * s, y: p.dir.x * s + p.dir.y * c };
        out.push({ kind: "arrow", at, dir, size: p.size / d, style: p.style, stroke });
      }
    } else {
      const at = modelToPaper(vp, rect, p.at);
      if (at.x >= rect.x1 && at.x <= rect.x2 && at.y >= rect.y1 && at.y <= rect.y2) {
        out.push({
          kind: "text",
          at,
          value: p.value,
          height: p.height / d,
          rotation: p.rotation + theta,
          font: p.font,
          widthFactor: p.widthFactor,
          oblique: p.oblique,
          hAlign: p.hAlign,
          vAlign: p.vAlign,
          fill: stroke.color,
        });
      }
    }
  }
  return out;
}

/** Build the Plot IR for one layout against the CURRENT document state.
 *  Deterministic: the same inputs produce the byte-identical IR (canonical
 *  serialization + hashing live at the App API layer — this module stays
 *  crypto-free for the browser bundle). */
export function buildPlotIR(input: PlotIRInput): PlotIR {
  const { layout } = input;
  const sheet = orientedSheetSize(layout.pageSetup);
  const printable = printableArea(layout.pageSetup);
  const scale = parsePlotScale(layout.pageSetup.plotScale);
  const scaleN = scale.mode === "fit" ? 1 : scale.numerator;
  const scaleM = scale.mode === "fit" ? 1 : scale.denominator;
  const sheetScale = scaleM / scaleN;

  const layoutViewports = input.viewports.filter((v) => v.layoutId === layout.id);
  // The plot offset: "center the plot" centers the CONTENT bbox (viewport
  // frames) in the printable area; otherwise the explicit plot origin.
  let offsetXMm = layout.pageSetup.plotOriginMm[0];
  let offsetYMm = layout.pageSetup.plotOriginMm[1];
  if (layout.pageSetup.centerPlot && layoutViewports.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const vp of layoutViewports) {
      const r = viewportRect(vp);
      minX = Math.min(minX, r.x1);
      minY = Math.min(minY, r.y1);
      maxX = Math.max(maxX, r.x2);
      maxY = Math.max(maxY, r.y2);
    }
    offsetXMm = printable.x + printable.w / 2 - (minX + maxX) / 2;
    offsetYMm = printable.y + printable.h / 2 - (minY + maxY) / 2;
  }

  // Frame furniture: the sheet boundary + the printable-area frame (dashed).
  const frame: PlotPrimitive[] = [];
  const sheetStroke = frameStroke(FRAME_COLOR);
  frame.push(
    { kind: "segment", a: { x: 0, y: 0 }, b: { x: sheet.widthMm, y: 0 }, stroke: sheetStroke },
    { kind: "segment", a: { x: sheet.widthMm, y: 0 }, b: { x: sheet.widthMm, y: sheet.heightMm }, stroke: sheetStroke },
    { kind: "segment", a: { x: sheet.widthMm, y: sheet.heightMm }, b: { x: 0, y: sheet.heightMm }, stroke: sheetStroke },
    { kind: "segment", a: { x: 0, y: sheet.heightMm }, b: { x: 0, y: 0 }, stroke: sheetStroke },
  );
  const printableStroke: PlotStroke = { color: FRAME_COLOR, lineweightMm: FRAME_LINEWEIGHT, dashMm: FRAME_DASH, alpha: 1 };
  frame.push(
    { kind: "segment", a: { x: printable.x, y: printable.y }, b: { x: printable.x + printable.w, y: printable.y }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x + printable.w, y: printable.y }, b: { x: printable.x + printable.w, y: printable.y + printable.h }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x + printable.w, y: printable.y + printable.h }, b: { x: printable.x, y: printable.y + printable.h }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x, y: printable.y + printable.h }, b: { x: printable.x, y: printable.y }, stroke: printableStroke },
  );

  // Viewport borders (plotted when plotViewports; offset applied).
  const plotViewports = layout.pageSetup.plotViewports !== false;
  if (plotViewports) {
    for (const vp of layoutViewports) {
      const r = viewportRect(vp);
      const x1 = r.x1 + offsetXMm;
      const y1 = r.y1 + offsetYMm;
      const x2 = r.x2 + offsetXMm;
      const y2 = r.y2 + offsetYMm;
      const stroke: PlotStroke = {
        color: vp.locked === true ? VIEWPORT_BORDER_LOCKED_COLOR : VIEWPORT_BORDER_COLOR,
        lineweightMm: VIEWPORT_BORDER_LINEWEIGHT,
        dashMm: [],
        alpha: 1,
      };
      frame.push(
        { kind: "segment", a: { x: x1, y: y1 }, b: { x: x2, y: y1 }, stroke },
        { kind: "segment", a: { x: x2, y: y1 }, b: { x: x2, y: y2 }, stroke },
        { kind: "segment", a: { x: x2, y: y2 }, b: { x: x1, y: y2 }, stroke },
        { kind: "segment", a: { x: x1, y: y2 }, b: { x: x1, y: y1 }, stroke },
      );
    }
  }

  // Per-viewport projected content (table order; later viewports render on
  // top — the deterministic z-order).
  const layerById = new Map<string, LayerRecord>();
  for (const layer of input.layers) layerById.set(layer.id, layer);
  const styleCtx = annotationStyleContext(input.textStyles, input.dimStyles, input.standards?.annotationScale);
  const entries: PlotViewportEntry[] = [];
  let primitiveCount = frame.length;
  for (const vp of layoutViewports) {
    const baseRect = viewportRect(vp);
    const rect: ViewportRect = {
      x1: baseRect.x1 + offsetXMm,
      y1: baseRect.y1 + offsetYMm,
      x2: baseRect.x2 + offsetXMm,
      y2: baseRect.y2 + offsetYMm,
    };
    const projected: PlotPrimitive[] = [];
    for (const el of input.elements) {
      const props = el.props as Record<string, unknown>;
      const layerId = typeof props.layer === "string" ? props.layer : null;
      const layer = layerId !== null ? layerById.get(layerId) : undefined;
      if (layerId !== null && !layerPlotsInViewport(vp, layerId, layer)) continue;
      const stroke = layer === undefined
        ? { color: "#111827", lineweightMm: 0.25, dashMm: [], alpha: 1 }
        : strokeOf(props, layer, input);
      if (el.kind === "annotation") {
        const annotation = annotationFromElement(el);
        if (annotation === null) continue;
        projected.push(...projectAnnotationPrimitives(annotationPrimitives(annotation, styleCtx), vp, rect, stroke));
        continue;
      }
      const geom = geomFromElement(el);
      if (geom === null) continue;
      projected.push(...projectGeometry(geom, vp, rect, stroke));
    }
    primitiveCount += projected.length;
    entries.push({
      id: vp.id,
      rect,
      locked: vp.locked === true,
      scaleDenominator: vp.scaleDenominator,
      rotationDeg: vp.rotationDeg,
      primitiveCount: projected.length,
      primitives: projected,
    });
  }

  return {
    format: PLOT_IR_FORMAT,
    formatVersion: PLOT_IR_FORMAT_VERSION,
    layout: { id: layout.id, name: layout.name },
    sheet: { widthMm: sheet.widthMm, heightMm: sheet.heightMm, printable },
    plot: {
      scaleN,
      scaleM,
      sheetScale,
      offsetXMm,
      offsetYMm,
      outputWidthMm: sheet.widthMm * sheetScale,
      outputHeightMm: sheet.heightMm * sheetScale,
      styleKind: layout.pageSetup.plotStyleKind,
      styleTable: layout.pageSetup.plotStyleTable,
      plotViewports,
    },
    frame: { primitives: frame },
    viewports: entries,
    primitiveCount,
  };
}

/** The world bounding box of the drafting GEOMETRY content (model units) —
 *  the deterministic extents the MVIEW "Fit" view computes from. Annotation
 *  elements are excluded (they hang off the measured geometry — the
 *  documented bounded rule); the empty model yields the canonical empty
 *  extents. */
export function modelExtentsOf(elements: readonly Element[]): ModelExtentsLike {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const el of elements) {
    if (el.kind !== "geometry") continue;
    const geom = geomFromElement(el);
    if (geom === null) continue;
    const box = geomBBox(geom);
    if (box === null) continue;
    any = true;
    minX = Math.min(minX, box.x1);
    minY = Math.min(minY, box.y1);
    maxX = Math.max(maxX, box.x2);
    maxY = Math.max(maxY, box.y2);
  }
  if (!any) return { minX: 0, minY: 0, maxX: 0, maxY: 0, empty: true };
  return { minX, minY, maxX, maxY, empty: false };
}

interface ModelExtentsLike {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly empty: boolean;
}

function geomBBox(geom: Geom): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null {
  switch (geom.type) {
    case "line":
      return { x1: Math.min(geom.x1, geom.x2), y1: Math.min(geom.y1, geom.y2), x2: Math.max(geom.x1, geom.x2), y2: Math.max(geom.y1, geom.y2) };
    case "polyline": {
      if (geom.vertices.length === 0) return null;
      const xs = geom.vertices.map((v) => v.x);
      const ys = geom.vertices.map((v) => v.y);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    case "circle":
    case "arc":
      return { x1: geom.cx - geom.r, y1: geom.cy - geom.r, x2: geom.cx + geom.r, y2: geom.cy + geom.r };
    case "ellipse":
      // The rotation-safe extent of an ellipse uses its axis-aligned bounds
      // of the rotated axes (conservative exact bound for the fitted view).
      return { x1: geom.cx - Math.max(geom.rx, geom.ry), y1: geom.cy - Math.max(geom.rx, geom.ry), x2: geom.cx + Math.max(geom.rx, geom.ry), y2: geom.cy + Math.max(geom.rx, geom.ry) };
    case "spline": {
      if (geom.controlPoints.length === 0) return null;
      const xs = geom.controlPoints.map((v) => v.x);
      const ys = geom.controlPoints.map((v) => v.y);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    case "point":
      return { x1: geom.x, y1: geom.y, x2: geom.x, y2: geom.y };
    case "ray":
    case "xline":
      return { x1: Math.min(geom.x1, geom.x2), y1: Math.min(geom.y1, geom.y2), x2: Math.max(geom.x1, geom.x2), y2: Math.max(geom.y1, geom.y2) };
    case "region": {
      const boundary = geom.boundary;
      if (boundary.kind === "circle") {
        return { x1: boundary.cx - boundary.r, y1: boundary.cy - boundary.r, x2: boundary.cx + boundary.r, y2: boundary.cy + boundary.r };
      }
      if (boundary.kind === "ellipse") {
        const rr = Math.max(boundary.rx, boundary.ry);
        return { x1: boundary.cx - rr, y1: boundary.cy - rr, x2: boundary.cx + rr, y2: boundary.cy + rr };
      }
      if (boundary.vertices.length === 0) return null;
      const xs = boundary.vertices.map((v) => v.x);
      const ys = boundary.vertices.map((v) => v.y);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    default:
      return null;
  }
}

function strokeOf(props: Readonly<Record<string, unknown>>, layer: LayerRecord, input: PlotIRInput): PlotStroke {
  const display = resolveDisplay(displayOverridesOf(props), layer, input.standards, input.ltypes);
  return {
    color: display.color,
    lineweightMm: display.lineweight,
    dashMm: display.dash,
    alpha: Math.max(0, Math.min(1, 1 - display.transparency / 100)),
  };
}

/** Build the Plot IRs for EVERY layout (the PUBLISH batch — deterministic
 *  order: layout table order). */
export function buildAllPlotIRs(input: Omit<PlotIRInput, "layout" | "viewports"> & { readonly layouts: readonly LayoutRecord[]; readonly viewports: readonly ViewportRecord[] }): PlotIR[] {
  return input.layouts.map((layout) =>
    buildPlotIR({ ...input, layout, viewports: input.viewports.filter((v) => v.layoutId === layout.id) }),
  );
}
