/**
 * CAD-PARITY-016 (Issue #112) — the durable job engine + the bounded
 * large-model streaming cache tests (PLAT-004; explicit cache
 * non-authority):
 *  - jobs advance ONE deterministic step per tick (queued → running →
 *    succeeded/failed); terminal jobs decline ticks typed; the job output
 *    is a revision-bound REPORT (worker output is never authority).
 *  - model.stream serves canonical id-sorted pages under the bounded
 *    page-size grammar with version + content-hash binding; the cache is
 *    revalidated against the CURRENT canonical version on every request
 *    (stale entries are evicted with exact accounting — never served).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type { JobView, StreamCacheStatsView, StreamPageView } from "../src/contracts/collab.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p016-jobs",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p016-jobs",
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

/** A larger deterministic model: 4 seed entities + 200 walls (the
 *  representative large-model access pattern). */
async function seedLarge(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p016-jobs-building" });
  const entities: Record<string, unknown>[] = [
    { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  ];
  for (let i = 0; i < 200; i += 1) {
    entities.push({
      type: "bim.wall",
      id: `wall-${String(i + 1).padStart(3, "0")}`,
      storyId: "story-gf",
      start: [i * 100, 0],
      end: [i * 100 + 100, 0],
      width: 100,
      height: 3000,
    });
  }
  await cmd(h, "bim.createElements", { entities });
}

test("jobs: the quantity.recalculate lifecycle advances one deterministic step per tick", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h);

  const created = val<{ job: JobView }>(
    await cmd(h, "jobs.create", { kind: "quantity.recalculate", params: { groupBy: "type" } }),
  );
  assert.equal(created.job.id, "job-000001");
  assert.equal(created.job.kind, "quantity.recalculate");
  assert.equal(created.job.status, "queued");
  assert.equal(created.job.step, 0);
  assert.equal(created.job.totalSteps, 3);
  assert.match(created.job.persistHint, /never authority/);

  const t1 = val<{ job: JobView }>(await cmd(h, "jobs.tick", { jobId: "job-000001" }));
  assert.equal(t1.job.status, "running");
  assert.equal(t1.job.step, 1);
  assert.equal(t1.job.result, null);
  assert.equal(t1.job.finishedAt, null);

  const t2 = val<{ job: JobView }>(await cmd(h, "jobs.tick", { jobId: "job-000001" }));
  assert.equal(t2.job.status, "running");
  assert.equal(t2.job.step, 2);

  const t3 = val<{ job: JobView }>(await cmd(h, "jobs.tick", { jobId: "job-000001" }));
  assert.equal(t3.job.status, "succeeded");
  assert.equal(t3.job.step, 3);
  assert.equal(t3.job.finishedAt, t3.job.createdAt + 3); // the session clock ticks per command
  const summary = t3.job.result!.summary as Record<string, unknown>;
  // Per-element rows over the measurable entities (the 200 walls; the story
  // is honestly skipped — no canonical quantity rule for it).
  assert.equal(summary.rows, 200);
  assert.ok(typeof summary.reportSha256 === "string" && (summary.reportSha256 as string).length === 64);
  const revision = summary.revision as Record<string, unknown>;
  assert.equal(revision.documentVersionNumber, 2);
  assert.ok(typeof revision.contentHash === "string");

  // Terminal jobs decline further ticks typed.
  const terminal = errVal(await cmd(h, "jobs.tick", { jobId: "job-000001" }));
  assert.equal(terminal.code, "job_terminal");

  // jobs.get/jobs.list read the durable state.
  const got = val<{ job: JobView }>(await qq(h, "jobs.get", { jobId: "job-000001" }));
  assert.equal(got.job.status, "succeeded");
  const listed = val<{ jobs: JobView[] }>(await qq(h, "jobs.list"));
  assert.equal(listed.jobs.length, 1);
  const missing = errVal(await qq(h, "jobs.get", { jobId: "job-999999" }));
  assert.equal(missing.code, "job_not_found");
});

