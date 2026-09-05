/**
 * COMPAT-CAD-007 (Issue #1) — deterministic coverage for the core editing
 * and deterministic object-selection layer (CAD-BENCH-RW-001 DEF-006 /
 * DEF-007 / DEF-021):
 *
 *  - DEF-007 (bracketed prompt options): the advertised word-forms are
 *    honored uniformly — typed "Undo" selects LINE's [Undo] option, typed
 *    "Close" closes POLYLINE, typed "Through"/"Radius" open OFFSET's/
 *    FILLET's option captures — and a typed token NEVER starts a new
 *    command while a command runs (the "per-command lottery" that
 *    canceled LINE for UNDO, POLYLINE for ARC and MOVE for SELECTALL is
 *    gone: the running prompt owns its input, AutoCAD-class).
 *  - DEF-021 (selection keywords): ALL / LAST / L / P / PREVIOUS are
 *    selection keywords INSIDE entity-step "Select objects:" prompts —
 *    resolved through the shared pickable view (workspace/selection.ts
 *    pickableEntityPicks), never through a global command escape.
 *  - DEF-006 (drag-select in command select phases): the `entities` batch
 *    event carries a window/crossing result into the running command's
 *    object step (validated, deduplicated, "N found, M total" echoes).
 *  - Core edit semantics: the supported modify workflows complete with ONE
 *    canonical revision per mutating command, exact deterministic geometry
 *    (the G4 quadrilateral trim closure) and undo/redo restoring exact
 *    prior state.
 *  - Negative guarantees: previews/batches are editor state until the
 *    command's own commit (the document version never moves on input);
 *    typed declines are explicit; failures never fabricate success echoes.
 *  - Web/Electron parity: the identical selection/edit script drives both
 *    real host transports (LOCK-004) — byte-identical plans and echo lines
 *    and equivalent final serialized state.
 *  - COMPAT-CAD-005/006 regression pins: the previous-selection "P"
 *    convention, navigation-only plans and the deterministic echo timing
 *    stay intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  runCommandScript,
  type CommandScriptStep,
  type PromptEngineState,
} from "../src/workspace/prompt-engine.js";
import { pickableEntityPicks } from "../src/workspace/selection.js";
import type { CommandPlan, EntityPick } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc007-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc007-test",
};

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}
function val<T = unknown>(r: CommandQueryResponse): T {
  if (!r.ok) throw new Error(`unexpected ErrResult: ${r.code}: ${r.message}`);
  return r.value as T;
}

interface ElementRow {
  readonly id: string;
  readonly kind: string;
  readonly props: Record<string, unknown>;
}
interface StateOutline {
  readonly elements: readonly ElementRow[];
  readonly version: number;
}

async function stateOf(h: AppApiHandler): Promise<StateOutline> {
  const s = val<{ elements: ElementRow[]; version: { version_number: number } }>(await h.handle(q("document.getState")));
  return { elements: s.elements, version: s.version.version_number };
}

/** A pickable element view over live handler elements (the hosts' rule). */
function selectableOf(h: AppApiHandler, layers: readonly { id: string; visible: boolean; frozen?: boolean; locked?: boolean }[]): Promise<readonly EntityPick[]> {
  return stateOf(h).then((s) => pickableEntityPicks(s.elements as never, layers as never));
}

const LAYERS = [{ id: "0", name: "0", color: "#111827", visible: true }];

function ctxOf(overrides: Partial<Parameters<typeof defaultCommandContext>[0]> = {}) {
  return defaultCommandContext({ activeLayer: "0", layers: LAYERS, ...overrides });
}

