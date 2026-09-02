/**
 * CAD-PARITY-016 remediation (the Architect CHANGES REQUESTED) — the
 * durable/shared persistence boundary tests: the port contract (memory +
 * file adapters), the cross-handler/cross-session SHARED project state
 * (blocker #2), the durable recovery across handler replacement (blocker
 * #1) and the fail-closed honesty contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppApiHandler } from "../src/app-api/index.js";
import {
  FailClosedP016Persist,
  MemoryP016Persist,
  P016PersistError,
  emptyPersistedP016State,
  validatePersistedP016State,
} from "../src/persist/index.js";
import { FileP016Persist } from "../src/persist/file.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type {
  CollabMemberView,
  P016PersistenceView,
  PersistedP016State,
} from "../src/contracts/collab.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p016-persist",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p016-persist",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  return r as { ok: false; code: string; message: string };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}

async function qq(h: AppApiHandler, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

async function seed(h: AppApiHandler, entityId: string): Promise<void> {
  await cmd(h, "document.create", { entityId });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  });
}

// ---------------------------------------------------------------------------
// The port contract (memory + file adapters implement the SAME semantics)
// ---------------------------------------------------------------------------

test("persist: the memory adapter implements the serialized append/read/blob/status contract", async () => {
  const persist = new MemoryP016Persist();
  assert.equal(persist.backend, "memory");
  assert.equal(await persist.read("proj-a"), null, "an unknown project reads null");
  const outcome = await persist.append("proj-a", (state) => {
    assert.equal(state, null);
    const next = emptyPersistedP016State();
    return {
      state: { ...next, clock: 1 },
      blobs: [{ sha: "abc", content: { hello: 1 } }],
      result: "first",
    };
  });
  assert.equal(outcome.eventCount, 1);
  assert.equal(outcome.result, "first");
  const state = (await persist.read("proj-a")) as PersistedP016State;
  assert.equal(state.clock, 1);
  const blob = await persist.fetchBlob("abc");
  assert.deepEqual(blob, { hello: 1 });
  const status: P016PersistenceView = await persist.status("proj-a");
  assert.deepEqual(status, { backend: "memory", projectKey: "proj-a", eventCount: 1 });
  // Projects are isolated.
  assert.equal(await persist.read("proj-b"), null);
  assert.deepEqual(await persist.status("proj-b"), { backend: "memory", projectKey: "proj-b", eventCount: 0 });
});

test("persist: a malformed persisted record is rejected typed (LOCK-007 — never guessed)", () => {
  assert.throws(() => validatePersistedP016State({ clock: -1, collab: {}, recovery: {}, jobs: {} }), {
    code: "p016_persist_corrupt",
  } as { code: string });
  assert.throws(() => validatePersistedP016State({ clock: 1, collab: { members: "no" }, recovery: {}, jobs: {} }), {
    code: "p016_persist_corrupt",
  } as { code: string });
  assert.throws(() => validatePersistedP016State("nope" as unknown), { code: "p016_persist_corrupt" } as { code: string });
  const good = emptyPersistedP016State();
  assert.equal(validatePersistedP016State({ ...good, clock: 3 }).clock, 3);
});

test("persist: the fail-closed adapter declines typed — never a silent memory degradation", async () => {
  const persist = new FailClosedP016Persist();
  await assert.rejects(
    () => persist.append("p", () => ({ state: emptyPersistedP016State(), result: 1 })),
    { code: "p016_persistence_unconfigured" } as { code: string },
  );
  await assert.rejects(() => persist.read("p"), { code: "p016_persistence_unconfigured" } as { code: string });
  await assert.rejects(() => persist.fetchBlob("s"), { code: "p016_persistence_unconfigured" } as { code: string });
  await assert.rejects(() => persist.status("p"), { code: "p016_persistence_unconfigured" } as { code: string });
});

test("persist: the file adapter is DURABLE across adapter instances (the process-restart boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p016-persist-"));
  try {
    const first = new FileP016Persist(dir);
    assert.equal(first.backend, "file");
    await first.append("proj-f", (state) => {
      assert.equal(state, null);
      return {
        state: { ...emptyPersistedP016State(), clock: 7 },
        blobs: [{ sha: "sha-f", content: { durable: true } }],
        result: 1,
      };
    });
    await first.append("proj-f", (state) => {
      assert.equal(state?.clock, 7);
      return { state: { ...(state as PersistedP016State), clock: 8 }, result: 2 };
    });

    // A NEW adapter instance over the same directory — the "restarted
    // process": the state and the content-addressed blob survive.
    const second = new FileP016Persist(dir);
    const state = (await second.read("proj-f")) as PersistedP016State;
    assert.equal(state.clock, 8);
    assert.deepEqual(await second.fetchBlob("sha-f"), { durable: true });
    const status = await second.status("proj-f");
    assert.deepEqual(status, { backend: "file", projectKey: "proj-f", eventCount: 2 });
    // The next append continues the event sequence.
    const outcome = await second.append("proj-f", (s) => ({
      state: { ...(s as PersistedP016State), clock: (s as PersistedP016State).clock + 1 },
      result: 3,
    }));
    assert.equal(outcome.eventCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Blocker #2 — the SHARED project state across handlers/sessions/instances
// ---------------------------------------------------------------------------

test("collab (REMEDIATION): two INDEPENDENT handlers over one shared store converge on the same project state", async () => {
  const persist = new MemoryP016Persist();
  const hA = AppApiHandler.create({ ...CONFIG, p016Persist: persist });
  await seed(hA, "p016-shared-building");
  await cmd(hA, "collab.join", { userId: "alice", role: "editor" });
  await cmd(hA, "collab.comment", { userId: "alice", body: "the shared baseline review", target: { kind: "document" } });
  const saved = val<{ bytes: number[] }>(await cmd(hA, "document.save", {}));

  // A FRESH handler (a different session/instance/process) over the SAME
  // persistence store, opening the SAME document (same canonical entity id
  // → same project).
  const hB = AppApiHandler.create({ ...CONFIG, p016Persist: persist, entityId: "p016-b" });
  await cmd(hB, "document.open", { source: saved.bytes });

  // B SEES A's member and comment (the shared durable project record).
  const stateB = val<{ members: CollabMemberView[]; comments: { id: string; body: string }[]; persistence: P016PersistenceView }>(
    await qq(hB, "collab.state"),
  );
  assert.equal(stateB.members.length, 1);
  assert.equal(stateB.members[0]!.userId, "alice");
  const commentsB = val<{ comments: { id: string; body: string }[] }>(await qq(hB, "collab.comments"));
  assert.equal(commentsB.comments.length, 1);
  assert.equal(commentsB.comments[0]!.body, "the shared baseline review");

  // B joins → A sees BOTH members (the convergence is bidirectional).
  await cmd(hB, "collab.join", { userId: "bob", role: "commenter" });
  const stateA2 = val<{ members: CollabMemberView[]; persistence: P016PersistenceView }>(
    await qq(hA, "collab.state"),
  );
  const stateB2 = val<{ members: CollabMemberView[]; persistence: P016PersistenceView }>(
    await qq(hB, "collab.state"),
  );
  assert.deepEqual(
    stateA2.members.map((m) => m.userId).sort(),
    ["alice", "bob"],
  );
  assert.deepEqual(
    stateB2.members.map((m) => m.userId).sort(),
    ["alice", "bob"],
  );
  // The persistence identity view is the SAME record from both sessions
  // (read back-to-back: identical project key, backend and event count).
  assert.equal(stateB.persistence.projectKey, "p016-shared-building");
  assert.equal(stateA2.persistence.projectKey, stateB2.persistence.projectKey);
  assert.equal(stateA2.persistence.projectKey, "p016-shared-building");
  assert.equal(stateA2.persistence.backend, stateB2.persistence.backend);
  assert.ok(stateA2.persistence.eventCount > 0);
});

test("collab (REMEDIATION): a SECOND session's stale-base transaction conflicts against the SHARED lineage", async () => {
  const persist = new MemoryP016Persist();
  const hA = AppApiHandler.create({ ...CONFIG, p016Persist: persist });
  await seed(hA, "p016-shared-txn");
  await cmd(hA, "collab.join", { userId: "alice", role: "editor" });
  const saved = val<{ bytes: number[] }>(await cmd(hA, "document.save", {}));

  const hB = AppApiHandler.create({ ...CONFIG, p016Persist: persist, entityId: "p016-b2" });
  await cmd(hB, "document.open", { source: saved.bytes });
  await cmd(hB, "collab.join", { userId: "bob", role: "editor" });

  // A commits at the current head (applies to A's document).
  const applied = val<{ applied: boolean; transaction: { id: string; status: string; resultingVersion: number | null } }>(
    await cmd(hA, "collab.commit", {
      userId: "alice",
      baseVersion: 2,
      edits: [{ type: "updateElement", elementId: "wall-south", patch: { FireRating: 90 } }],
    }),
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.transaction.status, "applied");

  // B (whose local editor copy is still at the pre-commit base) commits with
  // the STALE base — the SHARED lineage head detects the conflict even
  // though B's local document version still matches B's base.
  const conflicted = val<{ applied: boolean; transaction: { id: string; status: string; conflict: { interveningTransactions: string[] } | null } }>(
    await cmd(hB, "collab.commit", {
      userId: "bob",
      baseVersion: 2,
      edits: [{ type: "updateElement", elementId: "wall-east", patch: { AcousticRating: "Class B" } }],
    }),
  );
  assert.equal(conflicted.applied, false);
  assert.equal(conflicted.transaction.status, "conflict");
  assert.deepEqual(conflicted.transaction.conflict!.interveningTransactions, [applied.transaction.id]);

  // The shared transaction lineage is visible to BOTH sessions.
  const txnsA = val<{ transactions: { id: string; status: string }[] }>(await qq(hA, "collab.transactions"));
  const txnsB = val<{ transactions: { id: string; status: string }[] }>(await qq(hB, "collab.transactions"));
  assert.equal(txnsA.transactions.length, 2);
  assert.deepEqual(txnsA.transactions, txnsB.transactions);
});

test("collab (REMEDIATION): per-handler default persistence stays isolated (no accidental cross-test sharing)", async () => {
  const hA = AppApiHandler.create(CONFIG);
  const hB = AppApiHandler.create(CONFIG);
  await seed(hA, "p016-isolated");
  await cmd(hA, "collab.join", { userId: "alice", role: "editor" });
  const saved = val<{ bytes: number[] }>(await cmd(hA, "document.save", {}));
  await cmd(hB, "document.open", { source: saved.bytes });
  const stateB = val<{ members: CollabMemberView[] }>(await qq(hB, "collab.state"));
  assert.equal(stateB.members.length, 0, "separate default (per-handler) stores do not share");
});

// ---------------------------------------------------------------------------
// Blocker #1 — durable recovery across a HANDLER replacement (the fresh
// instance after a crash/restart) through the shared store
// ---------------------------------------------------------------------------

test("recovery (REMEDIATION): a FRESH handler over the shared store recovers the checkpoints (crash-restart)", async () => {
  const persist = new MemoryP016Persist();
  const hA = AppApiHandler.create({ ...CONFIG, p016Persist: persist });
  await seed(hA, "p016-crash-building");
  await cmd(hA, "collab.join", { userId: "alice", role: "editor" });
  const { checkpoint } = val<{ checkpoint: { id: string; contentHash: string } }>(
    await cmd(hA, "recovery.checkpoint", {}),
  );
  const hashAtCheckpoint = hA.currentContentHash();
  const saved = val<{ bytes: number[] }>(await cmd(hA, "document.save", {}));

  // The "crash": a FRESH handler instance (all session memory gone), the
  // SAME shared persistence store.
  const hB = AppApiHandler.create({ ...CONFIG, p016Persist: persist, entityId: "p016-crash-b" });
  await cmd(hB, "document.open", { source: saved.bytes });

  // The checkpoint inventory is durable.
  const list = val<{ checkpoints: { id: string; contentHash: string }[] }>(await qq(hB, "recovery.list"));
  assert.equal(list.checkpoints.length, 1);
  assert.equal(list.checkpoints[0]!.id, checkpoint.id);

  // The recovery.restore from the fresh instance rebuilds the canonical
  // document hash-exactly from the durable content-addressed blob.
  const out = val<{ report: { chosen: { id: string }; restoredContentHash: string } }>(
    await cmd(hB, "recovery.restore", {}),
  );
  assert.equal(out.report.chosen.id, checkpoint.id);
  assert.equal(out.report.restoredContentHash, hashAtCheckpoint);
  assert.equal(hB.currentContentHash(), hashAtCheckpoint);
});

// ---------------------------------------------------------------------------
// The persistence error mapping surfaces typed
// ---------------------------------------------------------------------------

test("persist: persistence failures surface as TYPED app-api errors (p016_persistence_unconfigured)", async () => {
  const h = AppApiHandler.create({ ...CONFIG, p016Persist: new FailClosedP016Persist() });
  await seed(h, "p016-failclosed");
  const bad = errVal(await cmd(h, "collab.join", { userId: "alice", role: "editor" }));
  assert.equal(bad.code, "p016_persistence_unconfigured");
  assert.match(bad.message, /BLOB_READ_WRITE_TOKEN/);
  // Non-P016 surfaces are unaffected (the document workflow keeps working).
  const state = val<{ elements: unknown[] }>(await qq(h, "document.getState"));
  assert.ok(Array.isArray(state.elements));
});
