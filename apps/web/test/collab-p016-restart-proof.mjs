/**
 * CAD-PARITY-016 remediation (the Architect CHANGES REQUESTED, blocker #1) —
 * the PROCESS-RESTART durability proof: the P016 project record (the
 * checkpoints + the content-addressed snapshot blobs + the collaboration
 * state) survives a FULL SERVER PROCESS KILL and restart through the REAL
 * persistence backend.
 *
 * This is the CI-side crash-recovery boundary proof (the web job's postgres
 * service). It runs its OWN dev-server instance on a dedicated port with
 * DATABASE_URL set, drives a checkpoint + member + comment through the real
 * HTTP App API, KILLS the server (SIGKILL — the simulated crash: all
 * in-memory session state is gone), restarts a FRESH server process over
 * the SAME backend, reopens the same document and asserts:
 *   - the durable checkpoint inventory is intact;
 *   - the recovery.restore rebuilds the canonical document hash-exactly
 *     from the durable content-addressed blobs;
 *   - the shared collaboration state (the member roster) survived.
 *
 * The deployed equivalent boundary (serverless instance rotation) is proven
 * by the deployed collab-p016 smoke against the linked blob store.
 *
 * Usage: node --import tsx apps/web/test/collab-p016-restart-proof.mjs
 *   (requires DATABASE_URL; a local postgres; skips honestly when unset)
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const WEB_DIR = join(REPO_ROOT, "apps", "web");

const PORT = 3121;
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;

if (typeof DATABASE_URL !== "string" || DATABASE_URL.length === 0) {
  console.log("COLLAB P016 RESTART-PROOF: SKIP (no DATABASE_URL — the postgres-backed restart proof runs in the CI web job)");
  process.exit(0);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
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

const RUN_KEY = `p016-restart-proof-${randomUUID().slice(0, 8)}`;

// --- Phase 1: the fresh server, the seed, the checkpoint, the member ------

console.log("COLLAB P016 RESTART-PROOF: phase 1 — the fresh server + the durable state");
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
  val(await cmd("collab.join", { userId: "ekon", role: "editor" }));
  val(
    await cmd("collab.comment", {
      userId: "ekon",
      body: "The pre-crash coordination note.",
      target: { kind: "document" },
    }),
  );
  const { checkpoint } = val(await cmd("recovery.checkpoint", {}));
  const state = val(await q("document.getState", {}));
  // The CANONICAL projection is what must survive the process boundary
  // byte-exactly: version, format, elements, modelHistory, layers,
  // selection, drafting/bim settings, sourceArtifactLineage — compared
  // under the project's canonical JSON form (recursively sorted keys — the
  // same form every pinned fixture and content hash uses; the live editing
  // session's in-memory key order is an implementation detail, while the
  // restored document's history is rebuilt through the canonical clone
  // CADDocument.open → cloneHistory → canonicalStringify). The
  // `editorState` section (the session-local undo history + the in-flight
  // command depth) is PROCESS-SCOPED BY DESIGN — a fresh process starts with
  // an empty undo stack (it cannot undo a dead process's commands), so
  // `canUndo`/`commandDepth` legitimately differ across the restart. The
  // canonical content identity is separately proven by the restored
  // content hash below.
  const canonicalOf = (s) => {
    const { editorState, ...canonical } = s;
    return canonical;
  };
  const canonicalJson = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  };
  const hashAtCheckpoint = canonicalJson(canonicalOf(state));
  const saved = val(await cmd("document.save", {}));
  const persistence = val(await q("collab.state", {}));

  // --- Phase 2: the CRASH (SIGKILL — the in-memory session state is gone) --

  console.log("COLLAB P016 RESTART-PROOF: phase 2 — SIGKILL (the simulated crash — the whole server process tree)");
  killTree(first.child);
  await new Promise((r) => setTimeout(r, 3000));

  // --- Phase 3: a FRESH server process over the SAME backend --------------

  console.log("COLLAB P016 RESTART-PROOF: phase 3 — the fresh process recovers the durable state");
  const second = await startServer();
  try {
    val(await cmd("document.open", { source: saved.bytes }));
    // The backend identity is the REAL postgres store.
    const after = val(await q("collab.state", {}));
    assert(
      after.persistence.backend === "postgres",
      `the restarted server is postgres-backed (got ${after.persistence.backend})`,
    );
    assert(after.persistence.projectKey === RUN_KEY, "the project key re-binds to the reopened document");
    // The shared collaboration state survived the process death.
    assert(
      after.members.length === 1 && after.members[0].userId === "ekon",
      `the member roster survived the restart (got ${JSON.stringify(after.members)})`,
    );
    const comments = val(await q("collab.comments", {}));
    assert(
      comments.comments.some((c) => c.body === "The pre-crash coordination note."),
      "the pre-crash comment survived the restart",
    );
    // The durable checkpoint inventory is intact.
    const list = val(await q("recovery.list", {}));
    assert(
      list.checkpoints.some((c) => c.id === checkpoint.id),
      `the durable checkpoint survived the restart (got ${JSON.stringify(list.checkpoints)})`,
    );
    // The recovery.restore rebuilds the canonical document hash-exactly from
    // the durable content-addressed blobs.
    const restore = val(await cmd("recovery.restore", { checkpointId: checkpoint.id }));
    assert(restore.report.chosen.id === checkpoint.id, "the requested checkpoint is chosen");
    assert(restore.report.skipped.length === 0, "no skipped candidates");
    assert(
      restore.report.restoredContentHash === checkpoint.contentHash,
      "the restored hash matches the checkpoint's recorded hash (blob integrity)",
    );
    const stateAfter = val(await q("document.getState", {}));
    assert(
      canonicalJson(canonicalOf(stateAfter)) === hashAtCheckpoint,
      "the restored CANONICAL document state is identical to the pre-crash checkpoint state under the project's canonical JSON form (the process-scoped session editorState — undo history, command depth — is excluded by design)",
    );
    console.log(
      "COLLAB P016 RESTART-PROOF: PASS (the process death boundary — the checkpoints, blobs, members and comments are durable; the restore is hash-exact)",
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
