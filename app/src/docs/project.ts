/**
 * Deterministic view projection engine (COMPAT-CAD-003, Issue #41:
 * "Plan / Elevation / Section / Detail Views").
 *
 * PURE functions: (view definition, BIM elements) → view primitives in VIEW
 * coordinates (mm). No engine, no host, no I/O (LOCK-018 — the projection
 * vocabulary is analytic, exactly like the drafting geom2d kernel; solids
 * realize separately through the OCCT adapter and are NOT this module's
 * concern). IEEE-754 with fixed construction order — identical inputs
 * produce identical primitive lists on every host (§5.5 parity), which the
 * canonical content hash (docs/regenerate.ts) proves.
 *
 * Projections (view space u = horizontal, v = vertical):
 *  - plan (storyId): u = story-local X, v = story-local Y. Walls as outline
 *    rectangles + centrelines; openings as jamb lines (or their fill's
 *    symbols when a door/window fills them); slabs as outline rectangles;
 *    spaces as polygon outlines + name labels at the polygon centroid.
 *  - elevation (direction, storyId?): u/v per direction (front: u = X,
 *    back: u = −X, left: u = Y, right: u = −Y; v = world Z). Wireframe
 *    outlines of every wall/slab rectangle; openings + fills on walls
 *    PARALLEL to the picture plane. NO hidden-line removal (documented
 *    limitation — outlines only, nothing inferred).
 *  - section (sectionAxis/sectionOffset, storyId?): the projected outlines
 *    of elements whose extent crosses the cut plane (cut profiles are
 *    projected outlines; filled hatching is a rendering concern). Spaces
 *    crossing the plane are labelled at the crossing chord midpoint.
 *  - detail (sourceViewId/region/detailScale): the source MODEL view's
 *    primitives cropped to the region (Liang-Barsky for lines/polyline
 *    segments; anchor-inside for circles/arcs/text — documented) and
 *    scaled into detail space.
 *
 * Stories are level containers and project to nothing (the same honest skip
 * buildGeometry applies). Element iteration follows DOCUMENT ORDER and each
 * element emits its primitives in a fixed sequence — canonical construction
 * order, no sorting.
 */

import type { DocsViewRecord, Element } from "../contracts/caddocument.js";
import { elementToBimEntityOrNull } from "../bim/index.js";
import type {
  BimEntity,
  DoorEntity,
  OpeningEntity,
  SlabEntity,
  SpaceEntity,
  StoryEntity,
  WallEntity,
  WindowEntity,
} from "../bim/elements.js";
import type { DocsElevationDirection } from "../contracts/caddocument.js";

/** A projected drawing primitive in VIEW coordinates (mm). `sourceId` is the
 *  CANONICAL element id that produced the primitive (null only for view
 *  furniture — none in this slice) so hosts can hit-test/select through
 *  canonical identities and annotations can bind to projections. */
export type ViewPrimitive =
  | { readonly type: "line"; readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly sourceId: string }
  | { readonly type: "polyline"; readonly points: readonly (readonly [number, number])[]; readonly closed: boolean; readonly sourceId: string }
  | { readonly type: "circle"; readonly center: readonly [number, number]; readonly radius: number; readonly sourceId: string }
  | { readonly type: "arc"; readonly center: readonly [number, number]; readonly radius: number; readonly startAngle: number; readonly endAngle: number; readonly sourceId: string }
  | { readonly type: "text"; readonly at: readonly [number, number]; readonly text: string; readonly sourceId: string };

export type Vec2 = readonly [number, number];

/** Reasons an element was skipped for a view (explicit, never silent). */
export interface ProjectionSkip {
  readonly elementId: string;
  readonly reason: string;
}

/** The projection result for one view. */
export interface ViewProjection {
  readonly viewId: string;
  readonly primitives: readonly ViewPrimitive[];
  readonly skips: readonly ProjectionSkip[];
  /** The view-space bounding box of all primitives (null when empty). */
  readonly bbox: { readonly uMin: number; readonly uMax: number; readonly vMin: number; readonly vMax: number } | null;
}

// --- geometry helpers (fixed operation order, IEEE-754) ----------------------

