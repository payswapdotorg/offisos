/**
 * CAD-PARITY-016 remediation (Issue #112, the Architect CHANGES REQUESTED) —
 * the durable/shared persistence boundary for the P016 collaboration,
 * recovery and jobs state (Architecture v1.1 FROZEN, additive, engine-free).
 *
 * THE CONTRACT (the review's two blockers, closed with one boundary):
 *  - Durability: recovery checkpoints and their content-addressed snapshot
 *    blobs are PERSISTED — they survive handler restarts, process death and
 *    document replacement (the project record keyed by the canonical
 *    document entity id remains; a reopened document recovers them).
 *  - Shared state: the project-scoped members/presence/comments/activity/
 *    transactions/merge-lineage live in ONE project record per document
 *    entity — every participant/session/handler/instance reads and appends
 *    the SAME record, so independent requests converge on the same state.
 *
 * THE SEMANTICS (Architecture v1.1 §6, "PostgreSQL/Construction Graph/
 * object storage remain authoritative; caches and worker outputs remain
 * support mechanisms"):
 *  - `append` is the SERIALIZATION POINT: the adapter loads the project's
 *    current record, runs the caller's PURE transition, and durably records
 *    the resulting state as the project's next event. Under store-level
 *    contention the transition is re-run against the freshly-read state
 *    (bounded retries) — never a lost update, never a silent merge.
 *  - Checkpoint snapshot contents are immutable, content-addressed blobs
 *    (the checkpoint view's contentHash IS the address) — object-storage
 *    semantics, deduplicated by construction.
 *  - The project clock ticks EXACTLY once per persisted project event: the
 *    deterministic timeline. Every P016 output remains a pure function of
 *    the persisted event sequence (fixture-pinnable across backends).
 *  - Backends (the closed vocabulary, wired by the HOSTS — the engine-
 *    adapter pattern at LOCK-003 applied to persistence):
 *      "memory"   — the in-process deterministic store (app tests, host
 *                   parity, dev without a store; per-handler by default).
 *      "file"     — the host filesystem store (the Electron host: durable
 *                   across app restarts; atomic tmp+rename writes).
 *      "postgres" — the transactional SQL store (the web host with
 *                   DATABASE_URL; unique-key event serialization —
 *                   PostgreSQL authority semantics).
 *      "blob"     — the object-storage event log (the web deployment with
 *                   BLOB_READ_WRITE_TOKEN; create-if-absent event claims +
 *                   bounded retry = the serialized append).
 *  - A host that wires NO persistence and provides no explicit memory
 *    opt-in gets the fail-closed adapter: P016 commands fail with the typed
 *    `p016_persistence_unconfigured` error — honest, never a silent
 *    in-memory degradation of the shared-state contract.
 *
 * LOCK-019 is preserved unchanged: the CADDocument remains the single
 * canonical system of record; this boundary never mutates a document.
 * Engine isolation (LOCK-018): this module is pure TypeScript — no engine
 * imports, no environment reads, no wall-clock (the adapters own I/O).
 */

import type {
  JobsPersistedState,
  P016PersistBackend,
  P016PersistenceView,
  PersistedP016State,
} from "../contracts/collab.js";

/** The typed persistence failure (surfaces as an app-api typed err). */
export class P016PersistError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The immutable, content-addressed blob a transition may emit (the
 *  checkpoint snapshot contents; the sha IS the store address — a repeated
 *  write is an idempotent dedup, never a mutation). */
export interface P016BlobWrite {
  readonly sha: string;
  readonly content: unknown;
}

/** The pure transition result: the next durable state, optional immutable
 *  blobs, and the caller's result value. The transition MUST be a pure
 *  function of (state) — it is re-run on store-level contention. */
export interface P016Transition<T> {
  readonly state: PersistedP016State;
  readonly blobs?: readonly P016BlobWrite[] | undefined;
  readonly result: T;
}

/** The append outcome: the persisted event count (== the project clock
 *  after the event) and the transition's result. */
export interface P016AppendOutcome<T> {
  readonly eventCount: number;
  readonly result: T;
}

/**
 * The durable/shared project persistence port. ONE authoritative record per
 * project key (the canonical document entity id), versioned through
 * append-only events, with content-addressed immutable blobs.
 */
export interface P016Persist {
  /** The closed backend identity (observability + the honest evidence). */
  readonly backend: P016PersistBackend;

