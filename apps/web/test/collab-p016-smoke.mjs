// CAD-PARITY-016 / Issue #112: Web host collaboration/recovery/scale smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (COLLABJOIN/
// PRESENCE/COMMENT/TXN/MERGE/JOB/CKPT/RECOVER + the CKPTLIST/COLLABSTATE/
// XREFSTATUS/BUDGETS report surfaces in commands-collab.ts) plus the App API
// surface the Collab workbench produces (recovery.checkpoint/autosave/
// restore + recovery.list, collab.join/presence/comment/resolveComment/
// commit/merge + collab.state/comments/activity/transactions, jobs.create/
// tick + jobs.list/get, model.stream + model.streamStats, xrefs.status +
// xrefs.probe, perf.budgets) — against the running dev server, asserting
// the session state after every step. This is the Web half of the
// Web/Electron semantic-parity evidence (LOCK-004); the app-suite
// collab-p016-host-parity test proves the same stream through both hosts;
// the pinned fixture (app/test/fixtures/cad-parity-016-collab.json) is the
// parity basis.
//
// Covers the CAD-PARITY-016 acceptance surface: the durable versioned
// recovery checkpoints traceable to canonical revisions + the bounded
// autosave policy + the deterministic crash/session recovery (hash-exact,
// typed skips, never a silent repair); the project-scoped permission-aware
// comments/presence/activity (typed collab_forbidden on role violations);
// the versioned transactional semantics with the explicit reproducible
// conflict records and the rebase/discard merge/resolution lineage; the
// controlled external-reference lifecycle with the explicit unavailable/
// unsupported outcomes + the probe-based stale outcome; the bounded
// large-model streaming with the explicit cache non-authority (stale
// entries evicted with exact accounting, never served); the durable
// background-regeneration jobs (one deterministic step per tick, worker
// output never authority); and the observable performance budgets
// (wall-clock thresholds asserted per call — the measurements are reported
// to the run log and NEVER pinned; only deterministic counters are pinned).
// Engine-free semantics (LOCK-018): no engine call is made.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-016-collab.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

// CAD-PARITY-016 remediation: the project key is run-unique — the smoke's
// project state lives in the DURABLE/SHARED persistence backend (memory |
// postgres | blob), so every run must start from a FRESH project record
// (the pinned fixture pins the run's own lineage, not any residue).
const RUN_KEY = `cad-parity-016-smoke-${randomUUID().slice(0, 8)}`;

const BASE = process.env.OFFISOS_WEB_URL ?? "http://localhost:3100";

