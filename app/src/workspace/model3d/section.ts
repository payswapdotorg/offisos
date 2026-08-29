/**
 * CAD-PARITY-009 (Issue #90): the bounded section/slice PREVIEW foundation.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). A section plane is a
 * versioned document record (origin + unit normal); the PREVIEW is derived
 * state recomputed on demand and never stored (the Plot IR precedent):
 *
 *  - For each element with persisted geometry extent (the engine-produced
 *    bbox in element props), compute the plane ∩ box intersection polygon —
 *    a convex polygon with up to 6 vertices, enumerated in a FIXED canonical
 *    order (the 12 box edges in boxEdges order; crossing points collected
 *    deterministically, then ordered around the polygon centroid by angle —
 *    exact deterministic output for the canonical hash).
 *  - The preview is EXPLICITLY labeled extent-level ("bbox"): it shows where
 *    the plane cuts each element's EXTENT, not its exact BRep cross-section.
 *    Exact cross-sections are a typed decline at the adapter boundary in
 *    this slice (section_exact_unsupported) — never a silent approximation.
 *  - This module stays crypto-free AND serialization-free for the browser
 *    bundle (the layouts/ir.ts precedent): canonical serialization + hashing
 *    live at the App API layer.
 */

import type { SectionPlaneRecord } from "../../contracts/caddocument.js";
import type { Vec3 } from "../../contracts/geometry.js";
import { v3Dot, v3Sub } from "./math3d.js";
import { type BBox3D, bbox3DIsEmpty } from "./camera.js";
import { boxEdges } from "./projection.js";

/** The canonical section-preview IR format identity (the Plot IR precedent). */
export const SECTION_PREVIEW_FORMAT = "offisos-section-preview-ir";
export const SECTION_PREVIEW_VERSION = "1";

/** One element's bounded section preview facet. */
export interface SectionPreviewFacet {
  readonly elementId: string;
  /** The extent-level intersection polygon (convex, canonical order;
   *  3..6 vertices; world coordinates). Empty when the plane misses the
   *  extent. */
  readonly polygon: readonly Vec3[];
}

/** The derived section preview IR BODY (never stored — recomputed on demand;
 *  the App API layer adds the canonical `hash` over this body). */
export interface SectionPreviewBody {
  readonly format: typeof SECTION_PREVIEW_FORMAT;
  readonly version: typeof SECTION_PREVIEW_VERSION;
  readonly sectionPlaneId: string;
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly facets: readonly SectionPreviewFacet[];
  /** Elements whose extent the plane misses (explicit, deterministic). */
  readonly missedElementIds: readonly string[];
  /** Elements without realized geometry (no bbox — nothing to intersect). */
  readonly noExtentElementIds: readonly string[];
}

/** The full derived section preview IR (body + the App-API-computed hash). */
export type SectionPreviewIR = SectionPreviewBody & { readonly hash: string };

/** Validate a section plane record (id/name shape, finite origin, unit
 *  normal — the zero vector is the typed degenerate decline). */
