/**
 * CAD-PARITY-016 remediation — the host-filesystem persistence adapter
 * (backend identity: "file"; the Electron host's durable store).
 *
 * Semantics: identical to the port contract — the per-project event log is
 * an append-only sequence of full-state snapshot files
 * (`projects/<encoded-key>/ev-<n>.json`, claimed at n = max+1), the
 * checkpoint snapshot contents are content-addressed immutable blobs
 * (`blobs/<sha>.json`, idempotent dedup), and every write is atomic
 * (tmp file + rename, fsync'd) so a crash mid-write never leaves a torn
 * record (LOCK-007: a malformed record is rejected typed, never guessed).
 * Durable across process restarts — the crash-recovery boundary for the
 * desktop host.
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  P016PersistError,
  encodeBlob,
  validatePersistedP016State,
  type P016AppendOutcome,
  type P016Persist,
  type P016Transition,
} from "./index.js";
import type {
  P016PersistenceView,
  PersistedP016State,
} from "../contracts/collab.js";

/** Encode a project key as a safe path segment (the document entity id is
 *  the key; UUID-like and slug ids pass through unchanged). */
function encodeKey(projectKey: string): string {
  const safe = projectKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
}

/** The n of an event file name (ev-000001.json → 1), or null when the name
 *  is not an event file (defensive — unknown files are ignored, never
 *  guessed into the log). */
function eventNumberOf(name: string): number | null {
  const match = /^ev-(\d{6,})\.json$/.exec(name);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export class FileP016Persist implements P016Persist {
  readonly backend = "file" as const;

  private readonly rootDir: string;
  /** The in-process write mutex (single writer per adapter — the host
   *  process serializes appends; cross-process serialization is the
   *  underlying filesystem's atomic rename). */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private projectDir(projectKey: string): string {
    return join(this.rootDir, "projects", encodeKey(projectKey));
  }

  private blobsDir(): string {
    return join(this.rootDir, "blobs");
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }

  /** Atomic write: tmp file in the SAME directory + rename (a reader never
   *  observes a torn file). */
  private atomicWrite(path: string, text: string): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, { encoding: "utf8" });
    renameSync(tmp, path);
  }

  /** The current event count (the highest claimed n; 0 when none). */
  private eventCountOf(projectKey: string): number {
    const dir = this.projectDir(projectKey);
    if (!existsSync(dir)) return 0;
    let max = 0;
    for (const name of readdirSync(dir)) {
      const n = eventNumberOf(name);
      if (n !== null && n > max) max = n;
    }
    return max;
  }

  private readEvent(projectKey: string, n: number): PersistedP016State {
    const path = join(this.projectDir(projectKey), `ev-${String(n).padStart(6, "0")}.json`);
    const raw = JSON.parse(readFileSync(path, { encoding: "utf8" })) as {
      state: unknown;
    };
    return validatePersistedP016State(raw.state);
  }

  async append<T>(
    projectKey: string,
    transition: (state: PersistedP016State | null) => P016Transition<T> | Promise<P016Transition<T>>,
  ): Promise<P016AppendOutcome<T>> {
    const run = async (): Promise<P016AppendOutcome<T>> => {
      // Read the current head (max-n event), run the pure transition,
      // claim n+1 with an atomic create (rename fails to overwrite is not
      // needed here — the in-process mutex serializes; the rename IS atomic
      // for readers).
      const dir = this.projectDir(projectKey);
      this.ensureDir(dir);
      const eventCount = this.eventCountOf(projectKey);
      const state = eventCount > 0 ? this.readEvent(projectKey, eventCount) : null;
      const t = await transition(state);
      for (const blob of t.blobs ?? []) {
        this.ensureDir(this.blobsDir());
        const blobPath = join(this.blobsDir(), `${blob.sha}.json`);
        if (!existsSync(blobPath)) {
          this.atomicWrite(blobPath, encodeBlob(blob.content));
        }
      }
      const n = eventCount + 1;
      const eventPath = join(dir, `ev-${String(n).padStart(6, "0")}.json`);
      if (existsSync(eventPath)) {
        throw new P016PersistError(
          "p016_persist_contention",
          `event ${n} for project '${projectKey}' already exists (concurrent writer)`,
        );
      }
      this.atomicWrite(eventPath, JSON.stringify({ n, state: t.state }));
      return { eventCount: n, result: t.result };
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  async read(projectKey: string): Promise<PersistedP016State | null> {
    const eventCount = this.eventCountOf(projectKey);
    if (eventCount === 0) return null;
    return this.readEvent(projectKey, eventCount);
  }

  async fetchBlob(sha: string): Promise<unknown | null> {
    const blobPath = join(this.blobsDir(), `${sha}.json`);
    if (!existsSync(blobPath)) return null;
    return JSON.parse(readFileSync(blobPath, { encoding: "utf8" })) as unknown;
  }

  async status(projectKey: string): Promise<P016PersistenceView> {
    return {
      backend: this.backend,
      projectKey,
      eventCount: this.eventCountOf(projectKey),
    };
  }
}
