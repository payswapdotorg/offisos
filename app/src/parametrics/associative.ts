/**
 * COMPAT-CAD-004 (Issue #121) — the consolidated associative surface:
 * the typed associative REPORT (annotations, symbol relationships, xrefs,
 * raster references, docs annotations — computed fresh from the canonical
 * elements/records, never stored) and the one-revision atomic REFRESH
 * composition (annotation re-measurement + documentation regeneration in
 * ONE `doc.execute(applyEdits)` revision).
 *
 * Honesty contract (AC: "report typed dangling/reference-loss outcomes
 * without silent re-targeting"): every row's outcome is DERIVED from the
 * current canonical state; the refresh reuses the VERIFIED semantics —
 * a dead annotation reference DISASSOCIATES (the ref is removed from the
 * stored refs, the canonical no-references form when none survive; the
 * last-known measured value survives; the echo says so), a dead docs
 * reference is MARKED dangling with an explicit reason — neither layer
 * ever re-targets, and this module adds no third semantics: it reports
 * and composes, never fabricates.
 *
 * Row ordering is deterministic: the fixed kind order (annotation, symbol,
 * xref, raster, docs) with id-sorted rows within each kind — repeated
 * calls over identical canonical inputs yield byte-identical reports.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import { createHash } from "node:crypto";
import type {
  BlockDefinitionRecord,
  Element,
  XrefRecord,
} from "../contracts/caddocument.js";
import type {
  AssocRefreshView,
  AssocReportView,
  AssocRow,
} from "../contracts/parametrics.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { annotationViewsOf, remeasureCascade } from "../workspace/annotation/assoc.js";
import type { Annotation } from "../workspace/annotation/types.js";
import { annotationFromElement } from "../workspace/annotation/types.js";
import {
  blockRefFromElement,
  xrefRefFromElement,
} from "../workspace/blocks/types.js";
import { isDocsAnnotationType } from "../docs/entities.js";
import type { RasterReferenceData, RasterSourceData } from "../contracts/toolsets.js";
import { referenceStatus } from "../toolsets/raster.js";
import { regenerateDocumentation } from "../docs/regenerate.js";
import type { DocsSheetRecord, DocsViewRecord, DocumentEdit } from "../contracts/caddocument.js";
import { ParametricsError } from "./errors.js";

// ---------------------------------------------------------------------------
// The canonical world the report derives from (pure inputs, no host reads).
// ---------------------------------------------------------------------------

export interface AssocWorld {
  readonly elements: readonly Element[];
  readonly blockDefById: (id: string) => BlockDefinitionRecord | undefined;
  readonly xrefById: (id: string) => XrefRecord | undefined;
  /** The raster.source records (id-sorted by the caller's table order —
   *  the P018 table is id-sorted already). */
  readonly rasterSources: readonly { data: RasterSourceData }[];
  /** The raster.reference records. */
  readonly rasterReferences: readonly { id: string; data: RasterReferenceData }[];
  /** The documentation view ids (the docs view table). */
  readonly docsViewIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// The consolidated report.
// ---------------------------------------------------------------------------

const KIND_ORDER: readonly AssocRow["kind"][] = ["annotation", "symbol", "xref", "raster", "docs"];

function refIdsOfAnnotation(a: Annotation): readonly string[] {
  switch (a.type) {
    case "dim-linear":
    case "dim-angular":
      return (a.refs ?? []).map((r) => r.id);
    case "dim-radius":
    case "dim-diameter":
      return a.target === null ? [] : [a.target];
    default:
      return [];
  }
}

function annotationRows(elements: readonly Element[]): AssocRow[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const out: AssocRow[] = [];
  for (const { id, annotation } of annotationViewsOf(elements)) {
    const targets = refIdsOfAnnotation(annotation);
    if (targets.length === 0) {
      // The canonical no-references form (a disassociated dimension keeps
      // its last-known state): the row reports the honest state, not an
      // error — the association simply no longer exists.
      out.push({
        kind: "annotation",
        id,
        outcome: "ok",
        reason: "no references (the disassociated last-known-value form)",
        targets: [],
      });
      continue;
    }
    const dead = targets.filter((t) => !byId.has(t));
    if (dead.length === 0) {
      out.push({
        kind: "annotation",
        id,
        outcome: "ok",
        reason: `${targets.length} live reference${targets.length === 1 ? "" : "s"}`,
        targets: [...new Set(targets)].sort(),
      });
      continue;
    }
    out.push({
      kind: "annotation",
      id,
      outcome: "dangling",
      code: "annotation_reference_missing",
      reason: `reference${dead.length === 1 ? "" : "s"} '${dead.sort().join("', '")}' ${dead.length === 1 ? "does" : "do"} not exist (the dimension disassociates at its last known value — never a silent re-target)`,
      targets: [...targets].sort(),
    });
  }
  return out;
}

