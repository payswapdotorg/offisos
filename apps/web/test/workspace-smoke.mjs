// CAD-PARITY-002 / Issue #75: Web host workspace workflow smoke.
//
// Drives the EXACT semantic command stream the professional workspace UI
// produces — derived by the SHARED prompt engine (app/src/workspace) —
// against the running dev server, and asserts the document state after
// every step. This is the Web half of the Web/Electron semantic-parity
// evidence (LOCK-004): the Electron smoke runs the same script through
// the real Electron UI and both must match the pinned fixture
// (app/test/fixtures/cad-parity-002-parity.json).
//
// Reproduce: cd <repo>/apps/web && npm run dev -- -p 3100 &
//            then: node --import tsx apps/web/test/workspace-smoke.mjs
//            (OFFISOS_WEB_URL overrides the base URL, default :3100)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "app", "test", "fixtures", "cad-parity-002-parity.json");

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

const TOL = 1e-6;
const step = (name) => console.log(`WEB WORKSPACE SMOKE: ${name}`);

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

// --- 0. The page renders -----------------------------------------------------
step("page render");
const page = await fetch(`${BASE}/`);
assert(page.status === 200, "GET / must be 200");
const html = await page.text();
assert(/Offisos/i.test(html), "the page must render the Offisos workspace shell");

// --- 1. Fresh document --------------------------------------------------------
step("document.create");
assert(
  ok(
    await cmd("document.create", {
      entityId: "cad-parity-002-smoke",
      format: "offisos-occt",
      formatVersion: "1",
      createdBy: "cad-parity-002-smoke",
    }),
  ),
  "document.create (pinned identity for Web/Electron parity)",
);
let snap = val(await q("document.getState", {}));

// --- 2. The representative command-driven workflow ------------------------------
// STORY (defaults via Enter) → LINE (typed) → CIRCLE (typed + distance) → WALL (typed).
// The SAME prompt-engine script a user runs from the command line.
function context() {
  const elements = snap.elements ?? [];
  const stories = elements.filter((el) => el.kind === "bim" && el.props?.type === "bim.story");
  const activeStory = stories.length > 0 ? stories[stories.length - 1].id : null;
  return defaultCommandContext({
    activeLayer: "0",
    activeStoryId: activeStory,
    elementCount: elements.length,
    storyCount: stories.length,
    currentSelection: [],
  });
}

async function runScript(steps) {
  const plans = [];
  const result = runCommandScript(steps, context(), (plan) => plans.push(plan));
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      const res = await cmd(entry.name, entry.payload);
      if (!ok(res)) throw new Error(`plan command failed: ${entry.name}: ${JSON.stringify(res).slice(0, 300)}`);
    }
  }
  snap = val(await q("document.getState", {}));
  return { result, plans };
}

step("STORY (command line, defaults via Enter)");
await runScript([
  { event: { type: "typed", text: "STORY" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
  { event: { type: "enter" } },
]);
const stories = snap.elements.filter((el) => el.kind === "bim" && el.props?.type === "bim.story");
assert(stories.length === 1, `expected 1 story, got ${stories.length}`);
assert(stories[0].props.name === "Story 1", `story name: ${stories[0].props.name}`);
assert(Math.abs(stories[0].props.height - 3000) < TOL, "story height default 3000");
step(`story created: ${stories[0].id}`);

step("LINE via typed coordinates (command-line path)");
await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "4000,0" } },
  { event: { type: "enter" } },
]);
let line = snap.elements.find((el) => el.props?.type === "line");
assert(line !== undefined, "line element must exist");
assert(Math.abs(line.props.from[0]) < TOL && Math.abs(line.props.to[0] - 4000) < TOL, "line geometry exact");

step("CIRCLE center + typed radius");
await runScript([
  { event: { type: "typed", text: "CIRCLE" } },
  { event: { type: "typed", text: "2000,1000" } },
  { event: { type: "typed", text: "500" } },
]);
let circle = snap.elements.find((el) => el.props?.type === "circle");
assert(circle !== undefined, "circle element must exist");
assert(Math.abs(circle.props.radius - 500) < TOL, "circle radius 500");

step("WALL on the active story (BIM command path)");
await runScript([
  { event: { type: "typed", text: "WALL" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "typed", text: "6000,0" } },
]);
let wall = snap.elements.find((el) => el.props?.type === "bim.wall");
assert(wall !== undefined, "wall element must exist");
assert(wall.props.storyId === stories[0].id, "wall references the created story");
assert(Math.abs(wall.props.width - 240) < TOL, "wall default width 240");
assert(snap.elements.length === 4, `expected 4 elements (story+line+circle+wall), got ${snap.elements.length}`);

// --- 3. Deterministic undo/redo ------------------------------------------------
step("undo removes the wall; redo restores it");
assert(ok(await cmd("document.undo", {})), "undo");
snap = val(await q("document.getState", {}));
assert(snap.elements.find((el) => el.props?.type === "bim.wall") === undefined, "wall must be gone after undo");
assert(ok(await cmd("document.redo", {})), "redo");
snap = val(await q("document.getState", {}));
wall = snap.elements.find((el) => el.props?.type === "bim.wall");
assert(wall !== undefined, "wall must be back after redo");
assert(Math.abs(wall.props.end[0] - 6000) < TOL, "redone wall geometry exact");

// --- 4. Command cancellation is deterministic ------------------------------------
step("cancel mid-LINE emits no command");
const before = snap.elements.length;
const cancelRun = await runScript([
  { event: { type: "typed", text: "LINE" } },
  { event: { type: "typed", text: "0,0" } },
  { event: { type: "cancel" } },
]);
assert(cancelRun.plans.length === 0, "canceled LINE must emit zero plans");
assert(cancelRun.result.lines.includes("*Cancel*"), "cancel echoes *Cancel*");
assert(snap.elements.length === before, "no element created by the canceled command");

// --- 5. Deterministic save (parity hash) ------------------------------------------
step("document.save determinism + parity fixture");
const s1 = val(await cmd("document.save", {}));
const s2 = val(await cmd("document.save", {}));
assert(s1.sha256 === s2.sha256, "save must be deterministic");
const sha = createHash("sha256").update(Buffer.from(s1.bytes)).digest("hex");
console.log(`WEB WORKSPACE SMOKE: save sha256 ${sha}`);

if (process.argv.includes("--write-fixture")) {
  mkdirSync(join(REPO_ROOT, "app", "test", "fixtures"), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify({
    saveSha256: sha,
    saveSize: s1.bytes.length,
    elements: snap.elements.length,
    commandStream: executed,
  }, null, 2) + "\n");
  console.log(`WEB WORKSPACE SMOKE: fixture written to ${FIXTURE_PATH}`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert(fixture.saveSha256 === sha, `parity fixture mismatch: expected ${fixture.saveSha256}, got ${sha}`);
  assert(fixture.elements === snap.elements.length, "parity fixture element count");
  assert(fixture.saveSize === s1.bytes.length, "parity fixture save size");
  assert(fixture.commandStream.join("|") === executed.join("|"), `parity fixture command stream:\n  expected ${fixture.commandStream.join("|")}\n  got      ${executed.join("|")}`);
}

step("PASS — line/circle/wall workflow deterministic; parity fixture matched");
console.log(`WEB WORKSPACE SMOKE: executed ${executed.length} semantic commands: ${executed.join(" → ")}`);
