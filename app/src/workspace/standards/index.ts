/**
 * CAD-PARITY-004 drawing standards core (Issue #80, CAD-2D-004) — the shared
 * layer/linetype/lineweight/style/display semantics for the professional
 * properties & palettes system.
 *
 * What lives here (ALL pure, deterministic, engine-free and host-free —
 * LOCK-003/018):
 *
 *  - the BUILT-IN linetype catalog (Continuous/Dashed/Hidden/Center/Phantom/
 *    Dot/DashDot/Divide/Border) with deterministic dash/gap patterns in mm —
 *    code-resolved so legacy snapshots (and the pinned CAD-PARITY-002 parity
 *    fixture) stay byte-identical;
 *  - the STANDARD lineweight set (mm) + the canonical default (0.25);
 *  - display RESOLUTION: entity override → layer value → document default
 *    (the "ByLayer" inheritance chain every renderer and the properties
 *    inspector show);
 *  - layer FILTERS (name pattern + state filters — the Layers manager);
 *  - the built-in "Standard" text/dimension style records + style resolution;
 *  - the named LAYER STANDARD presets (architectural/mechanical layer sets)
 *    applied through the versioned layer-table command model;
 *  - dash-array computation for canvas renderers (world mm → device px).
 *
 * The SAME module serves the CADDocument validators, the App API commands,
 * the Web host and the Electron host (LOCK-004 parity by construction).
 */

import type {
  DimStyleRecord,
  DrawingStandards,
  LayerRecord,
  LayerStateEntry,
  TextStyleRecord,
} from "../../contracts/caddocument.js";

// ---------------------------------------------------------------------------
// Linetypes — the built-in deterministic catalog.
// ---------------------------------------------------------------------------

export interface BuiltInLtype {
  readonly name: string;
  readonly description: string;
  /** Dash/gap sequence in drawing mm (even length: dashes at even indices,
   *  gaps at odd indices); empty = Continuous (solid). */
  readonly pattern: readonly number[];
}

/** The built-in linetype catalog. Patterns are our own deterministic
 *  millimeter conventions (documented, stable — never re-derived from a
 *  reference file); they scale by the document linetype scale (LTSCALE). */
export const BUILT_IN_LTYPES: readonly BuiltInLtype[] = [
  { name: "Continuous", description: "Solid line", pattern: [] },
  { name: "Dashed", description: "Dashes 12 / gaps 6", pattern: [12, 6] },
  { name: "Hidden", description: "Hidden: dashes 6 / gaps 3", pattern: [6, 3] },
  { name: "Center", description: "Center: long 19, gap 3, dash 3, gap 3", pattern: [19, 3, 3, 3] },
  { name: "Phantom", description: "Phantom: long 24, gaps 3, dashes 6", pattern: [24, 3, 6, 3, 6, 3] },
  { name: "Dot", description: "Dots 1 / gaps 5", pattern: [1, 5] },
  { name: "DashDot", description: "Dash 12, gap 3, dot 1, gap 3", pattern: [12, 3, 1, 3] },
  { name: "Divide", description: "Dash 12, gap 3, dot 1, gap 3, dot 1, gap 3", pattern: [12, 3, 1, 3, 1, 3] },
  { name: "Border", description: "Border: long 24, gap 3, dash 6, gap 3", pattern: [24, 3, 6, 3] },
];

export const BUILT_IN_LTYPE_NAMES: readonly string[] = BUILT_IN_LTYPES.map((l) => l.name);

/** Resolve a linetype NAME to its pattern: built-in catalog first, then the
 *  user-defined document table. Returns [] for "Continuous" (solid) and
 *  throws a typed error for UNKNOWN names (LOCK-007 — callers validating
 *  user input get a stable failure; resolution of already-stored names
 *  cannot reach the throw because removal is reference-checked). */
export function ltypePattern(
  name: string,
  userLtypes: readonly { name: string; pattern: readonly number[] }[] = [],
): readonly number[] {
  if (name === "Continuous") return [];
  const builtIn = BUILT_IN_LTYPES.find((l) => l.name === name);
  if (builtIn !== undefined) return builtIn.pattern;
  const user = userLtypes.find((l) => l.name === name);
  if (user !== undefined) return user.pattern;
  throw new Error(
    `unknown linetype '${name}' (available: ${[...BUILT_IN_LTYPE_NAMES, ...userLtypes.map((l) => l.name)].join(", ")})`,
  );
}

