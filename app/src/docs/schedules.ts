/**
 * CAD-PARITY-013 schedule/index derivation (Issue #104) — the deterministic
 * fresh row computation behind the `schedules.run` query.
 *
 * Schedules are SAVED DEFINITIONS only (`sch-NNNNNN` records: name, a closed
 * source vocabulary, an optional elements/components filter, 1..12 columns).
 * The ROWS are NEVER stored — they are derived FRESH from the CURRENT
 * canonical state on every run (the docs.regenerate determinism precedent:
 * there is NO parallel source of truth; the same snapshot yields the same
 * rows + sha256 on every host, every run).
 *
 * Cell rendering is fully deterministic: every cell is a string —
 *   - missing (undefined/null) → "-";
 *   - booleans → "true" / "false";
 *   - numbers → String(value) (the canonical authored value; no rounding
 *     anywhere — the materials BOM keeps raw canonical numbers too);
 *   - colors (materials source) → "#RRGGBB" (the workspace color
 *     convention);
 *   - revision codes / title-block / subset / master / folder names join
 *     through their tables, "-" when the reference is absent.
 *
 * Source row sets (document order throughout):
 *   - elements:    every BIM entity (bim-marked element) in document order;
 *   - components:  the bim.componentInstance entities in document order
 *                  (materials resolve instance ?? definition — the shared
 *                  effective precedence);
 *   - materials:   the bim.material entities in document order;
 *   - views:       the view table in document order, content hashes and
 *                  primitive counts computed through the SAME fresh
 *                  projection as docs.listViews (never stored);
 *   - layouts:     the layout table in document order, sheet numbers
 *                  derived through the shared layouts/book sheet-number
 *                  derivation (subset custom numbering included);
 *   - sheets:      the sheet table in document order.
 *
 * The `ps:<set>.<key>` dynamic property columns resolve through the
 * bim.meta property-set overlay (the canonical set name + property key
 * grammar; values render through the same cell rules).
 *
 * Pure + engine-free (LOCK-018; the only node import is node:crypto for the
 * canonical rows hash — the regenerate.ts precedent).
 */

import { createHash } from "node:crypto";
import type {
  DocsSheetRecord,
  DocsViewRecord,
  Element,
  LayerRecord,
  LayoutRecord,
  NavigatorNodeRecord,
  RevisionRecord,
  ScheduleRecord,
  TitleBlockRecord,
  ViewportRecord,
} from "../contracts/caddocument.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { elementToBimEntityOrNull, effectiveMaterialId } from "../bim/index.js";
import type { ComponentDefEntity, MaterialEntity } from "../bim/index.js";
import { bimMetaOfProps, effectiveRenovationStatus } from "../bim/meta.js";
import { materialIdOf } from "../workspace/materials.js";
import { elementLayerReference } from "../caddocument/workspace.js";
import { sheetNumberOf, revisionCodesOf } from "../workspace/layouts/book.js";
import { projectAllViews, viewContentHash } from "./regenerate.js";

// ---------------------------------------------------------------------------
// The run context (pure document inputs — no live document dependency).
// ---------------------------------------------------------------------------

/** The document tables + elements the rows derive from (a pure read view). */
export interface ScheduleRunContext {
  readonly elements: readonly Element[];
  readonly views: readonly DocsViewRecord[];
  readonly sheets: readonly DocsSheetRecord[];
  readonly layouts: readonly LayoutRecord[];
  readonly viewports: readonly ViewportRecord[];
  readonly navigatorNodes: readonly NavigatorNodeRecord[];
  readonly revisions: readonly RevisionRecord[];
  readonly titleBlocks: readonly TitleBlockRecord[];
  readonly layers: readonly LayerRecord[];
}

/** The fresh schedule run result (rows as strings; canonical sha256). */
export interface ScheduleRunResult {
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly sha256: string;
}

