/**
 * CAD-PARITY-017 (Issue #116) — the automation/extension core tests: the
 * versioned typed capability registry (discovery + the closed vocabulary +
 * typed unsupported declines — API-001), the authorization hook (the P016
 * role/ability table reused — typed automation_forbidden), script manifest
 * validation, the deterministic script execution (every step through the
 * governed App API — the ONLY mutation route), the reproducible outcome
 * digest (identical canonical inputs + profile → identical digest), the
 * bounded scoped derived event feed, the capability-scoped extension
 * manifests (DATA ONLY — no executable code), and the durable/shared
 * persisted automation state (cross-handler sharing + pre-P017 legacy
 * record backward compatibility).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { MemoryP016Persist, validatePersistedP016State } from "../src/persist/index.js";
import { AutomationStore, automationCapabilityOf, AUTOMATION_CAPABILITIES, deriveAutomationEvents } from "../src/automation/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type {
  AutomationCapabilitiesView,
  AutomationEventView,
  AutomationEventsView,
  AutomationExtensionView,
  AutomationPrincipalView,
  AutomationRunView,
  AutomationScriptView,
  AutomationSubscriptionView,
} from "../src/contracts/automation.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "p017-automation",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p017-automation",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}

function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
  return r as { ok: false; code: string; message: string };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}

async function qq(h: AppApiHandler, name: string, payload: unknown = {}): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

async function seed(h: AppApiHandler): Promise<string> {
  await cmd(h, "document.create", { entityId: "p017-automation-building" });
  await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  });
  const state = val<{ elements: unknown[]; version: { entity_id: string } }>(
    await qq(h, "document.getState"),
  );
  return state.version.entity_id;
}

/** A minimal valid mutating script manifest (a read, a patch, a read). */
function patchScript(name: string, onError: "abort" | "continue" = "abort") {
  return {
    name,
    profileId: "standard",
    apiVersion: "1",
    description: "patch + read-back",
    steps: [
      { stepId: "inspect", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
      {
        stepId: "patch",
        kind: "appApi",
        request: {
          type: "command",
          name: "document.applyEdit",
          payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 60 } } },
        },
        onError,
      },
      { stepId: "verify", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Capability discovery (API-001 — the versioned public automation surface).
// ---------------------------------------------------------------------------

test("automation: capabilities expose the versioned closed registry, bound to the canonical revision", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const caps = val<AutomationCapabilitiesView>(await qq(h, "automation.capabilities"));
  assert.equal(caps.apiVersion, "1");
  assert.equal(caps.profile.profileId, "standard");
  assert.equal(caps.profile.apiVersion, "1");
  assert.equal(caps.bounds.maxSteps, 64);
  assert.equal(caps.bounds.maxScripts, 32);
  assert.equal(caps.bounds.maxRuns, 50);
  assert.equal(caps.bounds.maxEvents, 100);
  // The closed registry: every capability id is a real governed App API
  // request name, commands are mutating, queries are not, and the ability
  // vocabulary is the P016 table.
  assert.ok(caps.capabilities.length >= 40);
  for (const c of caps.capabilities) {
    assert.equal(c.mutating, c.requestType === "command");
    assert.ok(["read", "presence", "comment", "transact", "jobs"].includes(c.requiredAbility));
    assert.ok(c.description.length > 0);
  }
  const ids = new Set(caps.capabilities.map((c) => c.capabilityId));
  assert.equal(ids.size, caps.capabilities.length); // no duplicates
  // The registry excludes automation.* (no nested automation) and the
  // document-swap commands.
  for (const id of ids) {
    assert.ok(!id.startsWith("automation."), `automation.* must not be a capability: ${id}`);
  }
  assert.ok(!ids.has("document.create"));
  assert.ok(!ids.has("document.open"));
  // Revision-bound discovery view.
  assert.equal(caps.documentVersion, 2);
  assert.equal(caps.contentHash.length, 64);
  // The registry module agrees with the served view.
  assert.equal(AUTOMATION_CAPABILITIES.length, caps.capabilities.length);
});

test("automation: unknown capabilities decline typed (no fabricated semantics)", () => {
  const code = (fn: () => unknown): string => {
    try { fn(); } catch (e) { return (e as { code: string }).code; }
    throw new Error("expected a typed decline");
  };
  assert.equal(code(() => automationCapabilityOf("geometry.prepare")), "automation_capability_unsupported");
  assert.equal(code(() => automationCapabilityOf("document.create")), "automation_capability_unsupported");
  assert.equal(code(() => automationCapabilityOf("native.run")), "automation_capability_unsupported");
  assert.equal(code(() => automationCapabilityOf("automation.runScript")), "automation_capability_unsupported");
  assert.throws(() => automationCapabilityOf("automation.runScript"), /not scriptable/);
  assert.equal(automationCapabilityOf("document.getState").requestType, "query");
  assert.equal(automationCapabilityOf("document.applyEdit").requestType, "command");
});

// ---------------------------------------------------------------------------
// Principals + the authorization hook (the reused role table).
// ---------------------------------------------------------------------------

test("automation: authenticate registers principals; duplicates and bad roles decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { principal } = val<{ principal: AutomationPrincipalView }>(
    await cmd(h, "automation.authenticate", { principalId: "site-bot", role: "editor" }),
  );
  assert.equal(principal.principalId, "site-bot");
  assert.equal(principal.role, "editor");
  assert.equal(principal.registeredAt, 1); // the 1st persisted project event (clock 1)
  assert.equal(principal.lastRunAt, null);

  const dup = errVal(await cmd(h, "automation.authenticate", { principalId: "site-bot", role: "viewer" }));
  assert.equal(dup.code, "automation_principal_exists");

  const badRole = errVal(await cmd(h, "automation.authenticate", { principalId: "x", role: "admin" }));
  assert.equal(badRole.code, "automation_bad_payload");
  assert.match(badRole.message, /viewer \| commenter \| editor/);

  const roster = val<{ principals: AutomationPrincipalView[] }>(await qq(h, "automation.principals"));
  assert.equal(roster.principals.length, 1);
});

