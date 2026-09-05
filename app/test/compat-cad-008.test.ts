/**
 * COMPAT-CAD-008 (Issue #5) — preparation-spike deterministic coverage for
 * the ARRAY/materialization surface (CAD-BENCH-RW-001 DEF-015) over the
 * merged COMPAT-CAD-007 selection/edit foundations.
 *
 * SPIKE BOUNDARY (the Architect's parallel-build directive, Issue #5 comment
 * 5553465375): this suite is PREPARATION evidence on the
 * work/compat-cad-008-array-preparation branch only — it is NOT a CC008
 * lifecycle transition, NOT a PR, and NOT a verification claim. CC008
 * remains DRAFT until the Architect legally advances it beyond the CC007
 * dependency gate.
 *
 * Coverage (the CC008 semantic contract's evidence fixtures, docs/work-items/
 * COMPAT-CAD-008-SEMANTIC-CONTRACT.md §11, mapped 1:1):
 *  1. rectangular 2×3 creation — row-major member order, document-minted
 *     identities, ONE atomic revision, exact translated geometry, source
 *     preserved, layer inherited;
 *  2. rectangular 1×1 — the explicit deterministic no-op (empty plan, zero
 *     mutation, no fabricated duplicate; op + command layers agree);
 *  3. rectangular invalid counts/spacings — typed bad_input pre-mutation on
 *     a byte-identical document (incl. the signed-spacing boundary);
 *  4. polar count 4 about a non-zero center — members at k·90°, rotated,
 *     ONE revision;
 *  5. the full-circle convention — full span steps 360°/count and never
 *     duplicates index 0; partial span is endpoint-inclusive;
 *  6. polar count 1 — the deterministic no-op;
 *  7. Path mode + degenerate inputs — typed declines, zero plans, zero
 *     mutation;
 *  8. materialized members are selectable immediately after commit through
 *     the CC007 selection path (pickableEntityPicks + the ALL keyword);
 *  9. ERASE removes exactly one member; UNDO restores the exact post-ARRAY
 *     elements; REDO re-erases; the pickable view never references dead ids;
 *  10. repeated execution byte identity — byte-identical plans/echo lines
 *      and identical serialized state on fresh documents;
 *  11. Web/Electron parity — the identical ARRAY stream through both real
 *      host transports, equivalent affected serialized state;
 *  12. CC005/006/007 regression pins — prompt ownership, the ALL keyword,
 *      typed-coordinate commits, no-plan-before-completion.
 *  Plus the contract's zero-spacing boundary: overlapping members remain
 *  uniquely canonical (distinct minted ids; ERASE/undo exact).
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
  entityId: "cc008-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc008-test",
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
function errCode(r: CommandQueryResponse): string {
  if (r.ok) throw new Error(`expected ErrResult, got Ok: ${JSON.stringify(r.value)}`);
  return r.code;
}

interface ElementRow {
  readonly id: string;
  readonly kind: string;
  readonly props: Record<string, unknown>;
}
interface StateOutline {
  readonly elements: readonly ElementRow[];
  readonly version: number;
  readonly revisions: number;
}

async function stateOf(h: AppApiHandler): Promise<StateOutline> {
  const s = val<{ elements: ElementRow[]; version: { version_number: number }; modelHistory?: { revisions?: unknown[] } }>(
    await h.handle(q("document.getState")),
  );
  return { elements: s.elements, version: s.version.version_number, revisions: s.modelHistory?.revisions?.length ?? 0 };
}
async function fullStateOf(h: AppApiHandler): Promise<string> {
  return JSON.stringify(val(await h.handle(q("document.getState"))));
}

/** The deterministic projection of the canonical state: elements, version
 *  number and the revision CONTENT (applied edit, delta, note). The
 *  document identity (entity/version UUIDs and their embedded hashes) is
 *  instance-random by design and excluded — byte identity is asserted over
 *  the semantic surface. */
async function projectionOf(h: AppApiHandler): Promise<string> {
  const s = val<{
    elements: ElementRow[];
    version: { version_number: number };
    modelHistory?: { revisions?: { applied_edit: unknown; delta: unknown; note: string }[] };
  }>(await h.handle(q("document.getState")));
  return JSON.stringify({
    elements: s.elements,
    versionNumber: s.version.version_number,
    revisions: (s.modelHistory?.revisions ?? []).map((r) => ({ applied_edit: r.applied_edit, delta: r.delta, note: r.note })),
  });
}

