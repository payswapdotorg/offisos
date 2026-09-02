/**
 * CAD-PARITY-016 (Issue #112) — the recovery core: durable, versioned
 * checkpoints with deterministic crash/session recovery (additive, engine-
 * free, Architecture v1.1 FROZEN).
 *
 * Governing boundary (LOCK-019): the CADDocument is the canonical system of
 * record. A checkpoint is a DERIVED support record — a content-hash-bound
 * capture of a canonical document revision. Restoration rebuilds the
 * document through the canonical `CADDocument.open` path (the same
 * validation a persisted file gets — LOCK-007: malformed state is rejected,
 * never guessed or silently repaired), so the restored document IS the
 * canonical document, not a parallel store.
 *
 * Determinism: every output is a pure function of the command sequence
 * (timestamps are session-clock units; the checkpoint list/scan order is
 * insertion order; integrity validation is hash-exact).
 */

import type { CADDocument } from "../caddocument/document.js";
import { baseContentHash, makeRevisionId } from "../caddocument/history.js";
import type { ModelHistory } from "../contracts/model.js";
import {
  DEFAULT_RECOVERY_POLICY,
  type CheckpointCause,
  type CheckpointView,
  type RecoveryPersistedState,
  type RecoveryPolicy,
  type RecoveryReport,
  type SessionClock,
  type XrefStatusView,
} from "../contracts/collab.js";

/** The canonical head revision id of a history (the same derivation the
 *  graph bridge and the quantities RevisionRef binding use — revision 0 is
 *  the base when no revision was recorded yet; ONE canonical formula). */
export function headRevisionIdOf(history: ModelHistory): { number: number; id: string } {
  if (history.revisions.length === 0) {
    return {
      number: 0,
      id: makeRevisionId(history.entity_id, 0, baseContentHash(history)),
    };
  }
  const head = history.revisions[history.revisions.length - 1]!;
  return { number: head.revision_number, id: head.revision_id };
}

/** The immutable, content-addressed checkpoint snapshot blob a mint emits
 *  (the view's contentHash IS the store address — object-storage semantics:
 *  immutable, deduplicated by construction; the durable adapters persist
 *  it, the memory adapter retains it). */
export interface CheckpointBlob {
  readonly sha: string;
  readonly content: unknown;
}

/** The mint outcome: the checkpoint VIEW plus the content-addressed
 *  snapshot blob to persist alongside it. */
export interface CheckpointMint {
  readonly view: CheckpointView;
  readonly blob: CheckpointBlob;
}

/**
 * The bounded checkpoint store. CAD-PARITY-016 remediation: the retained
 * records are the checkpoint VIEWS (metadata) — the snapshot CONTENTS live
 * in the durable persistence boundary as content-addressed immutable blobs
 * (the view's contentHash is the address). The whole store is serializable
 * (rehydrate/dehydrate) and re-binds to any handler/session: recovery from
 * a FRESH instance — after a handler restart, a process crash or a document
 * reopen — fetches the snapshots from the store and rebuilds through the
 * canonical `CADDocument.open` path exactly as an in-session restore does.
 *
 * The store is versioned (monotonic seq + the canonical document version +
 * content hash + the model revision head) and traceable: every record cites
 * the canonical revision it captured. Recovery restores the latest VALID
 * checkpoint deterministically — a corrupt or missing candidate falls back
 * down the list with a typed, recorded reason (never a silent repair).
 */
export class CheckpointStore {
  private readonly views: CheckpointView[] = [];
  private nextSeq = 0;
  private readonly policy: RecoveryPolicy;

  constructor(policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY) {
    this.policy = policy;
  }

  get recoveryPolicy(): RecoveryPolicy {
    return this.policy;
  }

  get checkpointCount(): number {
    return this.views.length;
  }

  /** The retained checkpoint views (oldest first — insertion order). */
  list(): readonly CheckpointView[] {
    return this.views.map((v) => ({ ...v }));
  }

  byId(id: string): CheckpointView | null {
    const found = this.views.find((v) => v.id === id);
    return found !== undefined ? { ...found } : null;
  }

  /** Capture a checkpoint of the CURRENT canonical document state. Minted
   *  ids (`ckpt-NNNNNN`) are never reused; the retention window trims the
   *  OLDEST records first (bounded records). Returns the view PLUS the
   *  content-addressed snapshot blob for the persistence boundary. */
  create(
    doc: CADDocument,
    cause: CheckpointCause,
    clock: SessionClock,
    mintId: (seq: number) => string,
  ): CheckpointMint {
    this.nextSeq += 1;
    const snapshot = doc.snapshot();
    const version = snapshot.version;
    const head = headRevisionIdOf(doc.history);
    const contentHash = doc.currentContentHash();
    const view: CheckpointView = {
      id: mintId(this.nextSeq),
      seq: this.nextSeq,
      cause,
      entityId: version.entity_id,
      documentVersionId: version.version_id,
      documentVersionNumber: version.version_number,
      contentHash,
      modelRevisionNumber: head.number,
      modelRevisionId: head.id,
      elementCount: snapshot.elements.length,
      at: clock,
    };
    this.views.push(view);
    while (this.views.length > this.policy.keep) {
      this.views.shift();
    }
    return { view: { ...view }, blob: { sha: contentHash, content: snapshot } };
  }