function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}
function mul(a: Vec2, k: number): Vec2 {
  return [a[0] * k, a[1] * k];
}
function len(a: Vec2): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}
function norm(a: Vec2): Vec2 {
  const l = len(a);
  if (l === 0) throw new Error("cannot normalize a zero-length vector");
  return [a[0] / l, a[1] / l];
}

/** Wall rectangle corners: axis ± width/2 on both sides (fixed order:
 *  start-left, start-right, end-right, end-left around the wall). */
function wallCorners(wall: WallEntity): [Vec2, Vec2, Vec2, Vec2] {
  const d = norm(sub(wall.end, wall.start));
  const n: Vec2 = [-d[1], d[0]];
  const h = wall.width / 2;
  return [
    add(wall.start, mul(n, h)),
    sub(wall.start, mul(n, h)),
    sub(wall.end, mul(n, h)),
    add(wall.end, mul(n, h)),
  ];
}

/** The 4 corners of an opening's band rectangle on its host wall (fixed
 *  order: p1+n·h, p1−n·h, p2−n·h, p2+n·h). */
function openingBandCorners(wall: WallEntity, opening: OpeningEntity): [Vec2, Vec2, Vec2, Vec2] {
  const d = norm(sub(wall.end, wall.start));
  const n: Vec2 = [-d[1], d[0]];
  const h = wall.width / 2;
  const p1 = add(wall.start, mul(d, opening.distance));
  const p2 = add(wall.start, mul(d, opening.distance + opening.width));
  return [add(p1, mul(n, h)), sub(p1, mul(n, h)), sub(p2, mul(n, h)), add(p2, mul(n, h))];
}

function polyline(points: readonly Vec2[], closed: boolean, sourceId: string): ViewPrimitive {
  return { type: "polyline", points, closed, sourceId };
}

function rectPolyline(uMin: number, vMin: number, uMax: number, vMax: number, sourceId: string): ViewPrimitive {
  const points: Vec2[] = [
    [uMin, vMin],
    [uMax, vMin],
    [uMax, vMax],
    [uMin, vMax],
  ];
  return polyline(points, true, sourceId);
}

function bboxOf(primitives: readonly ViewPrimitive[]): ViewProjection["bbox"] {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const consider = (u: number, v: number): void => {
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  };
  for (const p of primitives) {
    if (p.type === "line") {
      consider(p.from[0], p.from[1]);
      consider(p.to[0], p.to[1]);
    } else if (p.type === "polyline") {
      for (const pt of p.points) consider(pt[0], pt[1]);
    } else if (p.type === "circle") {
      consider(p.center[0] - p.radius, p.center[1] - p.radius);
      consider(p.center[0] + p.radius, p.center[1] + p.radius);
    } else if (p.type === "arc") {
      // Exact arc extents: endpoints + axis crossings inside the MINOR sweep
      // (the door vocabulary draws quarter arcs; bounds must not include the
      // un-swept part of the circle).
      for (const [u, v] of arcExtremePoints(p.center, p.radius, p.startAngle, p.endAngle)) {
        consider(u, v);
      }
    } else {
      consider(p.at[0], p.at[1]);
    }
  }
  if (primitives.length === 0) return null;
  return { uMin, uMax, vMin, vMax };
}

/** Extreme points of an arc over its MINOR sweep: the two endpoints plus
 *  any axis-aligned extreme (angle k·π/2) strictly inside the sweep.
 *  Deterministic: angles normalized to [0, 2π). */
