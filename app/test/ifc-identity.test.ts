/**
 * COMPAT-IFC-001 — deterministic IfcGuid identity derivation (pure core).
 *
 * The derivation must be stable (same canonical id → same guid on every
 * host/run), structurally valid per the buildingSMART IfcGuid encoding, and
 * distinct per id. The known-vector test pins the exact encoding against
 * ifcopenshell.guid.compress (values produced with ifcopenshell 0.8.5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ifcGuidFor, isIfcGuid } from "../src/ifc/index.js";

test("ifcGuidFor is deterministic across calls", () => {
  assert.equal(ifcGuidFor("el-000001"), ifcGuidFor("el-000001"));
  assert.equal(ifcGuidFor("wall-south"), ifcGuidFor("wall-south"));
});

test("ifcGuidFor produces structurally valid IfcGuids (22 chars, IFC alphabet, first char 0-3)", () => {
  for (const id of ["el-000001", "story-gf", "op-door", "vw-000001", "sh-000001", "x", "if-000001"]) {
    const guid = ifcGuidFor(id);
    assert.equal(guid.length, 22, `length for ${id}`);
    assert.ok(isIfcGuid(guid), `valid for ${id}: ${guid}`);
    assert.ok("0123".includes(guid[0]!), `first char restricted for ${id}: ${guid[0]}`);
  }
});

test("ifcGuidFor is distinct per canonical id", () => {
  const guids = new Set(["el-000001", "el-000002", "el-000003", "story-gf"].map(ifcGuidFor));
  assert.equal(guids.size, 4);
});

test("ifcGuidFor known vectors match ifcopenshell.guid.compress (0.8.5)", () => {
  // vectors generated with: ifcopenshell.guid.compress(sha256("offisos-ifc-guid:v1:"+id)[:32])
  assert.equal(ifcGuidFor("el-000001"), "1X0IpixYRpdtps2$cmXr2v");
  assert.equal(ifcGuidFor("el-000002"), "0aPdR8$UhqICsTgl1ohqaw");
  assert.equal(ifcGuidFor("el-123456"), "2_oRK1bD2FoXxMFIPPxyvX");
  assert.equal(ifcGuidFor("story-x"), "1zHsJWI1rKgy1jydZVQfMk");
  assert.equal(ifcGuidFor("wall-north-abc"), "0ZUVlr82MmHbR7IdTdNljF");
});

test("isIfcGuid rejects malformed guids", () => {
  assert.equal(isIfcGuid("1X0IpixYRpdtps2$cmXr2v"), true);
  assert.equal(isIfcGuid(""), false);
  assert.equal(isIfcGuid("short"), false);
  assert.equal(isIfcGuid("1X0IpixYRpdtps2$cmXr2vX"), false); // 23 chars
  assert.equal(isIfcGuid("4X0IpixYRpdtps2$cmXr2v"), false); // first char outside 0-3
  assert.equal(isIfcGuid("1X0IpixYRpdtps2$cmXr2-"), false); // '-' not in the alphabet
});
