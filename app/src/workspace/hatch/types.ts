/**
 * COMPAT-CAD-010 (Issue #18) — canonical hatch entity vocabulary.
 *
 * Hatch entities are CADDocument ELEMENTS with `kind: "annotation"`, the
 * `drafting: true` + `hatch: true` markers and the canonical FLAT props
 * convention (Pt objects `{x, y}` — the CAD-PARITY-003/005 geometry
 * convention). They participate in the CAD-PARITY-004 layer model exactly
 * like every other drafting element (layer name in `props.layer`, display
 * overrides in `props.color/linetype/lineweight/transparency`).
 *
 * Storage layout (ADDITIVE + OPTIONAL-aware so legacy snapshots stay
 * byte-identical; every number finite — LOCK-007 rejects otherwise):
 *
 *   hatch: { drafting, hatch, type:"hatch", layer,
 *            pattern:"ANSI31"|"ANSI32"|"ANSI37"|"NET"|"DOTS"|"SOLID",
 *            scale (>0, multiplies the pattern's base spacing),
 *            angle (radians, additional rotation),
 *            boundary: [ { id: <boundary entity id>, loop } … ≥1 ],
 *            color?, …display }
 *
 *   loop: { kind:"polygon", points:[{x,y}…≥3] }
 *       | { kind:"circle",  center:{x,y}, radius:>0 }
 *
 * `boundary` is the ASSOCIATIVITY record (the CC005 dim-refs precedent):
 * every entry references the canonical boundary entity it was resolved
 * from AND stores the resolved loop snapshot. The stored snapshot is the
 * document truth between updates (the CAD-PARITY-005 measured-value
 * convention: no silent recomputation at render time); the boundary
 * cascade re-resolves the snapshots inside the SAME atomic revision when
 * a referenced boundary entity moves, and erasing a referenced boundary
 * entity cascade-erases the hatch (the CC008 ARRAY source-deletion
 * precedent — no orphaned hatch over a partial boundary).
 *
 * The pattern STROKES are never stored: they are style-driven presentation
 * derived deterministically from the stored definition (annotation/render
 * precedent — font metrics resolve live from the style). Both hosts paint
 * the SAME primitives through the shared painter (hatch/paint), so the
 * pick surface (hatch/pick) and the visible surface can never disagree.
 *
 * Bounded CC010 scope (honest, typed declines — LOCK-007):
 *  - boundary sources: closed polylines (both storage conventions),
 *    rectangles and circles. Open geometry, text, dimensions, blocks,
 *    xrefs and nested hatches are typed-declined as boundary sources;
 *  - hatch translation is BOUNDARY-OWNED: a hatch-only MOVE selection is a
 *    typed decline at the command layer (select the boundary entities —
 *    the hatch follows its associative boundary);
 *  - hatch.update rebinds pattern/scale/angle only (HATCHEDIT-class);
 *    boundary re-association is out of the bounded scope.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../../contracts/caddocument.js";
import { EPS, Pt, isPt } from "../geometry/math2d.js";

// ---------------------------------------------------------------------------
// The bounded pattern registry.
// ---------------------------------------------------------------------------

/** The bounded CC010 hatch pattern set (deterministic line-work
 *  conventions; the base spacing is in drawing units and multiplies by
 *  the entity `scale`). */
export type HatchPatternId = "SOLID" | "ANSI31" | "ANSI32" | "ANSI37" | "NET" | "DOTS";

/** One line family of a pattern (parallel lines at `spacing` along the
 *  normal, direction `angle`). */
export interface HatchLineFamily {
  readonly angle: number;
  readonly spacing: number;
}

export interface HatchPatternDef {
  readonly id: HatchPatternId;
  readonly families: readonly HatchLineFamily[];
  /** Solid fill (no line families; the loops themselves are filled). */
  readonly solid: boolean;
  /** Dot lattice (the families define the lattice axes). */
  readonly dots: boolean;
}

const P = (id: HatchPatternId, families: readonly HatchLineFamily[], flags: { solid?: boolean; dots?: boolean } = {}): HatchPatternDef => ({
  id,
  families,
  solid: flags.solid === true,
  dots: flags.dots === true,
});

