/**
 * CAD-PARITY-007 deterministic constraint solver (Issue #86) — the bounded
 * propagation engine.
 *
 * NOT a general-purpose nonlinear solver (Issue #86 research direction):
 * every constraint kind has ONE closed-form application over the canonical
 * geometry view, applied through deterministic dependency-ordered
 * propagation (a worklist seeded by the driver, constraints visited in
 * canonical-id order = declaration order, a fixed pass bound). No
 * black-box numerics, no iteration-count-dependent convergence, no
 * randomness — the same elements + the same constraint graph produce the
 * same result on every host, every run (LOCK-004).
 *
 * Authority rules (deterministic, documented):
 *  - binary constraints: target[0] is authoritative (its geometry is
 *    preserved); target[1] adjusts — UNLESS the adjusting side is FIXED
 *    and the authoritative side is not (fixed wins, the roles flip).
 *  - unary line constraints (horizontal/vertical/distance-on-line): the
 *    start anchor is preserved and the end adjusts (same fixed-flip rule).
 *  - FIXED anchors are NEVER moved by the solver: an application that
 *    cannot avoid a fixed anchor is BLOCKED (a fixed/geometry conflict —
 *    the over-constrained classification).
 *
 * Outcomes (six, explicit and reproducible — Issue #86 acceptance):
 *  - solved           — every constraint satisfied AND component DoF = 0;
 *  - under-constrained— every constraint satisfied, component DoF > 0
 *                       (the bounded DoF formula: line 4, circle 3, arc 5,
 *                       point 2; each constraint removes its declared DoF);
 *  - over-constrained — DoF < 0 (structural redundancy) or a blocked
 *                       application (a constraint conflicting with fixed
 *                       geometry);
 *  - unsatisfied      — propagation ended (pass bound) with a violated
 *                       constraint (e.g. contradictory dimensional values);
 *  - ambiguous        — a constraint whose closed form is undefined on the
 *                       current degenerate geometry (zero-length direction,
 *                       concentric tangency) — declined, never guessed;
 *  - unsupported      — a constraint whose targets left the constrained
 *                       vocabulary (deleted element, changed type).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { ConstraintAnchor, ConstraintKind, ConstraintRecord, Element } from "../../contracts/caddocument.js";
import type { Geom, LineGeom, CircleGeom, ArcGeom, PointGeom } from "../geometry/types.js";
import { geomFromElement } from "../geometry/bridge.js";
import {
  add,
  angleOf,
  cross,
  dist,
  dot,
  EPS,
  len,
  mul,
  norm,
  Pt,
  sub,
  TAU,
} from "../geometry/math2d.js";
import {
  anchorPosition,
  constrainableGeomOf,
  constraintDof,
  entityDof,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public result types.
// ---------------------------------------------------------------------------

export type SolveOutcome =
  | "solved"
  | "under-constrained"
  | "over-constrained"
  | "unsatisfied"
  | "ambiguous"
  | "unsupported";

export interface ConstraintStatus {
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly satisfied: boolean;
  /** Null when satisfied; the deterministic reason when not. */
  readonly note: string | null;
}

export interface ComponentDof {
  /** The component's entity ids (sorted). */
  readonly entities: readonly string[];
  /** The component's constraint ids (sorted). */
  readonly constraints: readonly string[];
  /** Declared degrees of freedom remaining (negative = over-constrained). */
  readonly dof: number;
}

export interface SolveResult {
  readonly outcome: SolveOutcome;
  /** New geometry per CHANGED entity (canonical Geom; empty = no change). */
  readonly geometry: ReadonlyMap<string, Geom>;
  /** Verification status of every constraint (sorted by id). */
  readonly statuses: readonly ConstraintStatus[];
  /** DoF accounting per component (sorted by smallest entity id). */
  readonly dof: readonly ComponentDof[];
  /** Deterministic echo notes (fixed restores, pass-bound stops). */
  readonly notes: readonly string[];
}

export interface SolveOptions {
  /** Driver entities (the worklist seeds). Default: every constrained
   *  entity (a full-graph solve). */
  readonly seedIds?: readonly string[];
  /** The pre-edit element world — when present, entities whose FIXED
   *  anchors moved relative to this world are RESTORED before propagation
   *  (the constraint-aware edit cascade: fixed means fixed). */
  readonly before?: readonly Element[];
}

// ---------------------------------------------------------------------------
// Working state.
// ---------------------------------------------------------------------------

interface Working {
  readonly geom: Geom;
}

type ApplyStatus =
  | { readonly status: "satisfied" }
  | { readonly status: "applied" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "ambiguous"; readonly reason: string }
  | { readonly status: "unsupported"; readonly reason: string };

/** The fixed sets derived from the constraint graph (whole entities +
 *  per-anchor pins). */
interface FixedSets {
  readonly entities: ReadonlySet<string>;
  readonly anchors: ReadonlyMap<string, ReadonlySet<ConstraintAnchor>>;
}

function fixedSetsOf(constraints: readonly ConstraintRecord[]): FixedSets {
  const entities = new Set<string>();
  const anchors = new Map<string, Set<ConstraintAnchor>>();
  for (const c of constraints) {
    if (c.kind !== "fixed") continue;
    const t = c.targets[0];
    if (t === undefined) continue;
    if (t.anchor === undefined) entities.add(t.id);
    else {
      let set = anchors.get(t.id);
      if (set === undefined) {
        set = new Set();
        anchors.set(t.id, set);
      }
      set.add(t.anchor);
    }
  }
  return { entities, anchors };
}

// ---------------------------------------------------------------------------
// Geometry mutation helpers (pure — return new Geom values).
// ---------------------------------------------------------------------------

