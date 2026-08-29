/**
 * Drafting workspace state helpers (COMPAT-CAD-001, §5.4, LOCK-007).
 *
 * Validation + canonical defaults for the two additive CADDocument workspace
 * structures introduced by the 2D drafting slice:
 *
 *  - the persistent drawing layer table (`LayerRecord[]`, edited through the
 *    DocumentEdit command model: addLayer/updateLayer/removeLayer);
 *  - the non-versioned drafting settings (`DraftingSettings`: units, grid,
 *    snap configuration, view state — mutated without a version bump, like
 *    the ephemeral selection, but persisted with the snapshot).
 *
 * Everything here is strict: malformed input is REJECTED with a descriptive
 * error, never guessed or silently repaired (LOCK-007). Pure — no engine, no
 * host imports (LOCK-018).
 */

import type {
  BimCameraPreset,
  BimSettings,
  DimStyleRecord,
  DocsElevationDirection,
  DocumentEdit,
  DocsSheetRecord,
  DocsTitleBlock,
  DocsViewKind,
  DocsViewPlacement,
  DocsViewRecord,
  DraftingSettings,
  DrawingStandards,
  LayerRecord,
  LayerStateEntry,
  LayerStateRecord,
  LayoutRecord,
  LtypeRecord,
  SnapKind,
  IfcImportRecordView,
  TextStyleRecord,
  ViewportRecord,
} from "../contracts/caddocument.js";
import { DOCS_SHEET_FRAME as SHEET_FRAME } from "../contracts/caddocument.js";
// CAD-PARITY-004: the shared standards constants (built-in linetype catalog,
// standard lineweight set) live in the engine-free workspace standards module
// so BOTH the document validators and the host renderers resolve the SAME
// deterministic tables (type-only contracts import — no runtime cycle).
import {
  BUILT_IN_LTYPE_NAMES,
  isStandardLineweight,
  STANDARD_DEFAULT_LINEWEIGHT,
} from "../workspace/standards/index.js";
// CAD-PARITY-008: the shared paper/page-setup grammar (the constraints-core
// precedent: the shared grammar IS the validator — type-only contracts import
// plus this one runtime import; no cycle: layouts/paper imports contracts
// types only).
import { validatePageSetup } from "../workspace/layouts/paper.js";

/** Canonical BIM camera presets (COMPAT-CAD-002). */
export const BIM_CAMERA_PRESETS: readonly BimCameraPreset[] = ["iso", "top", "front", "right"];

/** The canonical default layer every drafting document carries (id "0",
 *  following the drawing-office convention). Fixed identity — never minted. */
export const DEFAULT_LAYER_ID = "0";

export const DEFAULT_LAYER: LayerRecord = {
  id: DEFAULT_LAYER_ID,
  name: "0",
  color: "#111827",
  visible: true,
};

/** Canonical snap-kind priority (COMPAT-CAD-001 tie-break order). */
export const SNAP_KIND_PRIORITY: readonly SnapKind[] = [
  "endpoint",
  "intersection",
  "center",
  "midpoint",
  "quadrant",
  "on-object",
  "grid",
];

/** Canonical default drafting settings (deterministic; mm units, 1 mm grid,
 *  all snap kinds at a 0.5 mm tolerance, identity view). */
export function defaultDraftingSettings(): DraftingSettings {
  return {
    units: "mm",
    grid: { enabled: true, size: 1 },
    snap: {
      enabled: true,
      kinds: [...SNAP_KIND_PRIORITY],
      tolerance: 0.5,
    },
    view: { pan: [0, 0], zoom: 1 },
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Structural validation of one layer record (LOCK-007). Throws on
 *  malformed input; returns the record untouched when valid. CAD-PARITY-004
 *  additive optional fields (frozen/locked/linetype/lineweight/transparency/
 *  plot/description) validate when PRESENT; absent means the default. */
export function validateLayerRecord(layer: unknown): LayerRecord {
  if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
    throw new Error("layer record must be an object");
  }
  const l = layer as Record<string, unknown>;
  if (typeof l.id !== "string" || l.id.length === 0) {
    throw new Error("layer.id must be a non-empty string");
  }
  if (typeof l.name !== "string" || l.name.length === 0) {
    throw new Error(`layer '${l.id}': name must be a non-empty string`);
  }
  if (typeof l.color !== "string" || !HEX_COLOR.test(l.color)) {
    throw new Error(`layer '${l.id}': color must be a hex string #RRGGBB`);
  }
  if (typeof l.visible !== "boolean") {
    throw new Error(`layer '${l.id}': visible must be a boolean`);
  }
  if (l.frozen !== undefined && typeof l.frozen !== "boolean") {
    throw new Error(`layer '${l.id}': frozen must be a boolean when present`);
  }
  if (l.locked !== undefined && typeof l.locked !== "boolean") {
    throw new Error(`layer '${l.id}': locked must be a boolean when present`);
  }
  if (l.linetype !== undefined) {
    if (typeof l.linetype !== "string" || l.linetype.length === 0) {
      throw new Error(`layer '${l.id}': linetype must be a non-empty string when present`);
    }
  }
  if (l.lineweight !== undefined) {
    if (!isFiniteNumber(l.lineweight) || !isStandardLineweight(l.lineweight as number)) {
      throw new Error(
        `layer '${l.id}': lineweight must be a standard lineweight (${STANDARD_DEFAULT_LINEWEIGHT} mm default) when present`,
      );
    }
  }
  if (l.transparency !== undefined) {
    if (!Number.isInteger(l.transparency) || (l.transparency as number) < 0 || (l.transparency as number) > 90) {
      throw new Error(`layer '${l.id}': transparency must be an integer 0–90 (percent) when present`);
    }
  }
  if (l.plot !== undefined && typeof l.plot !== "boolean") {
    throw new Error(`layer '${l.id}': plot must be a boolean when present`);
  }
  if (l.description !== undefined && typeof l.description !== "string") {
    throw new Error(`layer '${l.id}': description must be a string when present`);
  }
  return layer as LayerRecord;
}

/** Keys a layer patch may carry (updateLayer whitelists; anything else is
 *  rejected — no silent partial application). CAD-PARITY-004 extends the
 *  whitelist with the professional state/display vocabulary. */
const LAYER_PATCH_KEYS = [
  "name",
  "color",
  "visible",
  "frozen",
  "locked",
  "linetype",
  "lineweight",
  "transparency",
  "plot",
  "description",
] as const;

/** CAD-PARITY-004 canonical-minimal normalization: a patch value equal to the
 *  field DEFAULT removes the optional field entirely (absent = default) so
 *  layer records stay minimal and legacy-shaped unless genuinely customized
 *  (deterministic snapshots — LOCK-004). Lineweight is NOT normalized away
 *  (an explicit 0.25 must win over a standards-raised default). */
function normalizeLayerOptionals(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record.frozen === false) delete record.frozen;
  if (record.locked === false) delete record.locked;
  if (record.plot === true) delete record.plot;
  if (record.transparency === 0) delete record.transparency;
  if (record.linetype === "Continuous") delete record.linetype;
  if (record.description === "") delete record.description;
  return record;
}

/** Validate + normalize an updateLayer patch against the current record.
 *  Returns the MERGED record (current ∪ patch, default-valued optionals
 *  removed). Throws on unknown keys or invalid merged results. */
