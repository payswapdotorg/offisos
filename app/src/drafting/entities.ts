/**
 * Canonical drafting entities (COMPAT-CAD-001, Issue #37 scope).
 *
 * Drafting entities are CADDocument ELEMENTS whose `props` follow the
 * canonical drafting layout defined here. Element identity stays the
 * canonical document identity (§5.4); `engineId` is null — 2D drafting
 * entities are engine-free editor-domain geometry (LOCK-018/019: the OCCT
 * adapter boundary governs 3D solids; drafting never touches an engine).
 *
 * Props layout (per type; every number finite — LOCK-007 rejects otherwise):
 *   line:       { drafting, type:"line", layer, from:[x,y], to:[x,y] }
 *   polyline:   { drafting, type:"polyline", layer, points:[[x,y],…≥2], closed?:bool }
 *   circle:     { drafting, type:"circle", layer, center:[x,y], radius:r>0 }
 *   arc:        { drafting, type:"arc", layer, center, radius, startAngle, endAngle }  // CCW sweep, < 2π
 *   rectangle:  { drafting, type:"rectangle", layer, corner1:[x,y], corner2:[x,y] }    // axis-aligned
 *   dim-linear: { drafting, type:"dim-linear", layer, p1, p2, mode, offset, measured } // measured computed at creation
 *   dim-radius: { drafting, type:"dim-radius", layer, target:<entity id>, measured }    // measured computed at creation
 *
 * Dimensions are ANNOTATION entities. Their `measured` value is computed
 * deterministically at creation and stored (no silent recomputation later —
 * live parametric update is an explicit non-goal of this slice).
 */

import type { Element } from "../contracts/caddocument.js";
import {
  COINCIDENCE_EPS,
  PARAM_EPS,
  Vec2,
  assertFinite,
  assertPoint,
  assertPositiveFinite,
  ccwSweep,
  normalizeAngle,
} from "./precision.js";
import * as g from "./geom2d.js";

export const DRAFTING_PROPS_MARK = "drafting";

export type DraftEntityType =
  | "line"
  | "polyline"
  | "circle"
  | "arc"
  | "rectangle"
  | "dim-linear"
  | "dim-radius";

export type LinearDimMode = "aligned" | "horizontal" | "vertical";

export interface DraftEntityBase {
  readonly id: string;
  /** Canonical layer id (must exist in the document layer table). */
  readonly layer: string;
}

export interface LineEntity extends DraftEntityBase {
  readonly type: "line";
  readonly from: Vec2;
  readonly to: Vec2;
}
export interface PolylineEntity extends DraftEntityBase {
  readonly type: "polyline";
  readonly points: readonly Vec2[];
  readonly closed: boolean;
}
export interface CircleEntity extends DraftEntityBase {
  readonly type: "circle";
  readonly center: Vec2;
  readonly radius: number;
}
export interface ArcEntity extends DraftEntityBase {
  readonly type: "arc";
  readonly center: Vec2;
  readonly radius: number;
  /** Normalized [0, 2π). */
  readonly startAngle: number;
  /** Normalized [0, 2π); CCW sweep in (0, 2π). */
  readonly endAngle: number;
}
export interface RectangleEntity extends DraftEntityBase {
  readonly type: "rectangle";
  readonly corner1: Vec2;
  readonly corner2: Vec2;
}
export interface LinearDimensionEntity extends DraftEntityBase {
  readonly type: "dim-linear";
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly mode: LinearDimMode;
  /** Signed perpendicular offset of the dimension line from p1→p2. */
  readonly offset: number;
  /** Distance in drawing units per `mode`, computed at creation. */
  readonly measured: number;
}
export interface RadiusDimensionEntity extends DraftEntityBase {
  readonly type: "dim-radius";
  /** The measured entity's canonical id (circle or arc). */
  readonly target: string;
  readonly measured: number;
}