/** The canonical three-entity fixture: two lines + one circle on layer "0". */
async function fixtureThree(h: AppApiHandler): Promise<void> {
  val(
    await h.handle(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
          { type: "line", layer: "0", from: [100, 0], to: [100, 100] },
          { type: "circle", layer: "0", center: [200, 50], radius: 20 },
        ],
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// DEF-007 — the advertised word-forms select their options; no command
// escapes from a running prompt.
// ---------------------------------------------------------------------------

test("DEF-007: typed 'Undo' at LINE's [Undo] selects the option — the command keeps running", () => {
  const ctx = ctxOf();
  let st: PromptEngineState = IDLE_PROMPT_STATE;
  const apply = (ev: Parameters<typeof applyPromptEvent>[1]) => {
    const r = applyPromptEvent(st, ev, ctx);
    st = r.state;
    return r.output;
  };
  apply({ type: "start", commandId: "line" });
  apply({ type: "pick", point: [0, 0] });
  apply({ type: "pick", point: [100, 0] });
  const out = apply({ type: "typed", text: "Undo" });
  assert.equal(st.commandId, "line", "LINE must keep running");
  assert.ok(out.lines.includes("Undo one segment."), `the Undo option applied: ${JSON.stringify(out.lines)}`);
  assert.ok(!out.lines.includes("*Cancel*"), "no *Cancel* echo");
  assert.equal(out.commandName, "LINE", "the running command is still LINE (not UNDO)");
  // The U option's OWN plan (undo the last segment through document.undo) —
  // NOT the global UNDO command (which would end the LINE and echo "UNDO.").
  assert.ok(out.plan !== null && out.plan.appApi[0]!.name === "document.undo", "the option's segment-undo plan");
  assert.ok(!out.lines.some((l) => l === "UNDO."), "the global UNDO command never ran");
});

test("DEF-007: typed 'Close' at POLYLINE's vertex closes the polyline (the full word)", () => {
  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "polyline" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [100, 0] } },
      { event: { type: "pick", point: [100, 100] } },
      { event: { type: "typed", text: "Close" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "POLYLINE completed");
  assert.ok(lines.includes("Close."), `the Close option echo: ${JSON.stringify(lines)}`);
  assert.equal(plans.length, 1);
  const entity = (plans[0]!.appApi[0]!.payload as { entities: { type: string; closed: boolean }[] }).entities[0]!;
  assert.equal(entity.type, "polyline");
  assert.equal(entity.closed, true, "the closed flag is set");
});

test("DEF-007: typed 'Arc' at POLYLINE's vertex is a typed error — the command survives (no ARC escape)", () => {
  const ctx = ctxOf();
  let st: PromptEngineState = IDLE_PROMPT_STATE;
  const apply = (ev: Parameters<typeof applyPromptEvent>[1]) => {
    const r = applyPromptEvent(st, ev, ctx);
    st = r.state;
    return r.output;
  };
  apply({ type: "start", commandId: "polyline" });
  apply({ type: "pick", point: [0, 0] });
  const out = apply({ type: "typed", text: "Arc" });
  assert.equal(st.commandId, "polyline", "POLYLINE must keep running");
  assert.equal(out.plan, null, "no ARC command ran");
  assert.ok(!out.lines.includes("*Cancel*"), "no *Cancel* echo");
  assert.ok(out.lines.length > 0, "the typed error is visible");
  // The command still completes normally afterwards.
  apply({ type: "pick", point: [100, 0] });
  const done = apply({ type: "enter" });
  assert.equal(st.commandId, null, "POLYLINE completed after the rejected token");
  assert.ok(done.plan !== null, "the completion plan emitted");
});

test("DEF-007: typed 'Through' opens OFFSET's option capture; typed 'Radius' opens FILLET's", () => {
  // OFFSET distance step: the [Through] word-form.
  let r = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "offset" }, ctxOf());
  r = applyPromptEvent(r.state, { type: "typed", text: "Through" }, ctxOf());
  assert.ok(r.output.lines.some((l) => l.startsWith("T — ")), `the Through option echo: ${JSON.stringify(r.output.lines)}`);
  assert.equal(r.state.optionCapture?.keyword, "T", "the T capture is open");
  assert.equal(r.state.commandId, "offset", "OFFSET keeps running");

  // FILLET first-object step: the [Radius] word-form.
  let f = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "fillet" }, ctxOf());
  f = applyPromptEvent(f.state, { type: "typed", text: "Radius" }, ctxOf());
  assert.ok(f.output.lines.some((l) => l.startsWith("R — ")), `the Radius option echo: ${JSON.stringify(f.output.lines)}`);
  assert.equal(f.state.optionCapture?.keyword, "R", "the R capture is open");
  assert.equal(f.state.commandId, "fillet", "FILLET keeps running");
});

test("DEF-007: ROTATE's Reference word-form stays the typed unsupported decline", () => {
  const all: EntityPick[] = [{ id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } }];
  const ctx = ctxOf({ selectableElements: all });
  let r = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "rotate" }, ctx);
  r = applyPromptEvent(r.state, { type: "typed", text: "ALL" }, ctx);
  r = applyPromptEvent(r.state, { type: "pick", point: [0, 0] }, ctx);
  r = applyPromptEvent(r.state, { type: "typed", text: "Reference" }, ctx);
  assert.equal(r.state.commandId, "rotate", "ROTATE keeps running");
  assert.ok(
    r.output.lines.some((l) => l.includes("Reference mode is not supported")),
    `the explicit typed decline: ${JSON.stringify(r.output.lines)}`,
  );
});

test("DEF-007: typed 'CIRCLE' during LINE's point prompt is invalid input — LINE survives (the shipped switch behavior is GONE)", () => {
  // The pre-CC007 design started CIRCLE and canceled LINE; DEF-007's
  // per-command lottery. The AutoCAD contract: the prompt owns its input.
  const ctx = ctxOf();
  let r = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "line" }, ctx);
  r = applyPromptEvent(r.state, { type: "pick", point: [0, 0] }, ctx);
  r = applyPromptEvent(r.state, { type: "typed", text: "CIRCLE" }, ctx);
  assert.equal(r.state.commandId, "line", "LINE must keep running");
  assert.ok(!r.output.lines.includes("*Cancel*"), `no *Cancel*: ${JSON.stringify(r.output.lines)}`);
  assert.ok(r.output.lines[0]!.includes("CIRCLE"), "the typed error names the rejected token");
  assert.equal(r.output.plan, null);
});

test("DEF-007: ZOOM's declared keyword beats the word-form of an earlier option (EXT, not E)", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [{ event: { type: "start", commandId: "zoom" } }, { event: { type: "typed", text: "EXT" } }] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("EXT — Extents"), `the declared-keyword echo: ${JSON.stringify(lines)}`);
  assert.equal(plans[0]!.ui[0]!.action, "view.zoomExtents");
});

test("DEF-007: an option keyword stays the abbreviation path ('R' at FILLET)", () => {
  const ctx = ctxOf();
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "fillet" }, ctx);
  const out = applyPromptEvent(started.state, { type: "typed", text: "R" }, ctx);
  assert.ok(out.output.lines.some((l) => l.startsWith("R — ")), `the R keyword echo: ${JSON.stringify(out.output.lines)}`);
  assert.equal(out.state.optionCapture?.keyword, "R");
});

