/**
 * CAD-PARITY-010 deterministic boolean-solid tests (Issue #93) — the
 * engine-neutral boolean core (the triad composition over the descriptor
 * vocabulary, the operand provenance, the adapter-code → typed-decline
 * mapping) and the App API command surface on the reference engine:
 *
 *  - UNION of disjoint boxes (the reference exactness class): ONE atomic
 *    applyEdits revision (the operands removed, the result persisted with
 *    the engine result + the operand provenance), exact undo/redo (the
 *    operands restored byte-identically), replay integrity.
 *  - SUBTRACT (the first minus the second) and INTERSECT (cell ∩ cell) with
 *    exact reference volumes/bboxes through the persisted meshBBox.
 *  - The typed declines: bad payloads (op/elementIds shapes), the
 *    same-element-twice boolean_operand decline, the non-solid operand, the
 *    unknown element, and boolean_empty (a disjoint intersection — the
 *    engine_empty_result mapping; never a fabricated empty solid).
 *  - The PARITY ANCHOR: the full boolean command stream run twice through
 *    two fresh handlers produces byte-identical snapshots (the LOCK-004
 *    determinism evidence, the P009 precedent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppApiHandler } from "../src/app-api/index.js";
import { canonicalStringify, serialize } from "../src/caddocument/serialization.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import {
  BOOLEAN_OPS,
  booleanDescriptor,
  booleanFailureCode,
  booleanProvenance,
  parseBooleanOp,
} from "../src/workspace/model3d/index.js";
import type { GeometryDescriptor } from "../src/contracts/geometry.js";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cp10-booleans",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "cad-parity-010-tests",
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

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The P009 comparison basis: the canonical snapshot minus the ephemeral
 *  editorState (history/version bookkeeping legitimately differs across
 *  undo/save boundaries; the MODEL state must not). */
function modelStateHash(snap: unknown): string {
  const parsed = JSON.parse(serialize(snap as never)) as Record<string, unknown>;
  delete parsed.editorState;
  return canonicalStringify(parsed);
}

// ---------------------------------------------------------------------------
// The engine-free core.
// ---------------------------------------------------------------------------

test("the boolean triad composes the descriptor vocabulary exactly", () => {
  const box: GeometryDescriptor = { shape: "box", width: 1, depth: 1, height: 1 };
  const cyl: GeometryDescriptor = { shape: "cylinder", radius: 1, height: 2 };
  assert.deepEqual(booleanDescriptor("union", box, cyl), { shape: "fuse", a: box, b: cyl });
  assert.deepEqual(booleanDescriptor("difference", box, cyl), { shape: "cut", a: box, b: cyl });
  assert.deepEqual(booleanDescriptor("intersection", box, cyl), { shape: "intersect", a: box, b: cyl });
  // Recursive composition nests exactly like fuse/cut always have.
  const nested = booleanDescriptor("union", booleanDescriptor("intersection", box, cyl), box);
  assert.equal(nested.shape, "fuse");
  assert.equal((nested as { a: GeometryDescriptor }).a.shape, "intersect");
});

test("parseBooleanOp accepts exactly the triad; everything else declines", () => {
  for (const op of BOOLEAN_OPS) {
    assert.equal(parseBooleanOp(op), op);
  }
  assert.equal(parseBooleanOp("fuse"), null);
  assert.equal(parseBooleanOp(""), null);
  assert.equal(parseBooleanOp("UNION"), null);
});

test("booleanProvenance records the op and the operand order deterministically", () => {
  const p = booleanProvenance("difference", [
    { elementId: "el-000001", meshToken: "ref:aaa" },
    { elementId: "el-000002", meshToken: "ref:bbb" },
  ]);
  assert.deepEqual(p, {
    op: "difference",
    operands: [
      { elementId: "el-000001", meshToken: "ref:aaa" },
      { elementId: "el-000002", meshToken: "ref:bbb" },
    ],
  });
});

test("booleanFailureCode maps the typed engine outcomes; transport codes pass through", () => {
  assert.equal(booleanFailureCode("engine_empty_result"), "boolean_empty");
  assert.equal(booleanFailureCode("engine_non_manifold"), "boolean_invalid");
  assert.equal(booleanFailureCode("engine_malformed_input"), "boolean_invalid");
  assert.equal(booleanFailureCode("engine_unavailable"), "engine_unavailable");
  assert.equal(booleanFailureCode("engine_timeout"), "engine_timeout");
  assert.equal(booleanFailureCode("engine_error"), "engine_error");
});

// ---------------------------------------------------------------------------
// The App API surface on the reference engine.
// ---------------------------------------------------------------------------

interface SolidProps {
  readonly type: string;
  readonly shape: string;
  readonly op?: string;
  readonly operands?: readonly { elementId: string; meshToken: string }[];
  readonly meshToken: string;
  readonly meshBBox: readonly number[];
  readonly geometryEngine: { engineId: string; engineVersion: string };
}

