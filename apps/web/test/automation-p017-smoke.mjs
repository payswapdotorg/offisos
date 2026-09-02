// CAD-PARITY-017 / Issue #116: Web host automation/extension/API smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — the SHARED prompt-engine command registry (AUTOAUTH/AUTORUN/
// AUTOSUB + the AUTOCAPS/AUTOLIST/AUTOEVENTS report surfaces in
// commands-automation.ts) plus the App API surface the Automation
// workbench produces (automation.authenticate/registerScript/runScript/
// deleteScript/subscribe/unsubscribe/registerExtension +
// automation.capabilities/principals/scripts/runs/events/extensions) —
// against the running dev server, asserting the state after every step.
// This is the Web half of the Web/Electron semantic-parity evidence
// (LOCK-004); the app-suite automation-p017-host-parity test proves the
// same stream through both hosts; the pinned fixture
// (app/test/fixtures/cad-parity-017-automation.json) is the parity basis.
//
// Covers the CAD-PARITY-017 acceptance surface: the versioned typed
// capability discovery table (the closed registry — anything not listed
// is the typed automation_capability_unsupported decline, never a
// fabricated semantic); the authorization hook (the reused P016 role/
// ability table — typed automation_forbidden on role violations, the
// principal checked before resource lookup); the bounded script manifests
// (typed declines: unknown capabilities, non-appApi step kinds,
// version/profile mismatches, nested automation); the deterministic
// governed script execution (every step through the SAME App API command
// path — the only mutation route) with the reproducible outcome digest
// (identical canonical inputs + the declared profile → the identical
// digest — proven by a checkpoint/restore double-run); the deterministic
// error policies (abort stops, continue records — never hidden); the
// bounded, ordered, scoped derived event feeds (authoritative:false — a
// pure fold over the durable canonical records); the capability-scoped
// extension manifests (DATA ONLY — code fields decline typed, scripts
// escaping the declared set decline typed); the bounded job submission +
// result retrieval through the existing durable job boundary (a script
// driving jobs.create + the stepwise ticks); the durable/shared project
// automation state (survives the save/open round-trip, converges across
// sessions, scoped per canonical document); and the observable
// performance budgets (wall-clock thresholds asserted per call — the
// measurements are reported to the run log and NEVER pinned; only
// deterministic counters are pinned). Engine-free semantics (LOCK-018):
// no engine call is made.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-017-automation.json");
const WRITE_FIXTURE = process.argv.includes("--write-fixture");

// The project key is run-unique — the smoke's project state (including the
// automation section of the durable project record) lives in the
// DURABLE/SHARED persistence backend (memory | postgres | blob), so every
// run must start from a FRESH project record (the pinned fixture pins the
// run's own lineage, not any residue).
const RUN_KEY = `cad-parity-017-smoke-${randomUUID().slice(0, 8)}`;

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