/** The bounded pattern table (frozen registry — additive only). */
export const HATCH_PATTERNS: Readonly<Record<HatchPatternId, HatchPatternDef>> = {
  SOLID: P("SOLID", [], { solid: true }),
  ANSI31: P("ANSI31", [{ angle: Math.PI / 4, spacing: 3.175 }]),
  ANSI32: P("ANSI32", [{ angle: Math.PI / 4, spacing: 6.35 }]),
  ANSI37: P("ANSI37", [
    { angle: Math.PI / 4, spacing: 6.35 },
    { angle: (3 * Math.PI) / 4, spacing: 6.35 },
  ]),
  NET: P("NET", [
    { angle: 0, spacing: 6.35 },
    { angle: Math.PI / 2, spacing: 6.35 },
  ]),
  DOTS: P("DOTS", [{ angle: 0, spacing: 6.35 }], { dots: true }),
};

export const HATCH_PATTERN_IDS: readonly HatchPatternId[] = ["SOLID", "ANSI31", "ANSI32", "ANSI37", "NET", "DOTS"];

/** The painted dot radius convention (drawing units × entity scale). */
export const HATCH_DOT_RADIUS_FACTOR = 0.4;

// ---------------------------------------------------------------------------
// Boundary loops.
// ---------------------------------------------------------------------------

/** One closed boundary loop (exact — polygon or analytic circle). */
export type HatchLoop =
  | { readonly kind: "polygon"; readonly points: readonly Pt[] }
  | { readonly kind: "circle"; readonly center: Pt; readonly radius: number };

/** One associativity record: the boundary entity id + resolved loop. */
export interface HatchBoundaryRef {
  readonly id: string;
  readonly loop: HatchLoop;
}

// ---------------------------------------------------------------------------
// The entity.
// ---------------------------------------------------------------------------

export interface HatchEntity {
  readonly type: "hatch";
  readonly layer: string;
  readonly pattern: HatchPatternId;
  /** Multiplier on the pattern's base spacing (> 0). */
  readonly scale: number;
  /** Additional rotation in radians (finite). */
  readonly angle: number;
  readonly boundary: readonly HatchBoundaryRef[];
}

/** The typed error taxonomy for hatch operations (the shared App API
 *  convention: typed codes, never silent approximation — LOCK-007). */
export type HatchErrorCode =
  | "bad_input"
  | "bad_layer"
  | "bad_pattern"
  | "bad_boundary"
  | "bad_scale"
  | "bad_angle"
  | "hatch_unsupported";

export class HatchError extends Error {
  readonly code: HatchErrorCode;
  constructor(message: string, code: HatchErrorCode) {
    super(message);
    this.name = "HatchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Construction + validation (LOCK-007: reject, never guess).
// ---------------------------------------------------------------------------

function assertFiniteNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HatchError(`hatch.${field} must be a finite number`, "bad_input");
  }
  return v;
}

function requireLayer(layer: unknown): string {
  if (typeof layer !== "string" || layer.length === 0) {
    throw new HatchError("hatch entities require a layer id (the canonical default is '0')", "bad_layer");
  }
  return layer;
}

function parseLoop(raw: unknown, context: string): HatchLoop {
  if (typeof raw !== "object" || raw === null) {
    throw new HatchError(`${context}: loop must be an object`, "bad_boundary");
  }
  const loop = raw as Record<string, unknown>;
  if (loop.kind === "polygon") {
    if (!Array.isArray(loop.points) || loop.points.length < 3) {
      throw new HatchError(`${context}: polygon loop needs at least 3 points`, "bad_boundary");
    }
    const points: Pt[] = [];
    for (const [i, p] of (loop.points as unknown[]).entries()) {
      if (!isPt(p)) throw new HatchError(`${context}: points[${i}] must be {x, y}`, "bad_boundary");
      points.push({ x: (p as Pt).x, y: (p as Pt).y });
    }
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) {
        throw new HatchError(`${context}: points[${i}] and the next vertex must not coincide`, "bad_boundary");
      }
    }
    return { kind: "polygon", points };
  }
  if (loop.kind === "circle") {
    if (!isPt(loop.center)) throw new HatchError(`${context}: circle loop center must be {x, y}`, "bad_boundary");
    const radius = loop.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
      throw new HatchError(`${context}: circle loop radius must be a positive finite number`, "bad_boundary");
    }
    return { kind: "circle", center: { x: (loop.center as Pt).x, y: (loop.center as Pt).y }, radius };
  }
  throw new HatchError(`${context}: loop.kind must be 'polygon' or 'circle'`, "bad_boundary");
}

