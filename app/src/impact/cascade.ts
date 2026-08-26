/**
 * Downstream impact cascade — the deterministic Quantity → Estimate → RFQ →
 * Commercial-impact calculation (RESEARCH-CAD-007 / Issue #32,
 * event-model.md §3 key cascade, LOCK-003/005/007/017/019).
 *
 * Consumes the CADDocument's immutable model history (canonical revisions)
 * and the geometry engine through the FROZEN adapter boundary — nothing
 * else. Produces the existential ConstructionOS cascade for one model
 * transition (revision k−1 → k):
 *
 *   model.version.created            (graph bridge, upstream cause)
 *         ↓ causation
 *   quantity.recalculate.requested
 *         ↓
 *   quantity.changed                 (deltas + honest skips)
 *         ↓
 *   estimate.recalculated            (versioned cost items)
 *         ↓
 *   rfq.scope.impact.detected        (affected packages)
 *         ↓
 *   commercial impact                (aggregate statement)
 *
 * ENGINE INDEPENDENCE: quantity/estimate/RFQ IDENTITIES derive from canonical
 * inputs only (entity, element, rule, model version, rate table). The engine
 * is reached exclusively via `bundle.geometry.prepareGeometry` + the optional
 * `describeGeometryMetadata` capability; its id/version are recorded as
 * PROVENANCE. Swapping engines preserves identities and structure; values
 * agree within the declared tolerances.
 *
 * Determinism (LOCK-004/005/017): fixed timestamps, canonical ordering
 * (elements/items/packages sorted lexicographically), fixed arithmetic order,
 * SHA-256 over canonical encodings for every id and for the events_hash —
 * the same history through the same engine yields a byte-identical cascade
 * on every host and every run (Web/Electron parity).
 *
 * Epistemic honesty (LOCK-007): quantities are CALCULATED under an explicit
 * method + declared tolerance; elements without a measurable descriptor and
 * elements the adapter declines are recorded as UNKNOWN skips — never
 * guessed, never silently dropped.
 */

import { createHash } from "node:crypto";
import type { Element } from "../contracts/caddocument.js";
import type { EngineAdapterBundle } from "../contracts/adapter.js";
import { AdapterFailure, isAdapterFailure, isGeometryMetadataProvider } from "../contracts/geometry.js";
import type { GeometryDescriptor } from "../contracts/geometry.js";
import type {
  CommercialImpact,
  CostItem,
  EstimateRecord,
  ImpactCascade,
  ImpactEvent,
  ImpactEventType,
  QuantityDeltaRecord,
  QuantityRecord,
  RateTable,
  RfqImpactRecord,
  RfqPackage,
  SkippedQuantity,
  Tolerance,
} from "../contracts/impact.js";
import { IMPACT_EVENT_VERSION, VOLUME_RULE } from "../contracts/impact.js";
import type { ModelHistory, RevisionRef } from "../contracts/model.js";
import { HISTORY_NOW } from "../caddocument/history.js";
import { replayHistoryTo } from "../caddocument/history.js";
import { canonicalStringify } from "../caddocument/serialization.js";
import { bridgeModelHistory, graphNodeId } from "../graph/index.js";

// --- deterministic demo rate table -------------------------------------------

/**
 * The deterministic DEMO rate table. This is a FIXTURE, not market data
 * (LOCK-007: source "demo-fixture"): the existential cascade test needs a
 * stable, versioned rate source; binding real market rates is a production
 * estimate concern (data-model.md §3) outside this gate's scope.
 */
export const DEMO_RATE_TABLE: RateTable = {
  rate_table_id: "demo-rates-2026-08",
  currency: "GHS",
  rates: [
    { rate_id: "rate-concrete", category: "concrete", currency: "GHS", rate_per_unit: 420, source: "demo-fixture" },
    { rate_id: "rate-steel", category: "steel", currency: "GHS", rate_per_unit: 1150, source: "demo-fixture" },
  ],
  default_rate: {
    rate_id: "rate-uncategorized",
    category: "uncategorized",
    currency: "GHS",
    rate_per_unit: 300,
    source: "demo-fixture",
  },
};

