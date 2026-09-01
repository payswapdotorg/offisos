/**
 * CAD-PARITY-015 (Issue #110) — the property-definition registry: the
 * prd-NNNNNN records (closed grammar, unique names, unique (set, key)
 * addresses), the property.create/update/remove command surface and the
 * properties.list lineage statistics (values counted from the canonical
 * element property-set overlay ONLY — there is NO parallel source of
 * truth; type mismatches are reported, never coerced).
 *
 * Engine-free paths through the dummy bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "properties-p015",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p015-properties",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errOf(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, `expected a typed failure, got: ${JSON.stringify(r).slice(0, 300)}`);
  const e = r as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p015-properties-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    ],
  }));
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-south",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 90 }] }],
  }));
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-east",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: "sixty" }] }],
  }));
}

test("properties: create/update/remove — the closed grammar + typed failure codes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const created = val<{ propertyDef: { id: string } }>(await cmd(h, "property.create", {
    name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min", appliesTo: ["bim.wall", "bim.slab"],
  }));
  assert.match(created.propertyDef.id, /^prd-\d{6}$/);
  const id = created.propertyDef.id;

  // Duplicate name + duplicate (set, key) address.
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Fire rating", set: "Other", key: "Other", type: "text",
  })).code, "property_exists");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Another", set: "PSetA", key: "FireRating", type: "number",
  })).code, "property_exists");

  // Typed grammar failures.
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "", key: "FireRating", type: "number",
  })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "PSetA", key: "bad key!", type: "number",
  })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "PSetB", key: "Length", type: "colour",
  })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "PSetB", key: "Length", type: "text", unit: "mm",
  })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "PSetB", key: "Length", type: "number", appliesTo: ["not.a.type"],
  })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.create", {
    name: "Bad", set: "PSetB", key: "Length", type: "number", appliesTo: ["bim.wall", "bim.wall"],
  })).code, "property_invalid");

  // Update: rename + narrow the scope; null removes unit/appliesTo.
  val(await cmd(h, "property.update", { id, patch: { name: "Fire rating (walls)", appliesTo: ["bim.wall"] } }));
  const renamed = val<{ propertyDefs: { id: string; name: string; unit?: string; appliesTo?: string[] }[] }>(await qq(h, "properties.list", {}));
  const row = renamed.propertyDefs.find((d) => d.id === id)!;
  assert.equal(row.name, "Fire rating (walls)");
  assert.equal(row.unit, "min");
  assert.deepEqual(row.appliesTo, ["bim.wall"]);
  val(await cmd(h, "property.update", { id, patch: { unit: null, appliesTo: null } }));
  const cleared = val<{ propertyDefs: { id: string; unit?: string; appliesTo?: string[] }[] }>(await qq(h, "properties.list", {}));
  const clearedRow = cleared.propertyDefs.find((d) => d.id === id)!;
  assert.equal(clearedRow.unit, undefined);
  assert.equal(clearedRow.appliesTo, undefined);

  // Unknown id / bad patch / immutable id.
  assert.equal(errOf(await cmd(h, "property.update", { id: "prd-999999", patch: { name: "X" } })).code, "property_not_found");
  assert.equal(errOf(await cmd(h, "property.update", { id, patch: { id: "prd-000002" } })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.update", { id, patch: { junk: 1 } })).code, "property_invalid");
  assert.equal(errOf(await cmd(h, "property.remove", { id: "prd-999999" })).code, "property_not_found");

  // Remove.
  val(await cmd(h, "property.remove", { id }));
  const after = val<{ propertyDefs: { id: string }[] }>(await qq(h, "properties.list", {}));
  assert.ok(!after.propertyDefs.some((d) => d.id === id));
  assert.equal(errOf(await cmd(h, "property.remove", { id })).code, "property_not_found");
});

test("properties: the lineage statistics resolve from the canonical overlay only (no parallel truth)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  val(await cmd(h, "property.create", { name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min" }));
  val(await cmd(h, "property.create", { name: "Finish", set: "PSetA", key: "Finish", type: "text" }));

  const list = val<{
    contract: string;
    valueSource: string;
    propertyDefs: { name: string; type: string; elementsWithValue: number; typeMatches: number; typeMismatches: number }[];
  }>(await qq(h, "properties.list", {}));
  assert.equal(list.contract, "offisos-properties/1");
  assert.equal(list.valueSource, "element-property-set-overlay");
  // wall-south carries number 90 (match); wall-east carries "sixty" (a typed
  // MISMATCH reported, never coerced).
  const fr = list.propertyDefs.find((d) => d.name === "Fire rating")!;
  assert.equal(fr.elementsWithValue, 2);
  assert.equal(fr.typeMatches, 1);
  assert.equal(fr.typeMismatches, 1);
  // No element carries Finish at all.
  const finish = list.propertyDefs.find((d) => d.name === "Finish")!;
  assert.equal(finish.elementsWithValue, 0);
  assert.equal(finish.typeMatches, 0);
  assert.equal(finish.typeMismatches, 0);

  // A canonical mutation flows straight into the statistics.
  await val(await cmd(h, "bim.setPropertySets", {
    elementId: "wall-east",
    propertySets: [{ name: "PSetA", properties: [{ key: "FireRating", value: 60 }] }],
  }));
  const rerun = val<{ propertyDefs: { name: string; elementsWithValue: number; typeMatches: number }[] }>(await qq(h, "properties.list", {}));
  const fr2 = rerun.propertyDefs.find((d) => d.name === "Fire rating")!;
  assert.equal(fr2.typeMatches, 2);
  assert.equal(fr2.elementsWithValue, 2);
});

test("properties: the registry persists through save/open + versioned replay/undo", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  val(await cmd(h, "property.create", { name: "Fire rating", set: "PSetA", key: "FireRating", type: "number", unit: "min" }));

  // One versioned command per mutating operation (createElements +
  // setPropertySets ×2 + property.create).
  const state = val<{ modelHistory: { revisions: unknown[] } }>(await qq(h, "document.getState", {}));
  assert.equal(state.modelHistory?.revisions.length, 4, "a registry edit is a versioned command");

  // Undo removes the definition; redo restores it.
  val(await cmd(h, "document.undo", {}));
  const afterUndo = val<{ propertyDefs: unknown[] }>(await qq(h, "properties.list", {}));
  assert.equal(afterUndo.propertyDefs.length, 0);
  val(await cmd(h, "document.redo", {}));
  const afterRedo = val<{ propertyDefs: unknown[] }>(await qq(h, "properties.list", {}));
  assert.equal(afterRedo.propertyDefs.length, 1);

  // The snapshot round-trip preserves the registry (save → open).
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const snapshot = JSON.parse(new TextDecoder().decode(new Uint8Array(saved.bytes))) as { propertyDefs?: unknown[] };
  assert.ok(Array.isArray(snapshot.propertyDefs) && snapshot.propertyDefs.length === 1, "the snapshot carries the registry");
  await val(await cmd(h, "document.open", { source: saved.bytes, entityId: "p015-properties-reopened" }));
  const reopened = val<{ propertyDefs: { name: string }[] }>(await qq(h, "properties.list", {}));
  assert.equal(reopened.propertyDefs[0]!.name, "Fire rating");

  // The minted prd- sequence is monotonic (never reused): the next create
  // after reopen mints prd-000002.
  const second = val<{ propertyDef: { id: string } }>(await cmd(h, "property.create", {
    name: "Finish", set: "PSetA", key: "Finish", type: "text",
  }));
  assert.equal(second.propertyDef.id, "prd-000002");
});
