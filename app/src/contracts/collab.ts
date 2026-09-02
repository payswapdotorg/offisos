/**
 * CAD-PARITY-016 (Issue #112) — the collaboration/recovery/scale shared
 * contract types (additive, Architecture v1.1 FROZEN).
 *
 * These are the SESSION-SIDE support-record view types for the bounded
 * Phase 8 collaboration, recovery and scale surface. They are deliberately
 * NOT document snapshot records: per the P016 governing boundary, the
 * Construction Graph / CADDocument stays the canonical system of record and
 * collaboration state, recovery checkpoints, caches and worker outputs are
 * support mechanisms — linked to canonical objects/revisions wherever
 * applicable, never a parallel source of truth (LOCK-019).
 *
 * Determinism convention (the P016 session clock): every mutating command
 * dispatched through the App API advances a virtual session clock by one
 * unit. All P016 session records carry their timestamps as clock units
 * (monotonic integers), NOT wall-clock values, so every output is a pure
 * function of the command sequence and therefore fixture-pinnable and
 * reproducible across hosts, runs and the wire (LOCK-004 discipline).
 * Wall-clock observation exists ONLY in the smoke's performance-budget
 * assertions (never in pinned outputs).
 */

import type { Element } from "./caddocument.js";

// ---------------------------------------------------------------------------
// The session clock (virtual time — one tick per dispatched command).
// ---------------------------------------------------------------------------

/** Virtual session time in clock units (0 at session start). */
export type SessionClock = number;

/** Presence liveness window in clock units (a member is active when their
 *  last heartbeat is within this many dispatched commands). */
export const PRESENCE_TTL = 30;

// ---------------------------------------------------------------------------
// Collaboration — members, presence, comments, activity.
// ---------------------------------------------------------------------------

/** The bounded project-scoped collaboration role vocabulary (AUTH coverage:
 *  what each role may do is checked server-side, typed on violation). */
export type CollabRole = "viewer" | "commenter" | "editor";

/** What each role may do (the closed permission table). */
export const COLLAB_ROLE_ABILITIES: Readonly<Record<CollabRole, ReadonlySet<string>>> = {
  viewer: new Set(["presence", "read"]),
  commenter: new Set(["presence", "read", "comment"]),
  editor: new Set(["presence", "read", "comment", "transact", "jobs"]),
};

export interface CollabMemberView {
  readonly userId: string;
  readonly role: CollabRole;
  /** Clock units at join. */
  readonly joinedAt: SessionClock;
  /** Clock units at the last heartbeat (null before the first one). */
  readonly lastSeenAt: SessionClock | null;
  /** Liveness computed against the current clock (PRESENCE_TTL window). */
  readonly active: boolean;
  /** The document version_number the member last reported seeing. */
  readonly lastSeenVersion: number | null;
}

/** The bounded comment-target vocabulary — comments link to canonical
 *  objects (elements) or revisions, or the document as a whole. */
export type CommentTargetKind = "document" | "element" | "revision";

export interface CommentTarget {
  readonly kind: CommentTargetKind;
  /** Canonical element id (kind "element"). */
  readonly id?: string;
  /** Canonical model revision id (kind "revision"). */
  readonly revisionRef?: string;
}

export interface CommentView {
  readonly id: string;
  readonly userId: string;
  readonly body: string;
  readonly target: CommentTarget;
  readonly resolved: boolean;
  readonly resolvedBy: string | null;
  /** Clock units at creation. */
  readonly createdAt: SessionClock;
  /** The document version_number the comment was created against (the
   *  canonical revision binding — comments are traceable to revisions). */
  readonly documentVersion: number;
}

/** The bounded activity-stream vocabulary (append-only, last 100 retained). */
export type ActivityKind =
  | "member.joined"
  | "comment.added"
  | "comment.resolved"
  | "transaction.committed"
  | "transaction.conflict"
  | "transaction.merged"
  | "transaction.discarded"
  | "checkpoint.saved"
  | "recovery.restored"
  | "job.created"
  | "job.succeeded"
  | "job.failed";

