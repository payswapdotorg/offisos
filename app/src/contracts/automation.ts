/**
 * CAD-PARITY-017 (Issue #116) — the automation/extension/API shared contract
 * types (additive, Architecture v1.1 FROZEN).
 *
 * These are the bounded, versioned, typed automation surface contracts: the
 * capability registry view types, the script/extension MANIFEST types (data
 * only — never executable code), the principal/subscription/run view types,
 * the derived event-feed types and the persisted automation-state section.
 *
 * Governing boundary (LOCK-019, the P016 precedent): the Construction Graph /
 * CADDocument stays the canonical system of record. Automation is a CLIENT of
 * the governed semantic App API — every mutating script step dispatches
 * through the existing App API command path (the same validation, the same
 * idempotency, the same durable appends), so automation can NEVER mutate
 * canonical state through any other path. Extension manifests are
 * capability-scoped DATA; there is no executable extension surface in v1, so
 * extension code cannot import or bypass protected engine/renderer/domain
 * boundaries by construction (LOCK-003/018).
 *
 * Authorization boundary: the automation principal reuses the P016
 * collaboration role/ability table (contracts/collab.ts COLLAB_ROLE_ABILITIES
 * — the only role vocabulary in the system). No parallel identity or
 * permission subsystem is introduced; the closed ability set {read, presence,
 * comment, transact, jobs} is checked server-side on every automation
 * request, typed on violation.
 *
 * Determinism convention (the P016 session clock, unchanged): every mutating
 * command dispatched through the App API advances the virtual session clock
 * by one unit; all automation records carry clock units, never wall-clock.
 * Script execution is reproducible for identical canonical inputs and the
 * declared profile: the run outcome digest is a pure function of (canonical
 * document state, script manifest, profile) — no wall-clock, no random, no
 * environment reads.
 */

import type { ActivityKind, CollabRole, SessionClock } from "./collab.js";

// ---------------------------------------------------------------------------
// The automation API version + the execution profile (the declared
// environment — API-001: versioned public API surface, additive-only).
// ---------------------------------------------------------------------------

/** The automation contract version (additive-only: breaking changes create
 *  a new version — the App API §8 convention). */
export const AUTOMATION_API_VERSION = "1" as const;
export type AutomationApiVersion = typeof AUTOMATION_API_VERSION;

/** The closed profile vocabulary (the declared execution environment). v1
 *  ships exactly one profile; a script/extension manifest declares the
 *  profile it targets and the version it was authored against — a mismatch
 *  is the typed automation_version_unsupported decline, never a guess. */
export type AutomationProfileId = "standard";

export interface AutomationProfileView {
  readonly profileId: AutomationProfileId;
  readonly apiVersion: AutomationApiVersion;
  readonly description: string;
}

/** The declared v1 profile. */
export const AUTOMATION_PROFILE: AutomationProfileView = {
  profileId: "standard",
  apiVersion: AUTOMATION_API_VERSION,
  description:
    "The deterministic standard profile: typed App API capabilities only, session-clock semantics, bounded steps, no executable extension code, no network, no wall-clock, no random.",
};

// ---------------------------------------------------------------------------
// Bounds (the closed surface limits — every bound is enforced typed, never
// silently truncated).
// ---------------------------------------------------------------------------

/** Maximum steps per script manifest. */
export const AUTOMATION_MAX_STEPS = 64;
/** Maximum retained scripts per project. */
export const AUTOMATION_MAX_SCRIPTS = 32;
/** Maximum retained run records per project (oldest trimmed first). */
export const AUTOMATION_MAX_RUNS = 50;
/** Maximum registered principals per project. */
export const AUTOMATION_MAX_PRINCIPALS = 32;
/** Maximum subscriptions per principal. */
export const AUTOMATION_MAX_SUBSCRIPTIONS_PER_PRINCIPAL = 16;
/** Maximum registered extensions per project. */
export const AUTOMATION_MAX_EXTENSIONS = 16;
/** Maximum events delivered per automation.events query. */
export const AUTOMATION_MAX_EVENTS = 100;
/** Maximum scripts per extension manifest. */
export const AUTOMATION_MAX_EXTENSION_SCRIPTS = 8;
/** Maximum name/principalId/stepId length. */
export const AUTOMATION_ID_MAX = 64;
/** Maximum description length. */
export const AUTOMATION_DESCRIPTION_MAX = 200;
/** Maximum retained error message length in run step outcomes. */
export const AUTOMATION_MESSAGE_MAX = 200;