/** Does a linetype name resolve (built-in or user table)? */
export function ltypeExists(name: string, userLtypes: readonly { name: string }[] = []): boolean {
  if (name === "Continuous") return true;
  return BUILT_IN_LTYPE_NAMES.includes(name) || userLtypes.some((l) => l.name === name);
}

// ---------------------------------------------------------------------------
// Lineweights — the standard set.
// ---------------------------------------------------------------------------

/** The standard lineweight values in mm (the AutoCAD-class standard set). */
export const STANDARD_LINEWEIGHTS: readonly number[] = [
  0.0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53,
  0.6, 0.7, 0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.58, 2.0, 2.11,
];

/** The canonical default lineweight (mm). */
export const STANDARD_DEFAULT_LINEWEIGHT = 0.25;

export function isStandardLineweight(v: number): boolean {
  return STANDARD_LINEWEIGHTS.some((w) => Math.abs(w - v) < 1e-9);
}

// ---------------------------------------------------------------------------
// Entity display overrides + resolution (the ByLayer chain).
// ---------------------------------------------------------------------------

/** The display override fields a drafting entity may carry (either storage
 *  convention). Absent (or the "ByLayer" sentinel) = inherit from the layer. */
export interface EntityDisplayOverrides {
  readonly color: string | null;
  readonly linetype: string | null;
  readonly lineweight: number | null;
  readonly transparency: number | null;
}

/** Extract display overrides from element props (LOCK-007 honest: malformed
 *  values read as ByLayer — write paths validate strictly). */
export function displayOverridesOf(props: Readonly<Record<string, unknown>>): EntityDisplayOverrides {
  const color = typeof props.color === "string" && /^#[0-9a-fA-F]{6}$/.test(props.color) ? props.color : null;
  const linetype = typeof props.linetype === "string" && props.linetype.length > 0 && props.linetype !== "ByLayer"
    ? props.linetype
    : null;
  const lineweight = typeof props.lineweight === "number" && Number.isFinite(props.lineweight) ? props.lineweight : null;
  const transparency =
    typeof props.transparency === "number" && Number.isInteger(props.transparency) && props.transparency >= 0 && props.transparency <= 90
      ? props.transparency
      : null;
  return { color, linetype, lineweight, transparency };
}

/** The fully resolved display of one entity: entity override → layer value →
 *  document standard default. Everything a renderer or the Properties
 *  inspector needs, computed deterministically. */
export interface ResolvedDisplay {
  /** Stroke color (#RRGGBB). */
  readonly color: string;
  /** Linetype name. */
  readonly linetype: string;
  /** World-mm dash/gap pattern scaled by the document linetype scale;
   *  empty = solid (Continuous). */
  readonly dash: readonly number[];
  /** Lineweight in mm. */
  readonly lineweight: number;
  /** Transparency percent 0–90. */
  readonly transparency: number;
}

/** Resolve display for an entity. `standards` carries the document
 *  linetypeScale/defaultLineweight; `userLtypes` the document linetype table. */
export function resolveDisplay(
  overrides: EntityDisplayOverrides,
  layer: LayerRecord,
  standards: DrawingStandards | undefined,
  userLtypes: readonly { name: string; pattern: readonly number[] }[] = [],
): ResolvedDisplay {
  const linetypeScale = standards?.linetypeScale ?? 1;
  const defaultLineweight = standards?.defaultLineweight ?? STANDARD_DEFAULT_LINEWEIGHT;
  const linetype = overrides.linetype ?? layer.linetype ?? "Continuous";
  const pattern = ltypePattern(linetype, userLtypes);
  return {
    color: overrides.color ?? layer.color,
    linetype,
    dash: pattern.map((seg) => seg * linetypeScale),
    lineweight: overrides.lineweight ?? layer.lineweight ?? defaultLineweight,
    transparency: overrides.transparency ?? layer.transparency ?? 0,
  };
}

/** Canvas dash array: world-mm dash pattern → device px (zoom = px per mm). */
export function dashToDevicePx(dash: readonly number[], zoom: number): readonly number[] {
  return dash.map((d) => d * zoom);
}