/** One cell of one row (the deterministic string rendering). */
function cellText(v: unknown): string {
  if (v === undefined || v === null) return "-";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** [r, g, b] → "#RRGGBB" (the workspace color convention; "-" when absent). */
function colorText(color: readonly [number, number, number] | undefined): string {
  if (color === undefined) return "-";
  const hex = color.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"));
  return `#${hex[0]}${hex[1]}${hex[2]}`;
}

/** Resolve a dynamic `ps:<set>.<key>` property column against an element's
 *  meta overlay ("-" when the set/key/value is absent). */
function propertyCell(key: string, props: Readonly<Record<string, unknown>>): string {
  if (!key.startsWith("ps:")) return "-";
  const rest = key.slice(3);
  const dot = rest.indexOf(".");
  if (dot <= 0) return "-";
  const setName = rest.slice(0, dot);
  const propKey = rest.slice(dot + 1);
  const meta = bimMetaOfProps(props);
  const set = meta?.propertySets?.find((s) => s.name === setName);
  const property = set?.properties.find((p) => p.key === propKey);
  return cellText(property?.value);
}

/** Compute the fresh rows of one schedule against the context (pure). */
export function runSchedule(schedule: ScheduleRecord, ctx: ScheduleRunContext): ScheduleRunResult {
  const rows: string[][] = [];
  switch (schedule.source) {
    case "elements":
    case "components":
      rows.push(...elementComponentRows(schedule, ctx));
      break;
    case "materials":
      rows.push(...materialRows(schedule, ctx));
      break;
    case "views":
      rows.push(...viewRows(schedule, ctx));
      break;
    case "layouts":
      rows.push(...layoutRows(schedule, ctx));
      break;
    case "sheets":
      rows.push(...sheetRows(schedule, ctx));
      break;
  }
  return {
    rows,
    rowCount: rows.length,
    sha256: createHash("sha256").update(canonicalStringify(rows)).digest("hex"),
  };
}

// --- the elements/components sources -----------------------------------------

function elementComponentRows(schedule: ScheduleRecord, ctx: ScheduleRunContext): string[][] {
  const entities = ctx.elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((entity) => schedule.source === "components" ? entity.type === "bim.componentInstance" : true);
  // The optional filter (type/storyId) applies to the elements/components
  // sources only — the validator rejects a filter on any other source.
  const filter = schedule.filter;
  const filtered = entities.filter((entity) => {
    if (filter === undefined) return true;
    if (filter.type !== undefined && entity.type !== filter.type) return false;
    if (filter.storyId !== undefined) {
      const storyId = (entity as { storyId?: string }).storyId;
      if (storyId !== filter.storyId) return false;
    }
    return true;
  });
  // Resolution tables: story names, layer names, material names, component
  // definitions (instance ?? definition material precedence).
  const storiesById = new Map<string, string>();
  for (const entity of entities) {
    if (entity.type === "bim.story") storiesById.set(entity.id, entity.name);
  }
  const layersById = new Map(ctx.layers.map((l) => [l.id, l.name] as const));
  const materialsByName = new Map<string, MaterialEntity>();
  for (const el of ctx.elements) {
    const entity = elementToBimEntityOrNull(el);
    if (entity !== null && entity.type === "bim.material") materialsByName.set(entity.id, entity);
  }
  const definitions = new Map<string, ComponentDefEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.componentDef") definitions.set(entity.id, entity);
  }
  const materialNameOf = (materialId: string | null): string => {
    if (materialId === null) return "-";
    return materialsByName.get(materialId)?.name ?? "-";
  };
  const rows: string[][] = [];
  for (const entity of filtered) {
    const props = ctx.elements.find((el) => el.id === entity.id)?.props as Readonly<Record<string, unknown>> ?? {};
    const row: string[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push(entity.id);
          break;
        case "type":
          row.push(entity.type);
          break;
        case "name":
          row.push(cellText((entity as { name?: string }).name));
          break;
        case "story": {
          const storyId = (entity as { storyId?: string }).storyId;
          row.push(storyId !== undefined ? (storiesById.get(storyId) ?? "-") : "-");
          break;
        }
        case "layer": {
          const layerRef = elementLayerReference(props);
          row.push(layerRef !== null ? (layersById.get(layerRef) ?? layerRef) : "-");
          break;
        }
        case "material": {
          if (entity.type === "bim.componentInstance") {
            const definition = definitions.get(entity.definitionId);
            const effective = definition !== undefined ? effectiveMaterialId(definition, entity) : materialIdOf(props);
            row.push(materialNameOf(effective));
          } else {
            row.push(materialNameOf(materialIdOf(props)));
          }
          break;
        }
        case "classification":
          row.push(cellText(entity.meta?.classificationRef));
          break;
        case "renovationStatus":
          row.push(effectiveRenovationStatus(entity.meta));
          break;
        case "option":
          row.push(cellText(entity.meta?.option));
          break;
        default:
          row.push(propertyCell(column.key, props));
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the materials source ------------------------------------------------------

function materialRows(schedule: ScheduleRecord, ctx: ScheduleRunContext): string[][] {
  const materials = ctx.elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is MaterialEntity => x !== null && x.type === "bim.material");
  const rows: string[][] = [];
  for (const material of materials) {
    const row: string[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push(material.id);
          break;
        case "name":
          row.push(material.name);
          break;
        case "category":
          row.push(cellText(material.category));
          break;
        case "color":
          row.push(colorText(material.color));
          break;
        case "lineweight":
          row.push(cellText(material.lineweight));
          break;
        case "density":
          row.push(cellText(material.density));
          break;
        default:
          row.push("-");
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the views source ----------------------------------------------------------

function viewRows(schedule: ScheduleRecord, ctx: ScheduleRunContext): string[][] {
  // The content hashes/primitive counts derive through the SAME fresh
  // projection as docs.listViews — never a stored value.
  const projections = projectAllViews(ctx.views, ctx.elements);
  const folderNames = new Map(ctx.navigatorNodes.map((n) => [n.id, n.name] as const));
  const rows: string[][] = [];
  for (const view of ctx.views) {
    const result = projections.get(view.id);
    const projection = result?.projection ?? null;
    const row: string[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push(view.id);
          break;
        case "kind":
          row.push(view.kind);
          break;
        case "title":
          row.push(view.title);
          break;
        case "scale":
          row.push(cellText(view.scale));
          break;
        case "folder":
          row.push(view.folderId !== undefined ? (folderNames.get(view.folderId) ?? "-") : "-");
          break;
        case "contentHash":
          row.push(projection !== null ? viewContentHash(projection) : "-");
          break;
        case "primitives":
          row.push(projection !== null ? String(projection.primitives.length) : "0");
          break;
        default:
          row.push("-");
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the layouts source ----------------------------------------------------------

function layoutRows(schedule: ScheduleRecord, ctx: ScheduleRunContext): string[][] {
  const subsetNames = new Map(ctx.navigatorNodes.map((n) => [n.id, n.name] as const));
  const layoutNames = new Map(ctx.layouts.map((l) => [l.id, l.name] as const));
  const titleBlockNames = new Map(ctx.titleBlocks.map((t) => [t.id, t.name] as const));
  const rows: string[][] = [];
  for (const layout of ctx.layouts) {
    const codes = revisionCodesOf(layout, ctx.revisions);
    const row: string[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push(layout.id);
          break;
        case "name":
          row.push(layout.name);
          break;
        case "subset":
          row.push(layout.subsetId !== undefined ? (subsetNames.get(layout.subsetId) ?? "-") : "-");
          break;
        case "master":
          row.push(layout.masterId !== undefined ? (layoutNames.get(layout.masterId) ?? "-") : "-");
          break;
        case "sheetNumber":
          row.push(sheetNumberOf(layout, ctx.navigatorNodes, ctx.layouts));
          break;
        case "titleBlock":
          row.push(
            layout.titleBlockPlacement !== undefined
              ? (titleBlockNames.get(layout.titleBlockPlacement.titleBlockId) ?? "-")
              : "-",
          );
          break;
        case "revisions":
          row.push(codes.length > 0 ? codes.join(",") : "-");
          break;
        default:
          row.push("-");
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the sheets source -----------------------------------------------------------

function sheetRows(schedule: ScheduleRecord, ctx: ScheduleRunContext): string[][] {
  const rows: string[][] = [];
  for (const sheet of ctx.sheets) {
    const row: string[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push(sheet.id);
          break;
        case "title":
          row.push(sheet.title);
          break;
        case "sheetNumber":
          row.push(sheet.titleBlock.sheetNumber);
          break;
        case "projectName":
          row.push(sheet.titleBlock.projectName);
          break;
        case "views":
          row.push(String(sheet.viewPlacements.length));
          break;
        default:
          row.push("-");
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}
