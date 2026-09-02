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
 * CAD-PARITY-015 (additive, Issue #110) — the indexes/quantities-side
 * engine powers, every one OPT-IN on the saved definition (a P013-shaped
 * record produces the EXACT P013 result — byte-identical responses, the
 * pinned fixtures stay green):
 *   - `pd:<prd-NNNNNN>` property-definition columns: the document-owned
 *     property registry resolves the (set, key) address; the VALUES still
 *     come from the canonical element property-set overlay only (an
 *     unknown/removed definition renders the deterministic missing "-").
 *   - property-driven `conditions` (elements/components sources): 1..4
 *     AND-ed typed comparisons over the overlay; an absent property never
 *     matches (LOCK-007 — absent is not guessed).
 *   - `calc:<name>` calculated columns: the bounded arithmetic formula
 *     over the NUMERIC channel of the schedule's columns (see below);
 *     non-numeric operands and non-finite results render "-" (missing,
 *     never a guess).
 *   - `sort`: 1..3 stable multi-key sort rules. Deterministic total cell
 *     order: numeric cells first (numeric compare), then text cells
 *     (code-unit compare), then missing cells; ties keep the pre-sort
 *     (document) order.
 *   - `grouping`: 1..3 group-by column keys — the run derives structured
 *     group segments (key values, row counts, per-column subtotals of the
 *     NUMERIC channel) plus grand totals. The `groups`/`totals` fields are
 *     present in the result ONLY when grouping is declared.
 *   - column `format` {unit?, align?}: presentation-only unit suffix on
 *     the rendered cell text ("<value> <unit>"; missing stays "-"). The
 *     numeric channel (sorting, calculated fields, subtotals) stays RAW —
 *     presentation never transforms the canonical value.
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
  PropertyDefRecord,
  RevisionRecord,
  ScheduleColumn,
  ScheduleFormula,
  ScheduleOperand,
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
  /** CAD-PARITY-015 (Issue #110): the document-owned property definitions
   *  (the `pd:<prd-NNNNNN>` column resolution — declarations only, the
   *  values still resolve from the element property-set overlay). */
  readonly propertyDefs?: readonly PropertyDefRecord[];
}

/** One group segment of a grouped run (present only when the schedule
 *  declares grouping): the group-key cell values in grouping order, the
 *  segment's row count, the index of the segment's first row in the final
 *  sorted row list, and the per-column subtotals of the NUMERIC channel
 *  (null on columns with no numeric values in the segment). */
export interface ScheduleGroupSegment {
  readonly key: readonly string[];
  readonly rowCount: number;
  readonly firstRowIndex: number;
  readonly subtotals: readonly (number | null)[];
}

/** The fresh schedule run result (rows as strings; canonical sha256). The
 *  `groups`/`totals` fields are present ONLY when the schedule declares
 *  grouping — every CAD-PARITY-013-shaped schedule response stays
 *  byte-identical. */
export interface ScheduleRunResult {
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly sha256: string;
  readonly groups?: readonly ScheduleGroupSegment[];
  readonly totals?: readonly (number | null)[];
}

// ---------------------------------------------------------------------------
// The internal cell model: the rendered text + the RAW numeric channel
// (calculated fields, numeric sorting, subtotals). Presentation formats the
// text only — the numeric channel is the canonical value.
// ---------------------------------------------------------------------------

interface Cell {
  readonly text: string;
  readonly num?: number;
}

function textCell(v: unknown): Cell {
  if (v === undefined || v === null) return { text: "-" };
  if (typeof v === "boolean") return { text: v ? "true" : "false" };
  if (typeof v === "number" && Number.isFinite(v)) return { text: String(v), num: v };
  return { text: String(v) };
}

/** [r, g, b] → "#RRGGBB" (the workspace color convention; "-" when absent). */
function colorText(color: readonly [number, number, number] | undefined): string {
  if (color === undefined) return "-";
  const hex = color.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"));
  return `#${hex[0]}${hex[1]}${hex[2]}`;
}

/** Resolve a dynamic `ps:<set>.<key>` property value against an element's
 *  meta overlay ("-" when the set/key/value is absent; the numeric channel
 *  carries finite number values). */
