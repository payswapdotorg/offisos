/**
 * Reusable parametric components, materials and model coordination
 * (COMPAT-BIM-003, Issue #50 scope).
 *
 * Canonical BIM authoring elements for the component/material/coordination
 * layer, extending the COMPAT-CAD-002 element precedent: BIM elements are
 * CADDocument ELEMENTS of kind "bim" whose `props` follow the canonical
 * layout defined here. Everything in this module is engine-free semantic
 * state (LOCK-018); geometry is DERIVED deterministically (src/bim/geometry.ts
 * derives a parametric box per component instance from the effective
 * parameters — definition defaults merged with the instance's explicit
 * overrides — placed at the instance's story-local position/rotation).
 *
 * PARAMETRIC PROPAGATION MODEL (the design decision of this slice): a
 * component definition is the single source of truth for its parameter
 * defaults; an instance stores ONLY its placement plus an explicit, validated
 * set of parameter OVERRIDES. Effective parameters are always computed as
 * definition.defaults ⊕ instance.overrides — derivation, never duplication —
 * so a definition edit propagates to every instance deterministically (no
 * stale copy can drift) and the edit itself is one immutable revision through
 * the standard versioned command path. Overrides pin their parameter keys
 * against definition changes by construction.
 *
 * Props layout (per type; every number finite — LOCK-007 rejects otherwise):
 *   bim.componentDef: { bim, type:"bim.componentDef", name, category,
 *                       parameters:{...per-category}, materialId? }
 *   bim.componentInstance: { bim, type:"bim.componentInstance", definitionId,
 *                       storyId, position:[x,y], rotation, baseOffset,
 *                       overrides:{...}, materialId?, name? }
 *   bim.material:  { bim, type:"bim.material", name, description?,
 *                       color?:[r,g,b], properties:{...},
 *                       // CAD-PARITY-012 (additive parity fields — absent =
 *                       // canonical default form, never undefined):
 *                       category?, lineweight?, density? }
 *   bim.grid:      { bim, type:"bim.grid", storyId, name,
 *                       uLines:[x…], vLines:[y…] }   // story-local, ascending
 *   bim.referencePlane: { bim, type:"bim.referencePlane", storyId, name,
 *                       start:[x,y], end:[x,y] }     // vertical plane
 *
 * Materials are canonical DOMAIN DATA (BIM-002): stable canonical identity,
 * name-unique per document (enforced at the command layer, where the whole
 * document is visible), fully independent of OCCT/IfcOpenShell internals —
 * engines only ever see derived descriptors or IFC-side names as provenance.
 * Grids/reference planes are coordination primitives: story-scoped canonical
 * elements (plan coordinates are story-local, like every hosted element);
 * levels already exist as bim.story. Alignment CONSTRAINTS (dimensional
 * constraint networks) are outside this slice's supported set — attempting
 * them is a typed unsupported operation, never a silent approximation
 * (LOCK-007).
 */

import type { Element } from "../contracts/caddocument.js";
import type { Vec2 } from "../contracts/geometry.js";
import { assertVec2 } from "./elements.js";
import { BIM_COINCIDENCE_EPS } from "./elements.js";
import { validateBimMeta, type BimElementMeta } from "./meta.js";

// --- Categories and parameter schemas ----------------------------------------

/** Component categories with a representative parametric schema each. */
export type BimComponentCategory = "wall" | "door" | "window" | "furniture" | "fixture";

/**
 * Per-category parameter schemas (mm; every parameter > 0, finite). The schema
 * key set is FIXED per category: definitions must carry exactly these keys;
 * instance overrides must reference a subset of them. All parameters are
 * positive linear dimensions.
 */
export const COMPONENT_CATEGORY_PARAMS: Readonly<Record<BimComponentCategory, readonly string[]>> = {
  wall: ["length", "width", "height"],
  door: ["width", "height", "leafThickness"],
  window: ["width", "height", "frameDepth"],
  furniture: ["width", "depth", "height"],
  fixture: ["width", "depth", "height"],
};

export function isBimComponentCategory(value: unknown): value is BimComponentCategory {
  return (
    value === "wall" || value === "door" || value === "window" ||
    value === "furniture" || value === "fixture"
  );
}

/** Maximum material property count (determinism/bound guard). */
export const BIM_MAX_MATERIAL_PROPERTIES = 32;
/** Maximum grid line count per direction (determinism/bound guard). */
export const BIM_MAX_GRID_LINES = 64;
/** Maximum component instances addressable in one batch (bound guard). */
export const BIM_MAX_COMPONENT_BATCH = 512;