function asLine(g: Geom): LineGeom | null {
  return g.type === "line" ? g : null;
}

function asCircleLike(g: Geom): CircleGeom | ArcGeom | null {
  return g.type === "circle" || g.type === "arc" ? g : null;
}

function translateGeom(g: Geom, delta: Pt): Geom {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline":
      return { ...g, x1: g.x1 + delta.x, y1: g.y1 + delta.y, x2: g.x2 + delta.x, y2: g.y2 + delta.y };
    case "circle":
      return { ...g, cx: g.cx + delta.x, cy: g.cy + delta.y };
    case "arc":
      return { ...g, cx: g.cx + delta.x, cy: g.cy + delta.y };
    case "ellipse":
      return { ...g, cx: g.cx + delta.x, cy: g.cy + delta.y };
    case "point":
      return { ...g, x: g.x + delta.x, y: g.y + delta.y };
    default:
      return g;
  }
}

/** Move one anchor of a geometry to a position (midpoint translates the
 *  whole entity — the canonical convention). Null when the geometry does
 *  not carry the anchor. */
function moveAnchorGeom(g: Geom, anchor: ConstraintAnchor, to: Pt): Geom | null {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      if (anchor === "start") return { ...g, x1: to.x, y1: to.y };
      if (anchor === "end") return { ...g, x2: to.x, y2: to.y };
      if (anchor === "midpoint") {
        const mid = { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
        return translateGeom(g, sub(to, mid)) as typeof g;
      }
      return null;
    }
    case "circle":
    case "arc":
    case "ellipse":
      return anchor === "center" ? translateGeom(g, sub(to, { x: g.cx, y: g.cy })) as typeof g : null;
    case "point":
      return anchor === "start" ? { ...g, x: to.x, y: to.y } : null;
    default:
      return null;
  }
}