test("jobs: docs.regenerate fails deterministically without views; invalid kinds decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h);

  // No documentation views → the first tick records the typed failure.
  const created = val<{ job: JobView }>(
    await cmd(h, "jobs.create", { kind: "docs.regenerate", params: {} }),
  );
  const t1 = val<{ job: JobView }>(await cmd(h, "jobs.tick", { jobId: created.job.id }));
  assert.equal(t1.job.status, "failed");
  assert.equal(t1.job.failure!.code, "job_failed");
  assert.match(t1.job.failure!.message, /no documentation views/);

  // The closed kind vocabulary.
  const badKind = errVal(await cmd(h, "jobs.create", { kind: "render.magic" }));
  assert.equal(badKind.code, "jobs_invalid");
  const badParam = errVal(await cmd(h, "jobs.create", { kind: "quantity.recalculate", params: { nope: 1 } }));
  assert.equal(badParam.code, "jobs_invalid");

  // Ticking an unknown job declines typed.
  const noJob = errVal(await cmd(h, "jobs.tick", { jobId: "job-999999" }));
  assert.equal(noJob.code, "job_not_found");
});

test("jobs: docs.regenerate succeeds through the shared docs core with view hashes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await cmd(h, "document.create", { entityId: "p016-jobs-docs" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  });
  await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
    ],
  });

  const created = val<{ job: JobView }>(await cmd(h, "jobs.create", { kind: "docs.regenerate", params: {} }));
  await cmd(h, "jobs.tick", { jobId: created.job.id });
  await cmd(h, "jobs.tick", { jobId: created.job.id });
  const done = val<{ job: JobView }>(await cmd(h, "jobs.tick", { jobId: created.job.id }));
  assert.equal(done.job.status, "succeeded");
  const summary = done.job.result!.summary as Record<string, unknown>;
  assert.equal(summary.views, 2);
  assert.equal(summary.sheets, 0);
  const hashes = summary.viewHashes as { viewId: string; kind: string; contentHash: string; primitiveCount: number }[];
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0]!.viewId, "vw-000001");
  assert.ok(hashes[0]!.primitiveCount > 0);
  assert.match(hashes[0]!.contentHash, /^[0-9a-f]{64}$/);
});

test("jobs: model.stream.warm warms the bounded cache pages (non-authority by construction)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h); // 201 elements

  const created = val<{ job: JobView }>(
    await cmd(h, "jobs.create", { kind: "model.stream.warm", params: { pageSize: 100 } }),
  );
  assert.equal(created.job.totalSteps, 3); // ceil(201/100)
  for (let i = 0; i < 3; i += 1) {
    await cmd(h, "jobs.tick", { jobId: created.job.id });
  }
  const done = val<{ job: JobView }>(await qq(h, "jobs.get", { jobId: created.job.id }));
  assert.equal(done.job.status, "succeeded");
  const summary = done.job.result!.summary as Record<string, unknown>;
  assert.equal(summary.pagesWarmed, 3);
  assert.equal(summary.pageSize, 100);
  assert.equal(summary.totalElements, 201);
  assert.equal(summary.cacheNonAuthority, true);
  // The warmed pages are revalidated on every subsequent request (cache
  // hits with the version intact).
  const page0 = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 }));
  assert.equal(page0.page.cacheHit, true);
});

