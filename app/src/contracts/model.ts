/**
 * Model revision + Construction Graph bridge contracts
 * (CAD-IMPLEMENT-003, §5.4, §9, §10, data-model.md §2/§3/§5, event-model.md
 * §1/§2/§4, LOCK-005/LOCK-019).
 *
 * The CADDocument remains the editor's canonical working representation and is
 * NOT the Construction Graph (LOCK-019). This module defines the EXPLICIT
 * versioned contracts through which document state maps into the Graph:
 *
 *  - `ModelHistory` — the immutable, append-only model revision log persisted
 *    with the document (save/open). Each `ModelRevision` records one document
 *    transition (edit / undo / redo) with its version metadata (data-model.md
 *    §2), content hash, the applied edit, and the element-set delta. The log
 *    is deterministic (fixed timestamps, canonical ordering) and replayable
 *    (information-state correct, no future leakage).
 *  - `GraphModelEvent` — the deterministic graph-facing domain event emitted
 *    at model/version boundaries (event-model.md §2 Model family:
 *    `model.created`, `model.version.created`). Events are typed, immutable,
 *    attributable, idempotently consumable and linked to a source
 *    entity/version plus a causation/correlation chain (event-model.md §1).
 *    Each event payload carries the revision reference, the affected
 *    elements, per-element provenance (engine ids are provenance ONLY —
 *    canonical graph identity derives from the stable document element id)
 *    and an explicit uncertainty state (§2.7, LOCK-007: nothing inferred is
 *    presented as observed fact).
 *
 * These contracts are engine-free by construction (LOCK-018): the Graph
 * bridge consumes them, never engine internals.
 */

import type { DocumentEdit, Element, ElementKind, VersionMeta } from "./caddocument.js";

// --- Model revisions (immutable revision history, LOCK-005) ----------------

/** Origin of a recorded revision transition (auditability). */
export type RevisionNote = "edit" | "undo" | "redo";

/** Element-set delta between consecutive revisions. Canonical element ids,
 *  lexicographically sorted. Empty arrays are explicit (no delta members). */
export interface RevisionDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
}

/** One immutable model revision: a recorded document transition.
 *  Revisions are append-only; nothing may rewrite a recorded revision. */
export interface ModelRevision {
  /** Monotonic 1..N position in the history log. */
  readonly revision_number: number;
  /** Deterministic id: `<entity_id>#r<n>(<contentHash12>)`. */
  readonly revision_id: string;
  /** Document version BEFORE the transition. */
  readonly from_version_id: string;
  /** Document version AFTER the transition (frozen copy, data-model.md §2). */
  readonly version: VersionMeta;
  /** Content-only hash AFTER the transition (version-id derivation hash). */
  readonly content_hash: string;
  /** The edit applied to transition from the previous revision to this one. */
  readonly applied_edit: DocumentEdit;
  /** Element diff against the previous revision (base for revision 1). */
  readonly delta: RevisionDelta;
  /** How the transition was produced. */
  readonly note: RevisionNote;
  /** Fixed deterministic timestamp (replay/reproducibility invariant). */
  readonly created_at: string;
  readonly created_by: string;
}

/** The information state the history log starts from (before revision 1). */
export interface RevisionBase {
  /** "created": empty root (document.create). "opened": snapshot without a
   *  persisted history (legacy artifact) — the opened state IS the base. */
  readonly origin: "created" | "opened";
  /** Document version at the base. */
  readonly version: VersionMeta;
  /** Base elements (empty for origin "created"). */
  readonly elements: readonly Element[];
  readonly sourceArtifactLineage: readonly string[];
}

/** Immutable, append-only model history persisted inside the document
 *  snapshot (save/open round-trips preserve it; LOCK-005/LOCK-012). */
export interface ModelHistory {
  readonly entity_id: string;
  readonly format: string;
  readonly formatVersion: string;
  /** Pre-log information state. */
  readonly base: RevisionBase;
  /** Monotonic counter for document-minted canonical element ids
   *  (`el-000001`, …). Never reused, so minted identities stay stable and
   *  collision-free across revisions and sessions. */
  readonly next_element_sequence: number;
  /** COMPAT-CAD-001 (additive + optional): monotonic counter for
   *  document-minted canonical layer ids (`ly-000001`, …). Never reused —
   *  mirrors `next_element_sequence`. Absent on legacy histories. */
  readonly next_layer_sequence?: number;
  /** COMPAT-CAD-003 (additive + optional): monotonic counter for
   *  document-minted documentation view ids (`vw-000001`, …). Never reused.
   *  Absent on legacy histories. */
  readonly next_view_sequence?: number;
  /** COMPAT-CAD-003 (additive + optional): monotonic counter for
   *  document-minted documentation sheet ids (`sh-000001`, …). Never reused.
   *  Absent on legacy histories. */
  readonly next_sheet_sequence?: number;
  /** Append-only revision log (revisions[i].revision_number === i + 1). */
  readonly revisions: readonly ModelRevision[];
}

// --- Graph-facing domain events (event-model.md §1/§2/§4) ------------------

/** Event types emitted at model/version boundaries (event-model.md §2). */
export type GraphModelEventType = "model.created" | "model.version.created";

