/**
 * CAD-PARITY-007 constraint vocabulary (Issue #86) — the canonical
 * parametric-constraint types: the declared record grammar, the constrained
 * entity gate, anchor resolution on the canonical geometry view, and the
 * degrees-of-freedom accounting.
 *
 * The DECLARED graph is stored in the CADDocument constraint table
 * (`con-NNNNNN` records, versioned through addConstraint/updateConstraint/
 * setConstraintRecord/removeConstraint); satisfaction is COMPUTED on demand
 * by the shared deterministic solver (solve.ts) — never persisted stale.
 *
 * The constrained vocabulary (bounded first slice — honest limits, LOCK-007):
 *   line   — anchors start/end/midpoint; DoF 4 (x1,y1,x2,y2)
 *   circle — anchor center;                 DoF 3 (cx,cy,r)
 *   arc    — anchor center;                 DoF 5 (cx,cy,r,startAngle,endAngle)
 *   point  — anchor start;                  DoF 2 (x,y)
 * Everything else (polyline/ellipse/spline/ray/xline/region, annotations,
 * BIM entities, block/xref instances) is an EXPLICIT typed unsupported
 * target — constraint creation declines, never guesses (Issue #86:
 * "Any unsupported relationship must decline with a typed result rather
 * than silently approximate").
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { ConstraintAnchor, ConstraintKind, ConstraintRecord, ConstraintTarget, Element } from "../../contracts/caddocument.js";
import type { Geom } from "../geometry/types.js";
import { geomFromElement } from "../geometry/bridge.js";
import { dist, EPS, Pt, TAU } from "../geometry/math2d.js";

// ---------------------------------------------------------------------------
// Typed failures (stable codes; LOCK-007/008).
// ---------------------------------------------------------------------------

export class ConstraintError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ConstraintError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The vocabulary tables (deterministic, documented).
// ---------------------------------------------------------------------------

export const GEOMETRIC_KINDS: readonly ConstraintKind[] = [
  "horizontal",
  "vertical",
  "coincident",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "fixed",
];

export const DIMENSIONAL_KINDS: readonly ConstraintKind[] = ["distance", "angle", "radius"];

export const ALL_KINDS: readonly ConstraintKind[] = [...GEOMETRIC_KINDS, ...DIMENSIONAL_KINDS];

/** Human labels (echo/palette surface, deterministic). */
export const CONSTRAINT_LABEL: Readonly<Record<ConstraintKind, string>> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
  coincident: "Coincident",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  fixed: "Fixed",
  distance: "Distance",
  angle: "Angle",
  radius: "Radius",
};

/** Short glyph letters (canvas badges — one shared table, LOCK-004). */
export const CONSTRAINT_GLYPH: Readonly<Record<ConstraintKind, string>> = {
  horizontal: "H",
  vertical: "V",
  coincident: "●",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  fixed: "FIX",
  distance: "d",
  angle: "∠",
  radius: "R",
};

/** Target arity per kind (structural — checked in makeConstraint). */
export const KIND_ARITY: Readonly<Record<ConstraintKind, 1 | 2 | "1-2">> = {
  horizontal: 1,
  vertical: 1,
  coincident: 2,
  parallel: 2,
  perpendicular: 2,
  equal: 2,
  tangent: 2,
  fixed: 1,
  distance: "1-2",
  angle: 2,
  radius: 1,
};

/** Does the kind require an anchor on its targets? "required" — every target
 *  carries an anchor; "none" — no target carries one; "optional" — fixed
 *  (whole entity or one anchor) and distance (line length vs anchor pair). */
export type AnchorRule = "required" | "none" | "optional";

export const KIND_ANCHOR_RULE: Readonly<Record<ConstraintKind, AnchorRule>> = {
  horizontal: "none",
  vertical: "none",
  coincident: "required",
  parallel: "none",
  perpendicular: "none",
  equal: "none",
  tangent: "none",
  fixed: "optional",
  distance: "optional",
  angle: "none",
  radius: "none",
};

/** The geometric entity types the constrained vocabulary admits. */
export const CONSTRAINED_TYPES: readonly Geom["type"][] = ["line", "circle", "arc", "point"];

/** Is this element part of the constrained vocabulary (a soft gate — the
 *  constructors validate strictly, readers never throw)? */
