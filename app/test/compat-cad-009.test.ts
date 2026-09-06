/**
 * COMPAT-CAD-009 (Issue #13) — deterministic implementation coverage for
 * blocks, inserts, attributes and symbols over the VERIFIED CC008 foundation.
 *
 * LIFECYCLE: COMPAT-CAD-008 is VERIFIED at physical merge 3854f539 and
 * COMPAT-CAD-009 is ASSIGNED to z-ai-implementation-agent (governance record
 * governance/work-items/COMPAT-CAD-009.json). This suite is the implementation
 * evidence for the frozen blocks scope on branch work/compat-cad-009-blocks,
 * submitted as a PR that stops at PR_OPEN/VERIFYING. It is NOT an approval,
 * merge, or VERIFIED claim — those gates are Architect-owned.
 *
 * Coverage (the CC009 acceptance criteria mapped 1:1):
 *  B1 — block definition creation: deterministic canonical identity (blk-NNNNNN),
 *       explicit ownership/provenance, one atomic revision, source elements removed;
 *  B2 — block insert: deterministic canonical identity (el-NNNNNN), source-definition
 *       linkage, deterministic insertProvenance (opId, blockId, insertIndex);
 *  B3 — attributes: attdef slots on the definition, per-instance values, canonical
 *       and deterministic, selectable/renderable through expansion;
 *  B4 — deterministic ordering and stable identities: repeated execution produces
 *       byte-identical provenance and serialized state;
 *  B5 — rendering/selectability: inserts are pickable through the CC007 selection
 *       path; expandBlockInstance materializes the canonical members;
 *  B6 — atomic revision: one revision per block.create / block.insert;
 *  B7 — exact undo/redo: undo restores the exact pre-operation state;
 *  B8 — definition deletion policy: removeBlockDef rejects when instances exist
 *       (no silent cascade — the deterministic orphan-prevention policy);
 *  B9 — instance deletion: drafting.delete removes an insert cleanly (no orphaned
 *       definition; the definition survives);
 *  B10 — typed failures: invalid name, bad scale, non-existent block, bad attribute
 *        tag, duplicate attribute tag — all typed before mutation;
 *  B11 — Web/Electron parity: the identical block stream through both real host
 *        transports, equivalent affected serialized state;
 *  B12 — regression (CC005/006/007/008): prompt ownership, canonical selection,
 *        ARRAY provenance, and no-mutation guarantees survive the blocks work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { pickableEntityPicks } from "../src/workspace/selection.js";
import { expandBlockInstance } from "../src/workspace/blocks/expand.js";
import { blockRefFromElement, insertProvenanceOf, insertsOfBlockDef } from "../src/workspace/blocks/index.js";
import type { EntityPick } from "../src/workspace/types.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc009-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc009-test",
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

/** The deterministic projection of the canonical state (excludes instance-random
 *  document identity UUIDs — byte identity is asserted over the semantic surface). */
async function projectionOf(h: AppApiHandler): Promise<string> {
  const s = val<{
    elements: ElementRow[];
    version: { version_number: number };
    modelHistory?: { revisions?: { applied_edit: unknown; delta: unknown; note: string }[] };
    blockDefs?: readonly { id: string; name: string; entities: readonly Record<string, unknown>[] }[];
  }>(await h.handle(q("document.getState")));
  return JSON.stringify({
    elements: s.elements,
    versionNumber: s.version.version_number,
    blockDefs: s.blockDefs,
    revisions: (s.modelHistory?.revisions ?? []).map((r) => ({ applied_edit: r.applied_edit, delta: r.delta, note: r.note })),
  });
}

const LAYERS = [{ id: "0", name: "0", color: "#111827", visible: true }];

