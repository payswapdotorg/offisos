/**
 * Idempotency cache + handler idempotency (api-contract.md §4).
 *
 * Two commands with the same idempotency key are applied at most once; the
 * cached response is returned for subsequent occurrences.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler, IdempotencyCache } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "idem-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "idem-test",
};

test("IdempotencyCache get/set/size/clear", () => {
  const cache = new IdempotencyCache();
  assert.equal(cache.size(), 0);
  cache.set("k1", { ok: true, value: 1 });
  assert.equal(cache.size(), 1);
  assert.deepEqual(cache.get("k1"), { ok: true, value: 1 });
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get("k1"), undefined);
});

test("handler applies a command with a key once across duplicates", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const addA = {
    type: "command" as const,
    name: "document.applyEdit" as const,
    payload: { edit: { type: "addElement" as const, element: { id: "e1", kind: "geometry" as const, engineId: null, props: { meshToken: "m1" } } } },
    idempotencyKey: "key-A",
  };
  const first = await handler.handle(addA);
  const firstHash = handler.currentContentHash();
  assert.ok(first.ok);
  const second = await handler.handle(addA);
  assert.ok(second.ok);
  // Same key → same content (applied once).
  assert.equal(handler.currentContentHash(), firstHash);
});

test("handler distinguishes different keys", async () => {
  const handler = AppApiHandler.create(CONFIG);
  const addA = {
    type: "command" as const,
    name: "document.applyEdit" as const,
    payload: { edit: { type: "addElement" as const, element: { id: "e1", kind: "geometry" as const, engineId: null, props: { meshToken: "m1" } } } },
    idempotencyKey: "key-A",
  };
  const addB = {
    type: "command" as const,
    name: "document.applyEdit" as const,
    payload: { edit: { type: "addElement" as const, element: { id: "e2", kind: "geometry" as const, engineId: null, props: { meshToken: "m2" } } } },
    idempotencyKey: "key-B",
  };
  await handler.handle(addA);
  const afterA = handler.currentContentHash();
  await handler.handle(addB);
  assert.notEqual(handler.currentContentHash(), afterA);
});
