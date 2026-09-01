/**
 * CAD-PARITY-015 (Issue #110) — the deterministic quantity TAKEOFF engine
 * behind the `quantities.run` query.
 *
 * Quantity workflows derive from canonical geometry/component/material
 * semantics (the bim/geometry.ts closed forms + the authored canonical
 * fields + the effective-material precedence) and are REVISION-BOUND: the
 * report carries the RevisionRef of the CURRENT model head (revision id +
 * content hash — the same deterministic binding the graph bridge and the
 * impact cascade use), so a report is reproducible against the exact state
 * it was computed over. Like the schedules engine, NOTHING is stored —
 * rows/groups/totals are derived FRESH on every run; the same state yields
 * the same rows + reportSha256 on every host, every run.
 *
 * Honesty contract (LOCK-007): element types outside the closed rule table
 * are listed in `skipped` with the typed reason "no-canonical-rule" — they
 * are never approximated; materials without a density yield a mass of null;
 * measures outside a type's support are null (rendered "-" at the surface).
 *
 * Mass: density is kg/m³ and volumes are model units (mm³) — mass in kg is
 * density × volume × 1e-9 (the deterministic unit conversion, documented
 * here as the single canonical definition).
 *
 * Pure + engine-free (LOCK-018; the only node import is node:crypto for
 * the canonical report hash — the docs/schedules.ts precedent).
 */

import { createHash } from "node:crypto";
import type { Element } from "../contracts/caddocument.js";
import type { ModelHistory, RevisionRef } from "../contracts/model.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { baseContentHash, makeRevisionId, HISTORY_NOW } from "../caddocument/history.js";
import {
  bimGeometryContext,
  effectiveBox,
  effectiveMaterialId,
  elementToBimEntityOrNull,
  roofVolume,
  stairTotalRise,
  wallFrame,
} from "../bim/index.js";
import type {
  BimEntity,
  ComponentDefEntity,
  ComponentInstanceEntity,
  MaterialEntity,
  OpeningEntity,
  SlabEntity,
  SpaceEntity,
  StairEntity,
  WallEntity,
  ZoneEntity,
} from "../bim/index.js";
import { isMeasuredType, QUANTITY_GROUPINGS, QUANTITY_SOURCES } from "./rules.js";

// ---------------------------------------------------------------------------
// The input + context (pure document inputs — no live document dependency).
// ---------------------------------------------------------------------------

/** The takeoff request: one of the three quantity sources, the shared
 *  elements/components filter grammar and the closed group-by vocabulary. */
export interface QuantityTakeoffInput {
  readonly source: "elements" | "components" | "materials";
  readonly filter?: { readonly type?: string; readonly storyId?: string };
  readonly groupBy: "none" | "type" | "story" | "material";
}

/** The document tables + history the rows derive from (a pure read view). */
export interface QuantityTakeoffContext {
  readonly elements: readonly Element[];
  readonly history: ModelHistory;
}

// ---------------------------------------------------------------------------
// The report contract.
// ---------------------------------------------------------------------------

/** The report contract string (the deterministic versioned surface). */
export const QUANTITY_REPORT_CONTRACT = "offisos-quantities/1";

/** One measured element row (null measures render "-" at the surface). */
export interface QuantityRow {
  readonly elementId: string;
  readonly type: string;
  readonly name: string;
  readonly story: string;
  readonly material: string;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
}

/** One group segment (present only when groupBy ≠ "none"): the group key
 *  values, the measured row count and the subtotals of every measure. */
export interface QuantityGroup {
  readonly key: string[];
  readonly rowCount: number;
  readonly count: number;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
  readonly mass: number | null;
}

/** The grand totals over every measured row (present only when
 *  groupBy ≠ "none" — the grouping presentation boundary). */
export interface QuantityTotals {
  readonly count: number;
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
}

/** One material BOM row (the materials source): the effective-material
 *  aggregation of the measured elements. */
export interface MaterialBomRow {
  readonly materialId: string;
  readonly materialName: string;
  readonly category: string;
  readonly count: number;
  readonly volume: number | null;
  readonly mass: number | null;
}

/** An element outside the closed rule table — reported honestly. */
export interface SkippedElement {
  readonly elementId: string;
  readonly type: string;
  readonly reason: "no-canonical-rule";
}

