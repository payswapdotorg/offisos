/**
 * CAD-PARITY-016 (Issue #112) — the collaboration core: project-scoped
 * members/permissions, presence, comments, activity, versioned
 * transactional changes with explicit conflict + merge/resolution lineage
 * (COLLAB-001..004; additive, engine-free, Architecture v1.1 FROZEN).
 *
 * Governing boundary (LOCK-019): this store is a SESSION-SIDE support
 * mechanism. It NEVER mutates the document: transactional changes are
 * applied through a caller-supplied executor (the handler's
 * doc.execute path — ONE atomic versioned revision per transaction), so
 * collaborative BIM/document changes keep the CADDocument as the single
 * canonical source of truth. Comments/presence/activity are linked to
 * canonical objects (element ids) and revisions (version numbers /
 * revision ids) wherever applicable.
 *
 * Determinism: every record carries session-clock units (one tick per
 * dispatched command) — the full store state is a pure function of the
 * command sequence (fixture-pinnable across hosts and the wire).
 */

import {
  COLLAB_ROLE_ABILITIES,
  PRESENCE_TTL,
  type ActivityKind,
  type ActivityView,
  type CollabMemberView,
  type CollabPersistedState,
  type CollabRole,
  type CommentTarget,
  type CommentTargetKind,
  type CommentView,
  type ConflictView,
  type MergeLineageView,
  type SessionClock,
  type TransactionStatus,
  type TransactionView,
} from "../contracts/collab.js";

/** Bounded activity ring size. */
const ACTIVITY_LIMIT = 100;

/** Bounded comment body length. */
export const COMMENT_BODY_MAX = 500;

/** The closed role vocabulary. */
export const COLLAB_ROLES: readonly CollabRole[] = ["viewer", "commenter", "editor"];

interface MemberRecord {
  readonly userId: string;
  role: CollabRole;
  readonly joinedAt: SessionClock;
  lastSeenAt: SessionClock | null;
  lastSeenVersion: number | null;
}

interface CommentRecord {
  readonly id: string;
  readonly userId: string;
  readonly body: string;
  readonly target: CommentTarget;
  resolved: boolean;
  resolvedBy: string | null;
  readonly createdAt: SessionClock;
  readonly documentVersion: number;
}

interface ActivityRecord {
  readonly seq: number;
  readonly at: SessionClock;
  readonly actor: string;
  readonly kind: ActivityKind;
  readonly detail: string;
}

interface TransactionRecord {
  readonly id: string;
  readonly author: string;
  readonly baseVersion: number;
  readonly touchedElementIds: readonly string[];
  /** The retained edit batch (replay basis for a rebase merge — never
   *  exposed in the wire view). */
  readonly edits: readonly unknown[];
  readonly editCount: number;
  status: TransactionStatus;
  readonly recordedAt: SessionClock;
  resultingVersion: number | null;
  conflict: ConflictView | null;
  merge: MergeLineageView | null;
}

/** Bounded collaboration failure (surfaces as an app-api typed err). */
export class CollabError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The edit-batch shape a versioned transaction carries (the atomic
 *  element-edit subset — structurally compatible with the canonical
 *  DocumentEdit members under exactOptionalPropertyTypes). */
export interface CollabEditShape {
  readonly type: string;
  readonly elementId?: string | undefined;
  readonly element?: { readonly id?: string | undefined } | undefined;
}

/**
 * The bounded project-scoped collaboration store.
 *
 * All methods are pure with respect to (command sequence → clock): the
 * caller supplies the current session clock and the canonical document
 * version; nothing reads wall-clock, random or environment state.
 */
export class CollabStore {
  private presenceBeats = 0;
  private readonly members = new Map<string, MemberRecord>();
  private readonly comments: CommentRecord[] = [];
  private readonly activity: ActivityRecord[] = [];
  private readonly transactions: TransactionRecord[] = [];
  private seq = { member: 0, comment: 0, txn: 0, merge: 0, activity: 0 };

  // --- members / presence (COLLAB-001) ------------------------------------

  /** Join the project (project-scoped membership). One member record per
   *  userId (a rejoin is the typed collab_exists decline — roles are
   *  assigned at join; the session is the project scope). */
  join(userId: string, role: CollabRole, clock: SessionClock): CollabMemberView {
    if (typeof userId !== "string" || userId.length === 0 || userId.length > 64) {
      throw new CollabError("collab_bad_payload", "collab.join requires a userId (1..64 chars)");
    }
    if (!COLLAB_ROLES.includes(role)) {
      throw new CollabError("collab_bad_payload", `collab.join role must be one of ${COLLAB_ROLES.join(" | ")}`);
    }
    if (this.members.has(userId)) {
      throw new CollabError("collab_exists", `member '${userId}' already joined this project session`);
    }
    this.seq.member += 1;
    const record: MemberRecord = {
      userId,
      role,
      joinedAt: clock,
      lastSeenAt: null,
      lastSeenVersion: null,
    };
    this.members.set(userId, record);
    this.pushActivity(clock, userId, "member.joined", `member '${userId}' joined as ${role}`);
    return this.memberView(record, clock);
  }

