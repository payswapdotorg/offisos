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

/** The persisted internal checkpoint (the view + the captured snapshot). */
interface InternalCheckpoint {
  readonly view: CheckpointView;
  readonly snapshot: unknown;
}

/**
 * The bounded checkpoint store. "Durable" within the session semantics of
 * the P016 slice: the store survives every request/command boundary of the
 * host session (the same lifetime the CADDocument session has), is
 * versioned (monotonic seq + the canonical document version + content hash
 * + the model revision head), and is traceable: every record cites the
 * canonical revision it captured. Crash/session recovery restores the
 * latest VALID checkpoint deterministically — a corrupt latest falls back
 * down the list with a typed, recorded reason (never a silent repair).
 */
export class CheckpointStore {
  private readonly records: InternalCheckpoint[] = [];
  private nextSeq = 0;
  private readonly policy: RecoveryPolicy;

  constructor(policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY) {
    this.policy = policy;
  }

  get recoveryPolicy(): RecoveryPolicy {
    return this.policy;
  }

  get checkpointCount(): number {
    return this.records.length;
  }

  /** The retained checkpoint views (oldest first — insertion order). */
  list(): readonly CheckpointView[] {
    return this.records.map((r) => r.view);
  }

  byId(id: string): CheckpointView | null {
    const found = this.records.find((r) => r.view.id === id);
    return found !== undefined ? found.view : null;
  }

  /** Capture a checkpoint of the CURRENT canonical document state.
   *  Minted ids (`ckpt-NNNNNN`) are never reused; the retention window
   *  trims the OLDEST records first (bounded memory). */
  create(
    doc: CADDocument,
    cause: CheckpointCause,
    clock: SessionClock,
    mintId: (seq: number) => string,
  ): CheckpointView {
    this.nextSeq += 1;
    const snapshot = doc.snapshot();
    const version = snapshot.version;
    const head = headRevisionIdOf(doc.history);
    const view: CheckpointView = {
      id: mintId(this.nextSeq),
      seq: this.nextSeq,
      cause,
      entityId: version.entity_id,
      documentVersionId: version.version_id,
      documentVersionNumber: version.version_number,
      contentHash: doc.currentContentHash(),
      modelRevisionNumber: head.number,
      modelRevisionId: head.id,
      elementCount: snapshot.elements.length,
      at: clock,
    };
    this.records.push({ view, snapshot });
    while (this.records.length > this.policy.keep) {
      this.records.shift();
    }
    return view;
  }

  /** Deterministic crash/session recovery: scan the checkpoints from the
   *  LATEST to the oldest, restore the first one that (a) opens through the
   *  canonical path and (b) reproduces its recorded content hash exactly.
   *  Pre-restore safety checkpoints (captures of the state ABOUT to be
   *  replaced) are excluded from the DEFAULT scan — they are restorable
   *  only by explicit id. Every skipped candidate is reported with a typed
   *  reason. The returned document is the canonical rebuilt state
   *  (CADDocument.open — the same validation a persisted file round-trip
   *  gets). */
  scanAndRestore(
    requestedId: string | null,
    open: (snapshot: unknown) => CADDocument,
    contentHashOf: (doc: CADDocument) => string,
    xrefStatusOf: (doc: CADDocument) => readonly XrefStatusView[],
    clock: SessionClock,
  ): { doc: CADDocument; report: RecoveryReport } {
    const ordered = [...this.records].reverse(); // latest first
    const candidates =
      requestedId !== null
        ? ordered.filter((r) => r.view.id === requestedId)
        : ordered.filter((r) => r.view.cause !== "pre-restore");
    if (requestedId !== null && candidates.length === 0) {
      throw new Error(
        `recovery: requested checkpoint '${requestedId}' does not exist (retained: ${this.records.length})`,
      );
    }
    const skipped: { id: string; reason: string }[] = [];
    for (const candidate of candidates) {
      let restored: CADDocument;
      try {
        restored = open(candidate.snapshot);
      } catch (e) {
        skipped.push({
          id: candidate.view.id,
          reason: `open_failed: ${(e as Error).message.slice(0, 120)}`,
        });
        continue;
      }
      const hash = contentHashOf(restored);
      if (hash !== candidate.view.contentHash) {
        skipped.push({
          id: candidate.view.id,
          reason: `integrity_mismatch: recorded ${candidate.view.contentHash.slice(0, 12)}… restored ${hash.slice(0, 12)}…`,
        });
        continue;
      }
      const report: RecoveryReport = {
        requestedId,
        chosen: candidate.view,
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
}

/** The checkpoint id minting convention (`ckpt-NNNNNN`, six digits). */
export function checkpointIdOf(seq: number): string {
  return `ckpt-${String(seq).padStart(6, "0")}`;
}