/** Strict constructor (validation-before-mutation everywhere). */
export function makeHatch(input: Record<string, unknown>): HatchEntity {
  if (typeof input.pattern !== "string" || !Object.prototype.hasOwnProperty.call(HATCH_PATTERNS, input.pattern)) {
    throw new HatchError(
      `hatch.pattern must be one of the bounded CC010 set: ${HATCH_PATTERN_IDS.join(", ")} (got '${String(input.pattern)}')`,
      "bad_pattern",
    );
  }
  const pattern = input.pattern as HatchPatternId;
  const scale = input.scale === undefined ? 1 : assertFiniteNumber(input.scale, "scale");
  if (scale <= 0) {
    throw new HatchError("hatch.scale must be > 0 (a non-positive pattern scale is rejected)", "bad_scale");
  }
  const angle = input.angle === undefined ? 0 : assertFiniteNumber(input.angle, "angle");
  if (!Array.isArray(input.boundary) || input.boundary.length === 0) {
    throw new HatchError("hatch.boundary must be a non-empty array of boundary references", "bad_boundary");
  }
  const boundary: HatchBoundaryRef[] = [];
  const seen = new Set<string>();
  for (const [i, rawRef] of (input.boundary as unknown[]).entries()) {
    if (typeof rawRef !== "object" || rawRef === null) {
      throw new HatchError(`hatch.boundary[${i}] must be an object`, "bad_boundary");
    }
    const ref = rawRef as Record<string, unknown>;
    if (typeof ref.id !== "string" || ref.id.length === 0) {
      throw new HatchError(`hatch.boundary[${i}].id must be a non-empty entity id`, "bad_boundary");
    }
    if (seen.has(ref.id)) {
      throw new HatchError(`hatch.boundary[${i}].id '${ref.id}' is listed twice (a boundary entity contributes one loop)`, "bad_boundary");
    }
    seen.add(ref.id);
    boundary.push({ id: ref.id, loop: parseLoop(ref.loop, `hatch.boundary[${i}]`) });
  }
  return { type: "hatch", layer: requireLayer(input.layer), pattern, scale, angle, boundary };
}

// ---------------------------------------------------------------------------
// Element ⇄ entity mapping.
// ---------------------------------------------------------------------------

/** Is this element a hatch entity? (soft marker check — rendering filter) */
export function isHatchElement(el: Element): boolean {
  if (el.kind !== "annotation") return false;
  const p = el.props as Record<string, unknown>;
  return p.hatch === true && p.type === "hatch";
}

/** Write a hatch to element props (flat canonical convention). */
export function hatchToProps(h: HatchEntity): Record<string, unknown> {
  return {
    drafting: true,
    hatch: true,
    type: "hatch",
    layer: h.layer,
    pattern: h.pattern,
    scale: h.scale,
    angle: h.angle,
    boundary: h.boundary.map((ref) => ({ id: ref.id, loop: ref.loop })),
  };
}

/** Strict parse of a hatch element (LOCK-007: throws on malformed props). */
export function elementToHatch(el: Element): HatchEntity {
  if (!isHatchElement(el)) {
    throw new HatchError(`element '${el.id}' is not a hatch entity`, "bad_input");
  }
  const p = el.props as Record<string, unknown>;
  return makeHatch({
    pattern: p.pattern,
    scale: p.scale,
    angle: p.angle,
    boundary: p.boundary,
    layer: p.layer,
  });
}

/** Soft load: the hatch view of an element, or null (honest readers never
 *  throw; write paths validate strictly). */
export function hatchFromElement(el: Element): HatchEntity | null {
  if (!isHatchElement(el)) return null;
  try {
    return elementToHatch(el);
  } catch {
    return null;
  }
}

/** Which element ids does this hatch reference (associativity)? */
export function hatchRefIds(h: HatchEntity): readonly string[] {
  return h.boundary.map((ref) => ref.id);
}

// ---------------------------------------------------------------------------
// Boundary resolution from document elements (server-side authority).
// ---------------------------------------------------------------------------

