/**
 * CAD-PARITY-014 (Issue #107) — the Sheet IR → Plot IR bridge (D4):
 * `docs.exportSheet` pdf/svg.
 *
 * The Sheet IR (docs/export.ts — the COMPAT-CAD-003 canonical contract)
 * bridges onto the EXISTING deterministic plot writers
 * (workspace/layouts/pdf.ts plotIRToPDF, svg.ts plotIRToSVG): the sheet
 * frame maps to a synthetic A1-landscape PlotIR at IDENTITY scale (the
 * Sheet IR placements are already resolved sheet-space mm), the title-block
 * strip becomes frame furniture (the border + the block box + the fields as
 * text primitives — the titleBlockFrame discipline of layouts/ir.ts), and
 * each placed view becomes one viewport whose primitives are the view's
 * projected ViewPrimitives mapped from view space into the placement
 * rectangle (the documented FIT mapping) with a deterministic default
 * stroke (black #000000, 0.25 mm, no dash). Circles/arcs stay CURVES — the
 * exact-curve contract (never flattened).
 *
 * Documented bounded decisions (LOCK-007 — never silent):
 *  - printable area = the full frame minus a 10 mm margin (all sides);
 *  - the view fit mapping: uniform scale = min(w/bboxW, h/bboxH), centered
 *    in the placement rectangle (the empty view maps nothing);
 *  - view text primitives render at the documented 3.5 mm sheet height;
 *  - annotations: docs.note renders at its authored anchor; docs.tag renders
 *    its derived label anchored at the top-left of the target's projected
 *    primitive bbox (+2 mm); docs.dim renders the derived measured value at
 *    the derived dimension-line position (the midpoint of the two reference
 *    bboxes offset along the perpendicular axis) — the VALUE text only, the
 *    full dimension geometry (extension lines/arrows) is beyond this writer
 *    and is represented in the exchange report classification; dangling
 *    annotations (no derived value) are skipped, never approximated.
 *
 * Pure + engine-free (LOCK-018). Deterministic: fixed construction order,
 * identical IR → byte-identical PDF/SVG on every host (the writers' own
 * invariant).
 */

import type { DocsTitleBlock } from "../contracts/caddocument.js";
import type { SheetIR, SheetIRView } from "../docs/export.js";
import type { ViewPrimitive } from "../docs/project.js";
import {
  PLOT_IR_FORMAT,
  PLOT_IR_FORMAT_VERSION,
  type PlotIR,
  type PlotPrimitive,
  type PlotStroke,
  type PlotViewportEntry,
} from "../workspace/layouts/ir.js";
import type { SheetRect } from "../workspace/layouts/paper.js";
import type { DocsDimProps, DocsNoteProps, DocsTagProps } from "../docs/entities.js";

/** The documented printable margin (mm, all sides). */
const SHEET_EXPORT_MARGIN_MM = 10;

/** The documented default stroke of placed view content (black, 0.25 mm). */
const VIEW_STROKE: PlotStroke = { color: "#000000", lineweightMm: 0.25, dashMm: [], alpha: 1 };

/** The documented default text height of view text + annotations (mm). */
const SHEET_TEXT_HEIGHT_MM = 3.5;

/** The furniture strokes (the layouts/ir.ts furniture vocabulary). */
const FRAME_STROKE: PlotStroke = { color: "#64748b", lineweightMm: 0.1, dashMm: [], alpha: 1 };
const FRAME_DASH: readonly number[] = [2, 1.5, 2, 1.5];
const TITLEBLOCK_STROKE: PlotStroke = { color: "#1f2937", lineweightMm: 0.18, dashMm: [], alpha: 1 };
const TITLEBLOCK_COLOR = "#1f2937";

/** The title-block row height + text height (the documented layout). */
const TB_ROW_HEIGHT_MM = 20;
const TB_TEXT_HEIGHT_MM = 4;
const TB_INSET_MM = 2;