  /** Presence heartbeat (updates liveness + the revision the member is
   *  viewing). Returns the refreshed member view. */
  presence(userId: string, clock: SessionClock, currentVersion: number): CollabMemberView {
    const record = this.requireMember(userId);
    record.lastSeenAt = clock;
    record.lastSeenVersion = currentVersion;
    this.presenceBeats += 1;
    return this.memberView(record, clock);
  }

  /** The project-scoped member roster with computed liveness. */
  memberList(clock: SessionClock): readonly CollabMemberView[] {
    return [...this.members.values()].map((m) => this.memberView(m, clock));
  }

  /** Permission check (AUTH coverage — server-side, typed on violation). */
  requireAbility(userId: string, ability: string): MemberRecord {
    const record = this.requireMember(userId);
    const abilities = COLLAB_ROLE_ABILITIES[record.role];
    if (!abilities.has(ability)) {
      throw new CollabError(
        "collab_forbidden",
        `member '${userId}' (role ${record.role}) may not '${ability}' (requires ${
          ability === "comment" ? "commenter" : "editor"
        } or above)`,
      );
    }
    return record;
  }

  // --- comments (COLLAB-001) ----------------------------------------------

  /** Add a project-scoped comment linked to a canonical target (document /
   *  element id / model revision). */
  addComment(
    userId: string,
    body: string,
    target: CommentTarget,
    clock: SessionClock,
    currentVersion: number,
  ): CommentView {
    this.requireAbility(userId, "comment");
    if (typeof body !== "string" || body.trim().length === 0 || body.length > COMMENT_BODY_MAX) {
      throw new CollabError(
        "collab_bad_payload",
        `comment body must be 1..${COMMENT_BODY_MAX} chars (non-blank)`,
      );
    }
    const kind: CommentTargetKind = target.kind;
    if (kind !== "document" && kind !== "element" && kind !== "revision") {
      throw new CollabError("collab_bad_payload", "comment target kind must be document|element|revision");
    }
    if (kind === "element" && (typeof target.id !== "string" || target.id.length === 0)) {
      throw new CollabError("collab_bad_payload", "element comment target requires a canonical element id");
    }
    if (kind === "revision" && (typeof target.revisionRef !== "string" || target.revisionRef.length === 0)) {
      throw new CollabError("collab_bad_payload", "revision comment target requires a revisionRef");
    }
    if (kind === "document" && (target.id !== undefined || target.revisionRef !== undefined)) {
      throw new CollabError("collab_bad_payload", "document comment target carries no id/revisionRef");
    }
    this.seq.comment += 1;
    const id = `cmt-${String(this.seq.comment).padStart(6, "0")}`;
    const record: CommentRecord = {
      id,
      userId,
      body: body.trim(),
      target,
      resolved: false,
      resolvedBy: null,
      createdAt: clock,
      documentVersion: currentVersion,
    };
    this.comments.push(record);
    this.pushActivity(clock, userId, "comment.added", `comment ${id} on ${this.describeTarget(target)}`);
    return this.commentView(record);
  }

  /** Resolve a comment (the resolving member is recorded — lineage). */
  resolveComment(commentId: string, userId: string, clock: SessionClock): CommentView {
    this.requireAbility(userId, "comment");
    const record = this.comments.find((c) => c.id === commentId);
    if (record === undefined) {
      throw new CollabError("collab_not_found", `comment '${commentId}' does not exist`);
    }
    if (record.resolved) {
      throw new CollabError("collab_resolved", `comment '${commentId}' is already resolved`);
    }
    record.resolved = true;
    record.resolvedBy = userId;
    this.pushActivity(clock, userId, "comment.resolved", `comment ${commentId} resolved`);
    return this.commentView(record);
  }

  commentList(): readonly CommentView[] {
    return this.comments.map((c) => this.commentView(c));
  }

  // --- activity stream (COLLAB-001) ----------------------------------------

  activityList(): readonly ActivityView[] {
    return this.activity.map((a) => ({ ...a }));
  }