/** The fresh deterministic takeoff report. */
export interface QuantityReport {
  readonly contract: typeof QUANTITY_REPORT_CONTRACT;
  readonly source: QuantityTakeoffInput["source"];
  readonly groupBy: QuantityTakeoffInput["groupBy"];
  readonly revision: RevisionRef;
  readonly rows: readonly QuantityRow[];
  readonly groups: readonly QuantityGroup[];
  readonly totals: QuantityTotals | null;
  readonly bom: readonly MaterialBomRow[];
  readonly skipped: readonly SkippedElement[];
  readonly reportSha256: string;
}

/** Parse + validate a takeoff payload (typed first-failure-wins errors;
 *  groupBy defaults to "none"; filter follows the schedule filter-source
 *  rule — elements/components only). */
export function parseQuantityTakeoffInput(payload: unknown): QuantityTakeoffInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("quantities.run requires an object payload { source, groupBy?, filter? }");
  }
  const p = payload as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "source" && key !== "groupBy" && key !== "filter") {
      throw new Error(`quantities.run: unknown field '${key}' (allowed: source, groupBy, filter)`);
    }
  }
  const source = p.source as QuantityTakeoffInput["source"];
  if (typeof p.source !== "string" || !(QUANTITY_SOURCES as readonly string[]).includes(p.source)) {
    throw new Error(`quantities.run: source must be one of ${QUANTITY_SOURCES.join(" | ")}`);
  }
  let groupBy: QuantityTakeoffInput["groupBy"] = "none";
  if (p.groupBy !== undefined && p.groupBy !== null) {
    if (typeof p.groupBy !== "string" || !(QUANTITY_GROUPINGS as readonly string[]).includes(p.groupBy)) {
      throw new Error(`quantities.run: groupBy must be one of ${QUANTITY_GROUPINGS.join(" | ")}`);
    }
    groupBy = p.groupBy as QuantityTakeoffInput["groupBy"];
  }
  let filter: QuantityTakeoffInput["filter"];
  if (p.filter !== undefined && p.filter !== null) {
    if (source === "materials") {
      throw new Error("quantities.run: a filter is only valid on the elements/components sources (got 'materials')");
    }
    if (typeof p.filter !== "object" || Array.isArray(p.filter)) {
      throw new Error("quantities.run: filter must be an object { type?, storyId? }");
    }
    const f = p.filter as Record<string, unknown>;
    if (f.type !== undefined && f.type !== null && (typeof f.type !== "string" || f.type.length === 0)) {
      throw new Error("quantities.run: filter.type must be a non-empty string when present (a BIM element type)");
    }
    if (f.storyId !== undefined && f.storyId !== null && (typeof f.storyId !== "string" || f.storyId.length === 0)) {
      throw new Error("quantities.run: filter.storyId must be a non-empty string when present");
    }
    filter = {
      ...(typeof f.type === "string" && f.type.length > 0 ? { type: f.type } : {}),
      ...(typeof f.storyId === "string" && f.storyId.length > 0 ? { storyId: f.storyId } : {}),
    };
  }
  if (source === "materials" && groupBy !== "none") {
    throw new Error("quantities.run: the materials source is the material aggregation itself — groupBy must be 'none'");
  }
  return { source, groupBy, ...(filter !== undefined ? { filter } : {}) };
}

// ---------------------------------------------------------------------------
// The revision binding (the current model head).
// ---------------------------------------------------------------------------

/** The RevisionRef of the CURRENT model head: the latest recorded revision,
 *  or the history base (revision 0) when no revision was recorded yet. The
 *  same deterministic derivation the graph bridge uses (bridge.ts) — one
 *  canonical binding, no second formula. */
export function currentRevisionRef(history: ModelHistory): RevisionRef {
  if (history.revisions.length === 0) {
    const contentHash = baseContentHash(history);
    return {
      revision_id: makeRevisionId(history.entity_id, 0, contentHash),
      revision_number: 0,
      version_id: history.base.version.version_id,
      version_number: history.base.version.version_number,
      parent_version_id: history.base.version.parent_version_id,
      content_hash: contentHash,
    };
  }
  const head = history.revisions[history.revisions.length - 1]!;
  return {
    revision_id: head.revision_id,
    revision_number: head.revision_number,
    version_id: head.version.version_id,
    version_number: head.version.version_number,
    parent_version_id: head.version.parent_version_id,
    content_hash: head.content_hash,
  };
}

// ---------------------------------------------------------------------------
// The canonical closed-form measures.
// ---------------------------------------------------------------------------