/** The value/view mapping (view space → sheet space) of one placed view. */
interface ViewFit {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

function viewFit(view: SheetIRView): ViewFit | null {
  const bbox = view.bbox;
  if (bbox === null) return null;
  const bw = bbox.uMax - bbox.uMin;
  const bh = bbox.vMax - bbox.vMin;
  if (!(bw > 0) || !(bh > 0)) return null;
  const scale = Math.min(view.placement.w / bw, view.placement.h / bh);
  const tx = view.placement.x + (view.placement.w - bw * scale) / 2 - bbox.uMin * scale;
  const ty = view.placement.y + (view.placement.h - bh * scale) / 2 - bbox.vMin * scale;
  return { scale, tx, ty };
}

/** The placed-view title (a text primitive at the rectangle's top edge). */
function viewTitlePrimitive(view: SheetIRView): PlotPrimitive {
  return {
    kind: "text",
    at: { x: view.placement.x + 2, y: view.placement.y + view.placement.h - 2 },
    value: `${view.title} (${view.kind})`,
    height: 3,
    rotation: 0,
    font: "sans",
    widthFactor: 1,
    oblique: 0,
    hAlign: "left",
    vAlign: "top",
    fill: "#334155",
  };
}

/** Map one ViewPrimitive into a PlotPrimitive through the fit mapping. */
function viewPrimitiveToPlot(p: ViewPrimitive, fit: ViewFit): PlotPrimitive {
  const X = (u: number): number => u * fit.scale + fit.tx;
  const Y = (v: number): number => v * fit.scale + fit.ty;
  switch (p.type) {
    case "line":
      return { kind: "segment", a: { x: X(p.from[0]), y: Y(p.from[1]) }, b: { x: X(p.to[0]), y: Y(p.to[1]) }, stroke: VIEW_STROKE };
    case "polyline":
      return {
        kind: "polyline",
        points: p.points.map((pt) => ({ x: X(pt[0]), y: Y(pt[1]) })),
        closed: p.closed,
        stroke: VIEW_STROKE,
      };
    case "circle":
      // Exact-curve contract: circles stay circles (scaled radius).
      return { kind: "circle", c: { x: X(p.center[0]), y: Y(p.center[1]) }, r: p.radius * fit.scale, stroke: VIEW_STROKE };
    case "arc":
      // Exact-curve contract: arcs stay arcs.
      return {
        kind: "arc",
        c: { x: X(p.center[0]), y: Y(p.center[1]) },
        r: p.radius * fit.scale,
        start: p.startAngle,
        end: p.endAngle,
        stroke: VIEW_STROKE,
      };
    case "text":
      return {
        kind: "text",
        at: { x: X(p.at[0]), y: Y(p.at[1]) },
        value: p.text,
        height: SHEET_TEXT_HEIGHT_MM,
        rotation: 0,
        font: "sans",
        widthFactor: 1,
        oblique: 0,
        hAlign: "left",
        vAlign: "baseline",
        fill: "#000000",
      };
  }
}

/** The projected-primitive bbox of one source (null when it has none). */
function sourceBBox(view: SheetIRView, sourceId: string): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let any = false;
  for (const raw of view.primitives) {
    const p = raw as ViewPrimitive;
    if (p.sourceId !== sourceId) continue;
    any = true;
    switch (p.type) {
      case "line":
        x1 = Math.min(x1, p.from[0], p.to[0]);
        y1 = Math.min(y1, p.from[1], p.to[1]);
        x2 = Math.max(x2, p.from[0], p.to[0]);
        y2 = Math.max(y2, p.from[1], p.to[1]);
        break;
      case "polyline":
        for (const pt of p.points) {
          x1 = Math.min(x1, pt[0]);
          y1 = Math.min(y1, pt[1]);
          x2 = Math.max(x2, pt[0]);
          y2 = Math.max(y2, pt[1]);
        }
        break;
      case "circle":
      case "arc":
        x1 = Math.min(x1, p.center[0] - p.radius);
        y1 = Math.min(y1, p.center[1] - p.radius);
        x2 = Math.max(x2, p.center[0] + p.radius);
        y2 = Math.max(y2, p.center[1] + p.radius);
        break;
      case "text":
        x1 = Math.min(x1, p.at[0]);
        y1 = Math.min(y1, p.at[1]);
        x2 = Math.max(x2, p.at[0]);
        y2 = Math.max(y2, p.at[1]);
        break;
    }
  }
  return any ? { x1, y1, x2, y2 } : null;
}

/** The view-space anchor bbox of one annotation's reference (the view bbox
 *  when the reference has no primitives — a deterministic fallback). */
function refBBox(view: SheetIRView, refId: string): { x1: number; y1: number; x2: number; y2: number } {
  const own = sourceBBox(view, refId);
  if (own !== null) return own;
  const bbox = view.bbox;
  if (bbox !== null) {
    return { x1: bbox.uMin, y1: bbox.vMin, x2: bbox.uMax, y2: bbox.vMax };
  }
  return { x1: 0, y1: 0, x2: 0, y2: 0 };
}