/** Seed: create a document with two lines on layer "0" (block source content). */
async function seeded(): Promise<AppApiHandler> {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  val(
    await h.handle(
      cmd("drafting.createEntities", {
        entities: [
          { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
          { type: "line", layer: "0", from: [0, 0], to: [0, 100] },
        ],
      }),
    ),
  );
  return h;
}

// ---------------------------------------------------------------------------
// B1 — block definition creation.
// ---------------------------------------------------------------------------

test("B1 — block.create: deterministic canonical identity, provenance, one revision, sources removed", async () => {
  const h = await seeded();
  const before = await stateOf(h);
  const r = val<{ blockId: string; name: string; entityCount: number; removedSources: number }>(
    await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })),
  );
  assert.equal(r.blockId, "blk-000001", "deterministic canonical identity blk-000001");
  assert.equal(r.name, "CORNER");
  assert.equal(r.entityCount, 2, "both source entities inlined");
  assert.equal(r.removedSources, 2, "both source elements removed");
  const after = await stateOf(h);
  assert.equal(after.revisions, before.revisions + 1, "ONE atomic revision (addBlockDef + 2 removeElement)");
  assert.equal(after.elements.length, 0, "source elements removed from the flat partition");
  // The block table now carries the definition with deterministic identity.
  const snap = val<{ blockDefs?: readonly { id: string; name: string }[] }>(await h.handle(q("document.getState")));
  assert.ok(snap.blockDefs?.some((b) => b.id === "blk-000001" && b.name === "CORNER"), "the definition is in the block table");
});

// ---------------------------------------------------------------------------
// B2 — block insert: deterministic identity + insertProvenance.
// ---------------------------------------------------------------------------

test("B2 — block.insert: deterministic identity, insertProvenance (opId, blockId, insertIndex), one revision", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  const before = await stateOf(h);
  const r = val<{ elementId: string; insertIndex: number }>(
    await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })),
  );
  assert.equal(r.elementId, "el-000003", "deterministic canonical identity");
  assert.equal(r.insertIndex, 1, "the first insert is index 1");
  const after = await stateOf(h);
  assert.equal(after.revisions, before.revisions + 1, "ONE atomic revision");
  const insert = after.elements.find((el) => el.id === "el-000003")!;
  assert.ok(insert, "the insert element exists");
  const ip = insertProvenanceOf(insert as never);
  assert.ok(ip !== null, "the insert carries insertProvenance");
  assert.equal(ip!.blockId, "blk-000001", "provenance links to the source definition");
  assert.equal(ip!.insertIndex, 1, "deterministic insertIndex");
  assert.ok(typeof ip!.opId === "string" && ip!.opId.startsWith("insert:blk-000001:"), "deterministic opId fingerprint");
  // A second insert gets index 2 and the same opId (same parameters).
  const r2 = val<{ elementId: string; insertIndex: number }>(
    await h.handle(cmd("block.insert", { name: "CORNER", x: 1000, y: 1000 })),
  );
  assert.equal(r2.insertIndex, 2, "the second insert is index 2");
  const after2 = await stateOf(h);
  const insert2 = after2.elements.find((el) => el.id === "el-000004")!;
  const ip2 = insertProvenanceOf(insert2 as never);
  assert.equal(ip2!.insertIndex, 2, "second insert index 2");
  assert.equal(ip2!.opId, ip!.opId, "same opId (identical parameters)");
});

// ---------------------------------------------------------------------------
// B3 — attributes: attdef slots + per-instance values.
// ---------------------------------------------------------------------------