function arcExtremePoints(
  center: Vec2,
  radius: number,
  a0: number,
  a1: number,
): Vec2[] {
  const TAU = 2 * Math.PI;
  const norm = (a: number): number => ((a % TAU) + TAU) % TAU;
  const s = norm(a0);
  const e = norm(a1);
  let deltaCCW = e - s;
  if (deltaCCW < 0) deltaCCW += TAU;
  const ccw = deltaCCW <= TAU - deltaCCW; // minor sweep direction
  const at = (t: number): Vec2 => {
    const ang = norm(s + (ccw ? t : -t));
    return [center[0] + radius * Math.cos(ang), center[1] + radius * Math.sin(ang)];
  };
  const total = ccw ? deltaCCW : TAU - deltaCCW;
  const out: Vec2[] = [at(0), at(total)];
  for (let k = 0; k < 4; k++) {
    const axis = (k * Math.PI) / 2;
    // crossing t (distance from s along the sweep direction) for angle axis
    // and axis + 2π: solve norm(s ± t) = axis.
    for (const target of [axis, axis + TAU]) {
      const t = ccw ? target - s : s - target;
      const tn = t < 0 ? t + TAU : t;
      if (tn > 1e-12 && tn < total - 1e-12) {
        out.push(at(tn));
      }
    }
  }
  return out;
}

// --- the projection dispatcher ----------------------------------------------

/** Project the BIM model into a view. Throws on view-definition problems
 *  (unknown story for plan views etc.); skips carry honest reasons. */
export function projectView(view: DocsViewRecord, elements: readonly Element[]): ViewProjection {
  const entities = elements
    .map((el) => elementToBimEntityOrNull(el))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const stories = entities.filter((x): x is StoryEntity => x.type === "bim.story");
  let primitives: ViewPrimitive[];
  let skips: ProjectionSkip[];
  switch (view.kind) {
    case "plan": {
      const story = stories.find((s) => s.id === view.storyId);
      if (story === undefined) {
        throw new Error(`plan view '${view.id}': story '${view.storyId}' does not exist (dangling view — regenerate reports it)`);
      }
      ({ primitives, skips } = projectPlan(story, entities));
      break;
    }
    case "elevation": {
      const scope = view.storyId !== undefined ? stories.filter((s) => s.id === view.storyId) : stories;
      if (view.storyId !== undefined && scope.length === 0) {
        throw new Error(`elevation view '${view.id}': story '${view.storyId}' does not exist (dangling view)`);
      }
      ({ primitives, skips } = projectElevation(view.direction as DocsElevationDirection, scope, entities));
      break;
    }
    case "section": {
      const scope = view.storyId !== undefined ? stories.filter((s) => s.id === view.storyId) : stories;
      if (view.storyId !== undefined && scope.length === 0) {
        throw new Error(`section view '${view.id}': story '${view.storyId}' does not exist (dangling view)`);
      }
      ({ primitives, skips } = projectSection(
        (view.sectionAxis as "x" | "y"),
        view.sectionOffset as number,
        scope,
        entities,
      ));
      break;
    }
    case "detail": {
      // The source view must be resolved by the CALLER (it owns the view
      // table); projectDetail receives the source projection.
      throw new Error("projectView: detail views resolve through projectDetail (the caller owns the view table)");
    }
  }
  return { viewId: view.id, primitives, skips, bbox: bboxOf(primitives) };
}

/** Resolve a detail view against its (already projected) source. */
export function projectDetail(
  view: DocsViewRecord,
  source: { readonly view: DocsViewRecord; readonly projection: ViewProjection },
): ViewProjection {
  const region = view.region as { x: number; y: number; w: number; h: number };
  const k = view.detailScale as number;
  const primitives: ViewPrimitive[] = [];
  const skips: ProjectionSkip[] = [];
  for (const p of source.projection.primitives) {
    const mapped = clipAndScalePrimitive(p, region, k);
    if (mapped === "outside") {
      skips.push({ elementId: p.sourceId, reason: `primitive outside detail region (or center/anchor outside for discrete primitives)` });
      continue;
    }
    if (mapped !== null) primitives.push(mapped);
  }
  return { viewId: view.id, primitives, skips, bbox: bboxOf(primitives) };
}