export type DraftEntity =
  | LineEntity
  | PolylineEntity
  | CircleEntity
  | ArcEntity
  | RectangleEntity
  | LinearDimensionEntity
  | RadiusDimensionEntity;

/** Distributive Omit so each union member keeps its own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type DraftEntityInput = DistributiveOmit<DraftEntity, "id"> & { id?: string };

// --- Construction + validation (LOCK-007: reject, never guess) ---------------

export function makeLine(input: Record<string, unknown>): { type: "line"; layer: string; from: Vec2; to: Vec2 } {
  const from = assertPoint(input.from, "line.from");
  const to = assertPoint(input.to, "line.to");
  if (g.distance(from, to) <= COINCIDENCE_EPS) {
    throw new Error("line.from and line.to must not coincide (zero-length entities are rejected)");
  }
  return { type: "line", layer: requireLayer(input.layer), from, to };
}

export function makePolyline(input: Record<string, unknown>): { type: "polyline"; layer: string; points: readonly Vec2[]; closed: boolean } {
  if (!Array.isArray(input.points) || input.points.length < 2) {
    throw new Error("polyline.points must be an array of at least 2 points");
  }
  const points = input.points.map((p, i) => assertPoint(p, `polyline.points[${i}]`));
  for (let i = 1; i < points.length; i++) {
    if (g.distance(points[i - 1] as Vec2, points[i] as Vec2) <= COINCIDENCE_EPS) {
      throw new Error(`polyline.points[${i - 1}] and points[${i}] must not coincide`);
    }
  }
  const closed = input.closed === undefined ? false : input.closed;
  if (typeof closed !== "boolean") throw new Error("polyline.closed must be a boolean");
  if (closed && points.length === 2) {
    throw new Error("a closed polyline needs at least 3 points (2 points closed is a degenerate zero-area loop)");
  }
  return { type: "polyline", layer: requireLayer(input.layer), points, closed };
}

export function makeCircle(input: Record<string, unknown>): { type: "circle"; layer: string; center: Vec2; radius: number } {
  const center = assertPoint(input.center, "circle.center");
  const radius = assertPositiveFinite(input.radius, "circle.radius");
  return { type: "circle", layer: requireLayer(input.layer), center, radius };
}

export function makeArc(input: Record<string, unknown>): { type: "arc"; layer: string; center: Vec2; radius: number; startAngle: number; endAngle: number } {
  const center = assertPoint(input.center, "arc.center");
  const radius = assertPositiveFinite(input.radius, "arc.radius");
  const startAngle = assertFinite(input.startAngle, "arc.startAngle");
  const endAngle = assertFinite(input.endAngle, "arc.endAngle");
  const sweep = ccwSweep(startAngle, endAngle);
  // Normalize AFTER the degeneracy check so a genuine full sweep is still
  // rejected; normalization keeps start < end representable.
  const a0 = normalizeAngle(startAngle);
  const a1 = normalizeAngle(endAngle);
  if (sweep >= 2 * Math.PI - PARAM_EPS || sweep <= PARAM_EPS) {
    throw new Error("arc sweep must be in (0, 2π) — a full/empty circle is the `circle` entity, not an arc");
  }
  return { type: "arc", layer: requireLayer(input.layer), center, radius, startAngle: a0, endAngle: a1 };
}

export function makeRectangle(input: Record<string, unknown>): { type: "rectangle"; layer: string; corner1: Vec2; corner2: Vec2 } {
  const corner1 = assertPoint(input.corner1, "rectangle.corner1");
  const corner2 = assertPoint(input.corner2, "rectangle.corner2");
  const width = Math.abs(corner1[0] - corner2[0]);
  const height = Math.abs(corner1[1] - corner2[1]);
  if (width <= COINCIDENCE_EPS || height <= COINCIDENCE_EPS) {
    throw new Error("rectangle corners must span a non-degenerate axis-aligned area (zero width/height rejected)");
  }
  return { type: "rectangle", layer: requireLayer(input.layer), corner1, corner2 };
}

/** Deterministic measured value for a linear dimension. */
export function linearMeasured(p1: Vec2, p2: Vec2, mode: LinearDimMode): number {
  switch (mode) {
    case "aligned":
      return g.distance(p1, p2);
    case "horizontal":
      return Math.abs(p2[0] - p1[0]);
    case "vertical":
      return Math.abs(p2[1] - p1[1]);
  }
}