async function solidProps(h: AppApiHandler, elementId: string): Promise<SolidProps> {
  const snap = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h, "document.getState", {}));
  const el = snap.elements.find((e) => e.id === elementId);
  assert.ok(el !== undefined, `element ${elementId} exists`);
  return el.props as unknown as SolidProps;
}

async function elementCount(h: AppApiHandler): Promise<number> {
  const snap = val<{ elements: readonly unknown[] }>(await q(h, "document.getState", {}));
  return snap.elements.length;
}

test("UNION of disjoint boxes: one atomic revision, operands consumed, provenance persisted", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [10, 0, 0] }));
  const before = await elementCount(h);
  const versionBefore = val<{ version_number: number }>(await q(h, "document.getVersion", {})).version_number;

  const u = val<{ elementId: string; op: string; operands: readonly { elementId: string }[]; meshToken: string }>(
    await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, b.elementId] }),
  );
  assert.equal(u.op, "union");
  assert.deepEqual(u.operands.map((o) => o.elementId), [a.elementId, b.elementId]);
  // ONE atomic revision: 2 operands + 1 result → 1 element net; exactly one
  // new revision.
  assert.equal(await elementCount(h), before - 1);
  const versionAfter = val<{ version_number: number }>(await q(h, "document.getVersion", {})).version_number;
  assert.equal(versionAfter, versionBefore + 1);
  // The operands are gone; the result carries the boolean provenance.
  const props = await solidProps(h, u.elementId);
  assert.equal(props.type, "model3d.solid");
  assert.equal(props.shape, "boolean");
  assert.equal(props.op, "union");
  assert.equal(props.operands!.length, 2);
  assert.equal(props.meshToken, u.meshToken);
  assert.equal(props.geometryEngine.engineId, "reference");
  // The union's persisted bbox spans BOTH disjoint boxes (the reference
  // exactness class: disjoint fuse is exact).
  const bx = props.meshBBox as readonly number[];
  assert.ok(Math.abs(bx[0]! - 0) < 1e-9);
  assert.ok(Math.abs(bx[3]! - 12) < 1e-9);
});

test("UNION undo/redo restores the operands exactly (the atomic batch inverse)", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [10, 0, 0] }));
  const beforeUnion = val<unknown>(await q(h, "document.getState", {}));
  await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, b.elementId] });

  const undo = await cmd(h, "document.undo", {});
  assert.equal(undo.ok, true);
  const afterUndo = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h, "document.getState", {}));
  assert.equal(afterUndo.elements.length, 2);
  assert.ok(afterUndo.elements.some((e) => e.id === a.elementId));
  assert.ok(afterUndo.elements.some((e) => e.id === b.elementId));
  // The operands are restored BYTE-IDENTICALLY (compared by id — the undo
  // batch re-adds them in reverse order, which is legal model state).
  const byId = (els: readonly { id: string; props: Record<string, unknown> }[]): Map<string, string> =>
    new Map(els.map((e) => [e.id, canonicalStringify(e.props)]));
  const restored = byId(afterUndo.elements);
  const original = byId((beforeUnion as { elements: readonly { id: string; props: Record<string, unknown> }[] }).elements);
  assert.deepEqual(restored, original);

  const redo = await cmd(h, "document.redo", {});
  assert.equal(redo.ok, true);
  const afterRedo = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h, "document.getState", {}));
  assert.equal(afterRedo.elements.length, 1);
  assert.equal(afterRedo.elements[0]!.props.shape, "boolean");
});

test("SUBTRACT keeps the first solid minus the second (cell exactness)", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 4, height: 4 }));
  const s = val<{ elementId: string }>(
    await cmd(h, "model3d.boolean", { op: "difference", elementIds: [a.elementId, b.elementId] }),
  );
  const props = await solidProps(h, s.elementId);
  // 4×4×4 − 1×4×4 leaves a 3×4×4 slab: x ∈ [1, 4].
  const bx = props.meshBBox as readonly number[];
  assert.ok(Math.abs(bx[0]! - 1) < 1e-9);
  assert.ok(Math.abs(bx[3]! - 4) < 1e-9);
});

test("INTERSECT produces the exact common cell (the new third boolean)", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, at: [2, 0, 0] }));
  const i = val<{ elementId: string }>(
    await cmd(h, "model3d.boolean", { op: "intersection", elementIds: [a.elementId, b.elementId] }),
  );
  const props = await solidProps(h, i.elementId);
  assert.equal(props.op, "intersection");
  // The common volume is the 2×4×4 slab x ∈ [2, 4].
  const bb = props.meshBBox as readonly number[];
  assert.ok(Math.abs(bb[0]! - 2) < 1e-9 && Math.abs(bb[3]! - 4) < 1e-9);
  assert.ok(Math.abs(bb[1]! - 0) < 1e-9 && Math.abs(bb[4]! - 4) < 1e-9);
  assert.ok(Math.abs(bb[2]! - 0) < 1e-9 && Math.abs(bb[5]! - 4) < 1e-9);
});

