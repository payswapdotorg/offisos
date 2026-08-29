/**
 * CAD-PARITY-008 layout paper model (Issue #88) — the shared paper-size
 * table, page-setup validation and sheet geometry.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts, the App API and the CADDocument validators so page-setup semantics
 * are THE SAME everywhere (LOCK-004 Web/Electron semantic parity; the
 * constraints/types.ts precedent: the shared grammar IS the validator).
 *
 * Bounded slice (Issue #88): the named ISO A-series + CUSTOM sheets; no ANSI/
 * ARCH/roll sizes, no device-specific paper sources (typed declines live at
 * the plot surface).
 */

import type { LayoutPaperSizeName, PageSetup } from "../../contracts/caddocument.js";

/** The canonical portrait sheet dimensions of the named sizes (mm). */
export const PAPER_SIZES: Readonly<Record<Exclude<LayoutPaperSizeName, "CUSTOM">, { readonly widthMm: number; readonly heightMm: number }>> = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  A2: { widthMm: 420, heightMm: 594 },
  A1: { widthMm: 594, heightMm: 841 },
  A0: { widthMm: 841, heightMm: 1189 },
};

/** The named paper sizes in canonical order (prompt/UI vocabulary). */
export const PAPER_SIZE_NAMES: readonly LayoutPaperSizeName[] = ["A4", "A3", "A2", "A1", "A0", "CUSTOM"];

/** The canonical default page setup: A3 landscape, 10 mm margins, "fit"
 *  (layouts plot at exact paper size — the bounded layout-plot equivalence),
 *  no plot offset/centering, plot style "none" (as-displayed), viewport
 *  borders plotted. */
export const DEFAULT_PAGE_SETUP: PageSetup = {
  paperSize: "A3",
  widthMm: 297,
  heightMm: 420,
  orientation: "landscape",
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  plotScale: "fit",
  plotOriginMm: [0, 0],
  centerPlot: false,
  plotStyleTable: null,
  plotStyleKind: "none",
  plotViewports: true,
};

/** Parse a plot-scale declaration: "fit" or "N:M" (N, M positive integers —
 *  paper mm : output units). Returns the resolved ratio, or throws with the
 *  valid forms (LOCK-007 — reject, never guess). */
export function parsePlotScale(value: string): { readonly mode: "fit" } | { readonly mode: "custom"; readonly numerator: number; readonly denominator: number } {
  if (value === "fit") return { mode: "fit" };
  const m = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (m === null) {
    throw new Error(`plot scale '${value}' is not valid — use "fit" or "N:M" (e.g. 1:50, 2:1)`);
  }
  return { mode: "custom", numerator: Number.parseInt(m[1]!, 10), denominator: Number.parseInt(m[2]!, 10) };
}

/** Resolve the paper-size name of explicit sheet dimensions (the canonical
 *  table match, else "CUSTOM"). */
export function paperNameOf(widthMm: number, heightMm: number): LayoutPaperSizeName {
  for (const [name, size] of Object.entries(PAPER_SIZES)) {
    if (size.widthMm === widthMm && size.heightMm === heightMm) return name as Exclude<LayoutPaperSizeName, "CUSTOM">;
  }
  return "CUSTOM";
}

/** The ORIENTED sheet size in mm (portrait keeps width×height; landscape
 *  swaps — the printable-area/margin math and every writer consume the
 *  oriented sheet). */
export function orientedSheetSize(setup: PageSetup): { readonly widthMm: number; readonly heightMm: number } {
  return setup.orientation === "landscape"
    ? { widthMm: setup.heightMm, heightMm: setup.widthMm }
    : { widthMm: setup.widthMm, heightMm: setup.heightMm };
}

