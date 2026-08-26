/**
 * Downstream impact contracts — Quantity → Estimate → RFQ → Commercial
 * impact (RESEARCH-CAD-007 / Issue #32, domain-model.md §4/§5/§6,
 * event-model.md §1/§2/§3, data-model.md §3, LOCK-003/007/019).
 *
 * These contracts define the CANONICAL downstream semantics that consume the
 * model revision stream (contracts/model.ts) and produce the existential
 * ConstructionOS cascade:
 *
 *   model.version.created
 *         ↓
 *   quantity.recalculate.requested
 *         ↓
 *   quantity.changed
 *         ↓
 *   estimate.recalculated
 *         ↓
 *   rfq.scope.impact.detected
 *         ↓
 *   commercial impact (aggregate statement)
 *
 * ENGINE INDEPENDENCE (the CAD-007 proposition): every identity field below
 * (quantity_id, cost item id, estimate_id, package_id, graph_node_id) is a
 * deterministic function of CANONICAL inputs only — document entity id,
 * element id, measurement rule, model version, rate table. Engine ids and
 * engine versions appear ONLY as provenance. Swapping the geometry engine
 * behind the frozen adapter boundary therefore preserves every downstream
 * identity and structure; measured VALUES agree within the declared
 * tolerances. Nothing inferred is presented as observed fact (LOCK-007):
 * quantities are CALCULATED under an explicit method + tolerance; elements
 * without a measurable descriptor are recorded as UNKNOWN and skipped, never
 * guessed.
 *
 * This module is engine-free by construction (LOCK-018): it imports only
 * canonical contracts, never an adapter, never a host.
 */

import type { RevisionRef } from "./model.js";

// --- Measurement rules -------------------------------------------------------

/** A measurement rule (domain-model.md §4: quantities are traceable to a
 *  measurement rule, units, calculation method and engine version). */
export interface QuantityRule {
  readonly rule_id: "volume";
  readonly units: string;
  readonly description: string;
}

/** The volume rule: solid volume in cubic model units (the descriptor
 *  vocabulary is unit-free; values are reported in model-unit³). */
export const VOLUME_RULE: QuantityRule = {
  rule_id: "volume",
  units: "model-unit^3",
  description: "Solid volume of the element's geometry descriptor, computed through the geometry engine adapter (analytic fallback labelled by method).",
};

// --- Tolerances / provenance -------------------------------------------------

/** Declared tolerance of a calculated value (absolute + relative). */
export interface Tolerance {
  readonly absolute: number;
  readonly relative: number;
}

/** Engine provenance — PROVENANCE ONLY, never part of any identity (LOCK-019). */
export interface EngineProvenance {
  readonly engineId: string;
  readonly engineVersion: string;
}

// --- Quantities --------------------------------------------------------------

/** A calculated quantity for one element at one model version. */
export interface QuantityRecord {
  /** Deterministic: sha256 over canonical (entity, element, rule, version). */
  readonly quantity_id: string;
  readonly element_id: string;
  /** Canonical graph node id (entity + element only — engine-free). */
  readonly graph_node_id: string;
  readonly model_version_id: string;
  readonly rule: QuantityRule;
  readonly value: number;
  /** How the value was computed. "engine-geometry-adapter": through the
   *  bound geometry engine's metadata capability; "analytic-descriptor":
   *  local exact analytic fallback (adapters without the capability). */
  readonly method: "engine-geometry-adapter" | "analytic-descriptor";
  readonly engine: EngineProvenance | null;
  readonly declared_tolerance: Tolerance;
  readonly uncertainty: "CALCULATED";
  readonly calculated_at: string;
}

/** An element with no measurable geometry descriptor, or one the adapter
 *  declined (outside its exactness classes) — recorded honestly. */
export interface SkippedQuantity {
  readonly element_id: string;
  readonly reason: "props-not-descriptor" | "adapter-declined";
  readonly uncertainty: "UNKNOWN";
}

/** Per-element quantity delta between two model versions. */
export interface QuantityDeltaRecord {
  readonly element_id: string;
  readonly graph_node_id: string;
  readonly rule_id: QuantityRule["rule_id"];
  readonly previous: number | null;
  readonly current: number | null;
  readonly delta: number | null;
}

// --- Rates / Estimate ----------------------------------------------------------

/** The deterministic DEMO rate table (fixture, not market data — LOCK-007
 *  provenance "demo-fixture"; a production estimate binds a real rate
 *  source per data-model.md §3, which is out of scope for this gate). */
export interface RateEntry {
  readonly rate_id: string;
  readonly category: string;
  readonly currency: string;
  readonly rate_per_unit: number;
  readonly source: string;
}

export interface RateTable {
  readonly rate_table_id: string;
  readonly currency: string;
  readonly rates: readonly RateEntry[];
  /** Rate for categories with no explicit entry. */
  readonly default_rate: RateEntry;
}

/** A versioned cost item (domain-model.md §5): quantity source + rate source. */
export interface CostItem {
  /** Deterministic: sha256 over canonical (entity, element, rule, rate_id) —
   *  version-FREE so items map 1:1 across estimate versions. */
  readonly item_id: string;
  readonly element_id: string;
  readonly graph_node_id: string;
  readonly category: string;
  readonly quantity_source: string;
  readonly rate_id: string;
  readonly rate_per_unit: number;
  readonly amount: number;
  readonly currency: string;
  readonly uncertainty: "CALCULATED";
}