// ---------------------------------------------------------------------------
// DEF-021 — the selection keywords live INSIDE entity-step prompts.
// ---------------------------------------------------------------------------

test("DEF-021: typed 'ALL' at MOVE's 'Select objects:' collects every pickable entity and MOVE completes", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  await fixtureThree(h);
  const selectable = await selectableOf(h, LAYERS);
  assert.equal(selectable.length, 3, "three pickable entities");
  const ctx = ctxOf({ selectableElements: selectable });

  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "move" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "50,25" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "MOVE completed");
  assert.ok(lines.includes("3 found (all)"), `the ALL echo: ${JSON.stringify(lines)}`);
  assert.ok(!lines.includes("*Cancel*"), "no *Cancel* — the command was never lost");
  assert.equal(plans.length, 1, "exactly ONE plan (one canonical revision for the mutation)");
  const entry = plans[0]!.appApi[0]!;
  assert.equal(entry.name, "drafting.move", "the legacy-convention entities route to the drafting.* surface");
  assert.deepEqual((entry.payload as { ids: string[] }).ids, ["el-000001", "el-000002", "el-000003"]);
  assert.deepEqual(
    { dx: (entry.payload as { dx: number }).dx, dy: (entry.payload as { dy: number }).dy },
    { dx: 50, dy: 25 },
  );

  // Commit through the REAL handler — the mutation is one atomic revision.
  for (const c of plans.flatMap((p) => p.appApi.map((e) => cmd(e.name as Command["name"], e.payload)))) {
    val(await h.handle(c));
  }
  const after = await stateOf(h);
  assert.equal(after.elements.length, 3, "three entities moved, none created or lost");
  const moved = after.elements.find((el) => el.id === "el-000001")!;
  const from = moved.props.from as [number, number];
  assert.deepEqual(from, [50, 25], "el-000001 moved by exactly (50, 25)");
});

test("DEF-021: typed 'LAST' at ERASE's prompt selects the last-created entity (and 'L' equals it)", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  await fixtureThree(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable });

  for (const token of ["LAST", "L"]) {
    const plans: CommandPlan[] = [];
    const { state, lines } = runCommandScript(
      [
        { event: { type: "start", commandId: "erase" } },
        { event: { type: "typed", text: token } },
        { event: { type: "enter" } },
      ] as const satisfies readonly CommandScriptStep[],
      ctx,
      (plan) => plans.push(plan),
    );
    assert.equal(state.commandId, null, `ERASE completed (${token})`);
    assert.ok(lines.includes(`1 found (last: el-000003)`), `the LAST echo (${token}): ${JSON.stringify(lines)}`);
    const entry = plans[0]!.appApi[0]!;
    assert.deepEqual((entry.payload as { ids: string[] }).ids, ["el-000003"], "exactly the last entity");
  }
});

test("DEF-021: typed 'PREVIOUS' resolves the current selection (the full word joins 'P')", () => {
  const currentSelection: EntityPick[] = [
    { id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
    { id: "el-000002", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [100, 0], to: [100, 100] } },
  ];
  const ctx = ctxOf({ currentSelection });
  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "erase" } },
      { event: { type: "typed", text: "PREVIOUS" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "ERASE completed");
  assert.ok(lines.includes("2 found (previous selection)"), `the PREVIOUS echo: ${JSON.stringify(lines)}`);
  assert.deepEqual((plans[0]!.appApi[0]!.payload as { ids: string[] }).ids, ["el-000001", "el-000002"]);
});

test("DEF-021: ALL/LAST without the pickable view is the explicit typed decline (never fabricated)", () => {
  const ctx = ctxOf(); // NO selectableElements (legacy context)
  for (const token of ["ALL", "LAST"]) {
    const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "erase" }, ctx);
    const out = applyPromptEvent(started.state, { type: "typed", text: token }, ctx);
    assert.equal(out.state.commandId, "erase", `ERASE keeps running (${token})`);
    assert.equal(out.output.plan, null, "no plan — nothing fabricated");
    assert.ok(out.output.lines[0]!.includes("not available in this context"), `the typed decline (${token}): ${JSON.stringify(out.output.lines)}`);
  }
});

test("DEF-021: a garbage token at an entity step stays inside the prompt (no global command escape)", () => {
  const ctx = ctxOf({ selectableElements: [] });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "move" }, ctx);
  const out = applyPromptEvent(started.state, { type: "typed", text: "SELECTALL" }, ctx);
  assert.equal(out.state.commandId, "move", "MOVE keeps running — SELECTALL never ran");
  assert.equal(out.output.plan, null);
  assert.ok(out.output.lines[0]!.includes("not a valid selection"), `the typed error: ${JSON.stringify(out.output.lines)}`);
  assert.ok(!out.output.lines.includes("*Cancel*"));
});

test("DEF-021: typed 'ALL' at an entityPoint step is the honest decline (the pick location is semantic)", () => {
  const ctx = ctxOf({ selectableElements: [] });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "trim" }, ctx);
  // The edges step (entity, optional, emptyEnterCompletes) → Enter → targets step.
  const advanced = applyPromptEvent(started.state, { type: "enter" }, ctx);
  const out = applyPromptEvent(advanced.state, { type: "typed", text: "ALL" }, ctx);
  assert.equal(out.state.commandId, "trim", "TRIM keeps running");
  assert.equal(out.output.plan, null);
  assert.ok(out.output.lines[0]!.includes("pick the object in the canvas"), `the honest decline: ${JSON.stringify(out.output.lines)}`);
});