const step = (name) => console.log(`AUTOMATION P017 SMOKE: ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
// The pinned digests normalize the run-unique project identity and the
// content-addressed hashes (both are functions of the run-unique canonical
// entity id — the project key). Every SEMANTIC field (ids, seqs, clocks,
// actors, kinds, detail structure, lifecycles, statuses, digests) is
// pinned verbatim; only the run-identity-derived hex is tokenized
// (documented — never a silent masking of semantics).
const normalizePinned = (s) =>
  s
    .split(RUN_KEY)
    .join("«project»")
    .replace(/[0-9a-f]{64}/g, "«sha256»")
    .replace(/[0-9a-f]{12}…/g, "«sha12»");

// The observable performance budgets: the thresholds are declared here
// (the smoke is the measuring instrument — wall-clock asserted per call
// and reported to the run log, NEVER pinned; only deterministic counters
// are pinned). The P016 perf.budgets surface stays byte-identical.
const perf = [];
async function timed(label, thresholdMs, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  if (ms > thresholdMs) {
    throw new Error(`PERF BUDGET EXCEEDED — ${label}: ${ms}ms > ${thresholdMs}ms`);
  }
  perf.push(`${label}: ${ms}ms <= ${thresholdMs}ms`);
  console.log(`AUTOMATION P017 SMOKE: PERF ${label}: ${ms}ms (budget <= ${thresholdMs}ms)`);
  return out;
}

// --- 1. document + the canonical model seed --------------------------------------

step("document.create + the bim seed (the governed canonical baseline)");
val(
  await cmd("document.create", {
    entityId: RUN_KEY,
    format: "offisos-reference",
    formatVersion: "1",
    createdBy: "cad-parity-017-smoke",
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
const seed = val(await cmd("bim.createElements", { entities: seedEntities }));
assert(seed.created.length === 5, `the seed created 5 entities (got ${seed.created.length})`);
snap = val(await q("document.getState", {}));
assert(snap.version.version_number === 2, "the seeded baseline (create + createElements)");

// --- 2. the capability discovery + the authorization hook (AUTOAUTH) --------------

step("AUTOCAPS + AUTOAUTH (the registry stream) + the authorization boundary");
const caps = val(await timed("automation.capabilities", 1000, () => q("automation.capabilities", {})));
assert(caps.apiVersion === "1", "the automation API version");
assert(caps.profile.profileId === "standard" && caps.profile.apiVersion === "1", "the declared profile");
assert(caps.capabilities.length >= 40, `the closed registry (got ${caps.capabilities.length})`);
assert(caps.bounds.maxSteps === 64 && caps.bounds.maxRuns === 50 && caps.bounds.maxEvents === 100, "the closed bounds");
assert(caps.documentVersion === 2, "the discovery view is revision-bound");
for (const c of caps.capabilities) {
  assert(c.mutating === (c.requestType === "command"), "commands are mutating, queries are not");
  assert(["read", "presence", "comment", "transact", "jobs"].includes(c.requiredAbility), "the P016 ability vocabulary");
  assert(!c.capabilityId.startsWith("automation."), "no nested automation capabilities");
}

// The registry-driven principal registration (the editor principal).
const { result: authScript } = await runScript([
  { event: { type: "typed", text: "AUTOAUTH" } },
  { event: { type: "typed", text: "editor-bot" } },
  { event: { type: "typed", text: "ED" } }, // the editor flag (selected)
  { event: { type: "enter" } }, // completes the role step (the flag wins)
]);
assert(
  authScript.lines.includes("AUTOAUTH: principal 'editor-bot' registered as editor."),
  `the AUTOAUTH echo (got ${authScript.lines.join(" / ")})`,
);
// A viewer principal + a ghost (permission coverage).
val(await cmd("automation.authenticate", { principalId: "viewer-bot", role: "viewer" }));

const ghost = await cmd("automation.registerScript", { principalId: "ghost", script: { name: "x", profileId: "standard", apiVersion: "1", steps: [] } });
assert(!ok(ghost) && ghost.code === "automation_not_authenticated", "the unauthenticated register declines typed");
const ghostRun = await cmd("automation.runScript", { principalId: "ghost", scriptId: "scr-000001" });
assert(!ok(ghostRun) && ghostRun.code === "automation_not_authenticated", "the unauthenticated run declines typed (auth before resource lookup)");

// --- 3. the script manifest validation (typed declines) ----------------------------

step("script registration + the typed manifest declines");
const patchScript = {
  name: "fire-rating-patch",
  profileId: "standard",
  apiVersion: "1",
  description: "Read, patch the south wall fire rating through the governed App API, read back.",
  steps: [
    { stepId: "inspect", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
    { stepId: "patch", kind: "appApi", request: { type: "command", name: "document.applyEdit", payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 90 } } } } },
    { stepId: "verify", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
  ],
};
const registered = val(
  await timed("automation.registerScript", 1000, () =>
    cmd("automation.registerScript", { principalId: "editor-bot", script: patchScript }),
  ),
);
assert(registered.script.id === "scr-000001", "the minted script id");
assert(registered.script.stepCount === 3, "the manifest steps are registered");
assert(registered.script.extensionId === null, "a direct registration (no extension)");

// The typed declines (the honest no-fabricated-semantics coverage).
const viewerRegister = await cmd("automation.registerScript", { principalId: "viewer-bot", script: patchScript });
assert(!ok(viewerRegister) && viewerRegister.code === "automation_forbidden", "the viewer's mutating script declines typed (the ability check at registration)");
assert(viewerRegister.message.includes("step 'patch'"), "the decline names the offending step");
const badProfile = await cmd("automation.registerScript", { principalId: "editor-bot", script: { ...patchScript, profileId: "unstable" } });
assert(!ok(badProfile) && badProfile.code === "automation_version_unsupported", "the unknown profile declines typed");
const badVersion = await cmd("automation.registerScript", { principalId: "editor-bot", script: { ...patchScript, apiVersion: "2" } });
assert(!ok(badVersion) && badVersion.code === "automation_version_unsupported", "the version mismatch declines typed");
const nativeKind = await cmd("automation.registerScript", {
  principalId: "editor-bot",
  script: { name: "native", profileId: "standard", apiVersion: "1", steps: [{ stepId: "s", kind: "native", request: { type: "command", name: "document.applyEdit", payload: {} } }] },
});
assert(!ok(nativeKind) && nativeKind.code === "automation_step_invalid", "the non-appApi step kind declines typed");
const unknownCap = await cmd("automation.registerScript", {
  principalId: "editor-bot",
  script: { name: "engine", profileId: "standard", apiVersion: "1", steps: [{ stepId: "s", kind: "appApi", request: { type: "command", name: "geometry.prepare", payload: {} } }] },
});
assert(!ok(unknownCap) && unknownCap.code === "automation_capability_unsupported", "the unknown capability declines typed");
const nested = await cmd("automation.registerScript", {
  principalId: "editor-bot",
  script: { name: "nested", profileId: "standard", apiVersion: "1", steps: [{ stepId: "s", kind: "appApi", request: { type: "command", name: "automation.runScript", payload: {} } }] },
});
assert(!ok(nested) && nested.code === "automation_capability_unsupported" && nested.message.includes("not scriptable"), "the nested automation capability declines typed");
const typeMismatch = await cmd("automation.registerScript", {
  principalId: "editor-bot",
  script: { name: "mismatch", profileId: "standard", apiVersion: "1", steps: [{ stepId: "s", kind: "appApi", request: { type: "query", name: "document.applyEdit", payload: {} } }] },
});
assert(!ok(typeMismatch) && typeMismatch.code === "automation_step_invalid", "the request-type mismatch declines typed");
const unknownScript = await cmd("automation.runScript", { principalId: "editor-bot", scriptId: "scr-999999" });
assert(!ok(unknownScript) && unknownScript.code === "automation_script_not_found", "the unknown script declines typed");
const dupPrincipal = await cmd("automation.authenticate", { principalId: "editor-bot", role: "viewer" });
assert(!ok(dupPrincipal) && dupPrincipal.code === "automation_principal_exists", "the duplicate principal declines typed");

// --- 4. AUTORUN (the registry-driven governed execution) -----------------------------

step("AUTORUN (the deterministic governed execution + the canonical effect)");
// The registry-driven AUTORUN IS the first run: capture the plan's command
// response (the SAME command the workbench's run button dispatches).
const autorunPlans = [];
const autorunResult = runCommandScript(
  [
    { event: { type: "typed", text: "AUTORUN" } },
    { event: { type: "typed", text: "editor-bot" } },
    { event: { type: "typed", text: "scr-000001" } },
  ],
  context(),
  (plan) => autorunPlans.push(plan),
);
for (const line of autorunResult.lines) echoLines.push(line);
assert(
  autorunResult.lines.includes("AUTORUN: 'editor-bot' runs scr-000001 (deterministic, governed steps)."),
  `the AUTORUN echo (got ${autorunResult.lines.join(" / ")})`,
);
let autorunResponse = null;
for (const plan of autorunPlans) {
  for (const entry of plan.appApi) {
    executed.push(entry.name);
    autorunResponse = await timed("automation.runScript (3 governed steps)", 5000, () =>
      send({ type: "command", name: entry.name, payload: entry.payload }),
    );
  }
}
const run1 = val(autorunResponse);
snap = val(await q("document.getState", {}));
assert(run1.run.id === "run-000001" && run1.run.status === "completed", "the first governed run completes");
assert(run1.run.startVersion === 2 && run1.run.endVersion === 3, "exactly ONE versioned edit through the governed path");
assert(run1.run.steps.length === 3 && run1.run.steps.every((s) => s.ok), "every step outcome is recorded");
assert(run1.run.steps[0].documentVersion === 2 && run1.run.steps[1].documentVersion === 3, "the revision-bound step outcomes");
assert(run1.run.outcomeDigest.length === 64 && run1.run.reproducible === true, "the reproducible digest");
// The canonical effect (the governed mutation route — the ONLY one).
const patched = val(await q("document.getState", {}));
assert(patched.elements.find((e) => e.id === "wall-south").props.FireRating === 90, "the patch landed on the canonical document");
// The viewer CANNOT run the mutating script (the run re-checks).
const viewerRun = await cmd("automation.runScript", { principalId: "viewer-bot", scriptId: "scr-000001" });
assert(!ok(viewerRun) && viewerRun.code === "automation_forbidden", "the viewer's run declines typed (the re-checked ability)");

// --- 5. the reproducibility proof (checkpoint → run → restore → run) ------------------

step("the reproducibility contract (identical canonical inputs → identical digest)");
val(await cmd("recovery.checkpoint", {}));
const repro1 = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: "scr-000001" }));
val(await cmd("recovery.restore", {}));
const repro2 = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: "scr-000001" }));
assert(repro2.run.outcomeDigest === repro1.run.outcomeDigest, "the double-run digest is IDENTICAL (the reproducibility contract)");
assert(repro2.run.startVersion === repro1.run.startVersion && repro2.run.endVersion === repro1.run.endVersion, "the version trajectory is identical");
assert(repro2.contentHash === repro1.contentHash, "the canonical content hash is identical after the re-run");
assert(repro2.run.id !== repro1.run.id, "the minted run ids differ (excluded from the digest by design)");
// A read-only script over the same state produces a different digest.
const readScript = {
  name: "read-only-audit",
  profileId: "standard",
  apiVersion: "1",
  steps: [{ stepId: "audit", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } }],
};
const ro = val(await cmd("automation.registerScript", { principalId: "viewer-bot", script: readScript }));
val(await cmd("automation.runScript", { principalId: "viewer-bot", scriptId: ro.script.id }));
assert(val(await q("automation.runs", {})).runs.length === 4, "the bounded run history");

// --- 6. the deterministic error policies (abort / continue) ---------------------------

step("the onError policies (abort stops; continue records — never hidden)");
const failing = (onError) => ({
  name: `failing-${onError}`,
  profileId: "standard",
  apiVersion: "1",
  steps: [
    { stepId: "bad", kind: "appApi", request: { type: "command", name: "document.applyEdit", payload: { edit: { type: "setProps", elementId: "no-such-wall", patch: { x: 1 } } } }, onError },
    { stepId: "after", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
  ],
});
const abortScript = val(await cmd("automation.registerScript", { principalId: "editor-bot", script: failing("abort") }));
const abortRun = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: abortScript.script.id }));
assert(abortRun.run.status === "failed" && abortRun.run.steps.length === 1, "abort stops at the first failed step");
assert(abortRun.run.steps[0].ok === false && abortRun.run.steps[0].code === "edit_failed", "the typed failure code is recorded");
const continueScript = val(await cmd("automation.registerScript", { principalId: "editor-bot", script: failing("continue") }));
const continueRun = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: continueScript.script.id }));
assert(continueRun.run.status === "completed" && continueRun.run.steps.length === 2, "continue records the failure and proceeds");
assert(continueRun.run.steps[0].ok === false && continueRun.run.steps[1].ok === true, "the tolerated failure is visible, never hidden");

// --- 7. the bounded job submission through a script (the durable job boundary) ---------

step("a script drives the durable job boundary (create + stepwise ticks + result retrieval)");
const jobScript = {
  name: "quantity-audit-job",
  profileId: "standard",
  apiVersion: "1",
  steps: [
    { stepId: "create", kind: "appApi", request: { type: "command", name: "jobs.create", payload: { kind: "quantity.recalculate", params: { groupBy: "type" } } } },
    { stepId: "tick-1", kind: "appApi", request: { type: "command", name: "jobs.tick", payload: { jobId: "job-000001" } } },
    { stepId: "tick-2", kind: "appApi", request: { type: "command", name: "jobs.tick", payload: { jobId: "job-000001" } } },
    { stepId: "tick-3", kind: "appApi", request: { type: "command", name: "jobs.tick", payload: { jobId: "job-000001" } } },
    { stepId: "result", kind: "appApi", request: { type: "query", name: "jobs.get", payload: { jobId: "job-000001" } } },
  ],
};
const jobScriptReg = val(await cmd("automation.registerScript", { principalId: "editor-bot", script: jobScript }));
const jobRun = val(
  await timed("automation.runScript (job lifecycle, 5 steps)", 8000, () =>
    cmd("automation.runScript", { principalId: "editor-bot", scriptId: jobScriptReg.script.id }),
  ),
);
assert(jobRun.run.status === "completed" && jobRun.run.steps.every((s) => s.ok), "the script-driven job lifecycle completes");
const jobsState = val(await q("jobs.list", {}));
assert(jobsState.jobs.length === 1 && jobsState.jobs[0].status === "succeeded", "the durable job reached terminal success through the script's ticks");
assert(jobsState.jobs[0].id === "job-000001", "the deterministic job id (the script's ticks address it)");

// --- 8. the scoped event subscriptions + the derived feed ------------------------------

step("AUTOSUB + the derived scoped feeds (bounded, ordered, revision-bound)");
// Canonical records for the feed derivation: a member join (the project
// scope's activity stream) + a versioned transaction (the document scope's
// revision-bound lineage).
val(await cmd("collab.join", { userId: "ekon", role: "editor" }));
snap = val(await q("document.getState", {})); // refresh: the runs above moved the version
const txnCommit = val(
  await cmd("collab.commit", {
    userId: "ekon",
    baseVersion: snap.version.version_number,
    edits: [{ type: "updateElement", elementId: "wall-east", patch: { AcousticRating: "Class B" } }],
  }),
);
assert(txnCommit.applied === true && txnCommit.transaction.id === "txn-000001", "the versioned transaction (the feed's revision-bound source)");
snap = val(await q("document.getState", {}));
const { result: subScript } = await runScript([
  { event: { type: "typed", text: "AUTOSUB" } },
  { event: { type: "typed", text: "editor-bot" } },
  { event: { type: "typed", text: "DOC" } }, // the document scope flag
  { event: { type: "enter" } },
]);
assert(
  subScript.lines.includes("AUTOSUB: 'editor-bot' subscribed to the document scope."),
  `the AUTOSUB echo (got ${subScript.lines.join(" / ")})`,
);
val(await cmd("automation.subscribe", { principalId: "editor-bot", scope: "project" }));
val(await cmd("automation.subscribe", { principalId: "editor-bot", scope: "jobs", kinds: ["job.succeeded"] }));
const feed = val(await timed("automation.events", 2000, () => q("automation.events", { principalId: "editor-bot" })));
assert(feed.events.authoritative === false && feed.events.bounded === true, "the explicit non-authority markers");
assert(feed.events.subscriptions === 3, "the three subscriptions");
const clocks = feed.events.events.map((e) => e.clock);
assert(clocks.every((c, i) => i === 0 || clocks[i - 1] <= c), "the clock-ordered delivery");
const docEvents = feed.events.events.filter((e) => e.scope === "document");
assert(docEvents.every((e) => e.kind === "transaction.committed" || e.kind === "checkpoint.saved"), "the document scope is revision-bound");
assert(docEvents.some((e) => e.revisionBinding.recordId.startsWith("txn-")), "the events cite the canonical transaction records");
const jobEvents = feed.events.events.filter((e) => e.scope === "jobs");
assert(jobEvents.length === 1 && jobEvents[0].kind === "job.succeeded", "the kind filter passes only job.succeeded");
assert(feed.events.events.some((e) => e.scope === "project" && e.kind === "member.joined"), "the project scope carries the activity stream");
// The unsubscribe removes exactly one subscription.
const subList = feed.events.subscriptions;
val(await cmd("automation.unsubscribe", { principalId: "editor-bot", subscriptionId: "sub-000001" }));
const feed2 = val(await q("automation.events", { principalId: "editor-bot" }));
assert(feed2.events.subscriptions === subList - 1, "the unsubscribe");
assert(!feed2.events.events.some((e) => e.scope === "document"), "the document-scope feed is gone after the unsubscribe");
// Unknown principals decline typed on the feed.
const ghostFeed = await q("automation.events", { principalId: "ghost" });
assert(!ok(ghostFeed) && ghostFeed.code === "automation_not_authenticated", "the unauthenticated feed declines typed");

// --- 9. the extension manifests (capability-scoped DATA) --------------------------------

step("extension registration (DATA-only manifests) + the typed declines");
const extensionManifest = {
  extensionId: "qc-runner",
  name: "QC Runner",
  version: "1.0.0",
  profileId: "standard",
  apiVersion: "1",
  capabilities: ["document.getVersion", "document.applyEdit"],
  scripts: [
    {
      name: "qc-fire-patch",
      profileId: "standard",
      apiVersion: "1",
      steps: [
        { stepId: "check", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
        { stepId: "patch", kind: "appApi", request: { type: "command", name: "document.applyEdit", payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 120 } } } } },
      ],
    },
  ],
};
const extReg = val(
  await timed("automation.registerExtension", 2000, () =>
    cmd("automation.registerExtension", { principalId: "editor-bot", extension: extensionManifest }),
  ),
);
assert(extReg.extension.extensionId === "qc-runner" && extReg.scripts.length === 1, "the extension installs its declared script");
assert(extReg.scripts[0].extensionId === "qc-runner", "the installed script carries the extension lineage");
const extRun = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: extReg.scripts[0].id }));
assert(extRun.run.status === "completed", "the extension script runs through the SAME governed surface");
const patchedExt = val(await q("document.getState", {}));
assert(patchedExt.elements.find((e) => e.id === "wall-south").props.FireRating === 120, "the extension's governed patch landed canonically");
// The typed declines (no executable code; capability scoping).
const codeExt = await cmd("automation.registerExtension", {
  principalId: "editor-bot",
  extension: { ...extensionManifest, extensionId: "bad-code", code: "require('child_process')" },
});
assert(!ok(codeExt) && codeExt.code === "automation_extension_invalid" && codeExt.message.includes("DATA ONLY"), "the code field declines typed (no executable extension surface)");
const escapingExt = await cmd("automation.registerExtension", {
  principalId: "editor-bot",
  extension: { ...extensionManifest, extensionId: "bad-escape", capabilities: ["document.getVersion"] },
});
assert(!ok(escapingExt) && escapingExt.code === "automation_extension_invalid" && escapingExt.message.includes("declared capability set"), "the script escaping the declared set declines typed");
const unknownCapExt = await cmd("automation.registerExtension", {
  principalId: "editor-bot",
  extension: { ...extensionManifest, extensionId: "bad-cap", capabilities: ["geometry.prepare"] },
});
assert(!ok(unknownCapExt) && unknownCapExt.code === "automation_capability_unsupported", "the extension's unknown capability declines typed");
const dupExt = await cmd("automation.registerExtension", { principalId: "editor-bot", extension: extensionManifest });
assert(!ok(dupExt) && dupExt.code === "automation_extension_exists", "the duplicate extension declines typed");
const viewerExt = await cmd("automation.registerExtension", { principalId: "viewer-bot", extension: { ...extensionManifest, extensionId: "viewer-ext" } });
assert(!ok(viewerExt) && viewerExt.code === "automation_forbidden", "the extension registration requires the transact ability");
// The script lifecycle (the owner deletes).
const deleted = val(await cmd("automation.deleteScript", { principalId: "editor-bot", scriptId: abortScript.script.id }));
assert(deleted.script.id === abortScript.script.id, "the owner deletes the script");

// --- 10. the report surfaces + the registry echoes ----------------------------------------

step("AUTOCAPS + AUTOLIST + AUTOEVENTS (the registry report surfaces)");
for (const name of ["AUTOCAPS", "AUTOLIST"]) {
  const { result } = await runScript([{ event: { type: "typed", text: name } }]);
  assert(result.lines.includes(`${name}.`), `the ${name} echo`);
}
const { result: eventsScript } = await runScript([
  { event: { type: "typed", text: "AUTOEVENTS" } },
  { event: { type: "typed", text: "editor-bot" } },
]);
assert(
  eventsScript.lines.includes("AUTOEVENTS: the scoped feed for 'editor-bot'."),
  `the AUTOEVENTS echo (got ${eventsScript.lines.join(" / ")})`,
);
// The principals' lastRunAt bookkeeping.
const principalRows = val(await q("automation.principals", {}));
assert(principalRows.principals.find((p) => p.principalId === "editor-bot").lastRunAt !== null, "the lastRunAt bookkeeping");
assert(principalRows.principals.find((p) => p.principalId === "viewer-bot").registeredAt > 0, "the viewer principal is registered");

// --- 11. the pinned fixture (the run's own deterministic lineage) --------------------------

step("fixture");

snap = val(await q("document.getState", {}));
const finalCaps = val(await q("automation.capabilities", {}));
const finalPrincipals = val(await q("automation.principals", {}));
const finalScripts = val(await q("automation.scripts", {}));
const finalRuns = val(await q("automation.runs", {}));
const finalEvents = val(await q("automation.events", { principalId: "editor-bot" }));
const finalExtensions = val(await q("automation.extensions", {}));
const finalBudgets = val(await q("perf.budgets", {}));

const fixture = {
  elementCount: snap.elements.length,
  capabilityCount: finalCaps.capabilities.length,
  principalRoster: finalPrincipals.principals.map((p) => `${p.principalId}:${p.role}:${p.lastRunAt !== null ? "ran" : "never"}`),
  scriptInventory: finalScripts.scripts.map((s) => `${s.id}:${s.name}:${s.stepCount}:${s.extensionId ?? "-"}`),
  scriptsSha256: sha(normalizePinned(JSON.stringify(finalScripts.scripts.map((s) => [s.id, s.name, s.stepSummary])))),
  runLineage: finalRuns.runs.map((r) => `${r.id}:${r.status}:${r.steps.length}steps:v${r.startVersion}->${r.endVersion}`),
  runsSha256: sha(normalizePinned(JSON.stringify(finalRuns.runs.map((r) => [
    r.id,
    r.scriptId,
    r.principalId,
    r.status,
    r.startedAt,
    r.finishedAt,
    r.startVersion,
    r.endVersion,
    r.outcomeDigest,
    r.steps.map((s) => [s.stepId, s.requestName, s.ok, s.code ?? null, s.documentVersion, s.contentHash]),
  ])))),
  subscriptions: finalEvents.events.subscriptions,
  eventsSha256: sha(normalizePinned(JSON.stringify(finalEvents.events.events.map((e) => [
    e.eventId,
    e.kind,
    e.scope,
    e.clock,
    e.detail,
    [e.revisionBinding.recordKind, e.revisionBinding.recordId, e.revisionBinding.documentVersion],
  ])))),
  eventsDelivered: finalEvents.events.events.length,
  extensionInventory: finalExtensions.extensions.map((x) => `${x.extensionId}:${x.name}:${x.version}:${x.capabilities.length}:${x.scriptIds.length}:${x.registeredBy}`),
  budgetCounters: finalBudgets.counters,
  echoDigest: sha(echoLines.join("\n")),
  commandStream: executed,
};

if (WRITE_FIXTURE || !existsSync(FIXTURE_PATH)) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`AUTOMATION P017 SMOKE: fixture written → ${FIXTURE_PATH}`);
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
  console.log(`AUTOMATION P017 SMOKE: fixture match (${pinned.runLineage.length} runs)`);
}

// --- 12. the save/open round-trip + the durable/shared automation state --------------------

step("save/open round-trip — the durable automation state survives the reopen");
const saved = val(await cmd("document.save", {}));
val(await cmd("document.open", { source: saved.bytes }));
snap = val(await q("document.getState", {}));
assert(snap.elements.length === 5, "the elements survive the round-trip");
// The automation state is DURABLE: the principals, scripts and runs survive
// the reopen (the project record is keyed by the canonical document entity
// id — the same P016 remediation boundary).
const scriptsAfter = val(await q("automation.scripts", {}));
assert(scriptsAfter.scripts.length === finalScripts.scripts.length, "the scripts survive the reopen");
const principalsAfter = val(await q("automation.principals", {}));
assert(principalsAfter.principals.some((p) => p.principalId === "editor-bot"), "the principals survive the reopen");
const runsAfter = val(await q("automation.runs", {}));
assert(runsAfter.runs.length === finalRuns.runs.length, "the run history survives the reopen");
// The reopened session can still run the script (the governed path works
// from the fresh session through the durable record).
const postReopenRun = val(await cmd("automation.runScript", { principalId: "editor-bot", scriptId: "scr-000001" }));
assert(postReopenRun.run.status === "completed", "the post-reopen run completes through the durable record");
// A SECOND session's principal registers + runs — the shared convergence.
val(await cmd("automation.authenticate", { principalId: "site-b", role: "editor" }));
const sharedRun = val(await cmd("automation.runScript", { principalId: "site-b", scriptId: "scr-000001" }));
assert(sharedRun.run.status === "completed", "the second session's run (shared durable state)");
const principalsShared = val(await q("automation.principals", {}));
assert(principalsShared.principals.some((p) => p.principalId === "site-b"), "the second session's principal is shared project state");
// A FRESH document starts a FRESH automation project (the scoping proof).
val(await cmd("document.create", { entityId: `${RUN_KEY}-other` }));
const freshPrincipals = val(await q("automation.principals", {}));
assert(freshPrincipals.principals.length === 0, "a new document = a new automation project (fresh scope)");
const freshScripts = val(await q("automation.scripts", {}));
assert(freshScripts.scripts.length === 0, "no cross-project script leakage");
const freshRuns = val(await q("automation.runs", {}));
assert(freshRuns.runs.length === 0, "no cross-project run leakage");

console.log(`AUTOMATION P017 SMOKE: PASS (${executed.length} commands, ${echoLines.length} echo lines, ${perf.length} perf assertions)`);
