/**
 * CAD-PARITY-002 — workspace command registry + typed input: deterministic
 * resolution by name/alias, search ranking, AutoCAD-class coordinate syntax
 * parsing with explicit failures (Issue #75; CAD-P-002 command system,
 * CAD-UX-002 keyboard-first parity).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTypedInput,
  resolveTypedDistance,
  resolveTypedPoint,
} from "../src/workspace/typed-input.js";
import {
  WORKSPACE_COMMANDS,
  commandById,
  resolveCommand,
  searchCommands,
  projectOnWall,
} from "../src/workspace/commands.js";

// --- Registry resolution ----------------------------------------------------

test("registry: every command resolves by canonical name (case-insensitive)", () => {
  for (const command of WORKSPACE_COMMANDS) {
    assert.equal(resolveCommand(command.name), command);
    assert.equal(resolveCommand(command.name.toLowerCase()), command);
  }
});

test("registry: AutoCAD-class aliases resolve (L, C, PL, WA, M, CO, E, U)", () => {
  assert.equal(resolveCommand("L")?.id, "line");
  assert.equal(resolveCommand("C")?.id, "circle");
  assert.equal(resolveCommand("PL")?.id, "polyline");
  assert.equal(resolveCommand("A")?.id, "arc");
  assert.equal(resolveCommand("REC")?.id, "rectangle");
  assert.equal(resolveCommand("ST")?.id, "story");
  assert.equal(resolveCommand("WA")?.id, "wall");
  assert.equal(resolveCommand("SL")?.id, "slab");
  assert.equal(resolveCommand("DR")?.id, "door");
  assert.equal(resolveCommand("WN")?.id, "window");
  assert.equal(resolveCommand("M")?.id, "move");
  assert.equal(resolveCommand("CO")?.id, "copy");
  assert.equal(resolveCommand("E")?.id, "erase");
  assert.equal(resolveCommand("U")?.id, "undo");
  assert.equal(resolveCommand("l ")?.id, "line", "whitespace tolerated");
});

test("registry: unknown tokens return null (never a fuzzy guess)", () => {
  assert.equal(resolveCommand("LINEEE"), null);
  assert.equal(resolveCommand(""), null);
  assert.equal(resolveCommand("  "), null);
});

test("registry: command ids are unique and every interactive command has a builder", () => {
  const ids = new Set<string>();
  for (const command of WORKSPACE_COMMANDS) {
    assert.equal(ids.has(command.id), false, `duplicate id ${command.id}`);
    ids.add(command.id);
    if (command.steps.length > 0) {
      assert.equal(typeof command.build, "function", `${command.id} has steps and must have a builder`);
    } else {
      assert.equal(typeof command.instant, "function", `${command.id} has no steps and must be instant`);
    }
  }
});

test("registry: representative set is present (draw + BIM + modify + document + aids)", () => {
  const ids = new Set(WORKSPACE_COMMANDS.map((c) => c.id));
  for (const id of ["line", "polyline", "circle", "arc", "rectangle", "story", "wall", "slab", "door", "window", "move", "copy", "erase", "trim", "extend", "undo", "redo", "save", "new", "zoomextents", "layer", "properties", "navigator", "commandsearch", "help", "workspace", "osnap-toggle", "grid-toggle", "ortho-toggle", "snap-toggle", "polar-toggle", "otrack-toggle", "selectall", "cancel"]) {
    assert.equal(ids.has(id), true, `missing command ${id}`);
  }
});

// --- Search (command palette) ------------------------------------------------

test("search: exact name outranks prefix, alias and substring", () => {
  const hits = searchCommands("LINE");
  assert.equal(hits.length > 0, true);
  assert.equal(hits[0]!.command.id, "line");
  // PREFIX matches must outrank substring matches.
  const withSub = searchCommands("LA");
  const layerIdx = withSub.findIndex((h) => h.command.id === "layer");
  assert.equal(layerIdx, 0, "LAYER (alias LA) is the top hit for 'LA'");
});

test("search: deterministic ordering for identical queries", () => {
  const a = searchCommands("POLY");
  const b = searchCommands("POLY");
  assert.deepEqual(a.map((h) => h.command.id), b.map((h) => h.command.id));
  assert.equal(a[0]!.command.id, "polyline");
});

test("search: empty query returns every command in registry order", () => {
  const all = searchCommands("");
  assert.equal(all.length, WORKSPACE_COMMANDS.length);
  assert.equal(all.every((h) => h.score === 100), true);
});

test("search: description substring matches as the weakest rank", () => {
  const hits = searchCommands("BUILDING STORY");
  assert.equal(hits.some((h) => h.command.id === "story"), true);
  assert.equal(hits.every((h) => h.score >= 6), true, "description matches are the weakest rank");
});

// --- Typed input classification ----------------------------------------------

test("typed input: cartesian forms classify as points", () => {
  assert.deepEqual(classifyTypedInput("1200,300"), { kind: "point", point: [1200, 300], relative: false });
  assert.deepEqual(classifyTypedInput(" 1200 , 300 "), { kind: "point", point: [1200, 300], relative: false });
  assert.deepEqual(classifyTypedInput("-50.5,0"), { kind: "point", point: [-50.5, 0], relative: false });
});

test("typed input: relative and polar forms carry as unresolved markers", () => {
  assert.deepEqual(classifyTypedInput("@500,0"), { kind: "text", text: "@500,0" });
  assert.deepEqual(classifyTypedInput("@1000<90"), { kind: "text", text: "@1000<90" });
  const polar = classifyTypedInput("1000<45");
  assert.equal(polar.kind, "point");
  if (polar.kind === "point") {
    assert.ok(Math.abs(polar.point[0] - 1000 * Math.cos(Math.PI / 4)) < 1e-9);
    assert.ok(Math.abs(polar.point[1] - 1000 * Math.sin(Math.PI / 4)) < 1e-9);
  }
});

test("typed input: numbers classify as numbers", () => {
  assert.deepEqual(classifyTypedInput("500"), { kind: "number", value: 500 });
  assert.deepEqual(classifyTypedInput("-3.5"), { kind: "number", value: -3.5 });
  assert.deepEqual(classifyTypedInput("@500"), { kind: "distance", distance: 500 });
});

// --- Point resolution ---------------------------------------------------------

test("point resolution: absolute cartesian", () => {
  const r = resolveTypedPoint("100,200", null, null);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.point, [100, 200]);
});

test("point resolution: relative cartesian requires a base", () => {
  const noBase = resolveTypedPoint("@500,0", null, null);
  assert.equal(noBase.ok, false);
  if (!noBase.ok) assert.match(noBase.reason, /base point/i);

  const withBase = resolveTypedPoint("@500,0", [100, 100], null);
  assert.equal(withBase.ok, true);
  if (withBase.ok) assert.deepEqual(withBase.point, [600, 100]);
});

test("point resolution: relative polar in degrees", () => {
  const r = resolveTypedPoint("@1000<90", [0, 0], null);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(Math.abs(r.point[0]) < 1e-9);
    assert.ok(Math.abs(r.point[1] - 1000) < 1e-9);
  }
  const diag = resolveTypedPoint("@1000<45", [0, 0], null);
  assert.equal(diag.ok, true);
  if (diag.ok) {
    assert.ok(Math.abs(diag.point[0] - 707.1067811865476) < 1e-9);
    assert.ok(Math.abs(diag.point[1] - 707.1067811865476) < 1e-9);
  }
});

test("point resolution: direct distance entry along the cursor direction", () => {
  const r = resolveTypedPoint("500", [100, 0], [200, 0]);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.point, [600, 0]);

  const noCursor = resolveTypedPoint("500", [100, 0], null);
  assert.equal(noCursor.ok, false);
  if (!noCursor.ok) assert.match(noCursor.reason, /cursor/i);

  const noBase = resolveTypedPoint("500", null, [200, 0]);
  assert.equal(noBase.ok, false);
});

test("point resolution: malformed input fails explicitly", () => {
  const r = resolveTypedPoint("abc,def", null, null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /cannot parse/i);
  const neg = resolveTypedPoint("-500", [0, 0], [10, 0]);
  assert.equal(neg.ok, false);
});

test("distance resolution: positive number, pick-equivalent form", () => {
  const r = resolveTypedDistance("500", null, null);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.point, [500, 0]);
  const zero = resolveTypedDistance("0", null, null);
  assert.equal(zero.ok, false);
});

// --- Wall projection (DOOR/WINDOW position) -----------------------------------

test("projectOnWall: inside span returns the distance; outside is null (no clamping)", () => {
  const wall = {
    id: "w1",
    kind: "bim",
    props: { bim: true, type: "bim.wall", storyId: "s1", start: [0, 0], end: [5000, 0], width: 240, height: 3000 },
  };
  assert.equal(projectOnWall(wall, [1000, 700]), 1000);
  assert.equal(projectOnWall(wall, [-1, 0]), null);
  assert.equal(projectOnWall(wall, [5001, 0]), null);
  assert.equal(projectOnWall(wall, [5000, 0]), 5000);
});

test("projectOnWall: oblique walls project along the axis", () => {
  const wall = {
    id: "w2",
    kind: "bim",
    props: { bim: true, type: "bim.wall", storyId: "s1", start: [0, 0], end: [3000, 4000], width: 240, height: 3000 },
  };
  const d = projectOnWall(wall, [1500, 2000]);
  assert.ok(d !== null && Math.abs(d - 2500) < 1e-9);
});