/** Resolve ONE boundary loop from a candidate boundary element.
 *  Supported sources (the bounded CC010 set): closed polylines in BOTH
 *  storage conventions, legacy rectangles and circles. Everything else —
 *  including open geometry, annotations, blocks and nested hatches — is a
 *  typed decline (never a guessed boundary). */
export function boundaryLoopOfElement(el: Element): HatchLoop {
  const props = el.props as Record<string, unknown>;
  // Canonical flat convention (CAD-PARITY-003: flat records).
  if (props.type === "polyline" && Array.isArray(props.vertices)) {
    if (props.closed !== true) {
      throw new HatchError(
        `boundary '${el.id}' is an OPEN polyline — the CC010 bounded boundary set is closed polylines, rectangles and circles (close it first or pick different geometry)`,
        "hatch_unsupported",
      );
    }
    if ((props.vertices as unknown[]).length < 3) {
      throw new HatchError(`boundary '${el.id}': a closed polygon loop needs at least 3 vertices`, "bad_boundary");
    }
    const points: Pt[] = [];
    for (const [i, v] of (props.vertices as unknown[]).entries()) {
      if (!isPt(v)) throw new HatchError(`boundary '${el.id}': vertices[${i}] must be {x, y}`, "bad_boundary");
      points.push({ x: (v as Pt).x, y: (v as Pt).y });
    }
    return { kind: "polygon", points };
  }
  if (props.type === "circle" && typeof props.cx === "number" && typeof props.cy === "number" && typeof props.r === "number") {
    if (!Number.isFinite(props.r) || props.r <= 0) {
      throw new HatchError(`boundary '${el.id}': circle radius must be a positive finite number`, "bad_boundary");
    }
    return { kind: "circle", center: { x: props.cx, y: props.cy }, radius: props.r };
  }
  // Legacy COMPAT-CAD-001 convention (tuple points).
  if (props.drafting === true) {
    if (props.type === "polyline" && Array.isArray(props.points)) {
      if (props.closed !== true) {
        throw new HatchError(
          `boundary '${el.id}' is an OPEN polyline — the CC010 bounded boundary set is closed polylines, rectangles and circles (close it first or pick different geometry)`,
          "hatch_unsupported",
        );
      }
      if ((props.points as unknown[]).length < 3) {
        throw new HatchError(`boundary '${el.id}': a closed polygon loop needs at least 3 points`, "bad_boundary");
      }
      const points: Pt[] = [];
      for (const [i, p] of (props.points as unknown[]).entries()) {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number") {
          throw new HatchError(`boundary '${el.id}': points[${i}] must be [x, y]`, "bad_boundary");
        }
        points.push({ x: p[0] as number, y: p[1] as number });
      }
      return { kind: "polygon", points };
    }
    if (props.type === "rectangle" && Array.isArray(props.corner1) && Array.isArray(props.corner2)) {
      const c1 = props.corner1 as [number, number];
      const c2 = props.corner2 as [number, number];
      const x0 = Math.min(c1[0], c2[0]);
      const y0 = Math.min(c1[1], c2[1]);
      const x1 = Math.max(c1[0], c2[0]);
      const y1 = Math.max(c1[1], c2[1]);
      if (x1 - x0 <= EPS || y1 - y0 <= EPS) {
        throw new HatchError(`boundary '${el.id}': rectangle must span a non-degenerate area`, "bad_boundary");
      }
      return { kind: "polygon", points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
    }
    if (props.type === "circle") {
      const radius = props.radius;
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
        throw new HatchError(`boundary '${el.id}': circle radius must be a positive finite number`, "bad_boundary");
      }
      if (Array.isArray(props.center) && props.center.length === 2 && typeof props.center[0] === "number" && typeof props.center[1] === "number") {
        const t = props.center as [number, number];
        return { kind: "circle", center: { x: t[0], y: t[1] }, radius };
      }
      if (isPt(props.center)) {
        const c = props.center as Pt;
        return { kind: "circle", center: { x: c.x, y: c.y }, radius };
      }
      throw new HatchError(`boundary '${el.id}': circle center must be [x, y] or {x, y}`, "bad_boundary");
    }
  }
  throw new HatchError(
    `boundary '${el.id}' (type '${String(props.type)}') is not a closed polyline, rectangle or circle — the bounded CC010 boundary set (open geometry, annotations, blocks and nested hatches are typed declines)`,
    "hatch_unsupported",
  );
}