export interface AutomationBoundsView {
  readonly maxSteps: number;
  readonly maxScripts: number;
  readonly maxRuns: number;
  readonly maxPrincipals: number;
  readonly maxSubscriptionsPerPrincipal: number;
  readonly maxExtensions: number;
  readonly maxEvents: number;
  readonly maxExtensionScripts: number;
}

/** The closed bounds view (part of the capability-discovery surface). */
export const AUTOMATION_BOUNDS: AutomationBoundsView = {
  maxSteps: AUTOMATION_MAX_STEPS,
  maxScripts: AUTOMATION_MAX_SCRIPTS,
  maxRuns: AUTOMATION_MAX_RUNS,
  maxPrincipals: AUTOMATION_MAX_PRINCIPALS,
  maxSubscriptionsPerPrincipal: AUTOMATION_MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
  maxExtensions: AUTOMATION_MAX_EXTENSIONS,
  maxEvents: AUTOMATION_MAX_EVENTS,
  maxExtensionScripts: AUTOMATION_MAX_EXTENSION_SCRIPTS,
};

// ---------------------------------------------------------------------------
// Principals + the reused ability vocabulary (the authorization hook).
// ---------------------------------------------------------------------------

/** The automation role vocabulary — the P016 collab roles, unchanged (the
 *  single permission table; no parallel identity subsystem). */
export type AutomationRole = CollabRole;

/** The closed ability vocabulary — the exact COLLAB_ROLE_ABILITIES strings. */
export type AutomationAbility = "read" | "presence" | "comment" | "transact" | "jobs";

export interface AutomationPrincipalView {
  readonly principalId: string;
  readonly role: AutomationRole;
  /** Clock units at registration. */
  readonly registeredAt: SessionClock;
  /** Clock units at the last run this principal executed (null before). */
  readonly lastRunAt: SessionClock | null;
}

// ---------------------------------------------------------------------------
// The capability registry (discovery — the versioned public API surface).
// ---------------------------------------------------------------------------

export interface AutomationCapabilityView {
  /** The capability id — exactly the governed App API request name. */
  readonly capabilityId: string;
  readonly requestType: "command" | "query";
  /** Whether the capability mutates (commands always dispatch through the
   *  governed App API command path — the ONLY mutation route). */
  readonly mutating: boolean;
  /** The ability a principal's role must carry (checked server-side). */
  readonly requiredAbility: AutomationAbility;
  readonly description: string;
}