/** An estimate for one model version (versioned, traceable, deterministic). */
export interface EstimateRecord {
  /** Deterministic: sha256 over canonical (entity, model version). */
  readonly estimate_id: string;
  readonly model_version_id: string;
  readonly rate_table_id: string;
  readonly items: readonly CostItem[];
  readonly total: number;
  readonly currency: string;
  readonly uncertainty: "CALCULATED";
  readonly calculated_at: string;
}

// --- RFQ ---------------------------------------------------------------------

/** An RFQ package scoped to an element category (domain-model.md §6). */
export interface RfqPackage {
  /** Deterministic: sha256 over canonical (entity, category). */
  readonly package_id: string;
  readonly category: string;
  readonly title: string;
  /** Canonical element ids in scope (sorted). */
  readonly scope_element_ids: readonly string[];
  /** Canonical graph node ids in scope (sorted, same order). */
  readonly scope_graph_node_ids: readonly string[];
  readonly recipient: string;
}

/** Commercial impact on one RFQ package between two model versions. */
export interface RfqImpactRecord {
  readonly package_id: string;
  readonly category: string;
  readonly affected: boolean;
  readonly previous_amount: number | null;
  readonly current_amount: number;
  readonly delta_amount: number;
  readonly currency: string;
  readonly uncertainty: "CALCULATED";
}

/** The aggregate commercial impact statement (the terminal deliverable of
 *  the existential chain). */
export interface CommercialImpact {
  readonly currency: string;
  readonly total_delta: number;
  readonly affected_package_ids: readonly string[];
  readonly affected_category_count: number;
}

// --- Downstream events ---------------------------------------------------------

export const IMPACT_EVENT_VERSION = "1" as const;

export type ImpactEventType =
  | "quantity.recalculate.requested"
  | "quantity.changed"
  | "estimate.recalculated"
  | "rfq.scope.impact.detected";

/** Deterministic downstream event envelope (event-model.md §1: typed,
 *  immutable, attributable, idempotently consumable, causation-chained). */
export interface ImpactEvent {
  readonly event_id: string;
  readonly event_type: ImpactEventType;
  readonly event_version: string;
  readonly occurred_at: string;
  readonly actor_type: "application";
  readonly actor_id: string;
  readonly source_entity_id: string;
  readonly source_version_id: string;
  readonly source_revision_id: string;
  /** Previous event id in the cascade (the FIRST event's causation is the
   *  `model.version.created` graph event this cascade hangs off). */
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly payload:
    | QuantityRecalculateRequestedPayload
    | QuantityChangedPayload
    | EstimateRecalculatedPayload
    | RfqScopeImpactDetectedPayload;
}

export interface QuantityRecalculateRequestedPayload {
  readonly revision: RevisionRef;
  readonly requested_rules: readonly QuantityRule["rule_id"][];
  readonly affected_elements: readonly string[];
}

export interface QuantityChangedPayload {
  readonly revision: RevisionRef;
  readonly deltas: readonly QuantityDeltaRecord[];
  readonly skipped: readonly SkippedQuantity[];
  readonly method: QuantityRecord["method"];
  readonly engine: EngineProvenance | null;
  readonly declared_tolerance: Tolerance;
}

export interface EstimateRecalculatedPayload {
  readonly revision: RevisionRef;
  readonly estimate_id: string;
  readonly previous_estimate_id: string | null;
  readonly previous_total: number | null;
  readonly total: number;
  readonly delta_total: number;
  readonly currency: string;
  readonly rate_table_id: string;
}

export interface RfqScopeImpactDetectedPayload {
  readonly revision: RevisionRef;
  readonly affected_packages: readonly {
    package_id: string;
    category: string;
    delta_amount: number;
  }[];
  readonly currency: string;
  readonly total_delta: number;
}

// --- Cascade result -------------------------------------------------------------

/** The full deterministic downstream cascade for one model transition. */
export interface ImpactCascade {
  readonly entity_id: string;
  readonly from_revision: RevisionRef;
  readonly to_revision: RevisionRef;
  /** The `model.version.created` graph event this cascade is caused by. */
  readonly model_event_id: string;
  readonly events: readonly ImpactEvent[];
  /** SHA-256 over the canonical encoding of the event list — the
   *  determinism/parity anchor for the cascade. */
  readonly events_hash: string;
  readonly quantities: {
    readonly previous: readonly QuantityRecord[];
    readonly current: readonly QuantityRecord[];
    readonly deltas: readonly QuantityDeltaRecord[];
    readonly skipped: readonly SkippedQuantity[];
  };
  readonly estimate: {
    readonly previous: EstimateRecord | null;
    readonly current: EstimateRecord;
  };
  readonly rfq: {
    readonly packages: readonly RfqPackage[];
    readonly impacts: readonly RfqImpactRecord[];
  };
  readonly commercial_impact: CommercialImpact;
  /** Engine provenance of this cascade run (PROVENANCE ONLY — LOCK-019). */
  readonly engine: EngineProvenance;
  readonly rate_table_id: string;
}
