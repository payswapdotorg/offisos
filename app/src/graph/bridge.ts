/**
 * Construction Graph bridge (CAD-IMPLEMENT-003, §5.4, §9, §10, LOCK-019,
 * event-model.md §1/§2/§4, ADR-003/ADR-007).
 *
 * Maps the CADDocument's immutable model history into the graph-facing
 * domain event stream at model/version boundaries:
 *
 *   - `model.created`      — once, for the history base (the model entering
 *                            the editor's domain of record);
 *   - `model.version.created` — once per revision, carrying the revision
 *                            reference, the affected elements, per-element
 *                            provenance and an explicit uncertainty state.
 *
 * The bridge consumes ONLY the explicit domain contracts
 * (contracts/model.ts, contracts/caddocument.ts) — never engine internals,
 * never host code (LOCK-018/019; RESEARCH-CAD-003 identity findings: engine
 * GlobalIds are provenance, canonical domain ids are identity).
 *
 * Determinism: every field derives from deterministic inputs (fixed
 * timestamps, content hashes, canonical ordering), so the same history
 * yields byte-identical events on every host and every run (§5.5 parity).
 *
 * The bridge does NOT make CADDocument the Construction Graph: it produces
 * an event stream a graph-side consumer subscribes to. CADDocument identity
 * remains document-local; graph node ids are a deterministic projection.
 */

import { createHash } from "node:crypto";
import type { Element } from "../contracts/caddocument.js";
import type {
  ElementUncertainty,
  GraphBridgeResult,
  GraphElementProjection,
  GraphModelEvent,
  GraphModelEventPayload,
  GraphModelEventType,
  ModelHistory,
  RevisionDelta,
  RevisionRef,
  RevisionUncertainty,
} from "../contracts/model.js";
import { GRAPH_MODEL_EVENT_VERSION } from "../contracts/model.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { HISTORY_NOW, baseContentHash, makeRevisionId, replayHistoryTo } from "../caddocument/history.js";

/** Canonical graph node id: deterministic function of the document entity id
 *  and the stable document element id. Engine ids NEVER participate
 *  (LOCK-019): the same element id with different engine provenance maps to
 *  the SAME graph node. */
export function graphNodeId(entityId: string, elementId: string): string {
  const digest = createHash("sha256")
    .update(canonicalStringify({ entity_id: entityId, element_id: elementId }))
    .digest("hex");
  return `cg:cad-element:${digest.slice(0, 32)}`;
}

/** Deterministic event id for a (type, entity, revision) triple. */
function makeEventId(eventType: GraphModelEventType, entityId: string, revisionId: string): string {
  const digest = createHash("sha256")
    .update(
      canonicalStringify({
        event_type: eventType,
        event_version: GRAPH_MODEL_EVENT_VERSION,
        source_entity_id: entityId,
        source_revision_id: revisionId,
      }),
    )
    .digest("hex");
  return `cge1:${digest.slice(0, 32)}`;
}

/** Revision reference for the history base (revision 0). */
function baseRevisionRef(history: ModelHistory): RevisionRef {
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

/** Revision reference for revision k (1..N). */
function revisionRef(history: ModelHistory, k: number): RevisionRef {
  const rev = history.revisions[k - 1];
  if (rev === undefined) throw new Error(`bridge: missing revision ${k}`);
  return {
    revision_id: rev.revision_id,
    revision_number: rev.revision_number,
    version_id: rev.version.version_id,
    version_number: rev.version.version_number,
    parent_version_id: rev.version.parent_version_id,
    content_hash: rev.content_hash,
  };
}

/** Per-element epistemic state (§2.7, LOCK-007). */
function elementUncertainty(element: Element): ElementUncertainty {
  return {
    identity: "OBSERVED", // the element id is authoritative document state
    geometry_provenance: element.engineId !== null ? "OBSERVED" : "UNKNOWN",
    semantics: "UNKNOWN", // BIM semantics are not extracted in this slice
  };
}

/** Graph projection for one affected element. */
function projectElement(
  history: ModelHistory,
  element: Element,
  change: "added" | "removed" | "updated",
): GraphElementProjection {
  return {
    graph_node_id: graphNodeId(history.entity_id, element.id),
    element_id: element.id,
    document_entity_id: history.entity_id,
    change,
    kind: element.kind,
    engineId: element.engineId, // provenance ONLY (LOCK-019)
    uncertainty: elementUncertainty(element),
  };
}

/** Revision-level epistemic summary over the affected elements. */
function revisionUncertainty(elements: readonly Element[]): RevisionUncertainty {
  if (elements.length === 0) {
    return { geometry_provenance: "OBSERVED", semantics: "UNKNOWN" }; // no provenance asserted
  }
  const withProvenance = elements.filter((el) => el.engineId !== null).length;
  const geometry_provenance =
    withProvenance === elements.length ? "OBSERVED" : withProvenance === 0 ? "UNKNOWN" : "MIXED";
  return { geometry_provenance, semantics: "UNKNOWN" };
}

/** Element projections for a delta, using before/after element states. */
function projectDelta(
  history: ModelHistory,
  delta: RevisionDelta,
  before: ReadonlyMap<string, Element>,
  after: ReadonlyMap<string, Element>,
): GraphElementProjection[] {
  const projections: GraphElementProjection[] = [];
  for (const id of delta.added) {
    const el = after.get(id);
    if (el !== undefined) projections.push(projectElement(history, el, "added"));
  }
  for (const id of delta.removed) {
    const el = before.get(id);
    if (el !== undefined) projections.push(projectElement(history, el, "removed"));
  }
  for (const id of delta.updated) {
    const el = after.get(id);
    if (el !== undefined) projections.push(projectElement(history, el, "updated"));
  }
  projections.sort((a, b) =>
    a.element_id < b.element_id ? -1 : a.element_id > b.element_id ? 1 : a.change < b.change ? -1 : 1,
  );
  return projections;
}

function deepFreezeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeValue(item);
    Object.freeze(value);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) deepFreezeValue(obj[key]);
  Object.freeze(value);
  return value;
}