/** Rotate a line about a pivot so its direction becomes `targetDir`. */
function rotateLineTo(g: LineGeom, pivot: Pt, targetDir: Pt): LineGeom {
  const current = { x: g.x2 - g.x1, y: g.y2 - g.y1 };
  const delta = Math.atan2(targetDir.y, targetDir.x) - Math.atan2(current.y, current.x);
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  const rot = (p: Pt): Pt => ({ x: pivot.x + cos * (p.x - pivot.x) - sin * (p.y - pivot.y), y: pivot.y + sin * (p.x - pivot.x) + cos * (p.y - pivot.y) });
  const a = rot({ x: g.x1, y: g.y1 });
  const b = rot({ x: g.x2, y: g.y2 });
  return { type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Scale a line about a pivot to a new length (direction preserved). */
function scaleLineTo(g: LineGeom, pivot: Pt, newLength: number): LineGeom {
  const dir = norm({ x: g.x2 - g.x1, y: g.y2 - g.y1 });
  const a: Pt = { x: g.x1, y: g.y1 };
  const b: Pt = { x: g.x2, y: g.y2 };
  // Scale both endpoints about the pivot.
  const factor = newLength / len(sub(b, a));
  const scaled = (p: Pt): Pt => ({ x: pivot.x + (p.x - pivot.x) * factor, y: pivot.y + (p.y - pivot.y) * factor });
  const na = scaled(a);
  const nb = scaled(b);
  // Preserve the orientation start→end; if the pivot-based scaling flipped
  // it (factor < 0 impossible: newLength > 0, len > 0), keep as-is.
  void dir;
  return { type: "line", x1: na.x, y1: na.y, x2: nb.x, y2: nb.y };
}

// ---------------------------------------------------------------------------
// Verification (pure — reads the working geometry).
// ---------------------------------------------------------------------------

function lineDir(g: LineGeom): Pt {
  return { x: g.x2 - g.x1, y: g.y2 - g.y1 };
}

/** The CCW angle from direction a to direction b, normalized to [0, 2π). */
function ccwAngle(a: Pt, b: Pt): number {
  const raw = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
  return ((raw % TAU) + TAU) % TAU;
}

function angleClose(a: number, b: number): boolean {
  const d = Math.abs(a - b);
  return Math.min(d, TAU - d) <= EPS;
}

interface Worlds {
  readonly byId: Map<string, Working>;
  readonly constraints: readonly ConstraintRecord[];
  readonly byEntity: Map<string, ConstraintRecord[]>;
  readonly fixed: FixedSets;
}

function geomOf(w: Worlds, id: string): Geom | null {
  return w.byId.get(id)?.geom ?? null;
}

/** Verify ONE constraint against the working world. */
function verifyConstraint(w: Worlds, c: ConstraintRecord): { satisfied: boolean; note: string } {
  const t0 = c.targets[0];
  const t1 = c.targets[1];
  const g0 = t0 !== undefined ? geomOf(w, t0.id) : null;
  const g1 = t1 !== undefined ? geomOf(w, t1.id) : null;
  if (t0 === undefined || g0 === null) {
    return { satisfied: false, note: `target '${t0?.id ?? "?"}' is outside the constrained vocabulary` };
  }
  switch (c.kind) {
    case "fixed":
      return { satisfied: true, note: "" };
    case "horizontal": {
      const line = asLine(g0);
      if (line === null) return { satisfied: false, note: "target is not a line" };
      return Math.abs(line.y1 - line.y2) <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `endpoints differ in Y by ${fmt(Math.abs(line.y1 - line.y2))}` };
    }
    case "vertical": {
      const line = asLine(g0);
      if (line === null) return { satisfied: false, note: "target is not a line" };
      return Math.abs(line.x1 - line.x2) <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `endpoints differ in X by ${fmt(Math.abs(line.x1 - line.x2))}` };
    }
    case "coincident": {
      if (t1 === undefined || g1 === null) return { satisfied: false, note: "second target missing" };
      const pa = anchorPosition(g0, t0.anchor ?? "start");
      const pb = anchorPosition(g1, t1.anchor ?? "start");
      if (pa === null || pb === null) return { satisfied: false, note: "anchor not carried" };
      return dist(pa, pb) <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `anchors ${fmt(dist(pa, pb))} apart` };
    }
    case "parallel":
    case "perpendicular": {
      if (t1 === undefined || g1 === null) return { satisfied: false, note: "second target missing" };
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la === null || lb === null) return { satisfied: false, note: "target is not a line" };
      const da = lineDir(la);
      const db = lineDir(lb);
      if (len(da) <= EPS || len(db) <= EPS) return { satisfied: false, note: "degenerate (zero-length) line" };
      const crossZ = Math.abs(cross(norm(da), norm(db)));
      if (c.kind === "parallel") {
        return crossZ <= EPS
          ? { satisfied: true, note: "" }
          : { satisfied: false, note: `directions ${fmt(Math.asin(Math.min(1, crossZ)) * 180 / Math.PI)}° apart` };
      }
      const dotZ = Math.abs(dot(norm(da), norm(db)));
      return dotZ <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `directions ${fmt(Math.acos(Math.min(1, dotZ)) * 180 / Math.PI)}° from perpendicular` };
    }
    case "equal": {
      if (t1 === undefined || g1 === null) return { satisfied: false, note: "second target missing" };
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la !== null && lb !== null) {
        return Math.abs(len(lineDir(la)) - len(lineDir(lb))) <= EPS
          ? { satisfied: true, note: "" }
          : { satisfied: false, note: `lengths ${fmt(len(lineDir(la)))} vs ${fmt(len(lineDir(lb)))}` };
      }
      const ca = asCircleLike(g0);
      const cb = asCircleLike(g1);
      if (ca !== null && cb !== null) {
        return Math.abs(ca.r - cb.r) <= EPS
          ? { satisfied: true, note: "" }
          : { satisfied: false, note: `radii ${fmt(ca.r)} vs ${fmt(cb.r)}` };
      }
      return { satisfied: false, note: "equal applies to two lines or two circles/arcs" };
    }
    case "tangent": {
      if (t1 === undefined || g1 === null) return { satisfied: false, note: "second target missing" };
      const la = asLine(g0);
      const lb = asLine(g1);
      const ca = asCircleLike(g0);
      const cb = asCircleLike(g1);
      if (la !== null && cb !== null) return verifyLineCircleTangent(la, cb);
      if (ca !== null && lb !== null) return verifyLineCircleTangent(lb, ca);
      if (ca !== null && cb !== null) {
        const d = dist({ x: ca.cx, y: ca.cy }, { x: cb.cx, y: cb.cy });
        const required = c.mode === "internal" ? Math.abs(ca.r - cb.r) : ca.r + cb.r;
        return Math.abs(d - required) <= EPS
          ? { satisfied: true, note: "" }
          : { satisfied: false, note: `centers ${fmt(d)} apart (requires ${fmt(required)})` };
      }
      return { satisfied: false, note: "tangent applies to line+circle or circle+circle" };
    }
    case "distance": {
      const value = c.value ?? 0;
      if (t1 === undefined) {
        const line = asLine(g0);
        if (line === null) return { satisfied: false, note: "target is not a line" };
        const l = len(lineDir(line));
        return Math.abs(l - value) <= EPS
          ? { satisfied: true, note: "" }
          : { satisfied: false, note: `length ${fmt(l)} (declared ${fmt(value)})` };
      }
      if (g1 === null) return { satisfied: false, note: "second target missing" };
      const pa = anchorPosition(g0, t0.anchor ?? "start");
      const pb = anchorPosition(g1, t1.anchor ?? "start");
      if (pa === null || pb === null) return { satisfied: false, note: "anchor not carried" };
      const d = dist(pa, pb);
      return Math.abs(d - value) <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `anchors ${fmt(d)} apart (declared ${fmt(value)})` };
    }
    case "angle": {
      if (t1 === undefined || g1 === null) return { satisfied: false, note: "second target missing" };
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la === null || lb === null) return { satisfied: false, note: "target is not a line" };
      const da = lineDir(la);
      const db = lineDir(lb);
      if (len(da) <= EPS || len(db) <= EPS) return { satisfied: false, note: "degenerate (zero-length) line" };
      const actual = ccwAngle(da, db);
      return angleClose(actual, c.value ?? 0)
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `angle ${fmt(actual * 180 / Math.PI)}° (declared ${fmt((c.value ?? 0) * 180 / Math.PI)}°)` };
    }
    case "radius": {
      const circle = asCircleLike(g0);
      if (circle === null) return { satisfied: false, note: "target is not a circle/arc" };
      return Math.abs(circle.r - (c.value ?? 0)) <= EPS
        ? { satisfied: true, note: "" }
        : { satisfied: false, note: `radius ${fmt(circle.r)} (declared ${fmt(c.value ?? 0)})` };
    }
  }
}

function verifyLineCircleTangent(line: LineGeom, circle: CircleGeom | ArcGeom): { satisfied: boolean; note: string } {
  const d = linePointDist({ x: circle.cx, y: circle.cy }, line);
  return Math.abs(d - circle.r) <= EPS
    ? { satisfied: true, note: "" }
    : { satisfied: false, note: `line ${fmt(d)} from center (radius ${fmt(circle.r)})` };
}

function linePointDist(p: Pt, line: LineGeom): number {
  const a = { x: line.x1, y: line.y1 };
  const dir = { x: line.x2 - line.x1, y: line.y2 - line.y1 };
  const l = len(dir);
  if (l <= EPS) return dist(p, a);
  return Math.abs(cross(sub(p, a), dir)) / l;
}

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