  /** Record a system-level P016 event (checkpoint saved, recovery restored,
   *  job lifecycle) into the activity stream under the deterministic
   *  "system" actor — the shared entry point the handler-side support
   *  modules use. */
  noteSystemEvent(kind: ActivityKind, detail: string, clock: SessionClock): void {
    this.pushActivity(clock, "system", kind, detail);
  }

  // --- versioned transactions (COLLAB-003/004) ------------------------------

  /**
   * Attempt a versioned transactional commit. The author declares the
   * baseVersion they authored against:
   *  - baseVersion === currentVersion → the executor applies the edits as
   *    ONE atomic versioned revision; the transaction records "applied"
   *    plus the resulting canonical version.
   *  - baseVersion < currentVersion → an explicit, reproducible conflict:
   *    the record names the intervening transactions and the overlapping
   *    canonical element ids. NOTHING is applied; the conflict is resolved
   *    later through the bounded merge vocabulary.
   *  - baseVersion > currentVersion is the typed collab_bad_base decline
   *    (a future base is corrupt, never guessed).
   */
  commit(
    author: string,
    baseVersion: number,
    edits: readonly CollabEditShape[],
    clock: SessionClock,
    currentVersion: number,
    executeAtomic: (edits: readonly unknown[]) => number,
  ): { view: TransactionView; applied: boolean } {
    this.requireAbility(author, "transact");
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      throw new CollabError("collab_bad_payload", "baseVersion must be a non-negative integer");
    }
    if (baseVersion > currentVersion) {
      throw new CollabError(
        "collab_bad_base",
        `baseVersion ${baseVersion} is ahead of the canonical document version ${currentVersion} (corrupt base, never guessed)`,
      );
    }
    const touched = touchedElementIdsOf(edits);
    this.seq.txn += 1;
    const id = `txn-${String(this.seq.txn).padStart(6, "0")}`;
    const record: TransactionRecord = {
      id,
      author,
      baseVersion,
      touchedElementIds: touched,
      edits,
      editCount: edits.length,
      status: "conflict",
      recordedAt: clock,
      resultingVersion: null,
      conflict: null,
      merge: null,
    };
    this.transactions.push(record);

    if (baseVersion === currentVersion) {
      let resultingVersion: number;
      try {
        resultingVersion = executeAtomic(edits);
      } catch (e) {
        // A failed application removes the record (the minted txn id is
        // burned — never reused, the mint contract) and the typed error
        // propagates to the caller.
        this.transactions.pop();
        throw e;
      }
      record.status = "applied";
      record.resultingVersion = resultingVersion;
      this.pushActivity(
        clock,
        author,
        "transaction.committed",
        `transaction ${id} applied ${edits.length} edit(s) at base v${baseVersion} → v${resultingVersion}`,
      );
      return { view: this.transactionView(record), applied: true };
    }

