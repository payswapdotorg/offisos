/**
 * CAD-PARITY-008 deterministic PDF plot writer (Issue #88) — serializes the
 * canonical Plot IR into a valid minimal PDF 1.4 document (vector paths,
 * standard-14 Helvetica text, uncompressed content streams).
 *
 * Deterministic by construction: fixed object order, fixed xref offsets
 * (computed, not patched), no timestamps/metadata/IDs — identical IR →
 * byte-identical PDF on every host, every run (Issue #88 acceptance #5).
 * The writer applies the SAME plot policy the preview paints (sheet scale +
 * content offset — both resolved inside the IR) and NATIVE rectangular
 * clipping (`re W n` inside q/Q) so curves stay curves.
 *
 * Coordinate convention: PDF user space is y-up — the sheet maps DIRECTLY
 * (paper mm × pt/mm × sheetScale); text rotations/compositions follow the
 * paper frame (the Tm derivation in paintText). Text extents use the
 * standard Helvetica AFM advance widths (public deterministic data) so
 * alignment is exact; WinAnsi-encodable text only (others → '?', the
 * documented bounded rule).
 *
 * Pure + engine-free (LOCK-003/018). No compression, no device drivers
 * (Issue #88 non-goals — typed declines live at the App API surface).
 */

import type { PlotIR, PlotPrimitive } from "./ir.js";

/** Points per mm (PDF native unit). */
export const PDF_PT_PER_MM = 72 / 25.4;

/** Standard Helvetica AFM advance widths (units/1000 em) for chars 32–126 —
 *  public deterministic font metrics. */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //   ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
  278, 278, 584, 584, 584, 556, 1015, // : ; < = > ? @
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A-Z
  278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a-z
  334, 260, 334, 584, // { | } ~
];

const DEFAULT_WIDTH = 556;

/** Helvetica vertical metrics (AFM, units/1000): ascent / cap-height midpoint
 *  / descent — the vAlign anchor approximations (documented writer rule). */
const ASCENT = 0.718;
const MID = 0.359;
const DESCENT = 0.207;

function fmt(n: number): string {
  const r = Math.round(n * 1e3) / 1e3;
  if (Object.is(r, -0)) return "0";
  return String(r);
}

function hexColorToRgbParts(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
}

/** WinAnsi-safe PDF string literal (ASCII printable subset; others '?'). */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
      else out += ch;
    } else {
      out += "?";
    }
  }
  return `(${out})`;
}

/** Text advance width in em units (the widths table). */
function textWidthEm(value: string): number {
  let w = 0;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    w += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32]! : DEFAULT_WIDTH;
  }
  return w / 1000;
}

/** One page's assembled content + the resource names it references. */
interface PageBuild {
  readonly content: string;
  readonly extGStates: readonly string[];
}

class ContentBuilder {
  private readonly ops: string[] = [];
  private readonly gstateAlphas = new Map<string, number>();

  /** The graphics state stack helper (q/Q pairs are explicit). */
  push(): void {
    this.ops.push("q");
  }

  pop(): void {
    this.ops.push("Q");
  }

  scaleCTM(s: number): void {
    this.ops.push(`${fmt(s)} 0 0 ${fmt(s)} 0 0 cm`);
  }

  strokeColor(hex: string): void {
    this.ops.push(`${hexColorToRgbParts(hex)} RG`);
  }

  fillColor(hex: string): void {
    this.ops.push(`${hexColorToRgbParts(hex)} rg`);
  }

  lineWidth(mm: number): void {
    this.ops.push(`${fmt(mm)} w`);
  }

  dash(pattern: readonly number[]): void {
    if (pattern.length === 0) {
      this.ops.push("[] 0 d");
    } else {
      this.ops.push(`[${pattern.map(fmt).join(" ")}] 0 d`);
    }
  }

  alpha(a: number): void {
    if (a >= 1) return;
    const name = `GS${Math.round(a * 1000)}`;
    if (!this.gstateAlphas.has(name)) this.gstateAlphas.set(name, a);
    this.ops.push(`/${name} gs`);
  }

  rectClip(x: number, y: number, w: number, h: number): void {
    this.ops.push(`${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re W n`);
  }

  path(points: readonly { x: number; y: number }[], closed: boolean): void {
    if (points.length < 2) return;
    this.ops.push(`${fmt(points[0]!.x)} ${fmt(points[0]!.y)} m`);
    for (let i = 1; i < points.length; i += 1) {
      this.ops.push(`${fmt(points[i]!.x)} ${fmt(points[i]!.y)} l`);
    }
    if (closed) this.ops.push("h");
    this.ops.push("S");
  }