export function makeLinearDimension(input: Record<string, unknown>): { type: "dim-linear"; layer: string; p1: Vec2; p2: Vec2; mode: LinearDimMode; offset: number; measured: number } {
  const p1 = assertPoint(input.p1, "dim-linear.p1");
  const p2 = assertPoint(input.p2, "dim-linear.p2");
  const mode = input.mode === undefined ? "aligned" : input.mode;
  if (mode !== "aligned" && mode !== "horizontal" && mode !== "vertical") {
    throw new Error("dim-linear.mode must be 'aligned' | 'horizontal' | 'vertical'");
  }
  if (g.distance(p1, p2) <= COINCIDENCE_EPS) {
    throw new Error("dim-linear.p1 and p2 must not coincide");
  }
  const offset = input.offset === undefined ? 0 : assertFinite(input.offset, "dim-linear.offset");
  const measured = linearMeasured(p1, p2, mode);
  if (mode !== "aligned" && measured <= COINCIDENCE_EPS) {
    throw new Error(`dim-linear: the measured ${mode} distance is zero — use a mode that matches a non-zero extent`);
  }
  return { type: "dim-linear", layer: requireLayer(input.layer), p1, p2, mode, offset, measured };
}

export function makeRadiusDimension(input: Record<string, unknown>): { type: "dim-radius"; layer: string; target: string; measured: number } {
  if (typeof input.target !== "string" || input.target.length === 0) {
    throw new Error("dim-radius.target must be a non-empty entity id");
  }
  const target: string = input.target;
  const measured = assertPositiveFinite(input.measured, "dim-radius.measured");
  return { type: "dim-radius", layer: requireLayer(input.layer), target, measured };
}

function requireLayer(layer: unknown): string {
  if (typeof layer !== "string" || layer.length === 0) {
    throw new Error("drafting entities require a layer id (the canonical default is '0')");
  }
  return layer;
}

// --- Element ⇄ entity mapping -------------------------------------------------

function isAnnotation(type: DraftEntityType): boolean {
  return type === "dim-linear" || type === "dim-radius";
}

/** Build the CADDocument element for a drafting entity. `id` may be empty —
 *  the DOCUMENT mints the canonical identity on addElement. */
export function draftEntityToElement(entity: DraftEntityInput): Element {
  const id = entity.id !== undefined && entity.id.length > 0 ? entity.id : "";
  const props: Record<string, unknown> = { drafting: true, type: entity.type, layer: entity.layer };
  switch (entity.type) {
    case "line":
      props.from = entity.from;
      props.to = entity.to;
      break;
    case "polyline":
      props.points = entity.points;
      props.closed = entity.closed;
      break;
    case "circle":
      props.center = entity.center;
      props.radius = entity.radius;
      break;
    case "arc":
      props.center = entity.center;
      props.radius = entity.radius;
      props.startAngle = entity.startAngle;
      props.endAngle = entity.endAngle;
      break;
    case "rectangle":
      props.corner1 = entity.corner1;
      props.corner2 = entity.corner2;
      break;
    case "dim-linear":
      props.p1 = entity.p1;
      props.p2 = entity.p2;
      props.mode = entity.mode;
      props.offset = entity.offset;
      props.measured = entity.measured;
      break;
    case "dim-radius":
      props.target = entity.target;
      props.measured = entity.measured;
      break;
  }
  return { id, kind: isAnnotation(entity.type) ? "annotation" : "geometry", engineId: null, props };
}