/** Map one view's ANNOTATIONS into text primitives (the documented bounded
 *  rendering — see the module header). Dangling annotations are skipped. */
function annotationPrimitives(view: SheetIRView, fit: ViewFit): PlotPrimitive[] {
  const out: PlotPrimitive[] = [];
  const X = (u: number): number => u * fit.scale + fit.tx;
  const Y = (v: number): number => v * fit.scale + fit.ty;
  const text = (u: number, v: number, value: string): PlotPrimitive => ({
    kind: "text",
    at: { x: X(u), y: Y(v) },
    value,
    height: SHEET_TEXT_HEIGHT_MM,
    rotation: 0,
    font: "sans",
    widthFactor: 1,
    oblique: 0,
    hAlign: "left",
    vAlign: "baseline",
    fill: "#000000",
  });
  for (const raw of view.annotations) {
    const annotation = raw as { id?: string; type?: string } & Partial<DocsNoteProps> & Partial<DocsTagProps> & Partial<DocsDimProps>;
    if (annotation.type === "docs.note" && typeof annotation.x === "number" && typeof annotation.y === "number" && typeof annotation.text === "string") {
      out.push(text(annotation.x, annotation.y, annotation.text));
      continue;
    }
    if (annotation.type === "docs.tag") {
      const targetId = annotation.targetId;
      if (typeof targetId !== "string") continue;
      if (annotation.dangling === true) continue;
      const bbox = refBBox(view, targetId);
      const value = typeof annotation.label === "string" ? annotation.label : targetId;
      // The documented tag anchor: the target's bbox top-left + 2 mm.
      out.push(text(bbox.x1, bbox.y2 + 2, value));
      continue;
    }
    if (annotation.type === "docs.dim") {
      const measured = annotation.measured;
      if (typeof measured !== "number" || !Number.isFinite(measured)) continue; // dangling — no honest value
      if (annotation.dangling === true) continue;
      const refs = annotation.refIds;
      if (!Array.isArray(refs) || refs.length !== 2 || typeof refs[0] !== "string" || typeof refs[1] !== "string") continue;
      const b1 = refBBox(view, refs[0]);
      const b2 = refBBox(view, refs[1]);
      const offset = typeof annotation.offset === "number" ? annotation.offset : 0;
      // The documented dimension-value anchor: the midpoint of the two
      // reference bboxes' centers, offset along the perpendicular axis.
      const u = annotation.axis === "y" ? Math.max(b1.x2, b2.x2) + offset : (b1.x1 + b1.x2 + b2.x1 + b2.x2) / 4;
      const v = annotation.axis === "y" ? (b1.y1 + b1.y2 + b2.y1 + b2.y2) / 4 : Math.max(b1.y2, b2.y2) + offset;
      out.push(text(u, v, String(Math.round(measured * 100) / 100)));
      continue;
    }
  }
  return out;
}

/** Build the synthetic Plot IR of one Sheet IR (the bridge the existing
 *  deterministic PDF/SVG writers consume). */
