/**
 * Version chain satisfies data-model.md §2 (LOCK-005).
 *
 * Every versioned entity has entity_id, version_id, version_number,
 * parent_version_id, created_at, created_by, source_snapshot_id, status. The
 * chain is reconstructable via parent_version_id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { childVersion, describeChain, makeVersionId, rootVersion } from "../src/caddocument/index.js";
import { CADDocument } from "../src/caddocument/index.js";
import type { Element } from "../src/contracts/caddocument.js";

const FIXED_CREATED_BY = "version-test";

test("root version satisfies data-model.md §2", () => {
  const v = rootVersion("doc-1", FIXED_CREATED_BY, "snap-1");
  assert.equal(v.entity_id, "doc-1");
  assert.equal(v.version_number, 1);
  assert.equal(v.parent_version_id, null);
  assert.equal(v.status, "ACTIVE");
  assert.equal(v.created_by, FIXED_CREATED_BY);
  assert.equal(v.source_snapshot_id, "snap-1");
  assert.ok(v.version_id.length > 0);
});

test("child version points at its parent", () => {
  const root = rootVersion("doc-1", FIXED_CREATED_BY, null);
  const child = childVersion(root, "abc123def456", FIXED_CREATED_BY);
  assert.equal(child.version_number, 2);
  assert.equal(child.parent_version_id, root.version_id);
  assert.equal(child.entity_id, root.entity_id);
  assert.equal(child.status, "ACTIVE");
});

test("makeVersionId is a pure function of entity + number + hash", () => {
  const a = makeVersionId("doc-1", 2, "abc123def456");
  const b = makeVersionId("doc-1", 2, "abc123def456");
  assert.equal(a, b);
  assert.notEqual(a, makeVersionId("doc-1", 3, "abc123def456"));
});

test("CADDocument.execute bumps the version with the parent pointing back", () => {
  const doc = CADDocument.empty("chain-doc", "offisos-dummy", "1", FIXED_CREATED_BY);
  const rootVersionMeta = doc.snapshot().version;
  assert.equal(rootVersionMeta.version_number, 1);
  const element: Element = { id: "e1", kind: "geometry", engineId: null, props: { meshToken: "m1" } };
  doc.execute({ type: "addElement", element });
  const after = doc.snapshot().version;
  assert.equal(after.version_number, 2);
  assert.equal(after.parent_version_id, rootVersionMeta.version_id);
});

test("describeChain returns the version and its parent pointer", () => {
  const root = rootVersion("doc-1", FIXED_CREATED_BY, null);
  const child = childVersion(root, "deadbeef", FIXED_CREATED_BY);
  const chain = describeChain(child);
  assert.equal(chain[0], child.version_id);
  assert.equal(chain[1], child.parent_version_id);
});