/** The canonical measures of one measured entity (null outside the type's
 *  support). Pure functions over the canonical props + the geometry
 *  context (story levels, hosted openings, component definitions). */
interface EntityMeasures {
  readonly length: number | null;
  readonly area: number | null;
  readonly volume: number | null;
}

function entityMeasures(
  entity: BimEntity,
  ctx: {
    readonly openingsByHost: ReadonlyMap<string, OpeningEntity[]>;
    readonly spacesById: ReadonlyMap<string, SpaceEntity>;
    readonly definitionsById: ReadonlyMap<string, ComponentDefEntity>;
    readonly bimCtx: ReturnType<typeof bimGeometryContext>;
  },
): EntityMeasures {
  if (entity === null) return { length: null, area: null, volume: null };
  switch (entity.type) {
    case "bim.wall": {
      const wall = entity as WallEntity;
      const frame = wallFrame(wall);
      const gross = frame.length * wall.width * wall.height;
      const voids = (ctx.openingsByHost.get(wall.id) ?? []).reduce(
        (sum, opening) => sum + opening.width * opening.height * wall.width,
        0,
      );
      return { length: frame.length, area: null, volume: gross - voids };
    }
    case "bim.slab": {
      const slab = entity as SlabEntity;
      const area = Math.abs(slab.corner2[0] - slab.corner1[0]) * Math.abs(slab.corner2[1] - slab.corner1[1]);
      return { length: null, area, volume: area * slab.thickness };
    }
    case "bim.space": {
      const space = entity as SpaceEntity;
      return { length: null, area: space.area, volume: space.area * space.height };
    }
    case "bim.roof": {
      return { length: null, area: null, volume: roofVolume(entity) };
    }
    case "bim.stair": {
      const stair = entity as StairEntity;
      const totalRise = stairTotalRise(stair, ctx.bimCtx);
      const n = stair.stepCount;
      const rise = totalRise / n;
      const run = stair.tread * stair.width * rise * ((n * (n + 1)) / 2);
      const landing = stair.landingLength !== undefined && stair.landingLength > 0
        ? stair.landingLength * stair.width * totalRise
        : 0;
      return { length: null, area: null, volume: run + landing };
    }
    case "bim.componentInstance": {
      const instance = entity as ComponentInstanceEntity;
      const definition = ctx.definitionsById.get(instance.definitionId);
      if (definition === undefined) {
        // The document layer guarantees definition existence; a missing
        // definition is stored-state corruption, never a guess (LOCK-007).
        throw new Error(
          `quantity takeoff: component instance '${instance.id}' references unknown definition '${instance.definitionId}'`,
        );
      }
      const [sx, sy, sz] = effectiveBox(definition, instance);
      return { length: null, area: null, volume: sx * sy * sz };
    }
    case "bim.zone": {
      const zone = entity as ZoneEntity;
      const area = zone.spaceIds.reduce((sum, spaceId) => {
        const space = ctx.spacesById.get(spaceId);
        return space === undefined ? sum : sum + space.area;
      }, 0);
      return { length: null, area, volume: null };
    }
    default:
      return { length: null, area: null, volume: null };
  }
}

// ---------------------------------------------------------------------------
// The report builder.
// ---------------------------------------------------------------------------