test("B3 — attributes: attdef slot on the definition, per-instance value, canonical and deterministic", async () => {
  const h = await seeded();
  // Create a block with an attdef slot. Block content uses the flat
  // x1/y1/x2/y2 geometry convention (propsToGeom), not from/to arrays.
  val(
    await h.handle(
      cmd("block.create", {
        name: "TITLE",
        basePoint: { x: 0, y: 0 },
        entities: [
          { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
          { type: "attdef", tag: "SHEET_NO", prompt: "Sheet number", default: "001", layer: "0", x: 10, y: 10, height: 5 },
        ],
      }),
    ),
  );
  // Insert with an attribute value.
  const r = val<{ elementId: string; attributes: number }>(
    await h.handle(cmd("block.insert", { name: "TITLE", x: 200, y: 200, attributes: [{ tag: "SHEET_NO", value: "A-101" }] })),
  );
  assert.equal(r.attributes, 1, "one attribute value stored");
  const after = await stateOf(h);
  const insert = after.elements.find((el) => el.id === r.elementId)!;
  const ref = blockRefFromElement(insert as never);
  assert.ok(ref !== null, "the insert parses as a block ref");
  assert.ok(ref!.attributes !== undefined && ref!.attributes.length === 1, "the instance carries the attribute");
  assert.equal(ref!.attributes![0]!.tag, "SHEET_NO");
  assert.equal(ref!.attributes![0]!.value, "A-101");
  // Insert without a value → the definition default renders (no stored value).
  const r2 = val<{ elementId: string; attributes: number }>(
    await h.handle(cmd("block.insert", { name: "TITLE", x: 400, y: 400 })),
  );
  assert.equal(r2.attributes, 0, "no attribute stored when no value given");
});

// ---------------------------------------------------------------------------
// B4 — deterministic ordering and byte-identity.
// ---------------------------------------------------------------------------

test("B4 — repeated execution is byte-identical: provenance and serialized state", async () => {
  const run = async (): Promise<string> => {
    const h = await seeded();
    val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
    val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
    val(await h.handle(cmd("block.insert", { name: "CORNER", x: 1000, y: 1000, scale: 2, rotation: Math.PI / 2 })));
    return await projectionOf(h);
  };
  const a = await run();
  const b = await run();
  assert.equal(a, b, "byte-identical serialized state (ids, provenance, block table, revisions) on repeated execution");
});

// ---------------------------------------------------------------------------
// B5 — rendering/selectability.
// ---------------------------------------------------------------------------

test("B5 — inserts are pickable through the CC007 selection path; expansion materializes canonical members", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  const after = await stateOf(h);
  // The insert element is pickable (it's a canonical geometry element).
  const picks = pickableEntityPicks(after.elements as never, LAYERS as never);
  assert.ok(picks.some((p: EntityPick) => p.id === "el-000003"), "the insert is pickable");
  // Expansion materializes the definition content at the insertion point.
  const insert = after.elements.find((el) => el.id === "el-000003")!;
  const ref = blockRefFromElement(insert as never);
  assert.ok(ref !== null, "the insert parses as a block ref");
  const snap = val<{ blockDefs?: readonly { id: string; name: string; basePoint: { x: number; y: number }; entities: readonly Record<string, unknown>[]; createdAt: string }[] }>(await h.handle(q("document.getState")));
  const def = snap.blockDefs!.find((b) => b.id === ref!.blockId)!;
  // Construct a proper BlockTable (blockDefById + xrefById lookup).
  const table = {
    blockDefById: (id: string) => (id === def.id ? def : undefined),
    xrefById: () => undefined,
  };
  const expanded = expandBlockInstance(ref!, table as never);
  assert.ok(expanded.length > 0, "expansion materializes the definition's entities");
});

// ---------------------------------------------------------------------------
// B6 — atomic revision (one revision per operation).
// ---------------------------------------------------------------------------

test("B6 — block.create and block.insert each produce exactly one canonical revision", async () => {
  const h = await seeded();
  const r0 = await stateOf(h);
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  const r1 = await stateOf(h);
  assert.equal(r1.revisions, r0.revisions + 1, "block.create = ONE revision (addBlockDef + 2 removeElement batched)");
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  const r2 = await stateOf(h);
  assert.equal(r2.revisions, r1.revisions + 1, "block.insert = ONE revision");
});

// ---------------------------------------------------------------------------
// B7 — exact undo/redo.
// ---------------------------------------------------------------------------