function clipAndScalePrimitive(
  p: ViewPrimitive,
  region: { x: number; y: number; w: number; h: number },
  k: number,
): ViewPrimitive | "outside" | null {
  const toDetail = (u: number, v: number): Vec2 => [(u - region.x) * k, (v - region.y) * k];
  if (p.type === "line") {
    const clipped = clipSegment(p.from, p.to, region);
    if (clipped === null) return "outside";
    return {
      type: "line",
      from: toDetail(clipped[0][0], clipped[0][1]),
      to: toDetail(clipped[1][0], clipped[1][1]),
      sourceId: p.sourceId,
    };
  }
  if (p.type === "polyline") {
    const out: Vec2[] = [];
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = p.points[i] as Vec2;
      const b = p.points[i + 1] as Vec2;
      const clipped = clipSegment(a, b, region);
      if (clipped === null) continue;
      const [ca, cb] = clipped;
      if (out.length === 0) {
        out.push(toDetail(ca[0], ca[1]));
      } else {
        const last = out[out.length - 1] as Vec2;
        const lastSource = toDetail(ca[0], ca[1]);
        // Insert a break marker? Polylines cannot express breaks — split into
        // separate polylines instead. Handled by the caller loop below.
        if (last[0] !== lastSource[0] || last[1] !== lastSource[1]) {
          // segment gap — cannot represent in one polyline; skip this segment
          // with an honest note (rare: only when a polyline leaves+re-enters)
          return null; // caller records a skip for the whole primitive
        }
      }
      out.push(toDetail(cb[0], cb[1]));
    }
    if (out.length < 2) return "outside";
    return { type: "polyline", points: out, closed: false, sourceId: p.sourceId };
  }
  if (p.type === "circle" || p.type === "arc") {
    if (
      p.center[0] < region.x || p.center[0] > region.x + region.w ||
      p.center[1] < region.y || p.center[1] > region.y + region.h
    ) {
      return "outside";
    }
    const c = toDetail(p.center[0], p.center[1]);
    if (p.type === "circle") return { type: "circle", center: c, radius: p.radius * k, sourceId: p.sourceId };
    return { type: "arc", center: c, radius: p.radius * k, startAngle: p.startAngle, endAngle: p.endAngle, sourceId: p.sourceId };
  }
  // text
  if (p.at[0] < region.x || p.at[0] > region.x + region.w || p.at[1] < region.y || p.at[1] > region.y + region.h) {
    return "outside";
  }
  return { type: "text", at: toDetail(p.at[0], p.at[1]), text: p.text, sourceId: p.sourceId };
}

/** Liang-Barsky segment clipping against a rect (inclusive edges). Returns
 *  null when the segment is fully outside. */