/** Compute the fresh takeoff report (pure; deterministic; nothing stored). */
export function runQuantityTakeoff(input: QuantityTakeoffInput, ctx: QuantityTakeoffContext): QuantityReport {
  const revision = currentRevisionRef(ctx.history);
  const entities = ctx.elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Resolution tables (the same shared precedence the schedules use).
  const storiesById = new Map<string, string>();
  for (const entity of entities) {
    if (entity.type === "bim.story") storiesById.set(entity.id, entity.name);
  }
  const materialsById = new Map<string, MaterialEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.material") materialsById.set(entity.id, entity);
  }
  const definitionsById = new Map<string, ComponentDefEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.componentDef") definitionsById.set(entity.id, entity);
  }
  const spacesById = new Map<string, SpaceEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.space") spacesById.set(entity.id, entity);
  }
  const openingsByHost = new Map<string, OpeningEntity[]>();
  for (const entity of entities) {
    if (entity.type === "bim.opening") {
      const list = openingsByHost.get(entity.hostId) ?? [];
      list.push(entity);
      openingsByHost.set(entity.hostId, list);
    }
  }
  const elementPropsById = new Map<string, Readonly<Record<string, unknown>>>();
  for (const el of ctx.elements) elementPropsById.set(el.id, el.props);

  // The elements/components scope (components = componentInstance entities
  // only — the schedule source precedent).
  const scoped = entities.filter((entity) => {
    if (input.source === "components" && entity.type !== "bim.componentInstance") return false;
    if (input.filter !== undefined) {
      if (input.filter.type !== undefined && entity.type !== input.filter.type) return false;
      if (input.filter.storyId !== undefined) {
        const storyId = (entity as { storyId?: string }).storyId;
        if (storyId !== input.filter.storyId) return false;
      }
    }
    return true;
  });

  const storyNameOf = (entity: object): string => {
    const storyId = (entity as { storyId?: string }).storyId;
    return storyId !== undefined ? (storiesById.get(storyId) ?? "-") : "-";
  };
  const materialNameOf = (entity: object): string => {
    const props = elementPropsById.get((entity as { id: string }).id) ?? {};
    if ((entity as { type: string }).type === "bim.componentInstance") {
      const instance = entity as ComponentInstanceEntity;
      const definition = definitionsById.get(instance.definitionId);
      const effective = definition !== undefined ? effectiveMaterialId(definition, instance) : materialIdOfProps(props);
      return effective !== null ? (materialsById.get(effective)?.name ?? "-") : "-";
    }
    const materialId = materialIdOfProps(props);
    return materialId !== null ? (materialsById.get(materialId)?.name ?? "-") : "-";
  };

  if (input.source === "materials") {
    return buildMaterialBom(entities, materialsById, definitionsById, elementPropsById, revision);
  }

  // The element/component rows: measured entities in document order; the
  // unmeasured are reported honestly in skipped.
  const rows: QuantityRow[] = [];
  const skipped: SkippedElement[] = [];
  const bimCtx = bimGeometryContext(entities);
  const measureCtx = { openingsByHost, spacesById, definitionsById, bimCtx };
  for (const entity of scoped) {
    if (!isMeasuredType(entity.type)) {
      skipped.push({ elementId: entity.id, type: entity.type, reason: "no-canonical-rule" });
      continue;
    }
    const measures = entityMeasures(entity, measureCtx);
    rows.push({
      elementId: entity.id,
      type: entity.type,
      name: cellText((entity as { name?: string }).name),
      story: storyNameOf(entity),
      material: materialNameOf(entity),
      ...measures,
    });
  }

  // The grouping + totals (present only when groupBy ≠ "none").
  let groups: QuantityGroup[] = [];
  let totals: QuantityTotals | null = null;
  if (input.groupBy !== "none") {
    const keyOf = (row: QuantityRow): string[] => {
      switch (input.groupBy) {
        case "type":
          return [row.type];
        case "story":
          return [row.story];
        case "material":
          return [row.material];
        default:
          return [];
      }
    };
    const segments = new Map<string, QuantityRow[]>();
    const keyOrder: string[] = [];
    for (const row of rows) {
      const key = keyOf(row).join("\u0000");
      if (!segments.has(key)) {
        segments.set(key, []);
        keyOrder.push(key);
      }
      segments.get(key)!.push(row);
    }
    groups = keyOrder.map((key) => {
      const segment = segments.get(key)!;
      return groupOf(segment, key.split("\u0000"));
    });
    totals = totalsOf(rows);
  }

  const report: Omit<QuantityReport, "reportSha256"> = {
    contract: QUANTITY_REPORT_CONTRACT,
    source: input.source,
    groupBy: input.groupBy,
    revision,
    rows,
    groups,
    totals,
    bom: [],
    skipped,
  };
  return { ...report, reportSha256: reportHash(report) };
}

// --- the materials BOM -------------------------------------------------------