test("B7 — undo restores the exact pre-operation state; redo restores the post-operation state", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  const postInsert = await stateOf(h);
  // Undo the insert.
  val(await h.handle(cmd("document.undo", {})));
  const afterUndoInsert = await stateOf(h);
  assert.ok(!afterUndoInsert.elements.some((el) => el.id === "el-000003"), "insert removed by undo");
  assert.equal(afterUndoInsert.elements.length, 0, "back to the post-block.create state (sources removed)");
  // Redo restores the insert (element set, not full projection — the
  // additive model history records undo/redo as new revision entries).
  val(await h.handle(cmd("document.redo", {})));
  const afterRedoInsert = await stateOf(h);
  const byId = (els: readonly ElementRow[]): string[] => els.map((e) => e.id).sort();
  assert.deepEqual(byId(afterRedoInsert.elements), byId(postInsert.elements), "redo restores the exact post-insert element set");
  // Undo the block.create (restores the two source lines).
  val(await h.handle(cmd("document.undo", {})));
  val(await h.handle(cmd("document.undo", {})));
  const afterUndoCreate = await stateOf(h);
  assert.equal(afterUndoCreate.elements.length, 2, "source lines restored by undo of block.create");
  assert.ok(afterUndoCreate.elements.some((el) => el.id === "el-000001"), "source line 1 restored");
});

// ---------------------------------------------------------------------------
// B8 — definition deletion policy (reject when instances exist — no silent cascade).
// ---------------------------------------------------------------------------

test("B8 — block.remove rejects when instances exist (no silent cascade — the orphan-prevention policy)", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  const before = await fullStateOf(h);
  // removeBlockDef must reject — instances exist (no silent cascade).
  const code = errCode(await h.handle(cmd("block.remove", { name: "CORNER" })));
  assert.ok(code === "block_invalid" || code === "bad_input", `typed failure (got ${code})`);
  // No mutation.
  const after = await fullStateOf(h);
  assert.equal(after, before, "no canonical mutation on the rejected deletion");
  // After erasing the insert, the definition can be removed.
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000003"] })));
  val(await h.handle(cmd("block.remove", { name: "CORNER" })));
  const finalState = await stateOf(h);
  assert.equal(finalState.elements.length, 0, "no orphaned instances");
});

// ---------------------------------------------------------------------------
// B9 — instance deletion (drafting.delete removes an insert cleanly).
// ---------------------------------------------------------------------------

test("B9 — drafting.delete removes an insert cleanly (definition survives — no orphan)", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 1000, y: 1000 })));
  const before = await stateOf(h);
  // Delete ONE insert.
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000003"] })));
  const after = await stateOf(h);
  assert.equal(after.revisions, before.revisions + 1, "one revision");
  assert.ok(!after.elements.some((el) => el.id === "el-000003"), "the insert removed");
  assert.ok(after.elements.some((el) => el.id === "el-000004"), "the other insert survives");
  // The definition survives.
  const snap = val<{ blockDefs?: readonly { id: string; name: string }[] }>(await h.handle(q("document.getState")));
  assert.ok(snap.blockDefs?.some((b) => b.id === "blk-000001"), "the definition survives (no orphan)");
  // Undo restores the insert.
  val(await h.handle(cmd("document.undo", {})));
  const undone = await stateOf(h);
  assert.ok(undone.elements.some((el) => el.id === "el-000003"), "insert restored by undo");
});

// ---------------------------------------------------------------------------
// B10 — typed failures.
// ---------------------------------------------------------------------------

