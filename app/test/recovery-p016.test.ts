/**
 * CAD-PARITY-016 (Issue #112) — the recovery core tests: durable, versioned
 * checkpoints traceable to canonical document revisions, the bounded
 * autosave policy, deterministic crash/session recovery with typed
 * integrity failures (never a silent repair), and the restore semantics
 * (the restored document IS the canonical document — no parallel source of
 * truth).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { CheckpointStore, checkpointIdOf, headRevisionIdOf } from "../src/recovery/index.js";
import { CADDocument } from "../src/caddocument/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type { CheckpointView, RecoveryReport } from "../src/contracts/collab.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p016-recovery",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p016-recovery",
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

/** The shared P016 seed: a story + two walls + a slab (the P015 parity
 *  building, trimmed). */
async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p016-recovery-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
    ],
  });
}

test("recovery: manual checkpoints are versioned, revision-traceable and hash-exact", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const before = val<{ version_number: number; version_id: string }>(
    await qq(h, "document.getVersion"),
  );
  const { checkpoint, policy, retained } = val<{
    checkpoint: CheckpointView;
    policy: { autosaveEvery: number; keep: number };
    retained: number;
  }>(await cmd(h, "recovery.checkpoint", {}));

  assert.match(checkpoint.id, /^ckpt-000001$/);
  assert.equal(checkpoint.seq, 1);
  assert.equal(checkpoint.cause, "manual");
  assert.equal(checkpoint.documentVersionNumber, before.version_number);
  assert.equal(checkpoint.documentVersionId, before.version_id);
  assert.equal(checkpoint.contentHash, h.currentContentHash());
  assert.equal(checkpoint.entityId, "p016-recovery-building");
  assert.equal(checkpoint.elementCount, 4);
  assert.ok(checkpoint.modelRevisionNumber >= 1, "the checkpoint cites the model revision head");
  assert.match(checkpoint.modelRevisionId, /#r\d+\(/);
  assert.deepEqual(policy, { autosaveEvery: 5, keep: 8 });
  assert.equal(retained, 1);
});

test("recovery: the bounded autosave policy mints checkpoints every 5th version-changing command", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // One version-changing command so far (document.create resets to the
  // empty root version without a transition; bim.createElements is v1→v2).
  let counters = val<{ counters: { autosaves: number; mutationsSinceAutosave: number; commands: number } }>(
    await qq(h, "recovery.list"),
  ).counters;
  assert.equal(counters.autosaves, 0);
  assert.equal(counters.mutationsSinceAutosave, 1);
  assert.equal(counters.commands, 1); // the create resets the session clock + counters

  // Four more version-changing commands → the 5th mutation triggers the
  // first automatic autosave.
  await cmd(h, "bim.move", { ids: ["wall-south"], dx: 0, dy: 100, dz: 0 });
  await cmd(h, "bim.move", { ids: ["wall-east"], dx: 0, dy: 100, dz: 0 });
  await cmd(h, "bim.move", { ids: ["slab-g"], dx: 0, dy: 100, dz: 0 });
  const mid = val<{ counters: { autosaves: number; mutationsSinceAutosave: number } }>(
    await qq(h, "recovery.list"),
  ).counters;
  assert.equal(mid.autosaves, 0);
  assert.equal(mid.mutationsSinceAutosave, 4);
  await cmd(h, "bim.move", { ids: ["wall-south"], dx: 100, dy: 0, dz: 0 });
  const after = val<{ checkpoints: CheckpointView[]; counters: { autosaves: number; mutationsSinceAutosave: number } }>(
    await qq(h, "recovery.list"),
  );
  assert.equal(after.counters.autosaves, 1);
  assert.equal(after.counters.mutationsSinceAutosave, 0);
  assert.equal(after.checkpoints.length, 1);
  assert.equal(after.checkpoints[0]!.cause, "autosave");
  assert.match(after.checkpoints[0]!.id, /^ckpt-000001$/);
});