// ---------------------------------------------------------------------------
// Application (the closed forms).
// ---------------------------------------------------------------------------

function canMoveEntity(w: Worlds, id: string): boolean {
  return !w.fixed.entities.has(id);
}

function canMoveAnchor(w: Worlds, id: string, anchor: ConstraintAnchor | undefined): boolean {
  if (w.fixed.entities.has(id)) return false;
  if (anchor === undefined) return canMoveEntity(w, id);
  return !(w.fixed.anchors.get(id)?.has(anchor) ?? false);
}

function setGeom(w: Worlds, id: string, geom: Geom): void {
  const entry = w.byId.get(id);
  if (entry === undefined) return;
  w.byId.set(id, { geom });
}

/** Apply ONE constraint's closed form (mutates the working world).
 *  Returns the ids whose geometry changed ("" when none). */
function applyConstraint(w: Worlds, c: ConstraintRecord): { result: ApplyStatus; changed: string[] } {
  const t0 = c.targets[0];
  const t1 = c.targets[1];
  if (t0 === undefined) return { result: { status: "unsupported", reason: "no targets" }, changed: [] };
  const g0 = geomOf(w, t0.id);
  if (g0 === null) {
    return { result: { status: "unsupported", reason: `target '${t0.id}' is outside the constrained vocabulary` }, changed: [] };
  }
  const g1 = t1 !== undefined ? geomOf(w, t1.id) : null;
  switch (c.kind) {
    case "fixed":
      return { result: { status: "satisfied" }, changed: [] };
    case "horizontal": {
      const line = asLine(g0);
      if (line === null) return { result: { status: "unsupported", reason: "target is not a line" }, changed: [] };
      if (Math.abs(line.y1 - line.y2) <= EPS) return { result: { status: "satisfied" }, changed: [] };
      // Start authoritative; the end levels. Fixed flip.
      if (canMoveAnchor(w, t0.id, "end")) {
        setGeom(w, t0.id, { ...line, y2: line.y1 });
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      if (canMoveAnchor(w, t0.id, "start")) {
        setGeom(w, t0.id, { ...line, y1: line.y2 });
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      return { result: { status: "blocked", reason: "both endpoints fixed — horizontality conflicts with the fixed geometry" }, changed: [] };
    }
    case "vertical": {
      const line = asLine(g0);
      if (line === null) return { result: { status: "unsupported", reason: "target is not a line" }, changed: [] };
      if (Math.abs(line.x1 - line.x2) <= EPS) return { result: { status: "satisfied" }, changed: [] };
      if (canMoveAnchor(w, t0.id, "end")) {
        setGeom(w, t0.id, { ...line, x2: line.x1 });
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      if (canMoveAnchor(w, t0.id, "start")) {
        setGeom(w, t0.id, { ...line, x1: line.x2 });
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      return { result: { status: "blocked", reason: "both endpoints fixed — verticality conflicts with the fixed geometry" }, changed: [] };
    }
    case "coincident": {
      if (t1 === undefined || g1 === null) {
        return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      }
      const pa = anchorPosition(g0, t0.anchor ?? "start");
      const pb = anchorPosition(g1, t1.anchor ?? "start");
      if (pa === null || pb === null) {
        return { result: { status: "unsupported", reason: "anchor not carried" }, changed: [] };
      }
      if (dist(pa, pb) <= EPS) return { result: { status: "satisfied" }, changed: [] };
      // target[0] authoritative: move target[1]'s anchor — fixed flip.
      if (canMoveAnchor(w, t1.id, t1.anchor)) {
        const moved = moveAnchorGeom(g1, t1.anchor ?? "start", pa);
        if (moved === null) return { result: { status: "unsupported", reason: "anchor not movable" }, changed: [] };
        setGeom(w, t1.id, moved);
        return { result: { status: "applied" }, changed: [t1.id] };
      }
      if (canMoveAnchor(w, t0.id, t0.anchor)) {
        const moved = moveAnchorGeom(g0, t0.anchor ?? "start", pb);
        if (moved === null) return { result: { status: "unsupported", reason: "anchor not movable" }, changed: [] };
        setGeom(w, t0.id, moved);
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      return { result: { status: "blocked", reason: "both anchors fixed — coincidence conflicts with the fixed geometry" }, changed: [] };
    }
    case "parallel":
    case "perpendicular": {
      if (t1 === undefined || g1 === null) {
        return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      }
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la === null || lb === null) {
        return { result: { status: "unsupported", reason: "targets must be lines" }, changed: [] };
      }
      const da = lineDir(la);
      const db = lineDir(lb);
      if (len(da) <= EPS || len(db) <= EPS) {
        return { result: { status: "ambiguous", reason: "a zero-length line has no direction to align" }, changed: [] };
      }
      const v = verifyConstraint(w, c);
      if (v.satisfied) return { result: { status: "satisfied" }, changed: [] };
      // Rotate target[1] (fixed flip) to the nearest qualifying direction.
      const candidates: Pt[] =
        c.kind === "parallel"
          ? [norm(da), mul(norm(da), -1)]
          : [rot90(norm(da)), mul(rot90(norm(da)), -1)];
      const curAngle = angleOf(db);
      let best = candidates[0]!;
      let bestDelta = Infinity;
      for (const cand of candidates) {
        let delta = Math.abs(angleOf(cand) - curAngle);
        if (delta > Math.PI) delta = TAU - delta;
        if (delta < bestDelta) {
          bestDelta = delta;
          best = cand;
        }
      }
      const pivotFixed = (anchor: ConstraintAnchor): boolean => !canMoveAnchor(w, t1.id, anchor);
      // The pivot is the anchor that stays: prefer start (authoritative).
      let pivot: Pt;
      if (!pivotFixed("start")) {
        pivot = { x: lb.x1, y: lb.y1 };
      } else if (!pivotFixed("end")) {
        pivot = { x: lb.x2, y: lb.y2 };
      } else {
        return { result: { status: "blocked", reason: "both endpoints of the rotating line are fixed" }, changed: [] };
      }
      setGeom(w, t1.id, rotateLineTo(lb, pivot, best));
      return { result: { status: "applied" }, changed: [t1.id] };
    }
    case "equal": {
      if (t1 === undefined || g1 === null) {
        return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      }
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la !== null && lb !== null) {
        const lenA = len(lineDir(la));
        const lenB = len(lineDir(lb));
        if (Math.abs(lenA - lenB) <= EPS) return { result: { status: "satisfied" }, changed: [] };
        if (lenA <= EPS) return { result: { status: "ambiguous", reason: "the authoritative line is zero-length — no length to copy" }, changed: [] };
        if (lenB <= EPS) return { result: { status: "ambiguous", reason: "the adjusted line is zero-length — scaling cannot set its length" }, changed: [] };
        // Scale target[1] about its start (fixed flip to end).
        if (!canMoveAnchor(w, t1.id, "end")) {
          if (canMoveAnchor(w, t1.id, "start")) {
            setGeom(w, t1.id, scaleLineTo(lb, { x: lb.x2, y: lb.y2 }, lenA));
            return { result: { status: "applied" }, changed: [t1.id] };
          }
          return { result: { status: "blocked", reason: "both endpoints of the adjusted line are fixed" }, changed: [] };
        }
        setGeom(w, t1.id, scaleLineTo(lb, { x: lb.x1, y: lb.y1 }, lenA));
        return { result: { status: "applied" }, changed: [t1.id] };
      }
      const ca = asCircleLike(g0);
      const cb = asCircleLike(g1);
      if (ca !== null && cb !== null) {
        if (Math.abs(ca.r - cb.r) <= EPS) return { result: { status: "satisfied" }, changed: [] };
        if (!canMoveEntity(w, t1.id)) {
          if (canMoveEntity(w, t0.id)) {
            setGeom(w, t0.id, { ...g0, r: cb.r } as Geom);
            return { result: { status: "applied" }, changed: [t0.id] };
          }
          return { result: { status: "blocked", reason: "both circles are fixed — equal radii conflicts with the fixed geometry" }, changed: [] };
        }
        setGeom(w, t1.id, { ...g1, r: ca.r } as Geom);
        return { result: { status: "applied" }, changed: [t1.id] };
      }
      return { result: { status: "unsupported", reason: "equal applies to two lines or two circles/arcs" }, changed: [] };
    }
    case "tangent": {
      if (t1 === undefined || g1 === null) {
        return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      }
      const v = verifyConstraint(w, c);
      if (v.satisfied) return { result: { status: "satisfied" }, changed: [] };
      const la = asLine(g0);
      const lb = asLine(g1);
      const ca = asCircleLike(g0);
      const cb = asCircleLike(g1);
      // Line + circle: target[0] is authoritative, target[1] adjusts (the
      // fixed-flip rule applies — a fixed adjuster hands the role back).
      if (la !== null && cb !== null) {
        return applyTangentLineCircle(w, la, cb as CircleGeom | ArcGeom, t1, t0, "circle");
      }
      if (ca !== null && lb !== null) {
        return applyTangentLineCircle(w, lb, ca as CircleGeom | ArcGeom, t1, t0, "line");
      }
      if (ca !== null && cb !== null) {
        // Circle + circle: the adjusted circle's center slides along the
        // center line to the required separation (mode explicit).
        const required = c.mode === "internal" ? Math.abs(ca.r - cb.r) : ca.r + cb.r;
        if (required <= EPS) {
          return { result: { status: "ambiguous", reason: "internal tangency of equal radii is degenerate (concentric)" }, changed: [] };
        }
        const c1 = { x: ca.cx, y: ca.cy };
        const c2 = { x: cb.cx, y: cb.cy };
        const d = dist(c1, c2);
        if (d <= EPS) {
          return { result: { status: "ambiguous", reason: "concentric circles have no center-line direction" }, changed: [] };
        }
        const target2 = add(c1, mul(norm(sub(c2, c1)), required));
        if (canMoveEntity(w, t1.id)) {
          const delta = sub(target2, c2);
          setGeom(w, t1.id, translateGeom(g1, delta));
          return { result: { status: "applied" }, changed: [t1.id] };
        }
        const target1 = add(c2, mul(norm(sub(c1, c2)), required));
        if (canMoveEntity(w, t0.id)) {
          const delta = sub(target1, c1);
          setGeom(w, t0.id, translateGeom(g0, delta));
          return { result: { status: "applied" }, changed: [t0.id] };
        }
        return { result: { status: "blocked", reason: "both circles are fixed — tangency conflicts with the fixed geometry" }, changed: [] };
      }
      return { result: { status: "unsupported", reason: "tangent applies to line+circle or circle+circle" }, changed: [] };
    }
    case "distance": {
      const value = c.value ?? 0;
      if (t1 === undefined) {
        // Line length.
        const line = asLine(g0);
        if (line === null) return { result: { status: "unsupported", reason: "target is not a line" }, changed: [] };
        const l = len(lineDir(line));
        if (Math.abs(l - value) <= EPS) return { result: { status: "satisfied" }, changed: [] };
        if (l <= EPS) return { result: { status: "ambiguous", reason: "a zero-length line has no direction to extend along" }, changed: [] };
        const dir = norm(lineDir(line));
        const start: Pt = { x: line.x1, y: line.y1 };
        const end: Pt = { x: line.x2, y: line.y2 };
        if (canMoveAnchor(w, t0.id, "end")) {
          const newEnd = add(start, mul(dir, value));
          setGeom(w, t0.id, { ...line, x2: newEnd.x, y2: newEnd.y });
          return { result: { status: "applied" }, changed: [t0.id] };
        }
        if (canMoveAnchor(w, t0.id, "start")) {
          const newStart = sub(end, mul(dir, value));
          setGeom(w, t0.id, { ...line, x1: newStart.x, y1: newStart.y });
          return { result: { status: "applied" }, changed: [t0.id] };
        }
        return { result: { status: "blocked", reason: "both endpoints fixed — the length conflicts with the fixed geometry" }, changed: [] };
      }
      // Anchor pair separation.
      if (g1 === null) return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      const pa = anchorPosition(g0, t0.anchor ?? "start");
      const pb = anchorPosition(g1, t1.anchor ?? "start");
      if (pa === null || pb === null) return { result: { status: "unsupported", reason: "anchor not carried" }, changed: [] };
      const d = dist(pa, pb);
      if (Math.abs(d - value) <= EPS) return { result: { status: "satisfied" }, changed: [] };
      if (d <= EPS) return { result: { status: "ambiguous", reason: "the anchors coincide — no separation direction" }, changed: [] };
      const unit = norm(sub(pb, pa));
      if (canMoveAnchor(w, t1.id, t1.anchor)) {
        const moved = moveAnchorGeom(g1, t1.anchor ?? "start", add(pa, mul(unit, value)));
        if (moved === null) return { result: { status: "unsupported", reason: "anchor not movable" }, changed: [] };
        setGeom(w, t1.id, moved);
        return { result: { status: "applied" }, changed: [t1.id] };
      }
      if (canMoveAnchor(w, t0.id, t0.anchor)) {
        const moved = moveAnchorGeom(g0, t0.anchor ?? "start", add(pb, mul(unit, -value)));
        if (moved === null) return { result: { status: "unsupported", reason: "anchor not movable" }, changed: [] };
        setGeom(w, t0.id, moved);
        return { result: { status: "applied" }, changed: [t0.id] };
      }
      return { result: { status: "blocked", reason: "both anchors fixed — the distance conflicts with the fixed geometry" }, changed: [] };
    }
    case "angle": {
      if (t1 === undefined || g1 === null) {
        return { result: { status: "unsupported", reason: "second target missing" }, changed: [] };
      }
      const la = asLine(g0);
      const lb = asLine(g1);
      if (la === null || lb === null) return { result: { status: "unsupported", reason: "targets must be lines" }, changed: [] };
      const da = lineDir(la);
      const db = lineDir(lb);
      if (len(da) <= EPS || len(db) <= EPS) {
        return { result: { status: "ambiguous", reason: "a zero-length line has no direction" }, changed: [] };
      }
      const v = verifyConstraint(w, c);
      if (v.satisfied) return { result: { status: "satisfied" }, changed: [] };
      // Rotate target[1] so the CCW angle from dirA equals the value.
      const targetDir = rotatePt2(norm(da), c.value ?? 0);
      if (!canMoveAnchor(w, t1.id, "start")) {
        if (canMoveAnchor(w, t1.id, "end")) {
          setGeom(w, t1.id, rotateLineTo(lb, { x: lb.x2, y: lb.y2 }, targetDir));
          return { result: { status: "applied" }, changed: [t1.id] };
        }
        return { result: { status: "blocked", reason: "both endpoints of the rotated line are fixed" }, changed: [] };
      }
      setGeom(w, t1.id, rotateLineTo(lb, { x: lb.x1, y: lb.y1 }, targetDir));
      return { result: { status: "applied" }, changed: [t1.id] };
    }
    case "radius": {
      const value = c.value ?? 0;
      const circle = asCircleLike(g0);
      if (circle === null) return { result: { status: "unsupported", reason: "target is not a circle/arc" }, changed: [] };
      if (Math.abs(circle.r - value) <= EPS) return { result: { status: "satisfied" }, changed: [] };
      if (!canMoveEntity(w, t0.id)) {
        return { result: { status: "blocked", reason: "the circle is fixed — the radius conflicts with the fixed geometry" }, changed: [] };
      }
      setGeom(w, t0.id, { ...g0, r: value } as Geom);
      return { result: { status: "applied" }, changed: [t0.id] };
    }
  }
}

/** Apply a line↔circle tangency: `adjusterKind` names target[1] (the
 *  adjusting side of the record — target[0] is authoritative); the fixed
 *  flip hands the role to the other side. One shared closed form: the
 *  required signed distance along the line's unit normal is ±r (the
 *  center's side is preserved; the through-center default is +n). */
function applyTangentLineCircle(
  w: Worlds,
  line: LineGeom,
  circle: CircleGeom | ArcGeom,
  adjustTarget: { id: string },
  otherTarget: { id: string },
  adjusterKind: "line" | "circle",
): { result: ApplyStatus; changed: string[] } {
  if (len(lineDir(line)) <= EPS) {
    return { result: { status: "ambiguous", reason: "a zero-length line has no tangent direction" }, changed: [] };
  }
  const dir = norm(lineDir(line));
  const n: Pt = { x: -dir.y, y: dir.x };
  const a: Pt = { x: line.x1, y: line.y1 };
  const center: Pt = { x: circle.cx, y: circle.cy };
  const signed = dot(sub(center, a), n);
  const targetSigned = signed >= 0 ? circle.r : -circle.r;
  const shift = signed - targetSigned; // the LINE's travel along n
  if (Math.abs(shift) <= EPS) return { result: { status: "satisfied" }, changed: [] };
  const applyTo = (targetId: string, kind: "line" | "circle", geom: Geom): void => {
    const delta = mul(n, kind === "line" ? shift : -shift);
    setGeom(w, targetId, translateGeom(geom, delta));
  };
  if (canMoveEntity(w, adjustTarget.id)) {
    applyTo(adjustTarget.id, adjusterKind, adjusterKind === "line" ? line : circle);
    return { result: { status: "applied" }, changed: [adjustTarget.id] };
  }
  const otherKind: "line" | "circle" = adjusterKind === "line" ? "circle" : "line";
  if (canMoveEntity(w, otherTarget.id)) {
    applyTo(otherTarget.id, otherKind, otherKind === "line" ? line : circle);
    return { result: { status: "applied" }, changed: [otherTarget.id] };
  }
  return { result: { status: "blocked", reason: "both the line and the circle are fixed — tangency conflicts with the fixed geometry" }, changed: [] };
}

function rot90(v: Pt): Pt {
  return { x: -v.y, y: v.x };
}

function rotatePt2(v: Pt, angle: number): Pt {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: cos * v.x - sin * v.y, y: sin * v.x + cos * v.y };
}

// ---------------------------------------------------------------------------
// Components + DoF.
// ---------------------------------------------------------------------------

/** Build the constraint graph index over the constrainable element world. */
function buildWorlds(elements: readonly Element[], constraints: readonly ConstraintRecord[]): Worlds {
  const byId = new Map<string, Working>();
  for (const el of elements) {
    const geom = constrainableGeomOf(el);
    if (geom !== null) byId.set(el.id, { geom });
  }
  const byEntity = new Map<string, ConstraintRecord[]>();
  for (const c of constraints) {
    for (const t of c.targets) {
      let list = byEntity.get(t.id);
      if (list === undefined) {
        list = [];
        byEntity.set(t.id, list);
      }
      list.push(c);
    }
  }
  for (const list of byEntity.values()) {
    list.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }
  return { byId, constraints: [...constraints].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)), byEntity, fixed: fixedSetsOf(constraints) };
}