function propertyCellValue(
  key: string,
  props: Readonly<Record<string, unknown>>,
): Cell {
  if (!key.startsWith("ps:")) return { text: "-" };
  const rest = key.slice(3);
  const dot = rest.indexOf(".");
  if (dot <= 0) return { text: "-" };
  const setName = rest.slice(0, dot);
  const propKey = rest.slice(dot + 1);
  const meta = bimMetaOfProps(props);
  const set = meta?.propertySets?.find((s) => s.name === setName);
  const property = set?.properties.find((p) => p.key === propKey);
  if (property === undefined) return { text: "-" };
  return textCell(property.value);
}

/** Resolve a `pd:<prd-NNNNNN>` property-definition column: the definition
 *  registry maps the id to its (set, key) address, then the value resolves
 *  through the SAME canonical element property-set overlay (no parallel
 *  source of truth). Unknown/removed definitions render the deterministic
 *  missing cell "-" — rows are derived fresh, nothing is stored stale. */
function propertyDefCellValue(
  key: string,
  props: Readonly<Record<string, unknown>>,
  propertyDefs: readonly PropertyDefRecord[],
): Cell {
  if (!key.startsWith("pd:")) return { text: "-" };
  const defId = key.slice(3);
  const definition = propertyDefs.find((d) => d.id === defId);
  if (definition === undefined) return { text: "-" };
  return propertyCellValue(`ps:${definition.set}.${definition.key}`, props);
}

// ---------------------------------------------------------------------------
// The property-driven conditions (elements/components sources only).
// ---------------------------------------------------------------------------

/** Does one entity's overlay satisfy one condition? An ABSENT property
 *  never matches (any op — `ne` requires a present value that differs;
 *  absent is not guessed). gt/lt compare numbers only; contains compares
 *  strings only; eq/ne are strictly typed. */
function conditionMatches(
  condition: NonNullable<ScheduleRecord["conditions"]>[number],
  props: Readonly<Record<string, unknown>>,
): boolean {
  const meta = bimMetaOfProps(props);
  const set = meta?.propertySets?.find((s) => s.name === condition.set);
  const property = set?.properties.find((p) => p.key === condition.key);
  if (property === undefined) return false;
  const value = property.value;
  switch (condition.op) {
    case "eq":
      return value === condition.value;
    case "ne":
      return value !== condition.value;
    case "gt":
      return typeof value === "number" && typeof condition.value === "number" && value > condition.value;
    case "lt":
      return typeof value === "number" && typeof condition.value === "number" && value < condition.value;
    case "contains":
      return typeof value === "string" && typeof condition.value === "string" && value.includes(condition.value);
  }
}

// ---------------------------------------------------------------------------
// The calculated columns.
// ---------------------------------------------------------------------------

/** Resolve one operand to its numeric value (undefined when the operand is
 *  a column whose cell carries no numeric channel — text/missing). */
function operandNumber(
  operand: ScheduleOperand,
  cells: readonly Cell[],
  columns: readonly ScheduleColumn[],
): number | undefined {
  if ("value" in operand) return operand.value;
  const index = columns.findIndex((c) => c.key === operand.column);
  if (index === -1) return undefined;
  return cells[index]?.num;
}

/** Evaluate one calculated cell: both operands must resolve numerically;
 *  the result must be finite (division by zero is NOT a value — it renders
 *  the deterministic missing cell, LOCK-007). */
function calculatedCell(
  column: ScheduleColumn,
  cells: readonly Cell[],
  columns: readonly ScheduleColumn[],
): Cell {
  const formula = column.formula as ScheduleFormula;
  const left = operandNumber(formula.left, cells, columns);
  const right = operandNumber(formula.right, cells, columns);
  if (left === undefined || right === undefined) return { text: "-" };
  let result: number;
  switch (formula.op) {
    case "add":
      result = left + right;
      break;
    case "sub":
      result = left - right;
      break;
    case "mul":
      result = left * right;
      break;
    case "div":
      if (right === 0) return { text: "-" };
      result = left / right;
      break;
  }
  if (!Number.isFinite(result)) return { text: "-" };
  return { text: String(result), num: result };
}

// ---------------------------------------------------------------------------
// The deterministic sort (stable multi-key).
// ---------------------------------------------------------------------------