test("recovery: deterministic restore rebuilds the canonical document hash-exactly (no parallel truth)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { checkpoint } = val<{ checkpoint: CheckpointView }>(await cmd(h, "recovery.checkpoint", {}));
  const hashAtCheckpoint = h.currentContentHash();

  // Mutate past the checkpoint.
  await cmd(h, "bim.move", { ids: ["wall-south"], dx: 0, dy: 500, dz: 0 });
  assert.notEqual(h.currentContentHash(), hashAtCheckpoint);

  // Restore the checkpoint (explicit id).
  const out = val<{ report: RecoveryReport; preRestoreCheckpoint: CheckpointView }>(
    await cmd(h, "recovery.restore", { checkpointId: checkpoint.id }),
  );
  assert.equal(out.report.requestedId, checkpoint.id);
  assert.equal(out.report.chosen.id, checkpoint.id);
  assert.equal(out.report.skipped.length, 0);
  assert.equal(out.report.restoredContentHash, hashAtCheckpoint);
  assert.equal(h.currentContentHash(), hashAtCheckpoint);
  assert.equal(out.preRestoreCheckpoint.cause, "pre-restore");
  // The pre-restore checkpoint captured the PRE-restore state (nothing lost).
  assert.notEqual(out.preRestoreCheckpoint.contentHash, hashAtCheckpoint);

  // The restored elements are the checkpoint's elements (the move is gone —
  // deterministic restoration semantics).
  const state = val<{ elements: { id: string }[] }>(await qq(h, "document.getState"));
  assert.deepEqual(
    state.elements.map((e) => e.id).sort(),
    ["slab-g", "story-gf", "wall-east", "wall-south"],
  );
});

test("recovery: latest-valid default restore + requested-id declines typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "recovery.checkpoint", {}); // ckpt-000001
  await cmd(h, "bim.move", { ids: ["wall-south"], dx: 0, dy: 500, dz: 0 });
  await cmd(h, "recovery.checkpoint", {}); // ckpt-000002 (the latest)

  // Default: the latest valid.
  const out = val<{ report: RecoveryReport }>(await cmd(h, "recovery.restore", {}));
  assert.equal(out.report.requestedId, null);
  assert.equal(out.report.chosen.id, "ckpt-000002");
  assert.equal(out.report.skipped.length, 0);

  // A non-existent checkpoint id declines typed.
  const bad = errVal(await cmd(h, "recovery.restore", { checkpointId: "ckpt-999999" }));
  assert.equal(bad.code, "recovery_failed");
  assert.match(bad.message, /does not exist/);
});

test("recovery: corrupt candidates are SKIPPED with typed reasons, never silently repaired (unit scan)", async () => {
  const doc = CADDocument.empty("p016-recovery-unit", "offisos-dummy", "1", "p016-recovery-unit");
  doc.execute({ type: "addElement", element: { id: "e-1", kind: "geometry", engineId: null, props: {} } });
  const store = new CheckpointStore({ autosaveEvery: 5, keep: 8 });
  const mints = new Map<string, unknown>();
  const first = store.create(doc, "manual", 1, checkpointIdOf);
  mints.set(first.view.contentHash, first.blob.content);
  // A further mutation so the two checkpoints carry DIFFERENT content hashes.
  doc.execute({ type: "addElement", element: { id: "e-2", kind: "geometry", engineId: null, props: {} } });
  const second = store.create(doc, "manual", 2, checkpointIdOf);
  mints.set(second.view.contentHash, second.blob.content);
  assert.equal(first.view.id, "ckpt-000001");
  assert.equal(second.view.id, "ckpt-000002");
  assert.notEqual(first.view.contentHash, second.view.contentHash);

  const open = (snapshot: unknown): CADDocument =>
    CADDocument.open(snapshot as never, "p016-recovery-unit");
  const fetcher = async (sha: string): Promise<unknown | null> => mints.get(sha) ?? null;

  // A lying content-hash oracle for the LATEST checkpoint: the scan must
  // skip it (integrity_mismatch) and restore the previous valid one.
  const lyingHash = (d: CADDocument): string =>
    d.currentContentHash() === second.view.contentHash ? "deadbeef".repeat(8) : d.currentContentHash();
  const { report } = await store.scanAndRestore(null, fetcher, open, lyingHash, () => [], 9);
  assert.equal(report.chosen.id, first.view.id);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0]!.id, second.view.id);
  assert.match(report.skipped[0]!.reason, /^integrity_mismatch: /);

  // An open that throws for the newest snapshot: skipped with open_failed.
  const throwingOpen = (snapshot: unknown): CADDocument => {
    const doc2 = open(snapshot);
    if (doc2.currentContentHash() === second.view.contentHash) {
      throw new Error("simulated corrupt snapshot");
    }
    return doc2;
  };
  const { report: report2 } = await store.scanAndRestore(
    null,
    fetcher,
    throwingOpen,
    (d) => d.currentContentHash(),
    () => [],
    10,
  );
  assert.equal(report2.chosen.id, "ckpt-000001");
  assert.equal(report2.skipped.length, 1);
  assert.match(report2.skipped[0]!.reason, /^open_failed: /);

  // A MISSING content-addressed blob: skipped with snapshot_missing (the
  // durable-store gap is a typed skip, never a crash).
  const missingFetcher = async (sha: string): Promise<unknown | null> =>
    sha === second.view.contentHash ? null : (mints.get(sha) ?? null);
  const { report: report3 } = await store.scanAndRestore(
    null,
    missingFetcher,
    open,
    (d) => d.currentContentHash(),
    () => [],
    11,
  );
  assert.equal(report3.chosen.id, "ckpt-000001");
  assert.match(report3.skipped[0]!.reason, /^snapshot_missing: /);

  // No valid candidate at all → the typed unrecoverable failure.
  await assert.rejects(
    () => store.scanAndRestore(null, fetcher, open, () => "deadbeef".repeat(8), () => [], 9),
    /no valid recoverable checkpoint/,
  );
});

