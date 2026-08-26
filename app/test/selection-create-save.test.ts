/**
 * Selection, create and save commands (CAD-IMPLEMENT-001 milestone-2).
 *
 * `document.create` resets to a fresh empty document. `document.setSelection`
 * mutates the ephemeral editor selection WITHOUT bumping the version or
 * pushing an undo entry. `document.save` persists through the file adapter.
 * `document.getSelection` returns the current selection.
 *
 * Selection is orthogonal to the versioned snapshot: it is NOT in the
 * snapshot, NOT in the version-id derivation, and NOT in the parity content
 * hash — so two hosts with different selections still converge to the same
 * content hash (§5.5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "scs-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "scs-test",
};

function cmd(name: Command["name"], payload: unknown, idempotencyKey?: string): Command {
  return idempotencyKey === undefined
    ? { type: "command", name, payload }
    : { type: "command", name, payload, idempotencyKey };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}
/** Narrow a response to its Ok value, failing the test loudly on Err. */
function val<T = unknown>(r: CommandQueryResponse): T {
  if (!r.ok) throw new Error(`unexpected ErrResult: ${r.code}: ${r.message}`);
  return r.value as T;
}

const addBox = (id: string): Command =>
  cmd("document.applyEdit", {
    edit: {
      type: "addElement",
      element: { id, kind: "geometry", engineId: null, props: { shape: "box", x: 10, y: 10, w: 40, h: 30 } },
    },
  });

test("document.create resets to an empty document with a fresh entity id and cleared selection", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(addBox("e1"));
  await h.handle(cmd("document.setSelection", { ids: ["e1"] }));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["e1"]); // guard
  const before = val<{ entity_id: string }>(await h.handle(q("document.getVersion")));
  // create
  const r = await h.handle(cmd("document.create", {}));
  const snap = val<{ elements: unknown[]; version: { version_number: number } }>(r);
  assert.equal(snap.elements.length, 0, "create must clear elements");
  assert.equal(snap.version.version_number, 1, "create must reset to root version");
  const after = val<{ entity_id: string }>(await h.handle(q("document.getVersion")));
  assert.notEqual(after.entity_id, before.entity_id, "create must mint a fresh entity id");
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), [], "create must clear selection");
  assert.equal(val<boolean>(await h.handle(q("document.canUndo"))), false, "create must clear undo stack");
});

test("document.setSelection mutates selection WITHOUT bumping the version or pushing undo", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(addBox("e1"));
  const vBefore = val<{ version_id: string }>(await h.handle(q("document.getVersion")));
  // setSelection (non-versioned)
  const r = await h.handle(cmd("document.setSelection", { ids: ["e1"] }));
  assert.equal(r.ok, true);
  const vAfter = val<{ version_id: string }>(await h.handle(q("document.getVersion")));
  assert.equal(vAfter.version_id, vBefore.version_id, "setSelection must NOT bump the version");
  assert.equal(val<boolean>(await h.handle(q("document.canUndo"))), true, "undo stack unaffected by setSelection");
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["e1"]);
  // setSelection again replaces (not appends)
  await h.handle(cmd("document.setSelection", { ids: [] }));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), []);
});

test("selection is NOT in the snapshot — hosts with different selections still converge to the same content hash (§5.5)", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  await web.execute(addBox("e1"));
  await electron.execute(addBox("e1"));
  // diverge the selections
  await web.execute(cmd("document.setSelection", { ids: ["e1"] }));
  await electron.execute(cmd("document.setSelection", { ids: [] }));
  assert.notDeepEqual(
    val<string[]>(await webHandler.handle(q("document.getSelection"))),
    val<string[]>(await electronHandler.handle(q("document.getSelection"))),
    "selections must genuinely differ",
  );
  assert.equal(
    webHandler.currentContentHash(),
    electronHandler.currentContentHash(),
    "parity content hash must NOT depend on ephemeral selection",
  );
});

test("selection survives undo/redo (cleared only on open/create)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(addBox("e1"));
  await h.handle(cmd("document.setSelection", { ids: ["e1"] }));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["e1"]);
  // undo removes e1; selection persists (editor state survives undo)
  await h.handle(cmd("document.undo", {}));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["e1"], "selection survives undo");
  // redo re-adds e1; selection still persists
  await h.handle(cmd("document.redo", {}));
  assert.deepEqual(val<string[]>(await h.handle(q("document.getSelection"))), ["e1"], "selection survives redo");
});

