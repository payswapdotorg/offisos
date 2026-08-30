/**
 * CAD-PARITY-010 (Issue #93): the EXACT adapter-backed section/slice core.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Upgrades the P009
 * bbox-plane PREVIEW foundation to the exact surface where the engine can
 * provide it deterministically:
 *
 *  - The adapter's SectionProvider computes plane ∩ solid through the real
 *    engine (OCCT BRepAlgoAPI_Section + deterministic polyline sampling) and
 *    returns the raw intersection curves in its canonical order.
 *  - THIS module owns the canonical identity: it validates the raw output
 *    structurally, chains the intersection curves into closed loops (and
 *    open chains where the engine produces them), canonicalizes every loop
 *    (rotation to the lexicographic start vertex + canonical orientation),
 *    orders loops/facets deterministically and produces the IR body the App
 *    API layer hashes.
 *  - The P009 extent-level preview (section.ts) REMAINS the explicitly
 *    labeled fallback — model3d.sectionPreview keeps its exact semantics and
 *    its `exact: true` decline unchanged; the exact surface is the NEW
 *    model3d.section query. No approximation is ever presented as an exact
 *    section (Issue #93 §3).
 *
 * This module stays crypto-free and serialization-free for the browser
 * bundle (the section.ts precedent): canonical hashing lives at the App API
 * layer.
 */

import type { SectionGeometry, SectionPlaneSpec, Vec3 } from "../../contracts/geometry.js";
import type { SectionPlaneRecord } from "../../contracts/caddocument.js";
import { v3Dot, v3Sub } from "./math3d.js";

/** The canonical exact-section IR format identity (the preview precedent). */
export const SECTION_EXACT_FORMAT = "offisos-section-exact-ir";
export const SECTION_EXACT_VERSION = "1";

/** Structural tolerances (documented, deterministic). */
export const SECTION_ON_PLANE_TOLERANCE = 1e-6;
export const SECTION_CHAIN_EPS = 1e-7;
/** The bound on accepted intersection points per element (typed decline
 *  beyond — a bounded slice, never unbounded engine output). */
export const SECTION_MAX_POINTS = 8_192;

/** One element's exact section facet: the closed intersection loops (the
 *  plane cuts a closed solid in closed curves) plus any open chains the
 *  engine reports (kept honestly in the contract; empty for closed solids). */
export interface SectionExactFacet {
  readonly elementId: string;
  readonly loops: readonly (readonly Vec3[])[];
  readonly chains: readonly (readonly Vec3[])[];
}

/** The derived exact-section IR BODY (never stored — recomputed on demand;
 *  the App API layer adds the canonical `hash` over this body). */
export interface SectionExactBody {
  readonly format: typeof SECTION_EXACT_FORMAT;
  readonly version: typeof SECTION_EXACT_VERSION;
  readonly sectionPlaneId: string;
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly facets: readonly SectionExactFacet[];
  /** Elements whose solid the plane misses entirely (legal exact result). */
  readonly missedElementIds: readonly string[];
  /** Engine provenance (which engine produced the exact geometry). */
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
}

/** The full derived exact-section IR (body + the App-API-computed hash). */
export type SectionExactIR = SectionExactBody & { readonly hash: string };

/** A structural-validation failure (the App API surfaces it as the typed
 *  engine_error decline — the adapter's output did not honor the contract). */
export class SectionGeometryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionGeometryValidationError";
  }
}

/** Fixed-precision coordinate encoding (the worker's canonical convention:
 *  9 decimals, negative zero normalized — shared by chaining, canonical loop
 *  start selection and lexicographic ordering). */
export function encodeSectionPoint(p: Vec3): string {
  const f = (n: number): string => {
    const r = Math.round(n * 1e9) / 1e9;
    return (r === 0 ? 0 : r).toFixed(9);
  };
  return `${f(p[0])},${f(p[1])},${f(p[2])}`;
}

/** An in-plane stable basis for a unit plane normal: u = the world axis most
 *  ⊥ to the normal (x preferred, then y, then z), v = normal × u (the
 *  section.ts preview convention — the SAME basis for preview and exact so
 *  the two surfaces remain comparable). */
export function sectionPlaneBasis(normal: Vec3): { readonly u: Vec3; readonly v: Vec3 } {
  for (const [ax, ay, az] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
    const cross = [normal[1]! * az - normal[2]! * ay, normal[2]! * ax - normal[0]! * az, normal[0]! * ay - normal[1]! * ax];
    const len = Math.sqrt(cross[0]! ** 2 + cross[1]! ** 2 + cross[2]! ** 2);
    if (len > 1e-9) {
      const u: Vec3 = [cross[0]! / len, cross[1]! / len, cross[2]! / len];
      const v: Vec3 = [
        normal[1] * u[2] - normal[2] * u[1],
        normal[2] * u[0] - normal[0] * u[2],
        normal[0] * u[1] - normal[1] * u[0],
      ];
      return { u, v };
    }
  }
  // unreachable for a unit normal (some world axis is always ⊥)
  return { u: [1, 0, 0], v: [0, 1, 0] };
}

