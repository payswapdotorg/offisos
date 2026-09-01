/**
 * CAD-PARITY-014 (Issue #107) — the IFC documentation exchange carrier (D2):
 * the P013 documentation tables ↔ IfcGroup entities.
 *
 * CARRIER (one IfcGroup per record): IfcGroup is an IfcRoot (the guid
 * derives deterministically from the canonical record id through
 * identity.ts ifcGuidFor — the same "locked caller guid" discipline as
 * elements) AND an IfcObject (psets attach through the worker's standard
 * pset path):
 *   - Pset_OffisosIdentity {DomainId: <record id>, DomainKind: "docs.<kind>"}
 *     — identity provenance ONLY (the established pattern);
 *   - Pset_OffisosDocs {…record fields as string/number/boolean values}.
 *
 * FIELD ENCODING (documented, deterministic, reversible): array-valued
 * fields serialize as JOINED STRINGS with backslash escaping of the
 * component separators — id lists comma-joined (RevisionDomainIds,
 * LayoutDomainIds), column keys comma-joined, column labels pipe-joined,
 * publisher items pipe-joined "kind:id:format" triplets, title-block rows
 * semicolon-joined "label|field|value" triplets. A component's literal
 * separator characters escape as "\<sep>" (and "\\" for the backslash
 * itself); the decode splits on UNESCAPED separators only.
 *
 * Structure (folder→view, subset→layout, view→story scope) rides in the
 * linkage fields (ParentDomainId / StoryDomainId / FolderDomainId /
 * SubsetDomainId / MasterDomainId / TitleBlockDomainId /
 * SourceViewDomainId / RevisionDomainIds / LayoutDomainIds); the import
 * reconstructs by identity: the TARGET document mints fresh
 * nav-/vw-/lo-/tb-/sch-/rev-/pub- ids (the document authority mints — a
 * foreign file never dictates canonical identity) and resolves the linkage
 * fields back through the DomainId→minted-id map. Unresolvable links and
 * malformed records are UNSUPPORTED rows in the classification report —
 * never silently dropped, never guessed (LOCK-007).
 *
 * The documentation exchange is METADATA-ONLY: view CONTENT is derived
 * (regenerates from the model through projectAllViews); sheets (sh-*) are
 * COMPAT-CAD-003 constructs that stay OUT of IFC (their carrier is the
 * Sheet IR + the pdf/svg writers) and are counted as not exported.
 *
 * Pure + engine-free (LOCK-018).
 */

import { createHash } from "node:crypto";
import type {
  DocsViewRecord,
  LayoutRecord,
  NavigatorNodeRecord,
  PublisherSetRecord,
  RevisionRecord,
  ScheduleRecord,
  TitleBlockRecord,
} from "../contracts/caddocument.js";
import type { IfcDocumentationRecord, IfcParsedDocumentation, IfcParsedDocumentationRecord } from "../contracts/ifc.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import {
  validateDocsViewRecord,
  validateLayoutRecord,
  validateNavigatorNodeRecord,
  validatePublisherSetRecord,
  validateRevisionRecord,
  validateScheduleRecord,
  validateTitleBlockRecord,
} from "../caddocument/workspace.js";
import { ifcGuidFor } from "./identity.js";
import { classifyNumber, classifyValue, exactField, summarizeReports, unsupportedField, type IfcElementReport, type IfcFieldResult } from "./report.js";

// --- The joined-string codec (documented in the module header) ----------------

const SEPARATORS = [",", "|", ";", ":"] as const;

/** Escape a literal component (backslash + every separator). */
function esc(value: string): string {
  let out = value.split("\\").join("\\\\");
  for (const sep of SEPARATORS) {
    out = out.split(sep).join(`\\${sep}`);
  }
  return out;
}

