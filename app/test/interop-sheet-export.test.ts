/**
 * CAD-PARITY-014 (Issue #107) — the Sheet IR → pdf/svg export surface
 * (`docs.exportSheet`, D4): the deterministic writers, the format structure,
 * the DWG typed decline and the Sheet-IR byte-identity guarantee.
 *
 * The Sheet IR (the COMPAT-CAD-003 canonical contract) bridges onto the
 * EXISTING deterministic plot writers through interop/sheet-export.ts —
 * pdf/svg return real bytes + sha256 (the plot.export bytes precedent),
 * the sheet-ir path stays byte-identical to the P013 behavior (the IR is
 * the shared input; the new writers only CONSUME it), dwg keeps the typed
 * proprietary decline. The title-block fields and the placed-view content
 * are asserted IN the bytes (SVG text elements; PDF content-stream text
 * operators — the plot PDF writer emits uncompressed `(value) Tj` ops).
 *
 * Pure TS — runs EVERYWHERE (the dummy bundle; no engine, no skips).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "interop-sheet",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "interop-sheet-test",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = r as unknown as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

interface SvgResult {
  readonly format: "svg";
  readonly sheetId: string;
  readonly text: string;
  readonly size: number;
  readonly sha256: string;
  readonly irHash: string;
}
interface PdfResult {
  readonly format: "pdf";
  readonly sheetId: string;
  readonly bytesBase64: string;
  readonly size: number;
  readonly sha256: string;
  readonly irHash: string;
}

async function exportSvg(h: AppApiHandler): Promise<SvgResult> {
  return val<SvgResult>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "svg" }));
}
async function exportPdf(h: AppApiHandler): Promise<PdfResult> {
  return val<PdfResult>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
}

/** The documented documentation surface: the docs-workflow P013 sheet
 *  construction (building → 4 views incl. a detail → annotations → ONE
 *  A1-landscape sheet with 4 placements + a full title block) — reusing the
 *  exact same authoring sequence keeps the Sheet IR comparable with the
 *  P013-pinned assertions (the no-regression proof). */
async function seeded(): Promise<AppApiHandler> {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "interop-sheet-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
      { type: "bim.opening", id: "op-win", hostId: "wall-south", distance: 3500, width: 1500, height: 1200, sill: 900 },
      { type: "bim.window", id: "win-1", openingId: "op-win", name: "Facade W1" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
    ],
  });
  await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
      { kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500, scale: 50 },
      { kind: "detail", title: "Door Detail 1", sourceViewId: "vw-000001", region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: 2 },
    ],
  });
  await cmd(h, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", offset: -1000 },
      { type: "docs.tag", viewId: "vw-000001", targetId: "space-office" },
      { type: "docs.note", viewId: "vw-000001", x: 3000, y: 5500, text: "Tighten construction tolerances" },
    ],
  });
  await cmd(h, "docs.regenerate", {});
  val(await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "Ground Floor Documentation",
      titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101", author: "Z.ai", date: "2026-08-27" },
      viewPlacements: [
        { viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 },
        { viewId: "vw-000002", x: 320, y: 10, w: 300, h: 280 },
        { viewId: "vw-000003", x: 10, y: 300, w: 300, h: 280 },
        { viewId: "vw-000004", x: 320, y: 300, w: 300, h: 280 },
      ],
    }],
  }));
  return h;
}

// --- determinism + format structure --------------------------------------------

test("docs.exportSheet pdf/svg are deterministic byte-level exports", async () => {
  const h = await seeded();
  const svg1 = await exportSvg(h);
  const svg2 = await exportSvg(h);
  assert.equal(svg1.sha256, svg2.sha256, "two svg exports → identical sha256");
  assert.equal(svg1.text, svg2.text, "two svg exports → byte-identical text");
  assert.equal(svg1.size, svg1.text.length, "the svg size is the text length");
  assert.match(svg1.sha256, /^[0-9a-f]{64}$/);

  const pdf1 = await exportPdf(h);
  const pdf2 = await exportPdf(h);
  assert.equal(pdf1.sha256, pdf2.sha256, "two pdf exports → identical sha256");
  assert.equal(pdf1.bytesBase64, pdf2.bytesBase64, "two pdf exports → byte-identical bytes");
  const bytes = Buffer.from(pdf1.bytesBase64, "base64");
  assert.equal(pdf1.size, bytes.length, "the pdf size is the byte length");

  // BOTH writers consume the SAME canonical Sheet IR (the irHash equality —
  // the bridge never re-derives content).
  assert.equal(svg1.irHash, pdf1.irHash, "svg and pdf share the Sheet IR hash");
});

test("the pdf export is a structurally valid minimal PDF 1.4 document", async () => {
  const h = await seeded();
  const pdf = await exportPdf(h);
  const text = Buffer.from(pdf.bytesBase64, "base64").toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"), "the %PDF-1.4 header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "the %%EOF trailer");
  // ONE page: the catalog → pages → a single kid.
  assert.ok(text.includes("<< /Type /Catalog /Pages 2 0 R >>"));
  assert.match(text, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(text, /\/Type \/Page[^s]/);
  // Standard-14 Helvetica text + uncompressed content streams (the plot
  // writer's deterministic profile — no filters, no timestamps, no IDs).
  assert.match(text, /\/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica/);
  assert.doesNotMatch(text, /FlateDecode|DCTDecode|LZWDecode/, "uncompressed streams");
  // No timestamps/IDs: the xref + trailer are the only trailing objects.
  assert.match(text, /trailer\n<< \/Size \d+ \/Root 1 0 R >>\nstartxref\n\d+\n%%EOF/);
});