export function isConstrainableElement(el: Element): boolean {
  const geom = geomFromElement(el);
  return geom !== null && (CONSTRAINED_TYPES as readonly string[]).includes(geom.type);
}

// ---------------------------------------------------------------------------
// Anchors on the canonical geometry view.
// ---------------------------------------------------------------------------

/** The anchors an entity type carries (deterministic order). */
export function anchorsOfType(geom: Geom): ConstraintAnchor[] {
  switch (geom.type) {
    case "line":
      return ["start", "end", "midpoint"];
    case "circle":
      return ["center"];
    case "arc":
      return ["center"];
    case "point":
      return ["start"];
    default:
      return [];
  }
}

/** Resolve an anchor position on the canonical geometry (null when the
 *  geometry does not carry that anchor). */
export function anchorPosition(geom: Geom, anchor: ConstraintAnchor): Pt | null {
  switch (geom.type) {
    case "line":
    case "ray":
    case "xline":
      if (anchor === "start") return { x: geom.x1, y: geom.y1 };
      if (anchor === "end") return { x: geom.x2, y: geom.y2 };
      if (anchor === "midpoint") return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
      return null;
    case "circle":
    case "arc":
    case "ellipse":
      return anchor === "center" ? { x: geom.cx, y: geom.cy } : null;
    case "point":
      return anchor === "start" ? { x: geom.x, y: geom.y } : null;
    default:
      return null;
  }
}

/** The anchor of an entity NEAREST to a pick point (the entityPoint prompt
 *  semantics — deterministic tie-break: declaration order). Null when the
 *  entity carries no anchors (outside the vocabulary). */
export function nearestAnchor(geom: Geom, pick: Pt): ConstraintAnchor | null {
  const anchors = anchorsOfType(geom);
  if (anchors.length === 0) return null;
  let best: ConstraintAnchor | null = null;
  let bestD = Infinity;
  for (const anchor of anchors) {
    const pos = anchorPosition(geom, anchor);
    if (pos === null) continue;
    const d = dist(pos, pick);
    if (d < bestD - EPS) {
      bestD = d;
      best = anchor;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// DoF accounting (the bounded formula — deterministic, reproducible).
// ---------------------------------------------------------------------------

/** The declared degrees of freedom of a constrained-vocabulary entity. */
export function entityDof(geom: Geom): number {
  switch (geom.type) {
    case "line":
      return 4;
    case "circle":
      return 3;
    case "arc":
      return 5;
    case "point":
      return 2;
    default:
      return 0;
  }
}

/** The degrees of freedom a constraint removes (the declared accounting —
 *  the over/under-constrained classification is computed from it). A
 *  whole-entity fixed removes every DoF of its target — the caller resolves
 *  it against the entity's own DoF. */
export function constraintDof(kind: ConstraintKind, target: ConstraintTarget): number {
  switch (kind) {
    case "horizontal":
    case "vertical":
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "distance":
    case "angle":
    case "radius":
      return 1;
    case "coincident":
      return 2;
    case "fixed":
      // Whole-entity fixed removes every DoF of its target; anchor-level
      // fixed removes the 2 position DoF of that anchor.
      return target.anchor === undefined ? -1 : 2;
  }
}

// ---------------------------------------------------------------------------
// The record constructor (strict validation — LOCK-007: reject, never guess).
// ---------------------------------------------------------------------------

function fin(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConstraintError(`${field} must be a finite number`, "bad_input");
  }
  return v;
}

function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ConstraintError(`${field} must be a non-empty string`, "bad_input");
  }
  return v;
}

const ANCHORS: readonly ConstraintAnchor[] = ["start", "end", "center", "midpoint"];

/**
 * Validate + normalize ONE constraint record (the structural grammar — the
 * SEMANTIC vocabulary check against the actual elements is
 * validateConstraintTargets). Returns the canonical stored form:
 *  - kind must be part of the vocabulary;
 *  - target count satisfies the kind's arity;
 *  - anchors follow the kind's anchor rule;
 *  - dimensional kinds carry a positive finite value (angle additionally
 *    < 2π); geometric kinds carry none;
 *  - mode (external/internal) is tangent-only;
 *  - createdAt is required (the fixed deterministic provenance timestamp).
 */