export function validateSectionPlaneRecord(plane: SectionPlaneRecord): string | null {
  if (typeof plane.id !== "string" || plane.id.length === 0) return "section plane id must be a non-empty string";
  if (typeof plane.name !== "string" || plane.name.trim().length === 0) return "section plane name must be a non-empty string";
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

/** Normalize a normal candidate to unit length (or null when degenerate) —
 *  the command layer uses this to accept un-normalized input EXPLICITLY
 *  (the payload declares the intent), never silently at the document layer. */
export function normalizeSectionNormal(n: Vec3): Vec3 | null {
  const len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Compute the plane ∩ axis-aligned-box intersection polygon: clip the 12
 *  box edges against the plane (signed-distance sign change), collect the
 *  crossing points, drop duplicates within 1e-9, order them around the
 *  centroid by angle in the plane's basis (atan2; ties in fixed vertex
 *  order). Deterministic output for the canonical hash. */
export function intersectPlaneBox(origin: Vec3, normal: Vec3, box: BBox3D): readonly Vec3[] {
  if (bbox3DIsEmpty(box)) return [];
  const crossings: Vec3[] = [];
  for (const [a, b] of boxEdges(box)) {
    const da = v3Dot(v3Sub(a, origin), normal);
    const db = v3Dot(v3Sub(b, origin), normal);
    if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
    if (da === 0 && db === 0) continue; // coplanar edge — degenerate, skipped
    const denom = da - db;
    if (denom === 0) continue;
    const t = da / denom;
    if (t < 0 || t > 1) continue;
    crossings.push([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  // Deduplicate (1e-9, deterministic pairwise in arrival order).
  const unique: Vec3[] = [];
  for (const p of crossings) {
    let dup = false;
    for (const q of unique) {
      if (
        Math.abs(p[0] - q[0]) < 1e-9 &&
        Math.abs(p[1] - q[1]) < 1e-9 &&
        Math.abs(p[2] - q[2]) < 1e-9
      ) {
        dup = true;
        break;
      }
    }
    if (!dup) unique.push(p);
  }
  if (unique.length < 3) return [];
  // Order around the centroid by angle in a fixed plane basis.
  const centroid: Vec3 = [
    unique.reduce((s: number, p: Vec3) => s + p[0], 0) / unique.length,
    unique.reduce((s: number, p: Vec3) => s + p[1], 0) / unique.length,
    unique.reduce((s: number, p: Vec3) => s + p[2], 0) / unique.length,
  ];
  // A stable in-plane basis: u = normalize(any world axis ⊥ normal) (x
  // preferred, then y, then z); v = normal × u.
  let u: Vec3 | null = null;
  for (const [ax, ay, az] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
    const cross = [normal[1]! * az - normal[2]! * ay, normal[2]! * ax - normal[0]! * az, normal[0]! * ay - normal[1]! * ax];
    const len = Math.sqrt(cross[0]! ** 2 + cross[1]! ** 2 + cross[2]! ** 2);
    if (len > 1e-9) {
      u = [cross[0]! / len, cross[1]! / len, cross[2]! / len];
      break;
    }
  }
  if (u === null) return [];
  const v: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  const withAngle = unique.map((p: Vec3, index: number) => {
    const d = v3Sub(p, centroid);
    return { p, index, angle: Math.atan2(v3Dot(d, v), v3Dot(d, u)) };
  });
  withAngle.sort((a, b) => (a.angle === b.angle ? a.index - b.index : a.angle - b.angle));
  return withAngle.map((w) => w.p);
}

/** The input surface for preview computation (element id + persisted extent). */
export interface SectionPreviewElement {
  readonly id: string;
  readonly bbox: BBox3D | null;
}

/** Build the derived section preview BODY for a plane against elements (the
 *  App API layer computes the canonical hash over this body). */
export function buildSectionPreview(
  plane: SectionPlaneRecord,
  elements: readonly SectionPreviewElement[],
): SectionPreviewBody {
  const facets: SectionPreviewFacet[] = [];
  const missed: string[] = [];
  const noExtent: string[] = [];
  for (const el of elements) {
    if (el.bbox === null) {
      noExtent.push(el.id);
      continue;
    }
    const polygon = intersectPlaneBox(plane.origin, plane.normal, el.bbox);
    if (polygon.length === 0) {
      missed.push(el.id);
      continue;
    }
    facets.push({ elementId: el.id, polygon });
  }
  return {
    format: SECTION_PREVIEW_FORMAT,
    version: SECTION_PREVIEW_VERSION,
    sectionPlaneId: plane.id,
    origin: plane.origin,
    normal: plane.normal,
    facets,
    missedElementIds: missed,
    noExtentElementIds: noExtent,
  };
}

/** The typed decline reason surfaced for exact cross-section requests (the
 *  bounded slice's explicit unsupported behavior — acceptance criterion 6). */
export const SECTION_EXACT_DECLINE_REASON =
  "exact BRep cross-sections are not supported in this slice: the adapter boundary exposes no section operation; the bounded extent-level preview (plane ∩ element extent) is the deterministic surface (no silent approximation)";