export interface AutomationCapabilitiesView {
  readonly apiVersion: AutomationApiVersion;
  readonly profile: AutomationProfileView;
  readonly capabilities: readonly AutomationCapabilityView[];
  readonly bounds: AutomationBoundsView;
  /** The canonical revision the discovery view is bound to (revision-bound
   *  automation results — the binding every automation result carries). */
  readonly documentVersion: number;
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Script manifests (typed data — the only scriptable unit in v1).
// ---------------------------------------------------------------------------

/** The closed step-kind vocabulary: v1 scripts reference governed App API
 *  requests ONLY. Any other kind (native code, http, eval…) is the typed
 *  automation_step_invalid decline — no fabricated semantics. */
export type AutomationStepKind = "appApi";

export interface AutomationStepRequest {
  readonly type: "command" | "query";
  /** Must be a capability id present in the registry (validated at
   *  registration AND at run — typed declines otherwise). */
  readonly name: string;
  /** The request payload — validated by the App API itself at dispatch (the
   *  SAME schema/boundary validation every direct request gets). */
  readonly payload: unknown;
}

export interface AutomationStepManifest {
  /** Unique within the script (1..64 chars). */
  readonly stepId: string;
  readonly kind: AutomationStepKind;
  readonly request: AutomationStepRequest;
  /** The deterministic error policy: "abort" (default) stops the run at the
   *  first failed step (status failed); "continue" records the typed failure
   *  and proceeds. Never a silent retry or a fabricated success. */
  readonly onError: "abort" | "continue";
}

export interface AutomationScriptManifest {
  /** 1..64 chars, unique per project together with the minted id. */
  readonly name: string;
  readonly profileId: AutomationProfileId;
  /** Must equal AUTOMATION_API_VERSION (typed decline otherwise). */
  readonly apiVersion: string;
  readonly description?: string;
  readonly steps: readonly AutomationStepManifest[];
}

// ---------------------------------------------------------------------------
// Extension manifests (capability-scoped DATA — no executable code).
// ---------------------------------------------------------------------------

export interface AutomationExtensionManifest {
  /** 1..64 chars, unique per project. */
  readonly extensionId: string;
  readonly name: string;
  /** 1..16 chars (the extension's own version string). */
  readonly version: string;
  readonly profileId: AutomationProfileId;
  readonly apiVersion: string;
  /** The declared capability set — every entry must exist in the registry
   *  (typed automation_capability_unsupported otherwise), and every script
   *  step below must stay within this declared set. */
  readonly capabilities: readonly string[];
  /** The scripts the extension installs at registration (each validated like
   *  a direct registration, and constrained to the declared capabilities). */
  readonly scripts: readonly AutomationScriptManifest[];
}

// ---------------------------------------------------------------------------
// The registered views (what the queries return).
// ---------------------------------------------------------------------------

export interface AutomationScriptView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly profileId: AutomationProfileId;
  readonly apiVersion: string;
  readonly principalId: string;
  /** The extension that installed this script (null = a direct
   *  registration). */
  readonly extensionId: string | null;
  readonly stepCount: number;
  readonly stepSummary: readonly string[];
  readonly registeredAt: SessionClock;
}

export interface AutomationExtensionView {
  readonly extensionId: string;
  readonly name: string;
  readonly version: string;
  readonly profileId: AutomationProfileId;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly scriptIds: readonly string[];
  readonly registeredAt: SessionClock;
  readonly registeredBy: string;
}

export interface AutomationStepOutcome {
  readonly stepId: string;
  readonly requestName: string;
  readonly ok: boolean;
  /** The typed error code (failed steps only). */
  readonly code?: string;
  /** The truncated typed error message (failed steps only). */
  readonly message?: string;
  /** The canonical document version AFTER the step. */
  readonly documentVersion: number;
  /** The canonical content-only hash AFTER the step (deterministic across
   *  re-runs — the reproducibility basis). */
  readonly contentHash: string;
}

export interface AutomationRunView {
  readonly id: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly principalId: string;
  readonly status: "completed" | "failed";
  readonly steps: readonly AutomationStepOutcome[];
  /** Clock units at run start (the durable project clock before the steps). */
  readonly startedAt: SessionClock;
  /** Clock units at the run-record append (the durable project clock). */
  readonly finishedAt: SessionClock;
  readonly startVersion: number;
  readonly endVersion: number;
  /** The canonical sha-256 over the deterministic step-outcome projection
   *  ({stepId, requestName, ok, code, documentVersion, contentHash} +
   *  start/end versions): identical canonical inputs + the same manifest +
   *  the declared profile → the identical digest (the reproducibility
   *  contract). Minted ids/clock are deliberately excluded. */
  readonly outcomeDigest: string;
  readonly reproducible: true;
}

// ---------------------------------------------------------------------------
// Subscriptions + the derived event feed (bounded, ordered, scoped).
// ---------------------------------------------------------------------------

/** The closed event-scope vocabulary (what a subscription listens to). */
export type AutomationEventScope = "document" | "project" | "jobs";