export function sheetIRToPlotIR(ir: SheetIR): PlotIR {
  const frame = ir.sheet.frame;
  const width = frame.width;
  const height = frame.height;
  const printable: SheetRect = {
    x: SHEET_EXPORT_MARGIN_MM,
    y: SHEET_EXPORT_MARGIN_MM,
    w: width - 2 * SHEET_EXPORT_MARGIN_MM,
    h: height - 2 * SHEET_EXPORT_MARGIN_MM,
  };

  // --- frame furniture: sheet border + printable area + the title block ------
  const framePrimitives: PlotPrimitive[] = [];
  framePrimitives.push(
    { kind: "segment", a: { x: 0, y: 0 }, b: { x: width, y: 0 }, stroke: FRAME_STROKE },
    { kind: "segment", a: { x: width, y: 0 }, b: { x: width, y: height }, stroke: FRAME_STROKE },
    { kind: "segment", a: { x: width, y: height }, b: { x: 0, y: height }, stroke: FRAME_STROKE },
    { kind: "segment", a: { x: 0, y: height }, b: { x: 0, y: 0 }, stroke: FRAME_STROKE },
  );
  const printableStroke: PlotStroke = { color: "#64748b", lineweightMm: 0.1, dashMm: FRAME_DASH, alpha: 1 };
  framePrimitives.push(
    { kind: "segment", a: { x: printable.x, y: printable.y }, b: { x: printable.x + printable.w, y: printable.y }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x + printable.w, y: printable.y }, b: { x: printable.x + printable.w, y: printable.y + printable.h }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x + printable.w, y: printable.y + printable.h }, b: { x: printable.x, y: printable.y + printable.h }, stroke: printableStroke },
    { kind: "segment", a: { x: printable.x, y: printable.y + printable.h }, b: { x: printable.x, y: printable.y }, stroke: printableStroke },
  );
  // The title-block strip: the block box on the right edge + one horizontal
  // rule per row boundary + one text primitive per field (rows stack from
  // the TOP — the titleBlockFrame discipline).
  const tbX = width - frame.titleBlockWidth;
  const titleBlock = ir.sheet.titleBlock;
  const rows = titleBlockRows(titleBlock);
  framePrimitives.push(
    { kind: "segment", a: { x: tbX, y: 0 }, b: { x: tbX, y: height }, stroke: TITLEBLOCK_STROKE },
  );
  for (let i = 0; i < rows.length - 1; i += 1) {
    const ruleY = height - (i + 1) * TB_ROW_HEIGHT_MM;
    framePrimitives.push({ kind: "segment", a: { x: tbX, y: ruleY }, b: { x: width, y: ruleY }, stroke: TITLEBLOCK_STROKE });
  }
  for (let i = 0; i < rows.length; i += 1) {
    const cy = height - i * TB_ROW_HEIGHT_MM - TB_ROW_HEIGHT_MM / 2;
    framePrimitives.push({
      kind: "text",
      at: { x: tbX + TB_INSET_MM, y: cy },
      value: `${rows[i]!.label}: ${rows[i]!.value}`,
      height: TB_TEXT_HEIGHT_MM,
      rotation: 0,
      font: "sans",
      widthFactor: 1,
      oblique: 0,
      hAlign: "left",
      vAlign: "middle",
      fill: TITLEBLOCK_COLOR,
    });
  }

  // --- viewports: one per placed view (the fit mapping + the annotations) ----
  const viewports: PlotViewportEntry[] = [];
  let primitiveCount = framePrimitives.length;
  for (const view of ir.views) {
    const fit = viewFit(view);
    const primitives: PlotPrimitive[] = [];
    if (fit !== null) {
      for (const raw of view.primitives) {
        primitives.push(viewPrimitiveToPlot(raw as ViewPrimitive, fit));
      }
      primitives.push(...annotationPrimitives(view, fit));
    }
    primitives.push(viewTitlePrimitive(view));
    primitiveCount += primitives.length;
    viewports.push({
      id: view.viewId,
      rect: {
        x1: view.placement.x,
        y1: view.placement.y,
        x2: view.placement.x + view.placement.w,
        y2: view.placement.y + view.placement.h,
      },
      locked: false,
      scaleDenominator: fit !== null ? 1 / fit.scale : 1,
      rotationDeg: 0,
      primitiveCount: primitives.length,
      primitives,
    });
  }

  return {
    format: PLOT_IR_FORMAT,
    formatVersion: PLOT_IR_FORMAT_VERSION,
    layout: { id: ir.sheet.id, name: ir.sheet.title },
    sheet: { widthMm: width, heightMm: height, printable },
    plot: {
      // Identity scale: the Sheet IR placements are already resolved
      // sheet-space mm (the bounded plot policy).
      scaleN: 1,
      scaleM: 1,
      sheetScale: 1,
      offsetXMm: 0,
      offsetYMm: 0,
      outputWidthMm: width,
      outputHeightMm: height,
      styleKind: "none",
      styleTable: null,
      plotViewports: true,
    },
    frame: { primitives: framePrimitives },
    viewports,
    primitiveCount,
  };
}

/** The title-block field rows (Project/Sheet/Number + Author/Date when
 *  present — the DocsTitleBlock field vocabulary in fixed order). */
function titleBlockRows(titleBlock: DocsTitleBlock): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: "Project", value: titleBlock.projectName },
    { label: "Sheet", value: titleBlock.sheetTitle },
    { label: "Number", value: titleBlock.sheetNumber },
  ];
  if (titleBlock.author !== undefined && titleBlock.author.length > 0) {
    rows.push({ label: "Author", value: titleBlock.author });
  }
  if (titleBlock.date !== undefined && titleBlock.date.length > 0) {
    rows.push({ label: "Date", value: titleBlock.date });
  }
  return rows;
}