/** Soft check: is this element a drafting entity? (rendering filter) */
export function isDraftingElement(el: Element): boolean {
  const p = el.props as Record<string, unknown>;
  return p !== null && typeof p === "object" && p[DRAFTING_PROPS_MARK] === true && typeof p.type === "string";
}

/** Strict parse of a drafting element (LOCK-007: throws on malformed props).
 *  Re-validated through the same constructors — no trusting stored props. */
export function elementToDraftEntity(el: Element): DraftEntity {
  if (!isDraftingElement(el)) {
    throw new Error(`element '${el.id}' is not a drafting entity`);
  }
  const p = el.props as Record<string, unknown>;
  const base = { id: el.id };
  switch (p.type) {
    case "line":
      return { ...base, ...makeLine({ from: p.from, to: p.to, layer: p.layer }) };
    case "polyline":
      return { ...base, ...makePolyline({ points: p.points, closed: p.closed, layer: p.layer }) };
    case "circle":
      return { ...base, ...makeCircle({ center: p.center, radius: p.radius, layer: p.layer }) };
    case "arc":
      return { ...base, ...makeArc({ center: p.center, radius: p.radius, startAngle: p.startAngle, endAngle: p.endAngle, layer: p.layer }) };
    case "rectangle":
      return { ...base, ...makeRectangle({ corner1: p.corner1, corner2: p.corner2, layer: p.layer }) };
    case "dim-linear":
      return { ...base, ...makeLinearDimension({ p1: p.p1, p2: p.p2, mode: p.mode, offset: p.offset, layer: p.layer }) };
    case "dim-radius":
      return { ...base, ...makeRadiusDimension({ target: p.target, measured: p.measured, layer: p.layer }) };
    default:
      throw new Error(`element '${el.id}': unknown drafting entity type '${String(p.type)}'`);
  }
}

// --- Geometry interpretation ---------------------------------------------------

/** A trimmable/snappable curve contributed by a drafting entity. */
export type DraftCurve =
  | { readonly kind: "segment"; readonly entityId: string; readonly part: number; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: "circle"; readonly entityId: string; readonly radius: number; readonly center: Vec2 }
  | { readonly kind: "arc"; readonly entityId: string; readonly startAngle: number; readonly sweep: number; readonly radius: number; readonly center: Vec2 };

/** The geometry curves of an entity (dimensions contribute none — they are
 *  annotation and never act as cutting/boundary geometry). */
export function entityCurves(entity: DraftEntity): readonly DraftCurve[] {
  switch (entity.type) {
    case "line":
      return [{ kind: "segment", entityId: entity.id, part: 0, a: entity.from, b: entity.to }];
    case "polyline": {
      const curves: DraftCurve[] = [];
      const n = entity.points.length;
      const last = entity.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = entity.points[i] as Vec2;
        const b = entity.points[(i + 1) % n] as Vec2;
        curves.push({ kind: "segment", entityId: entity.id, part: i, a, b });
      }
      return curves;
    }
    case "circle":
      return [{ kind: "circle", entityId: entity.id, center: entity.center, radius: entity.radius }];
    case "arc":
      return [{ kind: "arc", entityId: entity.id, center: entity.center, radius: entity.radius, startAngle: entity.startAngle, sweep: ccwSweep(entity.startAngle, entity.endAngle) }];
    case "rectangle": {
      const x0 = Math.min(entity.corner1[0], entity.corner2[0]);
      const y0 = Math.min(entity.corner1[1], entity.corner2[1]);
      const x1 = Math.max(entity.corner1[0], entity.corner2[0]);
      const y1 = Math.max(entity.corner1[1], entity.corner2[1]);
      const c: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return c.map((a, i) => ({
        kind: "segment" as const,
        entityId: entity.id,
        part: i,
        a,
        b: c[(i + 1) % 4] as Vec2,
      }));
    }
    case "dim-linear":
    case "dim-radius":
      return [];
  }
}