    // The explicit conflict (COLLAB-003/004): name the intervening
    // transactions and the reproducible overlap set.
    const intervening = this.transactions.filter(
      (t) =>
        t.id !== id &&
        (t.status === "applied" || t.status === "merged") &&
        t.resultingVersion !== null &&
        t.resultingVersion > baseVersion,
    );
    const interveningIds = intervening.map((t) => t.id);
    const interveningTouched = new Set<string>();
    for (const t of intervening) {
      for (const elementId of t.touchedElementIds) interveningTouched.add(elementId);
    }
    const overlapping = touched.filter((elementId) => interveningTouched.has(elementId));
    const conflict: ConflictView = {
      transactionId: id,
      baseVersion,
      currentVersion,
      interveningTransactions: interveningIds,
      overlappingElementIds: overlapping,
      status: "open",
    };
    record.conflict = conflict;
    this.pushActivity(
      clock,
      author,
      "transaction.conflict",
      `transaction ${id} conflicted at base v${baseVersion} (head v${currentVersion}, overlap ${overlapping.length})`,
    );
    return { view: this.transactionView(record), applied: false };
  }

  /**
   * Resolve an open conflict through the bounded strategy vocabulary with
   * recorded merge/resolution lineage (COLLAB-004):
   *  - "rebase": NON-overlapping edits re-apply onto the current head as
   *    ONE atomic versioned revision (lineage: [baseVersion, headVersion]);
   *    an overlapping rebase is the typed merge_conflict decline (the
   *    caller must edit or discard — never a silent overwrite).
   *  - "discard": the transaction is abandoned with its lineage recorded.
   */
  merge(
    transactionId: string,
    userId: string,
    strategy: "rebase" | "discard",
    clock: SessionClock,
    currentVersion: number,
    executeAtomic: (edits: readonly unknown[]) => number,
  ): { view: TransactionView; merge: MergeLineageView } {
    this.requireAbility(userId, "transact");
    const record = this.transactions.find((t) => t.id === transactionId);
    if (record === undefined) {
      throw new CollabError("collab_not_found", `transaction '${transactionId}' does not exist`);
    }
    if (record.status !== "conflict" || record.conflict === null || record.conflict.status !== "open") {
      throw new CollabError(
        "conflict_not_open",
        `transaction '${transactionId}' has no open conflict (status ${record.status})`,
      );
    }
    this.seq.merge += 1;
    const mergeId = `mrg-${String(this.seq.merge).padStart(6, "0")}`;
    if (strategy === "rebase") {
      if (record.conflict.overlappingElementIds.length > 0) {
        throw new CollabError(
          "merge_conflict",
          `rebase refused: ${record.conflict.overlappingElementIds.length} overlapping element(s) [${record.conflict.overlappingElementIds.join(", ")}] — edit the transaction or discard it (never a silent overwrite)`,
        );
      }
      const edits = record.edits;
      if (edits.length === 0) {
        throw new CollabError("collab_bad_payload", `transaction '${transactionId}' has no replayable edits`);
      }
      const resultingVersion = executeAtomic(edits);
      const merge: MergeLineageView = {
        mergeId,
        transactionId,
        strategy,
        parents: [record.baseVersion, currentVersion],
        resultingVersion,
        at: clock,
        rebasedEditCount: edits.length,
      };
      record.status = "merged";
      record.resultingVersion = resultingVersion;
      record.merge = merge;
      record.conflict = { ...record.conflict, status: "resolved" };
      this.pushActivity(
        clock,
        userId,
        "transaction.merged",
        `merge ${mergeId} rebased ${transactionId} (base v${record.baseVersion} + head v${currentVersion}) → v${resultingVersion}`,
      );
      return { view: this.transactionView(record), merge };
    }
    // "discard"
    const merge: MergeLineageView = {
      mergeId,
      transactionId,
      strategy,
      parents: [record.baseVersion, currentVersion],
      resultingVersion: null,
      at: clock,
      rebasedEditCount: 0,
    };
    record.status = "discarded";
    record.merge = merge;
    record.conflict = { ...record.conflict, status: "resolved" };
    this.pushActivity(
      clock,
      userId,
      "transaction.discarded",
      `merge ${mergeId} discarded ${transactionId} (base v${record.baseVersion} vs head v${currentVersion})`,
    );
    return { view: this.transactionView(record), merge };
  }

  transactionList(): readonly TransactionView[] {
    return this.transactions.map((t) => this.transactionView(t));
  }

  transactionById(id: string): TransactionView | null {
    const record = this.transactions.find((t) => t.id === id);
    return record !== undefined ? this.transactionView(record) : null;
  }

  // --- counters (the perf-budget evidence) ----------------------------------

  get commentCount(): number {
    return this.comments.length;
  }

  get presenceBeatCount(): number {
    return this.presenceBeats;
  }

  get transactionCount(): number {
    return this.transactions.length;
  }

  get conflictCount(): number {
    return this.transactions.filter((t) => t.conflict !== null).length;
  }

  get mergeCount(): number {
    return this.transactions.filter((t) => t.merge !== null).length;
  }

  // --- internals -------------------------------------------------------------

  private requireMember(userId: string): MemberRecord {
    const record = this.members.get(userId);
    if (record === undefined) {
      throw new CollabError("collab_not_joined", `member '${userId}' has not joined this project session`);
    }
    return record;
  }

  private memberView(record: MemberRecord, clock: SessionClock): CollabMemberView {
    const active =
      record.lastSeenAt !== null && clock - record.lastSeenAt <= PRESENCE_TTL ? true : false;
    return {
      userId: record.userId,
      role: record.role,
      joinedAt: record.joinedAt,
      lastSeenAt: record.lastSeenAt,
      active,
      lastSeenVersion: record.lastSeenVersion,
    };
  }

  private commentView(record: CommentRecord): CommentView {
    return {
      id: record.id,
      userId: record.userId,
      body: record.body,
      target: record.target,
      resolved: record.resolved,
      resolvedBy: record.resolvedBy,
      createdAt: record.createdAt,
      documentVersion: record.documentVersion,
    };
  }

  private transactionView(record: TransactionRecord): TransactionView {
    return {
      id: record.id,
      author: record.author,
      baseVersion: record.baseVersion,
      touchedElementIds: record.touchedElementIds,
      editCount: record.editCount,
      status: record.status,
      recordedAt: record.recordedAt,
      resultingVersion: record.resultingVersion,
      conflict: record.conflict,
      merge: record.merge,
    };
  }

  private describeTarget(target: CommentTarget): string {
    if (target.kind === "document") return "the document";
    if (target.kind === "element") return `element ${target.id}`;
    return `revision ${target.revisionRef}`;
  }

  private pushActivity(clock: SessionClock, actor: string, kind: ActivityKind, detail: string): void {
    this.seq.activity += 1;
    this.activity.push({ seq: this.seq.activity, at: clock, actor, kind, detail });
    while (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
  }

  // --- the durable/shared persistence boundary (the P016 remediation) -----

  /** Rehydrate the store from the durable project record's collab section
   *  (deep-copied into mutable session-side records — the record itself is
   *  never aliased). */
  static rehydrate(persisted: CollabPersistedState): CollabStore {
    const store = new CollabStore();
    for (const m of persisted.members) {
      store.members.set(m.userId, {
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        lastSeenAt: m.lastSeenAt,
        lastSeenVersion: m.lastSeenVersion,
      });
    }
    store.comments.push(
      ...persisted.comments.map((c) => ({
        id: c.id,
        userId: c.userId,
        body: c.body,
        target: { ...c.target },
        resolved: c.resolved,
        resolvedBy: c.resolvedBy,
        createdAt: c.createdAt,
        documentVersion: c.documentVersion,
      })),
    );
    store.activity.push(
      ...persisted.activity.map((a) => ({
        seq: a.seq,
        at: a.at,
        actor: a.actor,
        kind: a.kind as ActivityKind,
        detail: a.detail,
      })),
    );
    store.transactions.push(
      ...persisted.transactions.map((t) => ({
        id: t.id,
        author: t.author,
        baseVersion: t.baseVersion,
        touchedElementIds: [...t.touchedElementIds],
        edits: [...t.edits],
        editCount: t.editCount,
        status: t.status,
        recordedAt: t.recordedAt,
        resultingVersion: t.resultingVersion,
        conflict: t.conflict === null ? null : { ...t.conflict },
        merge: t.merge === null ? null : { ...t.merge },
      })),
    );
    store.seq = {
      member: persisted.seq.member,
      comment: persisted.seq.comment,
      txn: persisted.seq.txn,
      merge: persisted.seq.merge,
      activity: persisted.seq.activity,
    };
    store.presenceBeats = persisted.presenceBeats;
    return store;
  }

  /** Dehydrate the store into the serializable durable record section. */
  dehydrate(): CollabPersistedState {
    return {
      members: [...this.members.values()].map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        lastSeenAt: m.lastSeenAt,
        lastSeenVersion: m.lastSeenVersion,
      })),
      comments: this.comments.map((c) => ({
        id: c.id,
        userId: c.userId,
        body: c.body,
        target: { ...c.target },
        resolved: c.resolved,
        resolvedBy: c.resolvedBy,
        createdAt: c.createdAt,
        documentVersion: c.documentVersion,
      })),
      activity: this.activity.map((a) => ({
        seq: a.seq,
        at: a.at,
        actor: a.actor,
        kind: a.kind,
        detail: a.detail,
      })),
      transactions: this.transactions.map((t) => ({
        id: t.id,
        author: t.author,
        baseVersion: t.baseVersion,
        touchedElementIds: [...t.touchedElementIds],
        edits: [...t.edits],
        editCount: t.editCount,
        status: t.status,
        recordedAt: t.recordedAt,
        resultingVersion: t.resultingVersion,
        conflict: t.conflict === null ? null : { ...t.conflict },
        merge: t.merge === null ? null : { ...t.merge },
      })),
      seq: { ...this.seq },
      presenceBeats: this.presenceBeats,
    };
  }

  /** The retained edit batch of a transaction (the rebase replay basis —
   *  the handler replays the winning rebase on the real session document
   *  exactly once, after the durable append). */
  replayableEditsOf(transactionId: string): readonly unknown[] {
    const record = this.transactions.find((t) => t.id === transactionId);
    return record === undefined ? [] : [...record.edits];
  }
}

/** The canonical element ids an edit batch touches (the overlap basis). */
export function touchedElementIdsOf(edits: readonly CollabEditShape[]): readonly string[] {
  const ids: string[] = [];
  for (const edit of edits) {
    if (edit.type === "addElement" && typeof edit.element?.id === "string") {
      ids.push(edit.element.id);
    } else if (
      (edit.type === "removeElement" || edit.type === "updateElement" || edit.type === "setProps") &&
      typeof edit.elementId === "string"
    ) {
      ids.push(edit.elementId);
    }
  }
  return [...new Set(ids)].sort();
}