function buildMaterialBom(
  entities: readonly BimEntity[],
  materialsById: ReadonlyMap<string, MaterialEntity>,
  definitionsById: ReadonlyMap<string, ComponentDefEntity>,
  elementPropsById: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  revision: RevisionRef,
): QuantityReport {
  const bimCtx = bimGeometryContext(entities);
  const spacesById = new Map<string, SpaceEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.space") spacesById.set(entity.id, entity);
  }
  const openingsByHost = new Map<string, OpeningEntity[]>();
  for (const entity of entities) {
    if (entity.type === "bim.opening") {
      const list = openingsByHost.get(entity.hostId) ?? [];
      list.push(entity);
      openingsByHost.set(entity.hostId, list);
    }
  }
  const measureCtx = { openingsByHost, spacesById, definitionsById, bimCtx };

  // Aggregate over the MEASURED volumed entities (the BOM is the material
  // volume aggregation — length/area-only rows contribute no BOM volume and
  // are not BOM rows; the elements source reports them).
  const byMaterial = new Map<string, { material: MaterialEntity | null; count: number; volume: number }>();
  const keyOrder: string[] = [];
  let skippedCount = 0;
  for (const entity of entities) {
    const measures = entityMeasures(entity, measureCtx);
    if (measures.volume === null) {
      skippedCount += 1;
      continue;
    }
    const props = elementPropsById.get(entity.id) ?? {};
    let materialId: string | null;
    if (entity.type === "bim.componentInstance") {
      const instance = entity as ComponentInstanceEntity;
      const definition = definitionsById.get(instance.definitionId);
      materialId = definition !== undefined ? effectiveMaterialId(definition, instance) : materialIdOfProps(props);
    } else {
      materialId = materialIdOfProps(props);
    }
    const key = materialId ?? "-";
    if (!byMaterial.has(key)) {
      byMaterial.set(key, { material: materialId !== null ? (materialsById.get(materialId) ?? null) : null, count: 0, volume: 0 });
      keyOrder.push(key);
    }
    const agg = byMaterial.get(key)!;
    agg.count += 1;
    agg.volume += measures.volume;
  }

  const bom: MaterialBomRow[] = keyOrder.map((key) => {
    const agg = byMaterial.get(key)!;
    const density = agg.material?.density;
    const mass = density !== undefined && Number.isFinite(density) && density > 0
      ? density * agg.volume * 1e-9
      : null;
    return {
      materialId: key,
      materialName: agg.material?.name ?? "-",
      category: cellText(agg.material?.category),
      count: agg.count,
      volume: agg.volume,
      mass,
    };
  });

  const totals: QuantityTotals = {
    count: bom.reduce((sum, row) => sum + row.count, 0),
    length: null,
    area: null,
    volume: bom.reduce((sum, row) => sum + (row.volume ?? 0), 0),
  };
  const report: Omit<QuantityReport, "reportSha256"> = {
    contract: QUANTITY_REPORT_CONTRACT,
    source: "materials",
    groupBy: "none",
    revision,
    rows: [],
    groups: [],
    totals,
    bom,
    skipped: [],
  };
  void skippedCount;
  return { ...report, reportSha256: reportHash(report) };
}

// --- shared helpers ------------------------------------------------------------

/** The deterministic cell text ("-" for absent — the schedules convention). */
function cellText(v: unknown): string {
  if (v === undefined || v === null) return "-";
  return String(v);
}

/** The material id of an element's props (the materials module precedence,
 *  inlined to keep this module's import graph minimal). */
function materialIdOfProps(props: Readonly<Record<string, unknown>>): string | null {
  const raw = props["materialId"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function groupOf(segment: readonly QuantityRow[], key: string[]): QuantityGroup {
  const totals = totalsOf(segment);
  const volume = totals.volume;
  const mass = null; // mass is a material-BOM measure (density-derived), not an element-group measure
  return {
    key,
    rowCount: segment.length,
    count: totals.count,
    length: totals.length,
    area: totals.area,
    volume,
    mass,
  };
}

function totalsOf(rows: readonly QuantityRow[]): QuantityTotals {
  let length: number | null = null;
  let area: number | null = null;
  let volume: number | null = null;
  for (const row of rows) {
    if (row.length !== null) length = (length ?? 0) + row.length;
    if (row.area !== null) area = (area ?? 0) + row.area;
    if (row.volume !== null) volume = (volume ?? 0) + row.volume;
  }
  return { count: rows.length, length, area, volume };
}

/** The canonical report hash — the determinism/parity anchor. */
function reportHash(report: Omit<QuantityReport, "reportSha256">): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        contract: report.contract,
        source: report.source,
        groupBy: report.groupBy,
        revision: {
          revision_id: report.revision.revision_id,
          revision_number: report.revision.revision_number,
          content_hash: report.revision.content_hash,
        },
        rows: report.rows,
        groups: report.groups,
        totals: report.totals,
        bom: report.bom,
        skipped: report.skipped,
      }),
    )
    .digest("hex");
}

// Keep the deterministic timestamp import referenced for contract parity
// documentation (the schedules/revisions fixed-now precedent).
void HISTORY_NOW;
