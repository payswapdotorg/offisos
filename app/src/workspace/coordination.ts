/**
 * Coordination core (CAD-PARITY-012, Issue #102) — grids, clash detection
 * and revision markup: the shared coordination semantics over the real
 * offisos architecture.
 *
 * - GRIDS: bim.grid entities (story-scoped, u/v strictly-ascending line
 *   sets). Labels are DERIVED at read time (Excel-style A, B, C… for the u
 *   axis, 1, 2, 3… for the v axis — minted from the sorted line order) and
 *   are NEVER stored; the display geometry (full-span segments over the
 *   document content bounds) is derived the same way so the same snapshot
 *   yields the same grid rendering on every host.
 * - CLASH: pairwise interference detection over the concrete 2D view
 *   (block instances EXPANDED through the ONE shared block expansion; a hit
 *   maps back to the INSTANCE element id). BBox prefilter + the exact
 *   intersectGeoms kernel. Deterministic ordering: pairs sorted by
 *   (a.id, b.id), points within a pair sorted by the kernel (x, then y).
 * - REVISION CLOUD: a closed, scalloped boundary polyline persisted with the
 *   bounded `marker: "revcloud"` drafting marker — deterministic sampling
 *   (8 points per scallop, 4..24 scallops per edge by edge length),
 *   renderable as plain geometry on every host and excluded from clash.
 *
 * Typed limitations (honest surface, LOCK-007):
 * - Splines have no exact intersections in this build → they never report
 *   clashes (documented kernel limitation, CAD-PARITY-003).
 * - Clash is CROSSING-based: two closed areas that only touch/contain
 *   without boundary crossing report no clash unless their boundaries
 *   actually intersect.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../contracts/caddocument.js";
import type { GridEntity } from "../bim/components.js";
import { bbox, type BBox } from "./geometry/entities.js";
import { intersectGeoms } from "./geometry/intersect.js";
import type { Geom } from "./geometry/types.js";
import { geomFromProps } from "./geometry/bridge.js";
import type { Pt } from "./geometry/math2d.js";
import type { BlockTable } from "./blocks/expand.js";
import { expandBlockInstance } from "./blocks/expand.js";
import { blockRefFromElement, isBlockRefElement } from "./blocks/types.js";
import { isRevcloudElement, REVCLOUD_MARKER } from "./materials.js";

export { isRevcloudElement, REVCLOUD_MARKER };

// --- Grids: derived labels + display geometry --------------------------------

/** Excel-style column label for a 1-based index (A..Z, AA.. — the u-axis
 *  label grammar; port of the reference minting helper). */
