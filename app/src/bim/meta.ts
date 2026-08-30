/**
 * BIM element semantic META overlay (CAD-PARITY-011, Issue #97).
 *
 * The cross-cutting authored semantics EVERY BIM element may carry, layered
 * additively over the per-type canonical props (the COMPAT-CAD-002 layout):
 *
 *   - classificationRef — a canonical classification identifier from the
 *     Offisos Canonical Classification table below (stable product-owned
 *     codes; the table is the closed vocabulary — arbitrary classification
 *     strings are rejected, never guessed);
 *   - propertySets — structured element property sets with stable canonical
 *     keys and typed values (string | finite number | boolean; bounded
 *     counts; deterministic insertion order is the canonical order);
 *   - renovationStatus — the bounded canonical renovation lifecycle state
 *     ("existing" | "new" | "to-be-demolished"; ABSENT means "existing" —
 *     the default canonical state, so pre-P011 documents need no migration);
 *   - optionGroupId + option — design-option membership (both present or
 *     both absent; the pair references a bim.optionGroup element and one of
 *     its declared options — the group registry is resolved at the command
 *     layer, the STRUCTURE is validated here).
 *
 * The overlay lives under the single canonical props key "meta" on every
 * BIM element. Entities carry it as the optional `meta` field so the
 * canonical element round-trip (entity → element props → entity) preserves
 * it through every edit-batch rebuild (a move/copy patch that dropped the
 * overlay would be silent semantic loss — LOCK-007 forbids that).
 *
 * Engine-free semantic modeling only (LOCK-018: this module is scanned —
 * no engine vocabulary appears here).
 */

import type { BimElementType } from "./elements.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** One canonical classification entry. */
export interface ClassificationEntry {
  /** Human-readable label. */
  readonly label: string;
  /** The BIM element types the code applies to (closed set per code). */
  readonly appliesTo: readonly BimElementType[];
}

/**
 * The Offisos Canonical Classification v1 — the CLOSED table of stable
 * product-owned classification codes for the supported BIM element
 * categories (CAD-PARITY-011 bounded scope). A classification reference
 * must be a key of this table AND apply to the classified element's type;
 * anything else is a typed rejection (never a guess).
 */
export const BIM_CLASSIFICATION_TABLE: Readonly<Record<string, ClassificationEntry>> = Object.freeze({
  "OFFISOS-ARCH-100": Object.freeze({ label: "Wall", appliesTo: Object.freeze(["bim.wall"] as const) }),
  "OFFISOS-ARCH-110": Object.freeze({ label: "Slab", appliesTo: Object.freeze(["bim.slab"] as const) }),
  "OFFISOS-ARCH-120": Object.freeze({ label: "Roof", appliesTo: Object.freeze(["bim.roof"] as const) }),
  "OFFISOS-ARCH-130": Object.freeze({ label: "Stair", appliesTo: Object.freeze(["bim.stair"] as const) }),
  "OFFISOS-ARCH-140": Object.freeze({ label: "Railing", appliesTo: Object.freeze(["bim.railing"] as const) }),
  "OFFISOS-ARCH-150": Object.freeze({ label: "Opening", appliesTo: Object.freeze(["bim.opening"] as const) }),
  "OFFISOS-ARCH-160": Object.freeze({ label: "Door", appliesTo: Object.freeze(["bim.door"] as const) }),
  "OFFISOS-ARCH-170": Object.freeze({ label: "Window", appliesTo: Object.freeze(["bim.window"] as const) }),
  "OFFISOS-ARCH-180": Object.freeze({ label: "Space", appliesTo: Object.freeze(["bim.space"] as const) }),
  "OFFISOS-ARCH-190": Object.freeze({ label: "Zone", appliesTo: Object.freeze(["bim.zone"] as const) }),
  "OFFISOS-ARCH-200": Object.freeze({ label: "Component", appliesTo: Object.freeze(["bim.componentInstance"] as const) }),
} as const);

/** The canonical classification codes in deterministic (sorted) order. */
export const BIM_CLASSIFICATION_CODES: readonly string[] = Object.keys(BIM_CLASSIFICATION_TABLE).sort();

// ---------------------------------------------------------------------------
// Property sets
// ---------------------------------------------------------------------------

/** Bounded property-set counts (determinism bounds, mirroring the profile
 *  point bound precedent in elements.ts). */
