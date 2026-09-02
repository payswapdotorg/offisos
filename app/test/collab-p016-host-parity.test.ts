/**
 * CAD-PARITY-016 (Issue #112) — Web/Electron host parity for the
 * collaboration/recovery/scale workflows (§5.5, LOCK-004/017; mirrors
 * schedules-p015-host-parity).
 *
 * The SAME P016 command/query sequence through the Web Host
 * (WebSocketTransport) and the Electron Host (IpcTransport) produces
 * identical semantic results: the session-clock values, the minted
 * checkpoint/comment/transaction ids, the checkpoint content hashes, the
 * conflict + merge/resolution lineage, the stream page shapes, the cache
 * counters and the perf-budget counters. Each host drives its OWN handler
 * + bundle instance through its REAL transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p016-parity",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p016-parity",
};

type Renderer = ReturnType<typeof createRenderer>;

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as OkResult).value as T;
}

async function c(r: Renderer, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return r.execute({ type: "command", name: name as never, payload });
}
async function qq(r: Renderer, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return r.query({ type: "query", name: name as never, payload });
}

interface P016SequenceResult {
  joinJson: string;
  presenceJson: string;
  commentJson: string;
  commentListJson: string;
  conflictJson: string;
  mergeJson: string;
  txnListJson: string;
  checkpointJson: string;
  restoreJson: string;
  streamPage0Json: string;
  streamPage1Json: string;
  streamStatsJson: string;
  jobLifecycleJson: string;
  budgetsJson: string;
  activityJson: string;
  contentHash: string;
}

/** The identical P016 sequence on both hosts. */
async function runP016Sequence(r: Renderer): Promise<P016SequenceResult> {
  await c(r, "document.create", { entityId: "p016-parity-building" });
  const entities: Record<string, unknown>[] = [
    { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
    { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  ];
  // The large-model page spread: 12 more walls → 15 elements → 2 pages at
  // the canonical minimum page size.
  for (let i = 0; i < 12; i += 1) {
    entities.push({
      type: "bim.wall",
      id: `wall-f${String(i + 1).padStart(2, "0")}`,
      storyId: "story-gf",
      start: [i * 100, 1000],
      end: [i * 100 + 100, 1000],
      width: 100,
      height: 3000,
    });
  }
  await c(r, "bim.createElements", { entities });

  // Members + presence (the clock starts ticking per dispatched command).
  const join = val<{ member: unknown }>(await c(r, "collab.join", { userId: "ekon", role: "editor" }));
  const presence = val<{ member: unknown }>(await c(r, "collab.presence", { userId: "ekon" }));
  await c(r, "collab.join", { userId: "reviewer", role: "commenter" });

  // A comment on a canonical element + the comment list.
  const comment = val<{ comment: unknown }>(
    await c(r, "collab.comment", {
      userId: "reviewer",
      body: "Verify the fire rating of this wall.",
      target: { kind: "element", id: "wall-south" },
    }),
  );
  const commentList = val<{ comments: unknown }>(await qq(r, "collab.comments"));

  // The versioned transactional semantics: A applies at the current base…
  const applied = val<{ applied: boolean; transaction: { id: string; baseVersion: number } }>(
    await c(r, "collab.commit", {
      userId: "ekon",
      baseVersion: 2,
      edits: [{ type: "updateElement", elementId: "wall-south", patch: { FireRating: 90 } }],
    }),
  );
  assert.equal(applied.applied, true);

  // …a second transaction commits from the SAME stale base on a different
  // element → the explicit conflict (the editor authors both — the conflict
  // is about the stale base, not the user).
  const conflict = val<{ applied: boolean; transaction: unknown }>(
    await c(r, "collab.commit", {
      userId: "ekon",
      baseVersion: 2,
      edits: [{ type: "updateElement", elementId: "wall-east", patch: { AcousticRating: "Class B" } }],
    }),
  );

  // Resolve by rebase (the merge/resolution lineage) + the inventory.
  const txnId = (conflict as { transaction: { id: string } }).transaction.id;
  const merge = val<{ merge: unknown }>(
    await c(r, "collab.merge", { transactionId: txnId, userId: "ekon", strategy: "rebase" }),
  );
  const txnList = val<{ transactions: unknown }>(await qq(r, "collab.transactions"));

  // Recovery: a manual checkpoint, a mutation, then the deterministic restore.
  const checkpoint = val<{ checkpoint: unknown }>(await c(r, "recovery.checkpoint", {}));
  await c(r, "bim.move", { ids: ["wall-south"], dx: 0, dy: 500, dz: 0 });
  const restore = val<{ report: unknown }>(await c(r, "recovery.restore", {}));

  // Large-model streaming: two pages + the cache stats.
  const page0 = val<{ page: unknown }>(await qq(r, "model.stream", { pageIndex: 0, pageSize: 10 }));
  const page1 = val<{ page: unknown }>(await qq(r, "model.stream", { pageIndex: 1, pageSize: 10 }));
  const streamStats = val<{ stats: unknown }>(await qq(r, "model.streamStats"));

  // Durable job lifecycle (3 ticks → succeeded).
  const created = val<{ job: { id: string } }>(
    await c(r, "jobs.create", { kind: "quantity.recalculate", params: { groupBy: "type" } }),
  );
  const ticks: unknown[] = [];
  for (let i = 0; i < 3; i += 1) {
    ticks.push(val<{ job: unknown }>(await c(r, "jobs.tick", { jobId: created.job.id })).job);
  }

  // The revision-bound budget counters + the activity stream.
  const budgets = val<{ revision: unknown; counters: unknown }>(await qq(r, "perf.budgets"));
  const activity = val<{ activity: unknown }>(await qq(r, "collab.activity"));

  const stable = (x: unknown): string => JSON.stringify(x);
  return {
    joinJson: stable(join),
    presenceJson: stable(presence),
    commentJson: stable(comment),
    commentListJson: stable(commentList),
    conflictJson: stable(conflict),
    mergeJson: stable(merge),
    txnListJson: stable(txnList),
    checkpointJson: stable(checkpoint),
    restoreJson: stable(restore),
    streamPage0Json: stable(page0),
    streamPage1Json: stable(page1),
    streamStatsJson: stable(streamStats),
    jobLifecycleJson: stable(ticks),
    budgetsJson: stable(budgets),
    activityJson: stable(activity),
    contentHash: "",
  };
}

test("collaboration/recovery/scale: Web and Electron converge to identical semantic results", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const webResult = await runP016Sequence(web);
  const electronResult = await runP016Sequence(electron);

  // The semantic surfaces converge byte-exactly across hosts (ids, clocks,
  // hashes, lineage, pages, counters).
  assert.equal(webResult.joinJson, electronResult.joinJson);
  assert.equal(webResult.presenceJson, electronResult.presenceJson);
  assert.equal(webResult.commentJson, electronResult.commentJson);
  assert.equal(webResult.commentListJson, electronResult.commentListJson);
  assert.equal(webResult.conflictJson, electronResult.conflictJson);
  assert.equal(webResult.mergeJson, electronResult.mergeJson);
  assert.equal(webResult.txnListJson, electronResult.txnListJson);
  assert.equal(webResult.checkpointJson, electronResult.checkpointJson);
  assert.equal(webResult.restoreJson, electronResult.restoreJson);
  assert.equal(webResult.streamPage0Json, electronResult.streamPage0Json);
  assert.equal(webResult.streamPage1Json, electronResult.streamPage1Json);
  assert.equal(webResult.streamStatsJson, electronResult.streamStatsJson);
  assert.equal(webResult.jobLifecycleJson, electronResult.jobLifecycleJson);
  assert.equal(webResult.budgetsJson, electronResult.budgetsJson);
  assert.equal(webResult.activityJson, electronResult.activityJson);

  // And the canonical documents converge to the same content hash (the
  // restored state + the collab transactions replay identically).
  assert.equal(webHandler.currentContentHash(), electronHandler.currentContentHash());
});