test("document.save returns file bytes; open(save) round-trips the versioned content", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(addBox("e1"));
  await h.handle(addBox("e2"));
  const saved = val<{ bytes: number[]; format: string }>(await h.handle(cmd("document.save", {})));
  assert.ok(saved.bytes.length > 0, "save must produce non-empty bytes");
  assert.equal(saved.format, "offisos-dummy");
  // round-trip: open from the saved bytes in a second handler
  const h2 = AppApiHandler.create(CONFIG);
  const snap = val<{ elements: { id: string }[]; version: { version_id: string; version_number: number } }>(
    await h2.handle(cmd("document.open", { source: saved.bytes })),
  );
  assert.equal(snap.elements.length, 2);
  assert.deepEqual(
    snap.elements.map((e) => e.id).sort(),
    ["e1", "e2"],
    "open(save(doc)) must restore the same elements",
  );
  // The versioned content (version_id + version_number + elements) must round-trip
  // identically. The full snapshot hash differs only because open clears the
  // undo stack (editorState.canUndo flips) — that is correct, documented behavior.
  const hSnap = val<{ version: { version_id: string; version_number: number }; elements: { id: string }[] }>(
    await h.handle(q("document.getState")),
  );
  assert.equal(snap.version.version_id, hSnap.version.version_id, "version_id must round-trip");
  assert.equal(snap.version.version_number, hSnap.version.version_number, "version_number must round-trip");
  assert.deepEqual(
    snap.elements.map((e) => e.id).sort(),
    hSnap.elements.map((e) => e.id).sort(),
    "elements must round-trip",
  );
});

test("document.create honors explicit overrides (entityId/format/createdBy)", async () => {
  const h = AppApiHandler.create(CONFIG);
  const r = await h.handle(cmd("document.create", { entityId: "explicit-001", format: "custom", formatVersion: "2", createdBy: "alice" }));
  const snap = val<{ version: { entity_id: string; created_by: string }; format: string; formatVersion: string }>(r);
  assert.equal(snap.version.entity_id, "explicit-001");
  assert.equal(snap.format, "custom");
  assert.equal(snap.formatVersion, "2");
  assert.equal(snap.version.created_by, "alice");
});

test("document.setSelection rejects non-string ids", async () => {
  const h = AppApiHandler.create(CONFIG);
  const r = await h.handle(cmd("document.setSelection", { ids: ["ok", 5] as unknown as string[] }));
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "bad_payload");
});

test("create -> applyEdit -> save -> open -> edit -> undo -> redo end-to-end on the Web transport", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(handler)));
  // create a fresh doc
  await web.execute(cmd("document.create", { entityId: "e2e-doc" }));
  // add an element, select it, save
  await web.execute(addBox("b1"));
  await web.execute(cmd("document.setSelection", { ids: ["b1"] }));
  const saved = val<{ bytes: number[] }>(await web.execute(cmd("document.save", {})));
  assert.ok(saved.bytes.length > 0);
  // open the saved doc in a second handler + verify selection was NOT persisted
  const handler2 = AppApiHandler.create(CONFIG);
  const web2 = createRenderer(new WebHost(new WebSocketTransport(handler2)));
  const opened = await web2.execute(cmd("document.open", { source: saved.bytes }));
  assert.equal(opened.ok, true);
  const sel = val<string[]>(await web2.query(q("document.getSelection")));
  assert.deepEqual(sel, [], "open must clear selection (selection is ephemeral)");
  // open clears the undo stack (correct: open = fresh document context). So to
  // exercise undo/redo on the reopened doc, do a NEW edit first, then undo it.
  assert.equal(val<boolean>(await web2.query(q("document.canUndo"))), false, "open clears undo stack");
  await web2.execute(addBox("b2"));
  assert.equal(val<boolean>(await web2.query(q("document.canUndo"))), true, "edit after open pushes undo");
  const u = await web2.execute(cmd("document.undo", {}));
  assert.equal(u.ok, true, "undo after a post-open edit must succeed");
  assert.equal(val<boolean>(await web2.query(q("document.canRedo"))), true);
  const r = await web2.execute(cmd("document.redo", {}));
  assert.equal(r.ok, true, "redo must succeed");
});