export const BIM_MAX_PROPERTY_SETS = 8;
export const BIM_MAX_PROPERTIES_PER_SET = 32;
/** Canonical property key pattern (stable keys — the exchange contract). */
export const BIM_PROPERTY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Canonical property set name length bound. */
export const BIM_PROPERTY_SET_NAME_MAX = 64;

/** One typed property value: string | finite number | boolean (nothing else). */
export type BimPropertyValue = string | number | boolean;

/** One property: a stable canonical key + its typed value. */
export interface BimProperty {
  readonly key: string;
  readonly value: BimPropertyValue;
}

/** One structured property set: a canonical name + ordered properties. */
export interface BimPropertySet {
  readonly name: string;
  readonly properties: readonly BimProperty[];
}

// ---------------------------------------------------------------------------
// Renovation lifecycle
// ---------------------------------------------------------------------------

/** The bounded canonical renovation lifecycle states (CAD-PARITY-011).
 *  ABSENT meta.renovationStatus means "existing" (the default canonical
 *  state — pre-P011 documents carry no renovation key at all). */
export const BIM_RENOVATION_STATES = Object.freeze(["existing", "new", "to-be-demolished"] as const);

export type BimRenovationStatus = (typeof BIM_RENOVATION_STATES)[number];

/** The element types that carry renovation status (building/spatial
 *  content). Level containers, domain data, coordination primitives and
 *  lifecycle registries do NOT — a typed rejection names the boundary. */
export const BIM_RENOVATION_ELIGIBLE: readonly BimElementType[] = Object.freeze([
  "bim.wall",
  "bim.slab",
  "bim.roof",
  "bim.stair",
  "bim.railing",
  "bim.opening",
  "bim.door",
  "bim.window",
  "bim.space",
  "bim.zone",
  "bim.componentInstance",
] as const);

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

/** The cross-cutting semantic meta overlay every BIM element may carry. */
export interface BimElementMeta {
  readonly classificationRef?: string;
  readonly propertySets?: readonly BimPropertySet[];
  readonly renovationStatus?: BimRenovationStatus;
  readonly optionGroupId?: string;
  readonly option?: string;
}

// --- shared strict value helpers (LOCK-007: reject, never guess) -------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

// --- property set validation --------------------------------------------------

/** Validate one property value (typed: string | finite number | boolean). */
function validatePropertyValue(value: unknown, path: string): BimPropertyValue {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (isFiniteNumber(value)) return value;
  throw new Error(`${path} must be a string, finite number or boolean (got ${typeof value})`);
}

/** Validate the full structured property-set list (deterministic, first
 *  failure wins): bounded counts, canonical names/keys, typed values,
 *  unique names across sets, unique keys within a set. Insertion order is
 *  the canonical order (serialization preserves it). */
export function validatePropertySets(value: unknown, path: string): readonly BimPropertySet[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of property sets`);
  }
  if (value.length > BIM_MAX_PROPERTY_SETS) {
    throw new Error(`${path} exceeds the ${BIM_MAX_PROPERTY_SETS}-set bound (got ${value.length})`);
  }
  const seenSetNames = new Set<string>();
  const out: BimPropertySet[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${path}[${i}] must be an object`);
    }
    const set = raw as Record<string, unknown>;
    const name = requireNonEmptyString(set.name, `${path}[${i}].name`);
    if (name.length > BIM_PROPERTY_SET_NAME_MAX) {
      throw new Error(`${path}[${i}].name exceeds the ${BIM_PROPERTY_SET_NAME_MAX}-character bound`);
    }
    if (seenSetNames.has(name)) {
      throw new Error(`${path}[${i}].name '${name}' is already taken by an earlier set (names are unique across the element's property sets)`);
    }
    seenSetNames.add(name);
    if (!Array.isArray(set.properties)) {
      throw new Error(`${path}[${i}].properties must be an array`);
    }
    if (set.properties.length > BIM_MAX_PROPERTIES_PER_SET) {
      throw new Error(`${path}[${i}].properties exceeds the ${BIM_MAX_PROPERTIES_PER_SET}-property bound (got ${set.properties.length})`);
    }
    const seenKeys = new Set<string>();
    const properties: BimProperty[] = [];
    for (let j = 0; j < set.properties.length; j++) {
      const rawProp = set.properties[j];
      if (typeof rawProp !== "object" || rawProp === null) {
        throw new Error(`${path}[${i}].properties[${j}] must be an object`);
      }
      const prop = rawProp as Record<string, unknown>;
      const key = requireNonEmptyString(prop.key, `${path}[${i}].properties[${j}].key`);
      if (!BIM_PROPERTY_KEY_PATTERN.test(key)) {
        throw new Error(`${path}[${i}].properties[${j}].key '${key}' does not match the canonical key pattern (letter followed by letters/digits/underscores, ≤ 64 chars)`);
      }
      if (seenKeys.has(key)) {
        throw new Error(`${path}[${i}].properties[${j}].key '${key}' is already taken within set '${name}' (keys are unique per set)`);
      }
      seenKeys.add(key);
      properties.push({ key, value: validatePropertyValue(prop.value, `${path}[${i}].properties[${j}].value`) });
    }
    out.push({ name, properties });
  }
  return out;
}

