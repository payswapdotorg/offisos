/**
 * Materials core (CAD-PARITY-012, Issue #102) — the shared material
 * semantics over the real offisos architecture.
 *
 * Materials ARE the COMPAT-BIM-003 `bim.material` ELEMENTS extended with the
 * additive parity fields (category / lineweight / density — see
 * src/bim/components.ts for the entity grammar and the strict constructor).
 * Per element, assignment is the optional `materialId` prop: absence or
 * null = unassigned — the canonical no-assignment form (NEVER an
 * undefined-valued key; canonicalStringify would reject it). Block
 * instances resolve `instance.materialId ?? definition.materialId ?? null`.
 *
 * The BILL OF MATERIALS is the deterministic quantity takeoff over the
 * CONCRETE 2D view: geometry elements measured by type (line: length;
 * circle: 2πr length + πr² area; arc: arc length; polyline: perimeter +
 * enclosed area when closed — the shared workspace geometry measures),
 * block instances contributing their EXPANDED measures as ONE element,
 * revision-cloud polylines and unresolvable materialId references
 * contributing to the unassigned bucket. Quantities are rounded to 1e-6 and
 * rows are ordered deterministically (material id, unassigned last) so the
 * same snapshot yields the same bill on every host.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../contracts/caddocument.js";
import type { MaterialEntity } from "../bim/components.js";
import {
  CATEGORY_DEFAULT_COLOR,
  DEFAULT_LINEWEIGHT,
  LINEWEIGHT_MAX,
  LINEWEIGHT_MIN,
  MATERIAL_CATEGORIES,
  isMaterialCategory,
  type MaterialCategory,
} from "../bim/components.js";
import type { BlockTable } from "./blocks/expand.js";
import { blockRefFromElement } from "./blocks/types.js";
import { expandBlockInstance } from "./blocks/expand.js";
import { areaOf, lengthOf } from "./geometry/entities.js";
import { propsToGeom } from "./geometry/types.js";
import type { Geom } from "./geometry/types.js";

// Re-export the shared vocabulary (the bim entity grammar is the single
// source of truth; hosts and command builders consume it through here).
export {
  CATEGORY_DEFAULT_COLOR,
  DEFAULT_LINEWEIGHT,
  LINEWEIGHT_MIN,
  LINEWEIGHT_MAX,
  MATERIAL_CATEGORIES,
  isMaterialCategory,
};
export type { MaterialCategory };

/** The bounded revision-cloud marker value (drafting marker vocabulary —
 *  revision clouds are markup, never measured content). */
export const REVCLOUD_MARKER = "revcloud";

// ---------------------------------------------------------------------------
// Assignment resolution.
// ---------------------------------------------------------------------------

/** Material id of an element's props (null = unassigned; malformed values
 *  read as unassigned — honest readers never guess). */