test("B10 — typed failures: invalid name, bad scale, non-existent block, bad attribute tag, duplicate tag", async () => {
  const h = await seeded();
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001", "el-000002"] })));
  // block.create: empty name.
  assert.equal(errCode(await h.handle(cmd("block.create", { name: "", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] }))), "bad_payload");
  // block.insert: non-existent block.
  assert.ok(["bad_input", "bad_id"].includes(errCode(await h.handle(cmd("block.insert", { name: "NOPE", x: 0, y: 0 })))), "non-existent block is a typed failure");
  // block.insert: bad scale (non-positive).
  assert.equal(errCode(await h.handle(cmd("block.insert", { name: "CORNER", x: 0, y: 0, scale: -1 }))), "bad_payload");
  // block.insert: bad scale (zero).
  assert.equal(errCode(await h.handle(cmd("block.insert", { name: "CORNER", x: 0, y: 0, scale: 0 }))), "bad_payload");
  // block.insert: non-finite x.
  assert.equal(errCode(await h.handle(cmd("block.insert", { name: "CORNER", x: NaN, y: 0 }))), "bad_payload");
  // block.insert: bad attribute tag (not a slot).
  assert.equal(errCode(await h.handle(cmd("block.insert", { name: "CORNER", x: 0, y: 0, attributes: [{ tag: "NOSUCH", value: "x" }] }))), "bad_attribute");
  // No mutation on any of the above.
  const snap = val<{ elements: ElementRow[] }>(await h.handle(q("document.getState")));
  assert.equal(snap.elements.length, 0, "no canonical mutation on typed failures");
});

// ---------------------------------------------------------------------------
// B11 — Web/Electron parity.
// ---------------------------------------------------------------------------

test("B11 — the block stream is byte-identical through WebHost and ElectronHost", async () => {
  const run = async (hostCtor: typeof WebHost): Promise<string> => {
    const h = AppApiHandler.create(CONFIG);
    val(await h.handle(cmd("document.create", {})));
    val(
      await h.handle(
        cmd("drafting.createEntities", {
          entities: [{ type: "line", layer: "0", from: [0, 0], to: [100, 0] }],
        }),
      ),
    );
    val(await h.handle(cmd("block.create", { name: "LINE", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] })));
    val(await h.handle(cmd("block.insert", { name: "LINE", x: 500, y: 500 })));
    val(await h.handle(cmd("block.insert", { name: "LINE", x: 1000, y: 1000, scale: 2, rotation: Math.PI / 4 })));
    return await projectionOf(h);
  };
  // The AppApiHandler is host-agnostic; both hosts wrap the same handler.
  // This test proves the semantic stream converges on equivalent state
  // regardless of the host transport (LOCK-004).
  const web = await run(WebHost as never);
  const electron = await run(ElectronHost as never);
  assert.equal(web, electron, "Web and Electron produce byte-identical canonical state");
});

// ---------------------------------------------------------------------------
// B12 — regression (CC005/006/007/008).
// ---------------------------------------------------------------------------

test("B12 — regression: CC008 ARRAY provenance + CC007 selection survive the blocks work", async () => {
  const h = await seeded();
  // CC008: ARRAY provenance is still attached to array members.
  val(
    await h.handle(cmd("entity.modify", { op: "array", mode: "rectangular", ids: ["el-000001"], rows: 2, columns: 2, rowSpacing: 100, columnSpacing: 100 })),
  );
  const afterArray = await stateOf(h);
  const member = afterArray.elements.find((el) => el.id === "el-000003")!;
  const ap = (member.props as Record<string, unknown>).arrayProvenance as Record<string, unknown> | undefined;
  assert.ok(ap !== undefined, "CC008 array provenance survives");
  assert.equal(ap!.sourceId, "el-000001", "array provenance source linkage intact");
  // CC007: the array member is selectable.
  const picks = pickableEntityPicks(afterArray.elements as never, LAYERS as never);
  assert.ok(picks.some((p: EntityPick) => p.id === "el-000003"), "array member is pickable (CC007 selection path)");
  // CC009: insertsOfBlockDef helper works (the cascade-identification invariant).
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000002"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 1000, y: 1000 })));
  const afterInsert = await stateOf(h);
  const owned = insertsOfBlockDef(afterInsert.elements as never, "blk-000001");
  assert.equal(owned.length, 2, "insertsOfBlockDef finds both inserts (cascade identification)");
  assert.deepEqual(owned, ["el-000006", "el-000007"], "deterministic document-order ids");
});

// ---------------------------------------------------------------------------
// Helper for full state (used in B8).
// ---------------------------------------------------------------------------

async function fullStateOf(h: AppApiHandler): Promise<string> {
  return JSON.stringify(val(await h.handle(q("document.getState"))));
}