/** Lineweight → device px width. Policy (documented display standard):
 *  hairline 1px when display is off; otherwise the mm width scaled by zoom
 *  and a visibility factor, clamped to [1, 12] px. */
export const LINEWEIGHT_DISPLAY_FACTOR = 2;

export function lineweightToDevicePx(
  lineweight: number,
  zoom: number,
  displayEnabled: boolean,
): number {
  if (!displayEnabled) return 1;
  const px = lineweight * zoom * LINEWEIGHT_DISPLAY_FACTOR;
  return Math.min(12, Math.max(1, px));
}

/** Transparency percent → canvas alpha. */
export function transparencyToAlpha(transparency: number): number {
  return 1 - transparency / 100;
}

// ---------------------------------------------------------------------------
// Layer filters (the Layers manager filter bar).
// ---------------------------------------------------------------------------

export type LayerFilterMode =
  | "all"
  | "in-use"
  | "not-in-use"
  | "off"
  | "frozen"
  | "locked"
  | "unplottable";

export const LAYER_FILTER_MODES: readonly { id: LayerFilterMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "in-use", label: "In use" },
  { id: "not-in-use", label: "Not in use" },
  { id: "off", label: "Off" },
  { id: "frozen", label: "Frozen" },
  { id: "locked", label: "Locked" },
  { id: "unplottable", label: "Not plottable" },
];

/** Deterministic layer filtering: state filter + case-insensitive name
 *  substring (empty text = no text constraint). `usedLayerIds` supplies the
 *  entity-reference set for in-use/not-in-use. */
export function filterLayers(
  layers: readonly LayerRecord[],
  mode: LayerFilterMode,
  text: string,
  usedLayerIds: ReadonlySet<string>,
): readonly LayerRecord[] {
  const needle = text.trim().toLowerCase();
  return layers.filter((l) => {
    if (
      needle.length > 0 &&
      !l.name.toLowerCase().includes(needle) &&
      !(l.description ?? "").toLowerCase().includes(needle)
    ) {
      return false;
    }
    switch (mode) {
      case "all":
        return true;
      case "in-use":
        return usedLayerIds.has(l.id);
      case "not-in-use":
        return !usedLayerIds.has(l.id);
      case "off":
        return !l.visible;
      case "frozen":
        return l.frozen === true;
      case "locked":
        return l.locked === true;
      case "unplottable":
        return l.plot === false;
    }
  });
}

// ---------------------------------------------------------------------------
// Built-in styles + resolution.
// ---------------------------------------------------------------------------

/** The reserved built-in text style (code-resolved, immutable; name-keyed
 *  like every style table entry). */
export const STANDARD_TEXT_STYLE: TextStyleRecord = {
  name: "Standard",
  font: "sans",
  height: 0,
  widthFactor: 1,
  obliqueAngle: 0,
};

/** The reserved built-in dimension style (code-resolved, immutable). */
export const STANDARD_DIM_STYLE: DimStyleRecord = {
  name: "Standard",
  textHeight: 2.5,
  arrowSize: 2.5,
  scale: 1,
  precision: 0,
};

export const STANDARD_TEXT_STYLE_NAME = "Standard";
export const STANDARD_DIM_STYLE_NAME = "Standard";

/** Resolve a text style by name ("Standard" → built-in; else the document
 *  table). Null when unknown (write paths validate names; resolution of
 *  stored references cannot go stale — removal is reference-checked). */
export function resolveTextStyle(
  name: string,
  userStyles: readonly TextStyleRecord[] = [],
): TextStyleRecord | null {
  if (name === STANDARD_TEXT_STYLE_NAME) return STANDARD_TEXT_STYLE;
  return userStyles.find((s) => s.name === name) ?? null;
}

/** Resolve a dimension style by name. */
export function resolveDimStyle(
  name: string,
  userStyles: readonly DimStyleRecord[] = [],
): DimStyleRecord | null {
  if (name === STANDARD_DIM_STYLE_NAME) return STANDARD_DIM_STYLE;
  return userStyles.find((s) => s.name === name) ?? null;
}

/** Format a measured dimension value per a dim style's precision. */
export function formatDimValue(value: number, style: DimStyleRecord): string {
  return value.toFixed(style.precision);
}

// ---------------------------------------------------------------------------
// Named layer standards (persistent drawing standards presets).
// ---------------------------------------------------------------------------