/** Split an escaped joined string on ONE separator (unescaped only). */
function splitEsc(value: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\") {
      const next = value[i + 1];
      if (next !== undefined && (next === "\\" || (SEPARATORS as readonly string[]).includes(next))) {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === sep) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function joinComma(values: readonly string[]): string {
  return values.map(esc).join(",");
}
function joinPipe(values: readonly string[]): string {
  return values.map(esc).join("|");
}
function joinSemicolon(values: readonly string[]): string {
  return values.map(esc).join(";");
}

// --- The documentation tables input (document order per kind) ------------------

export interface IfcDocumentationTables {
  readonly views: readonly DocsViewRecord[];
  readonly layouts: readonly LayoutRecord[];
  readonly navigatorNodes: readonly NavigatorNodeRecord[];
  readonly titleBlocks: readonly TitleBlockRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly revisions: readonly RevisionRecord[];
  readonly publisherSets: readonly PublisherSetRecord[];
}

export interface IfcDocumentationExport {
  /** One IfcDocumentationRecord per table record, fixed kind-group order
   *  (views → layouts → navigator nodes → title blocks → schedules →
   *  revisions → publisher sets), each kind in document order. */
  readonly groups: readonly IfcDocumentationRecord[];
  readonly counts: {
    readonly views: number;
    readonly layouts: number;
    readonly navigatorNodes: number;
    readonly titleBlocks: number;
    readonly schedules: number;
    readonly revisions: number;
    readonly publisherSets: number;
    /** Sheets stay OUT of IFC (the Sheet IR is their carrier) — counted. */
    readonly sheetsNotExported: number;
  };
}

/** Build the IfcGroup exchange records for the documentation tables. */
export function buildIfcDocumentationExport(
  tables: IfcDocumentationTables,
  sheetsNotExported: number,
): IfcDocumentationExport {
  const groups: IfcDocumentationRecord[] = [];
  for (const view of tables.views) {
    const fields: Record<string, string | number | boolean> = {
      Kind: view.kind,
      Title: view.title,
    };
    if (view.scale !== undefined) fields.Scale = view.scale;
    if (view.storyId !== undefined) fields.StoryDomainId = view.storyId;
    if (view.folderId !== undefined) fields.FolderDomainId = view.folderId;
    if (view.direction !== undefined) fields.Direction = view.direction;
    if (view.sectionAxis !== undefined) fields.SectionAxis = view.sectionAxis;
    if (view.sectionOffset !== undefined) fields.SectionOffset = view.sectionOffset;
    if (view.sourceViewId !== undefined) fields.SourceViewDomainId = view.sourceViewId;
    if (view.region !== undefined) {
      fields.RegionX = view.region.x;
      fields.RegionY = view.region.y;
      fields.RegionW = view.region.w;
      fields.RegionH = view.region.h;
    }
    if (view.detailScale !== undefined) fields.DetailScale = view.detailScale;
    groups.push(recordOf(view.id, "docs.view", view.title, fields));
  }
  for (const layout of tables.layouts) {
    const setup = layout.pageSetup;
    const fields: Record<string, string | number | boolean> = {
      Name: layout.name,
      CreatedAt: layout.createdAt,
      Paper: setup.paperSize,
      WidthMm: setup.widthMm,
      HeightMm: setup.heightMm,
      Orientation: setup.orientation,
      MarginTop: setup.marginsMm.top,
      MarginRight: setup.marginsMm.right,
      MarginBottom: setup.marginsMm.bottom,
      MarginLeft: setup.marginsMm.left,
      PlotScale: setup.plotScale,
      PlotOriginX: setup.plotOriginMm[0],
      PlotOriginY: setup.plotOriginMm[1],
      CenterPlot: setup.centerPlot,
      PlotStyleKind: setup.plotStyleKind,
      PlotViewports: setup.plotViewports !== false,
    };
    if (setup.plotStyleTable !== null) fields.PlotStyleTable = setup.plotStyleTable;
    if (layout.subsetId !== undefined) fields.SubsetDomainId = layout.subsetId;
    if (layout.masterId !== undefined) fields.MasterDomainId = layout.masterId;
    if (layout.titleBlockPlacement !== undefined) {
      fields.TitleBlockDomainId = layout.titleBlockPlacement.titleBlockId;
      fields.TitleBlockX = layout.titleBlockPlacement.xMm;
      fields.TitleBlockY = layout.titleBlockPlacement.yMm;
    }
    if (layout.revisionIds !== undefined && layout.revisionIds.length > 0) {
      fields.RevisionDomainIds = joinComma(layout.revisionIds);
    }
    groups.push(recordOf(layout.id, "docs.layout", layout.name, fields));
  }
  for (const node of tables.navigatorNodes) {
    const fields: Record<string, string | number | boolean> = {
      Kind: node.kind,
      Name: node.name,
      Order: node.order,
    };
    if (node.parentId !== null) fields.ParentDomainId = node.parentId;
    if (node.prefix !== undefined) fields.Prefix = node.prefix;
    if (node.numbering !== undefined) fields.Numbering = node.numbering;
    if (node.customNumber !== undefined) fields.CustomNumber = node.customNumber;
    groups.push(recordOf(node.id, "docs.navigator", node.name, fields));
  }
  for (const block of tables.titleBlocks) {
    const fields: Record<string, string | number | boolean> = {
      Name: block.name,
      WidthMm: block.widthMm,
      HeightMm: block.heightMm,
      RowHeightMm: block.rowHeightMm,
      Rows: joinSemicolon(block.rows.map((row) => `${esc(row.label)}|${esc(row.field)}|${esc(row.value ?? "")}`)),
    };
    groups.push(recordOf(block.id, "docs.titleblock", block.name, fields));
  }
  for (const schedule of tables.schedules) {
    const fields: Record<string, string | number | boolean> = {
      Name: schedule.name,
      Source: schedule.source,
      ColumnKeys: joinComma(schedule.columns.map((c) => c.key)),
      ColumnLabels: joinPipe(schedule.columns.map((c) => c.label)),
    };
    if (schedule.filter !== undefined) {
      if (schedule.filter.type !== undefined) fields.FilterType = schedule.filter.type;
      if (schedule.filter.storyId !== undefined) fields.FilterStoryDomainId = schedule.filter.storyId;
    }
    groups.push(recordOf(schedule.id, "docs.schedule", schedule.name, fields));
  }
  for (const revision of tables.revisions) {
    const fields: Record<string, string | number | boolean> = {
      Code: revision.code,
      Description: revision.description,
      Issued: revision.issued,
      CreatedAt: revision.createdAt,
      LayoutDomainIds: joinComma(revision.layoutIds),
    };
    groups.push(recordOf(revision.id, "docs.revision", revision.code, fields));
  }
  for (const set of tables.publisherSets) {
    const fields: Record<string, string | number | boolean> = {
      Name: set.name,
      Items: joinPipe(set.items.map((item) => `${esc(item.kind)}:${esc(item.id)}:${esc(item.format)}`)),
    };
    groups.push(recordOf(set.id, "docs.publisher", set.name, fields));
  }
  return {
    groups,
    counts: {
      views: tables.views.length,
      layouts: tables.layouts.length,
      navigatorNodes: tables.navigatorNodes.length,
      titleBlocks: tables.titleBlocks.length,
      schedules: tables.schedules.length,
      revisions: tables.revisions.length,
      publisherSets: tables.publisherSets.length,
      sheetsNotExported,
    },
  };
}

function recordOf(
  id: string,
  kind: string,
  name: string,
  fields: Readonly<Record<string, string | number | boolean>>,
): IfcDocumentationRecord {
  return {
    guid: ifcGuidFor(id),
    name,
    identity: { DomainId: id, DomainKind: kind },
    fields,
  };
}

// --- Reconciliation (import / dry-run) -------------------------------------------

export interface IfcDocsTargetState {
  /** The target document's documentation tables (document order). */
  readonly views: readonly DocsViewRecord[];
  readonly layouts: readonly LayoutRecord[];
  readonly navigatorNodes: readonly NavigatorNodeRecord[];
  readonly titleBlocks: readonly TitleBlockRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly revisions: readonly RevisionRecord[];
  readonly publisherSets: readonly PublisherSetRecord[];
  /** Domain-id → canonical ELEMENT id resolution for the story linkage
   *  (the element import's preserved identities + the existing elements). */
  readonly elementIdByDomainId: ReadonlyMap<string, string>;
}

/** The target document's record-id mints (one per kind — the document
 *  authority). Absent = the DRY path: created records carry empty ids and
 *  the linkage resolves against placeholder DomainIds (nothing is written). */
export interface IfcDocsMint {
  readonly view: () => string;
  readonly layout: () => string;
  readonly navigatorNode: () => string;
  readonly titleBlock: () => string;
  readonly schedule: () => string;
  readonly revision: () => string;
  readonly publisherSet: () => string;
}

/** The reconstructed records for CREATION (fresh ids, links resolved). */
export interface IfcDocsRecordDrafts {
  readonly views: readonly DocsViewRecord[];
  readonly layouts: readonly LayoutRecord[];
  readonly navigatorNodes: readonly NavigatorNodeRecord[];
  readonly titleBlocks: readonly TitleBlockRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly revisions: readonly RevisionRecord[];
  readonly publisherSets: readonly PublisherSetRecord[];
}

export interface IfcDocsReport {
  readonly records: readonly IfcElementReport[];
  readonly summary: {
    readonly created: number;
    readonly reconciled: number;
    readonly unchanged: number;
    readonly unsupported: number;
    readonly exact: number;
    readonly tolerance: number;
    readonly lossy: number;
    readonly unsupportedFields: number;
  };
}

export interface IfcDocsReconcileOutcome {
  readonly drafts: IfcDocsRecordDrafts;
  readonly report: IfcDocsReport;
  /** Canonical JSON + SHA-256 content hash (determinism artifact). */
  readonly reportHash: string;
}

/** Canonical JSON + SHA-256 of a documentation report. */
export function ifcDocsReportHash(report: IfcDocsReport): string {
  return createHash("sha256").update(canonicalStringify(report)).digest("hex");
}

interface ParsedRecord {
  readonly raw: IfcParsedDocumentationRecord;
  readonly domainId: string;
  readonly kind: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const KNOWN_KINDS = new Set(["docs.view", "docs.layout", "docs.navigator", "docs.titleblock", "docs.schedule", "docs.revision", "docs.publisher"]);

function numField(fields: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = fields[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strField(fields: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function boolField(fields: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const v = fields[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Reconcile the parsed documentation IfcGroups against the target document
 *  state: records are CLASSIFIED per field (exact/tolerance/lossy/
 *  unsupported — the report.ts vocabulary) and reconstructed for creation
 *  with freshly minted ids + resolved linkage. Existing records are matched
 *  on identity (DomainId) and classified; record PATCHING of existing
 *  records is not part of this slice (the bounded decision — the
 *  classification reports the difference, the document authority stays the
 *  only writer). */
export function reconcileIfcDocumentation(
  parsed: IfcParsedDocumentation,
  existing: IfcDocsTargetState,
  mint: IfcDocsMint | null,
): IfcDocsReconcileOutcome {
  // --- pass 1: identity + existing match + mint map --------------------------
  interface Plan {
    readonly parsed: ParsedRecord;
    readonly existingId: string | null;
    readonly mintedId: string | null;
  }
  const plans: Plan[] = [];
  const idByDomainId = new Map<string, string>(); // DomainId → target id (existing or minted)
  for (const raw of parsed.records) {
    const identity = raw.identity;
    const domainId = typeof (identity as Record<string, unknown> | null)?.DomainId === "string"
      ? ((identity as Record<string, unknown>).DomainId as string)
      : "";
    const kind = typeof (identity as Record<string, unknown> | null)?.DomainKind === "string"
      ? ((identity as Record<string, unknown>).DomainKind as string)
      : "";
    const fields = raw.fields;
    const plan: ParsedRecord = { raw, domainId, kind, fields };
    let existingId: string | null = null;
    if (domainId.length > 0 && KNOWN_KINDS.has(kind)) {
      existingId = findExisting(existing, kind, domainId);
    }
    let mintedId: string | null = null;
    if (existingId === null && domainId.length > 0 && KNOWN_KINDS.has(kind) && mint !== null) {
      mintedId = mintOf(mint, kind);
      idByDomainId.set(domainId, mintedId);
    } else if (existingId !== null) {
      idByDomainId.set(domainId, existingId);
    }
    plans.push({ parsed: plan, existingId, mintedId });
  }

  // --- pass 2: classify + reconstruct -----------------------------------------
  // The link resolver: documentation record DomainIds resolve through the
  // mint/existing map; STORY DomainIds (view scopes, schedule filters)
  // resolve through the target document's ELEMENT map (stories are elements
  // — the two id spaces never overlap: vw-/lo-/nav-/tb-/sch-/rev-/pub-* vs
  // el-*, so the combined resolution is unambiguous).
  const link = (domainId: string | undefined, what: string): string | null => {
    if (domainId === undefined) return null;
    const resolved = idByDomainId.get(domainId) ?? existing.elementIdByDomainId.get(domainId);
    if (resolved === undefined) return null;
    return resolved;
  };
  const rows: IfcElementReport[] = [];
  const views: DocsViewRecord[] = [];
  const layouts: LayoutRecord[] = [];
  const navigatorNodes: NavigatorNodeRecord[] = [];
  const titleBlocks: TitleBlockRecord[] = [];
  const schedules: ScheduleRecord[] = [];
  const revisions: RevisionRecord[] = [];
  const publisherSets: PublisherSetRecord[] = [];

  for (const plan of plans) {
    const { parsed } = plan;
    const targetId = plan.existingId ?? plan.mintedId;
    const rowName = parsed.raw.name;
    if (parsed.domainId.length === 0 || !KNOWN_KINDS.has(parsed.kind)) {
      rows.push({
        canonicalId: null,
        globalId: parsed.raw.globalId,
        ifcClass: `IfcGroup(${parsed.kind || "unknown"})`,
        name: rowName,
        action: "unsupported",
        fields: [unsupportedField("identity", "the group carries no Offisos identity or an unknown DomainKind — outside the documentation exchange vocabulary")],
      });
      continue;
    }

    // --- the EXISTING match: field-level classification ----------------------
    if (plan.existingId !== null) {
      const expected = existingFieldsOf(existing, parsed.kind, plan.existingId);
      const fields = compareFields(expected, parsed.fields);
      const hasLoss = fields.some((f) => f.classification === "lossy" || f.classification === "unsupported");
      rows.push({
        canonicalId: plan.existingId,
        globalId: parsed.raw.globalId,
        ifcClass: `IfcGroup(${parsed.kind})`,
        name: rowName,
        action: hasLoss ? "reconciled" : "unchanged",
        fields,
      });
      continue;
    }

    // --- creation (fresh ids, resolved linkage) ------------------------------
    if (plan.mintedId === null) {
      // DRY path: no mint supplied — classify the carried fields exact
      // (parse evidence) and record the source identity as the row id.
      rows.push({
        canonicalId: parsed.domainId,
        globalId: parsed.raw.globalId,
        ifcClass: `IfcGroup(${parsed.kind})`,
        name: rowName,
        action: "created",
        fields: Object.keys(parsed.fields).sort().map((key) => exactField(key)),
      });
      continue;
    }
    try {
      switch (parsed.kind) {
        case "docs.view": {
          views.push(validateDocsViewRecord(decodeView(parsed, plan.mintedId ?? "", link)));
          break;
        }
        case "docs.layout": {
          layouts.push(validateLayoutRecord(decodeLayout(parsed, plan.mintedId ?? "", link)));
          break;
        }
        case "docs.navigator": {
          navigatorNodes.push(validateNavigatorNodeRecord(decodeNavigatorNode(parsed, plan.mintedId ?? "", link)));
          break;
        }
        case "docs.titleblock": {
          titleBlocks.push(validateTitleBlockRecord(decodeTitleBlock(parsed, plan.mintedId ?? "")));
          break;
        }
        case "docs.schedule": {
          schedules.push(validateScheduleRecord(decodeSchedule(parsed, plan.mintedId ?? "", link)));
          break;
        }
        case "docs.revision": {
          revisions.push(validateRevisionRecord(decodeRevision(parsed, plan.mintedId ?? "", link)));
          break;
        }
        case "docs.publisher": {
          publisherSets.push(validatePublisherSetRecord(decodePublisherSet(parsed, plan.mintedId ?? "", link)));
          break;
        }
        default:
          throw new Error("unknown documentation record kind");
      }
      rows.push({
        canonicalId: plan.mintedId,
        globalId: parsed.raw.globalId,
        ifcClass: `IfcGroup(${parsed.kind})`,
        name: rowName,
        action: "created",
        fields: Object.keys(parsed.fields).sort().map((key) => exactField(key)),
      });
    } catch (e) {
      rows.push({
        canonicalId: null,
        globalId: parsed.raw.globalId,
        ifcClass: `IfcGroup(${parsed.kind})`,
        name: rowName,
        action: "unsupported",
        fields: [unsupportedField("record", (e as Error).message)],
      });
    }
  }

  const report: IfcDocsReport = { records: rows, summary: summarizeReports(rows) };
  return {
    drafts: { views, layouts, navigatorNodes, titleBlocks, schedules, revisions, publisherSets },
    report,
    reportHash: ifcDocsReportHash(report),
  };
}

function mintOf(mint: IfcDocsMint, kind: string): string {
  switch (kind) {
    case "docs.view": return mint.view();
    case "docs.layout": return mint.layout();
    case "docs.navigator": return mint.navigatorNode();
    case "docs.titleblock": return mint.titleBlock();
    case "docs.schedule": return mint.schedule();
    case "docs.revision": return mint.revision();
    case "docs.publisher": return mint.publisherSet();
    default: return "";
  }
}

function findExisting(existing: IfcDocsTargetState, kind: string, domainId: string): string | null {
  switch (kind) {
    case "docs.view": return existing.views.find((r) => r.id === domainId)?.id ?? null;
    case "docs.layout": return existing.layouts.find((r) => r.id === domainId)?.id ?? null;
    case "docs.navigator": return existing.navigatorNodes.find((r) => r.id === domainId)?.id ?? null;
    case "docs.titleblock": return existing.titleBlocks.find((r) => r.id === domainId)?.id ?? null;
    case "docs.schedule": return existing.schedules.find((r) => r.id === domainId)?.id ?? null;
    case "docs.revision": return existing.revisions.find((r) => r.id === domainId)?.id ?? null;
    case "docs.publisher": return existing.publisherSets.find((r) => r.id === domainId)?.id ?? null;
    default: return null;
  }
}

/** The re-encoded field set of an EXISTING record (the comparison's expected
 *  side — the SAME encoding the export used). */
function existingFieldsOf(existing: IfcDocsTargetState, kind: string, id: string): Record<string, string | number | boolean> {
  const views = existing.views.filter((v) => v.id === id);
  const layouts = existing.layouts.filter((l) => l.id === id);
  const nodes = existing.navigatorNodes.filter((n) => n.id === id);
  const blocks = existing.titleBlocks.filter((b) => b.id === id);
  const schedules = existing.schedules.filter((s) => s.id === id);
  const revisions = existing.revisions.filter((r) => r.id === id);
  const sets = existing.publisherSets.filter((p) => p.id === id);
  const tables: IfcDocumentationTables = {
    views: kind === "docs.view" ? views : [],
    layouts: kind === "docs.layout" ? layouts : [],
    navigatorNodes: kind === "docs.navigator" ? nodes : [],
    titleBlocks: kind === "docs.titleblock" ? blocks : [],
    schedules: kind === "docs.schedule" ? schedules : [],
    revisions: kind === "docs.revision" ? revisions : [],
    publisherSets: kind === "docs.publisher" ? sets : [],
  };
  const exportOutcome = buildIfcDocumentationExport(tables, 0);
  const group = exportOutcome.groups[0];
  return group !== undefined ? { ...group.fields } : {};
}

/** Field-level comparison of the expected (re-encoded existing record)
 *  against the parsed pset values. */
function compareFields(
  expected: Readonly<Record<string, string | number | boolean>>,
  actual: Readonly<Record<string, unknown>>,
): IfcFieldResult[] {
  const fields: IfcFieldResult[] = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (expectedValue === undefined) {
      fields.push({ field: key, classification: "lossy", actual: actualValue as string | number | boolean, note: "field added by the source" });
      continue;
    }
    if (actualValue === undefined) {
      fields.push({ field: key, classification: "lossy", expected: expectedValue, note: "field absent in the source" });
      continue;
    }
    if (typeof expectedValue === "number" && typeof actualValue === "number") {
      fields.push(classifyNumber(key, expectedValue, actualValue));
      continue;
    }
    fields.push(classifyValue(key, expectedValue, actualValue));
  }
  return fields;
}

// --- Per-kind decoders (strict: every failure is a typed unsupported row) ----

function decodeView(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): DocsViewRecord {
  const fields = parsed.fields;
  const kind = strField(fields, "Kind");
  const title = strField(fields, "Title");
  if (kind === undefined || !(["plan", "elevation", "section", "detail"] as const).some((k) => k === kind)) {
    throw new Error(`view '${parsed.domainId}': Kind must be one of plan|elevation|section|detail`);
  }
  if (title === undefined) {
    throw new Error(`view '${parsed.domainId}': Title is required`);
  }
  const storyDomainId = strField(fields, "StoryDomainId");
  const storyId = storyDomainId !== undefined ? link(storyDomainId, "story") : undefined;
  if (storyDomainId !== undefined && storyId === null) {
    throw new Error(`view '${parsed.domainId}': StoryDomainId '${storyDomainId}' does not resolve to a story element in the target document`);
  }
  const folderDomainId = strField(fields, "FolderDomainId");
  const folderId = folderDomainId !== undefined ? link(folderDomainId, "folder") : undefined;
  if (folderDomainId !== undefined && folderId === null) {
    throw new Error(`view '${parsed.domainId}': FolderDomainId '${folderDomainId}' does not resolve to a navigator node`);
  }
  const sourceDomainId = strField(fields, "SourceViewDomainId");
  const sourceViewId = sourceDomainId !== undefined ? link(sourceDomainId, "source view") : undefined;
  if (sourceDomainId !== undefined && sourceViewId === null) {
    throw new Error(`view '${parsed.domainId}': SourceViewDomainId '${sourceDomainId}' does not resolve to a view`);
  }
  const regionX = numField(fields, "RegionX");
  const regionY = numField(fields, "RegionY");
  const regionW = numField(fields, "RegionW");
  const regionH = numField(fields, "RegionH");
  const direction = strField(fields, "Direction");
  const sectionAxis = strField(fields, "SectionAxis");
  const sectionOffset = numField(fields, "SectionOffset");
  const detailScale = numField(fields, "DetailScale");
  const scale = numField(fields, "Scale");
  const record: DocsViewRecord = {
    id,
    kind: kind as DocsViewRecord["kind"],
    title,
    ...(storyId !== null && storyId !== undefined ? { storyId } : {}),
    ...(folderId !== null && folderId !== undefined ? { folderId } : {}),
    ...(direction !== undefined ? { direction: direction as NonNullable<DocsViewRecord["direction"]> } : {}),
    ...(sectionAxis !== undefined ? { sectionAxis: sectionAxis as NonNullable<DocsViewRecord["sectionAxis"]> } : {}),
    ...(sectionOffset !== undefined ? { sectionOffset } : {}),
    ...(sourceViewId !== null && sourceViewId !== undefined ? { sourceViewId } : {}),
    ...(regionX !== undefined && regionY !== undefined && regionW !== undefined && regionH !== undefined
      ? { region: { x: regionX, y: regionY, w: regionW, h: regionH } }
      : {}),
    ...(detailScale !== undefined ? { detailScale } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
  return record;
}

function decodeLayout(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): LayoutRecord {
  const fields = parsed.fields;
  const name = strField(fields, "Name");
  const createdAt = strField(fields, "CreatedAt");
  const paper = strField(fields, "Paper");
  const widthMm = numField(fields, "WidthMm");
  const heightMm = numField(fields, "HeightMm");
  const orientation = strField(fields, "Orientation");
  if (
    name === undefined || createdAt === undefined || paper === undefined ||
    widthMm === undefined || heightMm === undefined ||
    (orientation !== "portrait" && orientation !== "landscape")
  ) {
    throw new Error(`layout '${parsed.domainId}': the page-setup fields (Name/CreatedAt/Paper/WidthMm/HeightMm/Orientation) are required`);
  }
  const subsetDomainId = strField(fields, "SubsetDomainId");
  const subsetId = subsetDomainId !== undefined ? link(subsetDomainId, "subset") : undefined;
  if (subsetDomainId !== undefined && subsetId === null) {
    throw new Error(`layout '${parsed.domainId}': SubsetDomainId '${subsetDomainId}' does not resolve to a navigator subset node`);
  }
  const masterDomainId = strField(fields, "MasterDomainId");
  const masterId = masterDomainId !== undefined ? link(masterDomainId, "master layout") : undefined;
  if (masterDomainId !== undefined && masterId === null) {
    throw new Error(`layout '${parsed.domainId}': MasterDomainId '${masterDomainId}' does not resolve to a layout`);
  }
  const titleBlockDomainId = strField(fields, "TitleBlockDomainId");
  const titleBlockId = titleBlockDomainId !== undefined ? link(titleBlockDomainId, "title block") : undefined;
  if (titleBlockDomainId !== undefined && titleBlockId === null) {
    throw new Error(`layout '${parsed.domainId}': TitleBlockDomainId '${titleBlockDomainId}' does not resolve to a title block`);
  }
  const tbX = numField(fields, "TitleBlockX");
  const tbY = numField(fields, "TitleBlockY");
  // Comma-joined id list — the EMPTY string decodes as the empty list (a
  // layout may reference no revisions; the field key is still required).
  // Every revision id RESOLVES through the mint/existing map (the draft
  // carries the TARGET ids — never the foreign DomainIds).
  const revisionIdsRaw = fields.RevisionDomainIds;
  let revisionIds: string[] | undefined;
  if (typeof revisionIdsRaw === "string") {
    revisionIds = revisionIdsRaw.length === 0 ? [] : splitEsc(revisionIdsRaw, ",").map((rev) => {
      const resolved = link(rev, "revision");
      if (resolved === null) {
        throw new Error(`layout '${parsed.domainId}': revision '${rev}' does not resolve in the target document`);
      }
      return resolved;
    });
  }
  const marginTop = numField(fields, "MarginTop");
  const marginRight = numField(fields, "MarginRight");
  const marginBottom = numField(fields, "MarginBottom");
  const marginLeft = numField(fields, "MarginLeft");
  const plotOriginX = numField(fields, "PlotOriginX");
  const plotOriginY = numField(fields, "PlotOriginY");
  const plotScale = strField(fields, "PlotScale");
  if (
    marginTop === undefined || marginRight === undefined || marginBottom === undefined || marginLeft === undefined ||
    plotOriginX === undefined || plotOriginY === undefined || plotScale === undefined
  ) {
    throw new Error(`layout '${parsed.domainId}': the page-setup margin/origin/scale fields are required`);
  }
  const record: LayoutRecord = {
    id,
    name,
    createdAt,
    pageSetup: {
      paperSize: paper as LayoutRecord["pageSetup"]["paperSize"],
      widthMm,
      heightMm,
      orientation: orientation as "portrait" | "landscape",
      marginsMm: { top: marginTop, right: marginRight, bottom: marginBottom, left: marginLeft },
      plotScale,
      plotOriginMm: [plotOriginX, plotOriginY],
      centerPlot: boolField(fields, "CenterPlot") === true,
      plotStyleTable: strField(fields, "PlotStyleTable") ?? null,
      plotStyleKind: (strField(fields, "PlotStyleKind") ?? "none") as LayoutRecord["pageSetup"]["plotStyleKind"],
      plotViewports: boolField(fields, "PlotViewports") !== false,
    },
    ...(subsetId !== null && subsetId !== undefined ? { subsetId } : {}),
    ...(masterId !== null && masterId !== undefined ? { masterId } : {}),
    ...(titleBlockId !== null && titleBlockId !== undefined && tbX !== undefined && tbY !== undefined
      ? { titleBlockPlacement: { titleBlockId, xMm: tbX, yMm: tbY } }
      : {}),
    ...(revisionIds !== undefined && revisionIds.length > 0 ? { revisionIds } : {}),
  };
  return record;
}

function decodeNavigatorNode(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): NavigatorNodeRecord {
  const fields = parsed.fields;
  const kind = strField(fields, "Kind");
  const name = strField(fields, "Name");
  const order = numField(fields, "Order");
  if ((kind !== "folder" && kind !== "subset") || name === undefined || order === undefined || !Number.isInteger(order)) {
    throw new Error(`navigator node '${parsed.domainId}': Kind (folder|subset), Name and integer Order are required`);
  }
  const parentDomainId = strField(fields, "ParentDomainId");
  const parentId = parentDomainId !== undefined ? link(parentDomainId, "parent node") : null;
  if (parentDomainId !== undefined && parentId === null) {
    throw new Error(`navigator node '${parsed.domainId}': ParentDomainId '${parentDomainId}' does not resolve to a navigator node`);
  }
  const prefix = strField(fields, "Prefix");
  const numbering = strField(fields, "Numbering");
  const customNumber = strField(fields, "CustomNumber");
  const record: NavigatorNodeRecord = {
    id,
    kind: kind as "folder" | "subset",
    name,
    parentId,
    order,
    ...(prefix !== undefined ? { prefix } : {}),
    ...(numbering !== undefined ? { numbering: numbering as "none" | "custom" } : {}),
    ...(customNumber !== undefined ? { customNumber } : {}),
  };
  return record;
}

function decodeTitleBlock(parsed: ParsedRecord, id: string): TitleBlockRecord {
  const fields = parsed.fields;
  const name = strField(fields, "Name");
  const widthMm = numField(fields, "WidthMm");
  const heightMm = numField(fields, "HeightMm");
  const rowHeightMm = numField(fields, "RowHeightMm");
  const rowsRaw = strField(fields, "Rows");
  if (name === undefined || widthMm === undefined || heightMm === undefined || rowHeightMm === undefined || rowsRaw === undefined) {
    throw new Error(`title block '${parsed.domainId}': Name/WidthMm/HeightMm/RowHeightMm/Rows are required`);
  }
  const rows = splitEsc(rowsRaw, ";").map((rowRaw) => {
    const parts = splitEsc(rowRaw, "|");
    if (parts.length !== 3) {
      throw new Error(`title block '${parsed.domainId}': a row must encode as 'label|field|value'`);
    }
    const [label, field, value] = parts as [string, string, string];
    if (!(["layoutName", "sheetNumber", "revisions", "text"] as const).some((f) => f === field)) {
      throw new Error(`title block '${parsed.domainId}': row field '${field}' is outside the vocabulary`);
    }
    return {
      label,
      field: field as TitleBlockRecord["rows"][number]["field"],
      ...(value.length > 0 ? { value } : {}),
    };
  });
  return { id, name, widthMm, heightMm, rowHeightMm, rows };
}

function decodeSchedule(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): ScheduleRecord {
  const fields = parsed.fields;
  const name = strField(fields, "Name");
  const source = strField(fields, "Source");
  const keysRaw = strField(fields, "ColumnKeys");
  const labelsRaw = strField(fields, "ColumnLabels");
  if (name === undefined || source === undefined || keysRaw === undefined || labelsRaw === undefined) {
    throw new Error(`schedule '${parsed.domainId}': Name/Source/ColumnKeys/ColumnLabels are required`);
  }
  const keys = splitEsc(keysRaw, ",");
  const labels = splitEsc(labelsRaw, "|");
  if (keys.length !== labels.length || keys.length === 0) {
    throw new Error(`schedule '${parsed.domainId}': ColumnKeys and ColumnLabels must encode the same non-empty column set`);
  }
  const filterType = strField(fields, "FilterType");
  const filterStoryDomainId = strField(fields, "FilterStoryDomainId");
  const filterStoryId = filterStoryDomainId !== undefined ? link(filterStoryDomainId, "filter story") : undefined;
  if (filterStoryDomainId !== undefined && filterStoryId === null) {
    throw new Error(`schedule '${parsed.domainId}': FilterStoryDomainId '${filterStoryDomainId}' does not resolve to a story element`);
  }
  const record: ScheduleRecord = {
    id,
    name,
    source: source as ScheduleRecord["source"],
    ...(filterType !== undefined || filterStoryId !== undefined
      ? {
          filter: {
            ...(filterType !== undefined ? { type: filterType } : {}),
            ...(filterStoryId !== null && filterStoryId !== undefined ? { storyId: filterStoryId } : {}),
          },
        }
      : {}),
    columns: keys.map((key, i) => ({ key, label: labels[i]! })),
  };
  return record;
}

function decodeRevision(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): RevisionRecord {
  const fields = parsed.fields;
  const code = strField(fields, "Code");
  const description = strField(fields, "Description");
  const issued = boolField(fields, "Issued");
  const createdAt = strField(fields, "CreatedAt");
  // Comma-joined id list — the EMPTY string decodes as the empty list (a
  // revision may reference no layouts; the field key is still required).
  const layoutIdsRaw = fields.LayoutDomainIds;
  if (code === undefined || description === undefined || issued === undefined || createdAt === undefined || typeof layoutIdsRaw !== "string") {
    throw new Error(`revision '${parsed.domainId}': Code/Description/Issued/CreatedAt/LayoutDomainIds are required`);
  }
  const layoutIds = layoutIdsRaw.length === 0 ? [] : splitEsc(layoutIdsRaw, ",").map((layoutId) => {
    // The layout reference RESOLVES through the mint/existing map (the
    // draft carries the TARGET ids — never the foreign DomainIds).
    const resolved = link(layoutId, "layout");
    if (resolved === null) {
      throw new Error(`revision '${parsed.domainId}': layout '${layoutId}' does not resolve in the target document`);
    }
    return resolved;
  });
  return { id, code, description, issued, createdAt, layoutIds };
}

function decodePublisherSet(parsed: ParsedRecord, id: string, link: (domainId: string | undefined, what: string) => string | null): PublisherSetRecord {
  const fields = parsed.fields;
  const name = strField(fields, "Name");
  const itemsRaw = strField(fields, "Items");
  if (name === undefined || itemsRaw === undefined) {
    throw new Error(`publisher set '${parsed.domainId}': Name and Items are required`);
  }
  const items = splitEsc(itemsRaw, "|").map((itemRaw): PublisherSetRecord["items"][number] => {
    const parts = splitEsc(itemRaw, ":");
    if (parts.length !== 3) {
      throw new Error(`publisher set '${parsed.domainId}': an item must encode as 'kind:id:format'`);
    }
    const [kind, itemId, format] = parts as [string, string, string];
    if ((kind !== "layout" && kind !== "subset") || (format !== "pdf" && format !== "svg" && format !== "plot-ir")) {
      throw new Error(`publisher set '${parsed.domainId}': item kind/format outside the vocabulary`);
    }
    // The item target RESOLVES through the mint/existing map — the draft
    // carries the TARGET id (the minted or existing record), never the
    // foreign DomainId (which may collide with a differently-minted id).
    const target = link(itemId, "publisher target");
    if (target === null) {
      throw new Error(`publisher set '${parsed.domainId}': item '${itemId}' does not resolve in the target document`);
    }
    return { kind, id: target, format };
  });
  if (items.length === 0) {
    throw new Error(`publisher set '${parsed.domainId}': Items must encode at least one item`);
  }
  return { id, name, items };
}