function symbolRows(
  elements: readonly Element[],
  world: AssocWorld,
): AssocRow[] {
  const out: AssocRow[] = [];
  for (const el of elements) {
    const ref = blockRefFromElement(el);
    if (ref === null) continue;
    const def = world.blockDefById(ref.blockId);
    if (def === undefined) {
      // Unreachable through the command surface (block.remove is
      // reference-checked); classified honestly anyway.
      out.push({
        kind: "symbol",
        id: el.id,
        outcome: "dangling",
        code: "symbol_definition_missing",
        reason: `block definition '${ref.blockId}' does not exist (the removal gate makes this unreachable through edits; hand-built worlds are the honest exception)`,
        targets: [ref.blockId],
      });
      continue;
    }
    out.push({
      kind: "symbol",
      id: el.id,
      outcome: "ok",
      reason: `instance of definition '${ref.blockId}' (${def.entities.length} content entit${def.entities.length === 1 ? "y" : "ies"}, ${ref.mirrored === true ? "mirrored" : "unreflected"} placement)`,
      targets: [ref.blockId],
    });
  }
  return out;
}

function xrefRows(elements: readonly Element[], world: AssocWorld): AssocRow[] {
  const out: AssocRow[] = [];
  for (const el of elements) {
    const ref = xrefRefFromElement(el);
    if (ref === null) continue;
    const record = world.xrefById(ref.xrefId);
    if (record === undefined) {
      out.push({
        kind: "xref",
        id: el.id,
        outcome: "dangling",
        code: "xref_record_missing",
        reason: `external reference record '${ref.xrefId}' does not exist (the detach gate makes this unreachable through edits)`,
        targets: [ref.xrefId],
      });
      continue;
    }
    if (record.status === "loaded") {
      out.push({
        kind: "xref",
        id: el.id,
        outcome: "ok",
        reason: `loaded reference '${record.name}' (source hash ${record.sourceHash ?? "null"})`,
        targets: [ref.xrefId],
      });
      continue;
    }
    out.push({
      kind: "xref",
      id: el.id,
      outcome: "dangling",
      code: "xref_unresolved",
      reason: `reference '${record.name}' is unresolved (the canonical placeholder renders — the honest diagnostic, never a silent blank)`,
      targets: [ref.xrefId],
    });
  }
  return out;
}

function rasterRows(world: AssocWorld): AssocRow[] {
  const out: AssocRow[] = [];
  for (const reference of world.rasterReferences) {
    const status = referenceStatus(reference, world.rasterSources);
    if (status.status === "ok") {
      out.push({ kind: "raster", id: reference.id, outcome: "ok", reason: status.reason, targets: [reference.data.sourceRef] });
    } else if (status.status === "stale") {
      out.push({ kind: "raster", id: reference.id, outcome: "stale", code: "raster_reference_stale", reason: status.reason, targets: [reference.data.sourceRef] });
    } else {
      out.push({ kind: "raster", id: reference.id, outcome: "missing", code: "raster_reference_missing", reason: status.reason, targets: [reference.data.sourceRef] });
    }
  }
  return out;
}

function docsRows(elements: readonly Element[], world: AssocWorld): AssocRow[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const out: AssocRow[] = [];
  for (const el of elements) {
    if (el.kind !== "annotation") continue;
    const p = el.props as Record<string, unknown>;
    if (!isDocsAnnotationType(p.type)) continue;
    const type = p.type as string;
    if (type === "docs.note") {
      out.push({ kind: "docs", id: el.id, outcome: "ok", reason: "a free note (no model reference)", targets: [] });
      continue;
    }
    const viewId = typeof p.viewId === "string" ? p.viewId : "";
    const targets =
      type === "docs.dim" && Array.isArray(p.refIds)
        ? (p.refIds as unknown[]).filter((v): v is string => typeof v === "string")
        : type === "docs.tag" && typeof p.targetId === "string"
          ? [p.targetId]
          : [];
    const storedDangling = p.dangling === true;
    const storedReason = typeof p.reason === "string" ? p.reason : "";
    if (!world.docsViewIds.has(viewId)) {
      out.push({
        kind: "docs",
        id: el.id,
        outcome: "source_loss",
        code: "docs_view_missing",
        reason: `the view '${viewId}' does not exist${storedReason.length > 0 ? ` (stored reason: ${storedReason})` : ""}`,
        targets: viewId.length > 0 ? [viewId] : [],
      });
      continue;
    }
    const dead = targets.filter((t) => !byId.has(t));
    if (dead.length > 0) {
      out.push({
        kind: "docs",
        id: el.id,
        outcome: "dangling",
        code: "docs_target_missing",
        reason: `reference${dead.length === 1 ? "" : "s"} '${dead.sort().join("', '")}' ${dead.length === 1 ? "does" : "do"} not exist${storedDangling ? ` (marked dangling at the last regeneration: ${storedReason})` : " (never re-targeted — the regeneration marks it dangling)"}`,
        targets: [...targets].sort(),
      });
      continue;
    }
    if (storedDangling) {
      out.push({
        kind: "docs",
        id: el.id,
        outcome: "dangling",
        code: "docs_target_missing",
        reason: `marked dangling at the last regeneration (${storedReason}) — assoc.refresh re-evaluates honestly`,
        targets: [...targets].sort(),
      });
      continue;
    }
    out.push({
      kind: "docs",
      id: el.id,
      outcome: "ok",
      reason: `regenerates from ${targets.length} live target${targets.length === 1 ? "" : "s"} in view '${viewId}'`,
      targets: [...targets].sort(),
    });
  }
  return out;
}