test("automation: mutating automation requests require the ability (typed forbidden)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "viewer-bot", role: "viewer" });
  // A viewer cannot register a mutating script — the decline names the
  // offending step and the missing ability.
  const declined = errVal(
    await cmd(h, "automation.registerScript", { principalId: "viewer-bot", script: patchScript("viewer-patch") }),
  );
  assert.equal(declined.code, "automation_forbidden");
  assert.match(declined.message, /'transact'/);
  assert.match(declined.message, /step 'patch'/);

  // Unauthenticated principals decline typed on every mutating request.
  const ghost = errVal(
    await cmd(h, "automation.registerScript", { principalId: "ghost", script: patchScript("ghost-patch") }),
  );
  assert.equal(ghost.code, "automation_not_authenticated");
  const ghostRun = errVal(await cmd(h, "automation.runScript", { principalId: "ghost", scriptId: "scr-000001" }));
  assert.equal(ghostRun.code, "automation_not_authenticated");
  const ghostEvents = errVal(await qq(h, "automation.events", { principalId: "ghost" }));
  assert.equal(ghostEvents.code, "automation_not_authenticated");
});

// ---------------------------------------------------------------------------
// Script manifest validation (typed declines; closed vocabularies).
// ---------------------------------------------------------------------------

test("automation: script manifests validate profile, version, steps and capabilities typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });

  const badProfile = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: { ...patchScript("p"), profileId: "unstable" },
    }),
  );
  assert.equal(badProfile.code, "automation_version_unsupported");

  const badVersion = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: { ...patchScript("p"), apiVersion: "2" },
    }),
  );
  assert.equal(badVersion.code, "automation_version_unsupported");

  const badKind = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: [{ stepId: "s1", kind: "native", request: { type: "command", name: "document.applyEdit", payload: {} } }],
      },
    }),
  );
  assert.equal(badKind.code, "automation_step_invalid");
  assert.match(badKind.message, /native code|http|eval/);

  const unknownCap = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: [
          { stepId: "s1", kind: "appApi", request: { type: "command", name: "geometry.prepare", payload: {} } },
        ],
      },
    }),
  );
  assert.equal(unknownCap.code, "automation_capability_unsupported");

  const nested = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: [
          { stepId: "s1", kind: "appApi", request: { type: "command", name: "automation.runScript", payload: {} } },
        ],
      },
    }),
  );
  assert.equal(nested.code, "automation_capability_unsupported");
  assert.match(nested.message, /not scriptable/);

  const typeMismatch = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: [
          { stepId: "s1", kind: "appApi", request: { type: "query", name: "document.applyEdit", payload: {} } },
        ],
      },
    }),
  );
  assert.equal(typeMismatch.code, "automation_step_invalid");

  const dupStep = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: [
          { stepId: "s1", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
          { stepId: "s1", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
        ],
      },
    }),
  );
  assert.equal(dupStep.code, "automation_step_invalid");
  assert.match(dupStep.message, /duplicate stepId/);

  const tooManySteps = errVal(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: {
        name: "p",
        profileId: "standard",
        apiVersion: "1",
        steps: Array.from({ length: 65 }, (_, i) => ({
          stepId: `s${i}`,
          kind: "appApi",
          request: { type: "query" as const, name: "document.getVersion", payload: {} },
        })),
      },
    }),
  );
  assert.equal(tooManySteps.code, "automation_script_invalid");
  assert.match(tooManySteps.message, /1\.\.64/);
});