export function excelLabel(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** DERIVED u-axis labels of a grid (A, B, C… from the sorted line order —
 *  never stored). */
export function gridULabels(grid: Pick<GridEntity, "uLines">): string[] {
  return grid.uLines.map((_, i) => excelLabel(i + 1));
}

/** DERIVED v-axis labels of a grid (1, 2, 3… from the sorted line order —
 *  never stored). */
export function gridVLabels(grid: Pick<GridEntity, "vLines">): string[] {
  return grid.vLines.map((_, i) => String(i + 1));
}

/** One derived grid display segment. */
export interface GridLineView {
  /** "u" = a vertical line (world x = offset); "v" = horizontal (y = offset). */
  readonly axis: "u" | "v";
  /** 0-based index within the axis (label = minted from the sorted order). */
  readonly index: number;
  /** The story-local offset the line sits at (mm). */
  readonly offset: number;
  /** The DERIVED label (A…/1… — never stored). */
  readonly label: string;
  readonly p1: Pt;
  readonly p2: Pt;
}

/** Default grid span when a document carries no measurable content (the
 *  deterministic fallback bounds around the origin). */
const DEFAULT_GRID_BOUNDS = { min: { x: -1000, y: -1000 }, max: { x: 1000, y: 1000 } };

/** Grid line geometry: the full segment spanning the document content
 *  bounds (port of the reference gridLine helper — axis "u" is a vertical
 *  line at x = offset, "v" a horizontal line at y = offset). Deterministic
 *  from the snapshot. */
export function gridLine(
  grid: Pick<GridEntity, "uLines" | "vLines">,
  bounds: { min: Pt; max: Pt } | null,
  axis: "u" | "v",
  index: number,
): GridLineView {
  const b = bounds ?? DEFAULT_GRID_BOUNDS;
  if (axis === "u") {
    const offset = grid.uLines[index] as number;
    return {
      axis,
      index,
      offset,
      label: excelLabel(index + 1),
      p1: { x: offset, y: b.min.y },
      p2: { x: offset, y: b.max.y },
    };
  }
  const offset = grid.vLines[index] as number;
  return {
    axis,
    index,
    offset,
    label: String(index + 1),
    p1: { x: b.min.x, y: offset },
    p2: { x: b.max.x, y: offset },
  };
}

/** Every derived display segment of a grid (u then v, in stored order). */
export function gridLines(
  grid: Pick<GridEntity, "uLines" | "vLines">,
  bounds: { min: Pt; max: Pt } | null,
): readonly GridLineView[] {
  const out: GridLineView[] = [];
  for (let i = 0; i < grid.uLines.length; i++) out.push(gridLine(grid, bounds, "u", i));
  for (let i = 0; i < grid.vLines.length; i++) out.push(gridLine(grid, bounds, "v", i));
  return out;
}

// --- Document content bounds --------------------------------------------------

/** Content bounds of the document's concrete 2D geometry (block instances
 *  expanded through the ONE shared expansion), padded symmetrically; null
 *  when the document carries no measurable content. Deterministic. */
export function documentContentBounds(
  elements: readonly Element[],
  blockTable: BlockTable,
  pad = 500,
): { min: Pt; max: Pt } | null {
  const parts: BBox[] = [];
  const include = (g: Geom): void => {
    parts.push(bbox(g));
  };
  for (const el of elements) {
    if (isBlockRefElement(el)) {
      const ref = blockRefFromElement(el);
      if (ref === null) continue;
      for (const piece of expandBlockInstance(ref, blockTable)) {
        if (piece.kind !== "geometry") continue;
        const g = geomFromProps(piece.props);
        if (g !== null) include(g);
      }
      continue;
    }
    const g = geomFromProps(el.props as Record<string, unknown>);
    if (g !== null) include(g);
  }
  if (parts.length === 0) return null;
  const first = parts[0]!;
  let minX = first.minX;
  let minY = first.minY;
  let maxX = first.maxX;
  let maxY = first.maxY;
  for (const b of parts.slice(1)) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return {
    min: { x: minX - pad, y: minY - pad },
    max: { x: maxX + pad, y: maxY + pad },
  };
}

// --- Clash detection ----------------------------------------------------------

/** One clash pair (deterministic ordering: a.id < b.id; points sorted by the
 *  kernel — x, then y). */
export interface ClashPair {
  readonly a: string;
  readonly b: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Clash detection result. `checked` = participants in the concrete view
 *  (geometry elements + expanded block-instance pieces); `excluded` = the
 *  typed exclusions (ray/xline/point/spline geoms, revision-cloud elements,
 *  annotation elements). */
export interface ClashResult {
  readonly pairs: readonly ClashPair[];
  readonly checked: number;
  readonly excluded: number;
}

/** The concrete 2D view clash detection runs over. */
export interface ClashView {
  readonly elements: readonly Element[];
  readonly blockTable: BlockTable;
}

/** The geometry kinds never counted as clash participants (typed exclusions
 *  — construction geometry and points have no bounded body; splines have no
 *  exact intersections in this build). */
const EXCLUDED_GEOM_TYPES: readonly string[] = ["ray", "xline", "point", "spline"];

/** One concrete-view participant: an element id + decoded/expanded geometry.
 *  A block instance contributes one participant PER expanded geometry piece
 *  (all sharing the INSTANCE element id so a hit maps to the instance). */
interface Concrete {
  readonly id: string;
  readonly geom: Geom;
}

/** Pairwise clash detection over the concrete 2D view. Excluded (typed,
 *  counted): construction geometry (ray/xline), points, splines (no exact
 *  intersections in this build) and revision-cloud markup elements;
 *  annotation elements are excluded as non-geometry content. Two pieces of
 *  the SAME instance never clash with each other (one body). A pair reports
 *  only when the exact kernel yields intersection points. */
export function detectClashes(view: ClashView): ClashResult {
  const concrete: Concrete[] = [];
  let excluded = 0;
  const push = (id: string, geom: Geom): void => {
    if (EXCLUDED_GEOM_TYPES.includes(geom.type)) {
      excluded += 1;
      return;
    }
    concrete.push({ id, geom });
  };
  for (const el of view.elements) {
    const props = el.props as Record<string, unknown>;
    // Revision-cloud markup: excluded by the bounded marker.
    if (props.marker === REVCLOUD_MARKER) {
      excluded += 1;
      continue;
    }
    // Annotations: text/dimension content is not geometry — excluded.
    if (el.kind === "annotation" || props.annotation === true) {
      excluded += 1;
      continue;
    }
    // Block instances: EXPANDED pieces, participant id = the instance.
    if (isBlockRefElement(el)) {
      const ref = blockRefFromElement(el);
      if (ref === null) continue;
      for (const piece of expandBlockInstance(ref, view.blockTable)) {
        if (piece.kind !== "geometry") continue;
        const g = geomFromProps(piece.props);
        if (g === null) continue;
        push(el.id, g);
      }
      continue;
    }
    // BIM elements and non-decoding elements are not 2D view content —
    // skipped (not excluded, not checked).
    const g = geomFromProps(props);
    if (g === null) continue;
    push(el.id, g);
  }

  const pairs: ClashPair[] = [];
  const boxes = concrete.map((c) => bbox(c.geom));
  for (let i = 0; i < concrete.length; i++) {
    for (let j = i + 1; j < concrete.length; j++) {
      const a = concrete[i]!;
      const b = concrete[j]!;
      if (a.id === b.id) continue; // two pieces of the same instance
      const ba = boxes[i]!;
      const bb = boxes[j]!;
      if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) {
        continue; // BBox prefilter
      }
      const pts = intersectGeoms(a.geom, b.geom);
      if (pts.length === 0) continue;
      const [first, second] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      pairs.push({ a: first, b: second, points: pts.map((p) => ({ x: p.x, y: p.y })) });
    }
  }
  pairs.sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0));
  return { pairs, checked: concrete.length, excluded };
}

