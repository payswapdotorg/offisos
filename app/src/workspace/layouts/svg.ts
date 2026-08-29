/**
 * CAD-PARITY-008 deterministic SVG plot writer (Issue #88) — serializes the
 * canonical Plot IR into a standalone SVG 1.1 document.
 *
 * Deterministic by construction: fixed element order (defs → frame →
 * viewports in table order), fixed number formatting (6-decimal round-trip),
 * no metadata timestamps — identical IR → byte-identical SVG on every host,
 * every run (Issue #88 acceptance #5). The writer applies the SAME plot
 * policy the preview paints (sheet scale + content offset — both already
 * resolved inside the IR) and native rectangular clipping via one clipPath
 * per viewport (the exact-curve contract: circles/arcs/ellipses stay curves).
 *
 * Y convention: the sheet is y-up; SVG is y-down — every coordinate is
 * flipped at emit time (y_svg = sheetHeight − y), rotations negated, arcs
 * mirrored to sweep-flag 0.
 *
 * Pure + engine-free (LOCK-003/018). Bounded slice: text anchors map to
 * SVG text-anchor/dominant-baseline; no embedded fonts (generic families —
 * the annotation painter convention).
 */

import type { PlotIR, PlotPrimitive, PlotStroke } from "./ir.js";

/** Format a number deterministically (6-decimal round-trip, no exponent). */
function fmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  if (Object.is(r, -0)) return "0";
  return String(r);
}