// ---------------------------------------------------------------------------
// Deterministic script execution (the governed mutation route).
// ---------------------------------------------------------------------------

test("automation: runScript executes every step through the governed App API and records the revision-bound outcome", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: patchScript("fire-patch") }),
  );
  assert.equal(script.id, "scr-000001");
  assert.equal(script.name, "fire-patch");
  assert.equal(script.stepCount, 3);
  assert.deepEqual(script.stepSummary, ["inspect:query:document.getVersion", "patch:command:document.applyEdit", "verify:query:document.getVersion"]);

  const startedVersion = val<{ version_number: number }>(await qq(h, "document.getVersion")).version_number;
  const { run } = val<{ run: AutomationRunView; documentVersion: number }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: script.id }),
  );
  assert.equal(run.id, "run-000001");
  assert.equal(run.status, "completed");
  assert.equal(run.startVersion, startedVersion);
  assert.equal(run.endVersion, startedVersion + 1); // exactly ONE versioned edit
  assert.equal(run.steps.length, 3);
  // Every step outcome is revision-bound (version + content-only hash).
  for (const step of run.steps) {
    assert.equal(step.ok, true);
    assert.ok(Number.isInteger(step.documentVersion));
    assert.equal(step.contentHash.length, 64);
  }
  assert.equal(run.steps[0].documentVersion, startedVersion);
  assert.equal(run.steps[1].documentVersion, startedVersion + 1);
  assert.equal(run.steps[2].documentVersion, startedVersion + 1);
  assert.equal(run.outcomeDigest.length, 64);
  assert.equal(run.reproducible, true);
  // The governed path applied the patch to the CANONICAL document.
  const state = val<{ elements: { id: string; props: Record<string, unknown> }[] }>(await qq(h, "document.getState"));
  const wall = state.elements.find((e) => e.id === "wall-south")!;
  assert.equal(wall.props.FireRating, 60);
  // The principal's lastRunAt is recorded.
  const roster = val<{ principals: AutomationPrincipalView[] }>(await qq(h, "automation.principals"));
  assert.notEqual(roster.principals.find((p) => p.principalId === "editor-bot")!.lastRunAt, null);
});