export function makeConstraint(input: Record<string, unknown>): ConstraintRecord {
  const kind = input.kind;
  if (typeof kind !== "string" || !(ALL_KINDS as readonly string[]).includes(kind)) {
    throw new ConstraintError(
      `kind must be one of ${ALL_KINDS.join(", ")} (got '${String(kind)}')`,
      "bad_input",
    );
  }
  const k = kind as ConstraintKind;
  const id = input.id === undefined || input.id === null ? "" : nonEmpty(input.id, "id");
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new ConstraintError("targets must be a non-empty array", "bad_input");
  }
  const arity = KIND_ARITY[k];
  if (arity !== "1-2" && input.targets.length !== arity) {
    throw new ConstraintError(
      `${k} requires exactly ${arity} target${arity === 1 ? "" : "s"} (got ${input.targets.length})`,
      "bad_input",
    );
  }
  if (arity === "1-2" && input.targets.length > 2) {
    throw new ConstraintError(`${k} takes one or two targets (got ${input.targets.length})`, "bad_input");
  }
  const targets: ConstraintTarget[] = [];
  for (const [i, raw] of input.targets.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new ConstraintError(`targets[${i}] must be an object`, "bad_input");
    }
    const o = raw as Record<string, unknown>;
    targets.push({ id: nonEmpty(o.id, `targets[${i}].id`), ...(o.anchor !== undefined ? { anchor: anchorOf(o.anchor, `targets[${i}].anchor`) } : {}) });
  }
  const rule = KIND_ANCHOR_RULE[k];
  if (rule === "none") {
    for (const [i, t] of targets.entries()) {
      if (t.anchor !== undefined) {
        throw new ConstraintError(`${k} does not address anchors (targets[${i}].anchor must be absent)`, "bad_input");
      }
    }
  } else if (rule === "required") {
    for (const [i, t] of targets.entries()) {
      if (t.anchor === undefined) {
        throw new ConstraintError(`${k} requires an anchor on every target (targets[${i}].anchor missing)`, "bad_input");
      }
    }
  } else {
    // "optional": fixed — any mix; distance — all-or-none (line length vs
    // anchor pair; a mixed declaration is ambiguous by construction).
    if (k === "distance") {
      const withAnchor = targets.filter((t) => t.anchor !== undefined).length;
      if (withAnchor !== 0 && withAnchor !== targets.length) {
        throw new ConstraintError(
          "distance addresses either a whole line (no anchors) or an anchor pair (both anchors) — mixed declarations are ambiguous",
          "bad_input",
        );
      }
    }
  }
  let value: number | undefined;
  if ((DIMENSIONAL_KINDS as readonly string[]).includes(k)) {
    if (input.value === undefined || input.value === null) {
      throw new ConstraintError(`${k} requires a value (mm; radians for angle)`, "bad_input");
    }
    value = fin(input.value, `${k} value`);
    if (value <= 0) {
      throw new ConstraintError(`${k} value must be > 0`, "bad_input");
    }
    if (k === "angle" && value >= TAU) {
      throw new ConstraintError("angle value must be < 2π radians", "bad_input");
    }
  } else if (input.value !== undefined && input.value !== null) {
    throw new ConstraintError(`${k} does not carry a value (dimensional kinds only)`, "bad_input");
  }
  let mode: "external" | "internal" | undefined;
  if (input.mode !== undefined && input.mode !== null) {
    if (k !== "tangent") {
      throw new ConstraintError("mode is tangent-only (external/internal)", "bad_input");
    }
    if (input.mode !== "external" && input.mode !== "internal") {
      throw new ConstraintError("mode must be 'external' or 'internal'", "bad_input");
    }
    mode = input.mode;
  }
  const createdAt = nonEmpty(input.createdAt, "createdAt");
  const record: Record<string, unknown> = { kind: k, targets, createdAt };
  if (id.length > 0) record.id = id;
  if (value !== undefined) record.value = value;
  if (mode !== undefined) record.mode = mode;
  return record as unknown as ConstraintRecord;
}

function anchorOf(v: unknown, field: string): ConstraintAnchor {
  if (typeof v !== "string" || !(ANCHORS as readonly string[]).includes(v)) {
    throw new ConstraintError(`${field} must be one of ${ANCHORS.join(", ")}`, "bad_input");
  }
  return v as ConstraintAnchor;
}

// ---------------------------------------------------------------------------
// Semantic target validation (against the actual element world).
// ---------------------------------------------------------------------------