/** The total cell order: numeric cells (rank 0, numeric compare) before
 *  non-missing text cells (rank 1, code-unit compare) before missing cells
 *  (rank 2). Descending reverses the comparison, ties keep pre-sort order. */
function compareCells(a: Cell, b: Cell, direction: "asc" | "desc"): number {
  const rankOf = (cell: Cell): number => (cell.num !== undefined ? 0 : cell.text !== "-" ? 1 : 2);
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  let cmp = 0;
  if (ra === 0) {
    const an = a.num!;
    const bn = b.num!;
    cmp = an < bn ? -1 : an > bn ? 1 : 0;
  } else if (ra === 1) {
    cmp = a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  }
  if (direction === "desc") cmp = -cmp;
  return cmp;
}

// ---------------------------------------------------------------------------
// The presentation format (unit suffix; the numeric channel stays raw).
// ---------------------------------------------------------------------------

function formatCell(cell: Cell, format: ScheduleColumn["format"]): Cell {
  if (format?.unit === undefined || cell.text === "-") return cell;
  return { ...cell, text: `${cell.text} ${format.unit}` };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** Compute the fresh rows of one schedule against the context (pure). */
export function runSchedule(schedule: ScheduleRecord, ctx: ScheduleRunContext): ScheduleRunResult {
  const propertyDefs = ctx.propertyDefs ?? [];
  let cells: Cell[][] = [];
  switch (schedule.source) {
    case "elements":
    case "components":
      cells = elementComponentCells(schedule, ctx, propertyDefs);
      break;
    case "materials":
      cells = materialCells(schedule, ctx);
      break;
    case "views":
      cells = viewCells(schedule, ctx);
      break;
    case "layouts":
      cells = layoutCells(schedule, ctx);
      break;
    case "sheets":
      cells = sheetCells(schedule, ctx);
      break;
  }

  // The calculated columns (single pass over the base cells — the validator
  // guarantees formula operands reference non-calc columns only).
  if (schedule.columns.some((c) => c.formula !== undefined)) {
    cells = cells.map((row) => {
      const out: Cell[] = [];
      for (let i = 0; i < schedule.columns.length; i++) {
        const column = schedule.columns[i]!;
        out.push(column.formula !== undefined ? calculatedCell(column, row, schedule.columns) : row[i]!);
      }
      return out;
    });
  }

  // The stable multi-key sort (ties keep the pre-sort document order).
  if (schedule.sort !== undefined && schedule.sort.length > 0) {
    const sortRules = schedule.sort;
    const keyIndex = (key: string): number => schedule.columns.findIndex((c) => c.key === key);
    const indexed = cells.map((row, index) => ({ row, index }));
    indexed.sort((a, b) => {
      for (const rule of sortRules) {
        const i = keyIndex(rule.key);
        const cmp = compareCells(a.row[i] ?? { text: "-" }, b.row[i] ?? { text: "-" }, rule.direction);
        if (cmp !== 0) return cmp;
      }
      return a.index - b.index;
    });
    cells = indexed.map((entry) => entry.row);
  }

  // The presentation format (text channel only; the numeric channel stays
  // canonical — sorting/formulas/subtotals above used the raw values).
  const rows: string[][] = cells.map((row) =>
    row.map((cell, i) => formatCell(cell, schedule.columns[i]?.format).text),
  );

  const base: Omit<ScheduleRunResult, "groups" | "totals"> = {
    rows,
    rowCount: rows.length,
    sha256: createHash("sha256").update(canonicalStringify(rows)).digest("hex"),
  };

  // The structured grouping + grand totals (present ONLY when grouping is
  // declared — the P013 response shape stays byte-identical without it).
  if (schedule.grouping !== undefined && schedule.grouping.length > 0) {
    const groupIndexes = schedule.grouping.map((key) =>
      schedule.columns.findIndex((c) => c.key === key),
    );
    const groups: ScheduleGroupSegment[] = [];
    let currentKey: string | null = null;
    let segmentRows: Cell[][] = [];
    let segmentFirst = 0;
    const flush = (): void => {
      if (segmentRows.length === 0) return;
      groups.push({
        key: currentKey!.split("\u0000"),
        rowCount: segmentRows.length,
        firstRowIndex: segmentFirst,
        subtotals: subtotalsOf(schedule.columns, segmentRows),
      });
    };
    for (let i = 0; i < cells.length; i++) {
      const row = cells[i]!;
      const key = groupIndexes.map((idx) => row[idx]?.text ?? "-").join("\u0000");
      if (key !== currentKey) {
        flush();
        currentKey = key;
        segmentRows = [];
        segmentFirst = i;
      }
      segmentRows.push(row);
    }
    flush();
    return { ...base, groups, totals: subtotalsOf(schedule.columns, cells) };
  }
  return base;
}

/** Per-column subtotals of the numeric channel (null on columns with no
 *  numeric values in the segment — never a guessed zero). */
function subtotalsOf(columns: readonly ScheduleColumn[], rows: readonly Cell[][]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < columns.length; i++) {
    let sum: number | null = null;
    for (const row of rows) {
      const num = row[i]?.num;
      if (num !== undefined) sum = (sum ?? 0) + num;
    }
    out.push(sum);
  }
  return out;
}