/** Validate raw adapter section output: finite triples, ≥ 2 points per
 *  polyline, points ON the plane (tolerance), bounded total point count. */
export function validateSectionGeometry(
  plane: SectionPlaneSpec,
  raw: SectionGeometry,
): void {
  let total = 0;
  for (let i = 0; i < raw.polylines.length; i++) {
    const pts = raw.polylines[i]!.points;
    if (pts.length < 6 || pts.length % 3 !== 0) {
      throw new SectionGeometryValidationError(
        `section polyline ${i} must carry ≥ 2 points as flat x,y,z triples`,
      );
    }
    total += pts.length / 3;
    if (total > SECTION_MAX_POINTS) {
      throw new SectionGeometryValidationError(
        `section output exceeds the ${SECTION_MAX_POINTS}-point bound`,
      );
    }
    for (let k = 0; k < pts.length; k += 3) {
      const x = pts[k]!;
      const y = pts[k + 1]!;
      const z = pts[k + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new SectionGeometryValidationError(`section polyline ${i} point ${k / 3} is non-finite`);
      }
      const d =
        (x - plane.origin[0]) * plane.normal[0] +
        (y - plane.origin[1]) * plane.normal[1] +
        (z - plane.origin[2]) * plane.normal[2];
      if (Math.abs(d) > SECTION_ON_PLANE_TOLERANCE) {
        throw new SectionGeometryValidationError(
          `section polyline ${i} point ${k / 3} is off-plane by ${d} (tolerance ${SECTION_ON_PLANE_TOLERANCE})`,
        );
      }
    }
  }
}

function pointsEqual(a: Vec3, b: Vec3, eps: number): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

/** Canonicalize ONE closed loop: rotate to start at the lexicographically
 *  smallest encoded vertex and orient it so the signed area in the plane
 *  basis (u, v) is non-negative. Two engines producing the same loop with
 *  opposite curve directions canonicalize IDENTICALLY. */
export function canonicalizeLoop(loop: readonly Vec3[], u: Vec3, v: Vec3): readonly Vec3[] {
  if (loop.length < 3) return loop;
  // Drop a closing duplicate last vertex (engines may repeat the start).
  const pts = loop.length > 1 && pointsEqual(loop[0]!, loop[loop.length - 1]!, SECTION_CHAIN_EPS)
    ? loop.slice(0, -1)
    : loop;
  if (pts.length < 3) return pts;
  let start = 0;
  let startKey = encodeSectionPoint(pts[0]!);
  for (let i = 1; i < pts.length; i++) {
    const key = encodeSectionPoint(pts[i]!);
    if (key < startKey) {
      start = i;
      startKey = key;
    }
  }
  const rotated = [...pts.slice(start), ...pts.slice(0, start)];
  // Signed area in the plane basis.
  let area = 0;
  for (let i = 0; i < rotated.length; i++) {
    const a = rotated[i]!;
    const b = rotated[(i + 1) % rotated.length]!;
    const au = v3Dot(a, u);
    const av = v3Dot(a, v);
    const bu = v3Dot(b, u);
    const bv = v3Dot(b, v);
    area += au * bv - bu * av;
  }
  if (area < 0) {
    rotated.reverse();
    // Re-rotate to the lexicographic start after the flip.
    let s = 0;
    let k = encodeSectionPoint(rotated[0]!);
    for (let i = 1; i < rotated.length; i++) {
      const kk = encodeSectionPoint(rotated[i]!);
      if (kk < k) {
        s = i;
        k = kk;
      }
    }
    return [...rotated.slice(s), ...rotated.slice(0, s)];
  }
  return rotated;
}

/** Chain adapter polylines into closed loops and open chains: polylines are
 *  merged end-to-start when endpoints coincide within SECTION_CHAIN_EPS.
 *  Deterministic: the polylines are processed in their canonical
 *  (lexicographic) order; each merged chain extends greedily; the resulting
 *  loops/chains are canonically ordered at the end. */