export function materialIdOf(props: Readonly<Record<string, unknown>>): string | null {
  const v = (props as Record<string, unknown>).materialId;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

/** Is this element a revision-cloud markup entity? */
export function isRevcloudElement(el: Element): boolean {
  return (el.props as Record<string, unknown>).marker === REVCLOUD_MARKER;
}

/** RESOLVED material id of a block instance: the instance's own
 *  association, else the definition's default, else null. */
export function resolvedBlockMaterialId(
  instanceProps: Readonly<Record<string, unknown>>,
  definitionMaterialId: string | undefined,
): string | null {
  const own = materialIdOf(instanceProps);
  if (own !== null) return own;
  return definitionMaterialId !== undefined ? definitionMaterialId : null;
}

// ---------------------------------------------------------------------------
// Record validation (command-layer helper over the parity fields).
// ---------------------------------------------------------------------------

export interface MaterialFieldInput {
  readonly name: string;
  readonly category: string;
  readonly color: readonly [number, number, number];
  readonly lineweight: number;
  readonly density: number | null;
}

/** Validate a full material field set (LOCK-007: typed failures). Port of
 *  the CAD-PARITY-012 reference validation adapted to this repo's
 *  [r, g, b]-color convention. */
export function validateMaterialFields(fields: MaterialFieldInput): { ok: true } | { ok: false; reason: string } {
  if (fields.name.trim().length === 0) {
    return { ok: false, reason: "material name must be non-empty" };
  }
  if (!isMaterialCategory(fields.category)) {
    return {
      ok: false,
      reason: `category '${fields.category}' is not in the vocabulary [${MATERIAL_CATEGORIES.join(", ")}]`,
    };
  }
  if (
    fields.color.length !== 3 ||
    !fields.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
  ) {
    return { ok: false, reason: "color must be [r, g, b] integers in 0..255" };
  }
  if (
    !Number.isFinite(fields.lineweight) ||
    fields.lineweight < LINEWEIGHT_MIN ||
    fields.lineweight > LINEWEIGHT_MAX
  ) {
    return {
      ok: false,
      reason: `lineweight ${fields.lineweight} must be in [${LINEWEIGHT_MIN}, ${LINEWEIGHT_MAX}]`,
    };
  }
  if (fields.density !== null && (!Number.isFinite(fields.density) || fields.density <= 0)) {
    return { ok: false, reason: `density ${fields.density} must be positive or null` };
  }
  return { ok: true };
}

/** Default display color of a category (the bounded Generic fallback for
 *  unknown input at typed boundaries). */
export function categoryDefaultColor(category: string): readonly [number, number, number] {
  return CATEGORY_DEFAULT_COLOR[category as MaterialCategory] ?? CATEGORY_DEFAULT_COLOR.Generic;
}

// ---------------------------------------------------------------------------
// Bill of materials (deterministic quantity takeoff).
// ---------------------------------------------------------------------------

/** One BOM row (deterministic aggregation; the unassigned row is LAST). */
export interface BomRow {
  /** Material element id, or null for the unassigned bucket. */
  readonly materialId: string | null;
  readonly name: string;
  /** Element count contributing to the row. */
  readonly count: number;
  /** Total measured length in document units (1e-6 rounding). */
  readonly length: number;
  /** Total measured area in document units (1e-6 rounding). */
  readonly area: number;
}

/** One measured element of the concrete 2D view (block instances measure
 *  their EXPANDED content as ONE element). */
interface Measure {
  readonly length: number;
  readonly area: number;
}

function measureOfGeom(g: Geom): Measure {
  return { length: lengthOf(g), area: areaOf(g) };
}

/** Measure one element of the concrete view. Block instances expand through
 *  the ONE shared expansion (their expanded measures count once); geometry
 *  elements measure by type; everything else measures zero. */
function measureElement(el: Element, ref: ReturnType<typeof blockRefFromElement>, blockTable: BlockTable): Measure {
  if (ref === null) {
    const g = propsToGeom(el.props as Record<string, unknown>);
    if (g === null) return { length: 0, area: 0 };
    return measureOfGeom(g);
  }
  let length = 0;
  let area = 0;
  for (const piece of expandBlockInstance(ref, blockTable)) {
    if (piece.kind !== "geometry") continue;
    const g = propsToGeom(piece.props);
    if (g === null) continue;
    length += lengthOf(g);
    area += areaOf(g);
  }
  return { length, area };
}

/** Bill of materials over the document's elements: per material (sorted by
 *  material element id) — count, total length, total area in document
 *  units; block instances contribute their expanded content measures as
 *  ONE element; revision-cloud polylines and materialId references to
 *  missing materials contribute to the unassigned bucket; the unassigned
 *  row is last when non-empty. Deterministic on every host. */
export function billOfMaterials(
  elements: readonly Element[],
  materialsById: ReadonlyMap<string, MaterialEntity>,
  blockTable: BlockTable,
): BomRow[] {
  const buckets = new Map<string, { count: number; length: number; area: number }>();
  const get = (id: string): { count: number; length: number; area: number } => {
    let b = buckets.get(id);
    if (b === undefined) {
      b = { count: 0, length: 0, area: 0 };
      buckets.set(id, b);
    }
    return b;
  };
  const UNASSIGNED = "__unassigned__";
  for (const el of elements) {
    // The concrete 2D view: canonical geometry elements + block instances.
    // BIM elements (domain data/parametric state) and annotations decode to
    // no geometry and are not measured content — they are skipped entirely.
    const ref = blockRefFromElement(el);
    const geom = ref !== null ? null : propsToGeom(el.props as Record<string, unknown>);
    if (ref === null && geom === null) continue;
    // The effective bucket: revision clouds are markup (always unassigned);
    // block instances resolve instance ?? definition default; an assignment
    // resolving to a MISSING material reads as unassigned.
    let bucketId = UNASSIGNED;
    if (!isRevcloudElement(el)) {
      const assigned = ref !== null
        ? resolvedBlockMaterialId(
            el.props as Record<string, unknown>,
            blockTable.blockDefById(ref.blockId)?.materialId,
          )
        : materialIdOf(el.props as Record<string, unknown>);
      if (assigned !== null && materialsById.has(assigned)) {
        bucketId = assigned;
      }
    }
    const bucket = get(bucketId);
    bucket.count += 1;
    const m = measureElement(el, ref, blockTable);
    bucket.length += m.length;
    bucket.area += m.area;
  }
  const rows: BomRow[] = [];
  const sorted = [...materialsById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const material of sorted) {
    const b = buckets.get(material.id);
    if (b === undefined) continue;
    rows.push({
      materialId: material.id,
      name: material.name,
      count: b.count,
      length: round6(b.length),
      area: round6(b.area),
    });
  }
  const un = buckets.get(UNASSIGNED);
  if (un !== undefined && un.count > 0) {
    rows.push({
      materialId: null,
      name: "(unassigned)",
      count: un.count,
      length: round6(un.length),
      area: round6(un.area),
    });
  }
  return rows;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