/** Connected components over shared entities (deterministic: entities in
 *  id order, BFS neighbors in constraint-id order). */
function componentsOf(w: Worlds): Map<string, string[]> {
  const entityIds = [...w.byEntity.keys()].sort();
  const visited = new Set<string>();
  const components = new Map<string, string[]>();
  for (const seed of entityIds) {
    if (visited.has(seed)) continue;
    const comp: string[] = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length > 0) {
      const id = queue.shift()!;
      comp.push(id);
      for (const c of w.byEntity.get(id) ?? []) {
        for (const t of c.targets) {
          if (!visited.has(t.id) && w.byEntity.has(t.id)) {
            visited.add(t.id);
            queue.push(t.id);
          }
        }
      }
    }
    comp.sort();
    components.set(comp[0]!, comp);
  }
  return components;
}

/** The declared DoF of a component (the bounded formula). */
function componentDof(w: Worlds, entityIds: readonly string[], constraintIds: ReadonlySet<string>): number {
  let dof = 0;
  for (const id of entityIds) {
    const geom = w.byId.get(id)?.geom;
    if (geom !== undefined) dof += entityDof(geom);
  }
  for (const c of w.constraints) {
    if (!constraintIds.has(c.id)) continue;
    if (c.kind === "fixed") {
      const t = c.targets[0]!;
      const geom = w.byId.get(t.id)?.geom;
      if (geom === undefined) continue;
      if (t.anchor === undefined) dof -= entityDof(geom);
      else dof -= 2;
    } else {
      dof -= constraintDof(c.kind, c.targets[0]!);
    }
  }
  return dof;
}