/** The consolidated typed associative report (deterministic ordering +
 *  digest; computed fresh — the report IS the derivation). */
export function assocReport(world: AssocWorld): AssocReportView {
  const rows: AssocRow[] = [];
  for (const kind of KIND_ORDER) {
    let group: AssocRow[];
    switch (kind) {
      case "annotation":
        group = annotationRows(world.elements);
        break;
      case "symbol":
        group = symbolRows(world.elements, world);
        break;
      case "xref":
        group = xrefRows(world.elements, world);
        break;
      case "raster":
        group = rasterRows(world);
        break;
      case "docs":
        group = docsRows(world.elements, world);
        break;
    }
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    rows.push(...group);
  }
  const ok = rows.filter((r) => r.outcome === "ok").length;
  const report = {
    rows,
    counts: { total: rows.length, ok, notOk: rows.length - ok },
    reportSha256: createHash("sha256").update(canonicalStringify(rows)).digest("hex"),
  };
  return report;
}

// ---------------------------------------------------------------------------
// The one-revision atomic refresh composition.
// ---------------------------------------------------------------------------

export interface AssocRefreshOutcome {
  /** The atomic edit batch (annotation remeasure + docs regeneration —
   *  ONE revision when non-empty). */
  readonly edits: readonly DocumentEdit[];
  readonly notes: readonly string[];
  readonly docs: {
    readonly updated: number;
    readonly dangling: number;
    readonly sourceLoss: number;
  };
  readonly summary: string;
}

/** Compose the atomic refresh (pure: derives the batch; the caller executes
 *  it through doc.execute — one revision, one undo entry). */
export function composeAssocRefresh(
  world: AssocWorld,
  views: readonly DocsViewRecord[],
  sheets: readonly DocsSheetRecord[],
  modelVersionId: string,
): AssocRefreshOutcome {
  const annotations = annotationViewsOf(world.elements);
  const cascade = remeasureCascade(annotations, world.elements);
  const report = regenerateDocumentation(views, sheets, world.elements, modelVersionId);
  const docEdits: DocumentEdit[] = report.updates.map((u) => ({ type: "setProps", elementId: u.elementId, patch: u.props }));
  const edits: DocumentEdit[] = [...cascade.edits, ...docEdits];
  let dangling = 0;
  let sourceLoss = 0;
  for (const a of report.annotations) {
    if (a.outcome === "dangling") dangling++;
    else if (a.outcome === "source_loss") sourceLoss++;
  }
  const summary =
    edits.length === 0
      ? "all associations current — no revision"
      : `${cascade.edits.length} annotation re-measurement${cascade.edits.length === 1 ? "" : "s"} + ${docEdits.length} documentation update${docEdits.length === 1 ? "" : "s"} in ONE atomic revision`;
  return {
    edits,
    notes: cascade.notes,
    docs: { updated: report.updates.length, dangling, sourceLoss },
    summary,
  };
}

/** Guard: the refresh view builder (the App API handler maps this; the
 *  ParametricsError is the typed-decline channel). */
export function assocRefreshViewOf(
  outcome: AssocRefreshOutcome,
  world: AssocWorld,
): AssocRefreshView {
  if (outcome.edits.length > 0 && outcome.notes.length === 0 && outcome.docs.updated === 0) {
    throw new ParametricsError("refresh composed edits without any typed outcome", "parametrics_bad_payload");
  }
  return {
    applied: outcome.edits.length > 0,
    summary: outcome.summary,
    notes: outcome.notes,
    docs: outcome.docs,
    report: assocReport(world),
  };
}
