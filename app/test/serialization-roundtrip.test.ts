/**
 * Canonical serialization round-trip (LOCK-005, LOCK-012, data-model.md §2).
 *
 * Same snapshot → same canonical JSON → same hash, regardless of key order
 * or insertion order of equivalent fields. Round-trip preserves identity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CADDocumentSnapshot, Element } from "../src/contracts/caddocument.js";
import { rootVersion } from "../src/caddocument/index.js";
import {
  canonicalHash,
  canonicalStringify,
  deserialize,
  roundTripPreservesHash,
  serialize,
} from "../src/caddocument/index.js";

function makeElement(id: string, meshToken: string): Element {
  return { id, kind: "geometry", engineId: null, props: { meshToken } };
}

function makeSnapshot(elements: Element[]): CADDocumentSnapshot {
  return {
    version: rootVersion("serial-doc", "serial-test", null),
    format: "offisos-dummy",
    formatVersion: "1",
    sourceArtifactLineage: ["test:serial"],
    editorState: { canUndo: false, canRedo: false, commandDepth: 0 },
    elements,
  };
}

test("canonicalStringify sorts object keys", () => {
  const a = canonicalStringify({ b: 2, a: 1, c: { z: 9, y: 8 } });
  const b = canonicalStringify({ a: 1, b: 2, c: { y: 8, z: 9 } });
  assert.equal(a, b);
  assert.match(a, /^\{"a":1,"b":2,"c":\{"y":8,"z":9\}\}$/);
});

test("serialize then deserialize preserves the canonical hash", () => {
  const snapshot = makeSnapshot([makeElement("e1", "mesh-1"), makeElement("e2", "mesh-2")]);
  assert.ok(roundTripPreservesHash(snapshot));
  const round = deserialize(serialize(snapshot));
  assert.equal(canonicalHash(round), canonicalHash(snapshot));
});

test("deserialize rejects malformed input (LOCK-007 epistemic honesty)", () => {
  assert.throws(() => deserialize("null"), /expected a JSON object/);
  assert.throws(() => deserialize("{}"), /missing version metadata/);
  assert.throws(
    () => deserialize(JSON.stringify({ version: {} })),
    /version metadata does not satisfy data-model.md §2/,
  );
  const validVersion = {
    entity_id: "x",
    version_id: "v1",
    version_number: 1,
    parent_version_id: null,
    created_at: "t",
    created_by: "u",
    source_snapshot_id: null,
    status: "ACTIVE",
  };
  assert.throws(
    () => deserialize(JSON.stringify({ version: validVersion })),
    /missing format\/formatVersion/,
  );
});

test("the same snapshot serialized twice produces identical bytes", () => {
  const snapshot = makeSnapshot([makeElement("e1", "mesh-1")]);
  assert.equal(serialize(snapshot), serialize(snapshot));
});
