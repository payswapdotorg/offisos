/**
 * CAD-PARITY-007 deterministic constraint solver tests (Issue #86) — the
 * bounded propagation engine: the vocabulary grammar, the closed-form
 * applications (authority + fixed-flip rules), the six typed outcomes
 * (solved / under-constrained / over-constrained / unsatisfied / ambiguous /
 * unsupported — explicit and reproducible), the DoF accounting, the
 * fixed-restore cascade, the glyphs and determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Element, ConstraintRecord } from "../src/contracts/caddocument.js";
import {
  ConstraintError,
  ALL_KINDS,
  makeConstraint,
  validateConstraintTargets,
  anchorPosition,
  nearestAnchor,
  entityDof,
  constraintDof,
  constrainableGeomOf,
  constraintGlyphs,
  isConstrainableElement,
} from "../src/workspace/constraints/index.js";
import {
  solveConstraints,
  diagnoseConstraints,
  constraintsReferencing,
} from "../src/workspace/constraints/index.js";
import type { Geom } from "../src/workspace/geometry/types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const TOL = 1e-9;

function el(id: string, props: Record<string, unknown>): Element {
  return { id, kind: "geometry", engineId: null, props: { drafting: true, layer: "0", ...props } };
}

function con(
  id: string,
  kind: string,
  targets: readonly { id: string; anchor?: string }[],
  value?: number,
  mode?: "external" | "internal",
): ConstraintRecord {
  return {
    id,
    kind,
    targets,
    ...(value !== undefined ? { value } : {}),
    ...(mode !== undefined ? { mode } : {}),
    createdAt: NOW,
  } as ConstraintRecord;
}

function line(id: string, x1: number, y1: number, x2: number, y2: number): Element {
  return el(id, { type: "line", x1, y1, x2, y2 });
}

function circle(id: string, cx: number, cy: number, r: number): Element {
  return el(id, { type: "circle", cx, cy, r });
}

function geomOf(result: { geometry: ReadonlyMap<string, Geom> }, id: string): Geom | undefined {
  return result.geometry.get(id);
}

// ---------------------------------------------------------------------------
// The record grammar (makeConstraint — LOCK-007 strict).
// ---------------------------------------------------------------------------

test("makeConstraint: the 11-kind vocabulary with arity + anchor rules", () => {
  assert.equal(ALL_KINDS.length, 11);
  // Valid unary/binary/dimensional records round-trip.
  assert.deepEqual(
    makeConstraint({ id: "con-000001", kind: "horizontal", targets: [{ id: "el-1" }], createdAt: NOW }),
    { id: "con-000001", kind: "horizontal", targets: [{ id: "el-1" }], createdAt: NOW },
  );
  assert.deepEqual(
    makeConstraint({
      id: "con-000002",
      kind: "coincident",
      targets: [
        { id: "el-1", anchor: "end" },
        { id: "el-2", anchor: "start" },
      ],
      createdAt: NOW,
    }),
    {
      id: "con-000002",
      kind: "coincident",
      targets: [
        { id: "el-1", anchor: "end" },
        { id: "el-2", anchor: "start" },
      ],
      createdAt: NOW,
    },
  );
  const dim = makeConstraint({ id: "con-000003", kind: "distance", targets: [{ id: "el-1" }], value: 100, createdAt: NOW });
  assert.equal(dim.value, 100);
  // The id is optional at construction (the document mints).
  const minted = makeConstraint({ kind: "radius", targets: [{ id: "el-9" }], value: 5, createdAt: NOW });
  assert.equal("id" in minted, false);
});

test("makeConstraint: typed rejections (LOCK-007 — reject, never guess)", () => {
  // Unknown kind.
  assert.throws(() => makeConstraint({ kind: "symmetric", targets: [{ id: "a" }], createdAt: NOW }), ConstraintError);
  // Arity violations.
  assert.throws(() => makeConstraint({ kind: "horizontal", targets: [], createdAt: NOW }), ConstraintError);
  assert.throws(
    () => makeConstraint({ kind: "parallel", targets: [{ id: "a" }], createdAt: NOW }),
    ConstraintError,
  );
  assert.throws(
    () => makeConstraint({ kind: "radius", targets: [{ id: "a" }, { id: "b" }], value: 5, createdAt: NOW }),
    ConstraintError,
  );
  // Anchor rules: parallel must not address anchors.
  assert.throws(
    () =>
      makeConstraint({
        kind: "parallel",
        targets: [
          { id: "a", anchor: "start" },
          { id: "b" },
        ],
        createdAt: NOW,
      }),
    ConstraintError,
  );
  // Coincident requires anchors on BOTH targets.
  assert.throws(
    () => makeConstraint({ kind: "coincident", targets: [{ id: "a" }, { id: "b" }], createdAt: NOW }),
    ConstraintError,
  );
  // Dimensional kinds require a positive value; angle < 2π.
  assert.throws(() => makeConstraint({ kind: "radius", targets: [{ id: "a" }], createdAt: NOW }), ConstraintError);
  assert.throws(
    () => makeConstraint({ kind: "radius", targets: [{ id: "a" }], value: 0, createdAt: NOW }),
    ConstraintError,
  );
  assert.throws(
    () => makeConstraint({ kind: "angle", targets: [{ id: "a" }, { id: "b" }], value: Math.PI * 2, createdAt: NOW }),
    ConstraintError,
  );
  // Geometric kinds carry no value; mode is tangent-only.
  assert.throws(
    () => makeConstraint({ kind: "horizontal", targets: [{ id: "a" }], value: 10, createdAt: NOW }),
    ConstraintError,
  );
  assert.throws(
    () => makeConstraint({ kind: "equal", targets: [{ id: "a" }, { id: "b" }], mode: "external", createdAt: NOW }),
    ConstraintError,
  );
  // Distance is all-or-none on anchors (mixed = ambiguous by construction).
  assert.throws(
    () =>
      makeConstraint({
        kind: "distance",
        targets: [
          { id: "a", anchor: "start" },
          { id: "b" },
        ],
        value: 10,
        createdAt: NOW,
      }),
    ConstraintError,
  );
});

test("validateConstraintTargets: the typed unsupported vocabulary declines", () => {
  const byId = (id: string): Element | undefined =>
    ({
      "el-line": line("el-line", 0, 0, 10, 0),
      "el-circle": circle("el-circle", 0, 0, 5),
      "el-poly": el("el-poly", { type: "polyline", vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], closed: false }),
      "el-text": el("el-text", { annotation: true, type: "text", x: 0, y: 0, height: 2.5, rotation: 0, value: "x" }),
    } as Record<string, Element>)[id];
  // Missing target.
  assert.throws(
    () => validateConstraintTargets(con("c", "horizontal", [{ id: "el-X" }]), byId),
    (e: unknown) => e instanceof ConstraintError && e.code === "unsupported" && (e as ConstraintError).message.includes("does not exist"),
  );
  // Outside the constrained vocabulary.
  assert.throws(
    () => validateConstraintTargets(con("c", "horizontal", [{ id: "el-poly" }]), byId),
    (e: unknown) => e instanceof ConstraintError && (e as ConstraintError).message.includes("outside the constrained vocabulary"),
  );
  assert.throws(
    () => validateConstraintTargets(con("c", "fixed", [{ id: "el-text" }]), byId),
    ConstraintError,
  );
  // horizontal on a circle.
  assert.throws(
    () => validateConstraintTargets(con("c", "horizontal", [{ id: "el-circle" }]), byId),
    ConstraintError,
  );
  // equal line + circle (mixed pairing).
  assert.throws(
    () => validateConstraintTargets(con("c", "equal", [{ id: "el-line" }, { id: "el-circle" }]), byId),
    (e: unknown) => e instanceof ConstraintError && (e as ConstraintError).message.includes("mixed pairings"),
  );
  // angle on line + circle.
  assert.throws(
    () => validateConstraintTargets(con("c", "angle", [{ id: "el-line" }, { id: "el-circle" }]), byId),
    ConstraintError,
  );
  // radius on a line.
  assert.throws(
    () => validateConstraintTargets(con("c", "radius", [{ id: "el-line" }]), byId),
    ConstraintError,
  );
  // Valid pairings pass silently.
  validateConstraintTargets(con("c", "tangent", [{ id: "el-line" }, { id: "el-circle" }]), byId);
  validateConstraintTargets(con("c", "tangent", [{ id: "el-circle" }, { id: "el-line" }]), byId);
  validateConstraintTargets(con("c", "coincident", [{ id: "el-line", anchor: "end" }, { id: "el-circle", anchor: "center" }]), byId);
});

// ---------------------------------------------------------------------------
// Anchors + DoF.
// ---------------------------------------------------------------------------

test("anchor resolution: positions, nearest-anchor, vocabulary gates", () => {
  const g = constrainableGeomOf(line("a", 0, 0, 100, 50))!;
  assert.deepEqual(anchorPosition(g, "start"), { x: 0, y: 0 });
  assert.deepEqual(anchorPosition(g, "end"), { x: 100, y: 50 });
  assert.deepEqual(anchorPosition(g, "midpoint"), { x: 50, y: 25 });
  assert.equal(anchorPosition(g, "center"), null);
  assert.equal(nearestAnchor(g, { x: 105, y: 55 }), "end");
  assert.equal(nearestAnchor(g, { x: -5, y: -5 }), "start");
  const c = constrainableGeomOf(circle("b", 30, 30, 5))!;
  assert.equal(nearestAnchor(c, { x: 0, y: 0 }), "center");
  assert.equal(isConstrainableElement(el("p", { type: "polyline", vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false })), false);
  assert.equal(isConstrainableElement(line("l", 0, 0, 1, 1)), true);
});

test("DoF accounting: the bounded formula", () => {
  assert.equal(entityDof(constrainableGeomOf(line("a", 0, 0, 1, 1))!), 4);
  assert.equal(entityDof(constrainableGeomOf(circle("b", 0, 0, 1))!), 3);
  assert.equal(entityDof(constrainableGeomOf(el("ar", { type: "arc", cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: 1 }))!), 5);
  assert.equal(entityDof(constrainableGeomOf(el("p", { type: "point", x: 0, y: 0 }))!), 2);
  assert.equal(constraintDof("horizontal", { id: "a" }), 1);
  assert.equal(constraintDof("coincident", { id: "a", anchor: "start" }), 2);
  assert.equal(constraintDof("fixed", { id: "a" }), -1); // whole-entity sentinel
  assert.equal(constraintDof("fixed", { id: "a", anchor: "start" }), 2);
  assert.equal(constraintDof("distance", { id: "a" }), 1);
});

// ---------------------------------------------------------------------------
// Closed-form applications (authority + fixed-flip).
// ---------------------------------------------------------------------------

test("horizontal/vertical: the end levels to the start (start authoritative)", () => {
  let r = solveConstraints([line("el-1", 0, 0, 100, 30)], [con("con-1", "horizontal", [{ id: "el-1" }])]);
  const g1 = geomOf(r, "el-1") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g1.y1, 0);
  assert.equal(g1.y2, 0);
  assert.equal(g1.x1, 0);
  assert.equal(g1.x2, 100);

  r = solveConstraints([line("el-1", 10, 5, 100, 5)], [con("con-1", "vertical", [{ id: "el-1" }])]);
  const g2 = geomOf(r, "el-1") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g2.x1, 10);
  assert.equal(g2.x2, 10);
  assert.equal(g2.y2, 5);
});

test("coincident: target[1]'s anchor moves to target[0]'s (midpoint translates)", () => {
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 5), line("el-2", 0, 0, 200, 3)],
    [con("con-1", "coincident", [{ id: "el-1", anchor: "end" }, { id: "el-2", anchor: "start" }])],
  );
  const g2 = geomOf(r, "el-2") as { x1: number; y1: number };
  assert.equal(g2.x1, 100);
  assert.equal(g2.y1, 5);
  assert.equal(r.geometry.has("el-1"), false); // target[0] authoritative — unchanged

  // Midpoint coincidence translates the whole second line.
  const r2 = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 0, 10, 20, 10)],
    [con("con-1", "coincident", [{ id: "el-1", anchor: "midpoint" }, { id: "el-2", anchor: "midpoint" }])],
  );
  const g22 = geomOf(r2, "el-2") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g22.x1, 40); // midpoint (50,0) − half of (20,0)
  assert.equal(g22.y1, 0);
  assert.equal(g22.x2, 60);
  assert.equal(g22.y2, 0);
});

test("parallel/perpendicular: minimal rotation about the preserved start", () => {
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 200, 50, 300, 40)],
    [con("con-1", "parallel", [{ id: "el-1" }, { id: "el-2" }])],
  );
  const g = geomOf(r, "el-2") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g.x1, 200);
  assert.equal(g.y1, 50);
  assert.ok(Math.abs(g.y2 - 50) < TOL); // leveled to horizontal
  const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
  assert.ok(Math.abs(len - Math.hypot(100, -10)) < 1e-6); // length preserved

  const r2 = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 200, 0, 300, 10)],
    [con("con-1", "perpendicular", [{ id: "el-1" }, { id: "el-2" }])],
  );
  const g2 = geomOf(r2, "el-2") as { x1: number; y1: number; x2: number; y2: number };
  const angle = Math.atan2(g2.y2 - g2.y1, g2.x2 - g2.x1);
  assert.ok(Math.abs(angle - Math.PI / 2) < 1e-9);
});

test("equal: lines scale about the start; circles set radii", () => {
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 200, 0, 250, 0)],
    [con("con-1", "equal", [{ id: "el-1" }, { id: "el-2" }])],
  );
  const g = geomOf(r, "el-2") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g.x1, 200);
  assert.equal(g.x2, 300);

  const r2 = solveConstraints(
    [circle("el-1", 0, 0, 10), circle("el-2", 50, 0, 30)],
    [con("con-1", "equal", [{ id: "el-1" }, { id: "el-2" }])],
  );
  const c2 = geomOf(r2, "el-2") as { cx: number; cy: number; r: number };
  assert.equal(c2.r, 10);
  assert.equal(c2.cx, 50);
});

test("tangent line+circle: target[0] preserved, target[1] adjusts (fixed flips)", () => {
  // tangent(line, circle) — the circle's center slides along the normal.
  let r = solveConstraints(
    [line("el-1", -50, 0, 50, 0), circle("el-2", 0, 30, 10)],
    [con("con-1", "tangent", [{ id: "el-1" }, { id: "el-2" }])],
  );
  assert.equal(r.geometry.has("el-1"), false);
  const c = geomOf(r, "el-2") as { cx: number; cy: number; r: number };
  assert.equal(c.cy, 10); // distance to the line = 10 = r

  // tangent(circle, line) — the line translates.
  r = solveConstraints(
    [line("el-1", -50, 0, 50, 0), circle("el-2", 0, 30, 10)],
    [con("con-1", "tangent", [{ id: "el-2" }, { id: "el-1" }])],
  );
  assert.equal(r.geometry.has("el-2"), false);
  const g = geomOf(r, "el-1") as { y1: number; y2: number };
  assert.equal(g.y1, 20);
  assert.equal(g.y2, 20);

  // Fixed adjuster flips the role.
  r = solveConstraints(
    [line("el-1", -50, 0, 50, 0), circle("el-2", 0, 30, 10)],
    [
      con("con-1", "tangent", [{ id: "el-2" }, { id: "el-1" }]),
      con("con-0", "fixed", [{ id: "el-1" }]),
    ],
  );
  const c3 = geomOf(r, "el-2") as { cy: number };
  assert.equal(c3.cy, 10);
});

test("tangent circle+circle: external separation, explicit internal mode", () => {
  let r = solveConstraints(
    [circle("el-1", 0, 0, 10), circle("el-2", 30, 0, 8)],
    [con("con-1", "tangent", [{ id: "el-1" }, { id: "el-2" }])],
  );
  const c2 = geomOf(r, "el-2") as { cx: number; cy: number };
  assert.equal(c2.cx, 18); // external: d = 10 + 8
  assert.equal(c2.cy, 0);

  // Internal tangency (explicit mode): d = |r1 − r2|.
  r = solveConstraints(
    [circle("el-1", 0, 0, 10), circle("el-2", 30, 0, 4)],
    [con("con-1", "tangent", [{ id: "el-1" }, { id: "el-2" }], undefined, "internal")],
  );
  const ci = geomOf(r, "el-2") as { cx: number };
  assert.equal(ci.cx, 6); // d = 10 − 4
});

test("dimensional closed forms: length/distance-pair/angle/radius", () => {
  // Line length: the end extends along the current direction.
  let r = solveConstraints([line("el-1", 0, 0, 30, 40)], [con("con-1", "distance", [{ id: "el-1" }], 100)]);
  const g = geomOf(r, "el-1") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g.x2, 60);
  assert.equal(g.y2, 80);

  // Anchor-pair distance: the second anchor moves along the separation.
  r = solveConstraints(
    [el("el-1", { type: "point", x: 0, y: 0 }), el("el-2", { type: "point", x: 30, y: 40 })],
    [con("con-1", "distance", [{ id: "el-1", anchor: "start" }, { id: "el-2", anchor: "start" }], 100)],
  );
  const p2 = geomOf(r, "el-2") as { x: number; y: number };
  assert.equal(p2.x, 60);
  assert.equal(p2.y, 80);

  // Angle: the second line rotates to the declared CCW angle from the first.
  r = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 0, 0, 50, 10)],
    [con("con-1", "angle", [{ id: "el-1" }, { id: "el-2" }], Math.PI / 2)],
  );
  const g2 = geomOf(r, "el-2") as { x1: number; y1: number; x2: number; y2: number };
  assert.ok(Math.abs(g2.x1) < 1e-9);
  assert.ok(Math.abs(g2.y1) < 1e-9);
  const a2 = Math.atan2(g2.y2 - g2.y1, g2.x2 - g2.x1);
  assert.ok(Math.abs(a2 - Math.PI / 2) < 1e-9);

  // Radius.
  r = solveConstraints([circle("el-1", 0, 0, 10)], [con("con-1", "radius", [{ id: "el-1" }], 25)]);
  const c = geomOf(r, "el-1") as { r: number };
  assert.equal(c.r, 25);
});

// ---------------------------------------------------------------------------
// The six outcomes (explicit + reproducible).
// ---------------------------------------------------------------------------

test("outcome solved: a fully constrained entity (whole-entity fixed)", () => {
  const r = solveConstraints([line("el-1", 0, 0, 100, 0)], [con("con-1", "fixed", [{ id: "el-1" }])]);
  assert.equal(r.outcome, "solved");
  assert.equal(r.dof[0]?.dof, 0);
  assert.equal(r.geometry.size, 0);
});

test("outcome under-constrained: satisfied with remaining DoF", () => {
  const r = solveConstraints([line("el-1", 0, 0, 100, 30)], [con("con-1", "horizontal", [{ id: "el-1" }])]);
  assert.equal(r.outcome, "under-constrained");
  assert.equal(r.dof[0]?.dof, 3);
  assert.ok(r.statuses.every((s) => s.satisfied));
});

test("outcome over-constrained: structural redundancy (DoF < 0)", () => {
  const r = diagnoseConstraints(
    [
      line("el-1", 0, 0, 100, 0),
      line("el-2", 50, 50, 150, 50),
    ],
    [
      con("con-1", "fixed", [{ id: "el-1" }]),
      con("con-2", "fixed", [{ id: "el-2" }]),
      con("con-3", "coincident", [{ id: "el-1", anchor: "end" }, { id: "el-2", anchor: "start" }]),
    ],
  );
  assert.equal(r.outcome, "over-constrained");
  assert.equal(r.dof[0]?.dof, -2);
});

test("outcome over-constrained: a blocked application (fixed geometry conflict)", () => {
  // fixed(start) + fixed(end) + horizontal on one line: dof = 4 − 2 − 2 − 1 < 0
  // is caught structurally; the pure blocked path: an over-length distance
  // against both-fixed anchors.
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0)],
    [
      con("con-1", "fixed", [{ id: "el-1", anchor: "start" }]),
      con("con-2", "fixed", [{ id: "el-1", anchor: "end" }]),
      con("con-3", "horizontal", [{ id: "el-1" }]),
    ],
  );
  assert.equal(r.outcome, "over-constrained");
});

test("outcome unsatisfied: contradictory dimensional values", () => {
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 0, 50, 200, 50)],
    [
      con("con-1", "distance", [{ id: "el-1" }], 100),
      con("con-2", "distance", [{ id: "el-2" }], 200),
      con("con-3", "equal", [{ id: "el-1" }, { id: "el-2" }]),
    ],
  );
  assert.equal(r.outcome, "unsatisfied");
  assert.ok(r.statuses.some((s) => !s.satisfied));
});

test("outcome ambiguous: degenerate geometry declines (never guesses)", () => {
  // Parallel with a zero-length second line — no direction to align.
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0), line("el-2", 0, 50, 0, 50)],
    [con("con-1", "parallel", [{ id: "el-1" }, { id: "el-2" }])],
  );
  assert.equal(r.outcome, "ambiguous");
  const status = r.statuses.find((s) => s.id === "con-1");
  assert.equal(status?.satisfied, false);
  assert.ok(status?.note?.includes("no direction"));

  // Distance on a zero-length line — no extension direction.
  const r2 = solveConstraints(
    [line("el-1", 0, 0, 0, 0)],
    [con("con-1", "distance", [{ id: "el-1" }], 50)],
  );
  assert.equal(r2.outcome, "ambiguous");
});

test("outcome unsupported: a target that left the vocabulary", () => {
  const r = solveConstraints(
    [line("el-1", 0, 0, 100, 0)],
    [con("con-1", "coincident", [{ id: "el-1", anchor: "end" }, { id: "el-GONE", anchor: "start" }])],
  );
  assert.equal(r.outcome, "unsupported");
  assert.equal(r.statuses.find((s) => s.id === "con-1")?.satisfied, false);
});

// ---------------------------------------------------------------------------
// Fixed-restore (the constraint-aware edit cascade basis) + severance.
// ---------------------------------------------------------------------------

test("fixed-restore: a moved fixed entity returns to its pinned state", () => {
  const before = [line("el-1", 0, 0, 100, 0)];
  const after = [line("el-1", 50, 40, 150, 40)];
  const r = solveConstraints(after, [con("con-1", "fixed", [{ id: "el-1" }])], {
    seedIds: ["el-1"],
    before,
  });
  assert.equal(r.outcome, "solved");
  const g = geomOf(r, "el-1") as { x1: number; y1: number; x2: number; y2: number };
  assert.deepEqual([g.x1, g.y1, g.x2, g.y2], [0, 0, 100, 0]);
  assert.ok(r.notes.some((n) => n.includes("restored to its fixed position")));
});

test("fixed-restore: anchor-level fixed restores only the pinned anchor", () => {
  const before = [line("el-1", 0, 0, 100, 0)];
  const after = [line("el-1", 50, 40, 150, 40)];
  const r = solveConstraints(
    after,
    [con("con-1", "fixed", [{ id: "el-1", anchor: "start" }])],
    { seedIds: ["el-1"], before },
  );
  const g = geomOf(r, "el-1") as { x1: number; y1: number; x2: number; y2: number };
  assert.equal(g.x1, 0); // the pinned anchor restored
  assert.equal(g.y1, 0);
  assert.equal(g.x2, 150); // the rest follows the edit
  assert.equal(g.y2, 40);
});

test("constraintsReferencing: the severance set", () => {
  const set = new Set(["el-2"]);
  const dead = constraintsReferencing(
    [
      con("con-1", "horizontal", [{ id: "el-1" }]),
      con("con-2", "coincident", [{ id: "el-1", anchor: "end" }, { id: "el-2", anchor: "start" }]),
      con("con-3", "fixed", [{ id: "el-2" }]),
    ],
    set,
  );
  assert.deepEqual(dead.map((c) => c.id), ["con-2", "con-3"]);
});

// ---------------------------------------------------------------------------
// Determinism + glyph descriptors.
// ---------------------------------------------------------------------------

test("determinism: the same world + graph produce the identical result", () => {
  const elements = [line("el-1", 0, 0, 100, 5), line("el-2", 0, 0, 200, 3), circle("el-3", 300, 0, 10)];
  const constraints = [
    con("con-1", "coincident", [{ id: "el-1", anchor: "end" }, { id: "el-2", anchor: "start" }]),
    con("con-2", "horizontal", [{ id: "el-2" }]),
    con("con-3", "tangent", [{ id: "el-2" }, { id: "el-3" }]),
  ];
  const a = solveConstraints(elements, constraints);
  const b = solveConstraints(elements, constraints);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("glyphs: one badge per constraint at the deterministic positions", () => {
  const glyphs = constraintGlyphs(
    [line("el-1", 0, 0, 100, 0), circle("el-2", 200, 0, 10)],
    [
      con("con-000001", "horizontal", [{ id: "el-1" }]),
      con("con-000002", "tangent", [{ id: "el-1" }, { id: "el-2" }]),
      con("con-000003", "fixed", [{ id: "el-GONE" }]), // dead target — no badge
    ],
  );
  assert.equal(glyphs.length, 2);
  assert.deepEqual(glyphs[0]?.at, { x: 50, y: 0 }); // line midpoint
  assert.deepEqual(glyphs[1]?.at, { x: 125, y: 0 }); // midpoint between targets
  assert.equal(glyphs[0]?.label, "H");
  assert.equal(glyphs[1]?.label, "T");
});
