/**
 * CAD-PARITY-002 — deterministic selection, grips, drafting-aid feedback and
 * keymap (Issue #75; CAD-P-004 + CAD-UX-002/003). The same helpers drive the
 * Web canvas and the Electron canvas — these tests ARE the parity contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Element } from "../src/contracts/caddocument.js";
import { draftEntityToElement, makeCircle, makeLine, makeRectangle } from "../src/drafting/entities.js";
import {
  applyPickModifier,
  cyclePick,
  hitTest,
  pickAt,
  selectionRectangle,
  windowSelect,
} from "../src/workspace/selection.js";
import { gripDrag, gripsFor } from "../src/workspace/grips.js";
import { DEFAULT_DRAFTING_AIDS, constrainCursor, formatCoordinate, rubberInfo } from "../src/workspace/feedback.js";
import { mapKeyEvent, temporaryAidOverride } from "../src/workspace/keymap.js";

function line(id: string, from: [number, number], to: [number, number]): Element {
  return { ...draftEntityToElement({ ...makeLine({ from, to, layer: "0" }), id }) };
}
function circle(id: string, center: [number, number], radius: number): Element {
  return { ...draftEntityToElement({ ...makeCircle({ center, radius, layer: "0" }), id }) };
}
function rect(id: string, corner1: [number, number], corner2: [number, number]): Element {
  return { ...draftEntityToElement({ ...makeRectangle({ corner1, corner2, layer: "0" }), id }) };
}
function wall(id: string, start: [number, number], end: [number, number], width = 240): Element {
  return {
    id,
    kind: "bim",
    engineId: null,
    props: { bim: true, type: "bim.wall", storyId: "story-gf", start, end, width, height: 3000 },
  };
}
function slab(id: string, corner1: [number, number], corner2: [number, number]): Element {
  return {
    id,
    kind: "bim",
    engineId: null,
    props: { bim: true, type: "bim.slab", storyId: "story-gf", corner1, corner2, thickness: 200 },
  };
}

// --- Hit testing + ranking -------------------------------------------------------

test("hitTest: ranks by distance then id; deterministic total order", () => {
  const elements = [line("b", [0, 0], [10, 0]), line("a", [0, 0], [10, 0])];
  const hits = hitTest([5, 0.4], 0.5, elements);
  assert.equal(hits.length, 2);
  // Equal distances → id ascending.
  assert.equal(hits[0]!.id, "a");
  assert.equal(hits[1]!.id, "b");
});

test("hitTest: circle boundary, wall band and slab interior", () => {
  const elements = [circle("c1", [20, 500], 3), wall("w1", [0, 0], [5000, 0], 240), slab("s1", [100, 100], [200, 200])];
  assert.equal(pickAt([23, 500.4], 0.5, elements), "c1");
  assert.equal(pickAt([1000, 100], 1, elements), "w1", "inside the wall band");
  assert.equal(pickAt([1000, 130], 1, elements), null, "outside the wall band");
  assert.equal(pickAt([150, 150], 1, elements), "s1");
  assert.equal(pickAt([250, 150], 1, elements), null);
});

test("hitTest: tolerance boundary is inclusive", () => {
  const elements = [line("l1", [0, 0], [10, 0])];
  assert.equal(pickAt([5, 0.5], 0.5, elements), "l1");
  assert.equal(pickAt([5, 0.6], 0.5, elements), null);
});

test("cyclePick: wraps through stacked candidates deterministically", () => {
  const elements = [line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 0]), line("c", [0, 0], [10, 0])];
  const first = cyclePick([5, 0], 0.5, elements, -1);
  assert.equal(first?.id, "a");
  const second = cyclePick([5, 0], 0.5, elements, first!.index);
  assert.equal(second?.id, "b");
  const third = cyclePick([5, 0], 0.5, elements, second!.index);
  assert.equal(third?.id, "c");
  const wrapped = cyclePick([5, 0], 0.5, elements, third!.index);
  assert.equal(wrapped?.id, "a");
});

// --- Click modifiers --------------------------------------------------------------

test("applyPickModifier: replace, toggle-add, toggle-remove", () => {
  assert.deepEqual(applyPickModifier([], "x", "replace"), ["x"]);
  assert.deepEqual(applyPickModifier(["a"], "x", "replace"), ["x"]);
  assert.deepEqual(applyPickModifier(["a"], "x", "toggle"), ["a", "x"]);
  assert.deepEqual(applyPickModifier(["a", "x"], "x", "toggle"), ["a"]);
});

// --- Window / crossing selection ---------------------------------------------------

test("selectionRectangle: left-to-right is window, right-to-left is crossing", () => {
  assert.equal(selectionRectangle([0, 0], [10, 10]).mode, "window");
  assert.equal(selectionRectangle([10, 10], [0, 0]).mode, "crossing");
  assert.deepEqual(selectionRectangle([10, 10], [0, 0]).min, [0, 0]);
});

test("windowSelect: window mode selects only fully contained entities", () => {
  const elements = [
    line("inside", [1, 1], [9, 1]),
    line("crossing", [5, 1], [15, 1]),
    circle("inside-circle", [5, 5], 2),
    circle("crossing-circle", [9, 5], 3),
  ];
  const rect = selectionRectangle([0, 0], [10, 10]);
  assert.equal(rect.mode, "window");
  assert.deepEqual(windowSelect(rect, elements), ["inside", "inside-circle"]);
});

test("windowSelect: crossing mode selects intersecting entities too", () => {
  const elements = [
    line("inside", [1, 1], [9, 1]),
    line("crossing", [5, 1], [15, 1]),
    line("outside", [20, 20], [30, 20]),
    wall("w1", [4, -1], [4, 12]),
    slab("s1", [-5, 2], [-1, 4]),
  ];
  const rect = selectionRectangle([10, 10], [0, 0]); // right-to-left
  assert.equal(rect.mode, "crossing");
  assert.deepEqual(windowSelect(rect, elements), ["inside", "crossing", "w1"]);
});

test("windowSelect: result is in document order (not hit-rank order)", () => {
  const elements = [line("z", [1, 1], [9, 1]), line("a", [1, 5], [9, 5])];
  const rect = selectionRectangle([0, 0], [10, 10]);
  assert.deepEqual(windowSelect(rect, elements), ["z", "a"]);
});

// --- Grips -------------------------------------------------------------------------

test("gripsFor: line endpoints + move grip; circle center + radius grips; wall endpoints", () => {
  const l = line("l1", [0, 0], [100, 0]);
  const lg = gripsFor(l);
  assert.equal(lg.length, 3);
  assert.deepEqual(lg.map((g) => g.id), ["from", "to", "move"]);

  const c = circle("c1", [10, 10], 5);
  const cg = gripsFor(c);
  assert.deepEqual(cg.map((g) => g.id), ["center", "radius-e", "radius-w", "radius-n", "radius-s"]);

  const w = wall("w1", [0, 0], [5000, 0]);
  assert.deepEqual(gripsFor(w).map((g) => g.id), ["start", "end", "move"]);
});

test("gripDrag: line endpoint stretch emits a validated updateElement patch", () => {
  const l = line("l1", [0, 0], [100, 0]);
  const result = gripDrag(l, "to", [100, 50]);
  assert.ok(result !== null);
  const edit = (result!.appApi[0]!.payload as { edit: { type: string; elementId: string; patch: Record<string, unknown> } }).edit;
  assert.equal(edit.type, "updateElement");
  assert.equal(edit.elementId, "l1");
  assert.equal(edit.patch.type, "line");
  assert.deepEqual(edit.patch.to, [100, 50]);
  assert.deepEqual(edit.patch.from, [0, 0]);
});

test("gripDrag: circle radius grip recomputes and validates the radius", () => {
  const c = circle("c1", [10, 10], 5);
  const result = gripDrag(c, "radius-e", [18, 10]);
  assert.ok(result !== null);
  const edit = (result!.appApi[0]!.payload as { edit: { patch: Record<string, unknown> } }).edit;
  assert.equal(edit.patch.radius, 8);
});

test("gripDrag: circle radius zero is rejected explicitly", () => {
  const c = circle("c1", [10, 10], 5);
  const result = gripDrag(c, "radius-e", [10, 10]);
  assert.ok(result !== null);
  assert.equal(result!.appApi.length, 0);
  assert.equal(result!.echo.some((l) => /rejected/i.test(l)), true);
});

test("gripDrag: move grip emits the versioned move command (drafting vs BIM)", () => {
  const l = line("l1", [0, 0], [100, 0]);
  const lr = gripDrag(l, "move", [60, 10]);
  assert.deepEqual(lr!.appApi, [{ name: "drafting.move", payload: { ids: ["l1"], dx: 10, dy: 10 } }]);

  const w = wall("w1", [0, 0], [100, 0]);
  const wr = gripDrag(w, "move", [60, 10]);
  assert.deepEqual(wr!.appApi, [{ name: "bim.move", payload: { ids: ["w1"], dx: 10, dy: 10, dz: 0 } }]);
});

test("gripDrag: wall endpoint stretch goes through validated bim.setProperties", () => {
  const w = wall("w1", [0, 0], [5000, 0]);
  const result = gripDrag(w, "end", [6000, 0]);
  assert.deepEqual(result!.appApi, [
    { name: "bim.setProperties", payload: { elementId: "w1", patch: { start: [0, 0], end: [6000, 0] } } },
  ]);
});

// --- Drafting-aid feedback -----------------------------------------------------------

test("constrainCursor: ortho snaps to the dominant axis preserving distance", () => {
  const aids = { ...DEFAULT_DRAFTING_AIDS, ortho: true };
  const f = constrainCursor([0, 0], [300, 100], aids);
  assert.equal(f.aid, "ortho");
  assert.ok(Math.abs(f.point[0] - Math.hypot(300, 100)) < 1e-9);
  assert.equal(f.point[1], 0);

  const fy = constrainCursor([0, 0], [100, 300], aids);
  assert.equal(fy.aid, "ortho");
  assert.equal(fy.point[0], 0);
});

test("constrainCursor: polar snaps to the nearest 15° increment inside the capture window", () => {
  const aids = { ...DEFAULT_DRAFTING_AIDS, polar: true };
  const near45 = constrainCursor([0, 0], [700, 720], aids);
  assert.equal(near45.aid, "polar");
  assert.equal(near45.angleDeg, 45);
  const len = Math.hypot(700, 720);
  assert.ok(Math.abs(near45.point[0] - len * Math.cos(Math.PI / 4)) < 1e-9);

  const farOff = constrainCursor([0, 0], [700, 300], aids); // ~23.2° — outside ±9° of 15/30
  assert.equal(farOff.aid, null);
});

test("constrainCursor: otrack aligns horizontally/vertically near the base extensions", () => {
  const aids = { ...DEFAULT_DRAFTING_AIDS, otrack: true };
  const h = constrainCursor([100, 100], [400, 102], aids);
  assert.equal(h.aid, "otrack");
  assert.deepEqual(h.point, [400, 100]);
  const v = constrainCursor([100, 100], [102, 400], aids);
  assert.equal(v.aid, "otrack");
  assert.deepEqual(v.point, [100, 400]);
  const free = constrainCursor([100, 100], [400, 300], aids);
  assert.equal(free.aid, null);
});

test("constrainCursor: without a base the cursor is free", () => {
  const aids = { ...DEFAULT_DRAFTING_AIDS, ortho: true, polar: true };
  const f = constrainCursor(null, [300, 100], aids);
  assert.equal(f.aid, null);
  assert.deepEqual(f.point, [300, 100]);
});

test("formatCoordinate + rubberInfo are deterministic", () => {
  assert.equal(formatCoordinate([1234.567, 89.1]), "1234.6, 89.1");
  const r = rubberInfo([0, 0], [1000, 1000]);
  assert.ok(Math.abs(r.length - 1414.2135623730951) < 1e-9);
  assert.equal(r.angleDeg, 45);
});

// --- Keymap ---------------------------------------------------------------------------

test("keymap: drafting aid function keys map to toggles", () => {
  const key = (k: string) => ({ key: k, ctrl: false, shift: false, alt: false, meta: false });
  assert.deepEqual(mapKeyEvent(key("F3"), "canvas"), { type: "toggle", aid: "osnap" });
  assert.deepEqual(mapKeyEvent(key("F7"), "canvas"), { type: "toggle", aid: "grid" });
  assert.deepEqual(mapKeyEvent(key("F8"), "canvas"), { type: "toggle", aid: "ortho" });
  assert.deepEqual(mapKeyEvent(key("F9"), "canvas"), { type: "toggle", aid: "snap" });
  assert.deepEqual(mapKeyEvent(key("F10"), "canvas"), { type: "toggle", aid: "polar" });
  assert.deepEqual(mapKeyEvent(key("F11"), "canvas"), { type: "toggle", aid: "otrack" });
});

test("keymap: application chords (search, undo/redo, save, select-all)", () => {
  const ctrl = (k: string, shift = false) => ({ key: k, ctrl: true, shift, alt: false, meta: false });
  assert.deepEqual(mapKeyEvent(ctrl("k"), "canvas"), { type: "palette", palette: "search" });
  assert.deepEqual(mapKeyEvent(ctrl("z"), "canvas"), { type: "command", commandId: "undo" });
  assert.deepEqual(mapKeyEvent(ctrl("z", true), "canvas"), { type: "command", commandId: "redo" });
  assert.deepEqual(mapKeyEvent(ctrl("y"), "canvas"), { type: "command", commandId: "redo" });
  assert.deepEqual(mapKeyEvent(ctrl("s"), "canvas"), { type: "fileSave" });
  assert.deepEqual(mapKeyEvent(ctrl("a"), "canvas"), { type: "selectionAll" });
  assert.deepEqual(mapKeyEvent(ctrl("n"), "canvas"), { type: "fileNew" });
});

test("keymap: Esc/Enter/Del and the command-line zone", () => {
  const key = (k: string) => ({ key: k, ctrl: false, shift: false, alt: false, meta: false });
  assert.deepEqual(mapKeyEvent(key("Escape"), "canvas"), { type: "cancel" });
  assert.deepEqual(mapKeyEvent(key("Enter"), "canvas"), { type: "enter" });
  assert.deepEqual(mapKeyEvent(key("Delete"), "canvas"), { type: "command", commandId: "erase" });
  // While typing in the command line only Esc is mapped — typing stays free.
  assert.deepEqual(mapKeyEvent(key("F8"), "commandLine"), null);
  assert.deepEqual(mapKeyEvent(key("Escape"), "commandLine"), { type: "cancel" });
  // Function keys do nothing in the global zone outside the canvas.
  assert.equal(mapKeyEvent(key("F8"), "global"), null);
});

test("keymap: temporary Shift override forces ortho for one pick", () => {
  assert.deepEqual(temporaryAidOverride({ shift: true }), { forceOrtho: true });
  assert.deepEqual(temporaryAidOverride({ shift: false }), { forceOrtho: false });
});
