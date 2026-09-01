/**
 * CAD-PARITY-014 (Issue #107) — the bounded DXF interchange boundary:
 * the SHARED vocabulary of the deterministic R2000 ASCII writer and the
 * bounded reader.
 *
 * Bounded boundary (the work-item contract, D5): DXF is the OPEN
 * interchange path for the 2D drafting surface — geometry entities
 * (LINE/CIRCLE/ARC/ELLIPSE/LWPOLYLINE/SPLINE/POINT/RAY/XLINE/TEXT plus the
 * legacy POLYLINE/VERTEX/SEQEND set on import), the LTYPE/LAYER tables and
 * the $INSUNITS length declaration. Everything outside the boundary
 * (annotation dims/leaders/mtext, regions, blocks, BIM elements, model3d,
 * docs records) is SKIPPED and counted, never silently approximated
 * (LOCK-007). DWG — the proprietary binary cousin — is an explicit typed
 * decline (dwg_unsupported): reverse engineering it is a work-item non-goal.
 *
 * Determinism (LOCK-003): a fixed 6-decimal number format (the plot SVG
 * writer discipline), a fixed bounded ACI color mapping (documented below)
 * and the declared $INSUNITS factor table. Identical document state →
 * byte-identical DXF on every host, every run.
 *
 * Pure + engine-free (LOCK-018 — this directory is guarded by the
 * no-forbidden-imports scan).
 */

// --- Format identity + header variables ---------------------------------------

/** The DXF class marker written to $ACADVER (R2000 / "AC1015"). */
export const DXF_ACADVER = "AC1015";

/** $INSUNITS value for millimetres (the canonical Offisos domain). */
export const DXF_INSUNITS_MM = 4;

/** Format identity for reports/evidence. */
export const DXF_FORMAT = "dxf-ascii-r2000";

/** Format version for reports/evidence. */
export const DXF_FORMAT_VERSION = "1";

/** The bounded writable entity vocabulary (group-0 markers). */
export const DXF_WRITABLE_ENTITY_KINDS = [
  "LINE",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "LWPOLYLINE",
  "SPLINE",
  "POINT",
  "RAY",
  "XLINE",
  "TEXT",
] as const;

export type DxfWritableEntityKind = (typeof DXF_WRITABLE_ENTITY_KINDS)[number];

/** The bounded READABLE entity vocabulary (the writable set + the legacy
 *  POLYLINE/VERTEX/SEQEND composite that decodes into one polyline). */
export const DXF_READABLE_ENTITY_KINDS: readonly string[] = [
  ...DXF_WRITABLE_ENTITY_KINDS,
  "POLYLINE",
];

/** A DXF read failure (typed — LOCK-007: parse failures classify, never
 *  guess). */
export class DxfError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// --- Length units (the ifc unit-normalization precedent, D5) -----------------

/** Declared $INSUNITS vocabulary: DXF unit value → canonical factor to mm. */
export const DXF_UNIT_FACTORS: Readonly<Record<number, { readonly unit: string; readonly factor: number }>> = {
  1: { unit: "in", factor: 25.4 },
  2: { unit: "ft", factor: 304.8 },
  4: { unit: "mm", factor: 1 },
  5: { unit: "cm", factor: 10 },
  6: { unit: "m", factor: 1000 },
};

/** Resolve a $INSUNITS value to its declared factor (null = unitless or
 *  outside the declared set — the caller fails typed, no guessing). */
export function dxfUnitFactor(insunits: number | null): { unit: string; factor: number } | null {
  if (insunits === null) return null;
  return DXF_UNIT_FACTORS[insunits] ?? null;
}

// --- Number formatting (the plot SVG writer discipline) -----------------------

/** Format a float deterministically: 6-decimal round-trip, no exponent,
 *  negative-zero normalized to "0". */
export function dxfFmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  if (Object.is(r, -0)) return "0";
  return String(r);
}

// --- The bounded ACI color mapping (documented rule, D5) ----------------------
//
// RULE (one documented deterministic mapping, picked per the brief):
//   hex → ACI over the FIXED 16-entry palette below (the AutoCAD standard
//   colors 1-9 + the grayscale band 250-255) by NEAREST squared RGB distance,
//   ties resolved to the LOWEST ACI. #000000 maps to ACI 7 — the documented
//   AutoCAD black/white display duality (7 renders black on a light
//   background); every other exactly-palette hex maps exactly. Everything
//   else is an APPROXIMATION classified LOSSY by the round-trip reports.
//   Import reverses the table; foreign non-palette ACI values (the 10-249
//   hue grid) decode through the documented hue-grid approximation below
//   and classify LOSSY.

export interface DxfAciPaletteEntry {
  readonly aci: number;
  readonly rgb: readonly [number, number, number];
}

/** The fixed bounded ACI palette (RGB values of the AutoCAD standard set). */
export const DXF_ACI_PALETTE: readonly DxfAciPaletteEntry[] = [
  { aci: 1, rgb: [255, 0, 0] },
  { aci: 2, rgb: [255, 255, 0] },
  { aci: 3, rgb: [0, 255, 0] },
  { aci: 4, rgb: [0, 255, 255] },
  { aci: 5, rgb: [0, 0, 255] },
  { aci: 6, rgb: [255, 0, 255] },
  { aci: 7, rgb: [255, 255, 255] },
  { aci: 8, rgb: [128, 128, 128] },
  { aci: 9, rgb: [192, 192, 192] },
  { aci: 250, rgb: [51, 51, 51] },
  { aci: 251, rgb: [80, 80, 80] },
  { aci: 252, rgb: [105, 105, 105] },
  { aci: 253, rgb: [140, 140, 140] },
  { aci: 254, rgb: [169, 169, 169] },
  { aci: 255, rgb: [255, 255, 255] },
];

