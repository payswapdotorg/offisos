/**
 * Deterministic documentation regeneration (COMPAT-CAD-003, Issue #41:
 * "Deterministic Regeneration" + "Dimensions / Tags / Annotations").
 *
 * Regeneration is a PURE derivation over the CURRENT document state:
 *  - every view's projection is recomputed (never read from storage —
 *    projected primitives are derived state by design) and canonicalized
 *    into a content hash (same inputs → same hash on every host);
 *  - every documentation annotation's derived values are recomputed:
 *    docs.dim `measured` (from the two references' projected extents in the
 *    annotation's view) and docs.tag `label` (from the target's canonical
 *    properties). Notes are authored content — never touched.
 *
 * The command layer applies the recomputed annotation values through ONE
 * atomic versioned batch (immutable, replayable documentation revisions).
 * When nothing changed no revision is recorded (regeneration state is
 * derived; identical inputs producing identical output is the determinism
 * proof — recorded in the report, not in a no-op revision).
 *
 * Dangling references (deleted elements, unprojectable targets, views whose
 * story vanished) are REPORTED explicitly and marked on the annotation —
 * never silently re-targeted or dropped (LOCK-007).
 *
 * Pure + engine-free (LOCK-018).
 */

import { createHash } from "node:crypto";
import type { DocsSheetRecord, DocsViewRecord, Element } from "../contracts/caddocument.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { elementToBimEntityOrNull } from "../bim/index.js";
import type { BimEntity } from "../bim/elements.js";
import {
  elementToDocsAnnotationOrNull,
  type DocsDimAxis,
  type DocsDimMode,
  type DocsDimProps,
  type DocsTagProps,
} from "./entities.js";
import { projectDetail, projectView, type ViewProjection } from "./project.js";

/** Canonical content hash of a view's projected primitives (determinism
 *  anchor: identical view definition + identical model → identical hash). */