test("stream: canonical id-sorted pages under the bounded grammar, version+hash bound", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h);

  const page0 = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 }));
  assert.equal(page0.page.pageIndex, 0);
  assert.equal(page0.page.pageSize, 100);
  assert.equal(page0.page.totalElements, 201);
  assert.equal(page0.page.totalPages, 3);
  assert.equal(page0.page.elements.length, 100);
  assert.equal(page0.page.elements[0]!.id, "story-gf"); // canonical id order
  assert.equal(page0.page.elements[1]!.id, "wall-001");
  assert.equal(page0.page.elements[99]!.id, "wall-099");
  assert.equal(page0.page.cacheHit, false);
  assert.equal(page0.page.documentVersionNumber, 2);
  assert.equal(page0.page.contentHash, h.currentContentHash());

  const page2 = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 2, pageSize: 100 }));
  assert.equal(page2.page.elements.length, 1);
  assert.equal(page2.page.elements[0]!.id, "wall-200");

  // The bounded page-size grammar + range.
  const tooSmall = errVal(await qq(h, "model.stream", { pageIndex: 0, pageSize: 5 }));
  assert.equal(tooSmall.code, "stream_invalid");
  const tooBig = errVal(await qq(h, "model.stream", { pageIndex: 0, pageSize: 501 }));
  assert.equal(tooBig.code, "stream_invalid");
  const oob = errVal(await qq(h, "model.stream", { pageIndex: 3, pageSize: 100 }));
  assert.equal(oob.code, "stream_out_of_range");
  const badPayload = errVal(await qq(h, "model.stream", { pageSize: 100 }));
  assert.equal(badPayload.code, "bad_payload");
});

test("stream: the cache is revalidated against the CURRENT version — stale entries evicted, never served", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h);

  const first = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 }));
  assert.equal(first.page.cacheHit, false);
  const second = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 }));
  assert.equal(second.page.cacheHit, true);
  assert.equal(second.page.contentHash, first.page.contentHash);

  // A canonical edit bumps the version → the cached page is STALE and must
  // be evicted (counted), never served.
  await cmd(h, "bim.move", { ids: ["wall-001"], dx: 0, dy: 100, dz: 0 });
  const third = val<{ page: StreamPageView }>(await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 }));
  assert.equal(third.page.cacheHit, false);
  assert.equal(third.page.documentVersionNumber, 3);
  assert.equal(third.page.contentHash, h.currentContentHash());
  const stats = val<{ stats: StreamCacheStatsView }>(await qq(h, "model.streamStats"));
  assert.equal(stats.stats.hits, 1);
  assert.equal(stats.stats.misses, 2);
  assert.equal(stats.stats.staleEvictions, 1);
  assert.equal(stats.stats.maxEntries, 32);
  assert.equal(stats.stats.authoritative, false);
  assert.equal(stats.stats.bounded, true);
});

test("perf.budgets: revision-bound counters for the P016 workflows", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedLarge(h);
  await cmd(h, "collab.join", { userId: "ekon", role: "editor" });
  await cmd(h, "collab.presence", { userId: "ekon" });
  await cmd(h, "collab.comment", { userId: "ekon", body: "budget run", target: { kind: "document" } });
  await cmd(h, "collab.commit", {
    userId: "ekon",
    baseVersion: 2,
    edits: [{ type: "setProps", elementId: "wall-001", patch: { FireRating: 90 } }],
  });
  await qq(h, "model.stream", { pageIndex: 0, pageSize: 100 });

  const budgets = val<{
    revision: { documentVersionNumber: number; contentHash: string; modelRevisionNumber: number; elementCount: number };
    budgets: { workflow: string; thresholdMs: number; unit: string; measuredBy: string }[];
    counters: Record<string, number>;
  }>(await qq(h, "perf.budgets"));
  assert.equal(budgets.revision.documentVersionNumber, 3);
  assert.equal(budgets.revision.elementCount, 201);
  assert.equal(budgets.revision.contentHash, h.currentContentHash());
  assert.ok(budgets.budgets.length >= 6);
  for (const b of budgets.budgets) {
    assert.equal(b.unit, "ms");
    assert.equal(b.measuredBy, "smoke-observed");
    assert.ok(b.thresholdMs > 0);
  }
  const c = budgets.counters;
  assert.equal(c.commands, 5); // elements+join+presence+comment+commit (create resets the counters) — stream/perf are queries
  assert.equal(c.comments, 1);
  assert.equal(c.presenceBeats, 1);
  assert.equal(c.transactions, 1);
  assert.equal(c.conflicts, 0);
  assert.equal(c.streamPages, 1);
  assert.equal(c.cacheMisses, 1);
  assert.equal(c.jobTicks, 0);
});
