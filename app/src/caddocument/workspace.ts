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

import type { DraftingSettings, LayerRecord, SnapKind } from "../contracts/caddocument.js";

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