export function chainSectionPolylines(
  polylines: readonly { readonly points: readonly number[] }[],
  normal: Vec3,
): { readonly loops: readonly (readonly Vec3[])[]; readonly chains: readonly (readonly Vec3[])[] } {
  const { u, v } = sectionPlaneBasis(normal);
  // Decode + canonical sort of the raw polylines (stable: encoding, then
  // original index for exact duplicates).
  const decoded = polylines.map((p) => {
    const pts: Vec3[] = [];
    for (let k = 0; k < p.points.length; k += 3) {
      pts.push([p.points[k]!, p.points[k + 1]!, p.points[k + 2]!]);
    }
    return pts;
  });
  const order = decoded
    .map((pts, index) => ({ pts, index, key: pts.map(encodeSectionPoint).join(";") }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1));
  // Deduplicate identical polylines (an engine may report a shared edge
  // twice; identical keys collapse to the first).
  const unique: Vec3[][] = [];
  let lastKey: string | null = null;
  for (const entry of order) {
    if (entry.key !== lastKey) {
      unique.push(entry.pts);
      lastKey = entry.key;
    }
  }
  // Greedy chaining in canonical order.
  const open: Vec3[][] = unique.map((p) => [...p]);
  const loops: (readonly Vec3[])[] = [];
  const chains: (readonly Vec3[])[] = [];
  while (open.length > 0) {
    const current = open.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < open.length; i++) {
        const candidate = open[i]!;
        const head = current[0]!;
        const tail = current[current.length - 1]!;
        const cHead = candidate[0]!;
        const cTail = candidate[candidate.length - 1]!;
        if (pointsEqual(tail, cHead, SECTION_CHAIN_EPS)) {
          current.push(...candidate.slice(1));
          open.splice(i, 1);
          extended = true;
          break;
        }
        if (pointsEqual(tail, cTail, SECTION_CHAIN_EPS)) {
          current.push(...[...candidate.slice(1)].reverse());
          open.splice(i, 1);
          extended = true;
          break;
        }
        if (pointsEqual(head, cTail, SECTION_CHAIN_EPS)) {
          current.unshift(...candidate.slice(0, -1));
          open.splice(i, 1);
          extended = true;
          break;
        }
        if (pointsEqual(head, cHead, SECTION_CHAIN_EPS)) {
          current.unshift(...[...candidate.slice(0, -1)].reverse());
          open.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    const head = current[0]!;
    const tail = current[current.length - 1]!;
    if (current.length >= 4 && pointsEqual(head, tail, SECTION_CHAIN_EPS)) {
      loops.push(canonicalizeLoop(current.slice(0, -1), u, v));
    } else {
      chains.push(current);
    }
  }
  const encodeLoop = (loop: readonly Vec3[]): string => loop.map(encodeSectionPoint).join(";");
  loops.sort((a, b) => (encodeLoop(a) < encodeLoop(b) ? -1 : encodeLoop(a) > encodeLoop(b) ? 1 : 0));
  chains.sort((a, b) => (encodeLoop(a) < encodeLoop(b) ? -1 : encodeLoop(a) > encodeLoop(b) ? 1 : 0));
  return { loops, chains };
}

/** One element's input for exact-section computation. */
export interface SectionExactElement {
  readonly id: string;
  /** The adapter's raw section output for this element's descriptor (already
   *  validated) — empty polylines when the plane misses the solid. */
  readonly raw: SectionGeometry;
}

/** Build the derived exact-section IR body for a plane against elements
 *  (the App API layer computes the canonical hash over this body). */
export function buildSectionExact(
  plane: SectionPlaneRecord,
  elements: readonly SectionExactElement[],
): SectionExactBody {
  const facets: SectionExactFacet[] = [];
  const missed: string[] = [];
  let engineId = "";
  let engineVersion = "";
  for (const el of elements) {
    engineId = el.raw.engine.engineId;
    engineVersion = el.raw.engine.engineVersion;
    if (el.raw.polylines.length === 0) {
      missed.push(el.id);
      continue;
    }
    const { loops, chains } = chainSectionPolylines(el.raw.polylines, plane.normal);
    facets.push({ elementId: el.id, loops, chains });
  }
  return {
    format: SECTION_EXACT_FORMAT,
    version: SECTION_EXACT_VERSION,
    sectionPlaneId: plane.id,
    origin: plane.origin,
    normal: plane.normal,
    facets,
    missedElementIds: missed,
    engine: { engineId, engineVersion },
  };
}

/** The typed decline surfaced when the active engine cannot compute the
 *  exact section for a geometry (the reference engine outside its box-cell
 *  exactness class; the dummy adapter). The labeled extent-level preview
 *  (model3d.sectionPreview) remains available — the P009 fallback, never
 *  presented as exact (Issue #93 §3). */
export const SECTION_EXACT_ENGINE_DECLINE_REASON =
  "the active geometry engine cannot compute the exact BRep section for this solid (outside its deterministic exactness class) — the labeled extent-level preview (model3d.sectionPreview) remains the bounded fallback";

/** Guard: is the plane spec a valid unit-normal finite plane (the App API
 *  validates the record before adapter calls; shared with the command
 *  layer). */
export function validateSectionPlaneSpec(plane: SectionPlaneSpec): string | null {
  if (plane.origin.length !== 3 || !plane.origin.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "section plane origin must be a finite 3-vector";
  }
  if (plane.normal.length !== 3 || !plane.normal.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "section plane normal must be a finite 3-vector";
  }
  const len = Math.sqrt(plane.normal[0] ** 2 + plane.normal[1] ** 2 + plane.normal[2] ** 2);
  if (!(len > 0)) return "section plane normal must be non-zero";
  if (Math.abs(len - 1) > 1e-9) return "section plane normal must be unit length";
  return null;
}

/** Project a world point onto the section plane basis (u, v) — the loop
 *  plotting helper the hosts use to draw exact sections (the preview's
 *  in-plane convention). */
export function sectionPlaneCoords(p: Vec3, origin: Vec3, normal: Vec3): readonly [number, number] {
  const { u, v } = sectionPlaneBasis(normal);
  const d = v3Sub(p, origin);
  return [v3Dot(d, u), v3Dot(d, v)];
}
