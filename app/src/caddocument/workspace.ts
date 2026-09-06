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
  // CAD-PARITY-013 (additive, Issue #104): the documentation production
  // record tables.
  NavigatorNodeRecord,
  PublisherItem,
  PublisherSetRecord,
  RevisionRecord,
  ScheduleColumn,
  ScheduleRecord,
  ScheduleSource,
  TitleBlockRecord,
  TitleBlockRow,
  // CAD-PARITY-015 (additive, Issue #110): the schedules/indexes engine
  // extensions (formula/operand/format/condition) + the property-definition
  // registry record.
  ScheduleFormula,
  ScheduleOperand,
  ScheduleColumnFormat,
  ScheduleCondition,
  PropertyDefRecord,
} from "../contracts/caddocument.js";
import { DOCS_SHEET_FRAME as SHEET_FRAME } from "../contracts/caddocument.js";
// CAD-PARITY-013: the canonical BIM property-set key grammar (the dynamic
// `ps:<set>.<key>` schedule columns validate against it — the bim/meta
// surface is engine-free, LOCK-018; no cycle: bim/meta imports only
// bim/elements + contracts types).
import { BIM_PROPERTY_KEY_PATTERN } from "../bim/meta.js";
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
import { orientedSheetSize, validatePageSetup } from "../workspace/layouts/paper.js";
// CAD-PARITY-009: the shared 3D navigation/UCS/workplane/section grammar —
// the SAME precedent: the shared engine-free model3d modules ARE the
// validators (no cycle: model3d imports contracts types only).
import {
  validateCamera,
  normalizeCamera,
  validateUcsRecord as validateUcsRecordShape,
  validateSectionPlaneRecord as validateSectionPlaneRecordShape,
} from "../workspace/model3d/index.js";
import type { Camera3DState, SectionPlaneRecord, UcsRecord } from "../contracts/caddocument.js";

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
    activeLayout?: string;
    space?: "model" | "paper";
    activeUcs?: string;
    view3d?: Camera3DState;
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
  // CAD-PARITY-009 (additive + optional): the ACTIVE UCS id (the
  // current-workplane semantics — non-versioned editor state; "world" or
  // absent = the implicit World UCS; dangling-id repair lives at document
  // open where the adopted table is available) and the persisted 3D camera
  // state (validated through the SHARED camera grammar — the normalized
  // frame is what persists; view state strictly separated from model
  // history).
  if (s.activeUcs !== undefined) {
    if (typeof s.activeUcs !== "string" || (s.activeUcs as string).length === 0) {
      throw new Error("draftingSettings.activeUcs must be a non-empty string when present ('world' = the implicit World UCS)");
    }
    optional.activeUcs = s.activeUcs as string;
  }
  const camera3d = validateCamera3DSettings(s.view3d);
  if (camera3d !== null) optional.view3d = camera3d;
  // CAD-PARITY-008 (additive + optional): the active layout id + the
  // TILEMODE-class space context (persisted editor state; cross-reference
  // checks like activeLayout existence live in the App API layer where the
  // adopted table is available — the activeLayer precedent).
  if (s.activeLayout !== undefined) {
    if (typeof s.activeLayout !== "string" || (s.activeLayout as string).length === 0) {
      throw new Error("draftingSettings.activeLayout must be a non-empty string when present");
    }
    optional.activeLayout = s.activeLayout as string;
  }
  if (s.space !== undefined) {
    if (s.space !== "model" && s.space !== "paper") {
      throw new Error("draftingSettings.space must be 'model' or 'paper' when present");
    }
    optional.space = s.space;
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
  // CAD-PARITY-013: the navigator View Map folder reference (shape only —
  // the cross-record existence/kind check lives at the document boundary
  // where the navigator table is available).
  if (v.folderId !== undefined && (typeof v.folderId !== "string" || v.folderId.length === 0)) {
    throw new Error(`view '${v.id}': folderId must be a non-empty string when present`);
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

/** Keys a view patch may carry (updateView whitelists). CAD-PARITY-013
 *  adds `folderId` (null unassigns — the folder is removed, the view files
 *  at the map root). */
const VIEW_PATCH_KEYS = ["title", "scale", "storyId", "direction", "sectionAxis", "sectionOffset", "sourceViewId", "region", "detailScale", "folderId"] as const;

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
  // removes it — representable, validated below. CAD-PARITY-013: folderId null
  // ALSO unassigns (the wire representation of absence).
  const cleaned: Record<string, unknown> = { ...merged };
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) delete cleaned[key];
    if (key === "folderId" && cleaned[key] === null) delete cleaned[key];
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
  // CAD-PARITY-012 (additive): the definition's default material association
  // (structural validation only — the EXISTING-material reference check runs
  // at the command layer, where the element world is visible).
  if (b.materialId !== undefined && b.materialId !== null && (typeof b.materialId !== "string" || b.materialId.length === 0)) {
    throw new Error(`blockDef '${b.name}': materialId must be a non-empty material element id when present`);
  }
  // COMPAT-CAD-009 (additive): the monotonic insert sequence counter.
  // Optional; when present must be a non-negative integer.
  if (b.insertSeq !== undefined && b.insertSeq !== null) {
    if (typeof b.insertSeq !== "number" || !Number.isInteger(b.insertSeq) || b.insertSeq < 0) {
      throw new Error(`blockDef '${b.name}': insertSeq must be a non-negative integer when present`);
    }
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
  // CAD-PARITY-012 (additive): written ONLY when set (the additive-optional
  // contract — absence is the canonical no-default form, never undefined).
  if (typeof b.materialId === "string" && b.materialId.length > 0) out.materialId = b.materialId;
  // COMPAT-CAD-009 (additive): written ONLY when present (legacy byte-identical).
  if (typeof b.insertSeq === "number" && Number.isInteger(b.insertSeq) && b.insertSeq >= 0) out.insertSeq = b.insertSeq;
  return out as unknown as BlockDefinitionRecord;
}

/** Keys a block-definition patch may carry (id/createdAt are immutable). */
const BLOCK_DEF_PATCH_KEYS = ["name", "basePoint", "description", "entities", "materialId", "insertSeq"] as const;

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
    // null RESETS the optional description/materialId to absent.
    if (value === null && (key === "description" || key === "materialId")) {
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
 *  LOCK-007). CAD-PARITY-013 adds the additive optional fields (subsetId,
 *  masterId, titleBlockPlacement, revisionIds): each is SHAPE-validated here
 *  (an absent field means its default — no subset, no master, no placement,
 *  no revisions — so pre-P013 records pass byte-identically); the
 *  CROSS-RECORD reference checks (subset exists and is a subset, master
 *  exists/is not self/has no master of its own, title-block target exists,
 *  revision ids exist) live at the document boundary where the tables are
 *  available (the validateViewReferences split). The title-block placement
 *  must fit INSIDE the layout's ORIENTED sheet (the placement is
 *  layout-space geometry, validated against the layout's own record). */
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
  // CAD-PARITY-013: the additive optional fields (shape grammar).
  if (r.subsetId !== undefined && (typeof r.subsetId !== "string" || r.subsetId.length === 0)) {
    throw new Error(`layout '${r.id}': subsetId must be a non-empty string when present`);
  }
  if (r.masterId !== undefined && (typeof r.masterId !== "string" || r.masterId.length === 0)) {
    throw new Error(`layout '${r.id}': masterId must be a non-empty string when present`);
  }
  let titleBlockPlacement: LayoutRecord["titleBlockPlacement"] | undefined;
  if (r.titleBlockPlacement !== undefined && r.titleBlockPlacement !== null) {
    if (typeof r.titleBlockPlacement !== "object") {
      throw new Error(`layout '${r.id}': titleBlockPlacement must be an object when present`);
    }
    const p = r.titleBlockPlacement as Record<string, unknown>;
    if (typeof p.titleBlockId !== "string" || p.titleBlockId.length === 0) {
      throw new Error(`layout '${r.id}': titleBlockPlacement.titleBlockId must be a non-empty string`);
    }
    if (!isFiniteNumber(p.xMm) || !isFiniteNumber(p.yMm)) {
      throw new Error(`layout '${r.id}': titleBlockPlacement.xMm/yMm must be finite numbers`);
    }
    titleBlockPlacement = { titleBlockId: p.titleBlockId, xMm: p.xMm, yMm: p.yMm };
  }
  let revisionIds: readonly string[] | undefined;
  if (r.revisionIds !== undefined && r.revisionIds !== null) {
    if (!Array.isArray(r.revisionIds) || !r.revisionIds.every((x) => typeof x === "string" && x.length > 0)) {
      throw new Error(`layout '${r.id}': revisionIds must be an array of non-empty strings when present`);
    }
    const seen = new Set<string>();
    for (const id of r.revisionIds as readonly string[]) {
      if (seen.has(id)) {
        throw new Error(`layout '${r.id}': duplicate revisionId '${id}' (unique, document order)`);
      }
      seen.add(id);
    }
    // Canonical-minimal: an EMPTY revisionIds array is normalized to absent
    // (byte-identical to the pre-P013 record).
    if ((r.revisionIds as readonly string[]).length > 0) {
      revisionIds = [...(r.revisionIds as readonly string[])];
    }
  }
  if (titleBlockPlacement !== undefined) {
    const sheet = orientedSheetSize(pageSetup);
    if (
      titleBlockPlacement.xMm < 0 || titleBlockPlacement.xMm > sheet.widthMm ||
      titleBlockPlacement.yMm < 0 || titleBlockPlacement.yMm > sheet.heightMm
    ) {
      throw new Error(
        `layout '${r.id}': the title-block placement (${titleBlockPlacement.xMm}, ${titleBlockPlacement.yMm}) does not fit inside the oriented sheet ${sheet.widthMm}×${sheet.heightMm} mm`,
      );
    }
  }
  return {
    id: r.id,
    name: r.name,
    pageSetup,
    createdAt: r.createdAt,
    ...(r.subsetId !== undefined && r.subsetId !== null ? { subsetId: r.subsetId } : {}),
    ...(r.masterId !== undefined && r.masterId !== null ? { masterId: r.masterId } : {}),
    ...(titleBlockPlacement !== undefined ? { titleBlockPlacement } : {}),
    ...(revisionIds !== undefined ? { revisionIds } : {}),
  };
}