  bezier(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }): void {
    this.ops.push(`${fmt(p0.x)} ${fmt(p0.y)} m`);
    this.ops.push(`${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)} c`);
    this.ops.push("S");
  }

  fillPolygon(points: readonly { x: number; y: number }[]): void {
    if (points.length < 2) return;
    this.ops.push(`${fmt(points[0]!.x)} ${fmt(points[0]!.y)} m`);
    for (let i = 1; i < points.length; i += 1) {
      this.ops.push(`${fmt(points[i]!.x)} ${fmt(points[i]!.y)} l`);
    }
    this.ops.push("h f");
  }

  text(p: Extract<PlotPrimitive, { kind: "text" }>): void {
    const theta = p.rotation;
    const wf = p.widthFactor > 0 ? p.widthFactor : 1;
    const obliqueRad = (Math.max(-85, Math.min(85, p.oblique)) * Math.PI) / 180;
    const tanO = Math.tan(obliqueRad);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    // Tm = Translate(at) · Rot(θ) · Shear(−tanO in the paper frame — the
    // canvas-annotation-consistent lean) · Scale(wf).
    const a = wf * cosT;
    const b = wf * sinT;
    const c = -tanO * cosT - sinT;
    const d = -tanO * sinT + cosT;
    // Alignment: shift the anchor by the measured extents (widths table).
    const width = textWidthEm(p.value) * p.height * wf;
    let x = p.at.x;
    if (p.hAlign === "center") x -= width / 2;
    else if (p.hAlign === "right") x -= width;
    let y = p.at.y;
    switch (p.vAlign) {
      case "middle":
        y -= p.height * MID;
        break;
      case "top":
        y -= p.height * ASCENT;
        break;
      case "bottom":
        y += p.height * DESCENT;
        break;
      default:
        break;
    }
    this.fillColor(p.fill);
    this.ops.push("BT");
    this.ops.push(`/F1 ${fmt(p.height)} Tf`);
    this.ops.push(`${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(x)} ${fmt(y)} Tm`);
    this.ops.push(`${pdfString(p.value)} Tj`);
    this.ops.push("ET");
  }

  /** Emit one plot primitive (paper-mm user space, y-up). */
  primitive(p: PlotPrimitive): void {
    switch (p.kind) {
      case "segment": {
        this.alpha(p.stroke.alpha);
        this.strokeColor(p.stroke.color);
        this.lineWidth(p.stroke.lineweightMm);
        this.dash(p.stroke.dashMm);
        this.path([p.a, p.b], false);
        return;
      }
      case "polyline": {
        this.alpha(p.stroke.alpha);
        this.strokeColor(p.stroke.color);
        this.lineWidth(p.stroke.lineweightMm);
        this.dash(p.stroke.dashMm);
        this.path(p.points, p.closed);
        return;
      }
      case "circle": {
        this.strokeAttrs(p);
        this.circleCurves(p.c.x, p.c.y, p.r, p.r, 0, 0, Math.PI * 2);
        return;
      }
      case "arc": {
        let start = p.start;
        let end = p.end;
        while (end <= start) end += Math.PI * 2;
        this.strokeAttrs(p);
        this.circleCurves(p.c.x, p.c.y, p.r, p.r, 0, start, end);
        return;
      }
      case "ellipse": {
        this.strokeAttrs(p);
        this.circleCurves(p.c.x, p.c.y, p.rx, p.ry, p.rotation, 0, Math.PI * 2);
        return;
      }
      case "text": {
        this.text(p);
        return;
      }
      case "arrow": {
        if (p.style === "none") return;
        if (p.style === "tick") {
          const half = p.size * 0.6;
          const px = -p.dir.y;
          const py = p.dir.x;
          const c45 = Math.SQRT1_2;
          const s45 = Math.SQRT1_2;
          const o1x = px * c45 - py * s45;
          const o1y = px * s45 + py * c45;
          this.alpha(p.stroke.alpha);
          this.strokeColor(p.stroke.color);
          this.lineWidth(Math.max(0.05, p.stroke.lineweightMm));
          this.dash([]);
          this.path(
            [
              { x: p.at.x - o1x * half, y: p.at.y - o1y * half },
              { x: p.at.x + o1x * half, y: p.at.y + o1y * half },
            ],
            false,
          );
          return;
        }
        const wing = p.size * 0.35;
        const backX = p.at.x - p.dir.x * p.size;
        const backY = p.at.y - p.dir.y * p.size;
        this.alpha(p.stroke.alpha);
        this.fillColor(p.stroke.color);
        this.fillPolygon([
          { x: p.at.x, y: p.at.y },
          { x: backX - p.dir.y * wing, y: backY + p.dir.x * wing },
          { x: backX + p.dir.y * wing, y: backY - p.dir.x * wing },
        ]);
        return;
      }
      default:
        return;
    }
  }

  private strokeAttrs(p: { readonly stroke: { readonly color: string; readonly lineweightMm: number; readonly dashMm: readonly number[]; readonly alpha: number } }): void {
    this.alpha(p.stroke.alpha);
    this.strokeColor(p.stroke.color);
    this.lineWidth(p.stroke.lineweightMm);
    this.dash(p.stroke.dashMm);
  }

  /** Approximate a center-arc/ellipse (0…2π or a window) with ≤90° cubic
   *  bezier segments — the standard arc-to-bezier construction (kappa). */
  private circleCurves(cx: number, cy: number, rx: number, ry: number, rotation: number, start: number, end: number): void {
    const twoPi = Math.PI * 2;
    let sweep = end - start;
    if (sweep <= 0) sweep = twoPi;
    const segments = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const delta = sweep / segments;
    const k = (4 / 3) * Math.tan(delta / 4);
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const map = (x: number, y: number): { x: number; y: number } => {
      const px = x * cosR - y * sinR;
      const py = x * sinR + y * cosR;
      return { x: cx + px, y: cy + py };
    };
    const pt = (ang: number): { x: number; y: number } => map(rx * Math.cos(ang), ry * Math.sin(ang));
    const tan = (ang: number): { x: number; y: number } => map(-rx * Math.sin(ang), ry * Math.cos(ang));
    let p0 = pt(start);
    let t0 = tan(start);
    for (let i = 1; i <= segments; i += 1) {
      const ang = start + delta * i;
      const p3 = pt(ang);
      const t3 = tan(ang);
      const p1 = { x: p0.x + t0.x * k, y: p0.y + t0.y * k };
      const p2 = { x: p3.x - t3.x * k, y: p3.y - t3.y * k };
      this.ops.push(`${fmt(p0.x)} ${fmt(p0.y)} m`);
      this.ops.push(`${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)} c`);
      this.ops.push("S");
      p0 = p3;
      t0 = t3;
    }
  }

  build(): PageBuild {
    return { content: this.ops.join("\n"), extGStates: [...this.gstateAlphas.keys()] };
  }
}