export function viewContentHash(projection: ViewProjection): string {
  const payload = {
    viewId: projection.viewId,
    primitives: projection.primitives,
    // Skips are part of the honest projection result (they change when the
    // model changes which elements are in scope) — include them.
    skips: projection.skips,
  };
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

/** Per-view regeneration outcome. */
export interface ViewReport {
  readonly viewId: string;
  readonly kind: string;
  readonly title: string;
  readonly contentHash: string | null;
  readonly primitiveCount: number;
  readonly skipCount: number;
  /** Set when the view's projection failed (e.g. its story was deleted). */
  readonly error: string | null;
}

/** Per-annotation regeneration outcome. */
export interface AnnotationReport {
  readonly id: string;
  readonly type: string;
  readonly viewId: string;
  readonly updated: boolean;
  readonly dangling: boolean;
  readonly reason: string | null;
  readonly measured: number | null;
  readonly label: string | null;
  /** CAD-PARITY-013 (additive, Issue #104): the TYPED associative-documentation
   *  outcome. "ok" = every reference resolved; "dangling" = a target element
   *  reference is gone; "source_loss" = the annotation's view (or a detail's
   *  source view) is missing/unprojectable — defensive vocabulary: the
   *  removal gates make it unreachable through the command surface, but the
   *  report classifies honestly anyway. Always present ("ok" for healthy
   *  annotations); older consumers ignore it. */
  readonly outcome?: DocsAnnotationOutcome;
  /** CAD-PARITY-013 (additive): the typed failure code, present iff outcome
   *  is not "ok". */
  readonly code?: DocsAnnotationFailureCode;
}

/** The typed associative-documentation outcome vocabulary (CAD-PARITY-013). */
export type DocsAnnotationOutcome = "ok" | "dangling" | "source_loss";

/** The typed associative-documentation failure codes (CAD-PARITY-013). */
export type DocsAnnotationFailureCode =
  | "docs_target_missing"
  | "docs_view_missing"
  | "docs_source_view_missing";

/** The full regeneration report (deterministic for a document state). */
export interface RegenerationReport {
  readonly views: readonly ViewReport[];
  readonly annotations: readonly AnnotationReport[];
  /** FULL replacement props for annotations whose derived values changed —
   *  the caller applies them as ONE atomic setProps batch (setProps inverses
   *  are exact full-record restores: key additions AND removals — e.g.
   *  clearing a stale `reason` — replay correctly, unlike partial patches). */
  readonly updates: readonly { readonly elementId: string; readonly props: Readonly<Record<string, unknown>> }[];
}

/** Project every view (model views directly; details against their source's
 *  fresh projection). Views are processed in TABLE ORDER. */
export function projectAllViews(
  views: readonly DocsViewRecord[],
  elements: readonly Element[],
): Map<string, { projection: ViewProjection | null; error: string | null }> {
  const out = new Map<string, { projection: ViewProjection | null; error: string | null }>();
  const byId = new Map(views.map((v) => [v.id, v]));
  for (const view of views) {
    if (view.kind === "detail") {
      const source = view.sourceViewId !== undefined ? byId.get(view.sourceViewId) : undefined;
      if (source === undefined) {
        out.set(view.id, { projection: null, error: `detail source view '${view.sourceViewId}' does not exist` });
        continue;
      }
      const sourceResult = out.get(source.id);
      if (sourceResult === undefined || sourceResult.projection === null) {
        out.set(view.id, { projection: null, error: `detail source view '${source.id}' has no projection` });
        continue;
      }
      try {
        out.set(view.id, { projection: projectDetail(view, { view: source, projection: sourceResult.projection }), error: null });
      } catch (e) {
        out.set(view.id, { projection: null, error: (e as Error).message });
      }
      continue;
    }
    try {
      out.set(view.id, { projection: projectView(view, elements), error: null });
    } catch (e) {
      out.set(view.id, { projection: null, error: (e as Error).message });
    }
  }
  return out;
}

/** Regenerate the whole documentation set: view reports + annotation value
 *  updates. `modelVersionId` is informational (the revision the values were
 *  computed at — supplied by the command layer for the report). */
export function regenerateDocumentation(
  views: readonly DocsViewRecord[],
  sheets: readonly DocsSheetRecord[],
  elements: readonly Element[],
  modelVersionId: string,
): RegenerationReport {
  void sheets; // sheets reference views; placements are validated at edit time
  const projections = projectAllViews(views, elements);
  const viewReports: ViewReport[] = [];
  for (const view of views) {
    const result = projections.get(view.id);
    if (result === undefined || result.projection === null) {
      viewReports.push({
        viewId: view.id,
        kind: view.kind,
        title: view.title,
        contentHash: null,
        primitiveCount: 0,
        skipCount: 0,
        error: result?.error ?? "view not projected",
      });
      continue;
    }
    viewReports.push({
      viewId: view.id,
      kind: view.kind,
      title: view.title,
      contentHash: viewContentHash(result.projection),
      primitiveCount: result.projection.primitives.length,
      skipCount: result.projection.skips.length,
      error: null,
    });
  }

  const updates: { elementId: string; readonly props: Readonly<Record<string, unknown>> }[] = [];
  const annotationReports: AnnotationReport[] = [];
  const entitiesById = new Map<string, BimEntity>();
  for (const el of elements) {
    const entity = elementToBimEntityOrNull(el);
    if (entity !== null) entitiesById.set(entity.id, entity);
  }
  for (const el of elements) {
    const annotation = elementToDocsAnnotationOrNull(el);
    if (annotation === null) continue;
    if (annotation.type === "docs.note") {
      annotationReports.push({
        id: el.id, type: annotation.type, viewId: annotation.viewId,
        updated: false, dangling: false, reason: null, measured: null, label: null,
        outcome: "ok",
      });
      continue;
    }
    const viewResult = projections.get(annotation.viewId);
    if (viewResult === undefined || viewResult.projection === null) {
      // CAD-PARITY-013: the typed source-loss classification — the view
      // itself is gone (docs_view_missing), or a DETAIL's source view is
      // gone (docs_source_view_missing), or the view exists but does not
      // project (docs_view_missing — e.g. its story was deleted).
      const view = views.find((v) => v.id === annotation.viewId);
      const code: DocsAnnotationFailureCode =
        view !== undefined && view.kind === "detail" &&
        (view.sourceViewId === undefined || !views.some((v) => v.id === view.sourceViewId))
          ? "docs_source_view_missing"
          : "docs_view_missing";
      recordDangling(el, updates, annotationReports,
        `view '${annotation.viewId}' does not project (see the view report)`, "source_loss", code);
      continue;
    }
    const primitivesBySource = new Map<string, { uMin: number; uMax: number; vMin: number; vMax: number }>();
    for (const p of viewResult.projection.primitives) {
      let uMin: number, uMax: number, vMin: number, vMax: number;
      if (p.type === "line") {
        uMin = Math.min(p.from[0], p.to[0]); uMax = Math.max(p.from[0], p.to[0]);
        vMin = Math.min(p.from[1], p.to[1]); vMax = Math.max(p.from[1], p.to[1]);
      } else if (p.type === "polyline") {
        uMin = Infinity; uMax = -Infinity; vMin = Infinity; vMax = -Infinity;
        for (const pt of p.points) {
          uMin = Math.min(uMin, pt[0]); uMax = Math.max(uMax, pt[0]);
          vMin = Math.min(vMin, pt[1]); vMax = Math.max(vMax, pt[1]);
        }
      } else if (p.type === "circle" || p.type === "arc") {
        uMin = p.center[0] - p.radius; uMax = p.center[0] + p.radius;
        vMin = p.center[1] - p.radius; vMax = p.center[1] + p.radius;
      } else {
        uMin = uMax = p.at[0]; vMin = vMax = p.at[1];
      }
      const existing = primitivesBySource.get(p.sourceId);
      if (existing === undefined) {
        primitivesBySource.set(p.sourceId, { uMin, uMax, vMin, vMax });
      } else {
        primitivesBySource.set(p.sourceId, {
          uMin: Math.min(existing.uMin, uMin),
          uMax: Math.max(existing.uMax, uMax),
          vMin: Math.min(existing.vMin, vMin),
          vMax: Math.max(existing.vMax, vMax),
        });
      }
    }

    if (annotation.type === "docs.dim") {
      refreshDim(el, annotation, primitivesBySource, updates, annotationReports);
    } else {
      refreshTag(el, annotation, entitiesById, updates, annotationReports);
    }
  }

  return {
    views: viewReports,
    annotations: annotationReports,
    updates,
  };
  void modelVersionId;
}

function recordDangling(
  element: Element,
  updates: { elementId: string; readonly props: Readonly<Record<string, unknown>> }[],
  reports: AnnotationReport[],
  reason: string,
  outcome: DocsAnnotationOutcome = "dangling",
  code: DocsAnnotationFailureCode = "docs_target_missing",
): void {
  const annotation = element.props as Record<string, unknown>;
  const props: Record<string, unknown> = { ...annotation };
  delete props.measured;
  delete props.label;
  props.dangling = true;
  props.reason = reason;
  updates.push({ elementId: element.id, props });
  reports.push({
    id: element.id, type: String(annotation.type ?? "unknown"), viewId: String(annotation.viewId ?? ""),
    updated: true, dangling: true, reason, measured: null, label: null,
    outcome, code,
  });
}

function refreshDim(
  element: Element,
  dim: DocsDimProps,
  primitivesBySource: Map<string, { uMin: number; uMax: number; vMin: number; vMax: number }>,
  updates: { elementId: string; readonly props: Readonly<Record<string, unknown>> }[],
  reports: AnnotationReport[],
): void {
  const a = primitivesBySource.get(dim.refIds[0]);
  const b = primitivesBySource.get(dim.refIds[1]);
  if (a === undefined || b === undefined) {
    const missing = a === undefined ? dim.refIds[0] : dim.refIds[1];
    recordDangling(element, updates, reports,
      `reference element '${missing}' has no projection in view '${dim.viewId}' (deleted or out of scope)`,
      "dangling", "docs_target_missing");
    return;
  }
  const a1 = dim.axis === "x" ? a.uMin : a.vMin;
  const a2 = dim.axis === "x" ? a.uMax : a.vMax;
  const b1 = dim.axis === "x" ? b.uMin : b.vMin;
  const b2 = dim.axis === "x" ? b.uMax : b.vMax;
  const measured = dim.mode === "overall"
    ? Math.max(a2, b2) - Math.min(a1, b1)
    : Math.max(0, Math.max(a1, b1) - Math.min(a2, b2));
  const props: Record<string, unknown> = { ...element.props };
  props.measured = measured;
  delete props.dangling;
  delete props.reason;
  if (propsEqual(element.props, props)) {
    reports.push({ id: element.id, type: dim.type, viewId: dim.viewId, updated: false, dangling: false, reason: null, measured, label: null, outcome: "ok" });
    return;
  }
  updates.push({ elementId: element.id, props });
  reports.push({
    id: element.id, type: dim.type, viewId: dim.viewId, updated: true, dangling: false,
    reason: null, measured, label: null, outcome: "ok",
  });
}

function refreshTag(
  element: Element,
  tag: DocsTagProps,
  entitiesById: Map<string, BimEntity>,
  updates: { elementId: string; readonly props: Readonly<Record<string, unknown>> }[],
  reports: AnnotationReport[],
): void {
  const target = entitiesById.get(tag.targetId);
  if (target === undefined) {
    recordDangling(element, updates, reports,
      `target element '${tag.targetId}' does not exist (deleted)`,
      "dangling", "docs_target_missing");
    return;
  }
  const label = deriveTagLabel(target, entitiesById);
  const props: Record<string, unknown> = { ...element.props };
  props.label = label;
  delete props.dangling;
  delete props.reason;
  if (propsEqual(element.props, props)) {
    reports.push({ id: element.id, type: tag.type, viewId: tag.viewId, updated: false, dangling: false, reason: null, measured: null, label, outcome: "ok" });
    return;
  }
  updates.push({ elementId: element.id, props });
  reports.push({
    id: element.id, type: tag.type, viewId: tag.viewId, updated: true, dangling: false,
    reason: null, measured: null, label, outcome: "ok",
  });
}

/** Shallow canonical equality for annotation props (no-op detection — an
 *  unchanged annotation must not produce an update or a revision). */
function propsEqual(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
  }
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Deterministic tag label derivation from the target's canonical properties
 *  (door/window labels resolve their opening's clear size). */
export function deriveTagLabel(target: BimEntity, entitiesById: Map<string, BimEntity>): string {
  switch (target.type) {
    case "bim.space": {
      const areaM2 = target.area / 1e6;
      return `${target.name} (${areaM2.toFixed(2)} m²)`;
    }
    case "bim.wall": {
      const dx = target.end[0] - target.start[0];
      const dy = target.end[1] - target.start[1];
      const lengthM = Math.sqrt(dx * dx + dy * dy) / 1000;
      return `${target.name ?? target.id} (${lengthM.toFixed(2)} m)`;
    }
    case "bim.door":
    case "bim.window": {
      const opening = entitiesById.get(target.openingId);
      if (opening !== undefined && opening.type === "bim.opening") {
        return `${target.id} (${opening.width}×${opening.height} mm)`;
      }
      return `${target.id} (fill)`;
    }
    case "bim.opening":
      return `${target.id} (${target.width}×${target.height} mm)`;
    case "bim.slab":
      return target.name ?? target.id;
    case "bim.story":
      return `${target.name} (level ${target.level} mm)`;
    // COMPAT-BIM-003 (additive): the component/material/coordination layer.
    // Component instances tag by name/id (their parametric size lives on the
    // definition side); domain data and coordination primitives tag by name.
    case "bim.componentInstance":
      return target.name ?? target.id;
    case "bim.componentDef":
    case "bim.material":
    case "bim.grid":
    case "bim.referencePlane":
      return target.name;
    // CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
    // entities — deterministic labels from the canonical properties.
    case "bim.roof":
      return target.name ?? target.id;
    case "bim.stair":
      return target.name ?? target.id;
    case "bim.railing":
      return target.name ?? target.id;
    case "bim.zone":
      return target.name;
    case "bim.optionGroup":
      return target.name;
  }
}

export type { DocsDimAxis, DocsDimMode };
