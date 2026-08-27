/**
 * COMPAT-CAD-002 — BIM element constructors, validation and round-trips.
 *
 * LOCK-007: every malformed input is REJECTED with a descriptive error;
 * nothing is guessed or silently repaired. Deterministic expectations with
 * declared tolerances.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIM_MAX_PROFILE_POINTS,
  bimEntityToElement,
  elementToBimEntity,
  isBimElement,
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  polygonArea,
} from "../src/bim/elements.js";

test("story: valid construction with defaults", () => {
  const story = makeStory({ level: 0, height: 3000 });
  assert.deepEqual(story, { type: "bim.story", name: "", level: 0, height: 3000 });
  assert.deepEqual(makeStory({ name: "Ground Floor", level: -3000, height: 3200 }).name, "Ground Floor");
});

test("story: rejects non-finite level, non-positive height, non-string name", () => {
  assert.throws(() => makeStory({ level: Number.NaN, height: 3000 }), /story\.level/);
  assert.throws(() => makeStory({ level: 0, height: 0 }), /story\.height/);
  assert.throws(() => makeStory({ level: 0, height: 3000, name: 7 }), /story\.name/);
});

test("wall: valid construction with default baseOffset and optional name", () => {
  const wall = makeWall({ storyId: "el-000001", start: [0, 0], end: [6000, 0], width: 300, height: 3000 });
  assert.equal(wall.baseOffset, 0);
  assert.equal(wall.name, undefined);
  const named = makeWall({ storyId: "el-000001", start: [0, 0], end: [1, 0], width: 300, height: 3000, name: "W-1" });
  assert.equal(named.name, "W-1");
});

test("wall: rejects coincident axis, non-positive width/height, missing storyId", () => {
  assert.throws(() => makeWall({ storyId: "s", start: [0, 0], end: [0, 0], width: 300, height: 3000 }), /coincide/);
  assert.throws(() => makeWall({ storyId: "s", start: [0, 0], end: [1, 0], width: 0, height: 3000 }), /wall\.width/);
  assert.throws(() => makeWall({ storyId: "", start: [0, 0], end: [1, 0], width: 300, height: 3000 }), /storyId/);
  assert.throws(() => makeWall({ storyId: "s", start: [0, Number.POSITIVE_INFINITY], end: [1, 0], width: 300, height: 3000 }), /wall\.start/);
});

test("slab: rejects degenerate footprints and validates thickness", () => {
  assert.throws(() => makeSlab({ storyId: "s", corner1: [0, 0], corner2: [0, 5000], thickness: 200 }), /non-degenerate/);
  assert.throws(() => makeSlab({ storyId: "s", corner1: [0, 0], corner2: [6000, 5000], thickness: -1 }), /thickness/);
  assert.equal(makeSlab({ storyId: "s", corner1: [0, 0], corner2: [6000, 5000], thickness: 200 }).baseOffset, 0);
});

test("opening: validates distance/sill non-negative and sizes positive", () => {
  assert.throws(() => makeOpening({ hostId: "w", distance: -1, width: 900, height: 2100, sill: 0 }), /distance/);
  assert.throws(() => makeOpening({ hostId: "w", distance: 0, width: 900, height: 2100, sill: -5 }), /sill/);
  assert.throws(() => makeOpening({ hostId: "w", distance: 0, width: 0, height: 2100, sill: 0 }), /width/);
  assert.throws(() => makeOpening({ hostId: "", distance: 0, width: 900, height: 2100, sill: 0 }), /hostId/);
});

test("door: swing validation + leafThickness default", () => {
  assert.throws(() => makeDoor({ openingId: "o", storyId: "s", swing: "both" }), /swing/);
  const door = makeDoor({ openingId: "o", storyId: "s" });
  assert.equal(door.swing, "left");
  assert.equal(door.leafThickness, 40);
});

test("window: requires openingId + storyId", () => {
  assert.throws(() => makeWindow({ openingId: "o" }), /storyId/);
  assert.deepEqual(makeWindow({ openingId: "o", storyId: "s" }), { type: "bim.window", openingId: "o", storyId: "s" });
});

test("space: area is computed at creation via the shoelace magnitude", () => {
  const space = makeSpace({
    storyId: "s",
    name: "Office 1",
    footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]],
    height: 3000,
  });
  assert.equal(space.area, 27_000_000); // 27 m² in mm²
  // Winding independence: reversed footprint → identical area.
  const reversed = makeSpace({
    storyId: "s",
    name: "Office 1",
    footprint: [[0, 6000], [3000, 6000], [3000, 3000], [6000, 3000], [6000, 0], [0, 0]],
    height: 3000,
  });
  assert.equal(reversed.area, space.area);
});

test("space: rejects empty name, degenerate and malformed footprints", () => {
  assert.throws(() => makeSpace({ storyId: "s", name: "", footprint: [[0, 0], [1, 0], [0, 1]], height: 3000 }), /name/);
  assert.throws(() => makeSpace({ storyId: "s", name: "x", footprint: [[0, 0], [1, 0]], height: 3000 }), /at least 3/);
  // Repeated closing point (first == last) is rejected via the coincidence rule.
  assert.throws(
    () => makeSpace({ storyId: "s", name: "x", footprint: [[0, 0], [1, 0], [0, 1], [0, 0]], height: 3000 }),
    /coincides with its successor/,
  );
  // Consecutive duplicate points rejected.
  assert.throws(
    () => makeSpace({ storyId: "s", name: "x", footprint: [[0, 0], [5, 5], [5, 5], [0, 1]], height: 3000 }),
    /coincides with its successor/,
  );
  // Collinear zero-area footprint rejected.
  assert.throws(
    () => makeSpace({ storyId: "s", name: "x", footprint: [[0, 0], [1, 1], [2, 2]], height: 3000 }),
    /non-degenerate area/,
  );
});

test("footprint bound: profiles above the point-count limit are rejected", () => {
  const big: [number, number][] = [];
  for (let i = 0; i < BIM_MAX_PROFILE_POINTS + 1; i++) big.push([i, i % 7]);
  assert.throws(
    () => makeSpace({ storyId: "s", name: "x", footprint: big, height: 3000 }),
    new RegExp(`${BIM_MAX_PROFILE_POINTS}-point bound`),
  );
});

test("polygonArea: shoelace magnitude matches exact expectations", () => {
  assert.equal(polygonArea([[0, 0], [1000, 0], [1000, 1000], [0, 1000]]), 1_000_000);
  assert.equal(polygonArea([[0, 0], [2000, 0], [0, 1000]]), 1_000_000);
});

test("element ⇄ entity round-trip: canonical props survive strict re-validation", () => {
  const wall = { id: "el-000002", ...makeWall({ storyId: "el-000001", start: [100, 200], end: [5100, 200], width: 300, height: 3000, name: "W-South" }) };
  const element = bimEntityToElement(wall);
  assert.equal(element.kind, "bim");
  assert.equal(element.engineId, null, "authored BIM elements are engine-free until a realized build");
  assert.equal(isBimElement(element), true);
  assert.deepEqual(elementToBimEntity(element), wall);
});

test("elementToBimEntity throws for mutated/illegal stored props", () => {
  const wall = { id: "el-000002", ...makeWall({ storyId: "el-000001", start: [0, 0], end: [5000, 0], width: 300, height: 3000 }) };
  const element = bimEntityToElement(wall);
  const mutated = { ...element, props: { ...element.props, width: -5 } };
  assert.throws(() => elementToBimEntity(mutated), /wall\.width/);
});

test("isBimElement: false for drafting entities and unmarked elements", () => {
  assert.equal(isBimElement({ id: "x", kind: "bim", engineId: null, props: { meshToken: "m" } }), false);
  assert.equal(isBimElement({ id: "x", kind: "geometry", engineId: null, props: { drafting: true, type: "line" } }), false);
  assert.equal(isBimElement(bimEntityToElement({ id: "", ...makeStory({ level: 0, height: 3000 }) })), true);
});