export function applyLayerPatch(current: LayerRecord, patch: Readonly<Record<string, unknown>>): LayerRecord {
  for (const key of Object.keys(patch)) {
    if (!(LAYER_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateLayer: unknown layer field '${key}' (allowed: ${LAYER_PATCH_KEYS.join(", ")})`);
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  normalizeLayerOptionals(merged);
  return validateLayerRecord(merged);
}

/** Derive the layer mint-sequence counter from existing layer ids
 *  (`ly-NNNNNN` → max + 1; mirrors deriveElementSequence). */
export function deriveLayerSequence(layers: readonly LayerRecord[]): number {
  let max = 0;
  for (const layer of layers) {
    const m = /^ly-(\d{6,})$/.exec(layer.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** Canonicalize a snap-kind list: keeps only known kinds, removes duplicates,
 *  orders by the canonical priority. Deterministic for any input order. */
export function canonicalSnapKinds(kinds: readonly unknown[]): readonly SnapKind[] {
  const present = new Set<SnapKind>();
  for (const k of kinds) {
    if ((SNAP_KIND_PRIORITY as readonly unknown[]).includes(k)) present.add(k as SnapKind);
  }
  return SNAP_KIND_PRIORITY.filter((k) => present.has(k));
}

/** Structural validation of drafting settings (LOCK-007). Throws on
 *  malformed input; returns a CANONICALIZED copy (snap kinds deduped and
 *  priority-ordered) when valid. */
export function validateDraftingSettings(value: unknown): DraftingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("draftingSettings must be an object");
  }
  const s = value as Record<string, unknown>;
  if (s.units !== "mm") {
    throw new Error("draftingSettings.units must be 'mm' (the only unit in the drafting slice)");
  }
  const grid = s.grid;
  if (typeof grid !== "object" || grid === null) throw new Error("draftingSettings.grid must be an object");
  const g = grid as Record<string, unknown>;
  if (typeof g.enabled !== "boolean") throw new Error("draftingSettings.grid.enabled must be a boolean");
  if (!isFiniteNumber(g.size) || (g.size as number) <= 0) {
    throw new Error("draftingSettings.grid.size must be a positive finite number");
  }
  const snap = s.snap;
  if (typeof snap !== "object" || snap === null) throw new Error("draftingSettings.snap must be an object");
  const sn = snap as Record<string, unknown>;
  if (typeof sn.enabled !== "boolean") throw new Error("draftingSettings.snap.enabled must be a boolean");
  if (!Array.isArray(sn.kinds) || sn.kinds.length === 0) {
    throw new Error("draftingSettings.snap.kinds must be a non-empty array");
  }
  const kinds = canonicalSnapKinds(sn.kinds);
  if (kinds.length === 0) throw new Error("draftingSettings.snap.kinds contains no known snap kind");
  if (!isFiniteNumber(sn.tolerance) || (sn.tolerance as number) <= 0) {
    throw new Error("draftingSettings.snap.tolerance must be a positive finite number");
  }
  const view = s.view;
  if (typeof view !== "object" || view === null) throw new Error("draftingSettings.view must be an object");
  const vw = view as Record<string, unknown>;
  if (
    !Array.isArray(vw.pan) || vw.pan.length !== 2 || !vw.pan.every(isFiniteNumber)
  ) {
    throw new Error("draftingSettings.view.pan must be [number, number]");
  }
  if (!isFiniteNumber(vw.zoom) || (vw.zoom as number) <= 0) {
    throw new Error("draftingSettings.view.zoom must be a positive finite number");
  }
  // CAD-PARITY-004 additive optional fields carried through only when
  // present (absent = default; cross-reference checks like activeLayer
  // existence live in the App API layer where document state is available).
  const optional: {
    activeLayer?: string;
    lineweightDisplay?: boolean;
    textStyle?: string;
    dimStyle?: string;
    standards?: DrawingStandards;
  } = {};
  if (s.activeLayer !== undefined) {
    if (typeof s.activeLayer !== "string" || (s.activeLayer as string).length === 0) {
      throw new Error("draftingSettings.activeLayer must be a non-empty string when present");
    }
    optional.activeLayer = s.activeLayer as string;
  }
  if (s.lineweightDisplay !== undefined) {
    if (typeof s.lineweightDisplay !== "boolean") {
      throw new Error("draftingSettings.lineweightDisplay must be a boolean when present");
    }
    optional.lineweightDisplay = s.lineweightDisplay as boolean;
  }
  if (s.textStyle !== undefined) {
    if (typeof s.textStyle !== "string" || (s.textStyle as string).length === 0) {
      throw new Error("draftingSettings.textStyle must be a non-empty string when present");
    }
    optional.textStyle = s.textStyle as string;
  }
  if (s.dimStyle !== undefined) {
    if (typeof s.dimStyle !== "string" || (s.dimStyle as string).length === 0) {
      throw new Error("draftingSettings.dimStyle must be a non-empty string when present");
    }
    optional.dimStyle = s.dimStyle as string;
  }
  if (s.standards !== undefined) {
    if (typeof s.standards !== "object" || s.standards === null) {
      throw new Error("draftingSettings.standards must be an object when present");
    }
    const st = s.standards as Record<string, unknown>;
    if (st.linetypeScale !== undefined && (!isFiniteNumber(st.linetypeScale) || (st.linetypeScale as number) <= 0)) {
      throw new Error("draftingSettings.standards.linetypeScale must be a positive finite number when present");
    }
    if (st.defaultLineweight !== undefined && (!isFiniteNumber(st.defaultLineweight) || !isStandardLineweight(st.defaultLineweight as number))) {
      throw new Error(
        `draftingSettings.standards.defaultLineweight must be a standard lineweight when present (${STANDARD_DEFAULT_LINEWEIGHT} default)`,
      );
    }
    const standards: { linetypeScale?: number; defaultLineweight?: number; annotationScale?: number } = {};
    if (st.linetypeScale !== undefined) standards.linetypeScale = st.linetypeScale as number;
    if (st.defaultLineweight !== undefined) standards.defaultLineweight = st.defaultLineweight as number;
    // CAD-PARITY-005 (additive + optional): the document annotation scale
    // (DIMSCALE-class; multiplies dimension annotation geometry).
    if (st.annotationScale !== undefined) {
      if (!isFiniteNumber(st.annotationScale) || (st.annotationScale as number) <= 0) {
        throw new Error("draftingSettings.standards.annotationScale must be a positive finite number when present");
      }
      standards.annotationScale = st.annotationScale as number;
    }
    optional.standards = standards;
  }
  return {
    units: "mm",
    grid: { enabled: g.enabled as boolean, size: g.size as number },
    snap: { enabled: sn.enabled as boolean, kinds, tolerance: sn.tolerance as number },
    view: { pan: [vw.pan[0] as number, vw.pan[1] as number], zoom: vw.zoom as number },
    // Absent optional fields stay absent — legacy snapshots (and the pinned
    // parity fixture) stay byte-identical.
    ...optional,
  };
}

/** Is this element a drafting entity carrying a layer assignment? (Used by
 *  the document's removeLayer reference check — generic over props.) */
export function elementLayerReference(props: Readonly<Record<string, unknown>>): string | null {
  const layer = props.layer;
  return typeof layer === "string" && layer.length > 0 ? layer : null;
}

// --- COMPAT-CAD-002 (additive): BIM workspace settings -----------------------

/** Canonical default BIM settings (deterministic; mm units, iso camera). */
export function defaultBimSettings(): BimSettings {
  return { units: "mm", camera: { preset: "iso" } };
}

/** Structural validation of BIM settings (LOCK-007). Throws on malformed
 *  input; returns a canonicalized copy when valid. */
export function validateBimSettings(value: unknown): BimSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("bimSettings must be an object");
  }
  const s = value as Record<string, unknown>;
  if (s.units !== "mm") {
    throw new Error("bimSettings.units must be 'mm' (the only unit in the BIM slice)");
  }
  const camera = s.camera;
  if (typeof camera !== "object" || camera === null) {
    throw new Error("bimSettings.camera must be an object");
  }
  const cam = camera as Record<string, unknown>;
  if (!(BIM_CAMERA_PRESETS as readonly unknown[]).includes(cam.preset)) {
    throw new Error(
      `bimSettings.camera.preset must be one of ${BIM_CAMERA_PRESETS.join(" | ")}, got ${JSON.stringify(cam.preset)}`,
    );
  }
  return { units: "mm", camera: { preset: cam.preset as BimCameraPreset } };
}

// --- COMPAT-CAD-003 (additive): documentation views + sheets ---------------

const DOCS_VIEW_KINDS: readonly DocsViewKind[] = ["plan", "elevation", "section", "detail"];
const DOCS_ELEVATION_DIRECTIONS: readonly DocsElevationDirection[] = ["front", "back", "left", "right"];

/** Drawable-region width (frame minus the title-block strip), sheet mm. */
export const DOCS_DRAWABLE_WIDTH = SHEET_FRAME.width - SHEET_FRAME.titleBlockWidth;

/** Structural + per-kind validation of a documentation view record
 *  (LOCK-007: malformed input REJECTED, never guessed). Cross-reference
 *  checks (storyId/sourceViewId exist) live in the document/commands layer
 *  where state is available; this validates record shape per kind. */
export function validateDocsViewRecord(view: unknown): DocsViewRecord {
  if (typeof view !== "object" || view === null || Array.isArray(view)) {
    throw new Error("view record must be an object");
  }
  const v = view as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) {
    throw new Error("view.id must be a non-empty string");
  }
  if (!(DOCS_VIEW_KINDS as readonly unknown[]).includes(v.kind)) {
    throw new Error(`view '${v.id}': kind must be one of ${DOCS_VIEW_KINDS.join(" | ")}`);
  }
  if (typeof v.title !== "string" || v.title.length === 0) {
    throw new Error(`view '${v.id}': title must be a non-empty string`);
  }
  if (v.scale !== undefined && (!isFiniteNumber(v.scale) || (v.scale as number) <= 0)) {
    throw new Error(`view '${v.id}': scale must be a positive finite number (1:N denominator)`);
  }
  const kind = v.kind as DocsViewKind;
  if (kind === "plan") {
    if (typeof v.storyId !== "string" || v.storyId.length === 0) {
      throw new Error(`view '${v.id}': plan views require storyId`);
    }
    rejectViewFields(v, "plan", ["direction", "sectionAxis", "sectionOffset", "sourceViewId", "region", "detailScale"]);
  } else if (kind === "elevation") {
    if (!(DOCS_ELEVATION_DIRECTIONS as readonly unknown[]).includes(v.direction)) {
      throw new Error(`view '${v.id}': elevation views require direction (${DOCS_ELEVATION_DIRECTIONS.join(" | ")})`);
    }
    if (v.storyId !== undefined && (typeof v.storyId !== "string" || v.storyId.length === 0)) {
      throw new Error(`view '${v.id}': elevation storyId must be a non-empty string when present`);
    }
    rejectViewFields(v, "elevation", ["sectionAxis", "sectionOffset", "sourceViewId", "region", "detailScale"]);
  } else if (kind === "section") {
    if (v.sectionAxis !== "x" && v.sectionAxis !== "y") {
      throw new Error(`view '${v.id}': section views require sectionAxis 'x' | 'y'`);
    }
    if (!isFiniteNumber(v.sectionOffset)) {
      throw new Error(`view '${v.id}': section views require a finite sectionOffset`);
    }
    if (v.storyId !== undefined && (typeof v.storyId !== "string" || v.storyId.length === 0)) {
      throw new Error(`view '${v.id}': section storyId must be a non-empty string when present`);
    }
    rejectViewFields(v, "section", ["direction", "sourceViewId", "region", "detailScale"]);
  } else {
    // detail
    if (typeof v.sourceViewId !== "string" || v.sourceViewId.length === 0) {
      throw new Error(`view '${v.id}': detail views require sourceViewId`);
    }
    if (!isFiniteNumber(v.detailScale) || (v.detailScale as number) <= 0) {
      throw new Error(`view '${v.id}': detail views require a positive finite detailScale`);
    }
    const region = v.region;
    if (typeof region !== "object" || region === null) {
      throw new Error(`view '${v.id}': detail views require region {x,y,w,h}`);
    }
    const r = region as Record<string, unknown>;
    if (
      !isFiniteNumber(r.x) || !isFiniteNumber(r.y) ||
      !isFiniteNumber(r.w) || (r.w as number) <= 0 ||
      !isFiniteNumber(r.h) || (r.h as number) <= 0
    ) {
      throw new Error(`view '${v.id}': detail region must carry finite x/y and positive w/h`);
    }
    rejectViewFields(v, "detail", ["storyId", "direction", "sectionAxis", "sectionOffset"]);
  }
  return view as DocsViewRecord;
}

function rejectViewFields(
  v: Readonly<Record<string, unknown>>,
  kind: DocsViewKind,
  forbidden: readonly string[],
): void {
  for (const f of forbidden) {
    if (v[f] !== undefined) {
      throw new Error(`view '${v.id}': ${kind} views must not carry '${f}'`);
    }
  }
}

/** Keys a view patch may carry (updateView whitelists). */
const VIEW_PATCH_KEYS = ["title", "scale", "storyId", "direction", "sectionAxis", "sectionOffset", "sourceViewId", "region", "detailScale"] as const;

/** Validate + merge an updateView patch against the current record (kind is
 *  immutable — patching it is rejected). Returns the MERGED record. */
export function applyViewPatch(current: DocsViewRecord, patch: Readonly<Record<string, unknown>>): DocsViewRecord {
  for (const key of Object.keys(patch)) {
    if (key === "kind") {
      throw new Error("updateView: kind is immutable — remove and re-create the view");
    }
    if (!(VIEW_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateView: unknown view field '${key}' (allowed: ${VIEW_PATCH_KEYS.join(", ")})`);
    }
  }
  const merged = { ...current, ...patch } as DocsViewRecord;
  // A patch that clears a required field (e.g. sets title to "") is rejected
  // by validateDocsViewRecord; a patch setting an optional field to undefined
  // removes it — representable, validated below.
  const cleaned: Record<string, unknown> = { ...merged };
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) delete cleaned[key];
  }
  return validateDocsViewRecord(cleaned);
}

