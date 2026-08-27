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
  DocsElevationDirection,
  DocsSheetRecord,
  DocsTitleBlock,
  DocsViewKind,
  DocsViewPlacement,
  DocsViewRecord,
  DraftingSettings,
  LayerRecord,
  SnapKind,
} from "../contracts/caddocument.js";
import { DOCS_SHEET_FRAME as SHEET_FRAME } from "../contracts/caddocument.js";

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
 *  malformed input; returns the record untouched when valid. */
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
  return layer as LayerRecord;
}

/** Keys a layer patch may carry (updateLayer whitelists; anything else is
 *  rejected — no silent partial application). */
const LAYER_PATCH_KEYS = ["name", "color", "visible"] as const;

/** Validate + normalize an updateLayer patch against the current record.
 *  Returns the MERGED record (current ∪ patch). Throws on unknown keys or
 *  invalid merged results. */
export function applyLayerPatch(current: LayerRecord, patch: Readonly<Record<string, unknown>>): LayerRecord {
  for (const key of Object.keys(patch)) {
    if (!(LAYER_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateLayer: unknown layer field '${key}' (allowed: ${LAYER_PATCH_KEYS.join(", ")})`);
    }
  }
  const merged: LayerRecord = {
    id: current.id,
    name: patch.name !== undefined ? (patch.name as string) : current.name,
    color: patch.color !== undefined ? (patch.color as string) : current.color,
    visible: patch.visible !== undefined ? (patch.visible as boolean) : current.visible,
  };
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
  return {
    units: "mm",
    grid: { enabled: g.enabled as boolean, size: g.size as number },
    snap: { enabled: sn.enabled as boolean, kinds, tolerance: sn.tolerance as number },
    view: { pan: [vw.pan[0] as number, vw.pan[1] as number], zoom: vw.zoom as number },
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
