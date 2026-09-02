/**
 * CAD-PARITY-016 remediation — the PostgreSQL persistence adapter for the
 * web host (backend identity: "postgres"; selected by DATABASE_URL).
 *
 * Architecture v1.1 §6: PostgreSQL is authoritative for structured domain
 * state and events. The mapping:
 *  - `p016_events (project_key, n, state)` — the append-only event log;
 *    the per-project sequence is claimed inside a transaction with a
 *    per-project advisory lock (the SERIALIZATION POINT — the same
 *    semantics the blob adapter's create-if-absent claim implements).
 *  - `p016_blobs (sha, content)` — the immutable content-addressed
 *    checkpoint snapshot blobs (object-storage semantics inside the
 *    authoritative store; insert-if-absent is an idempotent dedup).
 *
 * THE COLUMN TYPE IS `json`, NOT `jsonb` — a determinism requirement, not a
 * style choice. PostgreSQL `jsonb` NORMALIZES its input (object keys are
 * reordered, duplicates dropped) on write; the P016 byte-identity contract
 * requires every persistence adapter to round-trip the persisted state
 * EXACTLY as `dehydrate()` serialized it, so a state loaded from ANY backend
 * rehydrates into the SAME key order the pure transitions produce (memory,
 * file and blob adapters round-trip the serialization text verbatim). With
 * `jsonb`, a postgres round-trip reorders the stored objects' keys and the
 * rehydrated views serialize differently than the code-created ones — the
 * pinned-fixture byte-identity across backends breaks (observed as the
 * CI web-job fixture mismatch: `commentsSha256`). `json` validates JSON
 * syntax on write and preserves the exact text — PostgreSQL authority with
 * adapter-neutral determinism. Nothing here queries INTO the state (the
 * head read is by the `(project_key, n)` primary key), so jsonb's indexing
 * is not needed.
 *
 * The DDL is idempotent (CREATE TABLE IF NOT EXISTS at connect) and migrates
 * a pre-`json` table's columns (a database created by an earlier revision
 * of this adapter, e.g. a local dev database) in place. Engine isolation
 * (LOCK-018) is untouched — this is host wiring, not core.
 */

import { Pool, type PoolClient } from "pg";
import {
  P016PersistError,
  validatePersistedP016State,
  type P016AppendOutcome,
  type P016Persist,
  type P016Transition,
} from "@offisos/cad-app-shell/persist";
import type {
  P016PersistenceView,
  PersistedP016State,
} from "@offisos/cad-app-shell/contracts/collab";

/** The bounded append retries under cross-instance contention. */
const MAX_APPEND_ATTEMPTS = 5;

function lockKeyOf(projectKey: string): string {
  // The advisory lock key needs a stable 64-bit hash of the project key —
  // a plain FNV-1a (deterministic; the authoritative serialization is the
  // PK + row lock anyway, this only scopes the advisory lock). BigInt-free
  // arithmetic (the web tsconfig targets below ES2020 — parity with the
  // rest of the host).
  let hi = 0x811c9dc5;
  let lo = 0xdeadbeef;
  for (let i = 0; i < projectKey.length; i += 1) {
    const c = projectKey.charCodeAt(i);
    lo = (lo ^ c) >>> 0;
    lo = Math.imul(lo, 0x01000193) >>> 0;
    hi = (hi ^ ((c << 16) | (c >>> 8))) >>> 0;
    hi = Math.imul(hi, 0x85ebca6b) >>> 0;
  }
  // A signed 64-bit advisory-lock key as a decimal string (pg takes
  // bigint): compose the two 32-bit halves without BigInt literals.
  const combined = BigInt(hi) * BigInt(4294967296) + BigInt(lo);
  return BigInt.asIntN(64, combined).toString();
}