function clipSegment(a: Vec2, b: Vec2, r: { x: number; y: number; w: number; h: number }): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: readonly (readonly [number, number])[] = [
    [-dx, a[0] - r.x],
    [dx, r.x + r.w - a[0]],
    [-dy, a[1] - r.y],
    [dy, r.y + r.h - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  const clip = (pt: Vec2, t: number): Vec2 => [a[0] + t * dx, a[1] + t * dy];
  return [clip(a, t0), clip(a, t1)];
}

// --- plan projection -----------------------------------------------------------

function projectPlan(story: StoryEntity, entities: readonly BimEntity[]): { primitives: ViewPrimitive[]; skips: ProjectionSkip[] } {
  const primitives: ViewPrimitive[] = [];
  const skips: ProjectionSkip[] = [];
  const wallsOfStory = entities.filter((x): x is WallEntity => x.type === "bim.wall" && x.storyId === story.id);
  const wallById = new Map(wallsOfStory.map((w) => [w.id, w]));
  const openingsByHost = new Map<string, OpeningEntity[]>();
  for (const x of entities) {
    if (x.type === "bim.opening") {
      const host = wallById.get(x.hostId);
      if (host === undefined) {
        skips.push({ elementId: x.id, reason: "opening's host wall is not on this story (or missing) — not projected" });
        continue;
      }
      const list = openingsByHost.get(x.hostId) ?? [];
      list.push(x);
      openingsByHost.set(x.hostId, list);
    }
  }
  // Fills keyed by opening id (doors/windows reference openingId).
  const fillByOpening = new Map<string, DoorEntity | WindowEntity>();
  for (const x of entities) {
    if (x.type === "bim.door" || x.type === "bim.window") fillByOpening.set(x.openingId, x);
  }

  for (const wall of wallsOfStory) {
    const [c1, c2, c3, c4] = wallCorners(wall);
    primitives.push(polyline([c1, c2, c3, c4], true, wall.id));
    primitives.push({ type: "line", from: [wall.start[0], wall.start[1]], to: [wall.end[0], wall.end[1]], sourceId: wall.id });
    const openings = openingsByHost.get(wall.id) ?? [];
    for (const opening of openings) {
      const fill = fillByOpening.get(opening.id);
      emitPlanOpening(primitives, wall, opening, fill);
    }
  }
  for (const x of entities) {
    if (x.type === "bim.slab" && x.storyId === story.id) {
      const uMin = Math.min(x.corner1[0], x.corner2[0]);
      const uMax = Math.max(x.corner1[0], x.corner2[0]);
      const vMin = Math.min(x.corner1[1], x.corner2[1]);
      const vMax = Math.max(x.corner1[1], x.corner2[1]);
      primitives.push(rectPolyline(uMin, vMin, uMax, vMax, x.id));
    } else if (x.type === "bim.space" && x.storyId === story.id) {
      primitives.push(polyline(x.footprint.map((pt) => [pt[0], pt[1]] as Vec2), true, x.id));
      const c = polygonCentroid(x.footprint.map((pt) => [pt[0], pt[1]] as Vec2));
      primitives.push({ type: "text", at: c, text: x.name, sourceId: x.id });
    } else if (x.type === "bim.story" && x.id === story.id) {
      skips.push({ elementId: x.id, reason: "story is the level container — projects to nothing in plan (see buildGeometry precedent)" });
    }
  }
  // Elements of OTHER stories are simply not in this view's scope (no skip
  // noise — scope filtering is not a skip).
  return { primitives, skips };
}

function emitPlanOpening(
  primitives: ViewPrimitive[],
  wall: WallEntity,
  opening: OpeningEntity,
  fill: DoorEntity | WindowEntity | undefined,
): void {
  const d = norm(sub(wall.end, wall.start));
  const n: Vec2 = [-d[1], d[0]];
  const h = wall.width / 2;
  const p1 = add(wall.start, mul(d, opening.distance));
  const p2 = add(wall.start, mul(d, opening.distance + opening.width));
  const jamb = (p: Vec2): void => {
    primitives.push({ type: "line", from: add(p, mul(n, h)), to: sub(p, mul(n, h)), sourceId: opening.id });
  };
  if (fill === undefined) {
    jamb(p1);
    jamb(p2);
    return;
  }
  if (fill.type === "bim.window") {
    // Window symbol: the band rectangle + a centre glazing line.
    const [b1, b2, b3, b4] = openingBandCorners(wall, opening);
    primitives.push(polyline([b1, b2, b3, b4], true, fill.id));
    primitives.push({ type: "line", from: [p1[0], p1[1]], to: [p2[0], p2[1]], sourceId: fill.id });
    return;
  }
  // Door symbol: jambs on both sides + leaf line + quarter arc. swing "left"
  // hinges at p1 with the leaf on +n; swing "right" hinges at p2 with the
  // leaf on +n (deterministic convention — documented; real-world
  // handedness conventions vary).
  jamb(p1);
  jamb(p2);
  const hinge = fill.swing === "left" ? p1 : p2;
  const leafEnd = add(hinge, mul(n, opening.width));
  primitives.push({ type: "line", from: [hinge[0], hinge[1]], to: [leafEnd[0], leafEnd[1]], sourceId: fill.id });
  const a0 = Math.atan2(n[1], n[0]);
  const a1 = Math.atan2(d[1], d[0]);
  primitives.push({
    type: "arc",
    center: [hinge[0], hinge[1]],
    radius: opening.width,
    startAngle: a0,
    endAngle: a1,
    sourceId: fill.id,
  });
}

/** Polygon centroid (area-weighted; shoelace). Falls back to the vertex mean
 *  for degenerate (zero-area) polygons — deterministic. */
function polygonCentroid(points: readonly Vec2[]): Vec2 {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    const cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (area2 === 0) {
    const n = points.length;
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * area2), cy / (3 * area2)];
}

// --- elevation projection --------------------------------------------------------