test("the svg export is a standalone SVG with the sheet viewBox and real drawing content", async () => {
  const h = await seeded();
  const svg = await exportSvg(h);
  assert.ok(svg.text.startsWith("<svg "), "the <svg> root");
  assert.ok(svg.text.trimEnd().endsWith("</svg>"), "the closing tag");
  // The A1 landscape sheet frame: 841 × 594 mm at the identity plot scale.
  assert.match(svg.text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" version="1\.1" width="841mm" height="594mm" viewBox="0 0 841 594">/);
  // Well-formedness by construction: every emitted element is self-closing
  // except <text>…</text> — count the balance.
  const opens = (svg.text.match(/<text /g) ?? []).length;
  const closes = (svg.text.match(/<\/text>/g) ?? []).length;
  assert.equal(opens, closes, "text elements open/close balanced");
  assert.ok(opens > 10, "text is present (title block + view titles + annotations)");
  // The projected view content (walls) renders as line segments; the frame
  // furniture as dashed line segments (27 line elements: the furniture +
  // the four views' projected geometry).
  assert.ok((svg.text.match(/<line /g) ?? []).length >= 20, "segment primitives");
  assert.match(svg.text, /stroke-dasharray="2,1.5,2,1.5"/, "the printable-frame furniture dash");
});

// --- the content assertions (the bytes carry the sheet) -------------------------

test("the title-block fields and placed-view titles are in the exported bytes", async () => {
  const h = await seeded();
  const svg = await exportSvg(h);
  // Title-block rows (label: value — the fixed DocsTitleBlock order).
  assert.ok(svg.text.includes("Project: Offisos Demo"), "the project name");
  assert.ok(svg.text.includes("Sheet: Ground Floor"), "the sheet title");
  assert.ok(svg.text.includes("Number: A-101"), "the sheet number");
  assert.ok(svg.text.includes("Author: Z.ai"), "the author row");
  assert.ok(svg.text.includes("Date: 2026-08-27"), "the date row");
  // The placed-view titles: "Ground Floor Plan (plan)" etc. — one per
  // placement (4 views).
  assert.ok(svg.text.includes("Ground Floor Plan (plan)"));
  assert.ok(svg.text.includes("Front Elevation (elevation)"));
  assert.ok(svg.text.includes("Section A-A (section)"));
  assert.ok(svg.text.includes("Door Detail 1 (detail)"));
  // The derived annotation content rides in the view (the regenerated
  // measured value + the tag label + the note text).
  assert.ok(svg.text.includes("5300"), "the dimension's derived measured value");
  assert.ok(svg.text.includes("Office 1 (27.00"), "the space tag label");
  assert.ok(svg.text.includes("Tighten construction tolerances"), "the note text");

  // The PDF carries the same content through its text operators (the
  // uncompressed `(value) Tj` ops of the plot writer; literal parens in
  // values escape per the PDF string-literal rule).
  const pdf = await exportPdf(h);
  const pdfText = Buffer.from(pdf.bytesBase64, "base64").toString("latin1");
  assert.ok(pdfText.includes("(Project: Offisos Demo) Tj"), "the project name in the content stream");
  assert.ok(pdfText.includes("(Number: A-101) Tj"), "the sheet number");
  assert.ok(pdfText.includes("(Ground Floor Plan \\(plan\\)) Tj"), "the placed-view title");
  assert.ok((pdfText.match(/\) Tj/g) ?? []).length >= 10, "text operators are present");
});

// --- the boundary + the Sheet-IR identity ----------------------------------------

test("dwg declines typed (the proprietary boundary) and the sheet-ir path stays byte-identical", async () => {
  const h = await seeded();
  const dwg = errVal(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "dwg" }));
  assert.equal(dwg.code, "docs_unsupported");
  assert.match(dwg.message, /proprietary DWG writer boundary/);
  assert.match(dwg.message, /DXF is the open interchange path/);

  // The P013 sheet-ir path is UNCHANGED: same result shape, deterministic
  // canonical bytes + hash, and the hash the pdf/svg writers report as their
  // irHash is exactly THIS canonical hash (the new writers only consume the
  // IR — the frozen P013 contract).
  const ir1 = val<{ format: string; sheetId: string; ir: { views: unknown[] }; canonical: string; hash: string }>(
    await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }),
  );
  const ir2 = val<{ canonical: string; hash: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  assert.equal(ir1.format, "sheet-ir");
  assert.equal(ir1.sheetId, "sh-000001");
  assert.equal(ir1.canonical, ir2.canonical, "sheet-ir canonical determinism");
  assert.equal(ir1.hash, ir2.hash);
  assert.equal(ir1.ir.views.length, 4, "the 4 placed views");
  assert.match(ir1.hash, /^[0-9a-f]{64}$/);
  const svg = await exportSvg(h);
  assert.equal(svg.irHash, ir1.hash, "the svg writer consumed THIS Sheet IR (hash identity)");
  const pdf = await exportPdf(h);
  assert.equal(pdf.irHash, ir1.hash, "the pdf writer consumed THIS Sheet IR (hash identity)");

  // Unknown sheet + bad format still fail typed (the P013 contract).
  assert.equal(errVal(await qq(h, "docs.exportSheet", { sheetId: "sh-999999", format: "pdf" })).code, "docs_invalid");
  assert.equal(
    errVal(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "png" })).code,
    "bad_payload",
    "an unknown format is a wire-shape failure",
  );
});