test("automation: onError abort stops at the first failed step; continue records and proceeds", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });
  const failing = (onError: "abort" | "continue") => ({
    name: `failing-${onError}`,
    profileId: "standard",
    apiVersion: "1",
    steps: [
      {
        stepId: "bad",
        kind: "appApi",
        request: {
          type: "command",
          name: "document.applyEdit",
          payload: { edit: { type: "setProps", elementId: "no-such-element", patch: { x: 1 } } },
        },
        onError,
      },
      { stepId: "after", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
    ],
  });
  const abortScript = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: failing("abort") }),
  );
  const abortRun = val<{ run: AutomationRunView }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: abortScript.script.id }),
  ).run;
  assert.equal(abortRun.status, "failed");
  assert.equal(abortRun.steps.length, 1); // stopped at the first failed step
  assert.equal(abortRun.steps[0].ok, false);
  assert.equal(abortRun.steps[0].code, "edit_failed");
  assert.ok(abortRun.steps[0].message !== undefined);

  const continueScript = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: failing("continue") }),
  );
  const continueRun = val<{ run: AutomationRunView }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: continueScript.script.id }),
  ).run;
  assert.equal(continueRun.status, "completed"); // the tolerated failure is recorded, not hidden
  assert.equal(continueRun.steps.length, 2);
  assert.equal(continueRun.steps[0].ok, false);
  assert.equal(continueRun.steps[1].ok, true);
});

test("automation: identical canonical inputs re-run identically (the reproducibility contract)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: patchScript("repro") }),
  );
  // Checkpoint the canonical state, run once, restore, run again — the
  // outcome digests must be IDENTICAL (a pure function of the canonical
  // inputs + the manifest + the declared profile).
  await cmd(h, "recovery.checkpoint", {});
  const run1 = val<{ run: AutomationRunView; contentHash: string }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: script.id }),
  );
  await cmd(h, "recovery.restore", {});
  const run2 = val<{ run: AutomationRunView; contentHash: string }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: script.id }),
  );
  assert.equal(run2.run.outcomeDigest, run1.run.outcomeDigest);
  assert.equal(run2.run.startVersion, run1.run.startVersion);
  assert.equal(run2.run.endVersion, run1.run.endVersion);
  assert.equal(run2.contentHash, run1.contentHash);
  assert.notEqual(run2.run.id, run1.run.id); // minted ids differ — excluded from the digest
  assert.notEqual(run2.run.startedAt, run1.run.startedAt); // clock differs — excluded from the digest
  // A different script (different manifest) over the same state produces a
  // different digest.
  const other = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", {
      principalId: "editor-bot",
      script: { ...patchScript("repro-2"), steps: patchScript("repro-2").steps.slice(0, 2) },
    }),
  );
  await cmd(h, "recovery.restore", {});
  const run3 = val<{ run: AutomationRunView }>(
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: other.script.id }),
  );
  assert.notEqual(run3.run.outcomeDigest, run1.run.outcomeDigest);
});

test("automation: runScript is idempotent with an idempotency key (no second execution)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: patchScript("idem") }),
  );
  const first = await h.handle({
    type: "command",
    name: "automation.runScript" as never,
    payload: { principalId: "editor-bot", scriptId: script.id },
    idempotencyKey: "run-once",
  });
  assert.equal(first.ok, true);
  const runsAfterFirst = val<{ runs: AutomationRunView[] }>(await qq(h, "automation.runs")).runs.length;
  const replay = await h.handle({
    type: "command",
    name: "automation.runScript" as never,
    payload: { principalId: "editor-bot", scriptId: script.id },
    idempotencyKey: "run-once",
  });
  assert.deepEqual(replay, first); // the cached response — byte-identical
  const runsAfterReplay = val<{ runs: AutomationRunView[] }>(await qq(h, "automation.runs")).runs.length;
  assert.equal(runsAfterReplay, runsAfterFirst); // no second execution, no second run record
});

test("automation: scripts and runs are bounded (typed limits, oldest-first trim)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "viewer" });
  const readScript = {
    name: "read-only",
    profileId: "standard",
    apiVersion: "1",
    steps: [{ stepId: "s1", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } }],
  };
  // A viewer CAN register read-only scripts.
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "editor-bot", script: readScript }),
  );
  for (let i = 0; i < 60; i += 1) {
    await cmd(h, "automation.runScript", { principalId: "editor-bot", scriptId: script.id });
  }
  const runs = val<{ runs: AutomationRunView[] }>(await qq(h, "automation.runs")).runs;
  assert.equal(runs.length, 50); // the bounded history — oldest trimmed
  assert.equal(runs[0].id, "run-000011"); // the first 10 trimmed
  // The run history is durable + deterministic (the ids sequence).
  assert.equal(runs[runs.length - 1].id, "run-000060");
});