/** Build the content stream of one page from its IR. */
function buildPageContent(ir: PlotIR): PageBuild {
  const b = new ContentBuilder();
  const s = PDF_PT_PER_MM * ir.plot.sheetScale;
  b.push();
  b.scaleCTM(s);
  // Frame furniture (no clip — the page IS the sheet).
  for (const p of ir.frame.primitives) {
    b.primitive(p);
  }
  // Viewport content, clipped, in table order (later viewports on top).
  for (const entry of ir.viewports) {
    b.push();
    const x = Math.min(entry.rect.x1, entry.rect.x2);
    const y = Math.min(entry.rect.y1, entry.rect.y2);
    const w = Math.abs(entry.rect.x2 - entry.rect.x1);
    const h = Math.abs(entry.rect.y2 - entry.rect.y1);
    b.rectClip(x, y, w, h);
    for (const p of entry.primitives) {
      b.primitive(p);
    }
    b.pop();
  }
  b.pop();
  return b.build();
}

/** Assemble a deterministic PDF from page IRs (one page per IR — the
 *  PUBLISH batch contract). */
export function plotIRsToPDF(irs: readonly PlotIR[]): Uint8Array {
  if (irs.length === 0) {
    throw new Error("plotIRsToPDF requires at least one layout IR");
  }
  const pages = irs.map((ir) => ({ ir, build: buildPageContent(ir) }));
  // Collect the distinct extgstate alphas across pages (deterministic ids,
  // first-use order across the page sequence).
  const gstateAlphas = new Map<string, number>();
  for (const page of pages) {
    for (const name of page.build.extGStates) {
      if (!gstateAlphas.has(name)) {
        const a = Number.parseInt(name.slice(2), 10) / 1000;
        gstateAlphas.set(name, a);
      }
    }
  }
  // Object layout: 1 catalog, 2 pages tree, then per page (page, contents),
  // then the font, then the extgstates.
  const pageCount = pages.length;
  const firstPageObj = 3;
  const fontObj = firstPageObj + pageCount * 2;
  const firstGStateObj = fontObj + 1;
  const gstateNames = [...gstateAlphas.keys()];
  const totalObjects = fontObj + gstateNames.length;

  const objects: string[] = new Array(totalObjects + 1).fill("");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  pages.forEach((page, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    const wPt = page.ir.plot.outputWidthMm * PDF_PT_PER_MM;
    const hPt = page.ir.plot.outputHeightMm * PDF_PT_PER_MM;
    const gstateRes =
      gstateNames.length > 0
        ? ` /ExtGState << ${gstateNames.map((n) => `/${n} ${firstGStateObj + gstateNames.indexOf(n)} 0 R`).join(" ")} >>`
        : "";
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(wPt)} ${fmt(hPt)}]` +
      ` /Resources << /Font << /F1 ${fontObj} 0 R >>${gstateRes} >> /Contents ${contentObj} 0 R >>`;
    const stream = page.build.content;
    objects[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  gstateNames.forEach((name, i) => {
    const a = gstateAlphas.get(name)!;
    objects[firstGStateObj + i] = `<< /Type /ExtGState /ca ${fmt(a)} /CA ${fmt(a)} >>`;
  });

  // Serialize with computed xref offsets (bytes == chars: ASCII/Latin-1).
  let out = "%PDF-1.4\n";
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  for (let i = 1; i <= totalObjects; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i += 1) {
    xref += `${String(offsets[i]!).padStart(10, "0")} 00000 n \n`;
  }
  out += xref;
  out += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) {
    bytes[i] = out.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Serialize ONE Plot IR into a single-page deterministic PDF. */
export function plotIRToPDF(ir: PlotIR): Uint8Array {
  return plotIRsToPDF([ir]);
}
