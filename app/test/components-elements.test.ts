/**
 * COMPAT-BIM-003 — strict constructor + validation matrices for the component/
 * material/coordination layer (pure, engine-free; LOCK-007: reject, never
 * guess). Mirrors the bim-elements.test.ts precedent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bimEntityToElement,
  elementToBimEntity,
  type BimEntity,
} from "../src/bim/elements.js";
import {
  COMPONENT_CATEGORY_PARAMS,
  effectiveBox,
  effectiveMaterialId,
  effectiveParameters,
  isBimComponentCategory,
  makeComponentDef,
  makeComponentInstance,
  makeGrid,
  makeMaterial,
  makeReferencePlane,
  validateComponentParameters,
  validateComponentOverrides,
  validateInstanceAgainstDefinition,
} from "../src/bim/components.js";
import { bimGeometryContext, bimSolidDescriptor, bimWorldBBox } from "../src/bim/geometry.js";
import { extractElementSemantics } from "../src/bim/semantics.js";

function throws(fn: () => unknown, needle: string): void {
  assert.throws(fn, (e: Error) => e.message.includes(needle));
}

// --- categories + parameter schemas --------------------------------------------

test("component categories have fixed parameter schemas", () => {
  assert.ok(isBimComponentCategory("wall"));
  assert.ok(isBimComponentCategory("fixture"));
  assert.ok(!isBimComponentCategory("roof"));
  for (const [category, params] of Object.entries(COMPONENT_CATEGORY_PARAMS)) {
    assert.ok(params.length >= 2, `${category} has a representative schema`);
    assert.ok(params.every((p) => typeof p === "string" && p.length > 0));
  }
  // furniture/fixture share the box schema by design; the wall/door/window
  // schemas are distinct from each other.
  assert.deepEqual(COMPONENT_CATEGORY_PARAMS.furniture, COMPONENT_CATEGORY_PARAMS.fixture);
  assert.notDeepEqual(COMPONENT_CATEGORY_PARAMS.wall, COMPONENT_CATEGORY_PARAMS.door);
  assert.notDeepEqual(COMPONENT_CATEGORY_PARAMS.door, COMPONENT_CATEGORY_PARAMS.window);
});

test("validateComponentParameters requires exactly the schema keys, all > 0", () => {
  assert.deepEqual(validateComponentParameters("wall", { length: 4000, width: 300, height: 3000 }, "p"), {
    height: 3000,
    length: 4000,
    width: 300,
  });
  throws(() => validateComponentParameters("wall", { length: 4000, width: 300 }, "p"), "p.height");
  throws(() => validateComponentParameters("wall", { length: 4000, width: 300, height: 3000, depth: 10 }, "p"), "depth");
  throws(() => validateComponentParameters("door", { width: 900, height: 2100, leafThickness: 0 }, "p"), "p.leafThickness");
  throws(() => validateComponentParameters("door", { width: 900, height: 2100, leafThickness: Number.NaN }, "p"), "leafThickness");
  throws(() => validateComponentParameters("furniture", { width: 800, depth: 600, height: Number.POSITIVE_INFINITY }, "p"), "height");
});

test("validateComponentOverrides accepts schema subsets, rejects foreign keys", () => {
  assert.deepEqual(validateComponentOverrides("window", { width: 1200 }, "p"), { width: 1200 });
  assert.deepEqual(validateComponentOverrides("window", undefined, "p"), {});
  // Structural-only validation (category unknown — element re-validation).
  assert.deepEqual(validateComponentOverrides(undefined, { anything: 5 }, "p"), { anything: 5 });
  throws(() => validateComponentOverrides("window", { depth: 300 }, "p"), "depth");
  throws(() => validateComponentOverrides("furniture", { width: -1 }, "p"), "p.width");
});

// --- component definitions -------------------------------------------------------

test("makeComponentDef validates strictly and canonicalizes key order", () => {
  const def = makeComponentDef({ name: "Exterior Wall 300", category: "wall", parameters: { width: 300, length: 4000, height: 3000 } });
  assert.equal(def.name, "Exterior Wall 300");
  assert.deepEqual(Object.keys(def.parameters), ["height", "length", "width"]);
  throws(() => makeComponentDef({ name: "", category: "wall", parameters: { length: 1, width: 1, height: 1 } }), "componentDef.name");
  throws(() => makeComponentDef({ name: "X", category: "roof", parameters: {} }), "componentDef.category");
  throws(() => makeComponentDef({ name: "X", category: "wall", parameters: "nope" }), "parameters");
  throws(() => makeComponentDef({ name: "X", category: "wall", parameters: {} }), "parameters.length");
  throws(() => makeComponentDef({ name: "X", category: "wall", parameters: { length: 1, width: 1, height: 1 }, materialId: "" }), "materialId");
});

// --- component instances + the propagation model ---------------------------------

test("makeComponentInstance validates placement and structural overrides", () => {
  const inst = makeComponentInstance({
    definitionId: "def-1", storyId: "story-gf", position: [1000, 2000],
    rotation: Math.PI / 6, baseOffset: 100, overrides: { width: 250 },
  });
  assert.equal(inst.definitionId, "def-1");
  assert.equal(inst.rotation, Math.PI / 6);
  assert.deepEqual(inst.overrides, { width: 250 });
  assert.equal(inst.baseOffset, 100);
  assert.deepEqual(makeComponentInstance({ definitionId: "d", storyId: "s", position: [0, 0] }), {
    type: "bim.componentInstance", definitionId: "d", storyId: "s", position: [0, 0], rotation: 0, baseOffset: 0, overrides: {},
  });
  throws(() => makeComponentInstance({ definitionId: "", storyId: "s", position: [0, 0] }), "definitionId");
  throws(() => makeComponentInstance({ definitionId: "d", storyId: "s", position: [0] }), "position");
  throws(() => makeComponentInstance({ definitionId: "d", storyId: "s", position: [0, 0], rotation: Number.NaN }), "rotation");
  throws(() => makeComponentInstance({ definitionId: "d", storyId: "s", position: [0, 0], overrides: { width: 0 } }), "overrides.width");
});

test("effective parameters are definition ⊕ overrides (derivation, never duplication)", () => {
  const def = { ...makeComponentDef({ name: "Desk", category: "furniture", parameters: { width: 800, depth: 600, height: 750 } }), id: "def-1" };
  const plain = { ...makeComponentInstance({ definitionId: "def-1", storyId: "s", position: [0, 0] }), id: "inst-1" };
  const overridden = { ...makeComponentInstance({ definitionId: "def-1", storyId: "s", position: [0, 0], overrides: { depth: 900 } }), id: "inst-2" };
  assert.deepEqual(effectiveParameters(def, plain), { depth: 600, height: 750, width: 800 });
  assert.deepEqual(effectiveParameters(def, overridden), { depth: 900, height: 750, width: 800 });
  // The propagation invariant: changing the DEFINITION default flows through
  // unless the instance pins the key with an override.
  const widened = { ...def, parameters: { depth: 600, height: 900, width: 1000 } };
  assert.deepEqual(effectiveParameters(widened, plain), { depth: 600, height: 900, width: 1000 });
  assert.deepEqual(effectiveParameters(widened, overridden), { depth: 900, height: 900, width: 1000 });
  // Cross-validation rejects override keys outside the definition's schema.
  validateInstanceAgainstDefinition(def, plain);
  const foreign = { ...makeComponentInstance({ definitionId: "def-1", storyId: "s", position: [0, 0] }), id: "inst-3" };
  const hacked = { ...foreign, overrides: { leafThickness: 40 } } as typeof foreign;
  throws(() => validateInstanceAgainstDefinition(def, hacked), "leafThickness");
});

test("effectiveBox maps parameters to per-category box extents", () => {
  const def = (category: Parameters<typeof makeComponentDef>[0]["category"], parameters: Record<string, number>) =>
    ({ ...makeComponentDef({ name: "D", category, parameters }), id: "def-1" });
  const inst = { ...makeComponentInstance({ definitionId: "def-1", storyId: "s", position: [0, 0] }), id: "inst-1" };
  assert.deepEqual(effectiveBox(def("wall", { length: 4000, width: 300, height: 3000 }), inst), [4000, 300, 3000]);
  assert.deepEqual(effectiveBox(def("door", { width: 900, height: 2100, leafThickness: 40 }), inst), [900, 40, 2100]);
  assert.deepEqual(effectiveBox(def("window", { width: 1200, height: 1500, frameDepth: 70 }), inst), [1200, 70, 1500]);
  assert.deepEqual(effectiveBox(def("fixture", { width: 600, depth: 450, height: 900 }), inst), [600, 450, 900]);
  assert.equal(effectiveMaterialId(def("wall", { length: 1, width: 1, height: 1 }), inst), null);
});

// --- materials ---------------------------------------------------------------------

test("makeMaterial validates name/color/properties strictly", () => {
  const mat = makeMaterial({
    name: "Concrete C30",
    description: "Structural concrete",
    color: [120, 120, 120],
    properties: { Density: 2400, FireRating: "REI90", Recycled: false },
  });
  assert.equal(mat.name, "Concrete C30");
  assert.deepEqual(mat.color, [120, 120, 120]);
  assert.deepEqual(Object.keys(mat.properties), ["Density", "FireRating", "Recycled"]);
  throws(() => makeMaterial({ name: "", properties: {} }), "material.name");
  throws(() => makeMaterial({ name: "X", properties: {} , color: [0, 0, 256] }), "color");
  throws(() => makeMaterial({ name: "X", properties: {} , color: [0, 0] }), "color");
  throws(() => makeMaterial({ name: "X", properties: {} , color: [0, 0, 1.5] }), "color");
  throws(() => makeMaterial({ name: "X" }), "material.properties");
  throws(() => makeMaterial({ name: "X", properties: { D: null } }), "properties.D");
  const tooMany: Record<string, number> = {};
  for (let i = 0; i < 33; i++) tooMany[`p${i}`] = i;
  throws(() => makeMaterial({ name: "X", properties: tooMany }), "32-property bound");
});

// --- grids + reference planes --------------------------------------------------------

test("makeGrid requires non-empty strictly ascending line sets", () => {
  const grid = makeGrid({ storyId: "story-gf", name: "Structural grid", uLines: [-6000, 0, 6000], vLines: [0, 5000] });
  assert.deepEqual(grid.uLines, [-6000, 0, 6000]);
  throws(() => makeGrid({ storyId: "s", name: "G", uLines: [], vLines: [0] }), "uLines");
  throws(() => makeGrid({ storyId: "s", name: "G", uLines: [0, 0], vLines: [0] }), "strictly ascending");
  throws(() => makeGrid({ storyId: "s", name: "G", uLines: [6000, 0], vLines: [0] }), "strictly ascending");
  throws(() => makeGrid({ storyId: "s", name: "G", uLines: [0, Number.NaN], vLines: [0] }), "finite number");
  const tooMany: number[] = [];
  for (let i = 0; i < 65; i++) tooMany.push(i);
  throws(() => makeGrid({ storyId: "s", name: "G", uLines: tooMany, vLines: [0] }), "64-line bound");
});

test("makeReferencePlane requires a non-degenerate trace", () => {
  const plane = makeReferencePlane({ storyId: "story-gf", name: "Grid A reference", start: [0, 0], end: [6000, 0] });
  assert.deepEqual(plane.start, [0, 0]);
  throws(() => makeReferencePlane({ storyId: "s", name: "P", start: [1, 1], end: [1, 1] }), "must not coincide");
  throws(() => makeReferencePlane({ storyId: "s", name: "", start: [0, 0], end: [1, 0] }), "name");
});

// --- element ⇄ entity mapping + semantics + geometry derivation ------------------------

test("element ⇄ entity mapping round-trips every new type (strict re-validation)", () => {
  const cases: BimEntity[] = [
    { ...makeComponentDef({ name: "Exterior Wall 300", category: "wall", parameters: { length: 4000, width: 300, height: 3000 }, materialId: "mat-1" }), id: "def-1" },
    { ...makeComponentInstance({ definitionId: "def-1", storyId: "story-gf", position: [1000, 2000], rotation: 0.5, overrides: { width: 250 }, materialId: "mat-1", name: "W-1" }), id: "inst-1" },
    { ...makeMaterial({ name: "Concrete C30", color: [120, 120, 120], properties: { Density: 2400 } }), id: "mat-1" },
    { ...makeGrid({ storyId: "story-gf", name: "Grid", uLines: [0, 6000], vLines: [0, 5000] }), id: "grid-1" },
    { ...makeReferencePlane({ storyId: "story-gf", name: "Plane", start: [0, 0], end: [6000, 0] }), id: "plane-1" },
  ];
  for (const entity of cases) {
    const el = bimEntityToElement(entity);
    assert.equal(el.kind, "bim");
    assert.equal(el.engineId, null);
    assert.deepEqual(elementToBimEntity(el), entity);
  }
  // Malformed stored props are rejected on parse (never trusted).
  const broken = bimEntityToElement(cases[1]!);
  (broken.props as Record<string, unknown>).rotation = "fast";
  throws(() => elementToBimEntity(broken), "rotation");
});

test("semantic records expose the component/material/coordination roles", () => {
  const mat = bimEntityToElement({ ...makeMaterial({ name: "Glass", properties: { UValue: 1.2 } }), id: "mat-9" });
  const rec = extractElementSemantics(mat);
  assert.equal(rec.type, "bim.material");
  assert.equal(rec.semantics.role, "domain-data");
  assert.equal(rec.semantics.classification, "material");

  const grid = bimEntityToElement({ ...makeGrid({ storyId: "s", name: "G", uLines: [0], vLines: [1] }), id: "grid-9" });
  assert.equal(extractElementSemantics(grid).semantics.role, "coordination");

  const def = bimEntityToElement({ ...makeComponentDef({ name: "D", category: "door", parameters: { width: 900, height: 2100, leafThickness: 40 } }), id: "def-9" });
  const defRec = extractElementSemantics(def);
  assert.equal(defRec.semantics.role, "component-definition");
  assert.equal(defRec.semantics.classification, "door");
});

test("instance solids derive as rotated centered boxes; defs/materials/grids honestly have none", () => {
  const story = { type: "bim.story", id: "story-gf", name: "GF", level: 0, height: 3000 } as const;
  const def = { ...makeComponentDef({ name: "Desk", category: "furniture", parameters: { width: 800, depth: 600, height: 750 } }), id: "def-1" };
  const inst = { ...makeComponentInstance({ definitionId: "def-1", storyId: "story-gf", position: [1000, 2000], rotation: Math.PI / 2, baseOffset: 50 }), id: "inst-1" };
  const ctx = bimGeometryContext([story, def, inst]);
  const { descriptor, reason } = bimSolidDescriptor(inst, ctx);
  assert.ok(descriptor !== null);
  assert.equal(descriptor.shape, "extrude");
  assert.equal(descriptor.height, 750);
  // Rotated 90°: the 800-wide footprint becomes 800 along Y, 600 along X.
  const box = bimWorldBBox(inst, ctx)!;
  assert.ok(Math.abs(box[3] - box[0] - 600) < 1e-6, `sizeX ${box[3] - box[0]}`);
  assert.ok(Math.abs(box[4] - box[1] - 800) < 1e-6, `sizeY ${box[4] - box[1]}`);
  assert.equal(box[2], 50);
  assert.equal(box[5], 800);
  // Honest no-solid answers:
  assert.match(bimSolidDescriptor(def, ctx).reason!, /parametric domain data/);
  assert.match(bimSolidDescriptor({ ...makeMaterial({ name: "M", properties: {} }), id: "m" }, ctx).reason!, /domain data/);
  assert.match(bimSolidDescriptor({ ...makeGrid({ storyId: "story-gf", name: "G", uLines: [0], vLines: [0] }), id: "g" }, ctx).reason!, /coordination/);
});