// ---------------------------------------------------------------------------
// Subscriptions + the derived scoped event feed.
// ---------------------------------------------------------------------------

test("automation: events deliver bounded, ordered, scoped feeds derived from canonical records", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "editor-bot", role: "editor" });
  // Produce canonical records: a member join (project scope), a transaction
  // (document scope), a checkpoint (document scope), a job lifecycle (jobs
  // scope).
  await cmd(h, "collab.join", { userId: "ekon", role: "editor" });
  await cmd(h, "collab.commit", {
    userId: "ekon",
    baseVersion: 2,
    edits: [{ type: "setProps", elementId: "wall-south", patch: { FireRating: 90 } }],
  });
  await cmd(h, "recovery.checkpoint", {});
  const job = val<{ job: { id: string; totalSteps: number } }>(
    await cmd(h, "jobs.create", { kind: "quantity.recalculate" }),
  );
  await cmd(h, "jobs.tick", { jobId: job.job.id });
  await cmd(h, "jobs.tick", { jobId: job.job.id });
  await cmd(h, "jobs.tick", { jobId: job.job.id });

  // document-scope subscription.
  const docSub = val<{ subscription: AutomationSubscriptionView }>(
    await cmd(h, "automation.subscribe", { principalId: "editor-bot", scope: "document" }),
  );
  assert.equal(docSub.subscription.id, "sub-000001");
  assert.equal(docSub.subscription.scope, "document");
  assert.equal(docSub.subscription.kinds, null);

  const docFeed = val<{ events: AutomationEventsView }>(
    await qq(h, "automation.events", { principalId: "editor-bot" }),
  ).events;
  assert.equal(docFeed.authoritative, false); // the explicit non-authority marker
  assert.equal(docFeed.bounded, true);
  assert.equal(docFeed.subscriptions, 1);
  for (const e of docFeed.events) {
    assert.equal(e.scope, "document");
    assert.ok(e.kind === "transaction.committed" || e.kind === "checkpoint.saved");
  }
  // Ordered by clock ascending (the derived deterministic order).
  const clocks = docFeed.events.map((e) => e.clock);
  assert.deepEqual([...clocks].sort((a, b) => a - b), clocks);
  // The revision bindings cite the canonical records.
  const committed = docFeed.events.find((e) => e.kind === "transaction.committed")!;
  assert.equal(committed.revisionBinding.recordKind, "transaction");
  assert.ok(committed.revisionBinding.recordId.startsWith("txn-"));
  assert.equal(committed.revisionBinding.documentVersion, 3);

  // project-scope subscription: the activity stream (members, comments…).
  await cmd(h, "automation.subscribe", { principalId: "editor-bot", scope: "project" });
  const projectFeed = val<{ events: AutomationEventsView }>(
    await qq(h, "automation.events", { principalId: "editor-bot" }),
  ).events;
  assert.equal(projectFeed.subscriptions, 2);
  assert.ok(projectFeed.events.some((e) => e.kind === "member.joined"));
  assert.ok(!projectFeed.events.some((e) => e.scope === "jobs"));

  // jobs-scope subscription + a kind filter.
  await cmd(h, "automation.subscribe", { principalId: "editor-bot", scope: "jobs", kinds: ["job.succeeded"] });
  const jobsFeed = val<{ events: AutomationEventsView }>(
    await qq(h, "automation.events", { principalId: "editor-bot" }),
  ).events;
  assert.equal(jobsFeed.subscriptions, 3);
  const jobEvents = jobsFeed.events.filter((e) => e.scope === "jobs");
  assert.equal(jobEvents.length, 1); // the kind filter passes only job.succeeded
  assert.equal(jobEvents[0].kind, "job.succeeded");
  assert.ok(jobEvents[0].revisionBinding.recordId.startsWith("job-"));

  // unsubscribe removes exactly that subscription.
  const removed = val<{ subscription: AutomationSubscriptionView }>(
    await cmd(h, "automation.unsubscribe", { principalId: "editor-bot", subscriptionId: docSub.subscription.id }),
  );
  assert.equal(removed.subscription.id, "sub-000001");
  const after = val<{ events: AutomationEventsView }>(
    await qq(h, "automation.events", { principalId: "editor-bot" }),
  ).events;
  assert.equal(after.subscriptions, 2);
  assert.ok(!after.events.some((e) => e.scope === "document"));
});