// --- the overlay validation ---------------------------------------------------

/**
 * Validate the meta overlay for one element type (strict; first failure
 * wins). Cross-ELEMENT references (the option group's existence and the
 * option's membership in its group) are resolved at the command layer —
 * this validates the STRUCTURE: the classification code exists in the
 * closed table and applies to this element type; property sets are
 * structurally valid; the renovation status is a canonical state on an
 * eligible element type; the option pair is both-present-or-both-absent.
 *
 * Returns the CANONICAL overlay (omitting absent keys), or undefined when
 * the input carries no overlay at all.
 */
export function validateBimMeta(elementType: BimElementType, value: unknown, path: string): BimElementMeta | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object when present`);
  }
  const input = value as Record<string, unknown>;
  const knownKeys = new Set(["classificationRef", "propertySets", "renovationStatus", "optionGroupId", "option"]);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      throw new Error(`${path}.${key} is not a recognized meta field (allowed: ${[...knownKeys].join(", ")})`);
    }
  }
  const meta: Record<string, unknown> = {};

  if (input.classificationRef !== undefined) {
    const ref = requireNonEmptyString(input.classificationRef, `${path}.classificationRef`);
    const entry = BIM_CLASSIFICATION_TABLE[ref];
    if (entry === undefined) {
      throw new Error(`${path}.classificationRef '${ref}' is not a canonical classification code (closed table: ${BIM_CLASSIFICATION_CODES.join(", ")})`);
    }
    if (!entry.appliesTo.includes(elementType)) {
      throw new Error(`${path}.classificationRef '${ref}' (${entry.label}) does not apply to ${elementType} elements (applies to: ${entry.appliesTo.join(", ")})`);
    }
    meta.classificationRef = ref;
  }

  if (input.propertySets !== undefined) {
    const sets = validatePropertySets(input.propertySets, `${path}.propertySets`);
    if (sets.length > 0) meta.propertySets = sets;
  }

  if (input.renovationStatus !== undefined) {
    const status = input.renovationStatus;
    if (typeof status !== "string" || !(BIM_RENOVATION_STATES as readonly string[]).includes(status)) {
      throw new Error(`${path}.renovationStatus must be one of ${BIM_RENOVATION_STATES.join(" | ")} (got ${JSON.stringify(status)})`);
    }
    if (!BIM_RENOVATION_ELIGIBLE.includes(elementType)) {
      throw new Error(`${path}.renovationStatus is not supported on ${elementType} elements (supported types: ${BIM_RENOVATION_ELIGIBLE.join(", ")})`);
    }
    meta.renovationStatus = status;
  }

  if (input.optionGroupId !== undefined || input.option !== undefined) {
    const optionGroupId = requireNonEmptyString(input.optionGroupId, `${path}.optionGroupId`);
    const option = requireNonEmptyString(input.option, `${path}.option`);
    meta.optionGroupId = optionGroupId;
    meta.option = option;
  }

  return Object.keys(meta).length > 0 ? (meta as BimElementMeta) : undefined;
}

/** Soft read: the overlay of an element's props, or undefined (throws
 *  never — malformed stored overlays surface through the strict
 *  constructors' re-validation, not here). */
export function bimMetaOfProps(props: Readonly<Record<string, unknown>>): BimElementMeta | undefined {
  const meta = props["meta"];
  if (meta === undefined || meta === null) return undefined;
  if (typeof meta !== "object") return undefined;
  return meta as BimElementMeta;
}

/** The effective renovation status (ABSENT = "existing", the default
 *  canonical state). Deterministic derived value for semantics/queries. */
export function effectiveRenovationStatus(meta: BimElementMeta | undefined): BimRenovationStatus {
  return meta?.renovationStatus ?? "existing";
}