// --- deterministic ids ---------------------------------------------------------

function sha(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

function quantityId(entityId: string, elementId: string, ruleId: string, versionId: string): string {
  return `qty:${sha({ entity_id: entityId, element_id: elementId, rule_id: ruleId, version_id: versionId }).slice(0, 24)}`;
}

function costItemId(entityId: string, elementId: string, ruleId: string, rateId: string): string {
  return `cost:${sha({ entity_id: entityId, element_id: elementId, rule_id: ruleId, rate_id: rateId }).slice(0, 24)}`;
}

function estimateId(entityId: string, versionId: string): string {
  return `est:${sha({ entity_id: entityId, version_id: versionId }).slice(0, 24)}`;
}

function packageId(entityId: string, category: string): string {
  return `rfq-pkg:${sha({ entity_id: entityId, category }).slice(0, 24)}`;
}

function impactEventId(type: ImpactEventType, entityId: string, revisionId: string, seq: number): string {
  return `dse1:${sha({ event_type: type, event_version: IMPACT_EVENT_VERSION, entity_id: entityId, revision_id: revisionId, seq }).slice(0, 32)}`;
}

// --- descriptor resolution -------------------------------------------------------

/** Resolve the GeometryDescriptor carried by an element. Two persisted
 *  conventions are accepted (both engine-free): `props.geometry` (the
 *  document workflow's convention — the descriptor plus inert provenance
 *  fields) and the descriptor AS props (the geometry.prepare convention).
 *  Returns null when the element carries no measurable descriptor. */
export function resolveGeometryDescriptor(element: Element): GeometryDescriptor | null {
  const props = element.props as Record<string, unknown>;
  const nested = props.geometry;
  if (typeof nested === "object" && nested !== null && typeof (nested as { shape?: unknown }).shape === "string") {
    return nested as GeometryDescriptor;
  }
  if (typeof props.shape === "string") {
    return props as unknown as GeometryDescriptor;
  }
  return null;
}

/** Local exact analytic volume fallback for adapters WITHOUT the metadata
 *  capability (e.g. the dummy test double). Exact for box / cylinder /
 *  transform compositions; booleans are OUTSIDE this fallback's exact
 *  classes and are declined honestly (bind a metadata-capable adapter). */
function fallbackAnalyticVolume(descriptor: unknown): number {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new AdapterFailure("engine_error", "impact fallback: descriptor must be an object", false);
  }
  const d = descriptor as { shape?: unknown; [key: string]: unknown };
  switch (d.shape) {
    case "box": {
      const w = d.width, dp = d.depth, h = d.height;
      if (typeof w !== "number" || typeof dp !== "number" || typeof h !== "number" || w <= 0 || dp <= 0 || h <= 0) {
        throw new AdapterFailure("engine_error", "impact fallback: invalid box", false);
      }
      return w * dp * h;
    }
    case "cylinder": {
      const r = d.radius, h = d.height;
      if (typeof r !== "number" || typeof h !== "number" || r <= 0 || h <= 0) {
        throw new AdapterFailure("engine_error", "impact fallback: invalid cylinder", false);
      }
      return Math.PI * r * r * h;
    }
    case "transform": {
      const m = d.matrix;
      if (!Array.isArray(m) || m.length !== 16) {
        throw new AdapterFailure("engine_error", "impact fallback: invalid transform matrix", false);
      }
      const a = m[0] as number, b = m[1] as number, c = m[2] as number;
      const dd = m[4] as number, e = m[5] as number, f = m[6] as number;
      const g = m[8] as number, hh = m[9] as number, i = m[10] as number;
      const det = Math.abs(a * (e * i - f * hh) - b * (dd * i - f * g) + c * (dd * hh - e * g));
      if (!(det > 1e-12)) {
        throw new AdapterFailure("engine_error", "impact fallback: singular transform matrix", false);
      }
      return fallbackAnalyticVolume(d.target) * det;
    }
    default:
      throw new AdapterFailure(
        "engine_error",
        `impact fallback: descriptor shape '${JSON.stringify(d.shape)}' is outside the local analytic fallback's exact classes (bind a metadata-capable geometry adapter)`,
        false,
      );
  }
}