  /** The serialized durable append (the serialization point). Loads the
   *  project's current state (null when the project has no events yet),
   *  runs the PURE transition (possibly async — reads such as content-
   *  addressed blob fetches are fine; it is re-run under contention), emits
   *  the blobs and records the resulting state as the project's next event.
   *  Typed failure on contention exhaustion or backend errors — never a
   *  silent loss. */
  append<T>(
    projectKey: string,
    transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>>;

  /** The current persisted state (the fold of the event log) — read-only,
   *  never appends. Returns null when the project has no events. */
  read(projectKey: string): Promise<PersistedP016State | null>;

  /** Fetch an immutable content-addressed blob by sha (null when absent). */
  fetchBlob(sha: string): Promise<unknown | null>;

  /** The persistence observability view for a project. */
  status(projectKey: string): Promise<P016PersistenceView>;
}

/** The empty initial persisted state (clock 0 — the first event ticks to 1). */
export function emptyPersistedP016State(): PersistedP016State {
  return {
    clock: 0,
    collab: {
      members: [],
      comments: [],
      activity: [],
      transactions: [],
      seq: { member: 0, comment: 0, txn: 0, merge: 0, activity: 0 },
      presenceBeats: 0,
    },
    recovery: { checkpoints: [], nextSeq: 0 },
    jobs: { jobs: [], seq: 0, tickCount: 0 },
  };
}

/** Deep structural validation of a state read from a store (LOCK-007: a
 *  malformed record is rejected, never guessed or silently repaired). */
export function validatePersistedP016State(value: unknown): PersistedP016State {
  const state = value as PersistedP016State;
  if (typeof state !== "object" || state === null) {
    throw new P016PersistError("p016_persist_corrupt", "persisted state is not an object");
  }
  const problems: string[] = [];
  if (typeof state.clock !== "number" || !Number.isInteger(state.clock) || state.clock < 0) {
    problems.push("clock must be a non-negative integer");
  }
  const has = (o: unknown, k: string) =>
    o !== null && typeof o === "object" && k in (o as Record<string, unknown>);
  if (!has(state, "collab") || !has(state, "recovery") || !has(state, "jobs")) {
    problems.push("collab/recovery/jobs sections are all required");
  } else {
    const { collab, recovery, jobs } = state;
    if (
      !Array.isArray(collab.members) ||
      !Array.isArray(collab.comments) ||
      !Array.isArray(collab.activity) ||
      !Array.isArray(collab.transactions)
    ) {
      problems.push("collab arrays malformed");
    }
    if (!Array.isArray(recovery.checkpoints) || typeof recovery.nextSeq !== "number") {
      problems.push("recovery section malformed");
    }
    const jobsState = jobs as JobsPersistedState;
    if (
      !Array.isArray(jobsState.jobs) ||
      typeof jobsState.seq !== "number" ||
      typeof jobsState.tickCount !== "number"
    ) {
      problems.push("jobs section malformed");
    }
  }
  if (problems.length > 0) {
    throw new P016PersistError(
      "p016_persist_corrupt",
      `persisted project state failed validation: ${problems.join("; ")}`,
    );
  }
  return state;
}

/**
 * The deterministic in-process memory adapter (the default for tests, the
 * host-parity suite and dev without a store). Shares state across every
 * handler constructed with the SAME instance — the cross-handler sharing
 * test basis. NOT durable across processes (backend identity: "memory" —
 * honestly reported, never silently substituted).
 */
export class MemoryP016Persist implements P016Persist {
  readonly backend = "memory" as const;

  private readonly projects = new Map<string, { eventCount: number; state: PersistedP016State }>();
  private readonly blobs = new Map<string, unknown>();

  async append<T>(
    projectKey: string,
    transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>> {
    const current = this.projects.get(projectKey);
    const state = current?.state ?? null;
    const t = await transition(state);
    for (const blob of t.blobs ?? []) {
      if (!this.blobs.has(blob.sha)) {
        this.blobs.set(blob.sha, blob.content);
      }
    }
    const eventCount = (current?.eventCount ?? 0) + 1;
    this.projects.set(projectKey, { eventCount, state: t.state });
    return { eventCount, result: t.result };
  }

  async read(projectKey: string): Promise<PersistedP016State | null> {
    return this.projects.get(projectKey)?.state ?? null;
  }

  async fetchBlob(sha: string): Promise<unknown | null> {
    return this.blobs.get(sha) ?? null;
  }

  async status(projectKey: string): Promise<P016PersistenceView> {
    return {
      backend: this.backend,
      projectKey,
      eventCount: this.projects.get(projectKey)?.eventCount ?? 0,
    };
  }
}

/**
 * The fail-closed adapter: a host that wired no persistence store and did
 * not explicitly opt into the (non-shared) memory backend gets typed
 * failures on every P016 command — the shared-state contract is never
 * silently degraded to per-handler memory.
 */
export class FailClosedP016Persist implements P016Persist {
  readonly backend = "memory" as const;

  private fail(): never {
    throw new P016PersistError(
      "p016_persistence_unconfigured",
      "the P016 collaboration/recovery persistence backend is not configured for this host " +
        "(set DATABASE_URL, BLOB_READ_WRITE_TOKEN, or OFFISOS_P016_PERSIST=memory for local development)",
    );
  }

  append<T>(
    _projectKey: string,
    _transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>> {
    return Promise.reject(this.failure());
  }

  read(_projectKey: string): Promise<PersistedP016State | null> {
    return Promise.reject(this.failure());
  }

  fetchBlob(_sha: string): Promise<unknown | null> {
    return Promise.reject(this.failure());
  }

  status(_projectKey: string): Promise<P016PersistenceView> {
    return Promise.reject(this.failure());
  }

  private failure(): P016PersistError {
    return new P016PersistError(
      "p016_persistence_unconfigured",
      "the P016 collaboration/recovery persistence backend is not configured for this host " +
        "(set DATABASE_URL, BLOB_READ_WRITE_TOKEN, or OFFISOS_P016_PERSIST=memory for local development)",
    );
  }
}

/** The canonical blob JSON encoding shared by the durable adapters (the
 *  stable serialization for content addressing — key order preserved by
 *  construction in the emitted objects). */
export function encodeBlob(content: unknown): string {
  return JSON.stringify(content);
}
