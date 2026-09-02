/**
 * CAD-PARITY-018 (Issue #118) — the MEP toolset semantics: the pure
 * route-validation derivation, the deterministic 2D clash/clearance
 * diagnostics against the canonical BIM wall/slab bodies, and the
 * domain-neutral in-record connection semantics. Engine-free
 * (LOCK-018): exact fixed-formula planar geometry, deterministic
 * ordering, typed declines — never a guess, never an engine call.
 */

import {
  TOOLSETS_MAX_CONNECTIONS_PER_RUN,
  type MechEquipmentData,
  type MepClashDiagnostic,
  type MepConnection,
  type MepConnectionEnd,
  type MepConnectionTarget,
  type MepDomain,
  type MepRunData,
  type MepRouteViolation,
} from "../contracts/toolsets.js";
import type { Element } from "../contracts/caddocument.js";
import { toolsetErr } from "./errors.js";

// ---------------------------------------------------------------------------
// Route validation (the pure derivation — the same grammar the record
// validator enforces at write time; the query re-derives it fresh).
// ---------------------------------------------------------------------------

/** The violation codes (deterministic, ordered by segment index). */
export const MEP_ROUTE_VIOLATION_CODES = [
  "segment_degenerate",
  "segment_discontinuous",
  "duct_non_orthogonal",
] as const;

/** Derive the route violations of one MEP run:
 *  - segment_degenerate: a zero-length segment;
 *  - segment_discontinuous: segment[i].end ≠ segment[i+1].start;
 *  - duct_non_orthogonal: a duct segment that is not axis-aligned (pipe
 *    and conduit allow arbitrary headings). */