// --- CAD-PARITY-012 (additive, Issue #102): material parity vocabulary -----

/** Constrained material category vocabulary (CAD-PARITY-012 — the shared
 *  semantic boundary: deterministic, no free text; every host offers the
 *  same fixed set through workspace/materials.ts). */
export const MATERIAL_CATEGORIES = [
  "Concrete",
  "Steel",
  "Masonry",
  "Timber",
  "Glass",
  "Insulation",
  "Finishes",
  "Generic",
] as const;

export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

/** Is the value part of the material category vocabulary? */
export function isMaterialCategory(value: unknown): value is MaterialCategory {
  return (
    value === "Concrete" || value === "Steel" || value === "Masonry" ||
    value === "Timber" || value === "Glass" || value === "Insulation" ||
    value === "Finishes" || value === "Generic"
  );
}

/** Deterministic default display color per category (RGB 0–255). */
export const CATEGORY_DEFAULT_COLOR: Readonly<Record<MaterialCategory, readonly [number, number, number]>> = {
  Concrete: [168, 162, 158],
  Steel: [139, 139, 150],
  Masonry: [194, 133, 95],
  Timber: [176, 137, 104],
  Glass: [156, 199, 196],
  Insulation: [212, 196, 154],
  Finishes: [201, 173, 167],
  Generic: [161, 161, 170],
};

/** Default material display lineweight (CAD-PARITY-012). */
export const DEFAULT_LINEWEIGHT = 1.4;
/** Minimum material display lineweight (inclusive). */
export const LINEWEIGHT_MIN = 0.5;
/** Maximum material display lineweight (inclusive). */
export const LINEWEIGHT_MAX = 8;

// --- Shared strict value helpers (LOCK-007: reject, never guess) -------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function assertFinite(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new Error(`${path} must be a finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertPositiveFinite(value: unknown, path: string): number {
  const n = assertFinite(value, path);
  if (n <= 0) throw new Error(`${path} must be > 0 (got ${n})`);
  return n;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalDescription(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string when present`);
  return value;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty element id`);
  }
  return value;
}

/** Build a record with its keys in SORTED order (canonical, deterministic
 *  prop layout regardless of caller key order). */
function sortedRecord(entries: readonly (readonly [string, number])[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out[key] = value;
  }
  return out;
}

// --- Parameter validation ------------------------------------------------------

/** Validate a full per-category parameter set (definitions): exactly the
 *  schema keys, every value a finite number > 0. Returns the parameters in
 *  sorted-key canonical order. */
export function validateComponentParameters(
  category: BimComponentCategory,
  value: unknown,
  path: string,
): Readonly<Record<string, number>> {
  const schema = COMPONENT_CATEGORY_PARAMS[category];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object of parameter name → number`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!schema.includes(key)) {
      throw new Error(`${path}.${key} is not a parameter of category '${category}' (allowed: ${schema.join(", ")})`);
    }
  }
  const entries: (readonly [string, number])[] = [];
  for (const key of schema) {
    entries.push([key, assertPositiveFinite(input[key], `${path}.${key}`)]);
  }
  return sortedRecord(entries);
}

/** Validate an instance parameter OVERRIDES set: a (possibly empty) subset of
 *  the category schema keys, every value a finite number > 0. Returns the
 *  overrides in sorted-key canonical order.
 *
 *  `category` is optional: the stored instance props carry no category (it is
 *  DEFINITION-derived state — LOCK-007 never trusts duplicated derived data),
 *  so strict element re-validation checks overrides structurally, and the
 *  command/query layer cross-validates the keys against the resolved
 *  definition's schema (validateInstanceAgainstDefinition). */
export function validateComponentOverrides(
  category: BimComponentCategory | undefined,
  value: unknown,
  path: string,
): Readonly<Record<string, number>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object of parameter name → number`);
  }
  const schema = category === undefined ? null : COMPONENT_CATEGORY_PARAMS[category];
  const input = value as Record<string, unknown>;
  const entries: (readonly [string, number])[] = [];
  for (const key of Object.keys(input)) {
    if (schema !== null && !schema.includes(key)) {
      throw new Error(`${path}.${key} is not a parameter of category '${category}' (allowed: ${schema.join(", ")})`);
    }
    entries.push([key, assertPositiveFinite(input[key], `${path}.${key}`)]);
  }
  return sortedRecord(entries);
}

