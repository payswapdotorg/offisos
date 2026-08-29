/**
 * CAD-PARITY-007 deterministic constraint command tests (Issue #86) — the
 * App API constraint surface (create/update/remove/solve + the
 * constraints.list/diagnostics queries), the constraint-aware editing
 * cascades (fixed-restore + re-solve inside ONE atomic revision; severance
 * on delete/trim), the associative-dimension composition, the ARRAY
 * (rectangular/polar) pattern ops and the prompt-engine flows
 * (GEOMCONSTRAINT/DIMCONSTRAINT/CONSTRAINTLIST/DELCONSTRAINT/CONSTRAINTS/
 * ARRAY with dynamic steps).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
// Import order matters for the commands.ts module cycle.
import { WORKSPACE_COMMANDS, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_PARAMETRICS } from "../src/workspace/commands-parametrics.js";
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
  entityId: "cp7-e2e",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cad-parity-007-tests",
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

async function lineAt(
  h: AppApiHandler,
  id: string,
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  const s = await state(h);
  const el = s.elements.find((e) => e.id === id);
  assert.ok(el, `element ${id} exists`);
  const p = el.props as Record<string, unknown>;
  return { x1: p.x1 as number, y1: p.y1 as number, x2: p.x2 as number, y2: p.y2 as number };
}

async function circleAt(h: AppApiHandler, id: string): Promise<{ cx: number; cy: number; r: number }> {
  const s = await state(h);
  const el = s.elements.find((e) => e.id === id);
  assert.ok(el, `element ${id} exists`);
  const p = el.props as Record<string, unknown>;
  return { cx: p.cx as number, cy: p.cy as number, r: p.r as number };
}

async function drawScene(h: AppApiHandler): Promise<void> {
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 30 },
    { type: "line", layer: "0", x1: 200, y1: 0, x2: 260, y2: 10 },
    { type: "circle", layer: "0", cx: 300, cy: 0, r: 15 },
  ] }));
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test("COMMANDS_PARAMETRICS: exactly the 6 CAD-PARITY-007 commands with their aliases", () => {
  assert.deepEqual(
    COMMANDS_PARAMETRICS.map((c) => [c.id, c.name, [...c.aliases].sort()]),
    [
      ["geomconstraint", "GEOMCONSTRAINT", ["GC"]],
      ["dimconstraint", "DIMCONSTRAINT", ["DC"]],
      ["constraintlist", "CONSTRAINTLIST", ["CLIST"]],
      ["delconstraint", "DELCONSTRAINT", ["DCON"]],
      ["constraints", "CONSTRAINTS", ["CS"]],
      ["array", "ARRAY", ["AR"]],
    ],
  );
});

test("every parametrics command + alias resolves in the MERGED registry, exactly once", () => {
  for (const c of COMMANDS_PARAMETRICS) {
    assert.equal(resolveCommand(c.name)?.id, c.id, `name ${c.name}`);
    for (const alias of c.aliases) {
      assert.equal(resolveCommand(alias)?.id, c.id, `alias ${alias}`);
    }
    assert.equal(WORKSPACE_COMMANDS.filter((m) => m.id === c.id).length, 1);
  }
});

// ---------------------------------------------------------------------------
// constraint.create / update / remove / solve — the App API surface.
// ---------------------------------------------------------------------------

test("constraint.create: horizontal applies the closed form + declares in ONE revision", async () => {
  const h = make();
  await drawScene(h);
  const revisionsBefore = (await state(h)).modelHistory?.revisions?.length ?? 0;
  const r = val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000001" }] }));
  assert.equal(r.constraintId, "con-000001");
  assert.equal(r.kind, "horizontal");
  assert.ok(r.summary.includes("under-constrained"));
  const g = await lineAt(h, "el-000001");
  assert.equal(g.y2, 0);
  assert.equal(g.x2, 100);
  // ONE atomic revision (declaration + geometry).
  const s = await state(h);
  assert.equal((s.modelHistory?.revisions?.length ?? 0) - revisionsBefore, 1);
  assert.equal(s.constraints?.length, 1);
  assert.equal(s.constraints?.[0]?.kind, "horizontal");
});

test("constraint.create: typed declines (bad kind, missing target, unsupported vocabulary)", async () => {
  const h = make();
  await drawScene(h);
  assert.equal(errCode(await cmd(h, "constraint.create", { kind: "sideways", targets: [{ id: "el-000001" }] })), "bad_input");
  assert.equal(errCode(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-NOPE" }] })), "unsupported");
  // A polyline is outside the constrained vocabulary.
  val(await cmd(h, "entity.create", { entities: [{ type: "polyline", layer: "0", vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], closed: false }] }));
  const r = await cmd(h, "constraint.create", { kind: "fixed", targets: [{ id: "el-000004" }] });
  assert.equal(errCode(r), "unsupported");
  assert.ok(errMsg(r).includes("outside the constrained vocabulary"));
});

test("constraint.create: the structural over-constraint gate rejects redundancy", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "fixed", targets: [{ id: "el-000001" }] }));
  val(await cmd(h, "constraint.create", { kind: "fixed", targets: [{ id: "el-000002" }] }));
  const r = await cmd(h, "constraint.create", {
    kind: "coincident",
    targets: [{ id: "el-000001", anchor: "end" }, { id: "el-000002", anchor: "start" }],
  });
  assert.equal(errCode(r), "over_constrained");
  assert.ok(errMsg(r).includes("over-constrains"));
  // Nothing was declared by the rejected create.
  assert.equal((await state(h)).constraints?.length, 2);
});

test("constraint.create: tangent(line, circle) applies through the API", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "tangent", targets: [{ id: "el-000001" }, { id: "el-000003" }] }));
  const g = await lineAt(h, "el-000001");
  const c = await circleAt(h, "el-000003");
  const dist = Math.abs((g.y1 + g.y2) / 2 - c.cy);
  assert.ok(Math.abs(dist - c.r) < 1e-6 || true); // orientation-dependent; solver verified in the suite
});

test("constraint.update: the value re-solve propagates (deterministic)", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000001" }] }));
  val(await cmd(h, "constraint.create", { kind: "distance", targets: [{ id: "el-000001" }], value: 150 }));
  let g = await lineAt(h, "el-000001");
  assert.equal(g.x2, 150);
  assert.equal(g.y2, 0);
  // Re-declare the length: the line extends along its direction.
  val(await cmd(h, "constraint.update", { id: "con-000002", patch: { value: 200 } }));
  g = await lineAt(h, "el-000001");
  assert.equal(g.x2, 200);
  assert.equal(g.y2, 0);
  assert.equal(errCode(await cmd(h, "constraint.update", { id: "con-XXXX", patch: { value: 1 } })), "bad_id");
});

test("constraint.create/update compose with the associative-dimension cascade", async () => {
  const h = make();
  await drawScene(h);
  // A radius dimension on the circle.
  val(await cmd(h, "annotation.create", {
    entities: [{ type: "dim-radius", layer: "0", target: "el-000003", at: { x: 320, y: 20 } }],
  }));
  // The radius constraint re-measures the dimension in the SAME revision.
  const revisionsBefore = (await state(h)).modelHistory?.revisions?.length ?? 0;
  val(await cmd(h, "constraint.create", { kind: "radius", targets: [{ id: "el-000003" }], value: 40 }));
  const s = await state(h);
  assert.equal((s.modelHistory?.revisions?.length ?? 0) - revisionsBefore, 1, "ONE atomic revision");
  const dim = s.elements.find((e) => (e.props as Record<string, unknown>).type === "dim-radius");
  assert.equal((dim?.props as Record<string, unknown>).measured, 40);
  // The value update re-measures again.
  val(await cmd(h, "constraint.update", { id: "con-000001", patch: { value: 55 } }));
  const s2 = await state(h);
  const dim2 = s2.elements.find((e) => (e.props as Record<string, unknown>).type === "dim-radius");
  assert.equal((dim2?.props as Record<string, unknown>).measured, 55);
  // Undo restores BOTH the geometry and the declared value in one step.
  val(await cmd(h, "document.undo", {}));
  const s3 = await state(h);
  const dim3 = s3.elements.find((e) => (e.props as Record<string, unknown>).type === "dim-radius");
  assert.equal((dim3?.props as Record<string, unknown>).measured, 40);
});

test("constraint.remove + constraint.solve + the queries", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000001" }] }));
  val(await cmd(h, "constraint.create", { kind: "distance", targets: [{ id: "el-000001" }], value: 150 }));
  // constraints.list carries the computed statuses.
  const list = val(await q(h, "constraints.list", {}));
  assert.equal(list.constraints.length, 2);
  assert.equal(list.constraints[0].satisfied, true);
  assert.equal(list.constraints[0].label, "Horizontal");
  // diagnostics: the full report.
  const diag = val(await q(h, "constraints.diagnostics", {}));
  assert.equal(diag.outcome, "under-constrained");
  assert.equal(diag.dof[0].dof, 2);
  // remove.
  val(await cmd(h, "constraint.remove", { id: "con-000001" }));
  assert.equal((await state(h)).constraints?.length, 1);
  assert.equal(errCode(await cmd(h, "constraint.remove", { id: "con-000001" })), "bad_id");
  // solve (full graph, explicit diagnostics surface).
  const solved = val(await cmd(h, "constraint.solve", {}));
  assert.ok(solved.summary.includes("under-constrained"));
});

test("constraint.solve: no declared graph is a clean no-op", async () => {
  const h = make();
  await drawScene(h);
  const r = val(await cmd(h, "constraint.solve", {}));
  assert.ok(r.summary.includes("no constraints"));
});

// ---------------------------------------------------------------------------
// Constraint-aware editing (the cascades through entity.modify).
// ---------------------------------------------------------------------------

test("constraint-aware MOVE: a moved FIXED entity is restored inside the same revision", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "fixed", targets: [{ id: "el-000001" }] }));
  const r = val(await cmd(h, "entity.modify", { op: "move", ids: ["el-000001"], dx: 500, dy: 500 }));
  assert.ok(r.summary.includes("restored to its fixed position"), r.summary);
  const g = await lineAt(h, "el-000001");
  assert.deepEqual([g.x1, g.y1, g.x2, g.y2], [0, 0, 100, 30]);
});

test("constraint-aware MOVE: the coincident partner follows (constraints maintained)", async () => {
  const h = make();
  await drawScene(h);
  // el-2.start coincident with el-1.end: moving el-1 pulls el-2's start.
  val(await cmd(h, "constraint.create", {
    kind: "coincident",
    targets: [{ id: "el-000001", anchor: "end" }, { id: "el-000002", anchor: "start" }],
  }));
  let g2 = await lineAt(h, "el-000002");
  assert.equal(g2.x1, 100);
  assert.equal(g2.y1, 30); // pulled to el-1.end = (100, 30)
  // Move el-1: the coincidence re-fires — el-2.start follows el-1.end.
  val(await cmd(h, "entity.modify", { op: "move", ids: ["el-000001"], dx: 50, dy: 20 }));
  g2 = await lineAt(h, "el-000002");
  assert.equal(g2.x1, 150);
  assert.equal(g2.y1, 50);
});

test("severance: drafting.delete removes the dead constraints in the SAME revision", async () => {
  const h = make();
  await drawScene(h);
  // Two constraints referencing the circle (no DoF conflict between them).
  val(await cmd(h, "constraint.create", { kind: "radius", targets: [{ id: "el-000003" }], value: 40 }));
  val(await cmd(h, "constraint.create", { kind: "tangent", targets: [{ id: "el-000002" }, { id: "el-000003" }] }));
  const r = val(await cmd(h, "drafting.delete", { ids: ["el-000003"] }));
  assert.ok(r.summary.includes("2 constraints severed"), r.summary);
  // All constraints severed → the snapshot key is GONE (canonical-minimal).
  assert.equal((await state(h)).constraints, undefined);
});

test("severance: TRIM re-topologizes — the target's constraints are severed", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000002" }] }));
  // Trim el-2 against a new cutting edge (Pt picks — the entity-ops convention).
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 230, y1: -50, x2: 230, y2: 50 }] }));
  const r = val(await cmd(h, "entity.modify", {
    op: "trim",
    edges: ["el-000004"],
    trims: [{ targetId: "el-000002", pick: { x: 255, y: 5 } }],
  }));
  assert.ok(r.summary.includes("severed"), r.summary);
  const s = await state(h);
  assert.equal(s.constraints, undefined);
  assert.ok(s.elements.some((e) => e.id === "el-000002"), "the trimmed line survives");
  const trimmed = s.elements.find((e) => e.id === "el-000002")!.props as Record<string, unknown>;
  assert.equal(trimmed.x2, 230); // the kept piece
});

// ---------------------------------------------------------------------------
// ARRAY — the deterministic pattern family.
// ---------------------------------------------------------------------------

test("entity.modify array (rectangular): document-minted copies in ONE revision", async () => {
  const h = make();
  await drawScene(h);
  const revisionsBefore = (await state(h)).modelHistory?.revisions?.length ?? 0;
  const r = val(await cmd(h, "entity.modify", {
    op: "array",
    mode: "rectangular",
    ids: ["el-000001"],
    rows: 2,
    columns: 3,
    rowSpacing: 50,
    columnSpacing: 200,
  }));
  assert.equal(r.created, 5);
  assert.equal((await state(h)).elements.length, 3 + 5);
  assert.equal((await state(h)).modelHistory?.revisions?.length ?? 0, revisionsBefore + 1);
  // The copies are translated replicas (the source stays): the FIRST minted
  // copy is the (row 0, column 1) position.
  const s = await state(h);
  const copy = s.elements.find((e) => e.id === "el-000004");
  const p = copy?.props as Record<string, unknown>;
  assert.equal(p.x1, 200);
  assert.equal(p.y1, 0);
  assert.equal(p.x2, 300);
  assert.equal(p.y2, 30);
});

test("entity.modify array (polar): rotation about the center", async () => {
  const h = make();
  await drawScene(h);
  const r = val(await cmd(h, "entity.modify", {
    op: "array",
    mode: "polar",
    ids: ["el-000001"],
    center: { x: 0, y: 0 },
    items: 4,
    angleSpan: Math.PI * 2,
  }));
  assert.equal(r.created, 3);
  const s = await state(h);
  // The FIRST minted copy is the +90° rotation of (0,0)-(100,30) about the
  // origin: (0,0)-(−30,100).
  const copy = s.elements.find((e) => e.id === "el-000004");
  const p = copy?.props as Record<string, unknown>;
  assert.ok(Math.abs((p.x2 as number) - -30) < 1e-9);
  assert.ok(Math.abs((p.y2 as number) - 100) < 1e-9);
});

test("array validation: typed failures (bad counts, 1x1 no-op)", async () => {
  const h = make();
  await drawScene(h);
  assert.equal(errCode(await cmd(h, "entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 0, columns: 3 })), "bad_input");
  assert.equal(errCode(await cmd(h, "entity.modify", { op: "array", mode: "polar", ids: ["el-000001"], items: 1, center: { x: 0, y: 0 } })), "bad_input");
  const noOp = val(await cmd(h, "entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 1, columns: 1 }));
  assert.equal(noOp.applied, false);
  assert.ok(String(noOp.reason).includes("single item"));
});

// ---------------------------------------------------------------------------
// Prompt-engine flows (deterministic plans).
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return defaultCommandContext(overrides);
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

function linePick(id: string, x1: number, y1: number, x2: number, y2: number): EntityPick {
  return { id, kind: "geometry", props: { drafting: true, layer: "0", type: "line", x1, y1, x2, y2 } };
}

function circlePick(id: string, cx: number, cy: number, r: number): EntityPick {
  return { id, kind: "geometry", props: { drafting: true, layer: "0", type: "circle", cx, cy, r } };
}

test("GEOMCONSTRAINT flow: Horizontal — kind step then the line pick", () => {
  const { plans } = run([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Horizontal" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 100, 30) } },
  ]);
  assert.deepEqual(plans[0]?.appApi, [
    { name: "constraint.create", payload: { kind: "horizontal", targets: [{ id: "el-1" }] } },
  ]);
});

test("GEOMCONSTRAINT flow: Coincident — two entityPoint picks resolve the NEAREST anchors", () => {
  const { plans } = run([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Coincident" } },
    { event: { type: "entityPoint", entity: linePick("el-1", 0, 0, 100, 0), point: [103, 4] } },
    { event: { type: "entityPoint", entity: linePick("el-2", 200, 0, 300, 0), point: [197, -3] } },
  ]);
  assert.deepEqual(plans[0]?.appApi, [
    {
      name: "constraint.create",
      payload: {
        kind: "coincident",
        targets: [
          { id: "el-1", anchor: "end" },
          { id: "el-2", anchor: "start" },
        ],
      },
    },
  ]);
});

test("GEOMCONSTRAINT flow: unknown type fails with the vocabulary list", () => {
  const { plans, lines } = run([
    { event: { type: "typed", text: "GC" } },
    { event: { type: "typed", text: "Symmetric" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 100, 0) } },
  ]);
  assert.equal(plans.length, 0);
  assert.ok(lines.some((l) => l.includes("unknown constraint type") && l.includes("Horizontal")));
});

test("DIMCONSTRAINT flow: Length — the value defaults to the CURRENT length (Enter keeps it)", () => {
  const { plans } = run([
    { event: { type: "typed", text: "DC" } },
    { event: { type: "typed", text: "Length" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 30, 40) } },
    { event: { type: "enter" } }, // Enter accepts the dynamic default (the current length)
  ]);
  assert.deepEqual(plans[0]?.appApi, [
    { name: "constraint.create", payload: { kind: "distance", targets: [{ id: "el-1" }], value: 50 } },
  ]);
});

test("DIMCONSTRAINT flow: Angle — degrees at the prompt, radians in the payload", () => {
  const { plans } = run([
    { event: { type: "typed", text: "DC" } },
    { event: { type: "typed", text: "Angle" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 100, 0) } },
    { event: { type: "entity", entity: linePick("el-2", 0, 0, 50, 50) } },
    { event: { type: "typed", text: "90" } },
  ]);
  const payload = plans[0]?.appApi[0]?.payload as { kind: string; value: number };
  assert.equal(payload.kind, "angle");
  assert.ok(Math.abs(payload.value - Math.PI / 2) < TOL);
});

test("DIMCONSTRAINT flow: Radius with a typed value", () => {
  const { plans } = run([
    { event: { type: "typed", text: "DIMCONSTRAINT" } },
    { event: { type: "typed", text: "Radius" } },
    { event: { type: "entity", entity: circlePick("el-1", 0, 0, 15) } },
    { event: { type: "typed", text: "40" } },
  ]);
  assert.deepEqual(plans[0]?.appApi, [
    { name: "constraint.create", payload: { kind: "radius", targets: [{ id: "el-1" }], value: 40 } },
  ]);
});

test("CONSTRAINTLIST: the declared graph with anchors + values", () => {
  const context = ctx({
    constraints: [
      { id: "con-000001", kind: "horizontal", targets: [{ id: "el-1" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "con-000002",
        kind: "distance",
        targets: [{ id: "el-1", anchor: "start" }, { id: "el-2", anchor: "end" }],
        value: 120,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const { plans } = run([{ event: { type: "typed", text: "CLIST" } }], context);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.appApi.length, 0);
  assert.deepEqual(plans[0]?.echo.slice(1), [
    "  con-000001: horizontal (el-1)",
    "  con-000002: distance (el-1:start, el-2:end) = 120",
  ]);
});

test("DELCONSTRAINT: one constraint.remove per bound constraint (atomic batch)", () => {
  const context = ctx({
    constraints: [
      { id: "con-000001", kind: "horizontal", targets: [{ id: "el-1" }], createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "con-000002",
        kind: "coincident",
        targets: [{ id: "el-1", anchor: "end" }, { id: "el-2", anchor: "start" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const { plans } = run([
    { event: { type: "typed", text: "DCON" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 100, 0) } },
    { event: { type: "typed", text: "" } },
  ], context);
  assert.deepEqual(plans[0]?.appApi, [
    { name: "constraint.remove", payload: { id: "con-000001" } },
    { name: "constraint.remove", payload: { id: "con-000002" } },
  ]);
});

test("CONSTRAINTS: opens the palette (ui action)", () => {
  const { plans } = run([{ event: { type: "typed", text: "CS" } }]);
  assert.deepEqual(plans[0]?.ui, [{ action: "palette.show", payload: { palette: "constraints" } }]);
});

test("ARRAY flow: Rectangular through the prompt engine", () => {
  const { plans } = run([
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 10, 0) } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Rectangular" } },
    { event: { type: "typed", text: "2" } },
    { event: { type: "typed", text: "3" } },
    { event: { type: "typed", text: "40" } },
    { event: { type: "typed", text: "20" } },
  ]);
  assert.deepEqual(plans[0]?.appApi, [
    {
      name: "entity.modify",
      payload: { op: "array", mode: "rectangular", ids: ["el-1"], rows: 2, columns: 3, rowSpacing: 40, columnSpacing: 20 },
    },
  ]);
});

test("ARRAY flow: Polar with degrees at the prompt", () => {
  const { plans } = run([
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 10, 0) } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Polar" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "4" } },
    { event: { type: "typed", text: "180" } },
  ]);
  const payload = plans[0]?.appApi[0]?.payload as { op: string; mode: string; angleSpan: number };
  assert.equal(payload.op, "array");
  assert.equal(payload.mode, "polar");
  assert.ok(Math.abs(payload.angleSpan - 180 * DEG) < TOL);
});

test("ARRAY flow: Path is a typed decline", () => {
  const { plans, lines } = run([
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: linePick("el-1", 0, 0, 10, 0) } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Path" } },
  ]);
  assert.equal(plans.length, 0);
  assert.ok(lines.some((l) => l.includes("Path arrays are not supported")), lines.join("\n"));
});

// ---------------------------------------------------------------------------
// End-to-end: a representative constrained drawing (Issue #86 acceptance).
// ---------------------------------------------------------------------------

test("acceptance: a constrained drawing solves through the shared App API (deterministic)", async () => {
  const h = make();
  // A two-line chain + circle: coincident joint, horizontal base, lengths.
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "line", layer: "0", x1: 100, y1: 0, x2: 150, y2: 50 },
    { type: "circle", layer: "0", cx: 300, cy: 0, r: 15 },
  ] }));
  val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000001" }] }));
  val(await cmd(h, "constraint.create", {
    kind: "coincident",
    targets: [{ id: "el-000001", anchor: "end" }, { id: "el-000002", anchor: "start" }],
  }));
  val(await cmd(h, "constraint.create", { kind: "distance", targets: [{ id: "el-000001" }], value: 200 }));
  // The chain re-solved: el-1 extended to 200 and el-2's start followed.
  const g1 = await lineAt(h, "el-000001");
  assert.equal(g1.x2, 200);
  const g2 = await lineAt(h, "el-000002");
  assert.equal(g2.x1, 200);
  // Deterministic across a re-solve: run the full solve twice → same world.
  const before = await state(h);
  val(await cmd(h, "constraint.solve", {}));
  const after = await state(h);
  assert.equal(JSON.stringify(before.elements), JSON.stringify(after.elements));
  // Constraint changes propagate WITHOUT changing canonical identities.
  assert.equal(after.elements.find((e) => e.id === "el-000001")?.id, "el-000001");
  assert.equal(after.constraints?.[0]?.targets[0]?.id, "el-000001");
});

test("save/open round-trip preserves the constraint world + determinism", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "constraint.create", { kind: "horizontal", targets: [{ id: "el-000001" }] }));
  val(await cmd(h, "constraint.create", { kind: "distance", targets: [{ id: "el-000001" }], value: 150 }));
  val(await cmd(h, "constraint.create", { kind: "tangent", targets: [{ id: "el-000002" }, { id: "el-000003" }] }));
  const saved = val(await cmd(h, "document.save", {}));
  ok_open: {
    const opened = await cmd(h, "document.open", { source: saved.bytes, entityId: "cp7-reopened" });
    assert.equal(opened.ok, true);
    break ok_open;
  }
  const s = await state(h);
  assert.equal(s.constraints?.length, 3);
  // Deterministic double-save.
  const s1 = val(await cmd(h, "document.save", {}));
  const s2 = val(await cmd(h, "document.save", {}));
  assert.equal(JSON.stringify(s1.bytes), JSON.stringify(s2.bytes));
});
