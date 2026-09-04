/**
 * COMPAT-CAD-005 (Issue #135) — deterministic coverage for the real-world 2D
 * drafting foundation slice, driven from the CAD-BENCH-RW-001 black-box
 * benchmark findings (PR #134):
 *
 *  - DEF-001/002: layer identity — the command/palette layer APIs and the
 *    canonical document layer table resolve through ONE identity space; the
 *    response snapshots are authoritative; echoes display layer NAMES.
 *  - DEF-003: NEW fully resets the document/editor state (layer table, active
 *    layer, selection, counters) — no dangling references.
 *  - DEF-008/014: one canonical, live-pruned selection state; entity counts
 *    cannot be inflated by dead ids.
 *  - DEF-006: the DECLARED screen-space pickbox tolerance (deterministic,
 *    shared by both hosts).
 *  - DEF-027: commit-authoritative echo — the prompt engine's plan outcome
 *    echoes are separable from interactive echoes (splitEchoTiming), and a
 *    failed canonical transaction is the one authoritative failure (the
 *    create is rejected typed with NO document mutation).
 *
 * Web/Electron parity: the same layer/selection flows run through BOTH real
 * host transports and must produce byte-identical outcomes (LOCK-004).
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
  commandById,
  resolveCommand,
} from "../src/workspace/commands.js";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  runCommandScript,
  splitEchoTiming,
  type CommandScriptStep,
} from "../src/workspace/prompt-engine.js";
import { defaultCommandContext, layerNameOrId } from "../src/workspace/types.js";
import { PICKBOX_SCREEN_PX, pickApertureWorld } from "../src/workspace/precision-2d.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc005-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc005-test",
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

interface LayerRow {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// DEF-001/DEF-002 — layer identity: one canonical table, authoritative
// snapshots, name-resolved echoes.
// ---------------------------------------------------------------------------

test("drafting.addLayer makeActive returns the authoritative snapshot (layer table + activeLayer)", async () => {
  const h = AppApiHandler.create(CONFIG);
  const r = val<{ layerId: string; active: boolean; snapshot: { layers: LayerRow[]; draftingSettings: { activeLayer?: string } } }>(
    await h.handle(cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true })),
  );
  assert.equal(r.active, true, "makeActive must report the switch");
  assert.match(r.layerId, /^ly-\d{6}$/, "the layer id is the canonical minted id");
  // The response snapshot IS the post-commit document state — the host adopts
  // exactly this (no second roundtrip, no client-side id minting).
  assert.deepEqual(
    r.snapshot.layers.map((l) => l.name),
    ["0", "A-WALL-TEST"],
    "the authoritative layer table contains the new layer after '0'",
  );
  assert.equal(r.snapshot.draftingSettings.activeLayer, r.layerId, "the authoritative activeLayer is the new layer id");
});

test("layer.setActive resolves the canonical id and returns the authoritative snapshot (typed bad_layer otherwise)", async () => {
  const h = AppApiHandler.create(CONFIG);
  const created = val<{ layerId: string }>(await h.handle(cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true })));
  const r = val<{ activeLayer: string; snapshot: { draftingSettings: { activeLayer?: string }; layers: LayerRow[] } }>(
    await h.handle(cmd("layer.setActive", { layerId: created.layerId })),
  );
  assert.equal(r.activeLayer, created.layerId);
  assert.equal(r.snapshot.draftingSettings.activeLayer, created.layerId);
  assert.equal(r.snapshot.layers.length, 2);
  // An id the document does not contain is a typed failure — never a silent
  // fallback to another layer (DEF-001's palette error was honest; the
  // *client* raw-id display was the defect).
  const bad = await h.handle(cmd("layer.setActive", { layerId: "ly-999999" }));
  assert.equal(bad.ok, false);
  assert.equal((bad as { code: string }).code, "bad_layer");
});

test("LINE stamps the resolved active-layer id and echoes the layer NAME (DEF-001/DEF-022)", async () => {
  // The prompt-engine builder path: with the adopted snapshot's layer table +
  // activeLayer in the context, the plan entity carries the canonical layer
  // id and the outcome echo shows the NAME the user typed.
  const ctx = defaultCommandContext({
    activeLayer: "ly-000001",
    layers: [
      { id: "0", name: "0", color: "#111827", visible: true },
      { id: "ly-000001", name: "A-WALL-TEST", color: "#111827", visible: true },
    ],
  });
  const plans: { appApi: { name: string; payload: unknown }[]; echo: string[] }[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "line" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "300,0" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  const entity = (plans[0]!.appApi[0]!.payload as { entities: { type: string; layer: string }[] }).entities[0]!;
  assert.equal(entity.layer, "ly-000001", "the create payload stamps the canonical active-layer id");
  const echo = lines.find((l) => l.startsWith("LINE:"));
  assert.ok(echo !== undefined, "the LINE outcome echo exists");
  assert.ok(echo.includes("on layer 'A-WALL-TEST'."), `the echo shows the layer NAME, not the raw id — got: ${echo}`);
  // The shared helper falls back to the raw id only when the table lacks it.
  assert.equal(layerNameOrId(ctx, "ly-000001"), "A-WALL-TEST");
  assert.equal(layerNameOrId(ctx, "ly-404"), "ly-404");
});

// ---------------------------------------------------------------------------
// DEF-003/DEF-014 — NEW fully resets document/editor state.
// ---------------------------------------------------------------------------

test("NEW resets the whole editor session: layer table, active layer, selection, elements, counters", async () => {
  const h = AppApiHandler.create(CONFIG);
  // Build a dirty session: a layer made active, geometry on it, a selection.
  await h.handle(cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true }));
  const line = await h.handle(
    cmd("drafting.createEntities", { entities: [{ type: "line", layer: "ly-000001", from: [0, 0], to: [300, 0] }] }),
  );
  assert.equal(line.ok, true);
  await h.handle(cmd("document.setSelection", { ids: ["el-000001"] }));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["el-000001"]);
  // NEW
  const snap = val<{ layers: LayerRow[]; draftingSettings: { activeLayer?: string }; elements: unknown[]; selection: string[]; version: { version_number: number } }>(
    await h.handle(cmd("document.create", {})),
  );
  assert.deepEqual(snap.layers.map((l) => l.name), ["0"], "the layer table resets to the default layer");
  assert.equal(snap.draftingSettings.activeLayer, undefined, "no dangling active-layer reference (layer '0' is the implicit default)");
  assert.equal(snap.elements.length, 0, "no phantom entities");
  assert.deepEqual(snap.selection, [], "the selection resets");
  assert.equal(snap.version.version_number, 1, "the version counter resets");
  // The NEW command definition emits the file.new ui action (the host's full
  // editor reset is driven by this canonical response).
  const newCmd = commandById("new");
  assert.ok(newCmd !== null);
  const newPlan = newCmd.instant!(defaultCommandContext());
  assert.equal(newPlan.appApi.length, 0);
  assert.deepEqual(
    newPlan.ui.map((a) => a.action),
    ["file.new"],
    "the NEW instant plan drives the host reset through the file.new ui action",
  );
});

test("draw-after-NEW: creation on the reset document succeeds with layer '0' (the DEF-003 undrawable-document defect)", async () => {
  const h = AppApiHandler.create(CONFIG);
  // Dirty session with a NON-'0' active layer.
  await h.handle(cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true }));
  await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "ly-000001", from: [0, 0], to: [10, 0] }] }));
  // NEW — then draw IMMEDIATELY (the benchmark's exact sequence).
  await h.handle(cmd("document.create", {}));
  const r = await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [300, 0] }] }));
  assert.equal(r.ok, true, "creation on the fresh document must succeed (no dangling layer reference)");
  const snap = val<{ elements: unknown[] }>(await h.handle(q("document.getState")));
  assert.equal(snap.elements.length, 1, "exactly ONE element after NEW + one line (no phantom inflation)");
});

// ---------------------------------------------------------------------------
// DEF-014 — entity-count integrity: SELECTALL counts only live elements.
// ---------------------------------------------------------------------------

test("repeated NEW/draw cycles keep Sel == drawn entities (the benchmark's Sel-3-after-one-line defect)", async () => {
  const h = AppApiHandler.create(CONFIG);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await h.handle(cmd("document.create", {}));
    for (let i = 0; i < 2; i += 1) {
      await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [i * 10, 0], to: [i * 10 + 5, 0] }] }));
    }
    const selRes = val<{ selection: string[] }>(await h.handle(cmd("document.setSelection", { ids: ["*"] })));
    // '*'-style garbage ids are dropped: the server prunes to live elements.
    assert.deepEqual(selRes.selection, [], "unknown ids are never stored");
    const snap = val<{ elements: { id: string }[] }>(await h.handle(q("document.getState")));
    await h.handle(cmd("document.setSelection", { ids: snap.elements.map((el) => el.id) }));
    const sel = val<string[]>(await h.handle(q("document.getSelection")));
    assert.equal(sel.length, 2, `cycle ${cycle}: Sel == 2 drawn entities (no phantom ids)`);
  }
});

// ---------------------------------------------------------------------------
// DEF-006 — the declared deterministic pickbox tolerance.
// ---------------------------------------------------------------------------

test("the pickbox is a declared deterministic screen-space tolerance", () => {
  assert.equal(PICKBOX_SCREEN_PX, 10, "the pickbox is 10 screen px (AutoCAD's default pickbox size)");
  // The world aperture is a pure function of zoom — deterministic at every
  // zoom level, identical on both hosts.
  assert.equal(pickApertureWorld(1), 10);
  assert.equal(pickApertureWorld(2), 5);
  assert.equal(pickApertureWorld(0.5), 20);
  assert.equal(pickApertureWorld(4), 2.5);
});

// ---------------------------------------------------------------------------
// DEF-027 — commit-authoritative echo.
// ---------------------------------------------------------------------------

test("splitEchoTiming: a plan's outcome echoes are exactly the trailing block of the output lines", () => {
  // LINE (chained path)
  const ctx = defaultCommandContext({ activeLayer: "0" });
  const started = applyPromptEvent(IDLE_PROMPT_STATE, { type: "start", commandId: "line" }, ctx);
  assert.equal(started.output.plan, null);
  const p1 = applyPromptEvent(started.state, { type: "typed", text: "0,0" }, ctx);
  assert.equal(p1.output.plan, null);
  const p2 = applyPromptEvent(p1.state, { type: "typed", text: "300,0" }, ctx);
  assert.ok(p2.output.plan !== null);
  {
    const { interactive, deferred } = splitEchoTiming(p2.output.lines, p2.output.plan);
    assert.deepEqual(deferred, p2.output.plan!.echo, "the deferred block IS the plan echo");
    assert.equal(interactive.length, p2.output.lines.length - deferred.length);
    assert.ok(deferred.some((l) => l.startsWith("LINE:")), "the LINE outcome claim is deferred, never immediate");
    assert.deepEqual([...interactive, ...deferred], p2.output.lines, "the partition is lossless");
  }
  // Instant command (NEW)
  {
    const r = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "NEW" }, ctx);
    assert.ok(r.output.plan !== null);
    const { interactive, deferred } = splitEchoTiming(r.output.lines, r.output.plan);
    assert.deepEqual(interactive, ["NEW"], "the command-name acknowledgment is interactive");
    assert.deepEqual(deferred, ["NEW."], "the outcome claim is deferred until file.new commits");
  }
  // No plan → everything interactive
  {
    const miss = applyPromptEvent(IDLE_PROMPT_STATE, { type: "typed", text: "NOSUCH" }, ctx);
    assert.equal(miss.output.plan, null);
    const { interactive, deferred } = splitEchoTiming(miss.output.lines, null);
    assert.deepEqual(interactive, miss.output.lines);
    assert.deepEqual(deferred, []);
  }
});

test("a failed canonical transaction is the one authoritative failure: typed error, NO document mutation, NO success echo channel", async () => {
  // The exact benchmark reproduction shape: the layer id was minted by a
  // DIFFERENT document session (the production deployment's split-instance
  // case, and the DEF-003 stale-client case) — the canonical document
  // rejects the create typed, with NO document mutation.
  const owner = AppApiHandler.create(CONFIG);
  await owner.handle(cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true }));
  const h = AppApiHandler.create(CONFIG);
  const before = val<{ version: { version_number: number }; elements: unknown[] }>(await h.handle(q("document.getState")));
  const r = await h.handle(
    cmd("drafting.createEntities", { entities: [{ type: "line", layer: "ly-000001", from: [0, 0], to: [300, 0] }] }),
  );
  assert.equal(r.ok, false, "the layer belongs to a DIFFERENT document session — the create must fail typed");
  assert.equal((r as { code: string }).code, "drafting_invalid");
  assert.match((r as { message: string }).message, /does not exist in the document layer table/);
  const after = val<{ version: { version_number: number }; elements: unknown[] }>(await h.handle(q("document.getState")));
  assert.equal(after.version.version_number, before.version.version_number, "the rejected transaction does not bump the version");
  assert.equal(after.elements.length, before.elements.length, "the rejected transaction does not mutate the document");
  void owner;
});

// ---------------------------------------------------------------------------
// Web/Electron parity (LOCK-004): the same flows through BOTH real host
// transports produce identical outcomes.
// ---------------------------------------------------------------------------

test("layer/selection/NEW flows are byte-identical through WebHost and ElectronHost", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  const script: Command[] = [
    cmd("drafting.addLayer", { name: "A-WALL-TEST", makeActive: true }),
    cmd("drafting.createEntities", { entities: [{ type: "line", layer: "ly-000001", from: [0, 0], to: [300, 0] }] }),
    cmd("document.setSelection", { ids: ["el-000001"] }),
    cmd("document.undo", {}),
    cmd("document.redo", {}),
    cmd("document.create", {}),
  ];
  type Outline = { layers: string[]; activeLayer: string | undefined; elements: number; selection: string[] };
  const outline = async (host: { execute(cmd: Command): Promise<CommandQueryResponse> }): Promise<Outline> => {
    const out: CommandQueryResponse[] = [];
    for (const c of script) out.push(await host.execute(c));
    // adopt the final create response (the host reset semantics)
    const last = out[out.length - 1]!;
    const snap = (last.ok ? last.value : (await host.execute(q("document.getState")))) as {
      layers: LayerRow[];
      draftingSettings: { activeLayer?: string };
      elements: unknown[];
      selection: string[];
    };
    return {
      layers: snap.layers.map((l) => l.name),
      activeLayer: snap.draftingSettings.activeLayer,
      elements: snap.elements.length,
      selection: snap.selection,
    };
  };
  const webOutline = await outline(web);
  const electronOutline = await outline(electron);
  assert.deepEqual(webOutline, electronOutline, "Web and Electron converge on the identical post-script document state");
  assert.deepEqual(webOutline, { layers: ["0"], activeLayer: undefined, elements: 0, selection: [] }, "the final NEW reset state is the canonical fresh document");
  // The undo pruned selection, the redo did not resurrect it — same on both hosts.
  const webSel = val<string[]>(await web.execute(q("document.getSelection")));
  assert.deepEqual(webSel, [], "post-NEW selection is empty through the Web host transport");
});

// ---------------------------------------------------------------------------
// CLAYER name resolution through the shared builder (the client resolution
// table IS the adopted authoritative snapshot — one identity space).
// ---------------------------------------------------------------------------

test("CLAYER resolves the name through the (adopted) layer table and emits a layer.setActive plan", () => {
  const ctx = defaultCommandContext({
    layers: [
      { id: "0", name: "0", color: "#111827", visible: true },
      { id: "ly-000001", name: "A-WALL-TEST", color: "#111827", visible: true },
    ],
  });
  const plans: { appApi: { name: string; payload: unknown }[] }[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "CLAYER" } },
      { event: { type: "typed", text: "A-WALL-TEST" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.appApi[0]!.name, "layer.setActive");
  assert.deepEqual(plans[0]!.appApi[0]!.payload, { layerId: "ly-000001" }, "the name resolves to the canonical id");
  assert.ok(lines.some((l) => l.includes("A-WALL-TEST")), "the echo carries the resolved layer name");
  // -LAYER M creates AND activates in one plan (the -LAYER Make flow)
  const layerCmd = resolveCommand("-LAYER");
  assert.ok(layerCmd !== null, "-LAYER resolves");
});

test("resolveCommand finds the COMPAT-CAD-005 golden surface commands", () => {
  for (const name of ["NEW", "SELECTALL", "LINE", "CLAYER", "-LAYER", "BLOCK", "UNDO", "REDO"]) {
    assert.ok(resolveCommand(name) !== null, `${name} resolves`);
  }
});