// --- tolerance declarations -------------------------------------------------------

/** Tolerances declared per computation method (mirrors the CAD-002 declared
 *  tolerances: engine BRep volumes are exact for polyhedra and within 1e-6
 *  for curved surfaces; the local fallback is exact up to float association). */
const ENGINE_TOLERANCE = { absolute: 1e-6, relative: 1e-6 } as const;
const FALLBACK_TOLERANCE = { absolute: 0, relative: 1e-12 } as const;

// --- quantity calculation ----------------------------------------------------------

interface QuantityOutcome {
  readonly quantities: QuantityRecord[];
  readonly skipped: SkippedQuantity[];
}

/** Deterministic engine provenance of the cascade run. */
function engineProvenance(bundle: EngineAdapterBundle): { engineId: string; engineVersion: string } {
  return { engineId: bundle.geometry.engineId, engineVersion: bundle.geometry.engineVersion };
}

/** Compute the quantity set for one replayed element set (sorted by element
 *  id) through the engine boundary. */
async function quantitiesFor(
  entityId: string,
  versionId: string,
  elements: readonly Element[],
  bundle: EngineAdapterBundle,
): Promise<QuantityOutcome> {
  const ordered = [...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const quantities: QuantityRecord[] = [];
  const skipped: SkippedQuantity[] = [];
  for (const element of ordered) {
    const descriptor = resolveGeometryDescriptor(element);
    if (descriptor === null) {
      skipped.push({ element_id: element.id, reason: "props-not-descriptor", uncertainty: "UNKNOWN" });
      continue;
    }
    // The engine is reached ONLY through the frozen contract: prepare the
    // descriptor, then ask the optional metadata capability for the volume.
    const engineElement: Element = {
      id: `quantity:${element.id}`,
      kind: "geometry",
      engineId: null,
      props: descriptor as Record<string, unknown>,
    };
    try {
      const prepared = await bundle.geometry.prepareGeometry(engineElement);
      let value: number | null = null;
      let method: QuantityRecord["method"] = "engine-geometry-adapter";
      if (isGeometryMetadataProvider(bundle.geometry)) {
        const meta = await bundle.geometry.describeGeometryMetadata(prepared.meshToken);
        if (meta !== null && typeof meta.volume === "number" && Number.isFinite(meta.volume)) {
          value = meta.volume;
        }
      }
      let tolerance: Tolerance = ENGINE_TOLERANCE;
      if (value === null) {
        // Honest fallback, labelled by method (LOCK-007).
        value = fallbackAnalyticVolume(descriptor);
        method = "analytic-descriptor";
        tolerance = FALLBACK_TOLERANCE;
      }
      // Provenance is read AFTER the engine call: the OCCT adapter lazily
      // discovers engineVersion from the first worker response — reading it
      // pre-call would record "unknown" on a cold adapter (LOCK-007).
      const provenance = engineProvenance(bundle);
      quantities.push({
        quantity_id: quantityId(entityId, element.id, VOLUME_RULE.rule_id, versionId),
        element_id: element.id,
        graph_node_id: graphNodeIdOf(entityId, element.id),
        model_version_id: versionId,
        rule: VOLUME_RULE,
        value,
        method,
        engine: provenance,
        declared_tolerance: tolerance,
        uncertainty: "CALCULATED",
        calculated_at: HISTORY_NOW,
      });
    } catch (e) {
      if (isAdapterFailure(e)) {
        if (e.code === "engine_malformed_input") {
          // Malformed descriptors are document corruption — reject loudly,
          // never silently repaired (the same principle as history open).
          throw e;
        }
        // The adapter declined this element's exactness class — recorded as
        // UNKNOWN, never guessed (LOCK-007).
        skipped.push({ element_id: element.id, reason: "adapter-declined", uncertainty: "UNKNOWN" });
        continue;
      }
      throw e;
    }
  }
  return { quantities, skipped };
}

// --- estimate / RFQ ------------------------------------------------------------------

function categoryOf(element: Element): string {
  const category = (element.props as Record<string, unknown>).category;
  if (typeof category === "string" && category.trim().length > 0) {
    return category.trim().toLowerCase();
  }
  return "uncategorized";
}

function rateFor(rateTable: RateTable, category: string) {
  return rateTable.rates.find((r) => r.category === category) ?? rateTable.default_rate;
}

function estimateFor(
  entityId: string,
  versionId: string,
  elements: readonly Element[],
  quantities: readonly QuantityRecord[],
  rateTable: RateTable,
): EstimateRecord {
  const ordered = [...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byElement = new Map(quantities.map((q) => [q.element_id, q] as const));
  const items: CostItem[] = [];
  for (const element of ordered) {
    const quantity = byElement.get(element.id);
    if (quantity === undefined) continue; // skipped elements carry no cost item
    const category = categoryOf(element);
    const rate = rateFor(rateTable, category);
    items.push({
      item_id: costItemId(entityId, element.id, VOLUME_RULE.rule_id, rate.rate_id),
      element_id: element.id,
      graph_node_id: graphNodeIdOf(entityId, element.id),
      category,
      quantity_source: quantity.quantity_id,
      rate_id: rate.rate_id,
      rate_per_unit: rate.rate_per_unit,
      amount: quantity.value * rate.rate_per_unit,
      currency: rateTable.currency,
      uncertainty: "CALCULATED",
    });
  }
  let total = 0;
  for (const item of items) total += item.amount;
  return {
    estimate_id: estimateId(entityId, versionId),
    model_version_id: versionId,
    rate_table_id: rateTable.rate_table_id,
    items,
    total,
    currency: rateTable.currency,
    uncertainty: "CALCULATED",
    calculated_at: HISTORY_NOW,
  };
}

function packagesFor(entityId: string, elements: readonly Element[], quantities: readonly QuantityRecord[]): RfqPackage[] {
  const measured = new Set(quantities.map((q) => q.element_id));
  const byCategory = new Map<string, Element[]>();
  const ordered = [...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const element of ordered) {
    if (!measured.has(element.id)) continue;
    const category = categoryOf(element);
    const list = byCategory.get(category) ?? [];
    list.push(element);
    byCategory.set(category, list);
  }
  const packages: RfqPackage[] = [];
  for (const category of [...byCategory.keys()].sort()) {
    const elementsInCategory = byCategory.get(category)!;
    packages.push({
      package_id: packageId(entityId, category),
      category,
      title: `RFQ package: ${category} (model elements)`,
      scope_element_ids: elementsInCategory.map((e) => e.id),
      scope_graph_node_ids: elementsInCategory.map((e) => graphNodeIdOf(entityId, e.id)),
      recipient: "subcontractor-demo",
    });
  }
  return packages;
}

function rfqImpacts(
  previous: EstimateRecord | null,
  current: EstimateRecord,
  packages: readonly RfqPackage[],
): RfqImpactRecord[] {
  const prevByCategory = new Map<string, { sum: number; count: number }>();
  if (previous !== null) {
    for (const item of previous.items) {
      const entry = prevByCategory.get(item.category) ?? { sum: 0, count: 0 };
      entry.sum += item.amount;
      entry.count += 1;
      prevByCategory.set(item.category, entry);
    }
  }
  const currByCategory = new Map<string, number>();
  for (const item of current.items) {
    currByCategory.set(item.category, (currByCategory.get(item.category) ?? 0) + item.amount);
  }
  const impacts: RfqImpactRecord[] = [];
  for (const pkg of packages) {
    const currentAmount = currByCategory.get(pkg.category) ?? 0;
    const prevEntry = prevByCategory.get(pkg.category);
    const previousAmount = prevEntry === undefined ? null : prevEntry.sum;
    const hadItems = previous !== null && (prevEntry?.count ?? 0) > 0;
    impacts.push({
      package_id: pkg.package_id,
      category: pkg.category,
      affected: currentAmount !== previousAmount,
      previous_amount: hadItems ? previousAmount : null,
      current_amount: currentAmount,
      delta_amount: hadItems ? currentAmount - (previousAmount as number) : currentAmount,
      currency: current.currency,
      uncertainty: "CALCULATED",
    });
  }
  return impacts;
}

// --- revision refs ---------------------------------------------------------------------

function revisionRefOf(history: ModelHistory, k: number): RevisionRef {
  if (k === 0) {
    const bridged = bridgeModelHistory(history);
    const created = bridged.events[0]!;
    return created.payload.revision;
  }
  const rev = history.revisions[k - 1]!;
  return {
    revision_id: rev.revision_id,
    revision_number: rev.revision_number,
    version_id: rev.version.version_id,
    version_number: rev.version.version_number,
    parent_version_id: rev.version.parent_version_id,
    content_hash: rev.content_hash,
  };
}

function graphNodeIdOf(entityId: string, elementId: string): string {
  return graphNodeId(entityId, elementId);
}

// --- the cascade --------------------------------------------------------------------------

export interface ImpactCascadeOptions {
  readonly history: ModelHistory;
  /** Target revision k (1..N): the cascade describes transition k−1 → k. */
  readonly revision: number;
  readonly bundle: EngineAdapterBundle;
  readonly rateTable?: RateTable;
}

/** Run the deterministic downstream impact cascade for one model transition.
 *  Same history + same engine → byte-identical cascade (parity anchor:
 *  `events_hash`). */
export async function runImpactCascade(options: ImpactCascadeOptions): Promise<ImpactCascade> {
  const { history, bundle } = options;
  const rateTable = options.rateTable ?? DEMO_RATE_TABLE;
  const k = options.revision;
  if (!Number.isInteger(k) || k < 1 || k > history.revisions.length) {
    throw new Error(`impact cascade: revision ${k} out of range 1..${history.revisions.length}`);
  }
  const entityId = history.entity_id;
  const toRef = revisionRefOf(history, k);
  const fromRef = revisionRefOf(history, k - 1);

  const beforeElements = replayHistoryTo(history, k - 1).elements;
  const afterElements = replayHistoryTo(history, k).elements;

  const previousOutcome = await quantitiesFor(entityId, fromRef.version_id, beforeElements, bundle);
  const currentOutcome = await quantitiesFor(entityId, toRef.version_id, afterElements, bundle);

  // Quantity deltas (canonical element-id order over the union of ids).
  const prevByElement = new Map(previousOutcome.quantities.map((q) => [q.element_id, q] as const));
  const currByElement = new Map(currentOutcome.quantities.map((q) => [q.element_id, q] as const));
  const allIds = [...new Set([...prevByElement.keys(), ...currByElement.keys()])].sort();
  const deltas: QuantityDeltaRecord[] = [];
  for (const id of allIds) {
    const p = prevByElement.get(id);
    const c = currByElement.get(id);
    deltas.push({
      element_id: id,
      graph_node_id: graphNodeIdOf(entityId, id),
      rule_id: VOLUME_RULE.rule_id,
      previous: p === undefined ? null : p.value,
      current: c === undefined ? null : c.value,
      delta: p !== undefined && c !== undefined ? c.value - p.value : null,
    });
  }

  const previousEstimate =
    k === 1
      ? null
      : estimateFor(entityId, fromRef.version_id, beforeElements, previousOutcome.quantities, rateTable);
  const currentEstimate = estimateFor(entityId, toRef.version_id, afterElements, currentOutcome.quantities, rateTable);
  const packages = packagesFor(entityId, afterElements, currentOutcome.quantities);
  const impacts = rfqImpacts(previousEstimate, currentEstimate, packages);

  const affected = impacts.filter((i) => i.affected);
  const commercialImpact: CommercialImpact = {
    currency: rateTable.currency,
    total_delta: affected.reduce((sum, i) => sum + i.delta_amount, 0),
    affected_package_ids: [...affected].sort((a, b) => (a.category < b.category ? -1 : 1)).map((i) => i.package_id),
    affected_category_count: affected.length,
  };

  // The upstream cause: the model.version.created graph event for revision k.
  const bridged = bridgeModelHistory(history);
  const modelEvent =
    bridged.events.find(
      (e) => e.event_type === "model.version.created" && e.source_revision_id === toRef.revision_id,
    ) ?? null;
  if (modelEvent === null) {
    throw new Error(`impact cascade: no model.version.created event for revision ${k}`);
  }

  // --- the deterministic downstream event chain ------------------------------------
  const actorId = history.revisions[k - 1]!.created_by;
  const events: ImpactEvent[] = [];
  const push = (
    type: ImpactEventType,
    payload: ImpactEvent["payload"],
  ): void => {
    events.push({
      event_id: impactEventId(type, entityId, toRef.revision_id, events.length),
      event_type: type,
      event_version: IMPACT_EVENT_VERSION,
      occurred_at: HISTORY_NOW,
      actor_type: "application",
      actor_id: actorId,
      source_entity_id: entityId,
      source_version_id: toRef.version_id,
      source_revision_id: toRef.revision_id,
      causation_id: events.length === 0 ? modelEvent.event_id : events[events.length - 1]!.event_id,
      correlation_id: entityId,
      payload,
    });
  };

  const affectedElements = deltas.filter((d) => d.previous !== d.current).map((d) => d.element_id);

  push("quantity.recalculate.requested", {
    revision: toRef,
    requested_rules: [VOLUME_RULE.rule_id],
    affected_elements: affectedElements,
  });

  push("quantity.changed", {
    revision: toRef,
    deltas,
    skipped: [...previousOutcome.skipped, ...currentOutcome.skipped].sort((a, b) =>
      a.element_id < b.element_id ? -1 : a.element_id > b.element_id ? 1 : a.reason < b.reason ? -1 : 1,
    ),
    method: currentOutcome.quantities[0]?.method ?? "engine-geometry-adapter",
    engine: engineProvenance(bundle),
    declared_tolerance: ENGINE_TOLERANCE,
  });

  push("estimate.recalculated", {
    revision: toRef,
    estimate_id: currentEstimate.estimate_id,
    previous_estimate_id: previousEstimate?.estimate_id ?? null,
    previous_total: previousEstimate?.total ?? null,
    total: currentEstimate.total,
    delta_total: previousEstimate === null ? currentEstimate.total : currentEstimate.total - previousEstimate.total,
    currency: currentEstimate.currency,
    rate_table_id: rateTable.rate_table_id,
  });

  push("rfq.scope.impact.detected", {
    revision: toRef,
    affected_packages: affected
      .sort((a, b) => (a.category < b.category ? -1 : 1))
      .map((i) => ({ package_id: i.package_id, category: i.category, delta_amount: i.delta_amount })),
    currency: rateTable.currency,
    total_delta: commercialImpact.total_delta,
  });

  const eventsHash = createHash("sha256").update(canonicalStringify(events)).digest("hex");

  return {
    entity_id: entityId,
    from_revision: fromRef,
    to_revision: toRef,
    model_event_id: modelEvent.event_id,
    events: Object.freeze(events),
    events_hash: eventsHash,
    quantities: {
      previous: previousOutcome.quantities,
      current: currentOutcome.quantities,
      deltas,
      skipped: currentOutcome.skipped,
    },
    estimate: {
      previous: previousEstimate,
      current: currentEstimate,
    },
    rfq: { packages, impacts },
    commercial_impact: commercialImpact,
    engine: engineProvenance(bundle),
    rate_table_id: rateTable.rate_table_id,
  };
}