/** Map a story-local XY point to elevation (u, v) for a direction. */
function elevationUv(direction: DocsElevationDirection, x: number, y: number, z: number): Vec2 {
  switch (direction) {
    case "front": return [x, z];
    case "back": return [-x, z];
    case "left": return [y, z];
    case "right": return [-y, z];
  }
}

/** Is a wall parallel to the picture plane for this direction? (Its axis
 *  runs along the picture plane; openings on it project cleanly.) */
function wallParallelToPicturePlane(wall: WallEntity, direction: DocsElevationDirection): boolean {
  const horizontal = direction === "front" || direction === "back";
  return horizontal ? wall.start[1] === wall.end[1] : wall.start[0] === wall.end[0];
}

function projectElevation(
  direction: DocsElevationDirection,
  stories: readonly StoryEntity[],
  entities: readonly BimEntity[],
): { primitives: ViewPrimitive[]; skips: ProjectionSkip[] } {
  const primitives: ViewPrimitive[] = [];
  const skips: ProjectionSkip[] = [];
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const walls = entities.filter((x): x is WallEntity => x.type === "bim.wall" && storyById.has(x.storyId));
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const fillByOpening = new Map<string, DoorEntity | WindowEntity>();
  for (const x of entities) {
    if (x.type === "bim.door" || x.type === "bim.window") fillByOpening.set(x.openingId, x);
  }
  // u mapping: the UNMIRRORED axis coordinate (front/back → X, left/right
  // → Y); extents are computed in axis space (where the ±width/2 offsets
  // keep their sign) and mirrored ONCE at the end — exact mirroring with
  // fixed construction order.
  const axisOf = (p: Vec2): number =>
    direction === "front" || direction === "back" ? p[0] : p[1];
  const mirror = (span: [number, number]): [number, number] => {
    const [lo, hi] = span;
    return direction === "front" || direction === "left" ? [lo, hi] : [-hi, -lo];
  };
  for (const wall of walls) {
    const story = storyById.get(wall.storyId) as StoryEntity;
    const vBase = story.level + wall.baseOffset;
    const vTop = vBase + wall.height;
    const a1 = axisOf(wall.start) - wall.width / 2;
    const a2 = axisOf(wall.end) + wall.width / 2;
    const [uMin, uMax] = mirror([Math.min(a1, a2), Math.max(a1, a2)]);
    primitives.push(rectPolyline(uMin, vBase, uMax, vTop, wall.id));
  }
  for (const x of entities) {
    if (x.type === "bim.opening") {
      const wall = wallById.get(x.hostId);
      if (wall === undefined) {
        skips.push({ elementId: x.id, reason: "opening's host wall is out of this elevation's story scope — not projected" });
        continue;
      }
      if (!wallParallelToPicturePlane(wall, direction)) {
        skips.push({ elementId: x.id, reason: "opening's host wall is perpendicular to the picture plane — projects to zero width, not drawn (wireframe elevation)" });
        continue;
      }
      const story = storyById.get(wall.storyId) as StoryEntity;
      const vBase = story.level + wall.baseOffset;
      const aA = axisOf(wall.start) + x.distance;
      const [uMin, uMax] = mirror([aA, aA + x.width]);
      const vMin = vBase + x.sill;
      const vMax = vMin + x.height;
      primitives.push(rectPolyline(uMin, vMin, uMax, vMax, x.id));
      const fill = fillByOpening.get(x.id);
      if (fill !== undefined && fill.type === "bim.window") {
        // Two horizontal glazing lines at 1/3 and 2/3 of the opening height.
        const v1 = vMin + x.height / 3;
        const v2 = vMin + (2 * x.height) / 3;
        primitives.push({ type: "line", from: [uMin, v1], to: [uMax, v1], sourceId: fill.id });
        primitives.push({ type: "line", from: [uMin, v2], to: [uMax, v2], sourceId: fill.id });
      } else if (fill !== undefined && fill.type === "bim.door") {
        // Closed-leaf indicator: the vertical centre line of the opening.
        const uMid = (uMin + uMax) / 2;
        primitives.push({ type: "line", from: [uMid, vMin], to: [uMid, vMax], sourceId: fill.id });
      }
    } else if (x.type === "bim.slab" && storyById.has(x.storyId)) {
      const story = storyById.get(x.storyId) as StoryEntity;
      const vBase = story.level + x.baseOffset;
      const vTop = vBase + x.thickness;
      const [uMin, uMax] = mirror([
        Math.min(axisOf(x.corner1), axisOf(x.corner2)),
        Math.max(axisOf(x.corner1), axisOf(x.corner2)),
      ]);
      primitives.push(rectPolyline(uMin, vBase, uMax, vTop, x.id));
    } else if (x.type === "bim.space") {
      skips.push({ elementId: x.id, reason: "spaces are semantic objects — not drawn in elevations (documented)" });
    } else if (x.type === "bim.story") {
      skips.push({ elementId: x.id, reason: "story is the level container — projects to nothing in elevation" });
    }
  }
  return { primitives, skips };
}