/** Derive the view mint-sequence counter from existing ids (`vw-NNNNNN`). */
export function deriveViewSequence(views: readonly DocsViewRecord[]): number {
  let max = 0;
  for (const view of views) {
    const m = /^vw-(\d{6,})$/.exec(view.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** Structural validation of a title block (LOCK-007). */
export function validateDocsTitleBlock(value: unknown): DocsTitleBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("titleBlock must be an object");
  }
  const t = value as Record<string, unknown>;
  for (const key of ["projectName", "sheetTitle", "sheetNumber"] as const) {
    if (typeof t[key] !== "string" || (t[key] as string).length === 0) {
      throw new Error(`titleBlock.${key} must be a non-empty string`);
    }
  }
  if (t.author !== undefined && typeof t.author !== "string") {
    throw new Error("titleBlock.author must be a string when present");
  }
  if (t.date !== undefined && typeof t.date !== "string") {
    throw new Error("titleBlock.date must be a string when present");
  }
  return value as DocsTitleBlock;
}

/** Structural + placement validation of a documentation sheet record.
 *  Placements must reference views (existence checked with document state),
 *  lie inside the drawable region [0, drawableWidth]×[0, height] and be
 *  pairwise NON-OVERLAPPING (open intervals — touching edges allowed). */
export function validateDocsSheetRecord(sheet: unknown): DocsSheetRecord {
  if (typeof sheet !== "object" || sheet === null || Array.isArray(sheet)) {
    throw new Error("sheet record must be an object");
  }
  const s = sheet as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.length === 0) {
    throw new Error("sheet.id must be a non-empty string");
  }
  if (typeof s.title !== "string" || s.title.length === 0) {
    throw new Error(`sheet '${s.id}': title must be a non-empty string`);
  }
  validateDocsTitleBlock(s.titleBlock);
  if (!Array.isArray(s.viewPlacements)) {
    throw new Error(`sheet '${s.id}': viewPlacements must be an array`);
  }
  const seen = new Set<string>();
  const placements: DocsViewPlacement[] = [];
  for (const raw of s.viewPlacements) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`sheet '${s.id}': each placement must be an object`);
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.viewId !== "string" || p.viewId.length === 0) {
      throw new Error(`sheet '${s.id}': placement.viewId must be a non-empty string`);
    }
    if (seen.has(p.viewId)) {
      throw new Error(`sheet '${s.id}': view '${p.viewId}' is placed twice — one placement per view`);
    }
    seen.add(p.viewId);
    if (
      !isFiniteNumber(p.x) || !isFiniteNumber(p.y) ||
      !isFiniteNumber(p.w) || (p.w as number) <= 0 ||
      !isFiniteNumber(p.h) || (p.h as number) <= 0
    ) {
      throw new Error(`sheet '${s.id}': placement for '${p.viewId}' needs finite x/y and positive w/h`);
    }
    const x = p.x as number, y = p.y as number, w = p.w as number, h = p.h as number;
    if (x < 0 || y < 0 || x + w > DOCS_DRAWABLE_WIDTH || y + h > SHEET_FRAME.height) {
      throw new Error(
        `sheet '${s.id}': placement for '${p.viewId}' leaves the drawable region [0,${DOCS_DRAWABLE_WIDTH}]×[0,${SHEET_FRAME.height}]`,
      );
    }
    placements.push({ viewId: p.viewId, x, y, w, h });
  }
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!, b = placements[j]!;
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlaps) {
        throw new Error(
          `sheet '${s.id}': placements for '${a.viewId}' and '${b.viewId}' overlap (open-interval check; touching edges are allowed)`,
        );
      }
    }
  }
  return sheet as DocsSheetRecord;
}

