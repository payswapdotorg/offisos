/**
 * CAD-PARITY-017 (Issue #116) — the PROCESS-RESTART durability proof for
 * the automation/extension state: the durable automation project record
 * (the principals, scripts, run history, subscriptions and extension
 * manifests) survives a FULL SERVER PROCESS KILL and restart through the
 * REAL persistence backend.
 *
 * This is the CI-side crash-recovery boundary proof (the web job's
 * postgres service). It runs its OWN dev-server instance on a dedicated
 * port with DATABASE_URL set, drives a principal + script + subscription +
 * extension + a governed run through the real HTTP App API, KILLS the
 * server (SIGKILL — the simulated crash: all in-memory session state is
 * gone), restarts a FRESH server process over the SAME backend, reopens
 * the same document and asserts:
 *   - the registered principals survived (the authorization hook state);
 *   - the registered scripts survived AND a governed run still executes
 *     through the recovered record (with the SAME reproducible outcome
 *     digest as the pre-crash run of the same script from the same
 *     canonical checkpoint — the reproducibility contract across the
 *     process boundary);
 *   - the run history survived (the pre-crash run records);
 *   - the subscriptions survived (the derived event feed still delivers
 *     the pre-crash canonical records);
 *   - the extension manifests survived with their installed scripts.
 *
 * The automation state rides the SAME append-only durable project record
 * the P016 remediation established (ONE record per canonical document
 * entity id; the process-restart boundary is the P016-verified mechanism —
 * this proof closes the P017 slice over it).
 *
 * Usage: node --import tsx apps/web/test/automation-p017-restart-proof.mjs
 *   (requires DATABASE_URL; a local postgres; skips honestly when unset)
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const WEB_DIR = join(REPO_ROOT, "apps", "web");

const PORT = 3122;
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;

if (typeof DATABASE_URL !== "string" || DATABASE_URL.length === 0) {
  console.log("AUTOMATION P017 RESTART-PROOF: SKIP (no DATABASE_URL — the postgres-backed restart proof runs in the CI web job)");
  process.exit(0);
}

const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};

async function send(body) {
  const res = await fetch(`${BASE}/api/cad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api: "1", body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const cmd = (name, payload) => send({ type: "command", name, payload });
const q = (name, payload) => send({ type: "query", name, payload });
const val = (r) => {
  if (r.ok !== true) throw new Error(JSON.stringify(r).slice(0, 400));
  return r.value;
};

/** Start a FRESH dev-server process on the dedicated port (postgres-backed)
 * and wait until it answers. The child is spawned DETACHED (its own process
 * group) so the crash simulation and the teardown kill the WHOLE server
 * tree — SIGKILLing only the npm wrapper leaves the next-server grandchild
 * alive, which would hold the port (and this script's stdio pipes → the
 * process would never exit; the CI step would hang). */
async function startServer() {
  const child = spawn("npm", ["run", "dev", "--", "--webpack", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      OFFISOS_GEOMETRY_ENGINE: "reference",
      OFFISOS_P016_PERSIST: "postgres",
      DATABASE_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/cad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api: "1", body: { type: "query", name: "document.getState", payload: {} } }),
      });
      if (res.ok) return { child, logs };
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  killTree(child);
  throw new Error(`the dev server did not become ready; logs:\n${logs.join("").slice(-2000)}`);
}

/** Kill the child's whole process group (npm wrapper + next-server
 *  grandchild). */
function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const RUN_KEY = `p017-restart-proof-${randomUUID().slice(0, 8)}`;

const PATCH_SCRIPT = {
  name: "restart-patch",
  profileId: "standard",
  apiVersion: "1",
  description: "The pre-crash governed patch script.",
  steps: [
    { stepId: "inspect", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
    { stepId: "patch", kind: "appApi", request: { type: "command", name: "document.applyEdit", payload: { edit: { type: "setProps", elementId: "wall-south", patch: { FireRating: 90 } } } } },
    { stepId: "verify", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } },
  ],
};

// --- Phase 1: the fresh server, the seed, the automation state ------------