test("automation: subscriptions are bounded and validated typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "sub-bot", role: "viewer" });
  for (let i = 0; i < 16; i += 1) {
    await cmd(h, "automation.subscribe", { principalId: "sub-bot", scope: "document" });
  }
  const over = errVal(await cmd(h, "automation.subscribe", { principalId: "sub-bot", scope: "document" }));
  assert.equal(over.code, "automation_subscription_limit");
  const badScope = errVal(await cmd(h, "automation.subscribe", { principalId: "sub-bot", scope: "universe" }));
  assert.equal(badScope.code, "automation_bad_payload");
  const badKind = errVal(
    await cmd(h, "automation.subscribe", { principalId: "sub-bot", scope: "document", kinds: ["nonsense.kind"] }),
  );
  assert.equal(badKind.code, "automation_bad_payload");
  const ghost = errVal(await cmd(h, "automation.subscribe", { principalId: "ghost", scope: "document" }));
  assert.equal(ghost.code, "automation_not_authenticated");
});

// ---------------------------------------------------------------------------
// Extensions (capability-scoped DATA manifests — no executable code).
// ---------------------------------------------------------------------------

test("automation: extensions register capability-scoped manifests and install their scripts", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "ext-bot", role: "editor" });
  const manifest = {
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
          {
            stepId: "patch",
            kind: "appApi",
            request: {
              type: "command",
              name: "document.applyEdit",
              payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 120 } } },
            },
          },
        ],
      },
    ],
  };
  const outcome = val<{ extension: AutomationExtensionView; scripts: AutomationScriptView[] }>(
    await cmd(h, "automation.registerExtension", { principalId: "ext-bot", extension: manifest }),
  );
  assert.equal(outcome.extension.extensionId, "qc-runner");
  assert.equal(outcome.extension.version, "1.0.0");
  assert.deepEqual([...outcome.extension.capabilities].sort(), ["document.applyEdit", "document.getVersion"]);
  assert.equal(outcome.scripts.length, 1);
  assert.equal(outcome.scripts[0].extensionId, "qc-runner");
  assert.ok(outcome.scripts[0].id.startsWith("scr-"));
  // The installed script runs through the SAME governed surface.
  const run = val<{ run: AutomationRunView }>(
    await cmd(h, "automation.runScript", { principalId: "ext-bot", scriptId: outcome.scripts[0].id }),
  );
  assert.equal(run.run.status, "completed");
  const state = val<{ elements: { id: string; props: Record<string, unknown> }[] }>(await qq(h, "document.getState"));
  assert.equal(state.elements.find((e) => e.id === "wall-south")!.props.FireRating, 120);
  // The extensions inventory lists the manifest.
  const exts = val<{ extensions: AutomationExtensionView[] }>(await qq(h, "automation.extensions"));
  assert.equal(exts.extensions.length, 1);
});