export class PostgresP016Persist implements P016Persist {
  readonly backend = "postgres" as const;

  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    // Serverless-honest pool sizing: each function instance keeps a small
    // warm pool; the provider terminates idles.
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=disable/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
    this.ready = this.migrate();
  }

  /** The idempotent DDL (CREATE TABLE IF NOT EXISTS) + the in-place column
   *  migration for tables created by an earlier revision of this adapter
   *  (jsonb columns — see the file header: the byte-identity contract
   *  requires the text-preserving `json` type). */
  private async migrate(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS p016_events (
          project_key TEXT NOT NULL,
          n BIGINT NOT NULL,
          state JSON NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (project_key, n)
        );
        CREATE TABLE IF NOT EXISTS p016_blobs (
          sha TEXT PRIMARY KEY,
          content JSON NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // A best-effort in-place migration for pre-existing jsonb columns (a
      // database written by the first revision of this adapter). The USING
      // cast re-serializes through jsonb's normalized text once; no schema
      // created after this revision ever takes this branch (data_type=json
      // → the check is a no-op).
      await this.pool.query(`
        DO $migrate$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'p016_events' AND column_name = 'state'
              AND data_type = 'jsonb'
          ) THEN
            ALTER TABLE p016_events ALTER COLUMN state TYPE json USING state::text::json;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'p016_blobs' AND column_name = 'content'
              AND data_type = 'jsonb'
          ) THEN
            ALTER TABLE p016_blobs ALTER COLUMN content TYPE json USING content::text::json;
          END IF;
        END
        $migrate$;
      `);
    } catch (e) {
      throw new P016PersistError(
        "p016_persist_failed",
        `postgres migration failed: ${(e as Error).message}`,
      );
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async append<T>(
    projectKey: string,
    transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      // Phase 1 — open the transaction + the per-project advisory lock +
      // the head read (backend I/O only: retryable).
      await this.ready;
      let client: PoolClient;
      try {
        client = await this.pool.connect();
      } catch (e) {
        lastError = e;
        continue; // a transient connection failure — the bounded retry
      }
      let state: PersistedP016State | null = null;
      try {
        await client.query("BEGIN");
        // The per-project serialization: the advisory transaction lock
        // (auto-released at COMMIT/ROLLBACK).
        await client.query("SELECT pg_advisory_xact_lock($1)", [lockKeyOf(projectKey)]);
        // The current head (max-n event, or none).
        const head = await client.query<{ state: unknown }>(
          "SELECT state FROM p016_events WHERE project_key = $1 ORDER BY n DESC LIMIT 1",
          [projectKey],
        );
        if ((head.rowCount ?? 0) > 0) {
          state = validatePersistedP016State(head.rows[0]!.state);
        }
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        lastError = e;
        continue; // a transient backend failure — the bounded retry
      }
      // Phase 2 — the PURE transition. DOMAIN ERRORS PROPAGATE UNCHANGED
      // (never retried, never rewritten — they are the command's own typed
      // declines); the open transaction is rolled back first.
      let t: P016Transition<T>;
      try {
        t = await transition(state);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        throw e;
      }
      // Phase 3 — the durable writes + the commit (retryable; the unique
      // event key is the contention signal).
      try {
        // The immutable content-addressed blobs (insert-if-absent =
        // idempotent dedup).
        for (const blob of t.blobs ?? []) {
          await client.query(
            "INSERT INTO p016_blobs (sha, content) VALUES ($1, $2::json) ON CONFLICT (sha) DO NOTHING",
            [blob.sha, JSON.stringify(blob.content)],
          );
        }
        // The event append (the commit point).
        const maxRes = await client.query<{ max: string | null }>(
          "SELECT MAX(n) AS max FROM p016_events WHERE project_key = $1",
          [projectKey],
        );
        const max = maxRes.rows[0]?.max;
        const eventCount = (max === null || max === undefined ? 0 : Number(max)) + 1;
        await client.query(
          "INSERT INTO p016_events (project_key, n, state) VALUES ($1, $2, $3::json)",
          [projectKey, eventCount, JSON.stringify(t.state)],
        );
        await client.query("COMMIT");
        client.release();
        return { eventCount, result: t.result };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        lastError = e;
        if (e instanceof P016PersistError && e.code === "p016_persist_corrupt") {
          throw e; // a corrupt record is never retried into existence
        }
        // contention (unique key) or a transient backend failure → the
        // bounded retry (the pure transition re-runs inside a fresh
        // transaction)
        continue;
      }
    }
    throw new P016PersistError(
      "p016_persist_failed",
      `postgres append for project '${projectKey}' did not succeed after ${MAX_APPEND_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? "unknown"}`,
    );
  }

  async read(projectKey: string): Promise<PersistedP016State | null> {
    return this.withClient(async (client) => {
      const head = await client.query<{ state: unknown }>(
        "SELECT state FROM p016_events WHERE project_key = $1 ORDER BY n DESC LIMIT 1",
        [projectKey],
      );
      if ((head.rowCount ?? 0) === 0) return null;
      return validatePersistedP016State(head.rows[0]!.state);
    });
  }

  async fetchBlob(sha: string): Promise<unknown | null> {
    return this.withClient(async (client) => {
      const res = await client.query<{ content: unknown }>(
        "SELECT content FROM p016_blobs WHERE sha = $1",
        [sha],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return res.rows[0]!.content as unknown;
    });
  }

  async status(projectKey: string): Promise<P016PersistenceView> {
    return this.withClient(async (client) => {
      const maxRes = await client.query<{ max: string | null }>(
        "SELECT MAX(n) AS max FROM p016_events WHERE project_key = $1",
        [projectKey],
      );
      const max = maxRes.rows[0]?.max;
      return {
        backend: this.backend,
        projectKey,
        eventCount: max === null || max === undefined ? 0 : Number(max),
      };
    });
  }

  /** Close the pool (test teardown / graceful shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