export interface LayerStandardLayerDef {
  readonly name: string;
  readonly color: string;
  readonly linetype: string;
  readonly lineweight: number;
  readonly description: string;
}

export interface LayerStandardDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly layers: readonly LayerStandardLayerDef[];
}

/** The built-in named layer standards. OFFISOS's own deterministic drafting
 *  standards (architectural and mechanical conventions) — applied through the
 *  versioned layer-table command model (addLayer batches), persisted with the
 *  snapshot, and identical on every host. */
export const LAYER_STANDARDS: readonly LayerStandardDef[] = [
  {
    id: "architectural",
    label: "Architectural (A-)",
    description: "AIA-style architectural layer naming standard",
    layers: [
      { name: "A-WALL", color: "#b45309", linetype: "Continuous", lineweight: 0.35, description: "Walls" },
      { name: "A-DOOR", color: "#15803d", linetype: "Continuous", lineweight: 0.25, description: "Doors + swings" },
      { name: "A-GLAZ", color: "#0e7490", linetype: "Continuous", lineweight: 0.25, description: "Windows/glazing" },
      { name: "A-FLOR-FIXT", color: "#6d28d9", linetype: "Continuous", lineweight: 0.13, description: "Fixed floor furniture/fixtures" },
      { name: "A-STAIR", color: "#9f1239", linetype: "Continuous", lineweight: 0.25, description: "Stairs + rails" },
      { name: "A-ROOF", color: "#7c2d12", linetype: "Continuous", lineweight: 0.25, description: "Roof outlines" },
      { name: "A-ANNO-DIMS", color: "#374151", linetype: "Continuous", lineweight: 0.13, description: "Dimensions" },
      { name: "A-ANNO-TEXT", color: "#111827", linetype: "Continuous", lineweight: 0.13, description: "Text notes" },
      { name: "A-ANNO-NPLT", color: "#9ca3af", linetype: "Continuous", lineweight: 0.09, description: "Non-plot construction notes (no plot)" },
    ],
  },
  {
    id: "mechanical",
    label: "Mechanical (ISO-ish)",
    description: "Mechanical drafting layer standard: visible/hidden/center/dimension classes",
    layers: [
      { name: "01_OUTLINE", color: "#111827", linetype: "Continuous", lineweight: 0.5, description: "Visible outlines" },
      { name: "02_HIDDEN", color: "#374151", linetype: "Hidden", lineweight: 0.25, description: "Hidden edges" },
      { name: "03_CENTER", color: "#b91c1c", linetype: "Center", lineweight: 0.18, description: "Center lines" },
      { name: "04_DIMS", color: "#1d4ed8", linetype: "Continuous", lineweight: 0.13, description: "Dimensions" },
      { name: "05_TEXT", color: "#111827", linetype: "Continuous", lineweight: 0.13, description: "Notes + labels" },
      { name: "06_HATCH", color: "#6d28d9", linetype: "Continuous", lineweight: 0.09, description: "Section hatching" },
      { name: "07_CONSTRUCTION", color: "#9ca3af", linetype: "DashDot", lineweight: 0.09, description: "Construction geometry" },
    ],
  },
];

export function layerStandardById(id: string): LayerStandardDef | null {
  return LAYER_STANDARDS.find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Layer helpers shared by hosts.
// ---------------------------------------------------------------------------

/** Is the layer visible for RENDERING AND PICKING (on + not frozen)? A frozen
 *  layer is suppressed like an off layer (regeneration-class exclusion), with
 *  the stronger creation/snap blocks enforced by the App API/document. */
export function layerRenderable(layer: LayerRecord): boolean {
  return layer.visible && layer.frozen !== true;
}

/** Fixed locked-layer fade for rendering (LAYLOCKFADECTL-class affordance). */
export const LOCKED_LAYER_FADE_ALPHA = 0.65;

/** Layer-state entry → updateLayer patch (restore path; mirrors
 *  caddocument/workspace.captureLayerState materialization). */
export function layerStatePatchOf(entry: LayerStateEntry): Record<string, unknown> {
  return {
    visible: entry.visible,
    frozen: entry.frozen,
    locked: entry.locked,
    color: entry.color,
    linetype: entry.linetype,
    lineweight: entry.lineweight,
    transparency: entry.transparency,
    plot: entry.plot,
  };
}