/** The circle-like geometry view of an element (circle/arc). Null otherwise. */
export function circleOf(el: Element): { center: Pt; radius: number; isArc: boolean } | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  if (geom.type === "circle") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r, isArc: false };
  if (geom.type === "arc") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r, isArc: true };
  return null;
}

/**
 * Validate a constraint's SEMANTICS against the actual elements: every
 * target must exist, be part of the constrained vocabulary, carry the
 * addressed anchor, and the kind's pairing must be supported:
 *  - horizontal/vertical: line
 *  - coincident: any two anchors of any two constrainable entities
 *  - parallel/perpendicular/angle: two lines
 *  - equal: two lines (lengths) or two circle-likes (radii) — same class
 *  - tangent: line + circle-like, or two circle-likes
 *  - fixed: any constrainable entity (whole or anchor)
 *  - distance: one line (length) or two anchors
 *  - radius: one circle-like
 * Throws ConstraintError("unsupported") with the specific reason — the
 * typed decline the work order demands (never a silent approximation).
 */
export function validateConstraintTargets(
  constraint: ConstraintRecord,
  elementById: (id: string) => Element | undefined,
): void {
  const geoms = constraint.targets.map((t) => {
    const el = elementById(t.id);
    if (el === undefined) {
      throw new ConstraintError(`target '${t.id}' does not exist`, "unsupported");
    }
    const geom = geomFromElement(el);
    if (geom === null || !(CONSTRAINED_TYPES as readonly string[]).includes(geom.type)) {
      throw new ConstraintError(
        `target '${t.id}' (${geom === null ? "non-geometry" : geom.type}) is outside the constrained vocabulary (line, circle, arc, point) — ${constraint.kind} declined`,
        "unsupported",
      );
    }
    if (t.anchor !== undefined) {
      if (anchorPosition(geom, t.anchor) === null) {
        throw new ConstraintError(
          `target '${t.id}' (${geom.type}) does not carry the '${t.anchor}' anchor`,
          "unsupported",
        );
      }
    }
    return geom;
  });
  const g0 = geoms[0];
  const g1 = geoms[1];
  const isLine = (g: Geom | undefined): boolean => g !== undefined && g.type === "line";
  const isCircleLike = (g: Geom | undefined): boolean => g !== undefined && (g.type === "circle" || g.type === "arc");
  switch (constraint.kind) {
    case "horizontal":
    case "vertical":
      if (!isLine(g0)) {
        throw new ConstraintError(
          `${constraint.kind} applies to lines (target '${constraint.targets[0]?.id}' is ${g0?.type ?? "unknown"})`,
          "unsupported",
        );
      }
      break;
    case "parallel":
    case "perpendicular":
    case "angle":
      if (!isLine(g0) || !isLine(g1)) {
        throw new ConstraintError(`${constraint.kind} applies to two lines`, "unsupported");
      }
      break;
    case "equal":
      if (isLine(g0) && isLine(g1)) break;
      if (isCircleLike(g0) && isCircleLike(g1)) break;
      throw new ConstraintError(
        "equal applies to two lines (equal lengths) or two circles/arcs (equal radii) — mixed pairings are unsupported",
        "unsupported",
      );
    case "tangent":
      if (isLine(g0) && isCircleLike(g1)) break;
      if (isCircleLike(g0) && isLine(g1)) break;
      if (isCircleLike(g0) && isCircleLike(g1)) break;
      throw new ConstraintError("tangent applies to a line and a circle/arc, or two circles/arcs", "unsupported");
    case "radius":
      if (!isCircleLike(g0)) {
        throw new ConstraintError("radius applies to a circle or arc", "unsupported");
      }
      break;
    case "coincident":
    case "fixed":
    case "distance":
      break;
  }
}

// ---------------------------------------------------------------------------
// Element ⇄ record helpers.
// ---------------------------------------------------------------------------

/** The element ids a constraint references. */
export function constraintElementIds(constraint: ConstraintRecord): string[] {
  return constraint.targets.map((t) => t.id);
}

/** Does this constraint reference any of the given element ids? */
export function constraintReferencesAny(constraint: ConstraintRecord, ids: ReadonlySet<string>): boolean {
  return constraint.targets.some((t) => ids.has(t.id));
}

/** Decode an element to its constrainable geometry (null when outside the
 *  vocabulary — readers never throw). */
export function constrainableGeomOf(el: Element): Geom | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  return (CONSTRAINED_TYPES as readonly string[]).includes(geom.type) ? geom : null;
}