/** Keys a layout patch may carry (id/createdAt are the record identity —
 *  immutable; pageSetup/titleBlockPlacement replace the whole embedded
 *  object; subsetId/masterId/titleBlockPlacement/revisionIds accept null to
 *  unassign — CAD-PARITY-013). */
const LAYOUT_PATCH_KEYS = ["name", "pageSetup", "subsetId", "masterId", "titleBlockPlacement", "revisionIds"] as const;

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
    // null unassigns the optional CAD-PARITY-013 fields (the wire
    // representation of absence); an empty revisionIds array normalizes to
    // absent (canonical-minimal records).
    if (value === null && (key === "subsetId" || key === "masterId" || key === "titleBlockPlacement" || key === "revisionIds")) {
      delete cleaned[key];
      continue;
    }
    if (key === "revisionIds" && Array.isArray(value) && value.length === 0) {
      delete cleaned[key];
      continue;
    }
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

// --- CAD-PARITY-009 (additive, Issue #90): the UCS + section-plane tables ---

const UCS_PATCH_KEYS = ["name", "origin", "xAxis", "yAxis", "zAxis"] as const;
const SECTION_PLANE_PATCH_KEYS = ["name", "origin", "normal"] as const;

/** CAD-PARITY-009: validate a UCS table record through the SHARED model3d
 *  grammar (right-handed orthonormal axes within UCS_ORTHONORMAL_TOLERANCE —
 *  degenerate/non-orthonormal triples are rejected, never normalized). The
 *  name is trimmed-checked, non-empty, max 255 chars; the World UCS is
 *  implicit so the reserved name (case-insensitive "world") and the reserved
 *  id "world" are typed rejections. */
export function validateUcsTableRecord(record: unknown): UcsRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("ucs record must be an object");
  }
  const failure = validateUcsRecordShape(record as UcsRecord);
  if (failure !== null) throw new Error(`ucs record: ${failure}`);
  const r = record as UcsRecord;
  if (r.name.length > 255) {
    throw new Error(`ucs '${r.id}': name must be max 255 chars`);
  }
  if (r.id === "world") {
    throw new Error("ucs record: id 'world' is the implicit World UCS — never a table record");
  }
  if (r.name.trim().toLowerCase() === "world") {
    throw new Error(`ucs '${r.id}': the name 'World' is reserved for the implicit World UCS`);
  }
  return { id: r.id, name: r.name.trim(), origin: [...r.origin], xAxis: [...r.xAxis], yAxis: [...r.yAxis], zAxis: [...r.zAxis], createdAt: r.createdAt };
}

/** CAD-PARITY-009: validate + merge an updateUcs patch (the merged record
 *  re-validates as a whole through the shared grammar). */