/** The ACI import table: exact hex per palette ACI (7 imports as WHITE —
 *  the AutoCAD convention; #000000 exporters should classify the black
 *  round trip LOSSY per the duality note above). */
const ACI_TO_HEX: Readonly<Record<number, string>> = Object.fromEntries(
  DXF_ACI_PALETTE.map((entry) => {
    const [r, g, b] = entry.rgb;
    return [entry.aci, `#${hex2(r)}${hex2(g)}${hex2(b)}`] as const;
  }),
);

function hex2(v: number): string {
  return v.toString(16).padStart(2, "0");
}

function rgbOfHex(hex: string): readonly [number, number, number] | null {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export interface HexToAciResult {
  readonly aci: number;
  /** True when the hex is exactly representable in the bounded palette. */
  readonly exact: boolean;
}

/** hex → ACI (the documented nearest-palette rule; see the module header). */
export function hexToAci(hex: string): HexToAciResult {
  const rgb = rgbOfHex(hex);
  if (rgb === null) return { aci: 7, exact: false };
  const [r, g, b] = rgb;
  // The documented black/white duality: black maps to ACI 7 (exact).
  if (r === 0 && g === 0 && b === 0) return { aci: 7, exact: true };
  let best = DXF_ACI_PALETTE[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entry of DXF_ACI_PALETTE) {
    const dr = r - entry.rgb[0];
    const dg = g - entry.rgb[1];
    const db = b - entry.rgb[2];
    const dist = dr * dr + dg * dg + db * db;
    // Ties resolve to the LOWEST ACI: strict < keeps the earlier (lower) entry.
    if (dist < bestDist) {
      best = entry;
      bestDist = dist;
    }
  }
  return { aci: best.aci, exact: bestDist === 0 };
}

export interface AciToHexResult {
  readonly hex: string;
  /** True when the ACI is one of the bounded palette entries. */
  readonly exact: boolean;
}

/** ACI → hex (palette-exact; foreign hue-grid values approximate). */
export function aciToHex(aci: number): AciToHexResult {
  const exact = ACI_TO_HEX[aci];
  if (exact !== undefined) return { hex: exact, exact: true };
  return { hex: aciGridApproxHex(aci), exact: false };
}

/** The documented hue-grid approximation for foreign ACI values (10-249):
 *  24 hue bands of 15°, each with 5 full-chroma and 5 half-chroma lightness
 *  steps — the structure of the AutoCAD palette, our own deterministic
 *  values. Never used for palette ACIs (those are exact). */
function aciGridApproxHex(aci: number): string {
  if (aci === 0 || aci === 256) return "#ffffff"; // ByBlock/ByLayer display defaults
  if (aci < 1 || aci > 249) return "#808080";
  const hueIndex = Math.floor((aci - 10) / 10); // 0..23
  const pos = (aci - 10) % 10; // 0..9
  const hue = (hueIndex * 15) * (Math.PI / 180);
  const full = pos < 5;
  const level = [0.4, 0.55, 0.7, 0.85, 1.0][pos % 5]!;
  const sat = full ? 1 : 0.5;
  const val = full ? level : Math.min(1, level + 0.15);
  // HSV → RGB (deterministic fixed construction order).
  const c = sat * val;
  const x = c * (1 - Math.abs(((hueIndex * 15) / 60) % 2 - 1));
  const m = val - c;
  const sector = Math.floor((hueIndex * 15) / 60) % 6;
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector === 0) { r = c; g = x; }
  else if (sector === 1) { r = x; g = c; }
  else if (sector === 2) { g = c; b = x; }
  else if (sector === 3) { g = x; b = c; }
  else if (sector === 4) { r = x; b = c; }
  else { r = c; b = x; }
  return `#${hex2(Math.round((r + m) * 255))}${hex2(Math.round((g + m) * 255))}${hex2(Math.round((b + m) * 255))}`;
}

// --- DWG detection (the explicit proprietary boundary, D5) --------------------

/** Detect the proprietary DWG binary magic: "AC" + version digits (AC1015,
 *  AC1018, AC1021, …) at the head of a BINARY payload (an ASCII DXF never
 *  starts with "AC" and never contains NUL this early). This is THE DWG
 *  boundary: the payload is declined typed dwg_unsupported — never parsed,
 *  never guessed. */
export function looksLikeDwg(bytes: Uint8Array): boolean {
  const b = bytes;
  if (b.length < 6) return false;
  if (b[0] !== 0x41 || b[1] !== 0x43) return false; // "AC"
  if (!/[0-9]/.test(String.fromCharCode(b[2]!))) return false;
  if (!/[0-9]/.test(String.fromCharCode(b[3]!))) return false;
  // Binary confirmation: a NUL byte within the first 64 bytes (ASCII DXF
  // files are printable + newlines only).
  const scan = Math.min(b.length, 64);
  for (let i = 0; i < scan; i += 1) {
    if (b[i] === 0) return true;
  }
  return false;
}