/** A rectangle in sheet coordinates (mm, y-up from the sheet's lower-left). */
export interface SheetRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The printable area inside the margins (sheet coordinates, y-up). */
export function printableArea(setup: PageSetup): SheetRect {
  const sheet = orientedSheetSize(setup);
  const { top, right, bottom, left } = setup.marginsMm;
  return {
    x: left,
    y: bottom,
    w: sheet.widthMm - left - right,
    h: sheet.heightMm - top - bottom,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate + normalize a page setup record (the structural grammar —
 *  LOCK-007: malformed records are rejected with a descriptive error,
 *  never repaired). Named sizes must carry the canonical dimensions; only
 *  "CUSTOM" carries arbitrary sheets. */
export function validatePageSetup(value: unknown): PageSetup {
  if (typeof value !== "object" || value === null) {
    throw new Error("page setup must be an object");
  }
  const p = value as Record<string, unknown>;
  if (typeof p.paperSize !== "string" || !(PAPER_SIZE_NAMES as readonly string[]).includes(p.paperSize)) {
    throw new Error(`page setup: paperSize must be one of ${PAPER_SIZE_NAMES.join(", ")}`);
  }
  if (!isFiniteNumber(p.widthMm) || !isFiniteNumber(p.heightMm) || (p.widthMm as number) <= 0 || (p.heightMm as number) <= 0) {
    throw new Error("page setup: widthMm/heightMm must be positive finite numbers");
  }
  const paperSize = p.paperSize as LayoutPaperSizeName;
  if (paperSize !== "CUSTOM") {
    const canonical = PAPER_SIZES[paperSize as Exclude<LayoutPaperSizeName, "CUSTOM">];
    if (canonical.widthMm !== p.widthMm || canonical.heightMm !== p.heightMm) {
      throw new Error(
        `page setup: paperSize '${paperSize}' must carry the canonical ${canonical.widthMm}×${canonical.heightMm} portrait dimensions (use CUSTOM for arbitrary sheets)`,
      );
    }
  } else {
    if ((p.widthMm as number) < 10 || (p.widthMm as number) > 5000 || (p.heightMm as number) < 10 || (p.heightMm as number) > 5000) {
      throw new Error("page setup: CUSTOM sheets are bounded to 10…5000 mm per side in this slice");
    }
  }
  if (p.orientation !== "portrait" && p.orientation !== "landscape") {
    throw new Error("page setup: orientation must be 'portrait' or 'landscape'");
  }
  const margins = p.marginsMm;
  if (typeof margins !== "object" || margins === null) {
    throw new Error("page setup: marginsMm must be an object");
  }
  const mg = margins as Record<string, unknown>;
  for (const key of ["top", "right", "bottom", "left"] as const) {
    if (!isFiniteNumber(mg[key]) || (mg[key] as number) < 0) {
      throw new Error(`page setup: marginsMm.${key} must be a non-negative finite number`);
    }
  }
  // The margins must leave a non-degenerate printable area on the ORIENTED
  // sheet (a sheet fully consumed by margins cannot plot).
  const sheet = orientedSheetSize({
    ...(p as unknown as PageSetup),
    orientation: p.orientation as "portrait" | "landscape",
  });
  if (sheet.widthMm - (mg.left as number) - (mg.right as number) <= 0 || sheet.heightMm - (mg.top as number) - (mg.bottom as number) <= 0) {
    throw new Error("page setup: the margins consume the whole sheet — the printable area must stay positive");
  }
  if (typeof p.plotScale !== "string" || p.plotScale.length === 0) {
    throw new Error("page setup: plotScale must be \"fit\" or \"N:M\"");
  }
  parsePlotScale(p.plotScale);
  if (!Array.isArray(p.plotOriginMm) || p.plotOriginMm.length !== 2 || !p.plotOriginMm.every(isFiniteNumber)) {
    throw new Error("page setup: plotOriginMm must be [number, number]");
  }
  if (typeof p.centerPlot !== "boolean") {
    throw new Error("page setup: centerPlot must be a boolean");
  }
  if (p.plotStyleTable !== null && (typeof p.plotStyleTable !== "string" || (p.plotStyleTable as string).length === 0)) {
    throw new Error("page setup: plotStyleTable must be a non-empty string or null");
  }
  if (p.plotStyleKind !== "none" && p.plotStyleKind !== "ctb" && p.plotStyleKind !== "stb") {
    throw new Error("page setup: plotStyleKind must be 'none', 'ctb' or 'stb'");
  }
  if (p.plotStyleKind === "none" && p.plotStyleTable !== null) {
    throw new Error("page setup: plotStyleKind 'none' carries no plot style table (set plotStyleTable null)");
  }
  if (p.plotStyleKind !== "none" && p.plotStyleTable === null) {
    throw new Error(`page setup: plotStyleKind '${p.plotStyleKind}' requires a named plotStyleTable`);
  }
  if (p.plotViewports !== undefined && typeof p.plotViewports !== "boolean") {
    throw new Error("page setup: plotViewports must be a boolean when present");
  }
  const out: PageSetup = {
    paperSize,
    widthMm: p.widthMm as number,
    heightMm: p.heightMm as number,
    orientation: p.orientation as "portrait" | "landscape",
    marginsMm: {
      top: mg.top as number,
      right: mg.right as number,
      bottom: mg.bottom as number,
      left: mg.left as number,
    },
    plotScale: p.plotScale as string,
    plotOriginMm: [p.plotOriginMm[0] as number, p.plotOriginMm[1] as number],
    centerPlot: p.centerPlot as boolean,
    plotStyleTable: p.plotStyleTable as string | null,
    plotStyleKind: p.plotStyleKind as "none" | "ctb" | "stb",
    ...(p.plotViewports !== undefined ? { plotViewports: p.plotViewports as boolean } : {}),
  };
  return out;
}