export function validateRoute(run: MepRunData): MepRouteViolation[] {
  const violations: MepRouteViolation[] = [];
  for (let i = 0; i < run.segments.length; i++) {
    const seg = run.segments[i]!;
    const dx = seg.end.x - seg.start.x;
    const dy = seg.end.y - seg.start.y;
    const dz = seg.end.z - seg.start.z;
    if (dx === 0 && dy === 0 && dz === 0) {
      violations.push({
        code: "segment_degenerate",
        message: `segments[${i}] is degenerate (start equals end)`,
        segmentIndex: i,
      });
      continue;
    }
    if (run.domain === "duct") {
      const nonzero = [dx, dy, dz].filter((c) => c !== 0).length;
      if (nonzero !== 1) {
        violations.push({
          code: "duct_non_orthogonal",
          message: `segments[${i}] is not axis-aligned (duct runs require orthogonal routing)`,
          segmentIndex: i,
        });
      }
    }
    if (i + 1 < run.segments.length) {
      const next = run.segments[i + 1]!;
      if (next.start.x !== seg.end.x || next.start.y !== seg.end.y || next.start.z !== seg.end.z) {
        violations.push({
          code: "segment_discontinuous",
          message: `segments[${i + 1}].start does not equal segments[${i}].end (continuous route required)`,
          segmentIndex: i + 1,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Clash / clearance diagnostics (deterministic 2D planar geometry).
// ---------------------------------------------------------------------------

interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface Seg2 {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/** Squared distance from point p to segment ab (exact planar formula). */
function pointSegDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Whether segments ab and cd properly cross (including touching). */
function segmentsIntersect(a: Seg2, b: Seg2): boolean {
  const d1 = cross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d2 = cross(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const d3 = cross(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d4 = cross(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1)) return true;
  if (d2 === 0 && onSegment(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2)) return true;
  if (d3 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1)) return true;
  if (d4 === 0 && onSegment(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2)) return true;
  return false;
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    px >= Math.min(ax, bx) && px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) && py <= Math.max(ay, by)
  );
}

/** Segment-to-segment distance (0 when they intersect/touch). */
function segSegDistance(a: Seg2, b: Seg2): number {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointSegDistance(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2),
    pointSegDistance(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2),
    pointSegDistance(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2),
    pointSegDistance(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2),
  );
}

/** Distance from a segment to a filled axis-aligned rectangle (0 when the
 *  segment touches, crosses or lies inside the rectangle). */
function segRectDistance(s: Seg2, r: Rect): number {
  if (pointInRect(s.x1, s.y1, r) || pointInRect(s.x2, s.y2, r)) return 0;
  const edges: readonly Seg2[] = [
    { x1: r.minX, y1: r.minY, x2: r.maxX, y2: r.minY },
    { x1: r.maxX, y1: r.minY, x2: r.maxX, y2: r.maxY },
    { x1: r.maxX, y1: r.maxY, x2: r.minX, y2: r.maxY },
    { x1: r.minX, y1: r.maxY, x2: r.minX, y2: r.minY },
  ];
  let min = Infinity;
  for (const edge of edges) {
    const d = segSegDistance(s, edge);
    if (d < min) min = d;
    if (min === 0) return 0;
  }
  return min;
}

/** The clashing element bodies: walls (axis + width → the body rectangle)
 *  and slabs (the footprint rectangle) — the canonical BIM records. */
interface ClashElement {
  readonly id: string;
  readonly rect: Rect;
  readonly kind: string;
}

function clashElementsOf(elements: readonly Element[]): ClashElement[] {
  const out: ClashElement[] = [];
  for (const el of elements) {
    const p = el.props as Record<string, unknown>;
    if (p?.type === "bim.wall") {
      const start = p.start as [number, number] | undefined;
      const end = p.end as [number, number] | undefined;
      const width = p.width as number | undefined;
      if (start === undefined || end === undefined || typeof width !== "number") continue;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      // The wall body: the axis swept by ±width/2 along the normal.
      const nx = (-dy / len) * (width / 2);
      const ny = (dx / len) * (width / 2);
      out.push({
        id: el.id,
        kind: "bim.wall",
        rect: {
          minX: Math.min(start[0] + nx, start[0] - nx, end[0] + nx, end[0] - nx),
          minY: Math.min(start[1] + ny, start[1] - ny, end[1] + ny, end[1] - ny),
          maxX: Math.max(start[0] + nx, start[0] - nx, end[0] + nx, end[0] - nx),
          maxY: Math.max(start[1] + ny, start[1] - ny, end[1] + ny, end[1] - ny),
        },
      });
    } else if (p?.type === "bim.slab") {
      const c1 = p.corner1 as [number, number] | undefined;
      const c2 = p.corner2 as [number, number] | undefined;
      if (c1 === undefined || c2 === undefined) continue;
      out.push({
        id: el.id,
        kind: "bim.slab",
        rect: {
          minX: Math.min(c1[0], c2[0]),
          minY: Math.min(c1[1], c2[1]),
          maxX: Math.max(c1[0], c2[0]),
          maxY: Math.max(c1[1], c2[1]),
        },
      });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The clash/clearance report: every run SEGMENT (2D x/y projection of
 *  the center line) against every wall/slab BODY. An exact distance of 0
 *  is an intersection; a distance below the required clearance is a
 *  clearance violation. Diagnostics are ordered by runId → segmentIndex
 *  → elementId (deterministic). */
export function clashReport(
  runs: readonly { id: string; data: MepRunData }[],
  clearanceMm: number,
  elements: readonly Element[],
): MepClashDiagnostic[] {
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) {
    throw toolsetErr("toolset_bad_payload", `clash clearance must be a finite number ≥ 0 (got ${clearanceMm})`);
  }
  const bodies = clashElementsOf(elements);
  const sortedRuns = [...runs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const diagnostics: MepClashDiagnostic[] = [];
  for (const run of sortedRuns) {
    for (const [segmentIndex, seg] of run.data.segments.entries()) {
      const s: Seg2 = { x1: seg.start.x, y1: seg.start.y, x2: seg.end.x, y2: seg.end.y };
      for (const body of bodies) {
        const distance = segRectDistance(s, body.rect);
        if (distance > clearanceMm) continue;
        const kindOfClash: "clearance" | "intersection" = distance === 0 ? "intersection" : "clearance";
        diagnostics.push({
          runId: run.id,
          segmentIndex,
          elementId: body.id,
          kindOfClash,
          distanceMm: distance,
          clearanceMm,
          message:
            kindOfClash === "intersection"
              ? `run '${run.id}' segment ${segmentIndex} intersects ${body.kind} '${body.id}' (distance 0 mm, required clearance ${clearanceMm} mm)`
              : `run '${run.id}' segment ${segmentIndex} is ${distance} mm from ${body.kind} '${body.id}' (below the required clearance ${clearanceMm} mm)`,
        });
      }
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// In-record connections (domain-neutral semantics, typed mismatches).
// ---------------------------------------------------------------------------

/** The connection lookup context (the canonical records the App API
 *  handler passes in — the pure function has no table access). */
export interface MepConnectContext {
  /** Look up one equipment record's data by canonical id. */
  readonly equipment: (id: string) => MechEquipmentData | undefined;
  /** Look up one run record's data by canonical id. */
  readonly run: (id: string) => MepRunData | undefined;
}

/** The port kinds that cannot carry MEP (fluid) runs at all. */
const NON_FLUID_PORT_KINDS: readonly string[] = ["power", "signal"];

/** Record one connection on a run (the ordinal id `c<next>`), with the
 *  typed domain/kind mismatch declines:
 *  - toolset_not_found: the target equipment/port/run does not exist;
 *  - toolset_unsupported: a domain/kind mismatch (a duct run to a
 *    power/signal port; a run-to-run connection across domains; a
 *    self-connection);
 *  - toolset_out_of_bounds: the per-run connection bound. */
export function connectRun(
  runId: string,
  run: MepRunData,
  at: MepConnectionEnd,
  target: MepConnectionTarget,
  context: MepConnectContext,
): MepRunData {
  if (at !== "start" && at !== "end") {
    throw toolsetErr("toolset_bad_payload", "connect.at must be 'start' | 'end'");
  }
  const existing = run.connections ?? [];
  if (existing.length + 1 > TOOLSETS_MAX_CONNECTIONS_PER_RUN) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `the run already carries the maximum of ${TOOLSETS_MAX_CONNECTIONS_PER_RUN} connections`,
    );
  }
  if (target.kind === "equipment") {
    const equipment = context.equipment(target.equipmentId);
    if (equipment === undefined) {
      throw toolsetErr("toolset_not_found", `no mechanical equipment '${target.equipmentId}'`);
    }
    const port = equipment.ports.find((p) => p.id === target.portId);
    if (port === undefined) {
      throw toolsetErr(
        "toolset_not_found",
        `equipment '${target.equipmentId}' has no port '${target.portId}' (declared ports: ${equipment.ports.map((p) => p.id).join(", ") || "none"})`,
      );
    }
    if (NON_FLUID_PORT_KINDS.includes(port.kind)) {
      throw toolsetErr(
        "toolset_unsupported",
        `port '${target.portId}' of equipment '${target.equipmentId}' is a '${port.kind}' connector — it cannot carry a ${run.domain} run (domain/kind mismatch)`,
      );
    }
    if (port.domain !== undefined && port.domain !== run.domain) {
      throw toolsetErr(
        "toolset_unsupported",
        `port '${target.portId}' of equipment '${target.equipmentId}' serves domain '${port.domain}' — it cannot carry a '${run.domain}' run (domain mismatch)`,
      );
    }
  } else if (target.kind === "run") {
    const other = context.run(target.runId);
    if (other === undefined) {
      throw toolsetErr("toolset_not_found", `no MEP run '${target.runId}'`);
    }
    if (target.runId === runId) {
      throw toolsetErr("toolset_unsupported", "a run cannot connect to itself");
    }
    if (other.domain !== run.domain) {
      throw toolsetErr(
        "toolset_unsupported",
        `run '${target.runId}' is a '${other.domain}' run — it cannot be connected to a '${run.domain}' run (domain mismatch)`,
      );
    }
  }
  const connection: MepConnection = {
    id: `c${existing.length + 1}`,
    at,
    target,
    domain: run.domain as MepDomain,
  };
  return { ...run, connections: [...existing, connection] };
}