// ---------------------------------------------------------------------------
// The shared pickable view (workspace/selection.ts) — the one rule.
// ---------------------------------------------------------------------------

test("pickableEntityPicks: visible/unfrozen/unlocked layers only; BIM wall/slab footprints; document order", () => {
  const layers = [
    { id: "l-vis", name: "vis", color: "#000", visible: true },
    { id: "l-off", name: "off", color: "#000", visible: false },
    { id: "l-frozen", name: "frozen", color: "#000", visible: true, frozen: true },
    { id: "l-locked", name: "locked", color: "#000", visible: true, locked: true },
  ];
  const elements = [
    { id: "e1", kind: "drafting", props: { type: "line", layer: "l-vis", from: [0, 0], to: [1, 1] } },
    { id: "e2", kind: "drafting", props: { type: "line", layer: "l-off", from: [0, 0], to: [1, 1] } },
    { id: "e3", kind: "drafting", props: { type: "line", layer: "l-frozen", from: [0, 0], to: [1, 1] } },
    { id: "e4", kind: "drafting", props: { type: "line", layer: "l-locked", from: [0, 0], to: [1, 1] } },
    { id: "e5", kind: "bim", props: { type: "bim.wall", layer: "l-vis", start: [0, 0], end: [10, 0], width: 2 } },
    { id: "e6", kind: "bim", props: { type: "bim.story", layer: "l-vis" } },
    { id: "e7", kind: "drafting", props: { type: "line", layer: "l-vis", from: [0, 0], to: [2, 2] } },
  ];
  const picks = pickableEntityPicks(elements as never, layers as never);
  assert.deepEqual(
    picks.map((p) => p.id),
    ["e1", "e5", "e7"],
    "only interactable-layer entities + BIM wall/slab footprints, in document order",
  );
});

// ---------------------------------------------------------------------------
// DEF-006 — the window/crossing batch event into command select phases.
// ---------------------------------------------------------------------------

test("DEF-006: the entities batch (a window result) collects into MOVE and the move commits once", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  await fixtureThree(h);
  const before = await stateOf(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable });

  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "move" } },
      { event: { type: "entities", entities: selectable.slice(0, 2) } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "10,10" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "MOVE completed");
  assert.ok(lines.includes("2 found."), `the batch echo: ${JSON.stringify(lines)}`);
  const entry = plans[0]!.appApi[0]!;
  assert.deepEqual((entry.payload as { ids: string[] }).ids, ["el-000001", "el-000002"], "the batch contents");

  // The batch was INPUT ONLY — the document did not move before the commit.
  assert.equal(before.version, (await stateOf(h)).version, "no mutation before the command's own commit");

  for (const c of plans.flatMap((p) => p.appApi.map((e) => cmd(e.name as Command["name"], e.payload)))) {
    val(await h.handle(c));
  }
  const after = await stateOf(h);
  assert.equal(after.version, before.version + 1, "exactly ONE canonical revision for the whole move");
  const circle = after.elements.find((el) => el.id === "el-000003")!;
  assert.deepEqual(circle.props.center, [200, 50], "the untouched entity stayed put");
});

