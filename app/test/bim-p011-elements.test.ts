/**
 * CAD-PARITY-011 (Issue #97) — the new Archicad-class authoring entities and
 * the meta overlay: strict constructor validation (LOCK-007: the FIRST
 * failure wins; every invalid input is a typed rejection), the canonical
 * element round-trip (entity → props → entity), and the meta overlay rules
 * (the closed classification table, structured property sets, the bounded
 * renovation vocabulary, the option membership pair).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIM_CLASSIFICATION_CODES,
  BIM_CLASSIFICATION_TABLE,
  BIM_RENOVATION_ELIGIBLE,
  BIM_RENOVATION_STATES,
  BIM_MAX_PROPERTY_SETS,
  BIM_MAX_PROPERTIES_PER_SET,
  effectiveRenovationStatus,
  validateBimMeta,
  validatePropertySets,
} from "../src/bim/meta.js";
import {
  BIM_OPTION_GROUP_MAX_OPTIONS,
  BIM_OPTION_GROUP_MIN_OPTIONS,
  BIM_STAIR_MAX_STEPS,
  BIM_STAIR_MIN_STEPS,
} from "../src/bim/elements.js";
import {
  bimEntityToElement,
  elementToBimEntity,
  makeOptionGroup,
  makeRailing,
  makeRoof,
  makeStair,
  makeWall,
  makeZone,
  type BimEntity,
} from "../src/bim/elements.js";

function assertInvalid(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

// ---------------------------------------------------------------------------
// The classification table
// ---------------------------------------------------------------------------

test("classification: the closed canonical table with sorted codes", () => {
  assert.ok(BIM_CLASSIFICATION_CODES.length >= 11);
  assert.deepEqual([...BIM_CLASSIFICATION_CODES], [...BIM_CLASSIFICATION_CODES].slice().sort());
  for (const code of BIM_CLASSIFICATION_CODES) {
    const entry = BIM_CLASSIFICATION_TABLE[code]!;
    assert.ok(entry.label.length > 0);
    assert.ok(entry.appliesTo.length >= 1);
  }
});

test("classification: applies-to gates reject cross-type classification", () => {
  assert.equal(validateBimMeta("bim.wall", { classificationRef: "OFFISOS-ARCH-100" }, "meta")?.classificationRef, "OFFISOS-ARCH-100");
  assertInvalid(
    () => validateBimMeta("bim.wall", { classificationRef: "OFFISOS-ARCH-160" }, "meta"),
    /does not apply to bim\.wall/,
  );
  assertInvalid(
    () => validateBimMeta("bim.roof", { classificationRef: "NOT-A-CODE" }, "meta"),
    /not a canonical classification code/,
  );
});

// ---------------------------------------------------------------------------
// Property sets
// ---------------------------------------------------------------------------

test("propertySets: valid structured sets round-trip with insertion order", () => {
  const sets = [
    {
      name: "Pset_OffisosCommon",
      properties: [
        { key: "FireRating", value: "REI60" },
        { key: "LoadBearing", value: true },
        { key: "ThermalTransmittance", value: 0.35 },
      ],
    },
  ];
  const validated = validatePropertySets(sets, "propertySets");
  assert.equal(validated.length, 1);
  assert.deepEqual(validated[0]!.properties.map((p) => p.key), ["FireRating", "LoadBearing", "ThermalTransmittance"]);
  const meta = validateBimMeta("bim.wall", { propertySets: sets }, "meta");
  assert.deepEqual(meta?.propertySets, validated);
});

test("propertySets: bounded counts, canonical keys, typed values, uniqueness", () => {
  assertInvalid(() => validatePropertySets([{ name: "S", properties: [] }, { name: "S", properties: [] }], "p"), /already taken/);
  assertInvalid(
    () => validatePropertySets([{ name: "S", properties: [{ key: "A", value: 1 }, { key: "A", value: 2 }] }], "p"),
    /already taken within set/,
  );
  assertInvalid(
    () => validatePropertySets([{ name: "S", properties: [{ key: "9bad", value: 1 }] }], "p"),
    /canonical key pattern/,
  );
  assertInvalid(
    () => validatePropertySets([{ name: "S", properties: [{ key: "A", value: null }] }], "p"),
    /string, finite number or boolean/,
  );
  assertInvalid(
    () => validatePropertySets([{ name: "S", properties: [{ key: "A", value: NaN }] }], "p"),
    /string, finite number or boolean/,
  );
  const tooManySets = Array.from({ length: BIM_MAX_PROPERTY_SETS + 1 }, (_, i) => ({
    name: `S${i}`,
    properties: [],
  }));
  assertInvalid(() => validatePropertySets(tooManySets, "p"), new RegExp(`${BIM_MAX_PROPERTY_SETS}-set bound`));
  const tooManyProps = {
    name: "S",
    properties: Array.from({ length: BIM_MAX_PROPERTIES_PER_SET + 1 }, (_, i) => ({ key: `K${i}`, value: i })),
  };
  assertInvalid(() => validatePropertySets([tooManyProps], "p"), new RegExp(`${BIM_MAX_PROPERTIES_PER_SET}-property bound`));
});

// ---------------------------------------------------------------------------
// Renovation + option membership
// ---------------------------------------------------------------------------

test("renovation: the closed three-state vocabulary on eligible types only", () => {
  assert.deepEqual([...BIM_RENOVATION_STATES], ["existing", "new", "to-be-demolished"]);
  assert.ok(BIM_RENOVATION_ELIGIBLE.includes("bim.roof"));
  assert.ok(BIM_RENOVATION_ELIGIBLE.includes("bim.zone"));
  assert.ok(!BIM_RENOVATION_ELIGIBLE.includes("bim.story"));
  assert.equal(validateBimMeta("bim.wall", { renovationStatus: "new" }, "meta")?.renovationStatus, "new");
  assertInvalid(() => validateBimMeta("bim.wall", { renovationStatus: "demolished" }, "meta"), /must be one of/);
  assertInvalid(() => validateBimMeta("bim.story", { renovationStatus: "new" }, "meta"), /not supported on bim.story/);
  // The derived default.
  assert.equal(effectiveRenovationStatus(undefined), "existing");
  assert.equal(effectiveRenovationStatus({ renovationStatus: "to-be-demolished" }), "to-be-demolished");
});

test("option membership: the pair is both-present-or-both-absent", () => {
  assert.equal(validateBimMeta("bim.wall", { optionGroupId: "g1", option: "A" }, "meta")?.optionGroupId, "g1");
  assertInvalid(() => validateBimMeta("bim.wall", { optionGroupId: "g1" }, "meta"), /option must be a non-empty string/);
  assertInvalid(() => validateBimMeta("bim.wall", { option: "A" }, "meta"), /optionGroupId must be a non-empty string/);
  // Unknown meta keys are rejected (LOCK-007 — no silent partial overlays).
  assertInvalid(() => validateBimMeta("bim.wall", { bogus: 1 }, "meta"), /not a recognized meta field/);
});

// ---------------------------------------------------------------------------
// Roof entities
// ---------------------------------------------------------------------------

test("roof: valid construction + the canonical element round-trip", () => {
  const roof = makeRoof({
    storyId: "story-1",
    corner1: [0, 0],
    corner2: [8000, 6000],
    ridgeAxis: "x",
    height: 1500,
    topStoryId: "story-2",
    name: "Main roof",
  });
  assert.equal(roof.type, "bim.roof");
  const el = bimEntityToElement({ ...roof, id: "roof-1" });
  assert.equal(el.kind, "bim");
  const back = elementToBimEntity(el);
  assert.equal(back.type, "bim.roof");
  assert.deepEqual(back, { ...roof, id: "roof-1" });
});

test("roof: typed rejections for invalid parameters", () => {
  assertInvalid(() => makeRoof({ storyId: "s", corner1: [0, 0], corner2: [0, 6000], height: 1 }), /non-degenerate/);
  assertInvalid(() => makeRoof({ storyId: "s", corner1: [0, 0], corner2: [1, 1], ridgeAxis: "z", height: 1 }), /ridgeAxis/);
  assertInvalid(() => makeRoof({ storyId: "s", corner1: [0, 0], corner2: [1, 1], height: 0 }), /roof.height must be > 0/);
  assertInvalid(() => makeRoof({ storyId: "", corner1: [0, 0], corner2: [1, 1], height: 1 }), /storyId/);
});

// ---------------------------------------------------------------------------
// Stair entities
// ---------------------------------------------------------------------------

test("stair: valid construction + the canonical element round-trip (with landing + meta)", () => {
  const stair = makeStair({
    storyId: "story-gf",
    topStoryId: "story-ff",
    start: [1000, 1000],
    direction: [1, 0],
    width: 1200,
    stepCount: 16,
    tread: 280,
    landingLength: 1200,
    meta: { classificationRef: "OFFISOS-ARCH-130", renovationStatus: "new" },
  });
  assert.equal(stair.landingLength, 1200);
  assert.equal(stair.meta?.classificationRef, "OFFISOS-ARCH-130");
  const el = bimEntityToElement({ ...stair, id: "stair-1" });
  const back = elementToBimEntity(el) as typeof stair & { id: string };
  assert.equal(back.meta?.renovationStatus, "new");
  // A zero landingLength is the canonical ABSENT key (byte-identity for the
  // default form).
  const noLanding = makeStair({ storyId: "a", topStoryId: "b", start: [0, 0], direction: [0, 1], width: 1, stepCount: 2, tread: 1, landingLength: 0 });
  assert.equal(noLanding.landingLength, undefined);
  assert.ok(!("landingLength" in (bimEntityToElement({ ...noLanding, id: "x" }).props as Record<string, unknown>)));
});

test("stair: typed rejections for invalid parameters", () => {
  const base = { storyId: "a", topStoryId: "b", start: [0, 0] as const, width: 1200, tread: 280 };
  assertInvalid(() => makeStair({ ...base, direction: [1, 1], stepCount: 2 }), /unit vector/);
  assertInvalid(() => makeStair({ ...base, direction: [1, 0], stepCount: 1 }), new RegExp(`between ${BIM_STAIR_MIN_STEPS} and ${BIM_STAIR_MAX_STEPS}`));
  assertInvalid(() => makeStair({ ...base, direction: [1, 0], stepCount: BIM_STAIR_MAX_STEPS + 1 }), new RegExp(`between ${BIM_STAIR_MIN_STEPS} and ${BIM_STAIR_MAX_STEPS}`));
  assertInvalid(() => makeStair({ ...base, direction: [1, 0], stepCount: 2.5 }), /integer/);
  assertInvalid(() => makeStair({ ...base, direction: [1, 0], stepCount: 2, tread: 0 }), /tread must be > 0/);
  assertInvalid(() => makeStair({ ...base, direction: [1, 0], stepCount: 2, tread: 1, topStoryId: "" }), /topStoryId/);
});

// ---------------------------------------------------------------------------
// Railing / zone / optionGroup entities
// ---------------------------------------------------------------------------

test("railing: valid construction + typed rejections", () => {
  const railing = makeRailing({ hostId: "stair-1", side: "right", height: 900 });
  assert.equal(railing.side, "right");
  // side defaults to left (the canonical default).
  assert.equal(makeRailing({ hostId: "s", height: 900 }).side, "left");
  assertInvalid(() => makeRailing({ hostId: "s" }), /railing.height must be a finite number/);
  assertInvalid(() => makeRailing({ hostId: "s", side: "middle" }), /side must be/);
  assertInvalid(() => makeRailing({ hostId: "s", height: 0 }), /height must be > 0/);
});

test("zone: membership validation (≥ 1 unique spaces)", () => {
  const zone = makeZone({ name: "Office wing", spaceIds: ["space-1", "space-2"] });
  assert.deepEqual(zone.spaceIds, ["space-1", "space-2"]);
  assertInvalid(() => makeZone({ name: "Z", spaceIds: [] }), /at least 1 space/);
  assertInvalid(() => makeZone({ name: "Z", spaceIds: ["a", "a"] }), /must not repeat/);
  assertInvalid(() => makeZone({ name: "", spaceIds: ["a"] }), /non-empty/);
});

test("optionGroup: the closed option vocabulary with the active selection", () => {
  const group = makeOptionGroup({ name: "Facade", options: ["Glazed", "Solid"], activeOption: "Glazed", description: "Facade variants" });
  assert.equal(group.activeOption, "Glazed");
  assertInvalid(
    () => makeOptionGroup({ name: "G", options: ["A"], activeOption: "A" }),
    new RegExp(`at least ${BIM_OPTION_GROUP_MIN_OPTIONS} options`),
  );
  assertInvalid(
    () => makeOptionGroup({ name: "G", options: Array.from({ length: BIM_OPTION_GROUP_MAX_OPTIONS + 1 }, (_, i) => `O${i}`), activeOption: "O1" }),
    new RegExp(`${BIM_OPTION_GROUP_MAX_OPTIONS}-option bound`),
  );
  assertInvalid(() => makeOptionGroup({ name: "G", options: ["A", "A"], activeOption: "A" }), /distinct alternatives/);
  assertInvalid(() => makeOptionGroup({ name: "G", options: ["A", "B"], activeOption: "C" }), /must be one of the declared options/);
});

// ---------------------------------------------------------------------------
// The meta overlay on pre-existing entity types (additive, byte-identity)
// ---------------------------------------------------------------------------

test("meta: absent overlay keeps the canonical props layout byte-identical", () => {
  const wall = makeWall({ storyId: "s", start: [0, 0], end: [1000, 0], width: 240, height: 3000 });
  const props = bimEntityToElement({ ...wall, id: "w1" }).props as Record<string, unknown>;
  assert.equal(props.meta, undefined);
  const withMeta = makeWall({ storyId: "s", start: [0, 0], end: [1000, 0], width: 240, height: 3000, meta: { renovationStatus: "new" } });
  const props2 = bimEntityToElement({ ...withMeta, id: "w1" }).props as Record<string, unknown>;
  assert.deepEqual(props2.meta, { renovationStatus: "new" });
});

test("meta: the stored overlay re-validates on the strict entity round-trip", () => {
  const wall = makeWall({
    storyId: "s",
    start: [0, 0],
    end: [1000, 0],
    width: 240,
    height: 3000,
    meta: { classificationRef: "OFFISOS-ARCH-100", propertySets: [{ name: "P", properties: [{ key: "K", value: "v" }] }] },
  });
  const el = bimEntityToElement({ ...wall, id: "w1" });
  const back = elementToBimEntity(el);
  assert.equal((back as { meta?: { classificationRef?: string } }).meta?.classificationRef, "OFFISOS-ARCH-100");
  // A MALFORMED stored overlay is a typed rejection on load (LOCK-007 —
  // stored props are never trusted).
  const bad = { ...el, props: { ...(el.props as Record<string, unknown>), meta: { renovationStatus: "bogus" } } };
  assertInvalid(() => elementToBimEntity(bad as Parameters<typeof elementToBimEntity>[0]), /must be one of/);
});

test("all new entity types join the BimEntity union and element mapping", () => {
  const entities: BimEntity[] = [
    { ...makeRoof({ storyId: "s", corner1: [0, 0], corner2: [1, 1], height: 1 }), id: "r" },
    { ...makeStair({ storyId: "a", topStoryId: "b", start: [0, 0], direction: [1, 0], width: 1, stepCount: 2, tread: 1 }), id: "t" },
    { ...makeRailing({ hostId: "t", height: 900 }), id: "l" },
    { ...makeZone({ name: "Z", spaceIds: ["sp"] }), id: "z" },
    { ...makeOptionGroup({ name: "G", options: ["A", "B"], activeOption: "A" }), id: "o" },
  ];
  for (const entity of entities) {
    const el = bimEntityToElement(entity);
    assert.equal(el.kind, "bim");
    const back = elementToBimEntity(el);
    assert.equal(back.id, entity.id);
    assert.equal(back.type, entity.type);
  }
});