/** Keys a sheet patch may carry (updateSheet whitelists). */
const SHEET_PATCH_KEYS = ["title", "titleBlock", "viewPlacements"] as const;

/** Validate + merge an updateSheet patch against the current record. */
export function applySheetPatch(current: DocsSheetRecord, patch: Readonly<Record<string, unknown>>): DocsSheetRecord {
  for (const key of Object.keys(patch)) {
    if (!(SHEET_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateSheet: unknown sheet field '${key}' (allowed: ${SHEET_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) delete cleaned[key];
  }
  return validateDocsSheetRecord(cleaned);
}

/** Derive the sheet mint-sequence counter from existing ids (`sh-NNNNNN`). */
export function deriveSheetSequence(sheets: readonly DocsSheetRecord[]): number {
  let max = 0;
  for (const sheet of sheets) {
    const m = /^sh-(\d{6,})$/.exec(sheet.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}


// --- COMPAT-IFC-001: IFC import records ----------------------------------------

const IFC_IMPORT_ACTIONS = ["created", "reconciled", "unchanged", "unsupported"] as const;

/** Validate an IFC import record view (LOCK-007: strict, first failure wins). */
export function validateIfcImportRecord(record: unknown): IfcImportRecordView {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("ifc import record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("ifc import record id must be a non-empty string");
  }
  if (typeof r.at !== "string" || r.at.length === 0) {
    throw new Error(`ifc import record '${r.id}': at must be a non-empty string`);
  }
  if (typeof r.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(r.sourceHash)) {
    throw new Error(`ifc import record '${r.id}': sourceHash must be a sha256 hex string`);
  }
  if (typeof r.schema !== "string" || r.schema.length === 0) {
    throw new Error(`ifc import record '${r.id}': schema must be a non-empty string`);
  }
  if (r.lengthUnitName !== null && typeof r.lengthUnitName !== "string") {
    throw new Error(`ifc import record '${r.id}': lengthUnitName must be a string or null`);
  }
  if (r.lengthUnitPrefix !== null && typeof r.lengthUnitPrefix !== "string") {
    throw new Error(`ifc import record '${r.id}': lengthUnitPrefix must be a string or null`);
  }
  if (!isFiniteNumber(r.scaleToMm) || (r.scaleToMm as number) <= 0) {
    throw new Error(`ifc import record '${r.id}': scaleToMm must be a positive finite number`);
  }
  if (typeof r.reportHash !== "string" || !/^[0-9a-f]{64}$/.test(r.reportHash)) {
    throw new Error(`ifc import record '${r.id}': reportHash must be a sha256 hex string`);
  }
  const summary = r.summary;
  if (typeof summary !== "object" || summary === null) {
    throw new Error(`ifc import record '${r.id}': summary must be an object`);
  }
  for (const key of ["created", "reconciled", "unchanged", "unsupported", "exact", "tolerance", "lossy", "unsupportedFields"]) {
    const v = (summary as Record<string, unknown>)[key];
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new Error(`ifc import record '${r.id}': summary.${key} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(r.mapping)) {
    throw new Error(`ifc import record '${r.id}': mapping must be an array`);
  }
  for (const raw of r.mapping) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`ifc import record '${r.id}': each mapping entry must be an object`);
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.globalId !== "string" || m.globalId.length === 0) {
      throw new Error(`ifc import record '${r.id}': mapping entry globalId must be a non-empty string`);
    }
    if (m.canonicalId !== null && typeof m.canonicalId !== "string") {
      throw new Error(`ifc import record '${r.id}': mapping entry canonicalId must be a string or null`);
    }
    if (typeof m.ifcClass !== "string" || m.ifcClass.length === 0) {
      throw new Error(`ifc import record '${r.id}': mapping entry ifcClass must be a non-empty string`);
    }
    if (!(IFC_IMPORT_ACTIONS as readonly string[]).includes(m.action as string)) {
      throw new Error(`ifc import record '${r.id}': mapping entry action must be one of ${IFC_IMPORT_ACTIONS.join("/")}`);
    }
  }
  return record as IfcImportRecordView;
}

/** Derive the import-record mint-sequence counter from existing ids (`if-NNNNNN`). */
export function deriveIfcImportSequence(records: readonly IfcImportRecordView[]): number {
  let max = 0;
  for (const record of records) {
    const m = /^if-(\d{6,})$/.exec(record.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

// --- CAD-PARITY-004 (additive): linetype / text-style / dim-style tables ----
// --- and layer states (name-keyed: the domain reference model) ---------------

/** Reserved layer-state name owned by LAYISO/LAYUNISO (never a user state). */
export const ISOLATE_LAYER_STATE_NAME = "*ISOLATE*";

/** Structural validation of a user-defined linetype record (LOCK-007).
 *  The name must not collide with the built-in catalog (the catalog is
 *  code-resolved and immutable — creating/updating it is a typed failure).
 *  Patterns: ≥ 2 entries, strictly positive finite numbers, first entry a
 *  dash, alternating dash/gap (even indices are dashes, odd are gaps). */
export function validateLtypeRecord(ltype: unknown): LtypeRecord {
  if (typeof ltype !== "object" || ltype === null || Array.isArray(ltype)) {
    throw new Error("linetype record must be an object");
  }
  const t = ltype as Record<string, unknown>;
  if (typeof t.name !== "string" || t.name.length === 0) {
    throw new Error("linetype.name must be a non-empty string");
  }
  if ((BUILT_IN_LTYPE_NAMES as readonly string[]).includes(t.name)) {
    throw new Error(`linetype '${t.name}' is a built-in linetype (immutable — choose another name)`);
  }
  if (typeof t.description !== "string") {
    throw new Error(`linetype '${t.name}': description must be a string`);
  }
  if (!Array.isArray(t.pattern) || t.pattern.length < 2 || t.pattern.length % 2 !== 0) {
    throw new Error(`linetype '${t.name}': pattern must be an even-length array of dash/gap lengths (≥ 2 entries)`);
  }
  for (const seg of t.pattern) {
    if (!isFiniteNumber(seg) || (seg as number) <= 0) {
      throw new Error(`linetype '${t.name}': pattern entries must be strictly positive finite numbers (dash, gap, …)`);
    }
  }
  return ltype as LtypeRecord;
}

/** Keys a linetype patch may carry (name is the immutable identity). */
const LTYPE_PATCH_KEYS = ["description", "pattern"] as const;

/** Validate + merge an updateLtype patch (name is immutable). */
export function applyLtypePatch(current: LtypeRecord, patch: Readonly<Record<string, unknown>>): LtypeRecord {
  for (const key of Object.keys(patch)) {
    if (key === "name") {
      throw new Error("updateLtype: name is the linetype identity — remove and re-create the linetype");
    }
    if (!(LTYPE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateLtype: unknown linetype field '${key}' (allowed: ${LTYPE_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateLtypeRecord(cleaned);
}

/** Reserved style names that are code-resolved defaults (immutable). */
export const RESERVED_STYLE_NAMES: readonly string[] = ["Standard"];

/** Structural validation of a text-style record (LOCK-007). */
export function validateTextStyleRecord(style: unknown): TextStyleRecord {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    throw new Error("text style record must be an object");
  }
  const s = style as Record<string, unknown>;
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new Error("textStyle.name must be a non-empty string");
  }
  if ((RESERVED_STYLE_NAMES as readonly string[]).includes(s.name)) {
    throw new Error("textStyle 'Standard' is the reserved built-in style (immutable)");
  }
  if (s.font !== "sans" && s.font !== "mono" && s.font !== "serif") {
    throw new Error(`textStyle '${s.name}': font must be 'sans' | 'mono' | 'serif'`);
  }
  if (!isFiniteNumber(s.height) || (s.height as number) < 0) {
    throw new Error(`textStyle '${s.name}': height must be a non-negative finite number (0 = not fixed)`);
  }
  if (!isFiniteNumber(s.widthFactor) || (s.widthFactor as number) <= 0) {
    throw new Error(`textStyle '${s.name}': widthFactor must be a positive finite number`);
  }
  if (!isFiniteNumber(s.obliqueAngle) || Math.abs(s.obliqueAngle as number) > 85) {
    throw new Error(`textStyle '${s.name}': obliqueAngle must be a finite number within ±85°`);
  }
  return style as TextStyleRecord;
}

/** Keys a text-style patch may carry (name is the immutable identity). */
const TEXT_STYLE_PATCH_KEYS = ["font", "height", "widthFactor", "obliqueAngle"] as const;

/** Validate + merge an updateTextStyle patch. */
export function applyTextStylePatch(current: TextStyleRecord, patch: Readonly<Record<string, unknown>>): TextStyleRecord {
  for (const key of Object.keys(patch)) {
    if (key === "name") {
      throw new Error("updateTextStyle: name is the style identity — remove and re-create the style");
    }
    if (!(TEXT_STYLE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateTextStyle: unknown field '${key}' (allowed: ${TEXT_STYLE_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateTextStyleRecord(cleaned);
}

/** Structural validation of a dimension-style record (LOCK-007). */
export function validateDimStyleRecord(style: unknown): DimStyleRecord {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    throw new Error("dim style record must be an object");
  }
  const s = style as Record<string, unknown>;
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new Error("dimStyle.name must be a non-empty string");
  }
  if ((RESERVED_STYLE_NAMES as readonly string[]).includes(s.name)) {
    throw new Error("dimStyle 'Standard' is the reserved built-in style (immutable)");
  }
  if (!isFiniteNumber(s.textHeight) || (s.textHeight as number) <= 0) {
    throw new Error(`dimStyle '${s.name}': textHeight must be a positive finite number`);
  }
  if (!isFiniteNumber(s.arrowSize) || (s.arrowSize as number) <= 0) {
    throw new Error(`dimStyle '${s.name}': arrowSize must be a positive finite number`);
  }
  if (!isFiniteNumber(s.scale) || (s.scale as number) <= 0) {
    throw new Error(`dimStyle '${s.name}': scale must be a positive finite number`);
  }
  if (!Number.isInteger(s.precision) || (s.precision as number) < 0 || (s.precision as number) > 6) {
    throw new Error(`dimStyle '${s.name}': precision must be an integer 0–6`);
  }
  // CAD-PARITY-005 (additive + optional): the rendered arrowhead kind and
  // the measurement unit suffix.
  if (s.arrowStyle !== undefined && s.arrowStyle !== null) {
    if (s.arrowStyle !== "closed" && s.arrowStyle !== "tick" && s.arrowStyle !== "none") {
      throw new Error(`dimStyle '${s.name}': arrowStyle must be closed|tick|none when present`);
    }
  }
  if (s.unitSuffix !== undefined && s.unitSuffix !== null) {
    if (typeof s.unitSuffix !== "string" || s.unitSuffix.length > 16) {
      throw new Error(`dimStyle '${s.name}': unitSuffix must be a string of at most 16 characters when present`);
    }
  }
  // Canonical-minimal: default-valued optionals drop out of the record
  // (arrowStyle "closed" and an empty unitSuffix are the defaults).
  const out: Record<string, unknown> = { ...(style as DimStyleRecord) };
  if (out.arrowStyle === null || out.arrowStyle === undefined || out.arrowStyle === "closed") {
    delete out.arrowStyle;
  }
  if (out.unitSuffix === null || out.unitSuffix === undefined || out.unitSuffix === "") {
    delete out.unitSuffix;
  }
  return out as unknown as DimStyleRecord;
}

/** Keys a dim-style patch may carry (name is the immutable identity;
 *  CAD-PARITY-005 adds the rendered arrowStyle + unitSuffix). */
const DIM_STYLE_PATCH_KEYS = ["textHeight", "arrowSize", "scale", "precision", "arrowStyle", "unitSuffix"] as const;

/** Validate + merge an updateDimStyle patch. */
export function applyDimStylePatch(current: DimStyleRecord, patch: Readonly<Record<string, unknown>>): DimStyleRecord {
  for (const key of Object.keys(patch)) {
    if (key === "name") {
      throw new Error("updateDimStyle: name is the style identity — remove and re-create the style");
    }
    if (!(DIM_STYLE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateDimStyle: unknown field '${key}' (allowed: ${DIM_STYLE_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // CAD-PARITY-005: null RESETS an optional field to its default (the
    // canonical-minimal record convention).
    if (value === null && (key === "arrowStyle" || key === "unitSuffix")) {
      delete cleaned[key];
      continue;
    }
    cleaned[key] = value;
  }
  return validateDimStyleRecord(cleaned);
}

/** Structural validation of a layer-state record (LOCK-007). Entries must
 *  reference distinct layers; names starting with '*' are reserved for the
 *  isolation machinery (only *ISOLATE* is valid today). */
export function validateLayerStateRecord(state: unknown): LayerStateRecord {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("layer state record must be an object");
  }
  const s = state as Record<string, unknown>;
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new Error("layerState.name must be a non-empty string");
  }
  if (s.name !== ISOLATE_LAYER_STATE_NAME && (s.name as string).startsWith("*")) {
    throw new Error(`layerState '${s.name}': names starting with '*' are reserved`);
  }
  if (!Array.isArray(s.layers) || s.layers.length === 0) {
    throw new Error(`layerState '${s.name}': layers must be a non-empty array of per-layer states`);
  }
  const seen = new Set<string>();
  for (const raw of s.layers) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`layerState '${s.name}': each layer entry must be an object`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.layerId !== "string" || e.layerId.length === 0) {
      throw new Error(`layerState '${s.name}': layer entry layerId must be a non-empty string`);
    }
    if (seen.has(e.layerId)) {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' appears twice`);
    }
    seen.add(e.layerId);
    if (typeof e.visible !== "boolean" || typeof e.frozen !== "boolean" || typeof e.locked !== "boolean") {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' needs boolean visible/frozen/locked`);
    }
    if (typeof e.color !== "string" || !HEX_COLOR.test(e.color)) {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' color must be #RRGGBB`);
    }
    if (typeof e.linetype !== "string" || e.linetype.length === 0) {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' linetype must be a non-empty string`);
    }
    if (!isFiniteNumber(e.lineweight) || (e.lineweight as number) <= 0) {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' lineweight must be a positive number`);
    }
    if (!Number.isInteger(e.transparency) || (e.transparency as number) < 0 || (e.transparency as number) > 90) {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' transparency must be an integer 0–90`);
    }
    if (typeof e.plot !== "boolean") {
      throw new Error(`layerState '${s.name}': layer '${e.layerId}' plot must be a boolean`);
    }
  }
  return state as LayerStateRecord;
}

/** Capture a layer table into the per-layer state entries of a layer state
 *  (defaults materialized explicitly — a state snapshot is complete). */
export function captureLayerState(layers: readonly LayerRecord[]): readonly LayerStateEntry[] {
  return layers.map((l): LayerStateEntry => ({
    layerId: l.id,
    visible: l.visible,
    frozen: l.frozen === true,
    locked: l.locked === true,
    color: l.color,
    linetype: l.linetype ?? "Continuous",
    lineweight: l.lineweight ?? STANDARD_DEFAULT_LINEWEIGHT,
    transparency: l.transparency ?? 0,
    plot: l.plot !== false,
  }));
}

/** Restore edits for a layer state: one updateLayer patch per captured layer
 *  (applied as ONE atomic batch by the caller — versioned, undoable). Layers
 *  removed after the state was saved are skipped honestly (no resurrection). */
export function layerStateRestoreEdits(
  state: LayerStateRecord,
  currentLayers: readonly LayerRecord[],
): readonly DocumentEdit[] {
  const byId = new Map(currentLayers.map((l) => [l.id, l] as const));
  const edits: DocumentEdit[] = [];
  for (const entry of state.layers) {
    if (!byId.has(entry.layerId)) continue;
    edits.push({
      type: "updateLayer",
      layerId: entry.layerId,
      patch: {
        visible: entry.visible,
        frozen: entry.frozen,
        locked: entry.locked,
        color: entry.color,
        linetype: entry.linetype,
        lineweight: entry.lineweight,
        transparency: entry.transparency,
        plot: entry.plot,
      },
    });
  }
  return edits;
}

// --- CAD-PARITY-006: block definitions + external references ---------------

// The inline-entity vocabulary lives in the shared blocks core (engine-free
// — the SAME validation for the document model, the App API write paths and
// both hosts; type-only contracts import — no runtime cycle, mirroring the
// standards import above).
import {
  assertDefinitionGraph,
  normalizeBlockEntities,
} from "../workspace/blocks/types.js";
import type { BlockDefinitionRecord, BlockEntityRecord, XrefRecord } from "../contracts/caddocument.js";
// CAD-PARITY-007: the shared constraints core (engine-free — the constraint
// record grammar lives in the workspace core so the document validators and
// both hosts resolve the SAME table; the type-only contracts import keeps
// the runtime cycle-free).
import { makeConstraint } from "../workspace/constraints/types.js";
import type { ConstraintRecord } from "../contracts/caddocument.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Structural validation + canonicalization of a block-definition record
 *  (LOCK-007: strict — the inline entities are validated and NORMALIZED
 *  through the shared blocks vocabulary so every stored definition is the
 *  canonical form). `defEntitiesById` supplies the OTHER definitions' inline
 *  entities in the post-write world (cycle + depth gates); pass a resolver
 *  over the would-be table including the record being written. */
export function validateBlockDefinitionRecord(
  block: unknown,
  defEntitiesById?: (id: string) => readonly BlockEntityRecord[] | undefined,
): BlockDefinitionRecord {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("block definition record must be an object");
  }
  const b = block as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) {
    throw new Error("blockDef.id must be a non-empty string (the document mints 'blk-NNNNNN')");
  }
  if (typeof b.name !== "string" || b.name.length === 0) {
    throw new Error(`blockDef '${b.id}': name must be a non-empty string`);
  }
  if (typeof b.createdAt !== "string" || b.createdAt.length === 0) {
    throw new Error(`blockDef '${b.id}': createdAt must be a non-empty string`);
  }
  if (b.basePoint === undefined || b.basePoint === null || typeof b.basePoint !== "object" || Array.isArray(b.basePoint)) {
    throw new Error(`blockDef '${b.name}': basePoint must be {x, y}`);
  }
  const bp = b.basePoint as Record<string, unknown>;
  if (!isFiniteNumber(bp.x) || !isFiniteNumber(bp.y)) {
    throw new Error(`blockDef '${b.name}': basePoint.x/y must be finite numbers`);
  }
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") {
    throw new Error(`blockDef '${b.name}': description must be a string when present`);
  }
  if (!Array.isArray(b.entities)) {
    throw new Error(`blockDef '${b.name}': entities must be an array`);
  }
  let entities: Record<string, unknown>[];
  try {
    entities = normalizeBlockEntities(b.entities);
  } catch (e) {
    throw new Error(`blockDef '${b.name}': ${(e as Error).message}`);
  }
  // The definition graph gates (cycles + bounded nesting) run against the
  // post-write table view when a resolver is supplied (document paths);
  // snapshot-open validation supplies it too so corrupt saves reject.
  if (defEntitiesById !== undefined) {
    try {
      assertDefinitionGraph(b.id, entities, defEntitiesById);
    } catch (e) {
      throw new Error(`blockDef '${b.name}': ${(e as Error).message}`);
    }
  }
  const out: Record<string, unknown> = {
    id: b.id,
    name: b.name,
    basePoint: { x: bp.x, y: bp.y },
    entities,
    createdAt: b.createdAt,
  };
  if (typeof b.description === "string" && b.description.length > 0) out.description = b.description;
  return out as unknown as BlockDefinitionRecord;
}

/** Keys a block-definition patch may carry (id/createdAt are immutable). */
const BLOCK_DEF_PATCH_KEYS = ["name", "basePoint", "description", "entities"] as const;

/** Validate + merge an updateBlockDef patch (entities replaces the whole
 *  inline array — the canonical full-array-replace convention). */
export function applyBlockDefPatch(
  current: BlockDefinitionRecord,
  patch: Readonly<Record<string, unknown>>,
  defEntitiesById?: (id: string) => readonly BlockEntityRecord[] | undefined,
): BlockDefinitionRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "createdAt") {
      throw new Error("updateBlockDef: id/createdAt are the definition identity — immutable");
    }
    if (!(BLOCK_DEF_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateBlockDef: unknown field '${key}' (allowed: ${BLOCK_DEF_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // null RESETS the optional description to absent.
    if (value === null && key === "description") {
      delete cleaned[key];
      continue;
    }
    cleaned[key] = value;
  }
  return validateBlockDefinitionRecord(cleaned, defEntitiesById);
}

/** Structural validation + canonicalization of an external-reference record
 *  (LOCK-007: a "loaded" record must carry a sha-256 source hash and its
 *  inline entities; an "unresolved" record carries neither). */
export function validateXrefRecord(xref: unknown): XrefRecord {
  if (typeof xref !== "object" || xref === null || Array.isArray(xref)) {
    throw new Error("xref record must be an object");
  }
  const x = xref as Record<string, unknown>;
  if (typeof x.id !== "string" || x.id.length === 0) {
    throw new Error("xref.id must be a non-empty string (the document mints 'xr-NNNNNN')");
  }
  if (typeof x.name !== "string" || x.name.length === 0) {
    throw new Error(`xref '${x.id}': name must be a non-empty string`);
  }
  if (typeof x.path !== "string" || x.path.length === 0) {
    throw new Error(`xref '${x.name}': path must be a non-empty string`);
  }
  if (typeof x.attachedAt !== "string" || x.attachedAt.length === 0) {
    throw new Error(`xref '${x.name}': attachedAt must be a non-empty string`);
  }
  if (x.status !== "loaded" && x.status !== "unresolved") {
    throw new Error(`xref '${x.name}': status must be loaded|unresolved`);
  }
  if (!Array.isArray(x.entities)) {
    throw new Error(`xref '${x.name}': entities must be an array`);
  }
  let entities: Record<string, unknown>[];
  try {
    entities = normalizeBlockEntities(x.entities);
  } catch (e) {
    throw new Error(`xref '${x.name}': ${(e as Error).message}`);
  }
  if (x.status === "loaded") {
    if (typeof x.sourceHash !== "string" || !SHA256_RE.test(x.sourceHash)) {
      throw new Error(`xref '${x.name}': a loaded reference must carry a sha-256 sourceHash`);
    }
  } else {
    if (x.sourceHash !== null && x.sourceHash !== undefined) {
      throw new Error(`xref '${x.name}': an unresolved reference must not carry a sourceHash`);
    }
    if (entities.length > 0) {
      throw new Error(`xref '${x.name}': an unresolved reference must not carry resolved entities`);
    }
  }
  const out: Record<string, unknown> = {
    id: x.id,
    name: x.name,
    path: x.path,
    status: x.status,
    sourceHash: x.status === "loaded" ? x.sourceHash : null,
    attachedAt: x.attachedAt,
    entities,
  };
  return out as unknown as XrefRecord;
}

/** Keys an xref patch may carry (id/attachedAt are immutable). */
const XREF_PATCH_KEYS = ["name", "path", "status", "sourceHash", "entities"] as const;

/** Validate + merge an updateXref patch (reload rewrites status + sourceHash
 *  + entities together — the merged record re-validates as a whole). */
export function applyXrefPatch(current: XrefRecord, patch: Readonly<Record<string, unknown>>): XrefRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "attachedAt") {
      throw new Error("updateXref: id/attachedAt are the reference identity — immutable");
    }
    if (!(XREF_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateXref: unknown field '${key}' (allowed: ${XREF_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateXrefRecord(cleaned);
}

/** CAD-PARITY-006: derive the block-definition mint-sequence counter from
 *  existing minted ids (`blk-NNNNNN`) — the deriveLayerSequence contract. */
export function deriveBlockSequence(blocks: readonly BlockDefinitionRecord[]): number {
  let max = 0;
  for (const b of blocks) {
    const m = /^blk-(\d{6,})$/.exec(b.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** CAD-PARITY-006: derive the external-reference mint-sequence counter from
 *  existing minted ids (`xr-NNNNNN`). */
export function deriveXrefSequence(xrefs: readonly XrefRecord[]): number {
  let max = 0;
  for (const x of xrefs) {
    const m = /^xr-(\d{6,})$/.exec(x.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

// --- CAD-PARITY-007 (additive): the parametric constraint table -----------

/** CAD-PARITY-007: validate + normalize a constraint record (the structural
 *  grammar through the shared constraints core — makeConstraint; the
 *  SEMANTIC vocabulary check against the actual elements happens at the
 *  command layer through validateConstraintTargets). LOCK-007: malformed
 *  records are rejected with a descriptive error, never repaired. */
export function validateConstraintRecord(record: unknown): ConstraintRecord {
  if (typeof record !== "object" || record === null) {
    throw new Error("constraint record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("constraint record: id must be a non-empty string");
  }
  try {
    return makeConstraint(r);
  } catch (e) {
    throw new Error(`constraint '${r.id}': ${(e as Error).message}`);
  }
}

/** Keys a constraint patch may carry (id/kind/targets/createdAt are the
 *  declaration identity — immutable; a different kind or target set is a
 *  remove + re-create, the honest bounded rule). */
const CONSTRAINT_PATCH_KEYS = ["value", "mode"] as const;

/** Validate + merge an updateConstraint patch (the merged record
 *  re-validates as a whole through the shared grammar). */
export function applyConstraintPatch(current: ConstraintRecord, patch: Readonly<Record<string, unknown>>): ConstraintRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "kind" || key === "targets" || key === "createdAt") {
      throw new Error("updateConstraint: id/kind/targets/createdAt are the constraint identity — immutable (remove + re-create)");
    }
    if (!(CONSTRAINT_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateConstraint: unknown field '${key}' (allowed: ${CONSTRAINT_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateConstraintRecord(cleaned);
}

/** CAD-PARITY-007: derive the constraint mint-sequence counter from
 *  existing minted ids (`con-NNNNNN`) — the deriveBlockSequence contract. */
export function deriveConstraintSequence(constraints: readonly ConstraintRecord[]): number {
  let max = 0;
  for (const c of constraints) {
    const m = /^con-(\d{6,})$/.exec(c.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

// --- CAD-PARITY-008 (additive): the layout + viewport tables ---------------

/** CAD-PARITY-008: validate + normalize a layout record (the structural
 *  grammar — the embedded page setup validates through the SHARED paper
 *  module so document state, commands and hosts agree on every value,
 *  LOCK-007). */
export function validateLayoutRecord(record: unknown): LayoutRecord {
  if (typeof record !== "object" || record === null) {
    throw new Error("layout record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("layout record: id must be a non-empty string");
  }
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.length > 255) {
    throw new Error(`layout '${r.id}': name must be a non-empty trimmed string (max 255 chars)`);
  }
  if (typeof r.createdAt !== "string" || r.createdAt.length === 0) {
    throw new Error(`layout '${r.id}': createdAt must be a non-empty string`);
  }
  let pageSetup: LayoutRecord["pageSetup"];
  try {
    pageSetup = validatePageSetup(r.pageSetup);
  } catch (e) {
    throw new Error(`layout '${r.name}': ${(e as Error).message}`);
  }
  return { id: r.id, name: r.name, pageSetup, createdAt: r.createdAt };
}

/** Keys a layout patch may carry (id/createdAt are the record identity —
 *  immutable; pageSetup replaces the whole embedded object). */
const LAYOUT_PATCH_KEYS = ["name", "pageSetup"] as const;

/** Validate + merge an updateLayout patch (the merged record re-validates
 *  as a whole through the shared grammar). */
export function applyLayoutPatch(current: LayoutRecord, patch: Readonly<Record<string, unknown>>): LayoutRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "createdAt") {
      throw new Error("updateLayout: id/createdAt are the layout identity — immutable");
    }
    if (!(LAYOUT_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateLayout: unknown field '${key}' (allowed: ${LAYOUT_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateLayoutRecord(cleaned);
}

/** CAD-PARITY-008: derive the layout mint-sequence counter from existing
 *  minted ids (`lo-NNNNNN`) — the deriveConstraintSequence contract. */
export function deriveLayoutSequence(layouts: readonly LayoutRecord[]): number {
  let max = 0;
  for (const l of layouts) {
    const m = /^lo-(\d{6,})$/.exec(l.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** CAD-PARITY-008: validate + normalize a viewport record (the structural
 *  grammar: a non-degenerate paper rectangle, a finite camera/scale/
 *  rotation triple and at most ONE override entry per layer). */
export function validateViewportRecord(record: unknown): ViewportRecord {
  if (typeof record !== "object" || record === null) {
    throw new Error("viewport record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("viewport record: id must be a non-empty string");
  }
  if (typeof r.layoutId !== "string" || r.layoutId.length === 0) {
    throw new Error(`viewport '${r.id}': layoutId must be a non-empty string`);
  }
  const corner = (v: unknown, which: string): readonly [number, number] => {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number" || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
      throw new Error(`viewport '${r.id}': corner${which} must be [number, number]`);
    }
    return [v[0] as number, v[1] as number];
  };
  const corner1 = corner(r.corner1, "1");
  const corner2 = corner(r.corner2, "2");
  if (Math.abs(corner1[0] - corner2[0]) < 1e-9 || Math.abs(corner1[1] - corner2[1]) < 1e-9) {
    throw new Error(`viewport '${r.id}': the paper rectangle is degenerate (zero width or height)`);
  }
  const camera = r.camera;
  if (typeof camera !== "object" || camera === null) {
    throw new Error(`viewport '${r.id}': camera must be an object`);
  }
  const cam = camera as Record<string, unknown>;
  if (typeof cam.centerX !== "number" || !Number.isFinite(cam.centerX) || typeof cam.centerY !== "number" || !Number.isFinite(cam.centerY)) {
    throw new Error(`viewport '${r.id}': camera.centerX/centerY must be finite numbers`);
  }
  if (typeof r.scaleDenominator !== "number" || !Number.isFinite(r.scaleDenominator) || (r.scaleDenominator as number) <= 0) {
    throw new Error(`viewport '${r.id}': scaleDenominator must be a positive finite number (model units per paper mm)`);
  }
  if (typeof r.rotationDeg !== "number" || !Number.isFinite(r.rotationDeg)) {
    throw new Error(`viewport '${r.id}': rotationDeg must be a finite number`);
  }
  if (r.locked !== undefined && typeof r.locked !== "boolean") {
    throw new Error(`viewport '${r.id}': locked must be a boolean when present`);
  }
  let layerOverrides: ViewportRecord["layerOverrides"];
  if (r.layerOverrides !== undefined) {
    if (!Array.isArray(r.layerOverrides)) {
      throw new Error(`viewport '${r.id}': layerOverrides must be an array when present`);
    }
    const seen = new Set<string>();
    const overrides: { layerId: string; visible?: boolean; frozen?: boolean }[] = [];
    for (const raw of r.layerOverrides) {
      if (typeof raw !== "object" || raw === null) {
        throw new Error(`viewport '${r.id}': each layer override must be an object`);
      }
      const o = raw as Record<string, unknown>;
      if (typeof o.layerId !== "string" || (o.layerId as string).length === 0) {
        throw new Error(`viewport '${r.id}': a layer override requires a non-empty layerId`);
      }
      if (o.visible !== undefined && typeof o.visible !== "boolean") {
        throw new Error(`viewport '${r.id}': override visible must be a boolean when present`);
      }
      if (o.frozen !== undefined && typeof o.frozen !== "boolean") {
        throw new Error(`viewport '${r.id}': override frozen must be a boolean when present`);
      }
      if (seen.has(o.layerId as string)) {
        throw new Error(`viewport '${r.id}': duplicate layer override for '${o.layerId as string}' (one entry per layer)`);
      }
      seen.add(o.layerId as string);
      overrides.push({
        layerId: o.layerId as string,
        ...(o.visible !== undefined ? { visible: o.visible as boolean } : {}),
        ...(o.frozen !== undefined ? { frozen: o.frozen as boolean } : {}),
      });
    }
    layerOverrides = overrides;
  }
  return {
    id: r.id as string,
    layoutId: r.layoutId as string,
    corner1,
    corner2,
    camera: { centerX: cam.centerX as number, centerY: cam.centerY as number },
    scaleDenominator: r.scaleDenominator as number,
    rotationDeg: r.rotationDeg as number,
    ...(r.locked !== undefined ? { locked: r.locked as boolean } : {}),
    ...(layerOverrides !== undefined ? { layerOverrides } : {}),
  };
}

/** Keys a viewport patch may carry (id/layoutId are the record identity —
 *  immutable; moving a viewport to another layout is a remove + re-create,
 *  the honest bounded rule). */
const VIEWPORT_PATCH_KEYS = ["corner1", "corner2", "camera", "scaleDenominator", "rotationDeg", "locked", "layerOverrides"] as const;

/** Validate + merge an updateViewport patch (the merged record re-validates
 *  as a whole). */
export function applyViewportPatch(current: ViewportRecord, patch: Readonly<Record<string, unknown>>): ViewportRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "layoutId") {
      throw new Error("updateViewport: id/layoutId are the viewport identity — immutable (remove + re-create)");
    }
    if (!(VIEWPORT_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateViewport: unknown field '${key}' (allowed: ${VIEWPORT_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateViewportRecord(cleaned);
}

/** CAD-PARITY-008: derive the viewport mint-sequence counter from existing
 *  minted ids (`vp-NNNNNN`). */
export function deriveViewportSequence(viewports: readonly ViewportRecord[]): number {
  let max = 0;
  for (const v of viewports) {
    const m = /^vp-(\d{6,})$/.exec(v.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}