/** Bridge the full model history into the deterministic graph-facing event
 *  stream: one `model.created` for the base + one `model.version.created`
 *  per revision, causation-chained in order. */
export function bridgeModelHistory(history: ModelHistory): GraphBridgeResult {
  const events: GraphModelEvent[] = [];

  // model.created — the base boundary (revision 0).
  const baseRef = baseRevisionRef(history);
  const baseElements = [...history.base.elements].sort((a, b) => (a.id < b.id ? -1 : 1));
  const baseDelta: RevisionDelta = {
    added: baseElements.map((el) => el.id),
    removed: [],
    updated: [],
  };
  const createdPayload: GraphModelEventPayload = {
    revision: baseRef,
    affected: baseDelta,
    elements: baseElements.map((el) => projectElement(history, el, "added")),
    provenance: {
      document_entity_id: history.entity_id,
      format: history.format,
      formatVersion: history.formatVersion,
      origin: history.base.origin,
      actor: history.base.version.created_by,
      source_snapshot_id: history.base.version.source_snapshot_id,
      sourceArtifactLineage: history.base.sourceArtifactLineage,
    },
    uncertainty: revisionUncertainty(baseElements),
  };
  events.push(
    deepFreezeValue({
      event_id: makeEventId("model.created", history.entity_id, baseRef.revision_id),
      event_type: "model.created",
      event_version: GRAPH_MODEL_EVENT_VERSION,
      occurred_at: HISTORY_NOW,
      actor_type: "application",
      actor_id: history.base.version.created_by,
      source_entity_id: history.entity_id,
      source_version_id: baseRef.version_id,
      source_revision_id: baseRef.revision_id,
      causation_id: null,
      correlation_id: history.entity_id,
      payload: createdPayload,
    }) as GraphModelEvent,
  );

  // model.version.created — one per revision, in order.
  for (let k = 1; k <= history.revisions.length; k++) {
    const rev = history.revisions[k - 1];
    if (rev === undefined) throw new Error(`bridge: missing revision ${k}`);
    const before = new Map(replayHistoryTo(history, k - 1).elements.map((el) => [el.id, el] as const));
    const after = new Map(replayHistoryTo(history, k).elements.map((el) => [el.id, el] as const));
    const ref = revisionRef(history, k);
    const affectedElements: Element[] = [];
    for (const id of rev.delta.added) {
      const el = after.get(id);
      if (el !== undefined) affectedElements.push(el);
    }
    for (const id of rev.delta.removed) {
      const el = before.get(id);
      if (el !== undefined) affectedElements.push(el);
    }
    for (const id of rev.delta.updated) {
      const el = after.get(id);
      if (el !== undefined) affectedElements.push(el);
    }
    const payload: GraphModelEventPayload = {
      revision: ref,
      affected: rev.delta,
      elements: projectDelta(history, rev.delta, before, after),
      provenance: {
        document_entity_id: history.entity_id,
        format: history.format,
        formatVersion: history.formatVersion,
        origin: rev.note,
        actor: rev.created_by,
        source_snapshot_id: rev.version.source_snapshot_id,
        sourceArtifactLineage: history.base.sourceArtifactLineage,
      },
      uncertainty: revisionUncertainty(affectedElements),
    };
    events.push(
      deepFreezeValue({
        event_id: makeEventId("model.version.created", history.entity_id, ref.revision_id),
        event_type: "model.version.created",
        event_version: GRAPH_MODEL_EVENT_VERSION,
        occurred_at: HISTORY_NOW,
        actor_type: "application",
        actor_id: rev.created_by,
        source_entity_id: history.entity_id,
        source_version_id: ref.version_id,
        source_revision_id: ref.revision_id,
        causation_id: events[events.length - 1]?.event_id ?? null,
        correlation_id: history.entity_id,
        payload,
      }) as GraphModelEvent,
    );
  }

  const events_hash = createHash("sha256").update(canonicalStringify(events)).digest("hex");
  Object.freeze(events);
  return Object.freeze({ events, events_hash }) as GraphBridgeResult;
}