/** Version of the graph-facing event contract (additive per api-contract.md §8). */
export const GRAPH_MODEL_EVENT_VERSION = "1" as const;

/** Reference to the revision an event was emitted for. revision_number 0
 *  denotes the history base (the `model.created` boundary). */
export interface RevisionRef {
  readonly revision_id: string;
  readonly revision_number: number;
  readonly version_id: string;
  readonly version_number: number;
  readonly parent_version_id: string | null;
  readonly content_hash: string;
}

/** Epistemic labels per §2.7 / LOCK-007. */
export type EpistemicLabel = "OBSERVED" | "CALCULATED" | "INFERRED" | "EXTRAPOLATED" | "GUESSED" | "UNKNOWN";

/** Per-element uncertainty state. Element identity is OBSERVED (the id is
 *  authoritative document state); engine provenance is UNKNOWN when the
 *  element carries no engineId. COMPAT-CAD-002: elements carrying the BIM mark
 *  have their authored semantics extracted (src/bim/semantics.ts) and are
 *  labelled OBSERVED; elements whose realized geometry attached a meshToken
 *  carry OBSERVED geometry provenance. Everything else stays UNKNOWN rather
 *  than guessed (LOCK-007). */
export interface ElementUncertainty {
  readonly identity: "OBSERVED";
  readonly geometry_provenance: "OBSERVED" | "UNKNOWN";
  readonly semantics: "OBSERVED" | "UNKNOWN";
}

/** Revision-level epistemic summary. geometry_provenance summarizes the
 *  affected elements' engine provenance: OBSERVED = every affected element
 *  carries engine provenance; UNKNOWN = none does; MIXED = some do. With no
 *  affected elements no provenance is asserted (labelled OBSERVED).
 *  COMPAT-CAD-002: semantics summarizes the affected elements' extracted BIM
 *  semantics with the same OBSERVED/UNKNOWN/MIXED aggregation (bim-mark
 *  gated — see the bridge). */
export interface RevisionUncertainty {
  readonly geometry_provenance: "OBSERVED" | "UNKNOWN" | "MIXED";
  readonly semantics: "OBSERVED" | "UNKNOWN" | "MIXED";
}

/** Canonical graph identity + provenance projection for one affected
 *  element. `graph_node_id` is a deterministic function of
 *  (document entity id, element id) — engine ids NEVER participate in
 *  canonical graph identity (LOCK-019; RESEARCH-CAD-003 identity findings). */
export interface GraphElementProjection {
  readonly graph_node_id: string;
  readonly element_id: string;
  readonly document_entity_id: string;
  readonly change: "added" | "removed" | "updated";
  readonly kind: ElementKind;
  /** Provenance ONLY — the source engine's id for this element, when known. */
  readonly engineId: string | null;
  readonly uncertainty: ElementUncertainty;
}

/** Revision provenance recorded on every graph-facing event. */
export interface RevisionProvenance {
  readonly document_entity_id: string;
  readonly format: string;
  readonly formatVersion: string;
  readonly origin: RevisionNote | "created" | "opened";
  readonly actor: string;
  readonly source_snapshot_id: string | null;
  readonly sourceArtifactLineage: readonly string[];
}

/** Payload of a graph-facing model event (event-model.md §4 payload fields
 *  ride the envelope; the payload carries the revision semantics). */
export interface GraphModelEventPayload {
  readonly revision: RevisionRef;
  readonly affected: RevisionDelta;
  readonly elements: readonly GraphElementProjection[];
  readonly provenance: RevisionProvenance;
  readonly uncertainty: RevisionUncertainty;
}

/** A deterministic graph-facing domain event (event-model.md §1/§4).
 *  All fields derive from deterministic inputs (fixed timestamps, content
 *  hashes) so the same history yields byte-identical events on every host,
 *  every run (Web/Electron semantic parity, §5.5). */
export interface GraphModelEvent {
  readonly event_id: string;
  readonly event_type: GraphModelEventType;
  readonly event_version: string;
  readonly occurred_at: string;
  readonly actor_type: "application";
  readonly actor_id: string;
  readonly source_entity_id: string;
  readonly source_version_id: string;
  readonly source_revision_id: string;
  /** Previous event id in the same stream (null for `model.created`). */
  readonly causation_id: string | null;
  /** Stable stream correlation id (the model entity id). */
  readonly correlation_id: string;
  readonly payload: GraphModelEventPayload;
}

/** Result of bridging a model history into the graph-facing event stream. */
export interface GraphBridgeResult {
  readonly events: readonly GraphModelEvent[];
  /** SHA-256 over the canonical encoding of the event list — the
   *  determinism/parity anchor for the bridge. */
  readonly events_hash: string;
}

/** Result of a deterministic historical replay (information-state correct,
 *  no future leakage: only the base + the first k revisions are consumed). */
export interface ModelReplayResult {
  readonly revision_number: number;
  readonly revision_id: string;
  readonly elements: readonly Element[];
  readonly content_hash: string;
  /** True when the replayed content hash matches the hash recorded on the
   *  target revision (integrity verification, LOCK-005). */
  readonly verified: boolean;
}