test("boolean chains compose: union then intersect (each step one atomic revision)", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [10, 0, 0] }));
  const u = val<{ elementId: string }>(await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, b.elementId] }));
  const c = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 8, depth: 8, height: 8, at: [2, -2, -2] }));
  const i = val<{ elementId: string }>(await cmd(h, "model3d.boolean", { op: "intersection", elementIds: [u.elementId, c.elementId] }));
  const props = await solidProps(h, i.elementId);
  // union extents x∈[0,12], y∈[0,4], z∈[0,4] ∩ box x∈[2,10], y∈[-2,6], z∈[-2,6]
  // → x∈[2,10] restricted by the union's actual material… the reference
  // intersect works on CELLS: cell [0,4]³ ∩ [2,10]×[-2,6]×[-2,6] = [2,4]×[0,4]×[0,4];
  const bx = props.meshBBox as readonly number[];
  assert.ok(Math.abs(bx[0]! - 2) < 1e-9 && Math.abs(bx[3]! - 4) < 1e-9);
  assert.equal(props.operands!.length, 2);
  assert.equal(props.operands![0]!.elementId, u.elementId);
});

test("typed declines: payloads, the same element twice, non-solids, unknown ids", async () => {
  const h = make();
  assert.equal(errCode(await cmd(h, "model3d.boolean", null)), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "fuse", elementIds: ["el-000001", "el-000002"] })), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "union", elementIds: ["el-000001"] })), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "union", elementIds: ["el-000001", "el-000002", "el-000003"] })), "bad_payload");
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1 }));
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, a.elementId] })), "boolean_operand");
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, "el-999999"] })), "bad_id");
  // A drafting entity is not a model3d solid.
  await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] });
  const snap = val<{ elements: readonly { id: string; props: Record<string, unknown> }[] }>(await q(h, "document.getState", {}));
  const line = snap.elements.find((e) => e.id !== a.elementId)!;
  assert.equal(errCode(await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, line.id] })), "boolean_operand");
});

test("boolean_empty: a disjoint intersection declines typed (never a fabricated empty solid)", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1, at: [50, 0, 0] }));
  const r = await cmd(h, "model3d.boolean", { op: "intersection", elementIds: [a.elementId, b.elementId] });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "boolean_empty");
  // The document is UNTOUCHED (both operands remain).
  assert.equal(await elementCount(h), 2);
});

test("boolean_empty: a subtraction that removes everything declines typed", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 3, depth: 3, height: 3, at: [-1, -1, -1] }));
  const r = await cmd(h, "model3d.boolean", { op: "difference", elementIds: [a.elementId, b.elementId] });
  assert.equal((r as { code: string }).code, "boolean_empty");
});

test("out-of-class booleans surface the engine's typed exactness decline", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.cylinder", { radius: 1, height: 3 }));
  // The reference engine declines cut/intersect with cylinders — the honest
  // typed failure (engine_error passes through the boolean mapping).
  const r = await cmd(h, "model3d.boolean", { op: "difference", elementIds: [a.elementId, b.elementId] });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "engine_error");
});

test("the save/open round-trip preserves the boolean solid + provenance", async () => {
  const h = make();
  const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
  const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [10, 0, 0] }));
  const u = val<{ elementId: string }>(await cmd(h, "model3d.boolean", { op: "union", elementIds: [a.elementId, b.elementId] }));
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const state = val<unknown>(await q(h, "document.getState", {}));

  const h2 = make();
  const opened = await cmd(h2, "document.open", { source: Array.from(saved.bytes) });
  assert.equal(opened.ok, true);
  const state2 = val<unknown>(await q(h2, "document.getState", {}));
  assert.equal(modelStateHash(state2), modelStateHash(state));

  const reopened = await solidProps(h2, u.elementId);
  assert.equal(reopened.shape, "boolean");
  assert.equal(reopened.op, "union");
  assert.deepEqual(reopened.operands!.map((o) => o.elementId), [a.elementId, b.elementId]);
});

test("PARITY ANCHOR: the full boolean stream twice through fresh handlers is byte-identical", async () => {
  const run = async (): Promise<string> => {
    const h = make();
    const a = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4 }));
    const b = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, at: [2, 0, 0] }));
    await cmd(h, "model3d.boolean", { op: "intersection", elementIds: [a.elementId, b.elementId] });
    const c = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 6, depth: 6, height: 6, at: [0, 0, 8] }));
    const d = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 2, height: 2, at: [1, 1, 9] }));
    const s = val<{ elementId: string }>(await cmd(h, "model3d.boolean", { op: "difference", elementIds: [c.elementId, d.elementId] }));
    const finalState = val<unknown>(await q(h, "document.getState", {}));
    return sha(JSON.stringify(finalState)) + ":" + s.elementId;
  };
  const first = await run();
  const second = await run();
  assert.equal(first, second);
  console.log(`CP10 PARITY booleans=${first.slice(0, 16)}`);
});