test("automation: extension manifests with code fields, unknown capabilities or escaping scripts decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "ext-bot", role: "editor" });
  // Executable-code fields are structurally rejected — v1 extensions are
  // DATA ONLY (no code path from a manifest to an engine/renderer/domain
  // boundary).
  for (const field of ["code", "entry", "url", "module"]) {
    const withCode = errVal(
      await cmd(h, "automation.registerExtension", {
        principalId: "ext-bot",
        extension: { extensionId: `bad-${field}`, name: "x", version: "1", profileId: "standard", apiVersion: "1", capabilities: ["document.getVersion"], scripts: [], [field]: "console.log(1)" },
      }),
    );
    assert.equal(withCode.code, "automation_extension_invalid");
    assert.match(withCode.message, /DATA ONLY/);
  }
  const unknownCap = errVal(
    await cmd(h, "automation.registerExtension", {
      principalId: "ext-bot",
      extension: { extensionId: "bad-cap", name: "x", version: "1", profileId: "standard", apiVersion: "1", capabilities: ["geometry.prepare"], scripts: [] },
    }),
  );
  assert.equal(unknownCap.code, "automation_capability_unsupported");
  // A script escaping the declared capability set declines typed.
  const escaping = errVal(
    await cmd(h, "automation.registerExtension", {
      principalId: "ext-bot",
      extension: {
        extensionId: "bad-escape",
        name: "x",
        version: "1",
        profileId: "standard",
        apiVersion: "1",
        capabilities: ["document.getVersion"],
        scripts: [
          {
            name: "escape",
            profileId: "standard",
            apiVersion: "1",
            steps: [
              { stepId: "s", kind: "appApi", request: { type: "command", name: "document.applyEdit", payload: {} } },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(escaping.code, "automation_extension_invalid");
  assert.match(escaping.message, /NOT in the extension's declared capability set/);
  // Registration requires the transact ability (the controlled third-party
  // surface).
  await cmd(h, "automation.authenticate", { principalId: "viewer-bot", role: "viewer" });
  const viewer = errVal(
    await cmd(h, "automation.registerExtension", {
      principalId: "viewer-bot",
      extension: { extensionId: "viewer-ext", name: "x", version: "1", profileId: "standard", apiVersion: "1", capabilities: ["document.getVersion"], scripts: [] },
    }),
  );
  assert.equal(viewer.code, "automation_forbidden");
  // Duplicates decline typed.
  const first = await cmd(h, "automation.registerExtension", {
    principalId: "ext-bot",
    extension: { extensionId: "dup", name: "x", version: "1", profileId: "standard", apiVersion: "1", capabilities: ["document.getVersion"], scripts: [] },
  });
  assert.equal(first.ok, true);
  const dup = errVal(
    await cmd(h, "automation.registerExtension", {
      principalId: "ext-bot",
      extension: { extensionId: "dup", name: "x", version: "1", profileId: "standard", apiVersion: "1", capabilities: ["document.getVersion"], scripts: [] },
    }),
  );
  assert.equal(dup.code, "automation_extension_exists");
});

// ---------------------------------------------------------------------------
// Script lifecycle + the durable/shared persisted automation state.
// ---------------------------------------------------------------------------

test("automation: deleteScript enforces ownership-or-transact; unknown scripts decline typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await cmd(h, "automation.authenticate", { principalId: "owner-bot", role: "editor" });
  await cmd(h, "automation.authenticate", { principalId: "other-viewer", role: "viewer" });
  await cmd(h, "automation.authenticate", { principalId: "other-editor", role: "editor" });
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.registerScript", { principalId: "owner-bot", script: patchScript("doomed") }),
  );
  const stranger = errVal(
    await cmd(h, "automation.deleteScript", { principalId: "other-viewer", scriptId: script.id }),
  );
  assert.equal(stranger.code, "automation_forbidden");
  const editor = val<{ script: AutomationScriptView }>(
    await cmd(h, "automation.deleteScript", { principalId: "other-editor", scriptId: script.id }),
  );
  assert.equal(editor.script.id, script.id);
  const gone = errVal(await cmd(h, "automation.runScript", { principalId: "owner-bot", scriptId: script.id }));
  assert.equal(gone.code, "automation_script_not_found");
});

test("automation: the persisted automation state is durable and shared across handlers", async () => {
  const persist = new MemoryP016Persist();
  const siteA = AppApiHandler.create({ ...CONFIG, p016Persist: persist });
  await seed(siteA);
  await cmd(siteA, "automation.authenticate", { principalId: "shared-bot", role: "editor" });
  const { script } = val<{ script: AutomationScriptView }>(
    await cmd(siteA, "automation.registerScript", { principalId: "shared-bot", script: patchScript("shared") }),
  );
  // A SECOND handler (a fresh session/instance) bound to the same project
  // record: it OPENS the saved canonical document (the same entity id + the
  // same content) and sees the SAME principals and scripts — the
  // durable/shared boundary.
  const saved = val<Record<string, unknown>>(await qq(siteA, "document.getState"));
  const siteB = AppApiHandler.create({ ...CONFIG, p016Persist: persist });
  await cmd(siteB, "document.open", { snapshot: saved });
  const scriptsB = val<{ scripts: AutomationScriptView[] }>(await qq(siteB, "automation.scripts"));
  assert.equal(scriptsB.scripts.length, 1);
  assert.equal(scriptsB.scripts[0].id, script.id);
  const rosterB = val<{ principals: AutomationPrincipalView[] }>(await qq(siteB, "automation.principals"));
  assert.equal(rosterB.principals[0].principalId, "shared-bot");
  // Site B can run the script site A registered (shared durable state, no
  // cross-session gap).
  const runB = val<{ run: AutomationRunView }>(
    await cmd(siteB, "automation.runScript", { principalId: "shared-bot", scriptId: script.id }),
  );
  assert.equal(runB.run.status, "completed");
  // A fresh project (a fresh document) has NO automation state — scoping.
  const siteC = AppApiHandler.create({ ...CONFIG, entityId: "p017-other-project", p016Persist: persist });
  await cmd(siteC, "document.create", { entityId: "p017-other-project-doc" });
  const scriptsC = val<{ scripts: AutomationScriptView[] }>(await qq(siteC, "automation.scripts"));
  assert.equal(scriptsC.scripts.length, 0);
});

test("automation: pre-P017 legacy persisted records (no automation section) validate and rehydrate to the empty store", () => {
  // The P016-era record shape: clock/collab/recovery/jobs, NO automation.
  const legacy = {
    clock: 3,
    collab: { members: [], comments: [], activity: [], transactions: [], seq: { member: 0, comment: 0, txn: 0, merge: 0, activity: 0 }, presenceBeats: 0 },
    recovery: { checkpoints: [], nextSeq: 0 },
    jobs: { jobs: [], seq: 0, tickCount: 0 },
  };
  const validated = validatePersistedP016State(legacy);
  assert.equal(validated.automation, undefined);
  const store = AutomationStore.rehydrate(validated.automation);
  assert.equal(store.principalList().length, 0);
  assert.equal(store.scriptList().length, 0);
  // A malformed automation section is rejected typed (LOCK-007).
  const corrupt = { ...legacy, automation: { principals: "not-an-array" } };
  assert.throws(() => validatePersistedP016State(corrupt), /automation section/);
});

test("automation: the derived event feed is bounded (the last 100 deliveries)", () => {
  const transactions = Array.from({ length: 260 }, (_, i) => ({
    id: `txn-${String(i).padStart(6, "0")}`,
    author: "ekon",
    baseVersion: 1,
    touchedElementIds: [],
    editCount: 1,
    status: "applied" as const,
    recordedAt: i + 1,
    resultingVersion: i + 2,
    conflict: null,
    merge: null,
  }));
  const subs = [{ id: "sub-000001", principalId: "bot", scope: "document" as const, kinds: null }];
  const feed = deriveFeed(transactions, subs);
  assert.equal(feed.events.length, 100); // bounded
  assert.equal(feed.events[0].eventId, "evt:transaction:txn-000160"); // the LAST 100
  assert.equal(feed.events[99].eventId, "evt:transaction:txn-000259");
  // Deterministic order: clock ascending.
  const clocks = feed.events.map((e) => e.clock);
  assert.deepEqual([...clocks].sort((a, b) => a - b), clocks);
});

function deriveFeed(
  transactions: Parameters<typeof deriveAutomationEvents>[0]["transactions"],
  subs: Parameters<typeof deriveAutomationEvents>[1],
) {
  // Local wrapper to keep the test body readable.
  return deriveAutomationEvents(
    { transactions, checkpoints: [], jobs: [], activity: [] },
    subs,
    "bot",
    260,
  );
}