test("recovery: the retention window trims the oldest first (bounded records)", () => {
  const doc = CADDocument.empty("p016-recovery-trim", "offisos-dummy", "1", "unit");
  const store = new CheckpointStore({ autosaveEvery: 5, keep: 3 });
  for (let i = 0; i < 6; i += 1) {
    store.create(doc, "autosave", i + 1, checkpointIdOf);
  }
  const ids = store.list().map((c) => c.id);
  assert.deepEqual(ids, ["ckpt-000004", "ckpt-000005", "ckpt-000006"]);
});

test("recovery (REMEDIATION): checkpoints are DURABLE across the document-reopen boundary — a reopened document recovers them", async () => {
  // The Architect blocker #1: resetP016Session used to DESTROY the
  // checkpoint store on document.open. The remediation persists the project
  // record keyed by the canonical document entity id: reopening the SAME
  // document (the save/open round-trip preserves the identity) retains the
  // checkpoints and the restore works from the durable blobs.
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "recovery.checkpoint", {}); // ckpt-000001 (manual)
  const hashAtCheckpoint = h.currentContentHash();

  // Mutate past the checkpoint, save, and REOPEN the same document (the
  // crash/session boundary: a fresh session over the same project).
  await cmd(h, "bim.move", { ids: ["wall-south"], dx: 0, dy: 500, dz: 0 });
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  await cmd(h, "document.open", { source: saved.bytes });

  // The checkpoints SURVIVED the reopen (the durable project record).
  const list = val<{ checkpoints: CheckpointView[]; counters: { commands: number; retained: number } }>(
    await qq(h, "recovery.list"),
  );
  assert.equal(list.checkpoints.length, 1, "the checkpoint is durable across the reopen boundary");
  assert.equal(list.checkpoints[0]!.id, "ckpt-000001");
  // The SESSION observability re-armed (commands counter reset — the session
  // is new; the durable record is not).
  assert.equal(list.counters.commands, 0);

  // The restore rebuilds the checkpoint state from the durable blob.
  const out = val<{ report: RecoveryReport }>(await cmd(h, "recovery.restore", {}));
  assert.equal(out.report.chosen.id, "ckpt-000001");
  assert.equal(out.report.restoredContentHash, hashAtCheckpoint);
  assert.equal(h.currentContentHash(), hashAtCheckpoint);
});

test("recovery: headRevisionIdOf derives the canonical base/head revision id (the shared formula)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const history = h.document.history;
  const head = headRevisionIdOf(history);
  assert.equal(head.number, history.revisions.length);
  const last = history.revisions[history.revisions.length - 1]!;
  assert.equal(head.id, last.revision_id);

  const empty = CADDocument.empty("p016-empty", "offisos-dummy", "1", "unit");
  const base = headRevisionIdOf(empty.history);
  assert.equal(base.number, 0);
  assert.match(base.id, /#r0\(/);
});
