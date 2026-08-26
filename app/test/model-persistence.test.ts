/**
 * Save/open persistence of the model revision history
 * (CAD-IMPLEMENT-003, LOCK-005/LOCK-012).
 *
 * Save → open round-trips preserve geometry, identity, provenance and
 * version lineage: the immutable history travels inside the snapshot through
 * the unchanged FileEngineAdapter boundary (both the dummy and the OCCT file
 * adapters serialize the snapshot), survives the JSON wire, and continues
 * appending after reopen. Legacy artifacts without a history open with a
 * seeded base. Corrupt histories are rejected (LOCK-007).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { CADDocument } from "../src/caddocument/index.js";
import { canonicalStringify, deserialize, serialize } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot, Element } from "../src/contracts/caddocument.js";
import type { Command, Query } from "../src/contracts/app-api.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "persist-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "persistence-test",
};

const OWNER = "persistence-test";

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
  assert.equal(response.ok, true, `expected ok for ${request.name}: ${JSON.stringify(response)}`);
  return (response as { ok: true; value: T }).value;
}

async function driveEdits(handler: AppApiHandler): Promise<void> {
  await okValue(handler, cmd("document.create", { entityId: "persist-doc" }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e1", "occt:abc", "occt") } }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e2", "m2") } }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "updateElement", elementId: "e1", patch: { meshToken: "occt:def" } } }));
  await okValue(handler, cmd("document.undo", {}));
  await okValue(handler, cmd("document.redo", {}));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "removeElement", elementId: "e2" } }));
}

test("save → open preserves geometry, identity, provenance, version lineage and history", async () => {
  const a = AppApiHandler.create(CONFIG);
  await driveEdits(a);

  const historyBefore = await okValue<{ revisions: unknown[] }>(a, q("model.getHistory"));
  const eventsBefore = await okValue<{ events_hash: string }>(a, q("model.getGraphEvents"));
  const headBefore = historyBefore.revisions.length;
  const headReplayBefore = await okValue<{ content_hash: string }>(a, q("model.replay", { revision_number: headBefore }));
  const versionBefore = await okValue<{ version_id: string; version_number: number }>(a, q("document.getVersion"));

  // document.save → bytes through the file adapter (unchanged boundary).
  const save = await okValue<{ bytes: number[]; format: string }>(a, cmd("document.save", {}));
  assert.ok(save.bytes.length > 0);

  // Open the saved bytes in a FRESH handler (new session).
  const b = AppApiHandler.create(CONFIG);
  const opened = await okValue<CADDocumentSnapshot>(b, cmd("document.open", { source: save.bytes }));
  assert.equal(opened.elements.length, 1, "geometry preserved");
  assert.equal(opened.elements[0]?.id, "e1", "canonical element identity preserved");
  assert.equal(opened.elements[0]?.engineId, "occt", "engine id preserved as provenance");
  assert.equal(opened.version.version_id, versionBefore.version_id, "version lineage preserved");

  const historyAfter = await okValue<{ revisions: unknown[] }>(b, q("model.getHistory"));
  assert.equal(historyAfter.revisions.length, historyBefore.revisions.length);
  assert.equal(
    canonicalStringify(historyAfter),
    canonicalStringify(historyBefore),
    "history is byte-identical across save/open",
  );
  const eventsAfter = await okValue<{ events_hash: string }>(b, q("model.getGraphEvents"));
  assert.equal(eventsAfter.events_hash, eventsBefore.events_hash, "graph events identical across save/open");
  // The editorState is ephemeral (open clears undo/redo), so the parity hash
  // legitimately differs; the CONTENT hash at the head revision — computed by
  // the deterministic replay — is the content-equality proof.
  const headReplayAfter = await okValue<{ content_hash: string }>(b, q("model.replay", { revision_number: headBefore }));
  assert.equal(headReplayAfter.content_hash, headReplayBefore.content_hash, "content hash at the head revision identical across save/open");

  // Deterministic replay still verifies at every revision after reopen.
  const count = historyAfter.revisions.length;
  for (let k = 0; k <= count; k++) {
    const replay = await okValue<{ verified: boolean; content_hash: string }>(b, q("model.replay", { revision_number: k }));
    assert.equal(replay.verified, true, `replay to ${k} verified after reopen`);
  }
});

test("revisions continue appending after reopen (parent linkage intact)", async () => {
  const a = AppApiHandler.create(CONFIG);
  await driveEdits(a);
  const save = await okValue<{ bytes: number[] }>(a, cmd("document.save", {}));

  const b = AppApiHandler.create(CONFIG);
  await okValue<CADDocumentSnapshot>(b, cmd("document.open", { source: save.bytes }));
  const before = await okValue<{ revisions: { revision_id: string; version: { version_id: string } }[] }>(
    b,
    q("model.getHistory"),
  );
  const last = before.revisions[before.revisions.length - 1];
  assert.ok(last);

  await okValue(b, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e3", "m3") } }));
  const after = await okValue<{ revisions: { revision_number: number; from_version_id: string; version: { version_id: string } }[] }>(
    b,
    q("model.getHistory"),
  );
  assert.equal(after.revisions.length, before.revisions.length + 1);
  const appended = after.revisions[after.revisions.length - 1];
  assert.ok(appended);
  assert.equal(appended.revision_number, before.revisions.length + 1);
  assert.equal(appended.from_version_id, last.version.version_id, "continuation links to the reopened head version");
});

test("serialize → deserialize round-trip preserves the history byte-identically", () => {
  const doc = CADDocument.empty("persist-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.undo();
  doc.redo();
  const snapshot = doc.snapshot();
  const text = serialize(snapshot);
  const restored = deserialize(text);
  assert.ok(restored.modelHistory !== undefined);
  assert.ok(snapshot.modelHistory !== undefined);
  assert.equal(canonicalStringify(restored.modelHistory), canonicalStringify(snapshot.modelHistory));
  // Legacy files (no modelHistory) still deserialize.
  const { modelHistory: _legacy, ...legacyRest } = snapshot;
  void _legacy;
  const legacy = deserialize(canonicalStringify(legacyRest));
  assert.equal(legacy.modelHistory, undefined);
});

test("legacy snapshot without history opens with a seeded 'opened' base", async () => {
  const doc = CADDocument.empty("legacy-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  doc.execute({ type: "addElement", element: el("e2", "m2") });
  // Strip the history: a pre-CAD-003 artifact.
  const { modelHistory: _stripped, ...rest } = doc.snapshot();
  void _stripped;
  const legacy: CADDocumentSnapshot = rest;

  const handler = AppApiHandler.create(CONFIG);
  const opened = await okValue<CADDocumentSnapshot>(handler, cmd("document.open", { snapshot: legacy }));
  assert.equal(opened.elements.length, 2);
  assert.equal(opened.modelHistory?.base.origin, "opened");
  assert.deepEqual(opened.modelHistory?.base.elements.map((e) => e.id), ["e1", "e2"]);
  assert.equal(opened.modelHistory?.revisions.length, 0);

  // Replaying the base (revision 0) reproduces the opened elements.
  const replay = await okValue<{ elements: Element[]; verified: boolean }>(
    handler,
    q("model.replay", { revision_number: 0 }),
  );
  assert.deepEqual(replay.elements.map((e) => e.id), ["e1", "e2"]);
  assert.equal(replay.verified, true);

  // The first edit after a legacy open is revision 1.
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "removeElement", elementId: "e2" } }));
  const history = await okValue<{ revisions: { revision_number: number; delta: { removed: string[] } }[] }>(
    handler,
    q("model.getHistory"),
  );
  assert.equal(history.revisions.length, 1);
  assert.deepEqual(history.revisions[0]?.delta.removed, ["e2"]);
});

test("corrupt histories are rejected, never guessed or repaired (LOCK-007)", async () => {
  const doc = CADDocument.empty("corrupt-doc", "offisos-dummy", "1", OWNER);
  doc.execute({ type: "addElement", element: el("e1", "m1") });
  const snapshot = doc.snapshot();
  const history = snapshot.modelHistory;
  assert.ok(history !== undefined);
  const firstRevision = history.revisions[0];
  assert.ok(firstRevision !== undefined);

  // Tampered content hash.
  const tamperedHash = {
    ...snapshot,
    modelHistory: {
      ...history,
      revisions: [
        { ...firstRevision, content_hash: "0".repeat(64) },
      ],
    },
  };
  const handler = AppApiHandler.create(CONFIG);
  // The tampered hash passes structural validation but fails replay verification.
  const opened = await handler.handle(cmd("document.open", { snapshot: tamperedHash }));
  assert.equal(opened.ok, true, "structurally valid history opens");
  const replay = await handler.handle(q("model.replay", { revision_number: 1 }));
  assert.equal(replay.ok, false);
  assert.equal((replay as { code: string }).code, "replay_failed", "tampered content hash fails integrity verification");

  // Broken revision numbering fails structural validation.
  const brokenNumbering = {
    ...snapshot,
    modelHistory: {
      ...history,
      revisions: [
        { ...firstRevision, revision_number: 7 },
      ],
    },
  };
  const rejected = await handler.handle(cmd("document.open", { snapshot: brokenNumbering }));
  assert.equal(rejected.ok, false);
  assert.equal((rejected as { code: string }).code, "open_failed");

  // Linkage violation: snapshot version does not match the history head.
  const otherDoc = CADDocument.empty("corrupt-doc", "offisos-dummy", "1", OWNER);
  otherDoc.execute({ type: "addElement", element: el("eX", "mX") });
  const linkageViolation = { ...otherDoc.snapshot(), modelHistory: history };
  const rejectedLink = await handler.handle(cmd("document.open", { snapshot: linkageViolation }));
  assert.equal(rejectedLink.ok, false);
  assert.equal((rejectedLink as { code: string }).code, "open_failed");

  // Malformed history through document.deserialize is typed too.
  const malformedHistory = {
    ...history,
    next_element_sequence: "not-a-number" as unknown as number,
  };
  const malformed = serialize({ ...snapshot, modelHistory: malformedHistory });
  const rejectedText = await handler.handle(cmd("document.deserialize", { text: malformed }));
  assert.equal(rejectedText.ok, false);
  assert.equal((rejectedText as { code: string }).code, "deserialize_failed");
});

test("duplicate element id through the App API is a typed edit_failed", async () => {
  const handler = AppApiHandler.create(CONFIG);
  await okValue(handler, cmd("document.create", { entityId: "dup-doc" }));
  await okValue(handler, cmd("document.applyEdit", { edit: { type: "addElement", element: el("e1", "m1") } }));
  const response = await handler.handle(
    cmd("document.applyEdit", { edit: { type: "addElement", element: el("e1", "m2") } }),
  );
  assert.equal(response.ok, false);
  assert.equal((response as { code: string }).code, "edit_failed");
  const history = await okValue<{ revisions: unknown[] }>(handler, q("model.getHistory"));
  assert.equal(history.revisions.length, 1, "rejected edit appended no revision");
});