// ---------------------------------------------------------------------------
// The solve entry points.
// ---------------------------------------------------------------------------

const OUTCOME_SEVERITY: Readonly<Record<SolveOutcome, number>> = {
  unsupported: 5,
  ambiguous: 4,
  "over-constrained": 3,
  unsatisfied: 2,
  "under-constrained": 1,
  solved: 0,
};

function worse(a: SolveOutcome, b: SolveOutcome): SolveOutcome {
  return OUTCOME_SEVERITY[a] >= OUTCOME_SEVERITY[b] ? a : b;
}

/**
 * The deterministic solve. `options.seedIds` drives the worklist (default:
 * every constrained entity — a full-graph solve); `options.before` enables
 * the fixed-restore pass (the constraint-aware edit cascade).
 */
export function solveConstraints(
  elements: readonly Element[],
  constraints: readonly ConstraintRecord[],
  options: SolveOptions = {},
): SolveResult {
  const w = buildWorlds(elements, constraints);
  const notes: string[] = [];
  const geometry = new Map<string, Geom>();
  const statuses: ConstraintStatus[] = [];
  const dof: ComponentDof[] = [];
  let outcome: SolveOutcome = "solved";

  // Constraint ids whose targets left the vocabulary (unsupported — reported,
  // never silently dropped).
  const unsupportedIds = new Set<string>();
  for (const c of w.constraints) {
    const bad = c.targets.some((t) => !w.byId.has(t.id));
    if (bad) unsupportedIds.add(c.id);
  }
  if (unsupportedIds.size > 0) outcome = worse(outcome, "unsupported");

  // The fixed-restore pass (the constraint-aware edit cascade): entities
  // whose pinned anchors moved relative to `before` go back FIRST.
  if (options.before !== undefined) {
    const beforeById = new Map<string, Element>();
    for (const el of options.before) beforeById.set(el.id, el);
    const restored = new Set<string>();
    for (const c of w.constraints) {
      if (c.kind !== "fixed") continue;
      const t = c.targets[0]!;
      const nowGeom = w.byId.get(t.id)?.geom;
      const beforeEl = beforeById.get(t.id);
      const beforeGeom = beforeEl !== undefined ? constrainableGeomOf(beforeEl) : null;
      if (nowGeom === undefined || beforeGeom === null) continue;
      if (JSON.stringify(nowGeom) === JSON.stringify(beforeGeom)) continue;
      if (t.anchor === undefined) {
        w.byId.set(t.id, { geom: beforeGeom });
        restored.add(t.id);
      } else {
        const beforePos = anchorPosition(beforeGeom, t.anchor);
        if (beforePos !== null) {
          const moved = moveAnchorGeom(nowGeom, t.anchor, beforePos);
          if (moved !== null) {
            w.byId.set(t.id, { geom: moved });
            restored.add(t.id);
          }
        }
      }
    }
    for (const id of [...restored].sort()) {
      notes.push(`'${id}' restored to its fixed position`);
    }
    // Restored entities join the seeds (their constraints re-fire).
    const seedSet = new Set(options.seedIds ?? []);
    for (const id of restored) seedSet.add(id);
    options = { ...options, seedIds: [...seedSet] };
  }

  // Components (deterministic order).
  const components = componentsOf(w);
  for (const [compKey, entityIds] of [...components.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const constraintIds = new Set<string>();
    for (const id of entityIds) {
      for (const c of w.byEntity.get(id) ?? []) constraintIds.add(c.id);
    }
    const compDof = componentDof(w, entityIds, constraintIds);
    dof.push({ entities: entityIds, constraints: [...constraintIds].sort(), dof: compDof });

    // Unsupported constraints are reported and never applied (their targets
    // left the vocabulary); the rest of the component still propagates.
    // Deterministic propagation worklist (skipped for diagnostics — no
    // seeds means verify-only).
    const seeds = (options.seedIds ?? [...entityIds]).filter((id) => entityIds.includes(id));
    const blocked = new Map<string, string>();
    const ambiguous = new Map<string, string>();
    if (seeds.length > 0) {
      const queue: string[] = [...new Set(seeds)].sort();
      const passBound = 4 * (constraintIds.size + entityIds.length) + 16;
      let passes = 0;
      while (queue.length > 0 && passes < passBound) {
        const id = queue.shift()!;
        passes += 1;
        for (const c of w.byEntity.get(id) ?? []) {
          if (unsupportedIds.has(c.id)) continue;
          const { result, changed } = applyConstraint(w, c);
          if (result.status === "blocked") blocked.set(c.id, result.reason);
          else blocked.delete(c.id);
          if (result.status === "ambiguous") ambiguous.set(c.id, result.reason);
          else ambiguous.delete(c.id);
          if (result.status === "applied") {
            for (const changedId of changed) {
              if (w.byId.has(changedId)) queue.push(changedId);
            }
          }
        }
      }
      if (queue.length > 0) {
        notes.push(`pass bound reached on the component of '${compKey}' — verification decides the final state`);
      }
    }

    // Verification + classification for this component.
    let anyViolated = false;
    let anyBlocked = false;
    let anyAmbiguous = false;
    for (const c of w.constraints) {
      if (!constraintIds.has(c.id)) continue;
      if (unsupportedIds.has(c.id)) {
        statuses.push({ id: c.id, kind: c.kind, satisfied: false, note: "a target left the constrained vocabulary" });
        continue;
      }
      const v = verifyConstraint(w, c);
      if (v.satisfied) {
        statuses.push({ id: c.id, kind: c.kind, satisfied: true, note: null });
        continue;
      }
      anyViolated = true;
      const blockedReason = blocked.get(c.id);
      const ambiguousReason = ambiguous.get(c.id);
      if (blockedReason !== undefined) anyBlocked = true;
      if (ambiguousReason !== undefined) anyAmbiguous = true;
      statuses.push({
        id: c.id,
        kind: c.kind,
        satisfied: false,
        note: blockedReason ?? ambiguousReason ?? v.note,
      });
    }
    // Classification precedence (most severe wins; the statuses carry the
    // full detail): blocked conflict > structural redundancy (DoF < 0) >
    // ambiguous degeneracy > unsatisfied violation > under-constrained.
    if (anyBlocked) outcome = worse(outcome, "over-constrained");
    if (compDof < 0) outcome = worse(outcome, "over-constrained");
    if (anyAmbiguous) outcome = worse(outcome, "ambiguous");
    if (anyViolated) outcome = worse(outcome, "unsatisfied");
    if (!anyViolated && compDof > 0) outcome = worse(outcome, "under-constrained");
  }

  // Collect the changed geometry (relative to the input world).
  const inputById = new Map<string, Element>();
  for (const el of elements) inputById.set(el.id, el);
  for (const [id, work] of w.byId) {
    const el = inputById.get(id);
    if (el === undefined) continue;
    const before = constrainableGeomOf(el);
    if (before === null) continue;
    if (JSON.stringify(before) !== JSON.stringify(work.geom)) geometry.set(id, work.geom);
  }

  statuses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { outcome, geometry, statuses, dof, notes };
}

/** Verify-only diagnostics (no propagation, no geometry change): the
 *  satisfaction status + DoF accounting of the declared graph. */
export function diagnoseConstraints(
  elements: readonly Element[],
  constraints: readonly ConstraintRecord[],
): SolveResult {
  return solveConstraints(elements, constraints, { seedIds: [] });
}

/** The constraint ids referencing any removed element id (the severance
 *  set — the CAD-PARITY-005 dead-ref precedent: severed explicitly, never
 *  left dangling). */
export function constraintsReferencing(
  constraints: readonly ConstraintRecord[],
  removedIds: ReadonlySet<string>,
): ConstraintRecord[] {
  return constraints.filter((c) => c.targets.some((t) => removedIds.has(t.id)));
}