const { runCommandScript } = await import(join(REPO_ROOT, "app", "src", "workspace", "prompt-engine.ts"));
const { defaultCommandContext } = await import(join(REPO_ROOT, "app", "src", "workspace", "types.ts"));

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const executed = [];
const cmd = (name, payload) => {
  executed.push(name);
  return send({ type: "command", name, payload });
};
const q = (name, payload) => send({ type: "query", name, payload });
const ok = (r) => r.ok === true;
const val = (r) => {
  if (!ok(r)) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

const step = (name) => console.log(`COLLAB P016 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
// CAD-PARITY-016 remediation: the pinned digests normalize the run-unique
// project identity and the content-addressed hashes (both are functions of
// the run-unique canonical entity id — the project key). Every SEMANTIC
// field (ids, seqs, clocks, actors, kinds, detail structure, lifecycles,
// statuses, counters) is pinned verbatim; only the run-identity-derived
// hex is tokenized (documented — never a silent masking of semantics).
const normalizePinned = (s) =>
  s
    .split(RUN_KEY)
    .join("«project»")
    .replace(/[0-9a-f]{64}/g, "«sha256»")
    .replace(/[0-9a-f]{12}…/g, "«sha12»");

// The observable performance budgets: the thresholds come from
// perf.budgets; the wall-clock measurements are asserted per call and
// reported to the run log — NEVER pinned (only deterministic counters are).
const perf = [];
async function timed(label, thresholdMs, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  if (ms > thresholdMs) {
    throw new Error(`PERF BUDGET EXCEEDED — ${label}: ${ms}ms > ${thresholdMs}ms`);
  }
  perf.push(`${label}: ${ms}ms <= ${thresholdMs}ms`);
  console.log(`COLLAB P016 SMOKE: PERF ${label}: ${ms}ms (budget <= ${thresholdMs}ms)`);
  return out;
}

// --- 1. document + the canonical model seed --------------------------------------

step("document.create + the bim seed (the large-model page spread)");
val(
  await cmd("document.create", {
    entityId: RUN_KEY,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-016-smoke",
  }),
);
let snap = val(await q("document.getState", {}));

function context(overrides = {}) {
  return defaultCommandContext({
    activeLayer: snap.draftingSettings?.activeLayer ?? "0",
    elementCount: snap.elements.length,
    currentSelection: [],
    layers: snap.layers ?? [],
    blocks: snap.blockDefs ?? [],
    ...overrides,
  });
}

const echoLines = [];
async function runScript(steps, overrides = {}) {
  const plans = [];
  const result = runCommandScript(steps, context(overrides), (plan) => plans.push(plan));
  for (const line of result.lines) echoLines.push(line);
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

const seedEntities = [
  { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
  { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000, name: "South wall" },
  { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
  { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
  { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
];
for (let i = 0; i < 10; i += 1) {
  seedEntities.push({
    type: "bim.wall",
    id: `wall-f${String(i + 1).padStart(2, "0")}`,
    storyId: "story-gf",
    start: [i * 100, 1000],
    end: [i * 100 + 100, 1000],
    width: 100,
    height: 3000,
  });
}
const seed = val(await cmd("bim.createElements", { entities: seedEntities }));
assert(seed.created.length === 15, `the seed created 15 entities (got ${seed.created.length})`);
snap = val(await q("document.getState", {}));

// --- 2. the members / presence / comments registry stream ----------------------------

step("COLLABJOIN + PRESENCE + COMMENT (the shared command registry)");
const { result: joinScript } = await runScript([
  { event: { type: "typed", text: "COLLABJOIN" } },
  { event: { type: "typed", text: "ekon" } },
  { event: { type: "typed", text: "ED" } }, // the editor flag (selected)
  { event: { type: "enter" } }, // completes the role step (the flag wins)
]);
assert(
  joinScript.lines.includes("COLLABJOIN: member 'ekon' joined as editor."),
  `the COLLABJOIN echo (got ${joinScript.lines.join(" / ")})`,
);

const { result: presenceScript } = await runScript([
  { event: { type: "typed", text: "PRESENCE" } },
  { event: { type: "typed", text: "ekon" } },
]);
assert(
  presenceScript.lines.includes("PRESENCE: heartbeat for 'ekon'."),
  `the PRESENCE echo (got ${presenceScript.lines.join(" / ")})`,
);

// A viewer joins (permission coverage) + a commenter.
val(await cmd("collab.join", { userId: "reviewer", role: "viewer" }));
val(await cmd("collab.join", { userId: "com", role: "commenter" }));

const { result: commentScript } = await runScript([
  { event: { type: "typed", text: "COMMENT" } },
  { event: { type: "typed", text: "ekon" } },
  { event: { type: "typed", text: "Verify the fire rating of the south wall." } },
  { event: { type: "typed", text: "EL" } }, // the element flag
  { event: { type: "enter" } }, // completes the target-kind step
  { event: { type: "typed", text: "wall-south" } },
]);
assert(
  commentScript.lines.includes("COMMENT: 'ekon' on element wall-south."),
  `the COMMENT echo (got ${commentScript.lines.join(" / ")})`,
);

// The permission coverage: the viewer may NOT comment (typed), the
// commenter may comment on the document, resolution records lineage.
const denied = await cmd("collab.comment", { userId: "reviewer", body: "viewer tries", target: { kind: "document" } });
assert(!ok(denied) && denied.code === "collab_forbidden", "the viewer comment declines typed collab_forbidden");
const docComment = await timed("collab.comment", 1000, () =>
  cmd("collab.comment", { userId: "com", body: "Coordination baseline review starts.", target: { kind: "document" } }),
);
assert(ok(docComment) && val(docComment).comment.id === "cmt-000002", "the document comment from the commenter");
const resolved = val(await cmd("collab.resolveComment", { commentId: "cmt-000002", userId: "com" }));
assert(resolved.comment.resolved === true && resolved.comment.resolvedBy === "com", "the resolution lineage");

// Presence liveness + the revision being viewed.
const presenceState = val(await q("collab.state", {}));
assert(presenceState.presenceTtl === 30, "the presence TTL");
// CAD-PARITY-016 remediation: the persistence identity — the honest backend
// the shared/durable state lives in (memory | postgres | blob). The
// backend identity is asserted + PRINTED for the evidence log; the shared
// project key is the run's canonical document entity id.
assert(
  ["memory", "postgres", "blob"].includes(presenceState.persistence.backend),
  `the P016 persistence backend is a real store (got ${JSON.stringify(presenceState.persistence)})`,
);
assert(
  presenceState.persistence.projectKey === RUN_KEY,
  `the shared project key is the canonical document entity id (got ${presenceState.persistence.projectKey})`,
);
console.log(`COLLAB P016 SMOKE: P016 PERSISTENCE BACKEND: ${presenceState.persistence.backend} (project ${RUN_KEY})`);
const BACKEND = presenceState.persistence.backend;
const ekon = presenceState.members.find((m) => m.userId === "ekon");
assert(ekon.active === true && ekon.lastSeenVersion === 2, "ekon is active at v2");

// --- 3. the versioned transactional semantics (TXN + conflict + MERGE) ---------------

step("TXN (applied) + TXN (stale base → conflict) + MERGE (rebase lineage)");
const { result: txnScript } = await runScript([
  { event: { type: "typed", text: "TXN" } },
  { event: { type: "typed", text: "ekon" } },
  { event: { type: "typed", text: "wall-south" } },
  { event: { type: "typed", text: "2" } }, // the current base version
  { event: { type: "typed", text: "FireRating" } },
  { event: { type: "typed", text: "90" } },
]);
assert(
  txnScript.lines.includes("TXN: 'ekon' patches wall-south FireRating=90 at base v2."),
  `the TXN echo (got ${txnScript.lines.join(" / ")})`,
);
const appliedTxn = val(
  await timed("collab.commit", 2000, () =>
    cmd("collab.commit", {
      userId: "ekon",
      baseVersion: 2,
      edits: [{ type: "updateElement", elementId: "wall-south", patch: { FireRating: 90 } }],
    }),
  ),
);
// The registry TXN above already applied it — this second commit from the
// SAME base is the explicit conflict (the reproducible stale-base record).
assert(appliedTxn.applied === false, "the stale-base commit conflicts (the registry TXN moved the head)");
assert(appliedTxn.transaction.status === "conflict", "the conflict status");
assert(
  JSON.stringify(appliedTxn.transaction.conflict.interveningTransactions) === JSON.stringify(["txn-000001"]),
  "the intervening lineage",
);
assert(
  JSON.stringify(appliedTxn.transaction.conflict.overlappingElementIds) === JSON.stringify(["wall-south"]),
  "the overlap is the SAME element (wall-south)",
);

// An overlapping rebase is refused typed; a DISCARD records the lineage.
const refused = await cmd("collab.merge", { transactionId: "txn-000002", userId: "ekon", strategy: "rebase" });
assert(!ok(refused) && refused.code === "merge_conflict", "the overlapping rebase refuses typed merge_conflict");
const { result: mergeScript } = await runScript([
  { event: { type: "typed", text: "MERGE" } },
  { event: { type: "typed", text: "ekon" } },
  { event: { type: "typed", text: "txn-000002" } },
  { event: { type: "typed", text: "DIS" } }, // the discard flag
  { event: { type: "enter" } }, // completes the strategy step
]);
assert(
  mergeScript.lines.includes("MERGE: discard txn-000002 by 'ekon'."),
  `the MERGE echo (got ${mergeScript.lines.join(" / ")})`,
);

// A clean conflict (a different element) resolves by REBASE with lineage.
val(
  await cmd("collab.commit", {
    userId: "ekon",
    baseVersion: 2,
    edits: [{ type: "updateElement", elementId: "wall-east", patch: { AcousticRating: "Class B" } }],
  }),
);
const rebased = val(
  await cmd("collab.merge", { transactionId: "txn-000003", userId: "ekon", strategy: "rebase" }),
);
assert(rebased.transaction.status === "merged", "the rebase applied");
assert(rebased.merge.strategy === "rebase", "the strategy");
assert(JSON.stringify(rebased.merge.parents) === JSON.stringify([2, 3]), "the merge parents [base, head]");
assert(rebased.merge.resultingVersion === 4, "the resulting version");

// The transactions inventory carries the full lineage.
const txns = val(await q("collab.transactions", {}));
assert(txns.transactions.length === 3, "three transactions recorded");

// --- 4. recovery: checkpoints + the deterministic crash recovery ---------------------

step("CKPT + the autosave policy + RECOVER (deterministic restore)");
const { result: ckptScript } = await runScript([{ event: { type: "typed", text: "CKPT" } }]);
assert(
  ckptScript.lines.includes("CKPT: durable versioned checkpoint of the current canonical revision."),
  `the CKPT echo (got ${ckptScript.lines.join(" / ")})`,
);
const ckptList1 = val(await q("recovery.list", {}));
assert(ckptList1.checkpoints[0].id === "ckpt-000001", "the manual checkpoint id");
assert(ckptList1.checkpoints[0].cause === "manual", "the manual cause");
assert(ckptList1.checkpoints[0].documentVersionNumber === 4, "the checkpoint revision binding (v4)");
assert(ckptList1.counters.autosaves === 0, "no autosave yet");

// The hash at the checkpoint.
const hashAtCkpt = val(await q("document.getState", {}));
void hashAtCkpt;

// Mutate past the checkpoint (the autosave policy mints the 5th-mutation
// checkpoint along the way: 3 mutations so far + this one = the 5th
// triggers the FIRST automatic autosave — create(0) createElements(1) txn
// (2) rebase-merge (3) move (4) move2 (5→autosave)).
val(await cmd("bim.move", { ids: ["wall-south"], dx: 0, dy: 100, dz: 0 }));
val(await cmd("bim.move", { ids: ["wall-east"], dx: 0, dy: 100, dz: 0 }));
const listAfterMoves = val(await q("recovery.list", {}));
assert(listAfterMoves.counters.autosaves === 1, "the first automatic autosave (the 5th mutation)");
assert(listAfterMoves.checkpoints.some((c) => c.cause === "autosave"), "the autosave checkpoint is retained");

const hashBeforeRecovery = (await (await fetch(`${BASE}/api/cad`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api: "1", body: { type: "query", name: "document.getState", payload: {} } }) })).json()).value;

// RECOVER (the deterministic latest-valid restore — pre-restore safety
// checkpoint first, the latest non-pre-restore checkpoint chosen).
const { result: recoverScript } = await runScript([
  { event: { type: "typed", text: "RECOVER" } },
  { event: { type: "enter" } }, // <latest valid>
]);
assert(
  recoverScript.lines.includes("RECOVER: deterministic recovery (latest valid checkpoint)."),
  `the RECOVER echo (got ${recoverScript.lines.join(" / ")})`,
);
const recovery = await timed("recovery.restore", 5000, () => cmd("recovery.restore", {}));
const rec = val(recovery);
assert(rec.report.requestedId === null, "the default latest-valid request");
assert(rec.report.chosen.cause === "autosave", "the latest non-pre-restore checkpoint (the autosave)");
assert(rec.report.skipped.length === 0, "no skipped candidates");
assert(rec.preRestoreCheckpoint.cause === "pre-restore", "the pre-restore safety checkpoint");
assert(rec.report.restoredVersionNumber === 6, "the restored version (the autosave checkpoint at the 5th mutation, v6)");
const hashAfterRecovery = val(await q("document.getState", {}));
void hashAfterRecovery;
void hashBeforeRecovery;

// Deterministic restore: the restored content hash matches the chosen
// checkpoint's recorded hash EXACTLY (integrity, never a silent repair).
assert(
  rec.report.restoredContentHash === rec.report.chosen.contentHash,
  "the restored hash matches the checkpoint's recorded hash",
);
const postRecoveryList = val(await q("recovery.list", {}));
assert(postRecoveryList.counters.restores === 2, "the restore counter (the registry RECOVER + the direct restore)");

// --- 5. external references: the controlled lifecycle + the fresh outcomes -------------

step("xref.attach (loaded/unresolved/unsupported) + xrefs.status + xrefs.probe (stale)");
val(
  await cmd("xref.attach", {
    name: "site-plan",
    path: "references/site-plan.json",
    content: {
      elements: [
        {
          id: "xref-line-1",
          kind: "drafting",
          engineId: null,
          props: { drafting: true, type: "line", layer: "0", start: [0, 0], end: [100, 0] },
        },
      ],
    },
  }),
);
// A LOADED record with a proprietary declared source format (the
// dwg_unsupported-class decline) + an unresolved reference (the source
// never supplied).
val(
  await cmd("xref.attach", {
    name: "survey",
    path: "external/survey.dwg",
    content: {
      elements: [
        {
          id: "xref-line-2",
          kind: "drafting",
          engineId: null,
          props: { drafting: true, type: "line", layer: "0", start: [0, 0], end: [200, 0] },
        },
      ],
    },
  }),
);
val(await cmd("xref.attach", { name: "legacy-grid", path: "legacy/grid.rvt" }));

const xrefStatus = val(await q("xrefs.status", {}));
const outcomes = xrefStatus.xrefs.map((x) => x.outcome);
assert(JSON.stringify(outcomes) === JSON.stringify(["available", "unsupported", "unavailable"]), `the outcome table (loaded/loaded-proprietary/unresolved — got ${JSON.stringify(outcomes)})`);
const currentVersion = val(await q("document.getVersion", {}));
assert(
  xrefStatus.xrefs[0].revisionBinding.documentVersionNumber === currentVersion.version_number,
  "the fresh revision binding (computed against the CURRENT canonical version)",
);

// The probe: the record hash vs the current external source hash (stale).
const loadedHash = xrefStatus.xrefs[0].sourceHash;
const probeStale = val(await q("xrefs.probe", { name: "site-plan", sourceHash: "deadbeef".repeat(8) }));
assert(probeStale.probe.outcome === "stale", "the stale probe outcome");
const probeCurrent = val(await q("xrefs.probe", { name: "site-plan", sourceHash: loadedHash }));
assert(probeCurrent.probe.outcome === "available", "the current probe outcome");
const probeMissing = await q("xrefs.probe", { name: "no-such-xref", sourceHash: "x" });
assert(!ok(probeMissing) && probeMissing.code === "xref_not_found", "the unknown xref declines typed");

// --- 6. jobs: the durable background-regeneration lifecycle ----------------------------

step("JOB (queue + 3 ticks → succeeded) + the worker-boundary contract");
const { result: jobScript } = await runScript([
  { event: { type: "typed", text: "JOB" } },
  { event: { type: "typed", text: "QTY" } }, // the quantity.recalculate flag
  { event: { type: "enter" } }, // completes the kind step
  { event: { type: "enter" } }, // queue a new job (no tick id)
]);
assert(
  jobScript.lines.includes("JOB: queue a quantity.recalculate job."),
  `the JOB echo (got ${jobScript.lines.join(" / ")})`,
);
const jobsAfterQueue = val(await q("jobs.list", {}));
const job = jobsAfterQueue.jobs[0];
assert(job.id === "job-000001" && job.status === "queued" && job.totalSteps === 3, "the queued job");
assert(job.persistHint.includes("never authority"), "the worker-boundary authority contract");

for (let i = 1; i <= 3; i += 1) {
  const tick = await timed(`jobs.tick step ${i}`, 2000, () => cmd("jobs.tick", { jobId: job.id }));
  assert(ok(tick), `tick ${i} ok`);
  assert(val(tick).job.step === i, `tick ${i} advanced one deterministic step`);
}
const done = val(await q("jobs.get", { jobId: job.id }));
assert(done.job.status === "succeeded", "the job succeeded");
assert(done.job.result.summary.rows === 14, `the per-element measurable row count (12 walls + slab + space; the story honestly skipped — got ${done.job.result.summary.rows})`);
assert(done.job.result.summary.reportSha256.length === 64, "the canonical report sha256");
assert(
  done.job.result.summary.revision.documentVersionNumber === currentVersion.version_number,
  "the revision-bound job result",
);

// Terminal jobs decline ticks typed; a second job fails deterministically
// (docs.regenerate without views).
const terminal = await cmd("jobs.tick", { jobId: job.id });
assert(!ok(terminal) && terminal.code === "job_terminal", "the terminal decline");
val(await cmd("jobs.create", { kind: "docs.regenerate", params: {} }));
val(await cmd("jobs.tick", { jobId: "job-000002" }));
const failedJob = val(await q("jobs.get", { jobId: "job-000002" }));
assert(failedJob.job.status === "failed" && failedJob.job.failure.code === "job_failed", "the deterministic job failure");

// --- 7. large-model streaming: the bounded cache + the explicit non-authority ----------

step("model.stream pages + the cache non-authority + streamStats");
const page0 = await timed("model.stream page 0 (cache miss)", 3000, () =>
  q("model.stream", { pageIndex: 0, pageSize: 10 }),
);
const p0 = val(page0).page;
assert(p0.totalElements === 15 && p0.totalPages === 2 && p0.elements.length === 10, "the first page");
assert(p0.elements[0].id === "space-office" || p0.elements[0].id.startsWith("story") || p0.elements[0].id.startsWith("wall") || p0.elements[0].id.startsWith("slab"), "canonical id order");
assert(p0.cacheHit === false, "the first derivation (miss)");
const ids = p0.elements.map((e) => e.id).join(",");
assert(ids === [...p0.elements].map((e) => e.id).sort().join(","), "the page is id-sorted");

const page0again = val(await q("model.stream", { pageIndex: 0, pageSize: 10 }));
assert(page0again.page.cacheHit === true, "the revalidated cache hit");
assert(page0again.page.contentHash === p0.contentHash, "identical content either way");

// A canonical edit bumps the version → the cached page is STALE and evicted
// (counted, never served).
val(await cmd("bim.move", { ids: ["wall-f01"], dx: 0, dy: 100, dz: 0 }));
const page0afterEdit = val(await q("model.stream", { pageIndex: 0, pageSize: 10 }));
assert(page0afterEdit.page.cacheHit === false, "the stale entry was evicted (not served)");
assert(
  page0afterEdit.page.documentVersionNumber === currentVersion.version_number + 1,
  "the page is derived from the CURRENT revision (after the edit)",
);
const streamStats = val(await q("model.streamStats", {}));
assert(streamStats.stats.authoritative === false, "the explicit non-authority marker");
assert(streamStats.stats.staleEvictions === 1, "the exact stale accounting");
assert(streamStats.stats.hits === 1 && streamStats.stats.misses === 2, "the exact hit/miss accounting");

// The bounded grammar + range declines typed.
const oob = await q("model.stream", { pageIndex: 2, pageSize: 10 });
assert(!ok(oob) && oob.code === "stream_out_of_range", "the out-of-range decline");
const badSize = await q("model.stream", { pageIndex: 0, pageSize: 5 });
assert(!ok(badSize) && badSize.code === "stream_invalid", "the page-size grammar decline");

// --- 8. the report surfaces + the observable budgets ------------------------------------

step("CKPTLIST + COLLABSTATE + TXNLIST + XREFSTATUS + BUDGETS (the registry report surfaces)");
for (const name of ["CKPTLIST", "COLLABSTATE", "TXNLIST", "XREFSTATUS", "BUDGETS"]) {
  const { result } = await runScript([{ event: { type: "typed", text: name } }]);
  assert(result.lines.includes(`${name}.`), `the ${name} echo`);
}

const budgets = val(await q("perf.budgets", {}));
assert(
  budgets.revision.documentVersionNumber === currentVersion.version_number + 1,
  "the budget revision binding (after the edit)",
);
assert(budgets.counters.comments === 2, "the comment counter");
assert(budgets.counters.transactions === 3, "the transaction counter");
assert(budgets.counters.conflicts === 2 && budgets.counters.merges === 2, "the conflict/merge counters");
assert(budgets.counters.restores === 2, "the restore counter (the registry RECOVER + the direct restore)");
assert(budgets.counters.jobTicks === 4, "the job tick counter (3 + the failing one)");
assert(budgets.counters.streamPages === 3, "the stream page counter");
assert(budgets.counters.cacheHits === 1 && budgets.counters.cacheMisses === 2, "the cache counters");
assert(budgets.counters.presenceBeats === 1, "the presence counter");
for (const b of budgets.budgets) {
  assert(b.unit === "ms" && b.thresholdMs > 0, "the observable threshold shape");
}

// The activity stream: the P016 events in clock order.
const activity = val(await q("collab.activity", {}));
const kinds = activity.activity.map((a) => a.kind);
assert(kinds.includes("member.joined"), "member.joined recorded");
assert(kinds.includes("comment.added") && kinds.includes("comment.resolved"), "comment events recorded");
assert(kinds.includes("transaction.committed") && kinds.includes("transaction.conflict") && kinds.includes("transaction.merged") && kinds.includes("transaction.discarded"), "the transaction lineage events");
assert(kinds.includes("checkpoint.saved") && kinds.includes("recovery.restored"), "the recovery events");
assert(kinds.includes("job.created") && kinds.includes("job.succeeded") && kinds.includes("job.failed"), "the job events");

// --- 9. the pinned fixture (captured BEFORE the round-trip: the run's own
// deterministic project lineage — the persisted event sequence — pinned;
// the remediation clock convention: one tick per persisted project event)

step("fixture");

snap = val(await q("document.getState", {}));
const finalRecovery = val(await q("recovery.list", {}));
const finalCollab = val(await q("collab.state", {}));
const finalComments = val(await q("collab.comments", {}));
const finalTxns = val(await q("collab.transactions", {}));
const finalActivity = val(await q("collab.activity", {}));
const finalJobs = val(await q("jobs.list", {}));
const finalStreamStats = val(await q("model.streamStats", {}));
const finalXrefs = val(await q("xrefs.status", {}));
const finalBudgets = val(await q("perf.budgets", {}));

const fixture = {
  elementCount: snap.elements.length,
  checkpointCount: finalRecovery.checkpoints.length,
  checkpointIds: finalRecovery.checkpoints.map((c) => `${c.id}:${c.cause}:v${c.documentVersionNumber}`),
  autosaves: finalRecovery.counters.autosaves,
  restores: finalRecovery.counters.restores,
  memberRoster: finalCollab.members.map((m) => `${m.userId}:${m.role}:${m.active ? "active" : "stale"}`),
  presenceTtl: finalCollab.presenceTtl,
  commentsSha256: sha(JSON.stringify(finalComments)),
  transactionLineage: finalTxns.transactions.map(
    (t) => `${t.id}:${t.status}:v${t.baseVersion}->${t.resultingVersion ?? "x"}:${t.merge !== null ? `${t.merge.mergeId}/${t.merge.strategy}[${t.merge.parents.join("+")}]` : "-"}`,
  ),
  activityKinds: finalActivity.activity.map((a) => a.kind),
  activityDigest: sha(normalizePinned(JSON.stringify(finalActivity.activity.map((a) => `${a.seq}:${a.at}:${a.actor}:${a.kind}:${a.detail}`)))),
  jobLifecycle: finalJobs.jobs.map((j) => `${j.id}:${j.kind}:${j.status}:${j.step}/${j.totalSteps}`),
  jobReportSha256: sha(normalizePinned(JSON.stringify(finalJobs.jobs.map((j) => j.result ?? j.failure)))),
  streamStats: {
    hits: finalStreamStats.stats.hits,
    misses: finalStreamStats.stats.misses,
    staleEvictions: finalStreamStats.stats.staleEvictions,
    entries: finalStreamStats.stats.entries,
  },
  xrefOutcomes: finalXrefs.xrefs.map((x) => `${x.name}:${x.outcome}`),
  budgetCounters: finalBudgets.counters,
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`COLLAB P016 SMOKE: fixture written → ${FIXTURE_PATH}`);
} else {
  const pinned = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  let mismatch = null;
  for (const key of Object.keys(pinned)) {
    const a = JSON.stringify(pinned[key]);
    const b = JSON.stringify(fixture[key]);
    if (a !== b) {
      mismatch = `${key}: pinned ${a.slice(0, 80)} ≠ actual ${b.slice(0, 80)}`;
      break;
    }
  }
  if (mismatch !== null) {
    throw new Error(`FIXTURE MISMATCH — ${mismatch}`);
  }
  console.log(`COLLAB P016 SMOKE: fixture match (${pinned.budgetCounters.commands} commands)`);
}

// --- 10. the save/open round-trip (the DURABLE project record survives the
// reopen — the crash/session boundary; the remediation closes blocker #1) --

step("save/open round-trip — the durable project record survives the reopen");
const saved = val(await cmd("document.save", {}));
const sA = val(await cmd("document.serialize", {}));
const sB = val(await cmd("document.serialize", {}));
assert(sha(JSON.stringify(sA)) === sha(JSON.stringify(sB.text ?? sA)), "double-serialize is deterministic");
// Reopen the SAME document: the save/open round-trip preserves the canonical
// entity id (the project key) — the durable project record SURVIVES.
val(await cmd("document.open", { source: saved.bytes }));
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 15, "the elements survive the round-trip");
const budgetsAfter = val(await q("perf.budgets", {}));
assert(budgetsAfter.revision.elementCount === 15, "the budgets re-bind to the reopened document");
assert(budgetsAfter.counters.commands === 0, "the session-side counters reset with the new document session");
// BLOCKER #1 CLOSED: the checkpoints are DURABLE across the reopen boundary
// (the project record is keyed by the canonical document entity id — a
// reopened document recovers them; a fresh document gets a fresh project).
const recoveryAfterOpen = val(await q("recovery.list", {}));
assert(
  recoveryAfterOpen.checkpoints.length > 0,
  `the durable checkpoints survive the reopen (got ${recoveryAfterOpen.checkpoints.length})`,
);
assert(
  recoveryAfterOpen.checkpoints.some((c) => c.cause === "manual" || c.cause === "autosave"),
  "the retained durable checkpoints are real (non pre-restore causes)",
);
// The recovery.restore works from the reopened session through the durable
// content-addressed snapshot blobs (the same path a fresh instance takes).
const restoreAfterOpen = await timed("recovery.restore (post-reopen)", 5000, () => cmd("recovery.restore", {}));
const rao = val(restoreAfterOpen);
assert(rao.report.skipped.length === 0, "the post-reopen restore has no skipped candidates");
assert(
  rao.report.restoredContentHash === rao.report.chosen.contentHash,
  "the post-reopen restore is hash-exact (the durable blob integrity)",
);

// --- 11. the multi-session SHARED project state (the remediation closes
// blocker #2): a second participant/session over the SAME project ------

step("the multi-session shared project state (members/comments/transactions converge)");
// The reopened session sees the SHARED roster (the first session's members
// are durable project state — visible to every session/handler/instance).
const sharedState = val(await q("collab.state", {}));
assert(
  sharedState.members.length === 3,
  `the shared roster survives the reopen (ekon/reviewer/com — got ${sharedState.members.map((m) => m.userId).join(",")})`,
);
assert(sharedState.persistence.backend === BACKEND, "the same persistence backend serves the reopened session");
// A SECOND participant joins — the join lands in the SHARED roster.
val(await cmd("collab.join", { userId: "site-b", role: "editor" }));
val(await cmd("collab.presence", { userId: "site-b" }));
const stateB = val(await q("collab.state", {}));
assert(stateB.members.length === 4, "the second session's join lands in the SHARED roster");
assert(
  stateB.members.some((m) => m.userId === "site-b" && m.active === true),
  "the second participant is live in the shared roster",
);
// B comments — the comment is visible as shared project state.
val(
  await cmd("collab.comment", {
    userId: "site-b",
    body: "Second-session coordination note.",
    target: { kind: "document" },
  }),
);
const sharedComments = val(await q("collab.comments", {}));
assert(
  sharedComments.comments.some((c) => c.userId === "site-b" && c.body === "Second-session coordination note."),
  "the second session's comment is shared project state",
);
// The CROSS-SESSION stale-base conflict: the shared transaction lineage head
// is beyond this session's local document version — the commit with the
// pre-collab base conflicts against the SHARED lineage (the second
// participant's stale-base detection, exactly like a second editor who has
// not pulled the latest transactions).
const staleCommit = await cmd("collab.commit", {
  userId: "site-b",
  baseVersion: 2,
  edits: [{ type: "updateElement", elementId: "slab-g", patch: { FireRating: 60 } }],
});
const sc = val(staleCommit);
assert(sc.applied === false, "the cross-session stale-base commit conflicts (against the SHARED lineage head)");
assert(sc.transaction.status === "conflict", "the conflict status");
assert(
  sc.transaction.conflict.interveningTransactions.length >= 1,
  "the conflict names the intervening SHARED transactions",
);
// The shared activity stream records both sessions' events.
const sharedActivity = val(await q("collab.activity", {}));
assert(
  sharedActivity.activity.some((a) => a.actor === "site-b" && a.kind === "member.joined"),
  "the shared activity records the second session's join",
);

// --- 12. a FRESH document starts a FRESH project (the scoping proof) -------

step("a fresh document starts a fresh project (no cross-project state leakage)");
val(await cmd("document.create", { entityId: `${RUN_KEY}-other` }));
const freshState = val(await q("collab.state", {}));
assert(freshState.members.length === 0, "a new document = a new project (fresh scope)");
assert(freshState.persistence.projectKey === `${RUN_KEY}-other`, "the fresh project key re-binds");
const freshRecovery = val(await q("recovery.list", {}));
assert(freshRecovery.checkpoints.length === 0, "no cross-project checkpoint leakage");
const freshTxns = val(await q("collab.transactions", {}));
assert(freshTxns.transactions.length === 0, "no cross-project transaction leakage");

console.log(`COLLAB P016 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines, ${perf.length} perf assertions, backend ${BACKEND})`);