function escapeXML(text: string): string {
  let out = "";
  for (const ch of text) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&apos;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function strokeAttrs(stroke: PlotStroke): string {
  const dash = stroke.dashMm.length > 0 ? ` stroke-dasharray="${stroke.dashMm.map(fmt).join(",")}"` : "";
  return `fill="none" stroke="${stroke.color}" stroke-width="${fmt(stroke.lineweightMm)}"${dash}`;
}

function alphaAttr(stroke: PlotStroke): string {
  return stroke.alpha < 1 ? ` stroke-opacity="${fmt(stroke.alpha)}"` : "";
}

/** Emit one primitive as SVG markup inside a group whose user space is the
 * ORIENTED SHEET (mm, y-up→flipped). */
function primitiveToSVG(p: PlotPrimitive, sheetHeightMm: number): string {
  const X = (x: number): string => fmt(x);
  const Y = (y: number): string => fmt(sheetHeightMm - y);
  switch (p.kind) {
    case "segment":
      return `<line x1="${X(p.a.x)}" y1="${Y(p.a.y)}" x2="${X(p.b.x)}" y2="${Y(p.b.y)}" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
    case "polyline": {
      const points = p.points.map((v) => `${X(v.x)},${Y(v.y)}`).join(" ");
      if (p.closed) {
        return `<polygon points="${points}" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
      }
      return `<polyline points="${points}" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
    }
    case "circle":
      return `<circle cx="${X(p.c.x)}" cy="${Y(p.c.y)}" r="${fmt(p.r)}" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
    case "arc": {
      // Paper CCW arc → SVG y-down mirror: sweep-flag 0; large-arc when the
      // sweep exceeds π.
      let sweep = p.end - p.start;
      while (sweep <= 0) sweep += Math.PI * 2;
      const largeArc = sweep > Math.PI ? 1 : 0;
      const x1 = p.c.x + p.r * Math.cos(p.start);
      const y1 = p.c.y + p.r * Math.sin(p.start);
      const x2 = p.c.x + p.r * Math.cos(p.end);
      const y2 = p.c.y + p.r * Math.sin(p.end);
      return `<path d="M ${fmt(x1)} ${Y(y1)} A ${fmt(p.r)} ${fmt(p.r)} 0 ${largeArc} 0 ${fmt(x2)} ${Y(y2)}" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
    }
    case "ellipse":
      return `<ellipse cx="${X(p.c.x)}" cy="${Y(p.c.y)}" rx="${fmt(p.rx)}" ry="${fmt(p.ry)}" transform="rotate(${fmt(-(p.rotation * 180) / Math.PI)} ${X(p.c.x)} ${Y(p.c.y)})" ${strokeAttrs(p.stroke)}${alphaAttr(p.stroke)}/>`;
    case "text": {
      const family = p.font === "mono" ? "monospace" : p.font === "serif" ? "serif" : "sans-serif";
      const anchor = p.hAlign === "center" ? "middle" : p.hAlign === "right" ? "end" : "start";
      const baseline =
        p.vAlign === "middle" ? "central" : p.vAlign === "top" ? "hanging" : p.vAlign === "bottom" ? "text-after-edge" : "alphabetic";
      const wf = p.widthFactor > 0 ? p.widthFactor : 1;
      const obliqueDeg = Math.max(-85, Math.min(85, p.oblique));
      const parts =
        `translate(${X(p.at.x)} ${Y(p.at.y)}) rotate(${fmt(-(p.rotation * 180) / Math.PI)})` +
        (wf !== 1 ? ` scale(${fmt(wf)} 1)` : "") +
        (obliqueDeg !== 0 ? ` skewX(${fmt(obliqueDeg)})` : "");
      return `<text x="0" y="0" font-family="${family}" font-size="${fmt(p.height)}" fill="${p.fill}" text-anchor="${anchor}" dominant-baseline="${baseline}" stroke="none" transform="${parts}">${escapeXML(p.value)}</text>`;
    }
    case "arrow": {
      if (p.style === "none") return "";
      if (p.style === "tick") {
        const half = p.size * 0.6;
        const px = -p.dir.y;
        const py = p.dir.x;
        const c45 = Math.SQRT1_2;
        const s45 = Math.SQRT1_2;
        const o1x = px * c45 - py * s45;
        const o1y = px * s45 + py * c45;
        const ax = p.at.x - o1x * half;
        const ay = p.at.y - o1y * half;
        const bx = p.at.x + o1x * half;
        const by = p.at.y + o1y * half;
        return `<line x1="${fmt(ax)}" y1="${Y(ay)}" x2="${fmt(bx)}" y2="${Y(by)}" stroke="${p.stroke.color}" stroke-width="${fmt(p.stroke.lineweightMm)}"${alphaAttr(p.stroke)}/>`;
      }
      const wing = p.size * 0.35;
      const backX = p.at.x - p.dir.x * p.size;
      const backY = p.at.y - p.dir.y * p.size;
      const p1x = backX - p.dir.y * wing;
      const p1y = backY + p.dir.x * wing;
      const p2x = backX + p.dir.y * wing;
      const p2y = backY - p.dir.x * wing;
      const opacity = p.stroke.alpha < 1 ? ` fill-opacity="${fmt(p.stroke.alpha)}"` : "";
      return `<polygon points="${fmt(p.at.x)},${Y(p.at.y)} ${fmt(p1x)},${Y(p1y)} ${fmt(p2x)},${Y(p2y)}" fill="${p.stroke.color}" stroke="none"${opacity}/>`;
    }
    default:
      return "";
  }
}

/** Serialize ONE Plot IR into a standalone deterministic SVG document
 *  (bytes → string; the App API hashes/wraps for transport). */
export function plotIRToSVG(ir: PlotIR): string {
  const sheet = ir.sheet;
  const outW = fmt(ir.plot.outputWidthMm);
  const outH = fmt(ir.plot.outputHeightMm);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${outW}mm" height="${outH}mm" viewBox="0 0 ${outW} ${outH}">`,
  );
  // Viewport clip paths (table order — deterministic ids).
  if (ir.viewports.length > 0) {
    parts.push("<defs>");
    for (const entry of ir.viewports) {
      const x = Math.min(entry.rect.x1, entry.rect.x2);
      const y = Math.min(entry.rect.y1, entry.rect.y2);
      const w = Math.abs(entry.rect.x2 - entry.rect.x1);
      const h = Math.abs(entry.rect.y2 - entry.rect.y1);
      parts.push(
        `<clipPath id="vp-${entry.id}"><rect x="${fmt(x)}" y="${fmt(sheet.heightMm - y - h)}" width="${fmt(w)}" height="${fmt(h)}"/></clipPath>`,
      );
    }
    parts.push("</defs>");
  }
  const scaleGroup = ir.plot.sheetScale === 1 ? "" : ` transform="scale(${fmt(ir.plot.sheetScale)})"`;
  parts.push(`<g${scaleGroup}>`);
  // Frame furniture (sheet boundary + printable area + viewport borders).
  for (const p of ir.frame.primitives) {
    const markup = primitiveToSVG(p, sheet.heightMm);
    if (markup.length > 0) parts.push(markup);
  }
  // Viewport content, clipped, in table order (later viewports on top).
  for (const entry of ir.viewports) {
    parts.push(`<g clip-path="url(#vp-${entry.id})">`);
    for (const p of entry.primitives) {
      const markup = primitiveToSVG(p, sheet.heightMm);
      if (markup.length > 0) parts.push(markup);
    }
    parts.push("</g>");
  }
  parts.push("</g>");
  parts.push("</svg>");
  return parts.join("\n");
}
