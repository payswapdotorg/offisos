/**
 * CAD-PARITY-015 (Issue #110) — the canonical quantity RULE table.
 *
 * The closed, typed support matrix of the quantity workflows: which BIM
 * element types carry which geometric measure under the CANONICAL
 * closed-form rules (bim/geometry.ts — the same canonical formulas that
 * back the solids and their closed-form assertions; ONE canonical source,
 * LOCK-007). Every type outside the matrix is honestly reported as
 * measure-unsupported (the takeoff's skipped list + the quantities.rules
 * query surface) — never silently approximated, never guessed.
 *
 * Measures and units (model units are millimeters):
 *   - length: mm (the wall axis length);
 *   - area:   mm² (footprint areas);
 *   - volume: mm³ (canonical solid volumes);
 *   - mass:   kg (density kg/m³ × volume m³ — material BOM rows only).
 *
 * Engine isolation (LOCK-003/018): the rules are pure closed-form
 * derivations over the canonical element props. Real engine BRep
 * measurement stays behind the adapter/worker boundary in the impact
 * cascade surface (impact/cascade.ts); this table is engine-free by
 * construction.
 */

/** The bounded measure vocabulary of the quantity workflows. */
export type QuantityMeasure = "count" | "length" | "area" | "volume" | "mass";

/** The declared unit per measure (deterministic presentation contract). */
export const QUANTITY_MEASURE_UNITS: Readonly<Record<QuantityMeasure, string>> = Object.freeze({
  count: "ea",
  length: "mm",
  area: "mm2",
  volume: "mm3",
  mass: "kg",
});

/** One row of the closed rule table: the per-type measure support with the
 *  canonical formula each supported measure derives from. */
export interface QuantityRuleEntry {
  readonly type: string;
  readonly length: string | null;
  readonly area: string | null;
  readonly volume: string | null;
  /** The canonical formulas in their source module (bim/geometry.ts closed
   *  forms unless noted). */
  readonly formula: { readonly length?: string; readonly area?: string; readonly volume?: string };
}

/**
 * The closed canonical quantity rule table. Types not listed carry the
 * count measure ONLY (every element counts exactly once — nothing else is
 * measured, the typed honest boundary).
 */
export const QUANTITY_RULE_TABLE: readonly QuantityRuleEntry[] = Object.freeze([
  Object.freeze({
    type: "bim.wall",
    length: "axis length ‖end−start‖",
    area: null,
    volume: "gross (axis·width·height) − Σ hosted openings (width·height·wall width)",
    formula: {
      length: "wallFrame(wall).length",
      volume: "wallFrame(wall).length * wall.width * wall.height - sum(opening.width * opening.height * wall.width for hosted openings)",
    },
  }),
  Object.freeze({
    type: "bim.slab",
    length: null,
    area: "footprint |corner2−corner1|",
    volume: "footprint area · thickness",
    formula: {
      area: "abs(corner2.x - corner1.x) * abs(corner2.y - corner1.y)",
      volume: "area * slab.thickness",
    },
  }),
  Object.freeze({
    type: "bim.space",
    length: null,
    area: "the authored footprint area (shoelace, computed at creation)",
    volume: "authored area · height",
    formula: {
      area: "space.area (authored canonical field)",
      volume: "space.area * space.height",
    },
  }),
  Object.freeze({
    type: "bim.roof",
    length: null,
    area: null,
    volume: "the gable-prism closed form span · ridgeLength · height / 2",
    formula: {
      volume: "roofVolume(roof) = (span * ridgeLength * roof.height) / 2",
    },
  }),
  Object.freeze({
    type: "bim.stair",
    length: null,
    area: null,
    volume: "the stacked-boxes closed form tread · width · rise · n(n+1)/2 (+ landing length · width · totalRise)",
    formula: {
      volume: "tread * width * (totalRise/n) * n(n+1)/2 + (landingLength ?? 0) * width * totalRise",
    },
  }),
  Object.freeze({
    type: "bim.componentInstance",
    length: null,
    area: null,
    volume: "the effective parametric box (instance ?? definition precedence)",
    formula: {
      volume: "effectiveBox(definition, instance) → sizeX * sizeY * sizeZ",
    },
  }),
  Object.freeze({
    type: "bim.zone",
    length: null,
    area: "Σ member space footprint areas (derived — membership lives on the zone)",
    volume: null,
    formula: {
      area: "sum(space.area for space in zone.spaceIds)",
    },
  }),
] as const);

/** The closed source vocabulary of the quantity workflows (the schedule
 *  sources that carry geometric semantics). */
export const QUANTITY_SOURCES: readonly string[] = Object.freeze(["elements", "components", "materials"]);

/** The closed group-by vocabulary. */
export const QUANTITY_GROUPINGS: readonly string[] = Object.freeze(["none", "type", "story", "material"]);

/** The measure support of one element type (the closed table lookup — types
 *  outside the table count only). */
export function quantitySupportOf(type: string): { length: boolean; area: boolean; volume: boolean } {
  const entry = QUANTITY_RULE_TABLE.find((e) => e.type === type);
  if (entry === undefined) return { length: false, area: false, volume: false };
  return {
    length: entry.length !== null,
    area: entry.area !== null,
    volume: entry.volume !== null,
  };
}

/** Does the entity carry at least one geometric measure (the row/skip
 *  boundary of the takeoff)? */
export function isMeasuredType(type: string): boolean {
  const support = quantitySupportOf(type);
  return support.length || support.area || support.volume;
}