export function applyUcsPatch(current: UcsRecord, patch: Readonly<Record<string, unknown>>): UcsRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "createdAt") {
      throw new Error("updateUcs: id/createdAt are the UCS identity — immutable");
    }
    if (!(UCS_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateUcs: unknown field '${key}' (allowed: ${UCS_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateUcsTableRecord(cleaned);
}

/** CAD-PARITY-009: derive the UCS mint-sequence counter from existing
 *  minted ids (`ucs-NNNNNN`). */
export function deriveUcsSequence(ucsTable: readonly UcsRecord[]): number {
  let max = 0;
  for (const u of ucsTable) {
    const m = /^ucs-(\d{6,})$/.exec(u.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** CAD-PARITY-009: validate a section-plane table record through the SHARED
 *  model3d grammar (finite origin + UNIT normal — the zero vector is a typed
 *  decline; un-normalized input is accepted ONLY through the explicit
 *  command-layer normalize path, never silently here). */
export function validateSectionPlaneTableRecord(record: unknown): SectionPlaneRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("section plane record must be an object");
  }
  const failure = validateSectionPlaneRecordShape(record as SectionPlaneRecord);
  if (failure !== null) throw new Error(`section plane record: ${failure}`);
  const r = record as SectionPlaneRecord;
  if (r.name.length > 255) {
    throw new Error(`section plane '${r.id}': name must be max 255 chars`);
  }
  return { id: r.id, name: r.name.trim(), origin: [...r.origin], normal: [...r.normal], createdAt: r.createdAt };
}

/** CAD-PARITY-009: validate + merge an updateSectionPlane patch. */
export function applySectionPlanePatch(current: SectionPlaneRecord, patch: Readonly<Record<string, unknown>>): SectionPlaneRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "createdAt") {
      throw new Error("updateSectionPlane: id/createdAt are the section plane identity — immutable");
    }
    if (!(SECTION_PLANE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateSectionPlane: unknown field '${key}' (allowed: ${SECTION_PLANE_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateSectionPlaneTableRecord(cleaned);
}

/** CAD-PARITY-009: derive the section-plane mint-sequence counter from
 *  existing minted ids (`sp-NNNNNN`). */
export function deriveSectionPlaneSequence(planes: readonly SectionPlaneRecord[]): number {
  let max = 0;
  for (const sp of planes) {
    const m = /^sp-(\d{6,})$/.exec(sp.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** CAD-PARITY-009: validate a persisted Camera3DState editor setting
 *  (additive-optional) through the SHARED camera grammar; the stored state
 *  is the NORMALIZED frame (deterministic rounding — the same arithmetic on
 *  every host). Returns null (field omitted) for absent input. */
export function validateCamera3DSettings(value: unknown): Camera3DState | null {
  if (value === undefined || value === null) return null;
  const failure = validateCamera(value as Camera3DState);
  if (failure !== null) throw new Error(`draftingSettings.view3d: ${failure}`);
  const normalized = normalizeCamera(value as Camera3DState);
  if (normalized === null) {
    throw new Error("draftingSettings.view3d: camera frame is degenerate");
  }
  return normalized;
}

// --- CAD-PARITY-013 (additive, Issue #104): the documentation production
// record tables — navigator nodes, title blocks, schedules, revisions and
// publisher sets. Every validator is STRICT (LOCK-007: malformed input is
// REJECTED, never guessed/repaired); cross-record reference checks (parent
// existence + same-kind + cycles, title-block targets, layout/revision
// references, publisher item targets + duplicate expansion) live at the
// document/applyEdit boundary where the tables are available (the
// validateViewReferences split). -----------------------------------------------------------------

const NAVIGATOR_NODE_KINDS: readonly ("folder" | "subset")[] = ["folder", "subset"];
const NAVIGATOR_NUMBERINGS: readonly ("none" | "custom")[] = ["none", "custom"];

/** CAD-PARITY-013: validate + normalize a navigator tree record (the
 *  structural grammar: kind-tagged, trimmed non-empty name max 80, integer
 *  order >= 1, parentId null-or-string; the subset-only prefix/numbering/
 *  customNumber grammar — prefix max 12, numbering none|custom, customNumber
 *  required iff custom and max 8; ALL subset fields are rejected on kind
 *  "folder"). Name UNIQUENESS is not required (the id is the address);
 *  parent existence/same-kind and cycle checks live at the document
 *  boundary. */
export function validateNavigatorNodeRecord(record: unknown): NavigatorNodeRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("navigator node record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("navigator node record: id must be a non-empty string");
  }
  if (!(NAVIGATOR_NODE_KINDS as readonly unknown[]).includes(r.kind)) {
    throw new Error(`navigator node '${r.id}': kind must be "folder" | "subset"`);
  }
  const kind = r.kind as "folder" | "subset";
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.trim().length > 80) {
    throw new Error(`navigator node '${r.id}': name must be a non-empty trimmed string (max 80 chars)`);
  }
  if (r.parentId !== null && (typeof r.parentId !== "string" || r.parentId.length === 0)) {
    throw new Error(`navigator node '${r.id}': parentId must be null (root) or a non-empty string`);
  }
  if (typeof r.order !== "number" || !Number.isInteger(r.order) || r.order < 1) {
    throw new Error(`navigator node '${r.id}': order must be an integer >= 1 (sibling order)`);
  }
  if (kind === "folder") {
    for (const forbidden of ["prefix", "numbering", "customNumber"] as const) {
      if (r[forbidden] !== undefined && r[forbidden] !== null) {
        throw new Error(`navigator node '${r.id}': folder nodes must not carry '${forbidden}' (subset-only field)`);
      }
    }
    return { id: r.id, kind, name: r.name.trim(), parentId: r.parentId as string | null, order: r.order };
  }
  let prefix: string | undefined;
  if (r.prefix !== undefined && r.prefix !== null) {
    if (typeof r.prefix !== "string" || r.prefix.length === 0 || r.prefix.length > 12) {
      throw new Error(`navigator node '${r.id}': prefix must be a non-empty string (max 12 chars)`);
    }
    prefix = r.prefix;
  }
  let numbering: "none" | "custom" | undefined;
  if (r.numbering !== undefined && r.numbering !== null) {
    if (!(NAVIGATOR_NUMBERINGS as readonly unknown[]).includes(r.numbering)) {
      throw new Error(`navigator node '${r.id}': numbering must be "none" | "custom"`);
    }
    numbering = r.numbering as "none" | "custom";
  }
  let customNumber: string | undefined;
  if (r.customNumber !== undefined && r.customNumber !== null) {
    if (typeof r.customNumber !== "string" || r.customNumber.length === 0 || r.customNumber.length > 8) {
      throw new Error(`navigator node '${r.id}': customNumber must be a non-empty string (max 8 chars, e.g. "01")`);
    }
    customNumber = r.customNumber;
  }
  if (numbering === "custom" && customNumber === undefined) {
    throw new Error(`navigator node '${r.id}': numbering "custom" requires customNumber (the zero-padded counter start)`);
  }
  if (numbering !== undefined && numbering !== "custom" && customNumber !== undefined) {
    throw new Error(`navigator node '${r.id}': customNumber is only valid with numbering "custom"`);
  }
  return {
    id: r.id,
    kind,
    name: r.name.trim(),
    parentId: r.parentId as string | null,
    order: r.order,
    ...(prefix !== undefined ? { prefix } : {}),
    ...(numbering !== undefined ? { numbering } : {}),
    ...(customNumber !== undefined ? { customNumber } : {}),
  };
}

/** Keys a navigator node patch may carry (id/kind are the record identity —
 *  immutable: re-parenting is a parentId patch, never a kind change). */
export const NAVIGATOR_PATCH_KEYS = ["name", "parentId", "order", "prefix", "numbering", "customNumber"] as const;

/** Validate + merge an updateNavigatorNode patch (kind immutable; the merged
 *  record re-validates as a whole; null prefix/numbering/customNumber values
 *  unassign those subset fields — the wire representation of absence). */
export function applyNavigatorNodePatch(current: NavigatorNodeRecord, patch: Readonly<Record<string, unknown>>): NavigatorNodeRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "kind") {
      throw new Error("updateNavigatorNode: id/kind are the navigator identity — immutable (remove + re-create)");
    }
    if (!(NAVIGATOR_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateNavigatorNode: unknown field '${key}' (allowed: ${NAVIGATOR_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (key === "prefix" || key === "numbering" || key === "customNumber")) {
      delete cleaned[key];
      continue;
    }
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateNavigatorNodeRecord(cleaned);
}

/** CAD-PARITY-013: derive the navigator mint-sequence counter from existing
 *  minted ids (`nav-NNNNNN`) — the deriveLayoutSequence contract. */
export function deriveNavigatorNodeSequence(nodes: readonly NavigatorNodeRecord[]): number {
  let max = 0;
  for (const n of nodes) {
    const m = /^nav-(\d{6,})$/.exec(n.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

const TITLE_BLOCK_FIELDS: readonly ("layoutName" | "sheetNumber" | "revisions" | "text")[] = [
  "layoutName",
  "sheetNumber",
  "revisions",
  "text",
];

/** CAD-PARITY-013: validate + normalize a title-block record (the structural
 *  grammar: name trimmed non-empty max 60, widthMm 20..500, heightMm
 *  20..300 and >= rows*rowHeightMm, rowHeightMm 4..60, 1..12 rows; each row
 *  label trimmed non-empty max 40, field from the closed vocabulary, value
 *  required iff field "text" (max 80) and rejected otherwise). Name
 *  UNIQUENESS among title blocks is enforced at the document boundary. */
export function validateTitleBlockRecord(record: unknown): TitleBlockRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("title block record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("title block record: id must be a non-empty string");
  }
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.trim().length > 60) {
    throw new Error(`title block '${r.id}': name must be a non-empty trimmed string (max 60 chars)`);
  }
  for (const [key, min, max] of [["widthMm", 20, 500], ["heightMm", 20, 300], ["rowHeightMm", 4, 60]] as const) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`title block '${r.id}': ${key} must be a finite number in ${min}..${max} mm`);
    }
  }
  if (!Array.isArray(r.rows) || r.rows.length < 1 || r.rows.length > 12) {
    throw new Error(`title block '${r.id}': rows must be an array of 1..12 rows`);
  }
  const rows: TitleBlockRow[] = [];
  for (let i = 0; i < r.rows.length; i++) {
    const raw = r.rows[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`title block '${r.id}': rows[${i}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.label !== "string" || row.label.trim().length === 0 || row.label.trim().length > 40) {
      throw new Error(`title block '${r.id}': rows[${i}].label must be a non-empty trimmed string (max 40 chars)`);
    }
    if (!(TITLE_BLOCK_FIELDS as readonly unknown[]).includes(row.field)) {
      throw new Error(`title block '${r.id}': rows[${i}].field must be one of ${TITLE_BLOCK_FIELDS.join(" | ")}`);
    }
    if (row.field === "text") {
      if (typeof row.value !== "string" || row.value.length === 0 || row.value.length > 80) {
        throw new Error(`title block '${r.id}': rows[${i}] with field "text" requires a value (non-empty string, max 80 chars)`);
      }
    } else if (row.value !== undefined && row.value !== null) {
      throw new Error(`title block '${r.id}': rows[${i}] with field '${String(row.field)}' must not carry a value (derived field)`);
    }
    rows.push({
      label: row.label.trim(),
      field: row.field as TitleBlockRow["field"],
      ...(row.field === "text" ? { value: row.value as string } : {}),
    });
  }
  const heightMm = r.heightMm as number;
  const rowHeightMm = r.rowHeightMm as number;
  if (heightMm < rows.length * rowHeightMm) {
    throw new Error(
      `title block '${r.id}': heightMm ${heightMm} must cover ${rows.length} row(s) × ${rowHeightMm} mm (= ${rows.length * rowHeightMm} mm)`,
    );
  }
  return { id: r.id, name: (r.name as string).trim(), widthMm: r.widthMm as number, heightMm, rowHeightMm, rows };
}

/** Keys a title-block patch may carry (id is the record identity). */
export const TITLEBLOCK_PATCH_KEYS = ["name", "widthMm", "heightMm", "rowHeightMm", "rows"] as const;

/** Validate + merge an updateTitleBlock patch (the merged record re-validates
 *  as a whole). */
export function applyTitleBlockPatch(current: TitleBlockRecord, patch: Readonly<Record<string, unknown>>): TitleBlockRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      throw new Error("updateTitleBlock: id is the title-block identity — immutable");
    }
    if (!(TITLEBLOCK_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateTitleBlock: unknown field '${key}' (allowed: ${TITLEBLOCK_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateTitleBlockRecord(cleaned);
}

/** CAD-PARITY-013: derive the title-block mint-sequence counter from
 *  existing minted ids (`tb-NNNNNN`). */
export function deriveTitleBlockSequence(blocks: readonly TitleBlockRecord[]): number {
  let max = 0;
  for (const b of blocks) {
    const m = /^tb-(\d{6,})$/.exec(b.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** The closed schedule column-key vocabulary per source (CAD-PARITY-013;
 *  `ps:<set>.<key>` dynamic property columns are additionally valid for the
 *  elements/components sources — see isDynamicPropertyColumn). */
export const SCHEDULE_COLUMN_KEYS: Readonly<Record<ScheduleSource, readonly string[]>> = Object.freeze({
  elements: [
    "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
  ],
  components: [
    "id", "type", "name", "story", "layer", "material", "classification", "renovationStatus", "option",
  ],
  materials: ["id", "name", "category", "color", "lineweight", "density"],
  views: ["id", "kind", "title", "scale", "folder", "contentHash", "primitives"],
  layouts: ["id", "name", "subset", "master", "sheetNumber", "titleBlock", "revisions"],
  sheets: ["id", "title", "sheetNumber", "projectName", "views"],
});

/** The schedule sources that accept a filter (type/storyId). */
export const SCHEDULE_FILTERED_SOURCES: readonly ScheduleSource[] = ["elements", "components"];

/** Is a column key a dynamic property-set value reference
 *  (`ps:<set>.<key>`)? The set name must be non-empty (max 64 chars — the
 *  BIM_PROPERTY_SET_NAME_MAX bound) and the property key must match the
 *  canonical BIM property key pattern (letters/digits/underscores). */
export function isDynamicPropertyColumn(key: string): boolean {
  if (!key.startsWith("ps:")) return false;
  const rest = key.slice(3);
  const dot = rest.indexOf(".");
  if (dot <= 0) return false;
  const setName = rest.slice(0, dot);
  const propKey = rest.slice(dot + 1);
  return (
    setName.length > 0 && setName.length <= 64 &&
    propKey.length > 0 && BIM_PROPERTY_KEY_PATTERN.test(propKey)
  );
}

// --- CAD-PARITY-015 (additive, Issue #110): the dynamic column key forms --
//
// `pd:<prd-NNNNNN>` — a property-DEFINITION column (the document-owned
// property registry; the run resolves the definition's (set, key) address
// against the element property-set overlay — values are NEVER stored on
// the definition). Valid on the elements/components sources only.
// `calc:<name>` — a calculated column carrying a bounded arithmetic
// formula over the schedule's numeric columns. Valid on EVERY source.

/** The calculated-column key grammar: `calc:` + a canonical name (a letter
 *  followed by letters/digits/underscores, ≤ 32 chars). */
export const SCHEDULE_CALC_KEY_PATTERN = /^calc:[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** The property-definition column key grammar: `pd:` + a canonical minted
 *  `prd-NNNNNN` identity. */
export const SCHEDULE_PD_KEY_PATTERN = /^pd:prd-\d{6}$/;

/** Is a column key a calculated-field column (`calc:<name>`)? */
export function isCalculatedColumn(key: string): boolean {
  return SCHEDULE_CALC_KEY_PATTERN.test(key);
}

/** Is a column key a property-definition column (`pd:<prd-NNNNNN>`)? */
export function isPropertyDefColumn(key: string): boolean {
  return SCHEDULE_PD_KEY_PATTERN.test(key);
}

/** CAD-PARITY-013: validate + normalize a schedule record (the structural
 *  grammar: name trimmed non-empty max 60, a closed source vocabulary, a
 *  filter ONLY on the elements/components sources ({type?, storyId?} —
 *  non-empty strings), 1..12 columns each with a trimmed non-empty label
 *  max 40 and a key from the CLOSED per-source vocabulary or the dynamic
 *  `ps:<set>.<key>` form on the elements/components sources). Name
 *  UNIQUENESS among schedules is enforced at the document boundary.
 *
 *  CAD-PARITY-015 (additive, Issue #110): the dynamic column grammar
 *  extends to `pd:<prd-NNNNNN>` (elements/components sources) and
 *  `calc:<name>` (every source — a calc column MUST carry a bounded
 *  arithmetic formula, non-calc columns MUST NOT); columns may carry an
 *  optional deterministic `format` {unit?, align?}; and the record may
 *  carry optional `sort` (1..3 column-key rules, stable), `grouping`
 *  (1..3 column keys) and `conditions` (1..4 property-driven AND-ed
 *  conditions, elements/components sources only — gt/lt need a number
 *  comparand, contains a string, eq/ne any typed value). */
export function validateScheduleRecord(record: unknown): ScheduleRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("schedule record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("schedule record: id must be a non-empty string");
  }
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.trim().length > 60) {
    throw new Error(`schedule '${r.id}': name must be a non-empty trimmed string (max 60 chars)`);
  }
  const source = r.source as ScheduleSource;
  if (!(Object.keys(SCHEDULE_COLUMN_KEYS) as readonly string[]).includes(r.source as string)) {
    throw new Error(`schedule '${r.id}': source must be one of ${Object.keys(SCHEDULE_COLUMN_KEYS).join(" | ")}`);
  }
  let filter: ScheduleRecord["filter"];
  if (r.filter !== undefined && r.filter !== null) {
    if (!(SCHEDULE_FILTERED_SOURCES as readonly string[]).includes(source)) {
      throw new Error(`schedule '${r.id}': a filter is only valid on the elements/components sources (got '${source}')`);
    }
    if (typeof r.filter !== "object") {
      throw new Error(`schedule '${r.id}': filter must be an object { type?, storyId? }`);
    }
    const f = r.filter as Record<string, unknown>;
    if (f.type !== undefined && f.type !== null && (typeof f.type !== "string" || f.type.length === 0)) {
      throw new Error(`schedule '${r.id}': filter.type must be a non-empty string when present (a BIM element type)`);
    }
    if (f.storyId !== undefined && f.storyId !== null && (typeof f.storyId !== "string" || f.storyId.length === 0)) {
      throw new Error(`schedule '${r.id}': filter.storyId must be a non-empty string when present`);
    }
    filter = {
      ...(typeof f.type === "string" && f.type.length > 0 ? { type: f.type } : {}),
      ...(typeof f.storyId === "string" && f.storyId.length > 0 ? { storyId: f.storyId } : {}),
    };
  }
  if (!Array.isArray(r.columns) || r.columns.length < 1 || r.columns.length > 12) {
    throw new Error(`schedule '${r.id}': columns must be an array of 1..12 columns`);
  }
  const vocabulary = SCHEDULE_COLUMN_KEYS[source];
  const dynamic = (SCHEDULE_FILTERED_SOURCES as readonly string[]).includes(source);
  const rawColumnKeys = (r.columns as { key?: unknown }[]).map((c) => (typeof c.key === "string" ? c.key : ""));
  const columns: ScheduleColumn[] = [];
  for (let i = 0; i < r.columns.length; i++) {
    const raw = r.columns[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`schedule '${r.id}': columns[${i}] must be an object`);
    }
    const col = raw as Record<string, unknown>;
    if (typeof col.key !== "string" || col.key.length === 0) {
      throw new Error(`schedule '${r.id}': columns[${i}].key must be a non-empty string`);
    }
    const isCalc = isCalculatedColumn(col.key);
    const isPd = isPropertyDefColumn(col.key);
    if (
      !vocabulary.includes(col.key) &&
      !(dynamic && isDynamicPropertyColumn(col.key)) &&
      !(dynamic && isPd) &&
      !isCalc
    ) {
      throw new Error(
        `schedule '${r.id}': columns[${i}].key '${col.key}' is not in the '${source}' column vocabulary [${vocabulary.join(", ")}${dynamic ? ", ps:<set>.<key>, pd:<prd-NNNNNN>" : ""}, calc:<name>]`,
      );
    }
    if (typeof col.label !== "string" || col.label.trim().length === 0 || col.label.trim().length > 40) {
      throw new Error(`schedule '${r.id}': columns[${i}].label must be a non-empty trimmed string (max 40 chars)`);
    }
    // CAD-PARITY-015: the calculated-field formula — REQUIRED on calc:
    // columns, FORBIDDEN on every other key form. Operand column references
    // validate against THIS schedule's raw column-key list (every declared
    // column key, in declaration order).
    let formula: ScheduleColumn["formula"];
    if (col.formula !== undefined && col.formula !== null) {
      if (!isCalc) {
        throw new Error(
          `schedule '${r.id}': columns[${i}].formula is only valid on calc:<name> columns (got key '${col.key}')`,
        );
      }
      formula = validateScheduleFormula(r.id, i, col.formula, rawColumnKeys);
    } else if (isCalc) {
      throw new Error(`schedule '${r.id}': columns[${i}] (key '${col.key}') requires a formula { op, left, right }`);
    }
    // CAD-PARITY-015: the deterministic presentation format (any column).
    let format: ScheduleColumn["format"];
    if (col.format !== undefined && col.format !== null) {
      format = validateScheduleColumnFormat(r.id, i, col.format);
    }
    columns.push({
      key: col.key,
      label: col.label.trim(),
      ...(formula !== undefined ? { formula } : {}),
      ...(format !== undefined ? { format } : {}),
    });
  }
  // CAD-PARITY-015: sort / grouping / conditions (column-key references are
  // resolved against THIS schedule's validated column set).
  const columnKeys = columns.map((c) => c.key);
  const sort = validateScheduleSort(r.id, r.sort, columnKeys);
  const grouping = validateScheduleGrouping(r.id, r.grouping, columnKeys, source);
  const conditions = validateScheduleConditions(r.id, r.conditions, source);
  return {
    id: r.id,
    name: (r.name as string).trim(),
    source,
    ...(filter !== undefined ? { filter } : {}),
    columns,
    ...(sort !== undefined ? { sort } : {}),
    ...(grouping !== undefined ? { grouping } : {}),
    ...(conditions !== undefined ? { conditions } : {}),
  };
}

/** CAD-PARITY-015: validate one formula operand ({column} | {value}). */
function validateScheduleOperand(
  scheduleId: string,
  colIndex: number,
  side: "left" | "right",
  value: unknown,
  columnKeys: readonly string[],
): ScheduleOperand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula.${side} must be { column } or { value }`);
  }
  const op = value as Record<string, unknown>;
  const keys = Object.keys(op);
  if (keys.length !== 1) {
    throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula.${side} must have exactly one of column | value`);
  }
  if (keys[0] === "column") {
    const ref = op.column;
    if (typeof ref !== "string" || !columnKeys.includes(ref)) {
      throw new Error(
        `schedule '${scheduleId}': columns[${colIndex}].formula.${side}.column '${JSON.stringify(ref)}' is not a column of this schedule [${columnKeys.join(", ")}]`,
      );
    }
    if (isCalculatedColumn(ref)) {
      throw new Error(
        `schedule '${scheduleId}': columns[${colIndex}].formula.${side}.column '${ref}' is itself a calc column — calculated fields reference non-calc columns only (single-pass evaluation)`,
      );
    }
    return { column: ref };
  }
  if (keys[0] === "value") {
    const literal = op.value;
    if (typeof literal !== "number" || !Number.isFinite(literal)) {
      throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula.${side}.value must be a finite number`);
    }
    return { value: literal };
  }
  throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula.${side} must be { column } or { value } (got key '${keys[0]}')`);
}

/** CAD-PARITY-015: validate the bounded formula grammar ({op, left, right}).
 *  Operand column references must address a NON-calc column of this
 *  schedule (single-pass evaluation — calc-on-calc references would be
 *  cyclic and are structurally rejected). */
function validateScheduleFormula(
  scheduleId: string,
  colIndex: number,
  value: unknown,
  columnKeys: readonly string[],
): ScheduleFormula {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula must be an object { op, left, right }`);
  }
  const f = value as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    if (key !== "op" && key !== "left" && key !== "right") {
      throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula unknown field '${key}' (allowed: op, left, right)`);
    }
  }
  if (f.op !== "add" && f.op !== "sub" && f.op !== "mul" && f.op !== "div") {
    throw new Error(`schedule '${scheduleId}': columns[${colIndex}].formula.op must be one of add | sub | mul | div`);
  }
  return {
    op: f.op,
    left: validateScheduleOperand(scheduleId, colIndex, "left", f.left, columnKeys),
    right: validateScheduleOperand(scheduleId, colIndex, "right", f.right, columnKeys),
  };
}

/** CAD-PARITY-015: validate the optional deterministic column format. */
function validateScheduleColumnFormat(
  scheduleId: string,
  colIndex: number,
  value: unknown,
): ScheduleColumnFormat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`schedule '${scheduleId}': columns[${colIndex}].format must be an object { unit?, align? }`);
  }
  const f = value as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    if (key !== "unit" && key !== "align") {
      throw new Error(`schedule '${scheduleId}': columns[${colIndex}].format unknown field '${key}' (allowed: unit, align)`);
    }
  }
  let unit: string | undefined;
  if (f.unit !== undefined && f.unit !== null) {
    if (typeof f.unit !== "string" || f.unit.trim().length === 0 || f.unit.trim().length > 8) {
      throw new Error(`schedule '${scheduleId}': columns[${colIndex}].format.unit must be a trimmed non-empty string (max 8 chars)`);
    }
    unit = f.unit.trim();
  }
  let align: "left" | "right" | undefined;
  if (f.align !== undefined && f.align !== null) {
    if (f.align !== "left" && f.align !== "right") {
      throw new Error(`schedule '${scheduleId}': columns[${colIndex}].format.align must be left | right`);
    }
    align = f.align;
  }
  return { ...(unit !== undefined ? { unit } : {}), ...(align !== undefined ? { align } : {}) };
}

/** CAD-PARITY-015: validate the optional sort rules (1..3 column-key rules,
 *  unique keys, asc|desc). */
function validateScheduleSort(
  scheduleId: string,
  value: unknown,
  columnKeys: readonly string[],
): ScheduleRecord["sort"] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error(`schedule '${scheduleId}': sort must be an array of 1..3 { key, direction } rules`);
  }
  const seen = new Set<string>();
  const out: { key: string; direction: "asc" | "desc" }[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`schedule '${scheduleId}': sort[${i}] must be an object { key, direction }`);
    }
    const rule = raw as Record<string, unknown>;
    for (const key of Object.keys(rule)) {
      if (key !== "key" && key !== "direction") {
        throw new Error(`schedule '${scheduleId}': sort[${i}] unknown field '${key}' (allowed: key, direction)`);
      }
    }
    if (typeof rule.key !== "string" || !columnKeys.includes(rule.key)) {
      throw new Error(`schedule '${scheduleId}': sort[${i}].key '${JSON.stringify(rule.key)}' is not a column of this schedule [${columnKeys.join(", ")}]`);
    }
    if (rule.direction !== "asc" && rule.direction !== "desc") {
      throw new Error(`schedule '${scheduleId}': sort[${i}].direction must be asc | desc`);
    }
    if (seen.has(rule.key)) {
      throw new Error(`schedule '${scheduleId}': sort[${i}].key '${rule.key}' is already sorted on (unique keys)`);
    }
    seen.add(rule.key);
    out.push({ key: rule.key, direction: rule.direction });
  }
  return out;
}

/** CAD-PARITY-015: validate the optional grouping keys (1..3 unique column
 *  keys; valid on every source). */
function validateScheduleGrouping(
  scheduleId: string,
  value: unknown,
  columnKeys: readonly string[],
  source: ScheduleSource,
): ScheduleRecord["grouping"] {
  void source;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error(`schedule '${scheduleId}': grouping must be an array of 1..3 column keys`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const key = value[i];
    if (typeof key !== "string" || !columnKeys.includes(key)) {
      throw new Error(`schedule '${scheduleId}': grouping[${i}] '${JSON.stringify(key)}' is not a column of this schedule [${columnKeys.join(", ")}]`);
    }
    if (seen.has(key)) {
      throw new Error(`schedule '${scheduleId}': grouping[${i}] '${key}' is already a group key (unique keys)`);
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** CAD-PARITY-015: validate the optional property-driven conditions (1..4,
 *  elements/components sources only; gt/lt number, contains string, eq/ne
 *  any typed value). */
function validateScheduleConditions(
  scheduleId: string,
  value: unknown,
  source: ScheduleSource,
): ScheduleRecord["conditions"] {
  if (value === undefined || value === null) return undefined;
  if (!(SCHEDULE_FILTERED_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`schedule '${scheduleId}': conditions are only valid on the elements/components sources (got '${source}')`);
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error(`schedule '${scheduleId}': conditions must be an array of 1..4 conditions`);
  }
  const out: ScheduleCondition[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`schedule '${scheduleId}': conditions[${i}] must be an object { set, key, op, value }`);
    }
    const cond = raw as Record<string, unknown>;
    for (const key of Object.keys(cond)) {
      if (key !== "set" && key !== "key" && key !== "op" && key !== "value") {
        throw new Error(`schedule '${scheduleId}': conditions[${i}] unknown field '${key}' (allowed: set, key, op, value)`);
      }
    }
    if (typeof cond.set !== "string" || cond.set.length === 0 || cond.set.length > 64) {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].set must be a non-empty string (max 64 chars)`);
    }
    if (typeof cond.key !== "string" || !BIM_PROPERTY_KEY_PATTERN.test(cond.key)) {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].key must match the canonical property key pattern`);
    }
    const op = cond.op;
    if (op !== "eq" && op !== "ne" && op !== "gt" && op !== "lt" && op !== "contains") {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].op must be one of eq | ne | gt | lt | contains`);
    }
    const v = cond.value;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].value must be a string, number or boolean`);
    }
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].value must be a finite number`);
    }
    if ((op === "gt" || op === "lt") && typeof v !== "number") {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].op '${op}' requires a NUMBER value (got ${typeof v})`);
    }
    if (op === "contains" && typeof v !== "string") {
      throw new Error(`schedule '${scheduleId}': conditions[${i}].op 'contains' requires a STRING value (got ${typeof v})`);
    }
    out.push({ set: cond.set, key: cond.key, op, value: v });
  }
  return out;
}

/** Keys a schedule patch may carry (id is the record identity). The
 *  CAD-PARITY-015 fields (sort/grouping/conditions) patch like filter:
 *  null REMOVES the field. */
export const SCHEDULE_PATCH_KEYS = ["name", "source", "filter", "columns", "sort", "grouping", "conditions"] as const;

/** Validate + merge an updateSchedule patch (the merged record re-validates
 *  as a whole; filter/sort/grouping/conditions null removes the field). */
export function applySchedulePatch(current: ScheduleRecord, patch: Readonly<Record<string, unknown>>): ScheduleRecord {
  const NULLABLE_KEYS = ["filter", "sort", "grouping", "conditions"] as const;
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      throw new Error("updateSchedule: id is the schedule identity — immutable");
    }
    if (!(SCHEDULE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateSchedule: unknown field '${key}' (allowed: ${SCHEDULE_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (NULLABLE_KEYS as readonly string[]).includes(key)) {
      delete cleaned[key];
      continue;
    }
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateScheduleRecord(cleaned);
}

/** CAD-PARITY-013: derive the schedule mint-sequence counter from existing
 *  minted ids (`sch-NNNNNN`). */
export function deriveScheduleSequence(schedules: readonly ScheduleRecord[]): number {
  let max = 0;
  for (const s of schedules) {
    const m = /^sch-(\d{6,})$/.exec(s.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// CAD-PARITY-015 (additive, Issue #110): the property-definition registry.
// ---------------------------------------------------------------------------

/** The CLOSED appliesTo vocabulary: the canonical BIM element types a
 *  property definition may be declared for (mirrors the BimElementType
 *  union of bim/elements.ts — the closed table is declared here, the
 *  BIM_CLASSIFICATION_TABLE precedent, so the validator stays a local
 *  leaf import graph for the browser bundle). */
export const PROPERTY_APPLIES_TO_TYPES: readonly string[] = Object.freeze([
  "bim.story",
  "bim.wall",
  "bim.slab",
  "bim.opening",
  "bim.door",
  "bim.window",
  "bim.space",
  "bim.componentDef",
  "bim.componentInstance",
  "bim.material",
  "bim.grid",
  "bim.referencePlane",
  "bim.roof",
  "bim.stair",
  "bim.railing",
  "bim.zone",
  "bim.optionGroup",
]);

/** The declared property types. */
export const PROPERTY_DEF_TYPES: readonly string[] = Object.freeze(["text", "number", "boolean"]);

/** CAD-PARITY-015: validate + normalize a property-definition record (the
 *  structural grammar: name trimmed non-empty max 60; set non-empty max 64;
 *  key matching the canonical BIM property key pattern; type from the closed
 *  text|number|boolean vocabulary; unit — trimmed non-empty max 16 — ONLY on
 *  number definitions; appliesTo an optional 1..12-entry array of UNIQUE
 *  canonical BimElementType strings from the closed table). NAME uniqueness
 *  and (set, key) ADDRESS uniqueness among definitions are enforced at the
 *  document boundary. */
export function validatePropertyDefRecord(record: unknown): PropertyDefRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("property definition record must be an object");
  }
  const r = record as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== "id" && key !== "name" && key !== "set" && key !== "key" && key !== "type" && key !== "unit" && key !== "appliesTo") {
      throw new Error(`property definition: unknown field '${key}' (allowed: id, name, set, key, type, unit, appliesTo)`);
    }
  }
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("property definition record: id must be a non-empty string");
  }
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.trim().length > 60) {
    throw new Error(`property definition '${r.id}': name must be a non-empty trimmed string (max 60 chars)`);
  }
  if (typeof r.set !== "string" || r.set.length === 0 || r.set.length > 64) {
    throw new Error(`property definition '${r.id}': set must be a non-empty string (max 64 chars — the ps:<set>… grammar)`);
  }
  if (typeof r.key !== "string" || !BIM_PROPERTY_KEY_PATTERN.test(r.key)) {
    throw new Error(`property definition '${r.id}': key must match the canonical property key pattern (letters/digits/underscores)`);
  }
  const type = r.type as PropertyDefRecord["type"];
  if (typeof r.type !== "string" || !(PROPERTY_DEF_TYPES as readonly string[]).includes(r.type)) {
    throw new Error(`property definition '${r.id}': type must be one of ${PROPERTY_DEF_TYPES.join(" | ")}`);
  }
  let unit: string | undefined;
  if (r.unit !== undefined && r.unit !== null) {
    if (type !== "number") {
      throw new Error(`property definition '${r.id}': unit is only valid on number definitions (got type '${type}')`);
    }
    if (typeof r.unit !== "string" || r.unit.trim().length === 0 || r.unit.trim().length > 16) {
      throw new Error(`property definition '${r.id}': unit must be a trimmed non-empty string (max 16 chars)`);
    }
    unit = r.unit.trim();
  }
  let appliesTo: readonly string[] | undefined;
  if (r.appliesTo !== undefined && r.appliesTo !== null) {
    if (!Array.isArray(r.appliesTo) || r.appliesTo.length < 1 || r.appliesTo.length > 12) {
      throw new Error(`property definition '${r.id}': appliesTo must be an array of 1..12 element types`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = 0; i < r.appliesTo.length; i++) {
      const entry = r.appliesTo[i];
      if (typeof entry !== "string" || !(PROPERTY_APPLIES_TO_TYPES as readonly string[]).includes(entry)) {
        throw new Error(
          `property definition '${r.id}': appliesTo[${i}] '${JSON.stringify(entry)}' is not a canonical BIM element type (closed table: ${PROPERTY_APPLIES_TO_TYPES.join(", ")})`,
        );
      }
      if (seen.has(entry)) {
        throw new Error(`property definition '${r.id}': appliesTo[${i}] '${entry}' is already declared (unique types)`);
      }
      seen.add(entry);
      out.push(entry);
    }
    appliesTo = out;
  }
  return {
    id: r.id,
    name: (r.name as string).trim(),
    set: r.set,
    key: r.key,
    type,
    ...(unit !== undefined ? { unit } : {}),
    ...(appliesTo !== undefined ? { appliesTo } : {}),
  };
}

/** Keys a property-definition patch may carry (id is the record identity). */
export const PROPERTY_DEF_PATCH_KEYS = ["name", "set", "key", "type", "unit", "appliesTo"] as const;

/** Validate + merge an updatePropertyDef patch (the merged record
 *  re-validates as a whole; unit/appliesTo null REMOVES the field). */
export function applyPropertyDefPatch(
  current: PropertyDefRecord,
  patch: Readonly<Record<string, unknown>>,
): PropertyDefRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      throw new Error("updatePropertyDef: id is the property definition identity — immutable");
    }
    if (!(PROPERTY_DEF_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updatePropertyDef: unknown field '${key}' (allowed: ${PROPERTY_DEF_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (key === "unit" || key === "appliesTo")) {
      delete cleaned[key];
      continue;
    }
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validatePropertyDefRecord(cleaned);
}

/** CAD-PARITY-015: derive the property-definition mint-sequence counter
 *  from existing minted ids (`prd-NNNNNN`). */
export function derivePropertyDefSequence(propertyDefs: readonly PropertyDefRecord[]): number {
  let max = 0;
  for (const d of propertyDefs) {
    const m = /^prd-(\d{6,})$/.exec(d.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** CAD-PARITY-013: validate + normalize a revision record (the structural
 *  grammar: code trimmed non-empty max 12, description max 200 (may be
 *  empty), issued boolean, createdAt a non-empty string (the FIXED
 *  deterministic timestamp — NEVER wall clock), layoutIds an array of
 *  non-empty unique strings kept in document order). Code UNIQUENESS and
 *  layoutId EXISTENCE are enforced at the document boundary. */
export function validateRevisionRecord(record: unknown): RevisionRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("revision record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("revision record: id must be a non-empty string");
  }
  if (typeof r.code !== "string" || r.code.trim().length === 0 || r.code.trim().length > 12) {
    throw new Error(`revision '${r.id}': code must be a non-empty trimmed string (max 12 chars, e.g. "P01")`);
  }
  const description = r.description === undefined || r.description === null ? "" : r.description;
  if (typeof description !== "string" || description.length > 200) {
    throw new Error(`revision '${r.id}': description must be a string (max 200 chars, may be empty)`);
  }
  if (typeof r.issued !== "boolean") {
    throw new Error(`revision '${r.id}': issued must be a boolean`);
  }
  if (typeof r.createdAt !== "string" || r.createdAt.length === 0) {
    throw new Error(`revision '${r.id}': createdAt must be a non-empty string (fixed deterministic timestamp)`);
  }
  if (!Array.isArray(r.layoutIds) || !r.layoutIds.every((x) => typeof x === "string" && x.length > 0)) {
    throw new Error(`revision '${r.id}': layoutIds must be an array of non-empty layout ids`);
  }
  const seen = new Set<string>();
  for (const id of r.layoutIds as readonly string[]) {
    if (seen.has(id)) {
      throw new Error(`revision '${r.id}': duplicate layoutId '${id}' (unique, document order)`);
    }
    seen.add(id);
  }
  return {
    id: r.id,
    code: (r.code as string).trim(),
    description,
    issued: r.issued,
    createdAt: r.createdAt,
    layoutIds: [...(r.layoutIds as readonly string[])],
  };
}

/** Keys a revision patch may carry (id/createdAt are the record identity —
 *  immutable). */
export const REVISION_PATCH_KEYS = ["code", "description", "issued", "layoutIds"] as const;

/** Validate + merge an updateRevision patch (the merged record re-validates
 *  as a whole). */
export function applyRevisionPatch(current: RevisionRecord, patch: Readonly<Record<string, unknown>>): RevisionRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "createdAt") {
      throw new Error("updateRevision: id/createdAt are the revision identity — immutable");
    }
    if (!(REVISION_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updateRevision: unknown field '${key}' (allowed: ${REVISION_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validateRevisionRecord(cleaned);
}

/** CAD-PARITY-013: derive the revision mint-sequence counter from existing
 *  minted ids (`rev-NNNNNN`). */
export function deriveRevisionSequence(revisions: readonly RevisionRecord[]): number {
  let max = 0;
  for (const rev of revisions) {
    const m = /^rev-(\d{6,})$/.exec(rev.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

const PUBLISHER_ITEM_KINDS: readonly ("layout" | "subset")[] = ["layout", "subset"];
const PUBLISHER_ITEM_FORMATS: readonly ("pdf" | "svg" | "plot-ir")[] = ["pdf", "svg", "plot-ir"];

/** CAD-PARITY-013: validate + normalize a publisher-set record (the
 *  structural grammar: name trimmed non-empty max 60, 1..64 items each
 *  {kind: layout|subset, id non-empty, format: pdf|svg|plot-ir}). Item
 *  TARGET existence, the subset-kind rule and the no-duplicate-expanded-
 *  layout rule are enforced at the document boundary. */
export function validatePublisherSetRecord(record: unknown): PublisherSetRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("publisher set record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error("publisher set record: id must be a non-empty string");
  }
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.trim().length > 60) {
    throw new Error(`publisher set '${r.id}': name must be a non-empty trimmed string (max 60 chars)`);
  }
  if (!Array.isArray(r.items) || r.items.length < 1 || r.items.length > 64) {
    throw new Error(`publisher set '${r.id}': items must be an array of 1..64 items`);
  }
  const items: PublisherItem[] = [];
  for (let i = 0; i < r.items.length; i++) {
    const raw = r.items[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`publisher set '${r.id}': items[${i}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (!(PUBLISHER_ITEM_KINDS as readonly unknown[]).includes(item.kind)) {
      throw new Error(`publisher set '${r.id}': items[${i}].kind must be "layout" | "subset"`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`publisher set '${r.id}': items[${i}].id must be a non-empty string`);
    }
    if (!(PUBLISHER_ITEM_FORMATS as readonly unknown[]).includes(item.format)) {
      throw new Error(`publisher set '${r.id}': items[${i}].format must be one of ${PUBLISHER_ITEM_FORMATS.join(" | ")}`);
    }
    items.push({ kind: item.kind as "layout" | "subset", id: item.id as string, format: item.format as "pdf" | "svg" | "plot-ir" });
  }
  return { id: r.id, name: (r.name as string).trim(), items };
}

/** Keys a publisher-set patch may carry (id is the record identity). */
export const PUBLISHER_PATCH_KEYS = ["name", "items"] as const;

/** Validate + merge an updatePublisherSet patch (the merged record
 *  re-validates as a whole). */
export function applyPublisherSetPatch(current: PublisherSetRecord, patch: Readonly<Record<string, unknown>>): PublisherSetRecord {
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      throw new Error("updatePublisherSet: id is the publisher-set identity — immutable");
    }
    if (!(PUBLISHER_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`updatePublisherSet: unknown field '${key}' (allowed: ${PUBLISHER_PATCH_KEYS.join(", ")})`);
    }
  }
  const cleaned: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return validatePublisherSetRecord(cleaned);
}

/** CAD-PARITY-013: derive the publisher-set mint-sequence counter from
 *  existing minted ids (`pub-NNNNNN`). */
export function derivePublisherSetSequence(sets: readonly PublisherSetRecord[]): number {
  let max = 0;
  for (const s of sets) {
    const m = /^pub-(\d{6,})$/.exec(s.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}
