/**
 * CAD-PARITY-016 remediation — the Vercel Blob persistence adapter for the
 * web host (backend identity: "blob"; selected by BLOB_READ_WRITE_TOKEN).
 *
 * Object-storage semantics over the store's primitives (the SAME port
 * contract as the postgres adapter):
 *  - Events: `projects/<key>/ev-<n>.json` — the append claims slot
 *    n = max+1 with a CREATE-IF-ABSENT put (`addRandomSuffix: false`,
 *    `allowOverwrite: false` — the store REJECTS the put when the blob
 *    exists). The claim IS the serialization point; a lost claim under
 *    cross-instance contention re-reads the log and re-runs the pure
 *    transition at the next slot (bounded retries, typed failure — never
 *    a lost update, never a silent merge).
 *  - The current state (the fold) = the max-n event's payload.
 *  - Checkpoint snapshot contents: `blobs/<sha>.json` — immutable,
 *    content-addressed, deduplicated by the same create-if-absent
 *    semantics (an existing blob at the sha IS the identical content).
 *
 * No wall-clock, no random state in the DATA path; the log order is the
 * claimed slot order — deterministic given the serialized command
 * sequence (single-writer sequences are fully deterministic).
 */

import { BlobNotFoundError, del, get, list, put } from "@vercel/blob";
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

function encodeKey(projectKey: string): string {
  const safe = projectKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
}

/** The claimed-slot file name (padded for the lexical max scan). */
function eventPathname(projectKey: string, n: number): string {
  return `projects/${encodeKey(projectKey)}/ev-${String(n).padStart(9, "0")}.json`;
}

function blobPathname(sha: string): string {
  return `blobs/${sha}.json`;
}

export class BlobP016Persist implements P016Persist {
  readonly backend = "blob" as const;

  constructor(private readonly token: string) {}

  private async headEvent(projectKey: string): Promise<{ n: number; state: PersistedP016State } | null> {
    // The current head = the highest-numbered event blob (lexically sorted
    // by the padded name). Unknown files are ignored, never guessed.
    const res = await list({ prefix: `projects/${encodeKey(projectKey)}/ev-`, token: this.token });
    let max = 0;
    for (const b of res.blobs) {
      const match = /ev-(\d{9})\.json$/.exec(b.pathname);
      if (match !== null) {
        const n = Number(match[1]);
        if (Number.isSafeInteger(n) && n > max) max = n;
      }
    }
    if (max === 0) return null;
    const text = await this.readBlobText(eventPathname(projectKey, max));
    if (text === null) {
      throw new P016PersistError("p016_persist_failed", `blob head event ${max} vanished mid-read`);
    }
    const raw = JSON.parse(text) as { n: number; state: unknown };
    return { n: max, state: validatePersistedP016State(raw.state) };
  }

  /** Read a blob's text (a missing blob is the typed null — the
   *  content-addressed fetch contract). */
  private async readBlobText(pathname: string): Promise<string | null> {
    let stream: ReadableStream<Uint8Array> | null = null;
    try {
      const g = await get(pathname, { token: this.token, access: "private" });
      stream = g === null ? null : g.stream;
    } catch (e) {
      if (e instanceof BlobNotFoundError || /not found/i.test(String((e as Error).message))) {
        return null;
      }
      throw new P016PersistError("p016_persist_failed", `blob get '${pathname}' failed: ${(e as Error).message}`);
    }
    if (stream === null) return null;
    return await new Response(stream).text();
  }

  async append<T>(
    projectKey: string,
    transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      // Phase 1 — read the current head (backend I/O only: retryable).
      let head: { n: number; state: PersistedP016State } | null;
      try {
        head = await this.headEvent(projectKey);
      } catch (e) {
        lastError = e;
        continue; // a transient backend read failure — the bounded retry
      }
      // Phase 2 — the PURE transition. DOMAIN ERRORS PROPAGATE UNCHANGED
      // (never retried, never rewritten — they are the command's own typed
      // declines). Only a contention retry re-runs the transition (pure).
      const t = await transition(head === null ? null : head.state);
      // Phase 3 — the durable writes (backend I/O: retryable; a rejected
      // event claim is the contention signal).
      try {
        // The immutable content-addressed blobs: create-if-absent; an
        // existing blob at the sha is the identical content (dedup).
        for (const blob of t.blobs ?? []) {
          try {
            await put(blobPathname(blob.sha), JSON.stringify(blob.content), {
              access: "private",
              addRandomSuffix: false,
              contentType: "application/json",
              token: this.token,
            });
          } catch (e) {
            const message = (e as Error).message;
            if (!/already exist|overwrite/i.test(message)) {
              throw new P016PersistError("p016_persist_failed", `blob put failed: ${message}`);
            }
            // The blob already exists at the sha — content-addressed
            // dedup, not an error.
          }
        }
        // The event claim: create-if-absent at n = max+1. A REJECTED put
        // means another writer claimed the slot first — retry the whole
        // pure transition at the next slot (bounded).
        const n = (head?.n ?? 0) + 1;
        try {
          await put(eventPathname(projectKey, n), JSON.stringify({ n, state: t.state }), {
            access: "private",
            addRandomSuffix: false,
            contentType: "application/json",
            token: this.token,
          });
        } catch (e) {
          const message = (e as Error).message;
          if (/already exist|overwrite/i.test(message)) {
            throw new P016PersistError("p016_persist_contention", `event slot ${n} was claimed concurrently`);
          }
          throw new P016PersistError("p016_persist_failed", `blob event put failed: ${message}`);
        }
        return { eventCount: n, result: t.result };
      } catch (e) {
        lastError = e;
        if (e instanceof P016PersistError && e.code === "p016_persist_corrupt") {
          throw e; // a corrupt record is never retried into existence
        }
        // contention or a transient backend write failure → the bounded
        // retry (the pure transition re-runs against the freshly-read head)
        continue;
      }
    }
    throw new P016PersistError(
      "p016_persist_failed",
      `blob append for project '${projectKey}' did not succeed after ${MAX_APPEND_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? "unknown"}`,
    );
  }

  async read(projectKey: string): Promise<PersistedP016State | null> {
    const head = await this.headEvent(projectKey);
    return head === null ? null : head.state;
  }

  async fetchBlob(sha: string): Promise<unknown | null> {
    const text = await this.readBlobText(blobPathname(sha));
    if (text === null) return null;
    return JSON.parse(text) as unknown;
  }

  async status(projectKey: string): Promise<P016PersistenceView> {
    const res = await list({ prefix: `projects/${encodeKey(projectKey)}/ev-`, token: this.token });
    let max = 0;
    for (const b of res.blobs) {
      const match = /ev-(\d{9})\.json$/.exec(b.pathname);
      if (match !== null) {
        const n = Number(match[1]);
        if (Number.isSafeInteger(n) && n > max) max = n;
      }
    }
    return { backend: this.backend, projectKey, eventCount: max };
  }

  /** Delete a project's event log + blobs (test cleanup ONLY — never used
   *  in the production wiring). */
  async purgeForTest(projectKey: string): Promise<void> {
    const events = await list({ prefix: `projects/${encodeKey(projectKey)}/`, token: this.token });
    for (const b of events.blobs) {
      await del(b.pathname, { token: this.token });
    }
  }
}