/** Is this entity an annotation (no cutting geometry, no translate)? */
export function isAnnotationEntity(entity: DraftEntity): boolean {
  return entity.type === "dim-linear" || entity.type === "dim-radius";
}

/** Translate an entity by (dx, dy): returns the PROPS PATCH for an
 *  updateElement edit (measured values are translation-invariant — a linear
 *  dimension's aligned/horizontal/vertical distance never changes under
 *  translation; radius dims have no own geometry). Returns null when the
 *  entity has nothing to translate. */
export function translatePatch(entity: DraftEntity, dx: number, dy: number): Record<string, unknown> | null {
  if (dx === 0 && dy === 0) return null;
  const move = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  switch (entity.type) {
    case "line":
      return { from: move(entity.from), to: move(entity.to) };
    case "polyline":
      return { points: entity.points.map(move) };
    case "circle":
      return { center: move(entity.center) };
    case "arc":
      return { center: move(entity.center) };
    case "rectangle":
      return { corner1: move(entity.corner1), corner2: move(entity.corner2) };
    case "dim-linear":
      return { p1: move(entity.p1), p2: move(entity.p2) };
    case "dim-radius":
      return null;
  }
}

/** Axis-aligned bounding box (min corner, max corner). Dimensions use their
 *  reference points plus the offset dimension line. */
export function entityBBox(entity: DraftEntity): readonly [Vec2, Vec2] {
  const box = (pts: readonly Vec2[]): [Vec2, Vec2] => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return [[minX, minY], [maxX, maxY]];
  };
  switch (entity.type) {
    case "line":
      return box([entity.from, entity.to]);
    case "polyline":
      return box(entity.points);
    case "circle":
      return box([
        [entity.center[0] - entity.radius, entity.center[1] - entity.radius],
        [entity.center[0] + entity.radius, entity.center[1] + entity.radius],
      ]);
    case "arc": {
      const sweep = ccwSweep(entity.startAngle, entity.endAngle);
      const pts: Vec2[] = [
        g.pointOnCircle(entity.center, entity.radius, entity.startAngle),
        g.pointOnCircle(entity.center, entity.radius, entity.endAngle),
      ];
      // Axis extremes within the sweep (deterministic multiples of π/2).
      const TWO_PI = 2 * Math.PI;
      for (let k = 0; k < 4; k++) {
        const axis = (k * Math.PI) / 2;
        // find the representative of `axis` within [start, start+sweep)
        let rep: number | null = null;
        for (let w = -1; w <= 1; w++) {
          const cand = axis + w * TWO_PI;
          if (cand >= entity.startAngle - PARAM_EPS && cand <= entity.startAngle + sweep + PARAM_EPS) {
            rep = cand;
            break;
          }
        }
        if (rep !== null) pts.push(g.pointOnCircle(entity.center, entity.radius, rep));
      }
      return box(pts);
    }
    case "rectangle":
      return box([entity.corner1, entity.corner2]);
    case "dim-linear": {
      const [p1o, p2o] = dimensionLinePoints(entity);
      return box([entity.p1, entity.p2, p1o, p2o]);
    }
    case "dim-radius":
      return box([[0, 0]]); // no own geometry (references its target)
  }
}

/** The offset dimension line points for a linear dimension (unit normal of
 *  p1→p2 scaled by the signed offset — the same construction for every mode;
 *  the mode only changes the measured value). */
export function dimensionLinePoints(entity: LinearDimensionEntity): readonly [Vec2, Vec2] {
  const d = g.sub(entity.p2, entity.p1);
  const len = g.length(d);
  if (len === 0) throw new Error("dim-linear: zero-length reference");
  const n: Vec2 = [-d[1] / len, d[0] / len];
  const p1o = g.add(entity.p1, g.scale(n, entity.offset));
  const p2o = g.add(entity.p2, g.scale(n, entity.offset));
  return [p1o, p2o];
}