console.log("AUTOMATION P017 RESTART-PROOF: phase 1 — the fresh server + the durable automation state");
const first = await startServer();
try {
  val(await cmd("document.create", { entityId: RUN_KEY }));
  val(
    await cmd("bim.createElements", {
      entities: [
        { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
        { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      ],
    }),
  );
  // The principal + the script + the subscription + the extension.
  val(await cmd("automation.authenticate", { principalId: "restart-bot", role: "editor" }));
  const registered = val(await cmd("automation.registerScript", { principalId: "restart-bot", script: PATCH_SCRIPT }));
  assert(registered.script.id === "scr-000001", "the pre-crash script registration");
  val(await cmd("automation.subscribe", { principalId: "restart-bot", scope: "document" }));
  val(
    await cmd("automation.registerExtension", {
      principalId: "restart-bot",
      extension: {
        extensionId: "restart-ext",
        name: "Restart Extension",
        version: "1.0.0",
        profileId: "standard",
        apiVersion: "1",
        capabilities: ["document.getVersion"],
        scripts: [
          {
            name: "restart-read",
            profileId: "standard",
            apiVersion: "1",
            steps: [{ stepId: "read", kind: "appApi", request: { type: "query", name: "document.getVersion", payload: {} } }],
          },
        ],
      },
    }),
  );
  // The governed pre-crash run + the checkpoint (the reproducibility basis:
  // the post-restart run must produce the SAME outcome digest from the SAME
  // canonical checkpoint).
  val(await cmd("recovery.checkpoint", {}));
  const preRun = val(await cmd("automation.runScript", { principalId: "restart-bot", scriptId: "scr-000001" }));
  assert(preRun.run.status === "completed", "the pre-crash governed run");
  const saved = val(await cmd("document.save", {}));

  // --- Phase 2: the CRASH (SIGKILL — the in-memory session state is gone) --

  console.log("AUTOMATION P017 RESTART-PROOF: phase 2 — SIGKILL (the simulated crash — the whole server process tree)");
  killTree(first.child);
  await new Promise((r) => setTimeout(r, 3000));

  // --- Phase 3: a FRESH server process over the SAME backend --------------

  console.log("AUTOMATION P017 RESTART-PROOF: phase 3 — the fresh process recovers the durable automation state");
  const second = await startServer();
  try {
    val(await cmd("document.open", { source: saved.bytes }));
    // The principals survived (the authorization hook state).
    const principals = val(await q("automation.principals", {}));
    assert(
      principals.principals.length === 1 && principals.principals[0].principalId === "restart-bot",
      `the principal roster survived the restart (got ${JSON.stringify(principals.principals)})`,
    );
    // The scripts survived (including the extension's installed script).
    const scripts = val(await q("automation.scripts", {}));
    assert(scripts.scripts.length === 2, `the registered scripts survived the restart (got ${scripts.scripts.length})`);
    assert(scripts.scripts.some((s) => s.id === "scr-000001" && s.name === "restart-patch"), "the pre-crash script is intact");
    assert(scripts.scripts.some((s) => s.extensionId === "restart-ext"), "the extension's installed script survived");
    // The extension manifest survived.
    const extensions = val(await q("automation.extensions", {}));
    assert(extensions.extensions.length === 1 && extensions.extensions[0].extensionId === "restart-ext", "the extension manifest survived the restart");
    // The run history survived.
    const runs = val(await q("automation.runs", {}));
    assert(runs.runs.length === 1 && runs.runs[0].status === "completed", "the pre-crash run record survived the restart");
    assert(runs.runs[0].outcomeDigest === preRun.run.outcomeDigest, "the pre-crash run digest is intact");
    // The subscription survived: the derived event feed still delivers the
    // pre-crash canonical records (the checkpoint + the run's version bump).
    const feed = val(await q("automation.events", { principalId: "restart-bot" }));
    assert(feed.events.subscriptions === 1, "the subscription survived the restart");
    assert(feed.events.events.length > 0, "the derived event feed still delivers the pre-crash canonical records");
    // The recovered record still EXECUTES: a post-restart governed run of the
    // recovered script from the recovered checkpoint produces the SAME
    // reproducible outcome digest (the reproducibility contract across the
    // process boundary).
    const restore = val(await cmd("recovery.restore", {}));
    assert(restore.report.skipped.length === 0, "the post-restart restore is clean");
    const postRun = val(await cmd("automation.runScript", { principalId: "restart-bot", scriptId: "scr-000001" }));
    assert(postRun.run.status === "completed", "the post-restart governed run executes through the recovered record");
    assert(
      postRun.run.outcomeDigest === preRun.run.outcomeDigest,
      "the post-restart run reproduces the pre-crash outcome digest (identical canonical inputs + the same manifest + the declared profile)",
    );
    assert(postRun.run.endVersion === preRun.run.endVersion, "the post-restart run's version trajectory matches");
    console.log(
      "AUTOMATION P017 RESTART-PROOF: PASS (the process death boundary — the principals, scripts, run history, subscriptions and extensions are durable; the recovered record still executes with the reproducible digest)",
    );
  } finally {
    if (second.child) killTree(second.child);
  }
} finally {
  killTree(first.child);
}

// The spawned trees are killed; exit explicitly (the stdio pipes of a
// SIGKILLed detached child can otherwise hold the event loop open).
process.exit(0);