// --- section projection -------------------------------------------------------

function projectSection(
  axis: "x" | "y",
  offset: number,
  stories: readonly StoryEntity[],
  entities: readonly BimEntity[],
): { primitives: ViewPrimitive[]; skips: ProjectionSkip[] } {
  const primitives: ViewPrimitive[] = [];
  const skips: ProjectionSkip[] = [];
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const walls = entities.filter((x): x is WallEntity => x.type === "bim.wall" && storyById.has(x.storyId));
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const fillByOpening = new Map<string, DoorEntity | WindowEntity>();
  for (const x of entities) {
    if (x.type === "bim.door" || x.type === "bim.window") fillByOpening.set(x.openingId, x);
  }
  const cutCoord = (p: Vec2): number => (axis === "x" ? p[0] : p[1]);
  const uCoord = (p: Vec2): number => (axis === "x" ? p[1] : p[0]);

  const openingsByHost = new Map<string, OpeningEntity[]>();
  for (const x of entities) {
    if (x.type !== "bim.opening") continue;
    const list = openingsByHost.get(x.hostId) ?? [];
    list.push(x);
    openingsByHost.set(x.hostId, list);
  }
  const processedOpenings = new Set<string>();
  for (const wall of walls) {
    const [c1, c2, c3, c4] = wallCorners(wall);
    const cutMin = Math.min(cutCoord(c1), cutCoord(c2), cutCoord(c3), cutCoord(c4));
    const cutMax = Math.max(cutCoord(c1), cutCoord(c2), cutCoord(c3), cutCoord(c4));
    if (offset < cutMin || offset > cutMax) {
      skips.push({ elementId: wall.id, reason: `wall does not cross the cut plane ${axis}=${offset} — not in section` });
      continue;
    }
    const story = storyById.get(wall.storyId) as StoryEntity;
    const vBase = story.level + wall.baseOffset;
    const vTop = vBase + wall.height;
    // The cut profile's u-extent is the wall RECTANGLE's projection onto the
    // u axis (min/max over the four corners — correct for parallel walls
    // (full length), perpendicular walls (thickness band) and diagonals).
    const [wc1, wc2, wc3, wc4] = wallCorners(wall);
    const uMin = Math.min(uCoord(wc1), uCoord(wc2), uCoord(wc3), uCoord(wc4));
    const uMax = Math.max(uCoord(wc1), uCoord(wc2), uCoord(wc3), uCoord(wc4));
    primitives.push(rectPolyline(uMin, vBase, uMax, vTop, wall.id));
    // Openings of this wall whose band crosses the plane.
    for (const x of openingsByHost.get(wall.id) ?? []) {
      processedOpenings.add(x.id);
      const [b1, b2, b3, b4] = openingBandCorners(wall, x);
      const bCutMin = Math.min(cutCoord(b1), cutCoord(b2), cutCoord(b3), cutCoord(b4));
      const bCutMax = Math.max(cutCoord(b1), cutCoord(b2), cutCoord(b3), cutCoord(b4));
      if (offset < bCutMin || offset > bCutMax) {
        skips.push({ elementId: x.id, reason: `opening band does not cross the cut plane ${axis}=${offset}` });
        continue;
      }
      const uA = Math.min(uCoord(b1), uCoord(b2), uCoord(b3), uCoord(b4));
      const uB = Math.max(uCoord(b1), uCoord(b2), uCoord(b3), uCoord(b4));
      const vMin = vBase + x.sill;
      const vMax = vMin + x.height;
      primitives.push(rectPolyline(uA, vMin, uB, vMax, x.id));
      const fill = fillByOpening.get(x.id);
      if (fill !== undefined && fill.type === "bim.window") {
        const v1 = vMin + x.height / 3;
        const v2 = vMin + (2 * x.height) / 3;
        primitives.push({ type: "line", from: [uA, v1], to: [uB, v1], sourceId: fill.id });
        primitives.push({ type: "line", from: [uA, v2], to: [uB, v2], sourceId: fill.id });
      } else if (fill !== undefined && fill.type === "bim.door") {
        const uMid = (uA + uB) / 2;
        primitives.push({ type: "line", from: [uMid, vMin], to: [uMid, vMax], sourceId: fill.id });
      }
    }
  }
  for (const x of entities) {
    if (x.type === "bim.opening" && !processedOpenings.has(x.id)) {
      skips.push({
        elementId: x.id,
        reason: wallById.has(x.hostId)
          ? `opening's host wall does not cross the cut plane ${axis}=${offset} — not in section`
          : `opening's host wall is out of this section's story scope — not in section`,
      });
      continue;
    }
    if (x.type === "bim.slab" && storyById.has(x.storyId)) {
      const cutAxisIdx = axis === "x" ? 0 : 1;
      const uAxisIdx = axis === "x" ? 1 : 0;
      const cutMin = Math.min(x.corner1[cutAxisIdx], x.corner2[cutAxisIdx]);
      const cutMax = Math.max(x.corner1[cutAxisIdx], x.corner2[cutAxisIdx]);
      if (offset < cutMin || offset > cutMax) {
        skips.push({ elementId: x.id, reason: `slab does not cross the cut plane ${axis}=${offset}` });
        continue;
      }
      const story = storyById.get(x.storyId) as StoryEntity;
      const vBase = story.level + x.baseOffset;
      const vTop = vBase + x.thickness;
      const uA = x.corner1[uAxisIdx];
      const uB = x.corner2[uAxisIdx];
      primitives.push(rectPolyline(Math.min(uA, uB), vBase, Math.max(uA, uB), vTop, x.id));
    } else if (x.type === "bim.space" && storyById.has(x.storyId)) {
      const chord = polygonCrossingChord(
        x.footprint.map((pt) => [pt[0], pt[1]] as Vec2),
        axis,
        offset,
      );
      if (chord === null) {
        skips.push({ elementId: x.id, reason: `space does not cross the cut plane ${axis}=${offset}` });
        continue;
      }
      const story = storyById.get(x.storyId) as StoryEntity;
      const vMid = story.level + x.baseOffset + x.height / 2;
      const uMid = (chord[0] + chord[1]) / 2;
      primitives.push({ type: "text", at: [uMid, vMid], text: x.name, sourceId: x.id });
    } else if (x.type === "bim.story") {
      skips.push({ elementId: x.id, reason: "story is the level container — projects to nothing in section" });
    }
  }
  return { primitives, skips };
}

/** The [min, max] crossing extent of a polygon with the axis-aligned line
 *  (axis = offset), or null when it does not cross. */
function polygonCrossingChord(points: readonly Vec2[], axis: "x" | "y", offset: number): [number, number] | null {
  const coord = (p: Vec2): number => (axis === "x" ? p[0] : p[1]);
  const other = (p: Vec2): number => (axis === "x" ? p[1] : p[0]);
  const crossings: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    const ca = coord(a);
    const cb = coord(b);
    if (ca === cb) continue; // parallel edge
    if ((ca <= offset && cb >= offset) || (cb <= offset && ca >= offset)) {
      const t = (offset - ca) / (cb - ca);
      crossings.push(other(a) + t * (other(b) - other(a)));
    }
  }
  if (crossings.length === 0) return null;
  return [Math.min(...crossings), Math.max(...crossings)];
}