// --- the elements/components sources -----------------------------------------

function elementComponentCells(
  schedule: ScheduleRecord,
  ctx: ScheduleRunContext,
  propertyDefs: readonly PropertyDefRecord[],
): Cell[][] {
  const entities = ctx.elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((entity) => schedule.source === "components" ? entity.type === "bim.componentInstance" : true);
  // The optional filter (type/storyId) + the CAD-PARITY-015 property-driven
  // conditions apply to the elements/components sources only — the validator
  // rejects them on any other source.
  const filter = schedule.filter;
  const conditions = schedule.conditions;
  const filtered = entities.filter((entity) => {
    if (filter !== undefined) {
      if (filter.type !== undefined && entity.type !== filter.type) return false;
      if (filter.storyId !== undefined) {
        const storyId = (entity as { storyId?: string }).storyId;
        if (storyId !== filter.storyId) return false;
      }
    }
    if (conditions !== undefined) {
      const props = ctx.elements.find((el) => el.id === entity.id)?.props as Readonly<Record<string, unknown>> ?? {};
      for (const condition of conditions) {
        if (!conditionMatches(condition, props)) return false;
      }
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
  const materialCellOf = (materialId: string | null): Cell => {
    if (materialId === null) return { text: "-" };
    const material = materialsByName.get(materialId);
    return material === undefined ? { text: "-" } : { text: material.name };
  };
  const rows: Cell[][] = [];
  for (const entity of filtered) {
    const props = ctx.elements.find((el) => el.id === entity.id)?.props as Readonly<Record<string, unknown>> ?? {};
    const row: Cell[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push({ text: entity.id });
          break;
        case "type":
          row.push({ text: entity.type });
          break;
        case "name":
          row.push(textCell((entity as { name?: string }).name));
          break;
        case "story": {
          const storyId = (entity as { storyId?: string }).storyId;
          row.push(storyId !== undefined ? { text: storiesById.get(storyId) ?? "-" } : { text: "-" });
          break;
        }
        case "layer": {
          const layerRef = elementLayerReference(props);
          row.push(layerRef !== null ? { text: layersById.get(layerRef) ?? layerRef } : { text: "-" });
          break;
        }
        case "material": {
          if (entity.type === "bim.componentInstance") {
            const definition = definitions.get(entity.definitionId);
            const effective = definition !== undefined ? effectiveMaterialId(definition, entity) : materialIdOf(props);
            row.push(materialCellOf(effective));
          } else {
            row.push(materialCellOf(materialIdOf(props)));
          }
          break;
        }
        case "classification":
          row.push(textCell(entity.meta?.classificationRef));
          break;
        case "renovationStatus":
          row.push({ text: effectiveRenovationStatus(entity.meta) });
          break;
        case "option":
          row.push(textCell(entity.meta?.option));
          break;
        default:
          if (column.key.startsWith("pd:")) {
            row.push(propertyDefCellValue(column.key, props, propertyDefs));
          } else {
            row.push(propertyCellValue(column.key, props));
          }
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the materials source ------------------------------------------------------

function materialCells(schedule: ScheduleRecord, ctx: ScheduleRunContext): Cell[][] {
  const materials = ctx.elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is MaterialEntity => x !== null && x.type === "bim.material");
  const rows: Cell[][] = [];
  for (const material of materials) {
    const row: Cell[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push({ text: material.id });
          break;
        case "name":
          row.push({ text: material.name });
          break;
        case "category":
          row.push(textCell(material.category));
          break;
        case "color":
          row.push({ text: colorText(material.color) });
          break;
        case "lineweight":
          row.push(textCell(material.lineweight));
          break;
        case "density":
          row.push(textCell(material.density));
          break;
        default:
          row.push({ text: "-" });
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the views source ----------------------------------------------------------

function viewCells(schedule: ScheduleRecord, ctx: ScheduleRunContext): Cell[][] {
  // The content hashes/primitive counts derive through the SAME fresh
  // projection as docs.listViews — never a stored value.
  const projections = projectAllViews(ctx.views, ctx.elements);
  const folderNames = new Map(ctx.navigatorNodes.map((n) => [n.id, n.name] as const));
  const rows: Cell[][] = [];
  for (const view of ctx.views) {
    const result = projections.get(view.id);
    const projection = result?.projection ?? null;
    const row: Cell[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push({ text: view.id });
          break;
        case "kind":
          row.push({ text: view.kind });
          break;
        case "title":
          row.push({ text: view.title });
          break;
        case "scale":
          row.push(textCell(view.scale));
          break;
        case "folder":
          row.push(view.folderId !== undefined ? { text: folderNames.get(view.folderId) ?? "-" } : { text: "-" });
          break;
        case "contentHash":
          row.push(projection !== null ? { text: viewContentHash(projection) } : { text: "-" });
          break;
        case "primitives":
          row.push(projection !== null ? { text: String(projection.primitives.length), num: projection.primitives.length } : { text: "0", num: 0 });
          break;
        default:
          row.push({ text: "-" });
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the layouts source ----------------------------------------------------------

function layoutCells(schedule: ScheduleRecord, ctx: ScheduleRunContext): Cell[][] {
  const subsetNames = new Map(ctx.navigatorNodes.map((n) => [n.id, n.name] as const));
  const layoutNames = new Map(ctx.layouts.map((l) => [l.id, l.name] as const));
  const titleBlockNames = new Map(ctx.titleBlocks.map((t) => [t.id, t.name] as const));
  const rows: Cell[][] = [];
  for (const layout of ctx.layouts) {
    const codes = revisionCodesOf(layout, ctx.revisions);
    const row: Cell[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push({ text: layout.id });
          break;
        case "name":
          row.push({ text: layout.name });
          break;
        case "subset":
          row.push(layout.subsetId !== undefined ? { text: subsetNames.get(layout.subsetId) ?? "-" } : { text: "-" });
          break;
        case "master":
          row.push(layout.masterId !== undefined ? { text: layoutNames.get(layout.masterId) ?? "-" } : { text: "-" });
          break;
        case "sheetNumber":
          row.push({ text: sheetNumberOf(layout, ctx.navigatorNodes, ctx.layouts) });
          break;
        case "titleBlock":
          row.push(
            layout.titleBlockPlacement !== undefined
              ? { text: titleBlockNames.get(layout.titleBlockPlacement.titleBlockId) ?? "-" }
              : { text: "-" },
          );
          break;
        case "revisions":
          row.push(codes.length > 0 ? { text: codes.join(",") } : { text: "-" });
          break;
        default:
          row.push({ text: "-" });
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}

// --- the sheets source -----------------------------------------------------------

function sheetCells(schedule: ScheduleRecord, ctx: ScheduleRunContext): Cell[][] {
  const rows: Cell[][] = [];
  for (const sheet of ctx.sheets) {
    const row: Cell[] = [];
    for (const column of schedule.columns) {
      switch (column.key) {
        case "id":
          row.push({ text: sheet.id });
          break;
        case "title":
          row.push({ text: sheet.title });
          break;
        case "sheetNumber":
          row.push({ text: sheet.titleBlock.sheetNumber });
          break;
        case "projectName":
          row.push({ text: sheet.titleBlock.projectName });
          break;
        case "views":
          row.push({ text: String(sheet.viewPlacements.length), num: sheet.viewPlacements.length });
          break;
        default:
          row.push({ text: "-" });
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}
