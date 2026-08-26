/**
 * Deterministic historical replay (CAD-IMPLEMENT-003, LOCK-005/LOCK-006).
 *
 * Replaying the model history to revision k consumes ONLY the base plus the
 * first k revisions (information-state correct, no future leakage) and
 * reproduces the element set and content hash recorded at that revision for
 * every k — including through undo/redo transitions and across handler
 * instances.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { CADDocument, replayHistoryTo, verifiedReplay } from "../src/caddocument/index.js";
import type { ModelHistory } from "../src/contracts/model.js";
import type { Element } from "../src/contracts/caddocument.js";
import type { Command, Query } from "../src/contracts/app-api.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";

const OWNER = "replay-test";
const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "replay-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: OWNER,
};

function el(id: string, meshToken: string, engineId: string | null = null): Element {
  return { id, kind: "geometry", engineId, props: { meshToken } };
}

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}

async function okValue<T>(handler: AppApiHandler, request: Command | Query): Promise<T> {
  const response = await handler.handle(request);
  assert.equal(response.ok, true, `expected ok for ${request.name}`);
  return (response as { ok: true; value: T }).value;
}

function buildHistory(): { history: ModelHistory; states: Element[][] } {
  const doc = CADDocument.empty("replay-doc", "offisos-dummy", "1", OWNER);
  const states: Element[][] = [];
  const capture = () => states.push([...doc.snapshot().elements]);
  capture(); // revision 0 (base)
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  capture();
  doc.execute({ type: "addElement", element: el("e2", "m2", "occt") });
  capture();
  doc.execute({ type: "updateElement", elementId: "e1", patch: { meshToken: "m1b" } });
  capture();
  doc.undo();
  capture();
  doc.redo();
  capture();
  doc.execute({ type: "removeElement", elementId: "e2" });
  capture();
  return { history: doc.history, states };
}

test("replay to every revision reproduces the recorded elements and content hash", () => {
  const { history, states } = buildHistory();
  assert.equal(history.revisions.length, states.length - 1);
  for (let k = 0; k <= history.revisions.length; k++) {
    const replay = replayHistoryTo(history, k);
    assert.deepEqual(
      replay.elements,
      states[k],
      `replay to revision ${k} must reproduce the recorded element state`,
    );
    const verified = verifiedReplay(history, k);
    assert.equal(verified.verified, true, `replay to ${k} matches the recorded content hash`);
    if (k > 0) {
      assert.equal(replay.content_hash, history.revisions[k - 1]?.content_hash);
    }
  }
});

test("no future leakage: replay(k) is unchanged by later revisions", () => {
  const { history } = buildHistory();
  const mid = Math.floor(history.revisions.length / 2);
  const full = replayHistoryTo(history, mid);
  // Truncate the history to the first `mid` revisions — the information
  // available at revision `mid`. replay(mid) must be identical.
  const truncated: ModelHistory = { ...history, revisions: history.revisions.slice(0, mid) };
  const partial = replayHistoryTo(truncated, mid);
  assert.deepEqual(partial.elements, full.elements);
  assert.equal(partial.content_hash, full.content_hash);
  // And a structurally different future produces the same past.
  const midRevision = history.revisions[mid];
  assert.ok(midRevision !== undefined);
  const differentFuture: ModelHistory = {
    ...history,
    revisions: [...history.revisions.slice(0, mid), { ...midRevision, note: "redo" }],
  };
  const partial2 = replayHistoryTo(differentFuture, mid);
  assert.equal(partial2.content_hash, full.content_hash);
});

test("replay rejects out-of-range and malformed revision numbers", () => {
  const { history } = buildHistory();
  const n = history.revisions.length;
  assert.throws(() => replayHistoryTo(history, n + 1), /out of range/);
  assert.throws(() => replayHistoryTo(history, -1), /out of range/);
  assert.throws(() => replayHistoryTo(history, 1.5), /out of range/);
});

test("model.replay through the App API: verified replays, typed errors", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await okValue(handler, cmd("document.create", { entityId: "replay-doc" }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e1", "m1") } }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e2", "m2") } }));
  await okValue(handler, cmd("document.undo", {}));

  for (const k of [0, 1, 2, 3]) {
    const replay = await okValue<{ revision_number: number; verified: boolean; elements: Element[] }>(
      handler,
      q("model.replay", { revision_number: k }),
    );
    assert.equal(replay.revision_number, k);
    assert.equal(replay.verified, true);
  }
  assert.deepEqual(
    (await okValue<{ elements: Element[] }>(handler, q("model.replay", { revision_number: 2 }))).elements.map((e) => e.id),
    ["e1", "e2"],
  );

  for (const bad of [4, -1, 1.5, "2", null]) {
    const response = await handler.handle(q("model.replay", { revision_number: bad }));
    assert.equal(response.ok, false, `revision_number ${JSON.stringify(bad)} must be rejected`);
    assert.equal((response as { code: string }).code, "bad_payload");
  }
  const missing = await handler.handle(q("model.replay", {}));
  assert.equal(missing.ok, false);
  assert.equal((missing as { code: string }).code, "bad_payload");
});

test("replay is deterministic across handler instances (same sequence, same replays)", async () => {
  const drive = async (handler: AppApiHandler): Promise<void> => {
    await okValue(handler, cmd("document.create", { entityId: "replay-doc" }));
    await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e1", "m1", "occt") } }));
    await okValue(handler, cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "e1", patch: { meshToken: "m2" } } }));
    await okValue(handler, cmd("document.undo", {}));
    await okValue(handler, cmd("document.redo", {}));
  };
  const a = AppApiHandler.create(CONFIG);
  const b = AppApiHandler.create(CONFIG);
  await drive(a);
  await drive(b);
  const historyA = await okValue<ModelHistory>(a, q("model.getHistory"));
  const historyB = await okValue<ModelHistory>(b, q("model.getHistory"));
  assert.equal(JSON.stringify(historyA), JSON.stringify(historyB));
  for (let k = 0; k <= historyA.revisions.length; k++) {
    const ra = await okValue<{ content_hash: string }>(a, q("model.replay", { revision_number: k }));
    const rb = await okValue<{ content_hash: string }>(b, q("model.replay", { revision_number: k }));
    assert.equal(ra.content_hash, rb.content_hash);
  }
});

test("undo/redo branches replay correctly (version chain divergence is preserved)", () => {
  const doc = CADDocument.empty("branch-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") }); // r1 → v2
  doc.undo(); // r2 → back to v1
  doc.execute({ type: "addElement", element: el("e2", "m2") }); // r3 → v2' (branched)
  const history = doc.history;
  assert.equal(history.revisions.length, 3);
  const r3 = history.revisions[2];
  assert.ok(r3);
  assert.notEqual(r3.version.version_id, history.revisions[0]?.version.version_id, "the branch creates a distinct version");
  const replay = verifiedReplay(history, 3);
  assert.equal(replay.verified, true);
  assert.deepEqual(replay.elements.map((e) => e.id), ["e2"], "the branched state contains only e2");
});
