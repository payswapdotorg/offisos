/**
 * CAD-PARITY-008 layouts barrel (Issue #88) — the public surface of the
 * shared layouts/plot core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts and the App API so the layout/plot semantics are THE SAME
 * everywhere (LOCK-004 Web/Electron semantic parity).
 */

export {
  PAPER_SIZES,
  PAPER_SIZE_NAMES,
  DEFAULT_PAGE_SETUP,
  parsePlotScale,
  paperNameOf,
  orientedSheetSize,
  printableArea,
  validatePageSetup,
  type SheetRect,
} from "./paper.js";

export {
  viewportRect,
  viewportCenter,
  modelToPaper,
  paperToModel,
  rectContains,
  rectIntersect,
  clipSegment,
  bboxIntersectsRect,
  fitViewToRect,
  windowViewToRect,
  formatViewportScale,
  distanceToRectEdges,
  EMPTY_MODEL_EXTENTS,
  type PaperPt,
  type ViewportRect,
  type ModelExtents,
} from "./transform.js";

export {
  buildPlotIR,
  buildAllPlotIRs,
  modelExtentsOf,
  PLOT_IR_FORMAT,
  PLOT_IR_FORMAT_VERSION,
  type PlotIR,
  type PlotIRInput,
  type PlotPrimitive,
  type PlotStroke,
  type PlotViewportEntry,
  type PlotPolicy,
} from "./ir.js";

export {
  paintPlotIR,
  paintPlotPrimitive,
  paintSheetBackdrop,
  PAPER_SELECTION_COLOR,
  PAPER_LOCKED_COLOR,
  type PaperCanvas2DContext,
  type PaperPaintOptions,
} from "./paint.js";

export { plotIRToSVG } from "./svg.js";
export { plotIRToPDF, plotIRsToPDF, PDF_PT_PER_MM } from "./pdf.js";
// CAD-PARITY-013 (additive, Issue #104): the deterministic Layout Book
// ordering + sheet-numbering + revision-code derivations (pure; shared by
// the Plot IR title-block rendering, the navigator tree, schedules and the
// publisher expansion).
export {
  bookOrderedSubsets,
  bookOrderedLayouts,
  subsetLayouts,
  sheetNumberOf,
  revisionCodesOf,
} from "./book.js";
