/**
 * CAD-PARITY-008 deterministic layouts core tests (Issue #88) — the shared
 * paper/page-setup grammar, the model↔paper transform (round trips, rotation,
 * clipping, fit/window), the canonical Plot IR (layer plot/visibility
 * filtering composed with per-viewport overrides, determinism) and the SVG +
 * PDF writers (byte-identical repeated exports, structural validity).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_SETUP,
  PAPER_SIZES,
  orientedSheetSize,
  parsePlotScale,
  printableArea,
  validatePageSetup,
} from "../src/workspace/layouts/paper.js";
import {
  clipSegment,
  fitViewToRect,
  modelToPaper,
  paperToModel,
  rectContains,
  viewportRect,
  windowViewToRect,
  type ViewportRect,
} from "../src/workspace/layouts/transform.js";
import { buildPlotIR, modelExtentsOf } from "../src/workspace/layouts/ir.js";
import type { PlotIR } from "../src/workspace/layouts/ir.js";
import { plotIRToSVG } from "../src/workspace/layouts/svg.js";
import { plotIRToPDF, plotIRsToPDF, PDF_PT_PER_MM } from "../src/workspace/layouts/pdf.js";
import type { Element, LayerRecord, LayoutRecord, ViewportRecord } from "../src/contracts/caddocument.js";
import { createHash } from "node:crypto";

const NOW = "2026-01-01T00:00:00.000Z";

function geomElement(id: string, props: Record<string, unknown>): Element {
  return { id, kind: "geometry", engineId: null, props: { drafting: true, layer: "0", ...props } };
}

const LAYER_0: LayerRecord = { id: "0", name: "0", color: "#111827", visible: true };

function layout(name = "Layout1"): LayoutRecord {
  return { id: "lo-000001", name, pageSetup: DEFAULT_PAGE_SETUP, createdAt: NOW };
}

function vp(overrides: Partial<ViewportRecord> = {}): ViewportRecord {
  return {
    id: "vp-000001",
    layoutId: "lo-000001",
    corner1: [20, 20],
    corner2: [190, 180],
    camera: { centerX: 5000, centerY: 3000 },
    scaleDenominator: 50,
    rotationDeg: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The paper model.
// ---------------------------------------------------------------------------

test("the ISO paper table carries the canonical portrait dimensions", () => {
  assert.equal(PAPER_SIZES.A4.widthMm, 210);
  assert.equal(PAPER_SIZES.A4.heightMm, 297);
  assert.equal(PAPER_SIZES.A3.widthMm, 297);
  assert.equal(PAPER_SIZES.A3.heightMm, 420);
  assert.equal(PAPER_SIZES.A0.widthMm, 841);
  assert.equal(PAPER_SIZES.A0.heightMm, 1189);
});

test("orientedSheetSize swaps for landscape; printableArea respects margins", () => {
  const portrait = { ...DEFAULT_PAGE_SETUP, orientation: "portrait" as const };
  assert.deepEqual(orientedSheetSize(portrait), { widthMm: 297, heightMm: 420 });
  assert.deepEqual(orientedSheetSize(DEFAULT_PAGE_SETUP), { widthMm: 420, heightMm: 297 });
  const area = printableArea(DEFAULT_PAGE_SETUP);
  assert.equal(area.x, 10);
  assert.equal(area.y, 10);
  assert.equal(area.w, 400);
  assert.equal(area.h, 277);
});

test("validatePageSetup enforces the grammar (named sizes, margins, plot scale, style pairing)", () => {
  assert.deepEqual(validatePageSetup(DEFAULT_PAGE_SETUP), DEFAULT_PAGE_SETUP);
  // A named size with the wrong dimensions is rejected.
  assert.throws(() => validatePageSetup({ ...DEFAULT_PAGE_SETUP, paperSize: "A3", widthMm: 200, heightMm: 300 }));
  // Margins consuming the whole sheet are rejected (A3 landscape: the
  // oriented height is 297 — top 290 + bottom 10 leaves nothing).
  assert.throws(() =>
    validatePageSetup({ ...DEFAULT_PAGE_SETUP, marginsMm: { top: 290, right: 10, bottom: 10, left: 10 } }),
  );
  // Plot scale grammar.
  assert.throws(() => validatePageSetup({ ...DEFAULT_PAGE_SETUP, plotScale: "1:0" }));
  assert.throws(() => validatePageSetup({ ...DEFAULT_PAGE_SETUP, plotScale: "half" }));
  // Style kind/table pairing.
  assert.throws(() => validatePageSetup({ ...DEFAULT_PAGE_SETUP, plotStyleKind: "ctb" }));
  assert.throws(() => validatePageSetup({ ...DEFAULT_PAGE_SETUP, plotStyleTable: "monochrome.ctb" }));
});

test("parsePlotScale resolves fit and N:M ratios deterministically", () => {
  assert.deepEqual(parsePlotScale("fit"), { mode: "fit" });
  assert.deepEqual(parsePlotScale("1:50"), { mode: "custom", numerator: 1, denominator: 50 });
  assert.deepEqual(parsePlotScale("2:1"), { mode: "custom", numerator: 2, denominator: 1 });
  assert.throws(() => parsePlotScale("1:0"));
  assert.throws(() => parsePlotScale("scaled"));
});

// ---------------------------------------------------------------------------
// The model↔paper transform.
// ---------------------------------------------------------------------------

const RECT: ViewportRect = { x1: 20, y1: 20, x2: 190, y2: 180 };

test("modelToPaper/paperToModel are exact inverses (camera center maps to the rect center)", () => {
  const view = vp();
  const center = modelToPaper(view, RECT, { x: 5000, y: 3000 });
  assert.equal(center.x, 105);
  assert.equal(center.y, 100);
  // Round trip through both directions.
  const p = { x: 5123, y: 2876 };
  const paper = modelToPaper(view, RECT, p);
  const back = paperToModel(view, RECT, paper);
  assert.ok(Math.abs(back.x - p.x) < 1e-9);
  assert.ok(Math.abs(back.y - p.y) < 1e-9);
});

test("the scale denominator maps model units to paper mm (1:50)", () => {
  const view = vp();
  const a = modelToPaper(view, RECT, { x: 5000, y: 3000 });
  const b = modelToPaper(view, RECT, { x: 5500, y: 3000 });
  assert.equal(b.x - a.x, 10); // 500 model units at 1:50 → 10 paper mm
});

test("rotation twists the view inside the viewport (CCW)", () => {
  const view = vp({ rotationDeg: 90 });
  // +X model direction maps to +Y paper around the viewport center.
  const a = modelToPaper(view, RECT, { x: 5000, y: 3000 });
  const b = modelToPaper(view, RECT, { x: 5500, y: 3000 });
  assert.ok(Math.abs(b.x - a.x) < 1e-9);
  assert.equal(Math.round(b.y - a.y), 10);
});

test("clipSegment clips to the rect (Liang-Barsky); rectContains is closed", () => {
  const clipped = clipSegment(RECT, { x: 0, y: 100 }, { x: 400, y: 100 });
  assert.ok(clipped !== null);
  assert.equal(clipped.a.x, 20);
  assert.equal(clipped.b.x, 190);
  assert.equal(clipSegment(RECT, { x: 0, y: 5 }, { x: 400, y: 5 }), null);
  assert.equal(rectContains(RECT, { x: 20, y: 20 }), true);
  assert.equal(rectContains(RECT, { x: 19.9, y: 20 }), false);
});

test("fitViewToRect fits the model extents into the paper rectangle", () => {
  const fitted = fitViewToRect({ minX: 0, minY: 0, maxX: 10000, maxY: 6000, empty: false }, RECT);
  assert.equal(fitted.centerX, 5000);
  assert.equal(fitted.centerY, 3000);
  // max(10000/170, 6000/160) = max(58.82, 37.5) → the width dominates.
  assert.ok(Math.abs(fitted.scaleDenominator - 10000 / 170) < 1e-12);
  // The empty model fits at the canonical 1:1 around the origin.
  const empty = fitViewToRect({ minX: 0, minY: 0, maxX: 0, maxY: 0, empty: true }, RECT);
  assert.deepEqual({ x: empty.centerX, y: empty.centerY, d: empty.scaleDenominator }, { x: 0, y: 0, d: 1 });
});

test("windowViewToRect maps an explicit model window onto the rectangle", () => {
  const win = windowViewToRect({ x1: 0, y1: 0, x2: 340, y2: 160 }, RECT);
  assert.equal(win.centerX, 170);
  assert.equal(win.centerY, 80);
  assert.ok(Math.abs(win.scaleDenominator - 2) < 1e-12);
});

test("modelExtentsOf computes the geometry bbox (annotations excluded, empty canonical)", () => {
  const elements: Element[] = [
    geomElement("el-1", { type: "line", x1: 0, y1: 0, x2: 10000, y2: 0 }),
    geomElement("el-2", { type: "circle", cx: 5000, cy: 3000, r: 500 }),
    { id: "el-3", kind: "annotation", engineId: null, props: { type: "text", x: 0, y: 0, height: 100, rotation: 0, value: "note", style: "Standard" } },
  ];
  const extents = modelExtentsOf(elements);
  assert.equal(extents.minX, 0);
  assert.equal(extents.maxX, 10000);
  assert.equal(extents.minY, 0);
  assert.equal(extents.maxY, 3500);
  assert.equal(extents.empty, false);
  assert.equal(modelExtentsOf([]).empty, true);
});

// ---------------------------------------------------------------------------
// The Plot IR.
// ---------------------------------------------------------------------------

function irInput(elements: readonly Element[], viewports: readonly ViewportRecord[], layers: readonly LayerRecord[] = [LAYER_0], layoutRecord: LayoutRecord = layout()) {
  return {
    layout: layoutRecord,
    viewports,
    elements,
    layers,
    ltypes: [],
    textStyles: [],
    dimStyles: [],
  };
}

test("buildPlotIR produces the frame furniture + per-viewport projected content", () => {
  const elements = [
    geomElement("el-1", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200 }),
    geomElement("el-2", { type: "circle", cx: 5000, cy: 3000, r: 400 }),
  ];
  const ir = buildPlotIR(irInput(elements, [vp()]));
  // Sheet = A3 landscape 420×297; frame furniture = sheet boundary (4) +
  // printable frame (4) + viewport border (4).
  assert.equal(ir.sheet.widthMm, 420);
  assert.equal(ir.sheet.heightMm, 297);
  assert.equal(ir.frame.primitives.length, 12);
  assert.equal(ir.viewports.length, 1);
  assert.equal(ir.viewports[0]!.primitiveCount, 2);
  // The line maps through 1:50: 1000 model wide → 20 paper mm.
  const seg = ir.viewports[0]!.primitives.find((p) => p.kind === "segment")!;
  assert.ok(seg !== undefined);
  // The circle keeps its curve identity (exact curves — writers clip natively).
  const circle = ir.viewports[0]!.primitives.find((p) => p.kind === "circle")!;
  assert.ok(circle !== undefined);
  // The plot policy: fit ≡ 1:1, no offset, borders plotted.
  assert.equal(ir.plot.sheetScale, 1);
  assert.equal(ir.plot.outputWidthMm, 420);
  assert.equal(ir.plot.plotViewports, true);
});

test("the IR filters unplottable/invisible/frozen layers and composes viewport overrides", () => {
  const layerHidden: LayerRecord = { id: "ly-1", name: "HIDDEN", color: "#111827", visible: false };
  const layerUnplot: LayerRecord = { id: "ly-2", name: "NO-PLOT", color: "#111827", visible: true, plot: false };
  const layerFrozen: LayerRecord = { id: "ly-3", name: "FROZEN", color: "#111827", visible: true, frozen: true };
  const layerOk: LayerRecord = { id: "ly-4", name: "OK", color: "#111827", visible: true };
  const elements = [
    geomElement("el-1", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200, layer: "ly-1" }),
    geomElement("el-2", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200, layer: "ly-2" }),
    geomElement("el-3", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200, layer: "ly-3" }),
    geomElement("el-4", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200, layer: "ly-4" }),
  ];
  const layers = [LAYER_0, layerHidden, layerUnplot, layerFrozen, layerOk];
  // No override: only el-4 (and layer-0 content — none) plots.
  const plain = buildPlotIR(irInput(elements, [vp()], layers));
  assert.equal(plain.viewports[0]!.primitiveCount, 1);
  // Viewport override hides ly-4 and SHOWS ly-1 (the VPLAYER surface).
  const overridden = buildPlotIR(
    irInput(elements, [vp({ layerOverrides: [{ layerId: "ly-4", visible: false }, { layerId: "ly-1", visible: true }] })], layers),
  );
  // el-1 (override visible) + el-4 hidden; ly-2 unplottable and ly-3 frozen
  // stay excluded regardless of overrides (plot/frozen are regeneration-class).
  assert.equal(overridden.viewports[0]!.primitiveCount, 1);
  const seg = overridden.viewports[0]!.primitives[0]!;
  assert.equal(seg.kind, "segment");
});

test("the plot policy records the ratio; layouts plot at exact paper size (the bounded equivalence)", () => {
  // centerPlot: the content bbox (the viewport frame) centers in the
  // printable area of the A3 landscape sheet (400×277 at 10,10).
  const centered = buildPlotIR(irInput([], [vp({ corner1: [0, 0], corner2: [100, 100] })], [LAYER_0], { ...layout(), pageSetup: { ...DEFAULT_PAGE_SETUP, centerPlot: true } }));
  // content bbox = (0,0)-(100,100); printable center = (210, 148.5);
  // offset = (210-50, 148.5-50) = (160, 98.5).
  assert.ok(Math.abs(centered.plot.offsetXMm - 160) < 1e-9);
  assert.ok(Math.abs(centered.plot.offsetYMm - 98.5) < 1e-9);
  // A custom 1:2 plot scale is RECORDED but does not rescale the sheet
  // (layouts plot at exact paper size — the AutoCAD layout equivalence).
  const scaled = buildPlotIR(irInput([], [vp()], [LAYER_0], { ...layout(), pageSetup: { ...DEFAULT_PAGE_SETUP, plotScale: "1:2" } }));
  assert.equal(scaled.plot.scaleN, 1);
  assert.equal(scaled.plot.scaleM, 2);
  assert.equal(scaled.plot.sheetScale, 1);
  assert.equal(scaled.plot.outputWidthMm, 420);
});

test("buildPlotIR is deterministic (identical inputs → identical IR)", () => {
  const elements = [
    geomElement("el-1", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200 }),
    geomElement("el-2", { type: "arc", cx: 5000, cy: 3000, r: 400, startAngle: 0, endAngle: Math.PI }),
  ];
  const a = buildPlotIR(irInput(elements, [vp()]));
  const b = buildPlotIR(irInput(elements, [vp()]));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("the empty-model viewport plots zero content primitives (honest empty sheet)", () => {
  const ir = buildPlotIR(irInput([], [vp()]));
  assert.equal(ir.viewports[0]!.primitiveCount, 0);
  assert.equal(ir.frame.primitives.length, 12);
});

// ---------------------------------------------------------------------------
// The writers.
// ---------------------------------------------------------------------------

test("plotIRToSVG emits a standalone deterministic SVG with native clipPaths", () => {
  const elements = [
    geomElement("el-1", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200 }),
    geomElement("el-2", { type: "circle", cx: 5000, cy: 3000, r: 400 }),
  ];
  const ir = buildPlotIR(irInput(elements, [vp()]));
  const svg = plotIRToSVG(ir);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" version="1.1"'));
  assert.ok(svg.includes('<clipPath id="clip-vp-000001">'));
  assert.ok(svg.includes('clip-path="url(#clip-vp-000001)"'));
  assert.ok(svg.includes("<circle"));
  assert.ok(svg.endsWith("</svg>"));
  // Determinism: byte-identical repeated serialization.
  assert.equal(plotIRToSVG(ir), svg);
});

test("plotIRToPDF emits a valid deterministic PDF (header, xref, EOF, byte-identical repeats)", () => {
  const elements = [
    geomElement("el-1", { type: "line", x1: 4500, y1: 2800, x2: 5500, y2: 3200 }),
    geomElement("el-2", { type: "circle", cx: 5000, cy: 3000, radius: 400 }),
  ];
  const ir = buildPlotIR(irInput(elements, [vp()]));
  const pdf = plotIRToPDF(ir);
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.ok(text.includes("/Type /Catalog"));
  assert.ok(text.includes("/Type /Page"));
  assert.ok(text.includes("/BaseFont /Helvetica"));
  assert.ok(text.includes("startxref"));
  // The MediaBox is the sheet at points (A3 landscape 420×297 mm).
  const wPt = 420 * PDF_PT_PER_MM;
  const hPt = 297 * PDF_PT_PER_MM;
  const mediaBox = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
  assert.ok(mediaBox !== null, "MediaBox missing");
  assert.ok(Math.abs(Number.parseFloat(mediaBox[1]!) - wPt) < 0.001);
  assert.ok(Math.abs(Number.parseFloat(mediaBox[2]!) - hPt) < 0.001);
  // Determinism: byte-identical repeated export.
  assert.deepEqual(Buffer.from(plotIRToPDF(ir)), Buffer.from(pdf));
  // The xref offsets resolve to the recorded object headers.
  const startxref = Number.parseInt(/startxref\n(\d+)\n/.exec(text)![1]!, 10);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number.parseInt(m[1]!, 10));
  for (const offset of offsets) {
    assert.match(text.slice(offset, offset + 24), /^\d+ 0 obj\n/);
  }
});

test("plotIRsToPDF assembles a deterministic multi-page document (PUBLISH)", () => {
  const irA = buildPlotIR(irInput([geomElement("el-1", { type: "line", x1: 0, y1: 0, x2: 100, y2: 100 })], [vp()]));
  const irB = buildPlotIR(
    irInput([], [vp({ id: "vp-000002" })], [LAYER_0], { ...layout(), id: "lo-000002", name: "Layout2" }),
  );
  const pdf = plotIRsToPDF([irA, irB]);
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.includes("/Count 2"));
  const kids = /\/Kids \[(.*?)\]/.exec(text)![1]!;
  assert.equal(kids.split(" ").filter((t) => t === "R").length, 2); // "3 0 R 5 0 R"
  assert.deepEqual(Buffer.from(plotIRsToPDF([irA, irB])), Buffer.from(pdf));
  assert.throws(() => plotIRsToPDF([]));
});

test("the sha256 of repeated exports is stable across formats (byte identity)", () => {
  const elements = [geomElement("el-1", { type: "polyline", points: [[0, 0], [100, 0], [100, 50]], closed: true })];
  const ir: PlotIR = buildPlotIR(irInput(elements, [vp()]));
  const h = (b: Buffer | string): string => createHash("sha256").update(b as never).digest("hex");
  assert.equal(h(plotIRToSVG(ir)), h(plotIRToSVG(ir)));
  assert.equal(h(Buffer.from(plotIRToPDF(ir))), h(Buffer.from(plotIRToPDF(ir))));
});

// ---------------------------------------------------------------------------
// Viewport record geometry helpers.
// ---------------------------------------------------------------------------

test("viewportRect normalizes corners in any order", () => {
  const rect = viewportRect(vp({ corner1: [190, 180], corner2: [20, 20] }));
  assert.deepEqual(rect, { x1: 20, y1: 20, x2: 190, y2: 180 });
});