export interface AutomationSubscriptionView {
  readonly id: string;
  readonly principalId: string;
  readonly scope: AutomationEventScope;
  /** The kind filter (a subset of the activity vocabulary; null = every
   *  kind the scope produces). */
  readonly kinds: readonly string[] | null;
  readonly createdAt: SessionClock;
}

/** The event kinds — EXACTLY the P016 activity vocabulary (single
 *  vocabulary; the scopes select the SOURCE records, the kinds filter
 *  them). Revision-bound by construction: every event cites the canonical
 *  record it was derived from. */
export type AutomationEventKind = ActivityKind;

export interface AutomationEventView {
  /** The derived deterministic id (`evt:<recordKind>:<recordId>`). */
  readonly eventId: string;
  readonly kind: AutomationEventKind;
  readonly scope: AutomationEventScope;
  /** Clock units of the source record (the deterministic order). */
  readonly clock: SessionClock;
  readonly detail: string;
  /** The canonical record the event was derived from (the explicit
   *  authority binding — the event feed itself is NEVER authority). */
  readonly revisionBinding: {
    readonly recordKind: "transaction" | "checkpoint" | "job" | "activity";
    readonly recordId: string;
    readonly documentVersion: number | null;
  };
}

export interface AutomationEventsView {
  readonly principalId: string;
  readonly events: readonly AutomationEventView[];
  /** The derived-feed non-authority markers (the modelstream precedent:
   *  authoritative state lives in the durable canonical records — this feed
   *  is a pure fold, computed fresh every call, never persisted stale). */
  readonly authoritative: false;
  readonly bounded: true;
  readonly subscriptions: number;
  readonly clock: SessionClock;
}

// ---------------------------------------------------------------------------
// The persisted automation state (the durable project record section).
// ---------------------------------------------------------------------------

export interface AutomationPrincipalRecord {
  readonly principalId: string;
  readonly role: AutomationRole;
  readonly registeredAt: SessionClock;
  lastRunAt: SessionClock | null;
}

export interface AutomationScriptRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly profileId: AutomationProfileId;
  readonly apiVersion: string;
  readonly principalId: string;
  readonly extensionId: string | null;
  readonly steps: readonly AutomationStepManifest[];
  readonly registeredAt: SessionClock;
}

export interface AutomationRunRecord {
  readonly id: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly principalId: string;
  readonly status: "completed" | "failed";
  readonly steps: readonly AutomationStepOutcome[];
  readonly startedAt: SessionClock;
  readonly finishedAt: SessionClock;
  readonly startVersion: number;
  readonly endVersion: number;
  readonly outcomeDigest: string;
}

export interface AutomationSubscriptionRecord {
  readonly id: string;
  readonly principalId: string;
  readonly scope: AutomationEventScope;
  readonly kinds: readonly string[] | null;
  readonly createdAt: SessionClock;
}

export interface AutomationExtensionRecord {
  readonly extensionId: string;
  readonly name: string;
  readonly version: string;
  readonly profileId: AutomationProfileId;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly scriptIds: readonly string[];
  readonly registeredAt: SessionClock;
  readonly registeredBy: string;
}

/** The serializable automation-store state (the durable project record
 *  section; append-only-event versioned through the P016 persistence port —
 *  the SAME PostgreSQL/object-storage semantics, ONE shared record per
 *  canonical document entity id). */
export interface AutomationPersistedState {
  readonly principals: readonly AutomationPrincipalRecord[];
  readonly scripts: readonly AutomationScriptRecord[];
  readonly runs: readonly AutomationRunRecord[];
  readonly subscriptions: readonly AutomationSubscriptionRecord[];
  readonly extensions: readonly AutomationExtensionRecord[];
  readonly seq: {
    principal: number;
    script: number;
    run: number;
    subscription: number;
    extension: number;
  };
}

/** The empty initial automation state. */
export function emptyAutomationPersistedState(): AutomationPersistedState {
  return {
    principals: [],
    scripts: [],
    runs: [],
    subscriptions: [],
    extensions: [],
    seq: { principal: 0, script: 0, run: 0, subscription: 0, extension: 0 },
  };
}