  /** Deterministic crash/session recovery: scan the checkpoints from the
   *  LATEST to the oldest, fetch each candidate's snapshot blob from the
   *  DURABLE store (the content-addressed fetch — the same path a fresh
   *  handler/instance takes), restore the first one that (a) opens through
   *  the canonical path and (b) reproduces its recorded content hash
   *  exactly. Pre-restore safety checkpoints (captures of the state ABOUT to
   *  be replaced) are excluded from the DEFAULT scan — they are restorable
   *  only by explicit id. Every skipped candidate is reported with a typed
   *  reason (a missing blob is `snapshot_missing`; a corrupt snapshot is
   *  `open_failed`/`integrity_mismatch`). The returned document is the
   *  canonical rebuilt state (CADDocument.open — the same validation a
   *  persisted file round-trip gets). */
  async scanAndRestore(
    requestedId: string | null,
    fetchSnapshot: (sha: string) => Promise<unknown | null>,
    open: (snapshot: unknown) => CADDocument,
    contentHashOf: (doc: CADDocument) => string,
    xrefStatusOf: (doc: CADDocument) => readonly XrefStatusView[],
    clock: SessionClock,
  ): Promise<{ doc: CADDocument; report: RecoveryReport }> {
    const ordered = [...this.views].reverse(); // latest first
    const candidates =
      requestedId !== null
        ? ordered.filter((v) => v.id === requestedId)
        : ordered.filter((v) => v.cause !== "pre-restore");
    if (requestedId !== null && candidates.length === 0) {
      throw new Error(
        `recovery: requested checkpoint '${requestedId}' does not exist (retained: ${this.views.length})`,
      );
    }
    const skipped: { id: string; reason: string }[] = [];
    for (const candidate of candidates) {
      const snapshot = await fetchSnapshot(candidate.contentHash);
      if (snapshot === null || snapshot === undefined) {
        skipped.push({
          id: candidate.id,
          reason: `snapshot_missing: no content-addressed blob at sha ${candidate.contentHash.slice(0, 12)}…`,
        });
        continue;
      }
      let restored: CADDocument;
      try {
        restored = open(snapshot);
      } catch (e) {
        skipped.push({
          id: candidate.id,
          reason: `open_failed: ${(e as Error).message.slice(0, 120)}`,
        });
        continue;
      }
      const hash = contentHashOf(restored);
      if (hash !== candidate.contentHash) {
        skipped.push({
          id: candidate.id,
          reason: `integrity_mismatch: recorded ${candidate.contentHash.slice(0, 12)}… restored ${hash.slice(0, 12)}…`,
        });
        continue;
      }
      const report: RecoveryReport = {
        requestedId,
        chosen: { ...candidate },
        skipped,
        restoredVersionNumber: restored.snapshot().version.version_number,
        restoredContentHash: hash,
        xrefOutcomes: xrefStatusOf(restored),
        at: clock,
      };
      return { doc: restored, report };
    }
    throw new Error(
      `recovery: no valid recoverable checkpoint (scanned ${candidates.length}, skipped ${skipped.length}: ${skipped
        .map((s) => s.id)
        .join(", ")})`,
    );
  }

  // --- the durable/shared persistence boundary (the P016 remediation) -----

  /** Rehydrate the store from the durable project record's recovery
   *  section (the checkpoint views; the snapshot contents are fetched from
   *  the store's content-addressed blobs at restore time). */
  static rehydrate(persisted: RecoveryPersistedState): CheckpointStore {
    const store = new CheckpointStore();
    store.views.push(...persisted.checkpoints.map((v) => ({ ...v })));
    store.nextSeq = persisted.nextSeq;
    return store;
  }

  /** Dehydrate the store into the serializable durable record section. */
  dehydrate(): RecoveryPersistedState {
    return {
      checkpoints: this.views.map((v) => ({ ...v })),
      nextSeq: this.nextSeq,
    };
  }
}

/** The checkpoint id minting convention (`ckpt-NNNNNN`, six digits). */
export function checkpointIdOf(seq: number): string {
  return `ckpt-${String(seq).padStart(6, "0")}`;
}