/** Cross-validate an instance against its resolved definition (command and
 *  query layer, where both are visible): override keys must belong to the
 *  definition's category schema. Stored-props corruption is rejected, never
 *  guessed. */
export function validateInstanceAgainstDefinition(
  definition: ComponentDefEntity,
  instance: ComponentInstanceEntity,
): void {
  if (definition.id !== instance.definitionId) {
    throw new Error(
      `instance '${instance.id}' does not reference definition '${definition.id}' (stored props are inconsistent)`,
    );
  }
  const schema = COMPONENT_CATEGORY_PARAMS[definition.category];
  for (const key of Object.keys(instance.overrides)) {
    if (!schema.includes(key)) {
      throw new Error(
        `instance '${instance.id}' overrides '${key}', which is not a parameter of its definition's category '${definition.category}' (stored props are inconsistent)`,
      );
    }
  }
}

// --- Entities -------------------------------------------------------------------

export interface ComponentDefEntity {
  readonly type: "bim.componentDef";
  readonly id: string;
  /** Non-empty definition (family) name. */
  readonly name: string;
  readonly category: BimComponentCategory;
  /** Parameter defaults — exactly the category schema keys (mm). */
  readonly parameters: Readonly<Record<string, number>>;
  /** Default material association (must exist while referenced). */
  readonly materialId?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

export interface ComponentInstanceEntity {
  readonly type: "bim.componentInstance";
  readonly id: string;
  /** The component definition (must exist while the instance exists). */
  readonly definitionId: string;
  /** Placement container (must exist while the instance exists). */
  readonly storyId: string;
  /** Placement center, story-local XY (mm). */
  readonly position: Vec2;
  /** Placement rotation about +Z (radians, finite; authored value is kept). */
  readonly rotation: number;
  /** Base offset above the story level (mm, finite; typically 0). */
  readonly baseOffset: number;
  /** Explicit parameter overrides (validated against the definition's
   *  category schema — a subset of its keys; mm). */
  readonly overrides: Readonly<Record<string, number>>;
  /** Per-instance material association (overrides the definition default). */
  readonly materialId?: string;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

export interface MaterialEntity {
  readonly type: "bim.material";
  readonly id: string;
  /** Non-empty, document-unique material name (the external exchange key). */
  readonly name: string;
  readonly description?: string;
  /** Display color, RGB 0–255 integers. */
  readonly color?: readonly [number, number, number];
  /** Material properties (canonical domain data; bounded count). */
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  /** CAD-PARITY-012 (additive parity field): the constrained category
   *  (MATERIAL_CATEGORIES vocabulary). Absent = the canonical default form
   *  (no category); NEVER undefined-valued in stored props. */
  readonly category?: MaterialCategory;
  /** CAD-PARITY-012 (additive parity field): display lineweight in
   *  [LINEWEIGHT_MIN, LINEWEIGHT_MAX]. Absent = DEFAULT_LINEWEIGHT applies
   *  at resolution time (the shared materials module). */
  readonly lineweight?: number;
  /** CAD-PARITY-012 (additive parity field): density, kg/m³ (> 0,
   *  informational only). Absent = unset. */
  readonly density?: number;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

export interface GridEntity {
  readonly type: "bim.grid";
  readonly id: string;
  /** Host story (must exist while the grid exists). */
  readonly storyId: string;
  /** Non-empty grid name. */
  readonly name: string;
  /** Vertical grid line X offsets, story-local (mm), strictly ascending. */
  readonly uLines: readonly number[];
  /** Horizontal grid line Y offsets, story-local (mm), strictly ascending. */
  readonly vLines: readonly number[];
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

export interface ReferencePlaneEntity {
  readonly type: "bim.referencePlane";
  readonly id: string;
  readonly storyId: string;
  /** Non-empty reference plane name. */
  readonly name: string;
  /** Plan trace of the vertical plane, story-local XY (mm). */
  readonly start: Vec2;
  readonly end: Vec2;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

// --- Strict constructors (deterministic; first failure wins) --------------------

/** The validated meta overlay of a component-family entity input
 *  (CAD-PARITY-011) — absent when the input carries no overlay. */
function metaField(type: "bim.componentDef" | "bim.componentInstance" | "bim.material" | "bim.grid" | "bim.referencePlane", input: Record<string, unknown>, path: string): { meta?: BimElementMeta } {
  const meta = validateBimMeta(type, input.meta, path);
  return meta === undefined ? {} : { meta };
}

export function makeComponentDef(input: Record<string, unknown>): Omit<ComponentDefEntity, "id"> {
  const name = requireNonEmptyString(input.name, "componentDef.name");
  const category = input.category;
  if (!isBimComponentCategory(category)) {
    throw new Error(
      `componentDef.category must be one of wall|door|window|furniture|fixture (got ${JSON.stringify(category)})`,
    );
  }
  const parameters = validateComponentParameters(category, input.parameters, "componentDef.parameters");
  const materialId = input.materialId === undefined ? undefined : requireId(input.materialId, "componentDef.materialId");
  const meta = metaField("bim.componentDef", input, "componentDef.meta");
  const base: Omit<ComponentDefEntity, "id"> = { type: "bim.componentDef", name, category, parameters, ...meta };
  return materialId === undefined ? base : { ...base, materialId };
}

export function makeComponentInstance(input: Record<string, unknown>): Omit<ComponentInstanceEntity, "id"> {
  const definitionId = requireId(input.definitionId, "componentInstance.definitionId");
  const storyId = requireId(input.storyId, "componentInstance.storyId");
  const position = assertVec2(input.position, "componentInstance.position");
  const rotation = assertFinite(input.rotation ?? 0, "componentInstance.rotation");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "componentInstance.baseOffset");
  const overrides = validateComponentOverrides(
    isBimComponentCategory(input.category) ? input.category : undefined,
    input.overrides,
    "componentInstance.overrides",
  );
  const materialId = input.materialId === undefined ? undefined : requireId(input.materialId, "componentInstance.materialId");
  const name = input.name === undefined ? undefined : requireNonEmptyString(input.name, "componentInstance.name");
  const base: Omit<ComponentInstanceEntity, "id"> = {
    type: "bim.componentInstance",
    definitionId,
    storyId,
    position,
    rotation,
    baseOffset,
    overrides,
    ...metaField("bim.componentInstance", input, "componentInstance.meta"),
  };
  const withMaterial = materialId === undefined ? base : { ...base, materialId };
  return name === undefined ? withMaterial : { ...withMaterial, name };
}

export function makeMaterial(input: Record<string, unknown>): Omit<MaterialEntity, "id"> {
  const name = requireNonEmptyString(input.name, "material.name");
  const description = optionalDescription(input.description, "material.description");
  // CAD-PARITY-012 (additive): the constrained parity fields — every one
  // OPTIONAL and validated strictly when present (LOCK-007: reject, never
  // guess; absence = the canonical default form, never undefined).
  const category = input.category === undefined || input.category === null ? undefined : input.category;
  if (category !== undefined && !isMaterialCategory(category)) {
    throw new Error(
      `material.category must be one of ${MATERIAL_CATEGORIES.join("|")} (got ${JSON.stringify(input.category)})`,
    );
  }
  const lineweight = input.lineweight === undefined || input.lineweight === null ? undefined : assertFinite(input.lineweight, "material.lineweight");
  if (lineweight !== undefined && (lineweight < LINEWEIGHT_MIN || lineweight > LINEWEIGHT_MAX)) {
    throw new Error(`material.lineweight must be in [${LINEWEIGHT_MIN}, ${LINEWEIGHT_MAX}] (got ${lineweight})`);
  }
  const density = input.density === undefined || input.density === null ? undefined : assertFinite(input.density, "material.density");
  if (density !== undefined && density <= 0) {
    throw new Error(`material.density must be > 0 (got ${density})`);
  }
  let color: readonly [number, number, number] | undefined;
  if (input.color !== undefined) {
    if (!Array.isArray(input.color) || input.color.length !== 3 || !input.color.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255)) {
      throw new Error("material.color must be [r, g, b] integers in 0..255");
    }
    color = [input.color[0] as number, input.color[1] as number, input.color[2] as number];
  }
  if (input.properties === undefined) {
    throw new Error("material.properties must be an object (use {} for none)");
  }
  if (typeof input.properties !== "object" || input.properties === null || Array.isArray(input.properties)) {
    throw new Error("material.properties must be an object of name → string|number|boolean");
  }
  const raw = input.properties as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length > BIM_MAX_MATERIAL_PROPERTIES) {
    throw new Error(`material.properties exceeds the ${BIM_MAX_MATERIAL_PROPERTIES}-property bound`);
  }
  const properties: Record<string, string | number | boolean> = {};
  for (const key of [...keys].sort((a, b) => (a < b ? -1 : 1))) {
    const value = raw[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
      properties[key] = value;
    } else {
      throw new Error(`material.properties.${key} must be a string, finite number or boolean`);
    }
  }
  const base: Omit<MaterialEntity, "id"> = { type: "bim.material", name, properties, ...metaField("bim.material", input, "material.meta") };
  const withDescription = description === undefined ? base : { ...base, description };
  const withColor = color === undefined ? withDescription : { ...withDescription, color };
  const withCategory = category === undefined ? withColor : { ...withColor, category };
  const withLineweight = lineweight === undefined ? withCategory : { ...withCategory, lineweight };
  return density === undefined ? withLineweight : { ...withLineweight, density };
}

export function makeGrid(input: Record<string, unknown>): Omit<GridEntity, "id"> {
  const storyId = requireId(input.storyId, "grid.storyId");
  const name = requireNonEmptyString(input.name, "grid.name");
  const uLines = validateGridLines(input.uLines, "grid.uLines");
  const vLines = validateGridLines(input.vLines, "grid.vLines");
  return { type: "bim.grid", storyId, name, uLines, vLines, ...metaField("bim.grid", input, "grid.meta") };
}

function validateGridLines(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of offsets`);
  }
  if (value.length > BIM_MAX_GRID_LINES) {
    throw new Error(`${path} exceeds the ${BIM_MAX_GRID_LINES}-line bound`);
  }
  const lines = value.map((x, i) => assertFinite(x, `${path}[${i}]`));
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1] as number;
    const cur = lines[i] as number;
    if (cur <= prev) {
      throw new Error(`${path} must be strictly ascending (entry ${i} is not greater than entry ${i - 1}; duplicates are rejected)`);
    }
  }
  return lines;
}

export function makeReferencePlane(input: Record<string, unknown>): Omit<ReferencePlaneEntity, "id"> {
  const storyId = requireId(input.storyId, "referencePlane.storyId");
  const name = requireNonEmptyString(input.name, "referencePlane.name");
  const start = assertVec2(input.start, "referencePlane.start");
  const end = assertVec2(input.end, "referencePlane.end");
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (Math.sqrt(dx * dx + dy * dy) <= BIM_COINCIDENCE_EPS) {
    throw new Error("referencePlane.start and referencePlane.end must not coincide (a plane needs a trace)");
  }
  return { type: "bim.referencePlane", storyId, name, start, end, ...metaField("bim.referencePlane", input, "referencePlane.meta") };
}

// --- Effective parameters (the propagation model) -------------------------------

/** Effective parameters of an instance: definition defaults merged with the
 *  instance's validated overrides (derivation — never a stored copy). The
 *  definition must be the instance's definition (same category validation was
 *  applied at authoring time; a mismatch is a stored-props corruption). */
export function effectiveParameters(
  definition: ComponentDefEntity,
  instance: ComponentInstanceEntity,
): Readonly<Record<string, number>> {
  if (definition.id !== instance.definitionId) {
    throw new Error(
      `effectiveParameters: definition '${definition.id}' is not the definition of instance '${instance.id}' (stored props are inconsistent)`,
    );
  }
  const merged: Record<string, number> = { ...definition.parameters };
  for (const [key, value] of Object.entries(instance.overrides)) {
    merged[key] = value;
  }
  return sortedRecord(Object.entries(merged));
}

/** Effective material of an instance: the instance association, else the
 *  definition default (null when neither is set). */
export function effectiveMaterialId(
  definition: ComponentDefEntity,
  instance: ComponentInstanceEntity,
): string | null {
  if (definition.id !== instance.definitionId) {
    throw new Error(
      `effectiveMaterialId: definition '${definition.id}' is not the definition of instance '${instance.id}' (stored props are inconsistent)`,
    );
  }
  return instance.materialId ?? definition.materialId ?? null;
}

/** Effective parametric BOX of an instance: [sizeX, sizeY, sizeZ] (mm) from
 *  the effective parameters, mapped per category (local X = primary extent,
 *  local Y = lateral/thickness extent, Z = height). */
export function effectiveBox(
  definition: ComponentDefEntity,
  instance: ComponentInstanceEntity,
): readonly [number, number, number] {
  const p = effectiveParameters(definition, instance);
  switch (definition.category) {
    case "wall":
      return [p.length!, p.width!, p.height!];
    case "door":
      return [p.width!, p.leafThickness!, p.height!];
    case "window":
      return [p.width!, p.frameDepth!, p.height!];
    case "furniture":
    case "fixture":
      return [p.width!, p.depth!, p.height!];
  }
}