export interface ActivityView {
  readonly seq: number;
  /** Clock units at the event. */
  readonly at: SessionClock;
  readonly actor: string;
  readonly kind: ActivityKind;
  /** Deterministic one-line summary (fixture-pinnable). */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Versioned transactions, conflicts and merge lineage.
// ---------------------------------------------------------------------------

/** The bounded versioned-transaction status vocabulary. */
export type TransactionStatus = "applied" | "conflict" | "merged" | "discarded";

export interface TransactionView {
  readonly id: string;
  readonly author: string;
  /** The document version_number the transaction was authored against. */
  readonly baseVersion: number;
  /** The canonical element ids the transaction touches (the reproducible
   *  overlap basis — visible lineage). */
  readonly touchedElementIds: readonly string[];
  readonly editCount: number;
  readonly status: TransactionStatus;
  /** Clock units when the transaction reached a terminal/recorded state. */
  readonly recordedAt: SessionClock;
  /** The document version_number produced by an applied/merged transaction. */
  readonly resultingVersion: number | null;
  readonly conflict: ConflictView | null;
  readonly merge: MergeLineageView | null;
}

/** An explicit, reproducible conflict record: the transaction was authored
 *  against baseVersion but the canonical document had already moved. */
export interface ConflictView {
  readonly transactionId: string;
  readonly baseVersion: number;
  /** The document version_number at the attempted commit. */
  readonly currentVersion: number;
  /** The transactions that moved the document past baseVersion (lineage). */
  readonly interveningTransactions: readonly string[];
  /** Canonical element ids touched by BOTH the intervening transactions and
   *  this one (the reproducible overlap set — empty overlap rebases clean). */
  readonly overlappingElementIds: readonly string[];
  readonly status: "open" | "resolved";
}

/** The recorded merge/resolution lineage (COLLAB-004): parents are the two
 *  document version_numbers the merge reconciled. */
export interface MergeLineageView {
  readonly mergeId: string;
  readonly transactionId: string;
  /** The closed resolution-strategy vocabulary. */
  readonly strategy: "rebase" | "discard";
  /** [baseVersion, headVersionAtMerge] — the reconciled parents. */
  readonly parents: readonly number[];
  readonly resultingVersion: number | null;
  readonly at: SessionClock;
  readonly rebasedEditCount: number;
}

// ---------------------------------------------------------------------------
// Recovery — durable, versioned checkpoints and deterministic restoration.
// ---------------------------------------------------------------------------

/** The bounded checkpoint-cause vocabulary. */
export type CheckpointCause = "manual" | "autosave" | "pre-restore";

/** The autosave policy (bounded, deterministic — a pure function of the
 *  command sequence). */
export interface RecoveryPolicy {
  /** Mutating commands between automatic autosave checkpoints. */
  readonly autosaveEvery: number;
  /** Maximum retained checkpoints (oldest trimmed first). */
  readonly keep: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = { autosaveEvery: 5, keep: 8 };

export interface CheckpointView {
  readonly id: string;
  readonly seq: number;
  readonly cause: CheckpointCause;
  readonly entityId: string;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  /** The canonical content-only hash at capture (integrity basis). */
  readonly contentHash: string;
  /** The canonical model revision head at capture (traceability). */
  readonly modelRevisionNumber: number;
  readonly modelRevisionId: string;
  readonly elementCount: number;
  readonly at: SessionClock;
}

/** The deterministic crash/session-recovery report: which checkpoint was
 *  chosen, which were skipped and why (typed, never silently repaired). */
export interface RecoveryReport {
  readonly requestedId: string | null;
  readonly chosen: CheckpointView;
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly restoredVersionNumber: number;
  readonly restoredContentHash: string;
  /** The fresh external-reference outcomes after restoration (the
   *  controlled lifecycle: records persist, statuses are recomputed). */
  readonly xrefOutcomes: readonly XrefStatusView[];
  readonly at: SessionClock;
}

// ---------------------------------------------------------------------------
// Background regeneration — durable job state (PLAT-004).
// ---------------------------------------------------------------------------

/** The bounded job-kind vocabulary (each runs through existing module
 *  boundaries; none ever mutates the canonical document). */
export type JobKind = "docs.regenerate" | "quantity.recalculate" | "model.stream.warm";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobResultSummary {
  readonly kind: JobKind;
  /** Deterministic per-kind report fields (fixture-pinnable). */
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface JobView {
  readonly id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  /** Completed steps (0..totalSteps). */
  readonly step: number;
  readonly totalSteps: number;
  readonly createdAt: SessionClock;
  readonly finishedAt: SessionClock | null;
  readonly result: JobResultSummary | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** The authority note — worker output is never promoted to canonical
   *  authority without explicit canonical persistence by the caller. */
  readonly persistHint: string;
}

// ---------------------------------------------------------------------------
// Large-model streaming — bounded access with explicit cache non-authority.
// ---------------------------------------------------------------------------

export interface StreamPageView {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly totalElements: number;
  readonly totalPages: number;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  /** The canonical content hash the page was derived from (the explicit
   *  non-authority binding: a version/hash mismatch is a typed stale
   *  outcome — cached pages are NEVER treated as canonical state). */
  readonly contentHash: string;
  /** Canonical id-sorted elements of the page (read-only views). */
  readonly elements: readonly Element[];
  readonly cacheHit: boolean;
}

export interface StreamCacheStatsView {
  readonly entries: number;
  readonly maxEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly staleEvictions: number;
  /** The explicit non-authority marker (cache contents are never
   *  authoritative — the document is). */
  readonly authoritative: false;
  readonly bounded: true;
}

// ---------------------------------------------------------------------------
// External references — fresh status with explicit outcomes.
// ---------------------------------------------------------------------------

/** The closed external-reference outcome vocabulary (Issue #112 scope:
 *  explicit unavailable/stale/unsupported outcomes). */
export type XrefOutcome = "available" | "unavailable" | "stale" | "unsupported";

export interface XrefStatusView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly recordStatus: "loaded" | "unresolved";
  readonly sourceHash: string | null;
  readonly entityCount: number;
  readonly instances: number;
  readonly outcome: XrefOutcome;
  /** Deterministic one-line explanation (fixture-pinnable). */
  readonly detail: string;
  /** The canonical revision the status was computed against (fresh, never
   *  persisted stale). */
  readonly revisionBinding: {
    readonly documentVersionNumber: number;
    readonly contentHash: string;
  };
}

export interface XrefProbeView {
  readonly id: string;
  readonly name: string;
  readonly recordSourceHash: string;
  readonly probedSourceHash: string;
  readonly outcome: XrefOutcome;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Observable performance budgets (revision-bound, deterministic counters).
// ---------------------------------------------------------------------------

export interface PerfBudgetRow {
  readonly workflow: string;
  /** The observable threshold. The smoke measures wall-clock per call and
   *  asserts this; measurements are reported to the run log and are NEVER
   *  pinned (only deterministic counters are pinned). */
  readonly thresholdMs: number;
  readonly unit: "ms";
  readonly measuredBy: "smoke-observed";
}

export interface PerfCountersView {
  readonly commands: number;
  readonly checkpoints: number;
  readonly autosaves: number;
  readonly restores: number;
  readonly comments: number;
  readonly presenceBeats: number;
  readonly transactions: number;
  readonly conflicts: number;
  readonly merges: number;
  readonly streamPages: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheStaleEvictions: number;
  readonly jobTicks: number;
}

export interface PerfBudgetsView {
  readonly revision: {
    readonly documentVersionId: string;
    readonly documentVersionNumber: number;
    readonly contentHash: string;
    readonly modelRevisionNumber: number;
    readonly modelRevisionId: string;
    readonly elementCount: number;
  };
  readonly budgets: readonly PerfBudgetRow[];
  readonly counters: PerfCountersView;
}