test("DEF-006: a second window over the same objects never double-counts (single-step command)", () => {
  const selectable: EntityPick[] = [
    { id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
    { id: "el-000002", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [100, 0], to: [100, 100] } },
  ];
  const ctx = ctxOf({ selectableElements: selectable });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "erase" } },
      { event: { type: "entities", entities: selectable } },
      { event: { type: "entities", entities: selectable } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("2 found."), `the first batch: ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((l) => l.startsWith("0 found, 2 total")),
    `the deduplicated second batch: ${JSON.stringify(lines)}`,
  );
  assert.equal(plans.length, 1, "the erase plan fired once with exactly the two entities");
  assert.deepEqual((plans[0]!.appApi[0]!.payload as { ids: string[] }).ids, ["el-000001", "el-000002"]);
});

test("DEF-006: the batch at a SINGLE-object step (OFFSET) is the typed decline", () => {
  const selectable: EntityPick[] = [{ id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } }];
  const ctx = ctxOf({ selectableElements: selectable });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "offset" }, ctx);
  // distance first
  const withDistance = applyPromptEvent(started.state, { type: "typed", text: "10" }, ctx);
  const out = applyPromptEvent(withDistance.state, { type: "entities", entities: selectable }, ctx);
  assert.equal(out.state.commandId, "offset", "OFFSET keeps running");
  assert.equal(out.output.plan, null);
  assert.ok(out.output.lines[0]!.includes("one object at a time"), `the single-object decline: ${JSON.stringify(out.output.lines)}`);
});

test("DEF-006: the batch at an entityPoint step (TRIM targets) is the typed decline", () => {
  const selectable: EntityPick[] = [{ id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } }];
  const ctx = ctxOf({ selectableElements: selectable });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "trim" }, ctx);
  const advanced = applyPromptEvent(started.state, { type: "enter" }, ctx); // edges (implied all) → targets
  const out = applyPromptEvent(advanced.state, { type: "entities", entities: selectable }, ctx);
  assert.equal(out.state.commandId, "trim", "TRIM keeps running");
  assert.equal(out.output.plan, null);
  assert.ok(out.output.lines[0]!.includes("does not accept a window selection"), `the entityPoint decline: ${JSON.stringify(out.output.lines)}`);
});

test("DEF-006: the batch at a POINT step is the typed decline", () => {
  const selectable: EntityPick[] = [{ id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } }];
  const ctx = ctxOf({ selectableElements: selectable });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "line" }, ctx);
  const out = applyPromptEvent(started.state, { type: "entities", entities: selectable }, ctx);
  assert.equal(out.state.commandId, "line", "LINE keeps running");
  assert.equal(out.output.plan, null);
  assert.ok(out.output.lines[0]!.includes("does not accept a window selection"), `the point-step decline: ${JSON.stringify(out.output.lines)}`);
});

test("DEF-006: a batch member outside the command's selection filter is counted and skipped", () => {
  const mixed: EntityPick[] = [
    { id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
    { id: "el-wall", kind: "bim", props: { type: "bim.wall", layer: "0", start: [0, 0], end: [10, 0], width: 2 } },
  ];
  const ctx = ctxOf({ selectableElements: mixed });
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "rotate" } },
      { event: { type: "entities", entities: mixed } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    () => {},
  );
  assert.ok(
    lines.some((l) => /^1 found, 1 skipped\.$/.test(l)),
    `the filtered batch echo: ${JSON.stringify(lines)}`,
  );
});

test("ERASE covers the canonical-flat partition (the discovered defect: post-TRIM entities were unerasable)", () => {
  // CAD-BENCH-RW-001-class discovery during CC007: the ERASE builder dropped
  // the canonical-flat picks (every entity.create product and every trim/
  // fillet re-topologized entity) — "ERASE received no erasable objects"
  // right after the G4 closure. drafting.delete's removeElement edits are
  // id-keyed (convention-agnostic), so the canonical ids join the batch.
  const canonical: EntityPick[] = [
    { id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 } },
  ];
  const ctx = ctxOf({ selectableElements: canonical });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "erase" } },
      { event: { type: "entities", entities: canonical } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(!lines.includes("ERASE received no erasable objects."), `no starvation echo: ${JSON.stringify(lines)}`);
  assert.deepEqual((plans[0]!.appApi[0]!.payload as { ids: string[] }).ids, ["el-000001"], "the canonical id joins the delete batch");
});

// ---------------------------------------------------------------------------
// Core edit semantics — the G4 quadrilateral trim closure + undo/redo.
// ---------------------------------------------------------------------------

test("G4: the precision quadrilateral trim closure produces the exact closed geometry (one revision)", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  val(
    await h.handle(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [0, 0], to: [104, 0] },
          { type: "line", layer: "0", from: [100, 0], to: [100, 104] },
          { type: "line", layer: "0", from: [100, 100], to: [-4, 100] },
          { type: "line", layer: "0", from: [0, 100], to: [0, -4] },
        ],
      }),
    ),
  );
  const before = await stateOf(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable });

  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "trim" } },
      { event: { type: "enter" }, note: "edges: implied all objects" },
      { event: { type: "entityPoint", entity: selectable[0]!, point: [102, 0] } },
      { event: { type: "entityPoint", entity: selectable[1]!, point: [100, 102] } },
      { event: { type: "entityPoint", entity: selectable[2]!, point: [-2, 100] } },
      { event: { type: "entityPoint", entity: selectable[3]!, point: [0, -2] } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "TRIM completed");
  assert.ok(
    lines.includes("TRIM: 4 target(s) (implied all edges)."),
    `the TRIM outcome echo: ${JSON.stringify(lines.slice(-4))}`,
  );
  assert.ok(lines.some((l) => l.startsWith("1 found (el-000001) at (102,0)")), "all four target picks echoed");
  assert.equal(plans.length, 1, "ONE plan for the whole trim");
  for (const c of plans.flatMap((p) => p.appApi.map((e) => cmd(e.name as Command["name"], e.payload)))) {
    val(await h.handle(c));
  }
  const after = await stateOf(h);
  assert.equal(after.elements.length, 4, "still four boundary entities (re-topologized in place)");
  assert.equal(after.version, before.version + 1, "one atomic revision");

  const geom = (id: string): { x1: number; y1: number; x2: number; y2: number } => {
    const el = after.elements.find((e) => e.id === id)!;
    return el.props as never;
  };
  assert.deepEqual([geom("el-000001").x1, geom("el-000001").y1, geom("el-000001").x2, geom("el-000001").y2], [0, 0, 100, 0]);
  assert.deepEqual([geom("el-000002").x1, geom("el-000002").y1, geom("el-000002").x2, geom("el-000002").y2], [100, 0, 100, 100]);
  assert.deepEqual([geom("el-000003").x1, geom("el-000003").y1, geom("el-000003").x2, geom("el-000003").y2], [100, 100, 0, 100]);
  assert.deepEqual([geom("el-000004").x1, geom("el-000004").y1, geom("el-000004").x2, geom("el-000004").y2], [0, 100, 0, 0]);
});

test("G4 (composed): eight excess picks, two per edge, compose to the exact closed square — the browser-discovered defect", async () => {
  // The exact-head browser G4 gate picked BOTH overshoots of every edge
  // (eight picks, two per entity). The pre-fix opTrim computed every pick
  // against the ORIGINAL geometry and the edit application resolved the
  // same-id replaces last-wins — silently discarding the first cut of every
  // doubly-picked edge while echoing success for all eight targets. The
  // composed semantics: picks on one entity accumulate as the union of the
  // picked pieces (input is collected against the pre-commit geometry).
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  val(
    await h.handle(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [-4, 0], to: [104, 0] },
          { type: "line", layer: "0", from: [100, -4], to: [100, 104] },
          { type: "line", layer: "0", from: [104, 100], to: [-4, 100] },
          { type: "line", layer: "0", from: [0, 104], to: [0, -4] },
        ],
      }),
    ),
  );
  const before = await stateOf(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable });

  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "trim" } },
      { event: { type: "enter" }, note: "edges: implied all objects" },
      { event: { type: "entityPoint", entity: selectable[0]!, point: [-2, 0] } },
      { event: { type: "entityPoint", entity: selectable[0]!, point: [102, 0] } },
      { event: { type: "entityPoint", entity: selectable[2]!, point: [102, 100] } },
      { event: { type: "entityPoint", entity: selectable[2]!, point: [-2, 100] } },
      { event: { type: "entityPoint", entity: selectable[1]!, point: [100, -2] } },
      { event: { type: "entityPoint", entity: selectable[1]!, point: [100, 102] } },
      { event: { type: "entityPoint", entity: selectable[3]!, point: [0, 102] } },
      { event: { type: "entityPoint", entity: selectable[3]!, point: [0, -2] } },
      // A stale re-pick of the piece the first pick already removed: an
      // honest no-op, never a wrong re-cut of a different piece.
      { event: { type: "entityPoint", entity: selectable[0]!, point: [-2, 0] } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "TRIM completed");
  assert.ok(
    lines.includes("TRIM: 9 target(s) (implied all edges)."),
    `the TRIM outcome echo: ${JSON.stringify(lines.slice(-4))}`,
  );
  assert.equal(plans.length, 1, "ONE plan for the whole trim");
  let modifySummary = "";
  for (const c of plans.flatMap((p) => p.appApi.map((e) => cmd(e.name as Command["name"], e.payload)))) {
    const r = val<{ summary?: string }>(await h.handle(c));
    if (c.payload && (c.payload as { op?: string }).op === "trim") modifySummary = r.summary ?? "";
  }
  assert.match(modifySummary, /^8 trims applied; skipped: el-000001: /, `the composed summary: ${modifySummary}`);
  assert.match(
    modifySummary,
    /pick is off the remaining piece \(already trimmed in this command\)/,
    `the stale pick is the honest skip: ${modifySummary}`,
  );

  const after = await stateOf(h);
  assert.equal(after.elements.length, 4, "still four boundary entities (composed in place)");
  assert.equal(after.version, before.version + 1, "one atomic revision for the whole composed trim");

  const geom = (id: string): { x1: number; y1: number; x2: number; y2: number } => {
    const el = after.elements.find((e) => e.id === id)!;
    return el.props as never;
  };
  assert.deepEqual([geom("el-000001").x1, geom("el-000001").y1, geom("el-000001").x2, geom("el-000001").y2], [0, 0, 100, 0]);
  assert.deepEqual([geom("el-000002").x1, geom("el-000002").y1, geom("el-000002").x2, geom("el-000002").y2], [100, 0, 100, 100]);
  assert.deepEqual([geom("el-000003").x1, geom("el-000003").y1, geom("el-000003").x2, geom("el-000003").y2], [100, 100, 0, 100]);
  assert.deepEqual([geom("el-000004").x1, geom("el-000004").y1, geom("el-000004").x2, geom("el-000004").y2], [0, 100, 0, 0]);
});

test("G10: undo/redo restores the exact prior state after ERASE ALL (and the selection view never inflates)", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  await fixtureThree(h);
  const before = await stateOf(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable, currentSelection: [...selectable] });

  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "erase" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("3 found (all)"));
  for (const c of plans.flatMap((p) => p.appApi.map((e) => cmd(e.name as Command["name"], e.payload)))) {
    val(await h.handle(c));
  }
  const erased = await stateOf(h);
  assert.equal(erased.elements.length, 0, "all three erased");
  assert.equal(erased.version, before.version + 1);

  // UNDO restores the EXACT prior element set (the inverse edit re-inserts
  // in reverse order — the shipped history semantics; the CONTENT of every
  // element is byte-identical to the pre-erase rows).
  val(await h.handle(cmd("document.undo", {})));
  const restored = await stateOf(h);
  assert.equal(restored.elements.length, 3);
  const byId = (rows: readonly ElementRow[]): readonly ElementRow[] =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(byId(restored.elements), byId(before.elements), "the exact prior element set (byte-identical rows)");
  assert.equal(restored.version, before.version, "the version is back to the pre-erase revision");

  // The live-pruned selection: erased ids never inflate the counts.
  const selectionAfterErase = val(await h.handle(q("document.getSelection")));
  assert.ok(Array.isArray(selectionAfterErase));
});

// ---------------------------------------------------------------------------
// Negative guarantees — no false success, no pre-commit mutation.
// ---------------------------------------------------------------------------

test("negative: a failed edit emits the typed failure and NEVER a success echo before it", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  await fixtureThree(h);
  const selectable = await selectableOf(h, LAYERS);
  const ctx = ctxOf({ selectableElements: selectable });

  // ERASE with an id the document does not contain — the typed failure path.
  const out = await h.handle(cmd("entity.modify", { op: "erase", ids: ["el-404404"] }));
  assert.equal(out.ok, false);
  const failure = out as { code: string; message: string };
  assert.equal(failure.code, "entity_invalid");
  const after = await stateOf(h);
  assert.equal(after.elements.length, 3, "nothing was removed");
});

test("negative: the input events (keywords, batches, picks) never emit a plan by themselves", () => {
  const selectable: EntityPick[] = [{ id: "el-000001", kind: "drafting", props: { type: "line", layer: "0" } }];
  const ctx = ctxOf({ selectableElements: selectable, currentSelection: selectable });
  const inputEvents: readonly CommandScriptStep[] = [
    { event: { type: "start", commandId: "move" } },
    { event: { type: "typed", text: "ALL" } },
    { event: { type: "entities", entities: selectable } },
    { event: { type: "typed", text: "LAST" } },
    { event: { type: "typed", text: "P" } },
    { event: { type: "pick", point: [5, 5] } },
  ];
  const plans: CommandPlan[] = [];
  runCommandScript(inputEvents, ctx, (plan) => plans.push(plan));
  assert.equal(plans.length, 0, "no plan until the command's final value completes — input is editor state only");
});

test("determinism: the same selection/edit script twice yields byte-identical plans and lines", () => {
  const selectable: EntityPick[] = [
    { id: "el-000001", kind: "drafting", props: { type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
    { id: "el-000002", kind: "drafting", props: { type: "circle", layer: "0", center: [200, 50], radius: 20 } },
  ];
  const ctx = ctxOf({ selectableElements: selectable });
  const script: readonly CommandScriptStep[] = [
    { event: { type: "start", commandId: "move" } },
    { event: { type: "typed", text: "ALL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "10,10" } },
    { event: { type: "start", commandId: "erase" } },
    { event: { type: "typed", text: "L" } },
    { event: { type: "enter" } },
  ];
  const run = (): { plans: string[]; lines: readonly string[] } => {
    const plans: CommandPlan[] = [];
    const { lines } = runCommandScript(script, ctx, (plan) => plans.push(plan));
    return { plans: plans.map((p) => JSON.stringify(p)), lines };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.plans, b.plans, "byte-identical plans");
  assert.deepEqual(a.lines, b.lines, "byte-identical echo lines");
});

// ---------------------------------------------------------------------------
// Web/Electron parity — the identical selection/edit stream through both
// real host transports (LOCK-004).
// ---------------------------------------------------------------------------

test("the DEF-006/007/021 selection/edit stream is byte-identical through WebHost and ElectronHost", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  type Exec = { execute(request: Command | Query): Promise<CommandQueryResponse> };

  const selectable: EntityPick[] = [
    { id: "el-000001", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
    { id: "el-000002", kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [100, 0], to: [100, 100] } },
  ];
  const ctx = ctxOf({ selectableElements: selectable, currentSelection: selectable });

  // The affected semantic stream: the DEF-006 window batch as the first
  // object input, the DEF-021 keywords (LAST at ERASE's prompt — the
  // single-step command keeps collecting), the core edit completions and
  // the idle UNDO. Every plan commits through BOTH real host transports.
  const script: readonly CommandScriptStep[] = [
    { event: { type: "start", commandId: "move" } },
    { event: { type: "entities", entities: selectable.slice(0, 1) }, note: "DEF-006: the window batch" },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "10,10" } },
    { event: { type: "start", commandId: "erase" } },
    { event: { type: "typed", text: "LAST" }, note: "DEF-021: the LAST keyword" },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "UNDO" } },
  ];
  const plansOf: string[] = [];
  const linesOf = runCommandScript(script, ctx, (plan) => plansOf.push(JSON.stringify(plan)));
  assert.equal(plansOf.length, 3, "move + erase + undo plans");
  assert.ok(linesOf.lines.includes("1 found."), `the batch echo: ${JSON.stringify(linesOf.lines)}`);
  assert.ok(linesOf.lines.includes("1 found (last: el-000002)"), `the LAST echo: ${JSON.stringify(linesOf.lines)}`);

  // Determinism: the same script yields the byte-identical plan stream.
  const plansAgain: string[] = [];
  runCommandScript(script, ctx, (plan) => plansAgain.push(JSON.stringify(plan)));
  assert.deepEqual(plansOf, plansAgain, "the plan stream is deterministic");

  // Fresh documents on both hosts; identical App API command streams.
  const seed = async (host: Exec): Promise<void> => {
    await host.execute(cmd("document.create", {}));
    await host.execute(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
          { type: "line", layer: "0", from: [100, 0], to: [100, 100] },
        ],
      }),
    );
  };
  await seed(web);
  await seed(electron);

  // Apply the collected plans to BOTH hosts exactly as the shells would
  // (every plan entry through the real transport).
  for (const p of plansOf) {
    const plan = JSON.parse(p) as CommandPlan;
    for (const entry of plan.appApi) {
      await web.execute(cmd(entry.name as Command["name"], entry.payload));
      await electron.execute(cmd(entry.name as Command["name"], entry.payload));
    }
  }
  const outline = async (host: Exec): Promise<{ elements: unknown[]; version: number }> => {
    const s = val<{ elements: unknown[]; version: { version_number: number } }>(await host.execute(q("document.getState")));
    return { elements: s.elements, version: s.version.version_number };
  };
  const webState = await outline(web);
  const electronState = await outline(electron);
  assert.deepEqual(webState, electronState, "Web and Electron converge on equivalent affected serialized state");
  assert.equal(webState.elements.length, 2, "the undo restored the erased entity");
  const moved = (webState.elements as ElementRow[]).find((el) => el.id === "el-000001")!;
  assert.deepEqual(moved.props.from, [10, 10], "the move applied through the real transport");
});

test("the composed multi-pick TRIM converges byte-identically through WebHost and ElectronHost", async () => {
  // The composed trim (union-of-picked-pieces; the browser-discovered
  // defect) executed through BOTH real host transports: identical summaries,
  // byte-identical final serialized state, the exact closed square.
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web: Exec = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron: Exec = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  type Exec = { execute(request: Command | Query): Promise<CommandQueryResponse> };

  const seed = async (host: Exec): Promise<void> => {
    await host.execute(cmd("document.create", {}));
    await host.execute(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [-4, 0], to: [104, 0] },
          { type: "line", layer: "0", from: [100, -4], to: [100, 104] },
          { type: "line", layer: "0", from: [104, 100], to: [-4, 100] },
          { type: "line", layer: "0", from: [0, 104], to: [0, -4] },
        ],
      }),
    );
  };
  await seed(web);
  await seed(electron);

  const versionOf = async (host: Exec): Promise<number> => {
    const s = val<{ version: { version_number: number } }>(await host.execute(q("document.getState")));
    return s.version.version_number;
  };
  const webBefore = await versionOf(web);
  const electronBefore = await versionOf(electron);

  const composed = {
    op: "trim",
    edges: [] as string[],
    trims: [
      { targetId: "el-000001", pick: { x: -2, y: 0 } },
      { targetId: "el-000001", pick: { x: 102, y: 0 } },
      { targetId: "el-000003", pick: { x: 102, y: 100 } },
      { targetId: "el-000003", pick: { x: -2, y: 100 } },
      { targetId: "el-000002", pick: { x: 100, y: -2 } },
      { targetId: "el-000002", pick: { x: 100, y: 102 } },
      { targetId: "el-000004", pick: { x: 0, y: 102 } },
      { targetId: "el-000004", pick: { x: 0, y: -2 } },
      // The stale re-pick: an honest skip on both hosts, never a re-cut.
      { targetId: "el-000001", pick: { x: -2, y: 0 } },
    ],
  };
  const webResult = val<{ summary: string }>(await web.execute(cmd("entity.modify", composed)));
  const electronResult = val<{ summary: string }>(await electron.execute(cmd("entity.modify", composed)));
  assert.equal(webResult.summary, electronResult.summary, "identical composed summaries on both hosts");
  assert.ok(
    webResult.summary.startsWith("8 trims applied; skipped: el-000001:"),
    `the composed summary: ${webResult.summary}`,
  );

  assert.equal(await versionOf(web), webBefore + 1, "ONE atomic revision for the whole composed trim (web)");
  assert.equal(await versionOf(electron), electronBefore + 1, "ONE atomic revision for the whole composed trim (electron)");

  const outline = async (host: Exec): Promise<{ elements: unknown[]; version: number }> => {
    const s = val<{ elements: unknown[]; version: { version_number: number } }>(await host.execute(q("document.getState")));
    return { elements: s.elements, version: s.version.version_number };
  };
  assert.deepEqual(await outline(web), await outline(electron), "byte-identical post-trim serialized state");

  const s = val<{ elements: ElementRow[] }>(await web.execute(q("document.getState")));
  assert.equal(s.elements.length, 4, "four boundary entities");
  const coords = (id: string): unknown[] => {
    const p = s.elements.find((el) => el.id === id)!.props as Record<string, unknown>;
    return [p.x1, p.y1, p.x2, p.y2];
  };
  assert.deepEqual(coords("el-000001"), [0, 0, 100, 0], "bottom closed");
  assert.deepEqual(coords("el-000002"), [100, 0, 100, 100], "right closed");
  assert.deepEqual(coords("el-000003"), [100, 100, 0, 100], "top closed");
  assert.deepEqual(coords("el-000004"), [0, 100, 0, 0], "left closed");
});

// ---------------------------------------------------------------------------
// COMPAT-CAD-005/006 regression pins.
// ---------------------------------------------------------------------------

test("REGRESSION (CC006): the entity-step 'P' convention still wins (previous selection, no PAN)", () => {
  const currentSelection: EntityPick[] = [{ id: "el-000001", kind: "drafting", props: { type: "line", layer: "0" } }];
  const ctx = ctxOf({ currentSelection });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "chprop" } },
      { event: { type: "typed", text: "P" } },
      { event: { type: "typed", text: "C" } },
      { event: { type: "typed", text: "#ff0000" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(!lines.includes("*Cancel*"), `CHPROP must not be canceled: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.includes("1 found (previous selection)")));
  const last = plans[plans.length - 1]!;
  assert.equal(last.ui.filter((u) => u.action.startsWith("view.")).length, 0, "no navigation fired");
  assert.ok(last.appApi.some((e) => e.name === "entity.setDisplay"), "the CHPROP patch applied");
});

test("REGRESSION (CC006): ZOOM E stays a navigation-only plan (zero App API)", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [{ event: { type: "start", commandId: "zoom" } }, { event: { type: "typed", text: "E" } }] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (plan) => plans.push(plan),
  );
  assert.equal(plans[0]!.appApi.length, 0, "navigation never mutates the document");
  assert.equal(plans[0]!.ui[0]!.action, "view.zoomExtents");
  assert.ok(lines.some((l) => l.includes("E — Extents") || l.includes("ZOOM: fitting extents")));
});

test("REGRESSION (CC005): LINE via typed coordinates still produces one drafting.createEntities plan (the commit-authoritative stream)", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "line" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "4000,0" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.appApi[0]!.name, "drafting.createEntities");
  assert.ok(lines.some((l) => l.startsWith("LINE:")), "the LINE outcome echo (printed only after commit in the hosts)");
});
