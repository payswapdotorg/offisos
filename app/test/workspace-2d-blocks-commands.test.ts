/**
 * CAD-PARITY-006 deterministic blocks command tests (Issue #84) — the App
 * API block/attribute/xref command surface and the prompt-engine flows:
 * BLOCK conversion (sources removed atomically), INSERT with dynamic
 * per-attribute prompts (rematerializing steps), ATTDEF definition editing
 * with instance propagation, ATTEDIT value rewrites, EXPLODE through
 * entity.modify (one-level materialization), instance placement transforms,
 * the xref attach/reload/detach lifecycle with content provenance, the
 * blocks.list/xrefs.list queries, undo/redo convergence, save/open
 * round-trips and locked-layer enforcement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
// Import order matters for the commands.ts module cycle.
import { WORKSPACE_COMMANDS, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_BLOCK } from "../src/workspace/commands-blocks.js";
import { runCommandScript, type CommandScriptStep } from "../src/workspace/prompt-engine.js";
import type { CommandContext, CommandPlan, EntityPick } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CADDocumentSnapshot, Element } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const TOL = 1e-9;
const DEG = Math.PI / 180;

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cp6-e2e",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cad-parity-006-tests",
};

function make(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function q(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}
function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r as OkResult).value as T;
}
function errCode(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { code: string }).code;
}
function errMsg(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { message: string }).message;
}

async function state(h: AppApiHandler): Promise<CADDocumentSnapshot> {
  return val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
}

async function drawScene(h: AppApiHandler): Promise<void> {
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "circle", layer: "0", cx: 50, cy: 20, r: 10 },
  ] }));
}

function pickOf(id: string, props: Record<string, unknown>): EntityPick {
  return { id, kind: "geometry", props };
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test("COMMANDS_BLOCK: exactly the 10 CAD-PARITY-006 commands with their aliases", () => {
  assert.deepEqual(
    COMMANDS_BLOCK.map((c) => [c.id, c.name, [...c.aliases].sort()]),
    [
      ["block", "BLOCK", ["B"]],
      ["insert", "INSERT", ["I"]],
      ["attdef", "ATTDEF", ["ATD"]],
      ["attedit", "ATTEDIT", ["ATE"]],
      ["xattach", "XATTACH", ["XA"]],
      ["xdetach", "XDETACH", ["XD"]],
      ["xreload", "XRELOAD", []],
      ["xlist", "XLIST", []],
      ["xref", "XREF", ["XR"]],
      ["blocklist", "BLOCKLIST", ["BLI"]],
    ],
  );
});

test("every blocks command + alias resolves in the MERGED registry, exactly once", () => {
  for (const c of COMMANDS_BLOCK) {
    assert.equal(resolveCommand(c.name)?.id, c.id, `name ${c.name}`);
    for (const alias of c.aliases) {
      assert.equal(resolveCommand(alias)?.id, c.id, `alias ${alias}`);
    }
    assert.equal(WORKSPACE_COMMANDS.filter((m) => m.id === c.id).length, 1);
  }
});

// ---------------------------------------------------------------------------
// Prompt-engine flows (deterministic plans).
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return defaultCommandContext(overrides);
}

function blocksCtx(defs: CommandContext["blocks"], xrefs: CommandContext["xrefs"] = []): CommandContext {
  return ctx({ blocks: defs, xrefs });
}

function run(steps: readonly CommandScriptStep[], context: CommandContext = ctx()): { plans: CommandPlan[]; lines: string[] } {
  const plans: CommandPlan[] = [];
  const lines: string[] = [];
  const result = runCommandScript(steps, context, (plan) => {
    plans.push(plan);
    lines.push(...plan.echo);
  });
  return { plans, lines: [...lines, ...result.lines] };
}

function defRecord(id: string, name: string, entities: Record<string, unknown>[]) {
  return { id, name, basePoint: { x: 0, y: 0 }, entities, createdAt: "2026-01-01T00:00:00.000Z" };
}

test("BLOCK flow: name → base → objects emits the conversion command", () => {
  const line = { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" } };
  const { plans } = run([
    { event: { type: "typed", text: "BLOCK" } },
    { event: { type: "typed", text: "SYMBOL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "entity", entity: pickOf("el-000001", line.props) } },
    { event: { type: "enter" } },
  ]);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [
    { name: "block.create", payload: { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"], layer: "0" } },
  ]);
});

test("BLOCK pick validator: dimensions and xref instances are typed rejections, geometry/text/instances pass", () => {
  const command = resolveCommand("BLOCK")!;
  const objectsStep = command.steps.find((s) => s.id === "objects")!;
  assert.equal(objectsStep.validate!(pickOf("a", { drafting: true, type: "line", x1: 0, y1: 0, x2: 1, y2: 0 })), null);
  assert.equal(objectsStep.validate!(pickOf("a", { drafting: true, type: "block-ref", blockId: "b" })), null);
  assert.notEqual(objectsStep.validate!(pickOf("a", { drafting: true, type: "dim-linear", p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } })), null);
  assert.notEqual(objectsStep.validate!(pickOf("a", { drafting: true, type: "xref-ref", xrefId: "x" })), null);
  assert.notEqual(objectsStep.validate!(pickOf("a", { kind: "bim" } as unknown as Record<string, unknown>)), null);
});

test("INSERT flow: dynamic per-attribute prompts appear once the name is known (rematerializing steps)", () => {
  const defs = [
    defRecord("blk-000001", "TITLEBLOCK", [
      { type: "attdef", tag: "TITLE", prompt: "Drawing title", default: "Untitled", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
      { type: "attdef", tag: "SHEET", default: "A-001", layer: "0", x: 0, y: 5, height: 2.5, rotation: 0 },
    ]),
  ];
  const { plans } = run([
    { event: { type: "typed", text: "INSERT" } },
    { event: { type: "typed", text: "TITLEBLOCK" } },
    { event: { type: "pick", point: [100, 100] } },
    { event: { type: "typed", text: "2" } },
    { event: { type: "enter" } },   // rotation default 0
    { event: { type: "typed", text: "Plan B" } },   // TITLE value
    { event: { type: "enter" } },   // SHEET default
  ], blocksCtx(defs));
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as Record<string, unknown>;
  assert.equal(payload.name, "TITLEBLOCK");
  assert.equal(payload.scale, 2);
  assert.equal(payload.rotation, 0);
  assert.deepEqual(payload.attributes, [{ tag: "TITLE", value: "Plan B" }]);
});

test("INSERT with an unknown name completes the flow then fails typed at the builder", () => {
  const { plans, lines } = run([
    { event: { type: "typed", text: "INSERT" } },
    { event: { type: "typed", text: "NOPE" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "enter" } },
    { event: { type: "enter" } },
  ], blocksCtx([]));
  assert.equal(plans.length, 0);
  assert.ok(lines.some((l) => l.includes("no block definitions in this drawing")), lines.join("\n"));
});

test("ATTDEF flow: appends the attdef to the definition through block.update", () => {
  const defs = [defRecord("blk-000001", "SYMBOL", [])];
  const { plans } = run([
    { event: { type: "typed", text: "ATTDEF" } },
    { event: { type: "typed", text: "SYMBOL" } },
    { event: { type: "typed", text: "REV" } },
    { event: { type: "typed", text: "Revision" } },
    { event: { type: "typed", text: "0" } },
    { event: { type: "pick", point: [5, 5] } },
    { event: { type: "enter" } },
    { event: { type: "enter" } },
  ], blocksCtx(defs));
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as { name: string; patch: { entities: Record<string, unknown>[] } };
  assert.equal(payload.name, "SYMBOL");
  assert.equal(payload.patch.entities.length, 1);
  assert.equal(payload.patch.entities[0]!.tag, "REV");
  assert.equal(payload.patch.entities[0]!.prompt, "Revision");
  assert.equal(payload.patch.entities[0]!.default, "0");
});

test("ATTEDIT flow: pick → tag → value emits attribute.update", () => {
  const defs = [defRecord("blk-000001", "TITLED", [
    { type: "attdef", tag: "TITLE", default: "X", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
  ])];
  const instance = pickOf("el-000009", { drafting: true, type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 });
  const { plans } = run([
    { event: { type: "typed", text: "ATTEDIT" } },
    { event: { type: "entity", entity: instance } },
    { event: { type: "typed", text: "TITLE" } },
    { event: { type: "typed", text: "New Value" } },
  ], blocksCtx(defs));
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [{ name: "attribute.update", payload: { id: "el-000009", tag: "TITLE", value: "New Value" } }]);
});

test("XATTACH flow: attaches unresolved with the honest echo; XLIST lists statuses", () => {
  const { plans, lines } = run([
    { event: { type: "typed", text: "XATTACH" } },
    { event: { type: "typed", text: "SITE" } },
    { event: { type: "typed", text: "site.offisos" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "enter" } },
    { event: { type: "enter" } },
  ]);
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as Record<string, unknown>;
  assert.equal(payload.name, "SITE");
  assert.equal(payload.path, "site.offisos");
  assert.ok(lines.some((l) => l.includes("UNRESOLVED")), lines.join("\n"));

  const listed = run([{ event: { type: "typed", text: "XLIST" } }], blocksCtx([], [
    { id: "xr-000001", name: "SITE", path: "site.offisos", status: "unresolved", sourceHash: null, attachedAt: "t", entities: [] },
  ]));
  assert.ok(listed.lines.some((l) => l.includes("SITE") && l.includes("unresolved")), listed.lines.join("\n"));

  const declined = run([{ event: { type: "typed", text: "XRELOAD" } }]);
  assert.ok(declined.lines.some((l) => l.includes("References palette")), declined.lines.join("\n"));
});

// ---------------------------------------------------------------------------
// App API: block.create / insert / update / remove.
// ---------------------------------------------------------------------------

test("block.create converts sources + removes them in ONE revision; undo restores both", async () => {
  const h = make();
  await drawScene(h);
  const result = val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 50, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  assert.equal(result.entityCount, 2);
  assert.equal(result.removedSources, 2);
  const snap = await state(h);
  assert.equal(snap.elements.length, 0); // both sources converted
  assert.deepEqual(snap.blockDefs!.map((b) => b.name), ["SYMBOL"]);
  assert.equal(snap.blockDefs![0]!.entities[0]!.type, "line");
  assert.equal(snap.blockDefs![0]!.entities[1]!.type, "circle");
  val(await cmd(h, "document.undo", {}));
  const undone = await state(h);
  assert.equal(undone.elements.length, 2);
  assert.equal(undone.blockDefs, undefined);
});

test("block.create typed failures: unknown source, non-convertible source, duplicate name", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "annotation.create", { entities: [{ type: "dim-linear", layer: "0", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, mode: "aligned", offset: 5, measured: 10 }] }));
  assert.equal(errCode(await cmd(h, "block.create", { name: "X", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-999999"] })), "bad_id");
  assert.equal(errCode(await cmd(h, "block.create", { name: "X", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000003"] })), "bad_entity");
  assert.equal(errCode(await cmd(h, "block.create", { name: "", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] })), "bad_payload");
  val(await cmd(h, "block.create", { name: "GOOD", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  assert.equal(errCode(await cmd(h, "block.create", { name: "GOOD", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000002"] })), "block_invalid");
});

test("block.insert places instances; attributes validated against the definition slots", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 0, layer: "0" },
    { type: "circle", cx: 50, cy: 20, r: 10, layer: "0" },
    { type: "attdef", tag: "TITLE", default: "Untitled", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
  ] } }));
  const ins = val(await cmd(h, "block.insert", { name: "SYMBOL", x: 500, y: 500, scale: 2, rotation: 90 * DEG, attributes: [{ tag: "TITLE", value: "Plan" }] }));
  assert.equal(typeof ins.elementId, "string");
  const snap = await state(h);
  const ref = snap.elements[0]!.props as Record<string, unknown>;
  assert.equal(ref.type, "block-ref");
  assert.equal(snap.elements[0]!.id, ins.elementId);
  assert.equal(ref.scale, 2);
  assert.deepEqual(ref.attributes, [{ tag: "TITLE", value: "Plan" }]);
  // Unknown slot + duplicate tag + missing name are typed failures.
  assert.equal(errCode(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0, attributes: [{ tag: "NOPE", value: "x" }] })), "bad_attribute");
  assert.equal(errCode(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0, attributes: [{ tag: "TITLE", value: "a" }, { tag: "TITLE", value: "b" }] })), "bad_input");
  assert.equal(errCode(await cmd(h, "block.insert", { name: "MISSING", x: 0, y: 0 })), "bad_id");
  assert.equal(errCode(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0, scale: -1 })), "bad_payload");
});

test("block.update propagates to instances (definition → instance propagation, derived rendering)", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  val(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0 }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "circle", cx: 0, cy: 0, r: 99, layer: "0" },
  ] } }));
  const snap = await state(h);
  assert.equal(snap.blockDefs![0]!.entities[0]!.type, "circle");
  // The instance still references the definition (no duplication); the
  // derived content follows the definition at expansion time.
  assert.equal((snap.elements[0]!.props as Record<string, unknown>).type, "block-ref");
});

test("block.remove is reference-checked through the API", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  const ins = val(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0 }));
  const r = await cmd(h, "block.remove", { name: "SYMBOL" });
  assert.equal(r.ok, false);
  assert.ok(errMsg(r).includes("no silent cascade"), errMsg(r));
  // The reference-checked world: moving the instance keeps the guard intact.
  val(await cmd(h, "entity.modify", { op: "move", ids: [ins.elementId], dx: 1, dy: 1 }));
});

// ---------------------------------------------------------------------------
// EXPLODE + instance transforms through entity.modify.
// ---------------------------------------------------------------------------

test("EXPLODE through entity.modify: one-level materialization with attribute text", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 0, layer: "0" },
    { type: "attdef", tag: "TITLE", default: "D", layer: "0", x: 10, y: 10, height: 2.5, rotation: 0 },
  ] } }));
  const ins = val(await cmd(h, "block.insert", { name: "SYMBOL", x: 100, y: 100, scale: 2, rotation: 0, attributes: [{ tag: "TITLE", value: "V" }] }));
  const result = val(await cmd(h, "entity.modify", { op: "explode", ids: [ins.elementId] }));
  assert.equal(result.applied, true);
  assert.ok(String(result.summary).includes("materialized"), String(result.summary));
  const snap = await state(h);
  assert.equal(snap.elements.length, 2); // line + materialized attribute text
  const line = snap.elements.find((e) => (e.props as Record<string, unknown>).type === "line")!;
  assert.ok(line !== undefined);
  assert.equal((line.props as Record<string, unknown>).x2, 300); // 100 + 2×100
  const text = snap.elements.find((e) => e.kind === "annotation")!;
  assert.equal((text.props as Record<string, unknown>).value, "V");
  assert.equal((text.props as Record<string, unknown>).height, 5); // 2.5 × 2
  // Undo restores the instance.
  val(await cmd(h, "document.undo", {}));
  const undone = await state(h);
  assert.equal(undone.elements.length, 1);
  assert.equal((undone.elements[0]!.props as Record<string, unknown>).type, "block-ref");
});

test("nested EXPLODE: one level per explode (the nested ref becomes an independent instance)", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "INNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  val(await cmd(h, "block.update", { name: "INNER", patch: { entities: [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" }] } }));
  // OUTER contains INNER as nested content.
  val(await cmd(h, "block.create", { name: "OUTER", basePoint: { x: 0, y: 0 }, entities: [
    { type: "block-ref", layer: "0", blockId: "blk-000001", x: 20, y: 0, scale: 1, rotation: 0 },
  ] }));
  const ins = val(await cmd(h, "block.insert", { name: "OUTER", x: 100, y: 100, scale: 1, rotation: 0 }));
  val(await cmd(h, "entity.modify", { op: "explode", ids: [ins.elementId] }));
  let snap = await state(h);
  const nestedEl = snap.elements.find((e) => (e.props as Record<string, unknown>).type === "block-ref")!;
  const nested = nestedEl.props as Record<string, unknown>;
  assert.equal(nested.type, "block-ref");
  assert.equal(nested.blockId, "blk-000001");
  assert.equal(nested.x, 120);
  // Exploding AGAIN descends to the geometry.
  val(await cmd(h, "entity.modify", { op: "explode", ids: [nestedEl.id] }));
  snap = await state(h);
  assert.equal(snap.elements.filter((e) => (e.props as Record<string, unknown>).type === "line").length, 1);
});

test("instance MOVE/ROTATE/SCALE/COPY transform the placement exactly; MIRROR is a typed decline", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" }] } }));
  const ins = val(await cmd(h, "block.insert", { name: "SYMBOL", x: 100, y: 100, scale: 1, rotation: 0 }));
  const id = ins.elementId as string;
  const refOf = async (): Promise<Record<string, unknown>> => {
    const s = await state(h);
    return (s.elements.find((e) => e.id === id)!.props) as Record<string, unknown>;
  };
  // MOVE.
  val(await cmd(h, "entity.modify", { op: "move", ids: [id], dx: 50, dy: -50 }));
  let ref = await refOf();
  assert.equal(ref.x, 150);
  assert.equal(ref.y, 50);
  // ROTATE 90° about the origin.
  val(await cmd(h, "entity.modify", { op: "rotate", ids: [id], base: { x: 0, y: 0 }, angle: 90 * DEG }));
  ref = await refOf();
  assert.ok(Math.abs((ref.x as number) - -50) < TOL, String(ref.x));
  assert.ok(Math.abs((ref.y as number) - 150) < TOL);
  assert.ok(Math.abs((ref.rotation as number) - Math.PI / 2) < TOL);
  // SCALE ×2 about (0, 0).
  val(await cmd(h, "entity.modify", { op: "scale", ids: [id], base: { x: 0, y: 0 }, factor: 2 }));
  ref = await refOf();
  assert.equal(ref.scale, 2);
  // COPY keeps attributes + display.
  val(await cmd(h, "entity.modify", { op: "copy", ids: [id], dx: 10, dy: 10 }));
  const snap = await state(h);
  const refs = snap.elements.filter((e) => (e.props as Record<string, unknown>).type === "block-ref");
  assert.equal(refs.length, 2);
  assert.deepEqual(
    (refs[1]!.props as Record<string, unknown>).blockId,
    (refs[0]!.props as Record<string, unknown>).blockId,
  );
  // MIRROR is the typed decline.
  const r = await cmd(h, "entity.modify", { op: "mirror", ids: [id], p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } });
  assert.equal(r.ok, false);
  assert.equal(errCode(r), "mirror_unsupported");
});

// ---------------------------------------------------------------------------
// attribute.update + the inventory queries.
// ---------------------------------------------------------------------------

test("attribute.update rewrites values; null clears back to the definition default", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "T", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  val(await cmd(h, "block.update", { name: "T", patch: { entities: [
    { type: "attdef", tag: "TITLE", default: "Default", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
  ] } }));
  const ins = val(await cmd(h, "block.insert", { name: "T", x: 0, y: 0, attributes: [{ tag: "TITLE", value: "First" }] }));
  const id = ins.elementId as string;
  const refOf = async (): Promise<Record<string, unknown>> => {
    const s = await state(h);
    return (s.elements.find((e) => e.id === id)!.props) as Record<string, unknown>;
  };
  val(await cmd(h, "attribute.update", { id, tag: "TITLE", value: "Second" }));
  let ref = await refOf();
  assert.deepEqual(ref.attributes, [{ tag: "TITLE", value: "Second" }]);
  val(await cmd(h, "attribute.update", { id, tag: "TITLE", value: null }));
  ref = await refOf();
  assert.equal("attributes" in ref, false);
  assert.equal(errCode(await cmd(h, "attribute.update", { id, tag: "NOPE", value: "x" })), "bad_attribute");
  assert.equal(errCode(await cmd(h, "attribute.update", { id: "el-999999", tag: "TITLE", value: "x" })), "bad_id");
});

test("blocks.list + xrefs.list inventory queries", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" },
    { type: "attdef", tag: "A", layer: "0", x: 0, y: 0, height: 2, rotation: 0 },
  ] } }));
  val(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0 }));
  const listed = val<{ blocks: { id: string; name: string; entityCount: number; instances: number; attributeTags: string[] }[] }>(await q(h, "blocks.list", {}));
  assert.equal(listed.blocks.length, 1);
  assert.equal(listed.blocks[0]!.name, "SYMBOL");
  assert.equal(listed.blocks[0]!.entityCount, 2);
  assert.equal(listed.blocks[0]!.instances, 1);
  assert.deepEqual(listed.blocks[0]!.attributeTags, ["A"]);
  val(await cmd(h, "xref.attach", { name: "SITE", path: "site.offisos" }));
  const xrefs = val<{ xrefs: { name: string; status: string; instances: number }[] }>(await q(h, "xrefs.list", {}));
  assert.equal(xrefs.xrefs.length, 1);
  assert.equal(xrefs.xrefs[0]!.name, "SITE");
  assert.equal(xrefs.xrefs[0]!.status, "unresolved");
  assert.equal(xrefs.xrefs[0]!.instances, 0);
});

// ---------------------------------------------------------------------------
// The xref lifecycle through the API.
// ---------------------------------------------------------------------------

test("xref.attach with content: loaded with provenance hash + placement instance in ONE revision", async () => {
  const h = make();
  // Build an external snapshot through a second document.
  const external = make();
  await drawScene(external);
  const content = val(await q(external, "document.getState", {}));
  const result = val(await cmd(h, "xref.attach", { name: "SITE", path: "site.offisos", x: 200, y: 200, scale: 2, rotation: 0, content }));
  assert.equal(result.status, "loaded");
  assert.equal(result.resolved, 2);
  assert.equal(result.skipped, 0);
  assert.match(result.sourceHash as string, /^[0-9a-f]{64}$/);
  assert.equal(result.elementId, "el-000001");
  const snap = await state(h);
  assert.equal(snap.xrefs!.length, 1);
  assert.equal(snap.xrefs![0]!.status, "loaded");
  assert.equal(snap.xrefs![0]!.entities.length, 2);
  assert.equal((snap.elements[0]!.props as Record<string, unknown>).type, "xref-ref");
  // One revision: undo removes the record AND the instance together.
  val(await cmd(h, "document.undo", {}));
  const undone = await state(h);
  assert.equal(undone.xrefs, undefined);
  assert.equal(undone.elements.length, 0);
});

test("xref.attach without content attaches unresolved (the command-line bound)", async () => {
  const h = make();
  const result = val(await cmd(h, "xref.attach", { name: "MISSING", path: "m.offisos", x: 0, y: 0 }));
  assert.equal(result.status, "unresolved");
  assert.equal(result.sourceHash, null);
  const snap = await state(h);
  assert.equal(snap.xrefs![0]!.entities.length, 0);
});

test("xref.reload re-resolves with fresh content; without content it is a typed failure", async () => {
  const h = make();
  val(await cmd(h, "xref.attach", { name: "SITE", path: "site.offisos" }));
  const external = make();
  await drawScene(external);
  const content = val(await q(external, "document.getState", {}));
  const reloaded = val(await cmd(h, "xref.reload", { name: "SITE", content }));
  assert.equal(reloaded.status, "loaded");
  assert.equal(reloaded.resolved, 2);
  const r = await cmd(h, "xref.reload", { name: "SITE" });
  assert.equal(r.ok, false);
  assert.ok(errMsg(r).includes("References palette"));
});

test("xref.detach removes the record AND instances in ONE atomic revision", async () => {
  const h = make();
  const external = make();
  await drawScene(external);
  const content = val(await q(external, "document.getState", {}));
  val(await cmd(h, "xref.attach", { name: "SITE", path: "site.offisos", x: 0, y: 0, content }));
  val(await cmd(h, "xref.attach", { name: "TOPO", path: "topo.offisos", x: 500, y: 500, content }));
  const detached = val(await cmd(h, "xref.detach", { name: "SITE" }));
  assert.equal(detached.removedInstances, 1);
  const snap = await state(h);
  assert.deepEqual(snap.xrefs!.map((x) => x.name), ["TOPO"]);
  assert.equal(snap.elements.length, 1);
  assert.equal(errCode(await cmd(h, "xref.detach", { name: "NOPE" })), "bad_id");
});

// ---------------------------------------------------------------------------
// Save/open + locked layers + determinism.
// ---------------------------------------------------------------------------

test("save/open round-trips the full blocks world (fixtures survive)", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 0, layer: "0" },
    { type: "attdef", tag: "TITLE", default: "D", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
  ] } }));
  val(await cmd(h, "block.insert", { name: "SYMBOL", x: 10, y: 10, scale: 2, rotation: 0.5, attributes: [{ tag: "TITLE", value: "V" }] }));
  const saved = val<{ bytes: Uint8Array }>(await cmd(h, "document.save", {}));
  const h2 = make();
  val(await cmd(h2, "document.open", { source: saved.bytes, entityId: "roundtrip" }));
  const snap = await state(h2);
  assert.equal(snap.blockDefs!.length, 1);
  const ref = snap.elements.find((e) => (e.props as Record<string, unknown>).type === "block-ref")!;
  assert.deepEqual((ref.props as Record<string, unknown>).attributes, [{ tag: "TITLE", value: "V" }]);
});

test("locked/frozen layers gate instance creation + modification through the API", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
  val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "0" }] } }));
  const layer = val<{ layerId: string }>(await cmd(h, "drafting.addLayer", { name: "L" }));
  const lockedId = layer.layerId;
  val(await cmd(h, "drafting.updateLayer", { layerId: lockedId, patch: { locked: true } }));
  // Instances are drafting entities: creation on a locked layer is allowed;
  // MODIFICATION is what locked blocks (the frozen gate blocks creation).
  const ins = val(await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0, layer: lockedId }));
  const moveResult = await cmd(h, "entity.modify", { op: "move", ids: [ins.elementId], dx: 1, dy: 1 });
  assert.equal(moveResult.ok, false);
  val(await cmd(h, "drafting.updateLayer", { layerId: lockedId, patch: { locked: false, frozen: true } }));
  const insertFrozen = await cmd(h, "block.insert", { name: "SYMBOL", x: 0, y: 0, layer: lockedId });
  assert.equal(insertFrozen.ok, false);
});

test("determinism: the same command stream produces the byte-identical save", async () => {
  async function build(): Promise<string> {
    const h = make();
    await drawScene(h);
    val(await cmd(h, "block.create", { name: "SYMBOL", basePoint: { x: 50, y: 0 }, fromElementIds: ["el-000001", "el-000002"] }));
    val(await cmd(h, "block.update", { name: "SYMBOL", patch: { entities: [
      { type: "line", x1: 0, y1: 0, x2: 100, y2: 0, layer: "0" },
      { type: "circle", cx: 50, cy: 20, r: 10, layer: "0" },
      { type: "attdef", tag: "TITLE", default: "Untitled", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
    ] } }));
    const ins = val<{ elementId: string }>(await cmd(h, "block.insert", { name: "SYMBOL", x: 100, y: 100, scale: 2, rotation: Math.PI / 2, attributes: [{ tag: "TITLE", value: "Plan B" }] }));
    val(await cmd(h, "attribute.update", { id: ins.elementId, tag: "TITLE", value: "Plan C" }));
    val(await cmd(h, "entity.modify", { op: "explode", ids: [ins.elementId] }));
    const saved = val<{ bytes: Uint8Array }>(await cmd(h, "document.save", {}));
    return JSON.stringify(Array.from(saved.bytes));
  }
  const a = await build();
  const b = await build();
  assert.equal(a, b);
});