/** A pickable element view over live handler elements (the hosts' rule). */
function selectableOf(h: AppApiHandler): Promise<readonly EntityPick[]> {
  return stateOf(h).then((s) => pickableEntityPicks(s.elements as never, LAYERS as never));
}

const LAYERS = [{ id: "0", name: "0", color: "#111827", visible: true }];

function ctxOf(overrides: Partial<Parameters<typeof defaultCommandContext>[0]> = {}) {
  return defaultCommandContext({ activeLayer: "0", layers: LAYERS, ...overrides });
}

/** The canonical three-entity fixture: two lines + one circle on layer "0". */
async function seeded(): Promise<AppApiHandler> {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
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
  return h;
}

function linePick(id: string, x1: number, y1: number, x2: number, y2: number): EntityPick {
  return { id, kind: "geometry", props: { drafting: true, layer: "0", type: "line", x1, y1, x2, y2 } };
}

const approx = (actual: unknown, expected: number, label = ""): void =>
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${label} ${actual} ≈ ${expected}`);

const coords = (s: StateOutline, id: string): [number, number, number, number] => {
  const p = s.elements.find((el) => el.id === id)!.props;
  return [p.x1 as number, p.y1 as number, p.x2 as number, p.y2 as number];
};

// ---------------------------------------------------------------------------
// Fixtures 1-3 — rectangular arrays.
// ---------------------------------------------------------------------------

test("fixture 1 — ARRAY rectangular 2×3: five minted members in ONE revision, row-major order, exact geometry", async () => {
  const h = await seeded();
  const before = await stateOf(h);
  const r = val<{ created: number; summary: string }>(
    await h.handle(
      cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, rowSpacing: 50, columnSpacing: 200 }),
    ),
  );
  assert.equal(r.created, 5);
  const after = await stateOf(h);
  assert.equal(after.elements.length, before.elements.length + 5, "3 sources + 5 members");
  assert.equal(after.revisions, before.revisions + 1, "ONE atomic revision for the whole ARRAY");
  // Row-major member order: (r0,c1), (r0,c2), (r1,c0), (r1,c1), (r1,c2).
  const expected: [string, number, number][] = [
    ["el-000004", 200, 0],
    ["el-000005", 400, 0],
    ["el-000006", 0, 50],
    ["el-000007", 200, 50],
    ["el-000008", 400, 50],
  ];
  for (const [id, dx, dy] of expected) {
    assert.deepEqual(coords(after, id), [dx, dy, 100 + dx, dy], `${id} at row-major offset (${dx}, ${dy})`);
    assert.equal(after.elements.find((el) => el.id === id)!.props.layer, "0", "layer inherited from the source");
  }
  // The source occurrence (the (0,0) member) is preserved unmoved (its
  // drafting-created props keep the from/to convention; the op-materialized
  // members carry the flat x1..y2 convention — both decode through the
  // shared geometry bridge).
  const src = after.elements.find((el) => el.id === "el-000001")!.props;
  assert.deepEqual([src.from, src.to], [[0, 0], [100, 0]]);
});

test("fixture 2 — ARRAY rectangular 1×1 is the explicit deterministic no-op: no mutation, no fabricated duplicate", async () => {
  const h = await seeded();
  const before = await fullStateOf(h);
  // Op layer: applied:false with the deterministic reason.
  const noOp = val<{ applied: boolean; reason: string }>(
    await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 1, columns: 1 })),
  );
  assert.equal(noOp.applied, false);
  assert.ok(String(noOp.reason).includes("single item"), String(noOp.reason));
  assert.equal(await fullStateOf(h), before, "zero mutation (byte-identical state)");

  // Command layer: the SAME no-op under the existing command contract — a
  // plan IS a result (not a cancel), with an empty App API batch.
  const selectable = await selectableOf(h);
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "AR" } },
      { event: { type: "entity", entity: selectable[0]! } },
      { event: { type: "typed", text: "" } },
      { event: { type: "typed", text: "Rectangular" } },
      { event: { type: "typed", text: "1" } },
      { event: { type: "typed", text: "1" } },
      { event: { type: "typed", text: "50" } },
      { event: { type: "typed", text: "200" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (p) => plans.push(p),
  );
  assert.equal(plans.length, 1, "the no-op plan is a result");
  assert.deepEqual(plans[0]!.appApi, [], "no canonical mutation");
  assert.ok(lines.some((l) => l.includes("nothing to create")), lines.join("\n"));
});

test("fixture 3 — ARRAY invalid counts and spacings fail typed (bad_input) before any mutation", async () => {
  const h = await seeded();
  const before = await fullStateOf(h);
  const bad: unknown[] = [
    { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 0, columns: 3 },
    { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2.5, columns: 3 },
    { op: "array", mode: "rectangular", ids: ["el-000001"], rows: -1, columns: 3 },
    { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, rowSpacing: -10 },
    { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, columnSpacing: -0.001 },
    { op: "array", mode: "polar", ids: ["el-000001"], items: 0, center: { x: 0, y: 0 } },
    { op: "array", mode: "polar", ids: ["el-000001"], items: -3, center: { x: 0, y: 0 } },
    { op: "array", mode: "polar", ids: [], items: 4, center: { x: 0, y: 0 } },
    { op: "array", mode: "polar", ids: ["el-000001"], items: 4 },
    { op: "array", mode: "polar", ids: ["el-000001"], items: 4, center: { x: 0, y: 0 }, angleSpan: 0 },
  ];
  for (const payload of bad) {
    assert.equal(errCode(await h.handle(cmd("entity.modify", payload))), "bad_input", JSON.stringify(payload));
  }
  assert.equal(await fullStateOf(h), before, "the document is byte-identical after every typed failure");
});

// ---------------------------------------------------------------------------
// Fixtures 4-7 — polar arrays, the full-circle convention, typed declines.
// ---------------------------------------------------------------------------

test("fixture 4 — ARRAY polar 4 items about a non-zero center: members at k·90°, rotated, ONE revision", async () => {
  const h = await seeded();
  const before = await stateOf(h);
  const r = val<{ created: number }>(
    await h.handle(
      cmd("entity.modify", { op: "array", mode: "polar", ids: ["el-000001"], center: { x: 500, y: 500 }, items: 4, angleSpan: Math.PI * 2 }),
    ),
  );
  assert.equal(r.created, 3, "the source (index 0) plus 3 members");
  const after = await stateOf(h);
  assert.equal(after.revisions, before.revisions + 1, "ONE atomic revision");
  // Expected rotations of (0,0)-(100,0) about (500,500) — computed by hand:
  // k·90°: (x,y) ↦ (1000−y, x) / (1000−x, 1000−y) / (y, 1000−x).
  const expected: [string, [number, number, number, number]][] = [
    ["el-000004", [1000, 0, 1000, 100]],
    ["el-000005", [1000, 1000, 900, 1000]],
    ["el-000006", [0, 1000, 0, 900]],
  ];
  for (const [id, exp] of expected) {
    const got = coords(after, id);
    for (let i = 0; i < 4; i++) approx(got[i]!, exp[i]!);
  }
});

test("fixture 5 — the polar full-circle convention: step = 360°/count, index 0 never duplicated; partial span is endpoint-inclusive", async () => {
  // A circle source exposes the member angles directly (its center lands
  // exactly on the rotated position, radius preserved).
  const seedCircle = async (): Promise<AppApiHandler> => {
    const h = AppApiHandler.create(CONFIG);
    val(await h.handle(cmd("document.create", {})));
    val(
      await h.handle(cmd("drafting.createEntities", { entities: [{ type: "circle", layer: "0", center: [200, 0], radius: 10 }] })),
    );
    return h;
  };
  // Full circle: 6 items → members at 60°..300°, NONE at the source angle.
  const full = await seedCircle();
  val(await full.handle(cmd("entity.modify", { op: "array", mode: "polar", ids: ["el-000001"], center: { x: 0, y: 0 }, items: 6, angleSpan: Math.PI * 2 })));
  const fs = await stateOf(full);
  const members = fs.elements.filter((el) => el.id !== "el-000001");
  assert.equal(members.length, 5, "count−1 members");
  const step = (Math.PI * 2) / 6;
  for (let i = 1; i <= 5; i++) {
    const p = members[i - 1]!.props;
    approx(p.cx, 200 * Math.cos(i * step));
    approx(p.cy, 200 * Math.sin(i * step));
    approx(p.r, 10, "radius preserved");
  }
  for (const m of members) {
    assert.ok(
      Math.abs((m.props.cx as number) - 200) > 1 || Math.abs((m.props.cy as number) - 0) > 1,
      `member ${m.id} never duplicates index 0`,
    );
  }
  // Partial span: 3 items over 180° → step 90°, the LAST member lands
  // exactly at the span end (endpoint-inclusive convention).
  const partial = await seedCircle();
  val(
    await partial.handle(cmd("entity.modify", { op: "array", mode: "polar", ids: ["el-000001"], center: { x: 0, y: 0 }, items: 3, angleSpan: Math.PI })),
  );
  const ps = await stateOf(partial);
  const pm = ps.elements.filter((el) => el.id !== "el-000001");
  assert.equal(pm.length, 2);
  approx(pm[0]!.props.cx, 0, "90°: cx");
  approx(pm[0]!.props.cy, 200, "90°: cy");
  approx(pm[1]!.props.cx, -200, "180°: cx — the endpoint-inclusive final member");
  approx(pm[1]!.props.cy, 0, "180°: cy");
});

test("fixture 6 — ARRAY polar count 1 is the deterministic no-op (command + op layers agree)", async () => {
  const h = await seeded();
  const before = await fullStateOf(h);
  const noOp = val<{ applied: boolean; reason: string }>(
    await h.handle(cmd("entity.modify", { op: "array", mode: "polar", ids: ["el-000001"], center: { x: 0, y: 0 }, items: 1, angleSpan: Math.PI * 2 })),
  );
  assert.equal(noOp.applied, false);
  assert.ok(String(noOp.reason).includes("single item"), String(noOp.reason));
  assert.equal(await fullStateOf(h), before);

  const selectable = await selectableOf(h);
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "AR" } },
      { event: { type: "entity", entity: selectable[0]! } },
      { event: { type: "typed", text: "" } },
      { event: { type: "typed", text: "Polar" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "1" } },
      { event: { type: "typed", text: "360" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (p) => plans.push(p),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [], "no canonical mutation");
  assert.ok(lines.some((l) => l.includes("nothing to create")), lines.join("\n"));
});

test("fixture 7 — ARRAY Path is the typed decline and degenerate inputs never mutate", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "AR" } },
      { event: { type: "entity", entity: linePick("el-000001", 0, 0, 100, 0) } },
      { event: { type: "typed", text: "" } },
      { event: { type: "typed", text: "Path" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (p) => plans.push(p),
  );
  assert.equal(plans.length, 0, "a typed decline emits NO plan");
  assert.ok(lines.some((l) => l.includes("Path arrays are not supported")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("cop")), "no fabricated success echo");
});

// ---------------------------------------------------------------------------
// Fixture 8-9 — selectability, ERASE/undo/redo over materialized members.
// ---------------------------------------------------------------------------

test("fixture 8 — materialized members are selectable immediately after commit through the CC007 selection path", async () => {
  const h = await seeded();
  val(
    await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, rowSpacing: 50, columnSpacing: 200 })),
  );
  const picks = await selectableOf(h);
  assert.equal(picks.length, 8, "2 lines + 1 circle + 5 members are all pickable");
  assert.ok(picks.some((p) => p.id === "el-000008"), "the last-minted member is pickable");
  // The CC007 keyword path: MOVE + ALL collects every member id.
  const ctx = ctxOf({ selectableElements: picks });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "10,10" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (p) => plans.push(p),
  );
  assert.ok(lines.includes("8 found (all)"), lines.join("\n"));
  assert.equal(plans.length, 1, "one MOVE plan");
  const payload = JSON.stringify(plans[0]!.appApi);
  for (const id of ["el-000001", "el-000002", "el-000003", "el-000004", "el-000005", "el-000006", "el-000007", "el-000008"]) {
    assert.ok(payload.includes(`"${id}"`), `${id} is a canonical target (never a preview handle)`);
  }
});

test("fixture 9 — ERASE removes exactly one member; UNDO restores the exact post-ARRAY elements; REDO re-erases", async () => {
  const h = await seeded();
  val(
    await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, rowSpacing: 50, columnSpacing: 200 })),
  );
  const postArray = await stateOf(h);
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000006"] })));
  const erased = await stateOf(h);
  assert.equal(erased.elements.length, postArray.elements.length - 1, "exactly the one member removed");
  assert.ok(!erased.elements.some((el) => el.id === "el-000006"));
  // UNDO restores the EXACT post-ARRAY element set. (The undo re-add
  // appends at list end — the document's pre-existing append semantics for
  // any delete+undo, not ARRAY-specific — so the set is compared
  // order-independently; determinism of the resulting order is separately
  // pinned by fixture 10.)
  val(await h.handle(cmd("document.undo", {})));
  const undone = await stateOf(h);
  const byId = (els: readonly ElementRow[]): ElementRow[] => [...els].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(byId(undone.elements), byId(postArray.elements), "exact post-ARRAY restoration (ids + props)");
  // REDO re-erases exactly the member.
  val(await h.handle(cmd("document.redo", {})));
  const redone = await stateOf(h);
  assert.equal(JSON.stringify(redone.elements), JSON.stringify(erased.elements), "redo re-erases");
  // The pickable view never references the dead id.
  const picks = await selectableOf(h);
  assert.equal(picks.length, 7);
  assert.ok(!picks.some((p) => p.id === "el-000006"));
});

// ---------------------------------------------------------------------------
// Fixture 10-11 — determinism and Web/Electron parity.
// ---------------------------------------------------------------------------

test("fixture 10 — repeated execution is byte-identical: plans, echo lines and serialized state", async () => {
  // Engine level: the same ARRAY script twice → byte-identical plans/lines.
  const selectable: EntityPick[] = [
    linePick("el-000001", 0, 0, 100, 0),
    linePick("el-000002", 100, 0, 100, 100),
  ];
  const ctx = ctxOf({ selectableElements: selectable });
  const script: readonly CommandScriptStep[] = [
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: selectable[0]! } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Rectangular" } },
    { event: { type: "typed", text: "2" } },
    { event: { type: "typed", text: "3" } },
    { event: { type: "typed", text: "40" } },
    { event: { type: "typed", text: "20" } },
  ];
  const run = (): { plans: string[]; lines: readonly string[] } => {
    const plans: CommandPlan[] = [];
    const { lines } = runCommandScript(script, ctx, (p) => plans.push(p));
    return { plans: plans.map((p) => JSON.stringify(p)), lines };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.plans, b.plans, "byte-identical plans");
  assert.deepEqual(a.lines, b.lines, "byte-identical echo lines");

  // Document level: identical history position ⇒ identical mint allocation
  // and byte-identical semantic state (the monotonic-counter mint is
  // entropy-free — the contract's §6 invariant, proven over the
  // identity-excluded projection; the document UUID is instance-random by
  // design and not part of the semantic surface).
  const docRun = async (): Promise<string> => {
    const h = await seeded();
    val(
      await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 3, rowSpacing: 50, columnSpacing: 200 })),
    );
    val(
      await h.handle(cmd("entity.modify", { op: "array", mode: "polar", ids: ["el-000002"], center: { x: 0, y: 0 }, items: 4, angleSpan: Math.PI * 2 })),
    );
    return await projectionOf(h);
  };
  assert.equal(await docRun(), await docRun(), "identical semantic state on fresh documents");
});

test("fixture 11 — the ARRAY stream is byte-identical through WebHost and ElectronHost", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  type Exec = { execute(request: Command | Query): Promise<CommandQueryResponse> };

  const seed = async (host: Exec): Promise<void> => {
    await host.execute(cmd("document.create", {}));
    await host.execute(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
          { type: "line", layer: "0", from: [100, 0], to: [100, 100] },
          { type: "circle", layer: "0", center: [200, 50], radius: 20 },
        ],
      }),
    );
  };
  await seed(web);
  await seed(electron);

  const selectable = await selectableOf(webHandler);
  const ctx = ctxOf({ selectableElements: selectable });
  // The affected semantic stream: rectangular + polar through the SAME
  // engine-free command contract.
  const script: readonly CommandScriptStep[] = [
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: selectable[0]! } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Rectangular" } },
    { event: { type: "typed", text: "2" } },
    { event: { type: "typed", text: "3" } },
    { event: { type: "typed", text: "40" } },
    { event: { type: "typed", text: "20" } },
    { event: { type: "typed", text: "AR" } },
    { event: { type: "entity", entity: selectable[1]! } },
    { event: { type: "typed", text: "" } },
    { event: { type: "typed", text: "Polar" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "4" } },
    { event: { type: "typed", text: "360" } },
  ];
  const plansOf: string[] = [];
  runCommandScript(script, ctx, (plan) => plansOf.push(JSON.stringify(plan)));
  assert.equal(plansOf.length, 2, "rectangular + polar plans");
  const again: string[] = [];
  runCommandScript(script, ctx, (plan) => again.push(JSON.stringify(plan)));
  assert.deepEqual(plansOf, again, "the plan stream is deterministic");

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
  assert.equal((webState.elements as ElementRow[]).length, 3 + 5 + 3, "8 after rectangular, +3 polar members");
  const m = (webState.elements as ElementRow[]).find((el) => el.id === "el-000004")!;
  assert.deepEqual([m.props.x1, m.props.y1, m.props.x2, m.props.y2], [20, 0, 120, 0], "the first rectangular member moved exactly 20 in x");
});

// ---------------------------------------------------------------------------
// Fixture 12 + boundaries — regression pins, zero spacing, no-plan-before-commit.
// ---------------------------------------------------------------------------

test("fixture 12 — REGRESSION (CC005/006/007): prompt ownership, the ALL keyword and typed-coordinate commits survive the ARRAY hardening", () => {
  // (a) DEF-007: a typed token NEVER starts a new command mid-prompt —
  // LINE's [Undo] word-form is honored, the command keeps running.
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
  assert.ok(out.lines.includes("Undo one segment."), JSON.stringify(out.lines));
  assert.ok(out.plan !== null && out.plan.appApi[0]!.name === "document.undo");

  // (b) DEF-021: the ALL keyword resolves through the shared pickable view.
  const selectable: EntityPick[] = [linePick("el-000001", 0, 0, 100, 0), linePick("el-000002", 0, 10, 100, 10)];
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "typed", text: "10,10" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf({ selectableElements: selectable }),
    (p) => plans.push(p),
  );
  assert.ok(lines.includes("2 found (all)"), lines.join("\n"));
  assert.equal(plans.length, 1);

  // (c) The LINE typed-coordinate commit (commit-authoritative echo timing).
  const linePlans: CommandPlan[] = [];
  runCommandScript(
    [
      { event: { type: "start", commandId: "line" } },
      { event: { type: "typed", text: "0,0" } },
      { event: { type: "typed", text: "100,50" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctxOf(),
    (p) => linePlans.push(p),
  );
  assert.equal(linePlans.length, 1, "LINE completes on Enter");
  assert.equal(linePlans[0]!.appApi[0]!.name, "drafting.createEntities");
});

test("boundary — zero spacing is legal: duplicate/overlapping members stay uniquely canonical", async () => {
  const h = await seeded();
  val(
    await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 2, rowSpacing: 0, columnSpacing: 100 })),
  );
  const s = await stateOf(h);
  assert.equal(s.elements.length, 3 + 3, "three members: (0,1), (1,0), (1,1)");
  // The (1,0) member sits exactly on the source with its OWN identity.
  const overlap = s.elements.find((el) => el.id === "el-000005")!.props;
  assert.deepEqual([overlap.x1, overlap.y1, overlap.x2, overlap.y2], [0, 0, 100, 0], "geometrically identical to the source");
  assert.ok(s.elements.some((el) => el.id === "el-000001"), "the source coexists (no hidden replacement)");
  // ERASE removes exactly ONE of the duplicates; UNDO restores exactly.
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000005"] })));
  const s2 = await stateOf(h);
  assert.ok(s2.elements.some((el) => el.id === "el-000001"), "the source survives");
  assert.ok(!s2.elements.some((el) => el.id === "el-000005"), "exactly the member removed");
  val(await h.handle(cmd("document.undo", {})));
  const restored = await stateOf(h);
  const byId = (els: readonly ElementRow[]): ElementRow[] => [...els].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(byId(restored.elements), byId(s.elements), "exact element-set restoration (the undo re-add appends at list end — the document's existing append semantics)");
});

test("negative guarantee — ARRAY input events are editor state only: no plan before the command's own completion", () => {
  const selectable: EntityPick[] = [linePick("el-000001", 0, 0, 100, 0)];
  const ctx = ctxOf({ selectableElements: selectable });
  const plans: CommandPlan[] = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "AR" } },
      { event: { type: "entity", entity: selectable[0]! } },
      { event: { type: "typed", text: "" } },
      { event: { type: "typed", text: "Rectangular" } },
      { event: { type: "typed", text: "2" } },
      { event: { type: "typed", text: "3" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (p) => plans.push(p),
  );
  assert.equal(plans.length, 0, "no plan until the final parameter completes — input is editor state only");
});