// --- Revision cloud -----------------------------------------------------------

/** Number of polyline samples per scallop arc (deterministic). */
export const REV_CLOUD_SAMPLES = 8;

/** Minimum scallop count per edge. */
const REV_CLOUD_MIN_SCALLOPS = 4;
/** Maximum scallop count per edge. */
const REV_CLOUD_MAX_SCALLOPS = 24;
/** Target scallop span (document units) driving the per-edge count. */
const REV_CLOUD_TARGET_SPAN = 60;

/** Revision-cloud geometry: a closed scalloped boundary around the rectangle
 *  (cornerA, cornerB). Exact port of the reference scallop algorithm: a
 *  closed CCW corner walk, scallops bulging OUTWARD along the right
 *  perpendicular of the walk direction, each scallop a quadratic Bézier
 *  through (base, apex, next-base) sampled at 8 points; the scallop count
 *  per edge scales with edge length (target span ~60 units, clamped to
 *  [4, 24]). Returns the polyline vertices. */
export function revisionCloudGeom(cornerA: Pt, cornerB: Pt): readonly Pt[] {
  const minX = Math.min(cornerA.x, cornerB.x);
  const minY = Math.min(cornerA.y, cornerB.y);
  const maxX = Math.max(cornerA.x, cornerB.x);
  const maxY = Math.max(cornerA.y, cornerB.y);
  const corners: readonly Pt[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  const vertices: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const from = corners[i]!;
    const to = corners[(i + 1) % 4]!;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const count = Math.max(
      REV_CLOUD_MIN_SCALLOPS,
      Math.min(REV_CLOUD_MAX_SCALLOPS, Math.round(len / REV_CLOUD_TARGET_SPAN)),
    );
    for (let s = 0; s < count; s++) {
      const t0 = s / count;
      const t1 = (s + 0.5) / count; // arc apex parameter
      const r = len / count / 2;
      // The corner walk is CCW, so OUTWARD is the right perpendicular
      // (dy, -dx) of the walk direction.
      const bulge = r * 0.85;
      const dx = (to.x - from.x) / len;
      const dy = (to.y - from.y) / len;
      // Base points along the edge.
      const bx = from.x + (to.x - from.x) * t0;
      const by = from.y + (to.y - from.y) * t0;
      // Apex point, offset outward.
      const ax = from.x + (to.x - from.x) * t1 + dy * bulge;
      const ay = from.y + (to.y - from.y) * t1 - dx * bulge;
      const nextX = from.x + (to.x - from.x) * ((s + 1) / count);
      const nextY = from.y + (to.y - from.y) * ((s + 1) / count);
      for (let k = 0; k < REV_CLOUD_SAMPLES; k++) {
        const t = k / REV_CLOUD_SAMPLES;
        // Quadratic Bézier through (b, apex, next-base).
        const u = 1 - t;
        vertices.push({
          x: u * u * bx + 2 * u * t * ax + t * t * nextX,
          y: u * u * by + 2 * u * t * ay + t * t * nextY,
        });
      }
    }
  }
  return vertices;
}

/** The bounded revision-cloud marker props (persisted on the closed polyline
 *  element — the drafting-marker convention). */
export function revcloudMarker(): Record<string, unknown> {
  return { marker: REVCLOUD_MARKER };
}

/** Is a rectangle degenerate for a revision cloud (zero width or height —
 *  no edge can carry a scallop)? */
export function isDegenerateRect(cornerA: Pt, cornerB: Pt): boolean {
  return cornerA.x === cornerB.x || cornerA.y === cornerB.y;
}
