/**
 * CAD-PARITY-002 — deterministic prompt engine: the command/selection/input
 * state machine (Issue #75). Proves the acceptance criteria:
 *  - a representative line/circle/wall workflow completes from typed
 *    coordinates (command-line path) AND picked points (mouse path) with
 *    IDENTICAL semantic command plans;
 *  - Enter/cancel/repeat semantics are deterministic;
 *  - validation failures cancel with actionable messages (LOCK-008).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  runCommandScript,
  type CommandScriptStep,
} from "../src/workspace/prompt-engine.js";
import type { CommandContext, CommandPlan } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return defaultCommandContext(overrides);
}

interface Collected {
  readonly plans: readonly CommandPlan[];
  readonly lines: readonly string[];
}

function run(steps: readonly CommandScriptStep[], context: CommandContext): Collected {
  const plans: CommandPlan[] = [];
  const lines: string[] = [];
  const result = runCommandScript(steps, context, (plan) => {
    plans.push(plan);
    lines.push(...plan.echo);
  });
  return { plans, lines: [...lines, ...result.lines] };
}

// --- LINE: typed path vs picked path produce the SAME semantic command ------

test("LINE via typed coordinates produces one drafting.createEntities command", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "4000,0" } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [
    {
      name: "drafting.createEntities",
      payload: { entities: [{ type: "line", layer: "0", from: [0, 0], to: [4000, 0] }] },
    },
  ]);
});

test("LINE via mouse picks produces the IDENTICAL semantic command", () => {
  const { plans } = run(
    [
      { event: { type: "start", commandId: "line" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [4000, 0] } },
      { event: { type: "cancel" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [
    {
      name: "drafting.createEntities",
      payload: { entities: [{ type: "line", layer: "0", from: [0, 0], to: [4000, 0] }] },
    },
  ]);
});

test("LINE chains: three picks create two segments in one command run", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "L" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "1000,0" } },
      { event: { type: "typed", text: "1000,1000" } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "line", layer: "0", from: [0, 0], to: [1000, 0] }],
  });
  assert.deepEqual(plans[1]!.appApi[0]!.payload, {
    entities: [{ type: "line", layer: "0", from: [1000, 0], to: [1000, 1000] }],
  });
});

test("LINE relative + direct-distance input: @500,0 then 500 along +X cursor", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "typed", text: "100,100" } },
      { event: { type: "typed", text: "@500,0", cursor: [900, 100] } },
      { event: { type: "typed", text: "500", cursor: [2000, 100] } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "line", layer: "0", from: [100, 100], to: [600, 100] }],
  });
  // Direct distance 500 along the base→cursor direction (+X).
  assert.deepEqual(plans[1]!.appApi[0]!.payload, {
    entities: [{ type: "line", layer: "0", from: [600, 100], to: [1100, 100] }],
  });
});

test("LINE cancel mid-command emits no plan and echoes *Cancel*", () => {
  const { plans, lines } = run(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "cancel" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 0);
  assert.equal(lines.includes("*Cancel*"), true);
});

test("LINE Undo option emits document.undo and reverts the chain base", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "1000,0" } },
      { event: { type: "typed", text: "U" } },
      { event: { type: "typed", text: "0,1000" } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  // Segment 1, then the undo (document.undo), then the replacement segment.
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[1]!.appApi, [{ name: "document.undo", payload: {} }]);
  assert.deepEqual(plans[2]!.appApi[0]!.payload, {
    entities: [{ type: "line", layer: "0", from: [0, 0], to: [0, 1000] }],
  });
});

// --- CIRCLE -------------------------------------------------------------------

test("CIRCLE center + typed radius", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "CIRCLE" } },
      { event: { type: "typed", text: "2000,1000" } },
      { event: { type: "typed", text: "500" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "circle", layer: "0", center: [2000, 1000], radius: 500 }],
  });
});

test("CIRCLE radius via pick measures the distance from the center", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "C" } },
      { event: { type: "typed", text: "2000,1000" } },
      { event: { type: "pick", point: [2500, 1000] } },
    ],
    ctx(),
  );
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "circle", layer: "0", center: [2000, 1000], radius: 500 }],
  });
});

test("CIRCLE rejects non-positive radius with an actionable message", () => {
  const result = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "CIRCLE" }, ctx());
  const r2 = applyPromptEvent(result.state, { type: "typed", text: "0,0" }, ctx());
  const r3 = applyPromptEvent(r2.state, { type: "typed", text: "0" }, ctx());
  assert.equal(r3.output.plan, null);
  assert.equal(r3.output.lines.some((l) => /positive/i.test(l)), true);
});

// --- WALL (BIM) ---------------------------------------------------------------

test("WALL requires an active story and fails fast with guidance", () => {
  const { plans, lines } = run(
    [
      { event: { type: "typed", text: "WALL" } },
    ],
    ctx({ activeStoryId: null }),
  );
  assert.equal(plans.length, 0);
  assert.equal(lines.some((l) => /active story/i.test(l)), true);
});

test("WALL on the active story emits one bim.createElements command", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "WALL" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "6000,0" } },
    ],
    ctx({ activeStoryId: "story-gf" }),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [
    {
      name: "bim.createElements",
      payload: {
        entities: [
          {
            type: "bim.wall",
            storyId: "story-gf",
            start: [0, 0],
            end: [6000, 0],
            width: 240,
            height: 3000,
          },
        ],
      },
    },
  ]);
});

test("WALL with zero length is rejected explicitly (no silent entity)", () => {
  const { plans, lines } = run(
    [
      { event: { type: "typed", text: "WALL" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "0,0" } },
    ],
    ctx({ activeStoryId: "story-gf" }),
  );
  assert.equal(plans.length, 0);
  assert.equal(lines.some((l) => /coincide/i.test(l)), true);
});

// --- STORY --------------------------------------------------------------------

test("STORY with defaults names from the story count and activates the created story", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "STORY" } },
      { event: { type: "enter" } },
      { event: { type: "enter" } },
      { event: { type: "enter" } },
    ],
    ctx({ storyCount: 0 }),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "bim.story", name: "Story 1", level: 0, height: 3000 }],
  });
  assert.deepEqual(plans[0]!.ui, [{ action: "story.activateCreated" }]);
});

test("STORY typed values override the defaults", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "ST" } },
      { event: { type: "typed", text: "Ground Floor" } },
      { event: { type: "typed", text: "-3000" } },
      { event: { type: "typed", text: "3600" } },
    ],
    ctx({ storyCount: 2 }),
  );
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "bim.story", name: "Ground Floor", level: -3000, height: 3600 }],
  });
});

// --- DOOR / WINDOW --------------------------------------------------------------

function wallPick(): { id: string; kind: string; props: Record<string, unknown> } {
  return {
    id: "wall-1",
    kind: "bim",
    props: { bim: true, type: "bim.wall", storyId: "story-gf", start: [0, 0], end: [5000, 0], width: 240, height: 3000 },
  };
}

test("DOOR creates opening + door in ONE atomic batch with explicit ids", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "DOOR" } },
      { event: { type: "entity", entity: wallPick() } },
      { event: { type: "typed", text: "2000,300" } },
    ],
    ctx({ activeStoryId: "story-gf", elementCount: 3 }),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [
      { type: "bim.opening", id: "cmd-open-4", hostId: "wall-1", distance: 2000, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", openingId: "cmd-open-4", storyId: "story-gf", swing: "left" },
    ],
  });
});

test("DOOR rejects a non-wall host and out-of-span positions", () => {
  const notWall = { id: "slab-1", kind: "bim", props: { bim: true, type: "bim.slab", storyId: "s", corner1: [0, 0], corner2: [1, 1], thickness: 200 } };
  const { plans, lines } = run(
    [
      { event: { type: "typed", text: "DOOR" } },
      { event: { type: "entity", entity: notWall } },
    ],
    ctx({ activeStoryId: "story-gf" }),
  );
  assert.equal(plans.length, 0);
  assert.equal(lines.some((l) => /host must be a wall/i.test(l)), true);

  const outOfSpan = run(
    [
      { event: { type: "typed", text: "DOOR" } },
      { event: { type: "entity", entity: wallPick() } },
      { event: { type: "typed", text: "9000,0" } },
    ],
    ctx({ activeStoryId: "story-gf" }),
  );
  assert.equal(outOfSpan.plans.length, 0);
  assert.equal(outOfSpan.lines.some((l) => /outside the wall/i.test(l)), true);
});

test("WINDOW creates the opening + window batch with sill", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "WN" } },
      { event: { type: "entity", entity: wallPick() } },
      { event: { type: "typed", text: "1500,50" } },
    ],
    ctx({ activeStoryId: "story-gf", elementCount: 0 }),
  );
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [
      { type: "bim.opening", id: "cmd-open-1", hostId: "wall-1", distance: 1500, width: 1200, height: 1500, sill: 900 },
      { type: "bim.window", openingId: "cmd-open-1", storyId: "story-gf" },
    ],
  });
});

// --- POLYLINE -------------------------------------------------------------------

test("POLYLINE collects vertices until Enter; Close option closes it", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "PL" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "1000,0" } },
      { event: { type: "typed", text: "1000,500" } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "polyline", layer: "0", points: [[0, 0], [1000, 0], [1000, 500]], closed: false }],
  });

  const closed = run(
    [
      { event: { type: "typed", text: "PL" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "1000,0" } },
      { event: { type: "typed", text: "C" } },
    ],
    ctx(),
  );
  assert.deepEqual(closed.plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "polyline", layer: "0", points: [[0, 0], [1000, 0]], closed: true }],
  });
});

test("POLYLINE with a single vertex does not create anything (min 2)", () => {
  const { plans } = run(
    [
      { event: { type: "typed", text: "PL" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "enter" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 0);
});

// --- MOVE / ERASE (selection semantics) ----------------------------------------

test("MOVE with picked objects and typed displacement partitions drafting/BIM", () => {
  const line = { id: "e1", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [1, 0] } };
  const { plans } = run(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "entity", entity: line } },
      { event: { type: "enter" } },
      { event: { type: "typed", text: "500,250" } },
      { event: { type: "typed", text: "500,250" } },
    ],
    ctx(),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [{ name: "drafting.move", payload: { ids: ["e1"], dx: 500, dy: 250 } }]);
});

test("MOVE with zero picks falls back to the current selection on Enter", () => {
  const line = { id: "e1", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [1, 0] } };
  const wall = { id: "w1", kind: "bim", props: { bim: true, type: "bim.wall", storyId: "s", start: [0, 0], end: [2, 0], width: 240, height: 3000 } };
  const { plans } = run(
    [
      { event: { type: "typed", text: "M" } },
      { event: { type: "enter" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "100,0" } },
    ],
    ctx({ currentSelection: [line, wall] }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.appApi.length, 2);
  assert.deepEqual(plans[0]!.appApi[0], { name: "drafting.move", payload: { ids: ["e1"], dx: 100, dy: 0 } });
  assert.deepEqual(plans[0]!.appApi[1], { name: "bim.move", payload: { ids: ["w1"], dx: 100, dy: 0, dz: 0 } });
});

test("ERASE via P (previous selection) + Enter deletes both partitions", () => {
  const line = { id: "e1", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [1, 0] } };
  const wall = { id: "w1", kind: "bim", props: { bim: true, type: "bim.wall", storyId: "s", start: [0, 0], end: [2, 0], width: 240, height: 3000 } };
  const { plans } = run(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "enter" } },
    ],
    ctx({ currentSelection: [line, wall] }),
  );
  assert.deepEqual(plans[0]!.appApi, [
    { name: "drafting.delete", payload: { ids: ["e1"] } },
    { name: "bim.delete", payload: { ids: ["w1"] } },
  ]);
});

// --- Prompt lifecycle ------------------------------------------------------------

test("Enter when idle repeats the last command", () => {
  const result = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "CIRCLE" }, ctx());
  const after = applyPromptEvent(result.state, { type: "typed", text: "10,10" }, ctx());
  const after2 = applyPromptEvent(after.state, { type: "typed", text: "5" }, ctx());
  assert.equal(after2.state.commandId, null);
  const repeat = applyPromptEvent(after2.state, { type: "enter" }, ctx());
  assert.equal(repeat.state.commandId, "circle");
  assert.equal(repeat.output.commandName, "CIRCLE");
});

test("COMPAT-CAD-007: a typed token mid-command NEVER switches commands (AutoCAD prompt-owns-input)", () => {
  // The CAD-BENCH-RW-001 DEF-007 finding: the shipped "command token typed
  // while a command runs starts the new command" behavior produced the
  // per-command lottery ("Undo" at LINE ran UNDO; "Arc" at POLYLINE ran
  // ARC; "ALL" at MOVE ran SELECTALL) that destroyed the command-line
  // trust contract. COMPAT-CAD-007 replaces it with the AutoCAD contract:
  // the running prompt owns its input — a typed token that is not a valid
  // option/coordinate/number answers with the step's explicit typed error
  // and the command KEEPS RUNNING. (This test REPLACES the pre-CC007 pin
  // "starting a new command cancels the running one first".)
  const line = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "LINE" }, ctx());
  const mid = applyPromptEvent(line.state, { type: "typed", text: "0,0" }, ctx());
  const notSwitched = applyPromptEvent(mid.state, { type: "typed", text: "CIRCLE" }, ctx());
  assert.equal(notSwitched.state.commandId, "line", "LINE must keep running");
  assert.ok(!notSwitched.output.lines.includes("*Cancel*"), `no *Cancel* echo: ${JSON.stringify(notSwitched.output.lines)}`);
  assert.ok(
    notSwitched.output.lines.length > 0 && /CIRCLE/i.test(notSwitched.output.lines[0]!),
    `the typed error must name the rejected token: ${JSON.stringify(notSwitched.output.lines)}`,
  );
  // The command still completes normally afterwards.
  const done = applyPromptEvent(notSwitched.state, { type: "typed", text: "100,0" }, ctx());
  assert.equal(done.state.commandId, "line");
});

test("unknown command echoes an actionable message", () => {
  const { lines } = run([{ event: { type: "typed", text: "FROBNICATE" } }], ctx());
  assert.equal(lines.some((l) => /unknown command/i.test(l)), true);
});

test("instant commands emit plans without prompts", () => {
  const undo = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "U" }, ctx());
  assert.deepEqual(undo.output.plan!.appApi, [{ name: "document.undo", payload: {} }]);
  assert.equal(undo.output.prompt, null);

  const search = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "commandsearch" }, ctx());
  assert.deepEqual(search.output.plan!.ui, [{ action: "palette.show", payload: { palette: "search" } }]);

  const ortho = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "ortho-toggle" }, ctx());
  assert.deepEqual(ortho.output.plan!.ui, [{ action: "toggle.ortho" }]);
});

// --- Determinism: same script → same plans, always -------------------------------

test("determinism: running the same script twice yields identical plans and lines", () => {
  const steps: readonly CommandScriptStep[] = [
    { event: { type: "typed", text: "LINE" } },
    { event: { type: "typed", text: "0,0" } },
    { event: { type: "typed", text: "1000,0" } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "CIRCLE" } },
    { event: { type: "typed", text: "500,0" } },
    { event: { type: "typed", text: "250" } },
  ];
  const context = ctx({ activeStoryId: "s1" });
  const a = run(steps, context);
  const b = run(steps, context);
  assert.deepEqual(a.plans, b.plans);
  assert.deepEqual(a.lines, b.lines);
});
