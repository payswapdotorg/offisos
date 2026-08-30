/**
 * CAD-PARITY-009 (Issue #90): the canonical deterministic 3D scene SVG
 * writer — the shared "deterministic visual state" surface.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) and BROWSER-SAFE
 * (pure string building — crypto-free and serialization-free, the
 * layouts/svg.ts precedent): BOTH hosts render the byte-identical SVG from
 * the same inputs, and the parity fixture pins its SHA-256 (computed at the
 * App API layer). The rendered extent surface is the PERSISTED element
 * extent (the engine-produced bbox in element props) drawn as a wireframe
 * and EXPLICITLY labeled extent-level (data-extent="bbox"); the engine mesh
 * identity is carried as provenance text only (the meshToken prefix) — the
 * canonical scene never depends on tessellation internals.
 *
 * Determinism rules: elements sorted by canonical id; the 12 extent edges in
 * boxEdges order; grid segments in the given order; every number rendered
 * through fmtNum (6 decimals, −0 normalized); fixed stroke vocabulary; the
 * UCS triad drawn at the active UCS origin with the domain-standard axis
 * colors (X red, Y green, Z blue); section preview facets drawn after the
 * grid, before the elements.
 */

import type { Camera3DState, UcsRecord } from "../../contracts/caddocument.js";
import type { Vec3 } from "../../contracts/geometry.js";
import { fmtNum, v3Add, v3Scale } from "./math3d.js";
import { type BBox3D, cameraFrame } from "./camera.js";
import { boxEdges, projectPoint, type ScreenViewport } from "./projection.js";
import type { SectionPreviewFacet } from "./section.js";
import type { UcsGridSegment } from "./ucs.js";

/** The canonical 3D scene SVG format identity. */
export const SCENE3D_SVG_FORMAT = "offisos-scene3d-svg";
export const SCENE3D_SVG_VERSION = "1";

/** One element's rendered surface input. */
export interface Scene3DElement {
  readonly id: string;
  /** The persisted engine-produced extent (element props meshBBox), or null
   *  when the element has no realized geometry (rendered as a small marker
   *  cross at the origin — explicit, not hidden). */
  readonly bbox: BBox3D | null;
  /** Engine provenance marker (the meshToken prefix) — text-only. */
  readonly meshToken?: string;
}

/** The full scene input (all derived/persisted state — no engine calls). */
export interface Scene3DInput {
  readonly viewport: ScreenViewport;
  readonly camera: Camera3DState;
  readonly elements: readonly Scene3DElement[];
  /** The ACTIVE UCS (triad + grid frame). Absent = World. */
  readonly ucs?: UcsRecord;
  readonly grid?: readonly UcsGridSegment[];
  readonly sectionFacets?: readonly SectionPreviewFacet[];
  readonly selectedIds?: readonly string[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the canonical deterministic 3D scene SVG. */
export function buildScene3DSVG(input: Scene3DInput): string {
  const { viewport, camera } = input;
  const frame = cameraFrame(camera);
  const ucs = input.ucs ?? undefined;
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(viewport.width)}" height="${fmtNum(viewport.height)}" viewBox="0 0 ${fmtNum(viewport.width)} ${fmtNum(viewport.height)}" data-format="${SCENE3D_SVG_FORMAT}" data-version="${SCENE3D_SVG_VERSION}">`);
  lines.push(`<rect x="0" y="0" width="${fmtNum(viewport.width)}" height="${fmtNum(viewport.height)}" fill="#ffffff"/>`);
  const p = (w: Vec3): { x: number; y: number } | null => {
    const pr = projectPoint(camera, viewport, w);
    return pr === null ? null : { x: pr.x, y: pr.y };
  };
  const line = (a: Vec3, b: Vec3, stroke: string, width: number, opacity: number, extra = ""): void => {
    const pa = p(a);
    const pb = p(b);
    if (pa === null || pb === null) return;
    lines.push(`<line x1="${fmtNum(pa.x)}" y1="${fmtNum(pa.y)}" x2="${fmtNum(pb.x)}" y2="${fmtNum(pb.y)}" stroke="${stroke}" stroke-width="${fmtNum(width)}" stroke-opacity="${fmtNum(opacity)}"${extra}/>`);
  };

  // Grid on the active workplane.
  if (input.grid !== undefined && input.grid.length > 0) {
    lines.push(`<g class="grid" data-plane="ucs-xy">`);
    for (const seg of input.grid) {
      line(seg.a, seg.b, "#d4d4d4", 1, 1);
    }
    lines.push(`</g>`);
  }

  // Section preview facets (extent-level, explicitly labeled).
  if (input.sectionFacets !== undefined && input.sectionFacets.length > 0) {
    lines.push(`<g class="section-preview" data-level="extent">`);
    for (const facet of input.sectionFacets) {
      const pts: string[] = [];
      for (const v of facet.polygon) {
        const pv = p(v);
        if (pv === null) break;
        pts.push(`${fmtNum(pv.x)},${fmtNum(pv.y)}`);
      }
      if (pts.length === facet.polygon.length) {
        lines.push(`<polygon points="${pts.join(" ")}" fill="rgba(204,51,51,0.12)" stroke="#cc3333" stroke-width="1" data-element="${esc(facet.elementId)}"/>`);
      }
    }
    lines.push(`</g>`);
  }

  // Elements: sorted by canonical id; extent wireframes (12 edges, fixed
  // order); depth cue from the extent-center view depth (deterministic).
  const elements = [...input.elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = new Set(input.selectedIds ?? []);
  let zmin = Number.POSITIVE_INFINITY;
  let zmax = Number.NEGATIVE_INFINITY;
  for (const el of elements) {
    if (el.bbox === null) continue;
    const c: Vec3 = [(el.bbox.minX + el.bbox.maxX) / 2, (el.bbox.minY + el.bbox.maxY) / 2, (el.bbox.minZ + el.bbox.maxZ) / 2];
    const d = v3Add(v3Scale(c, 1), [0, 0, 0]);
    if (frame !== null) {
      const rel: Vec3 = [d[0] - camera.eye[0], d[1] - camera.eye[1], d[2] - camera.eye[2]];
      const zc = rel[0] * frame.forward[0] + rel[1] * frame.forward[1] + rel[2] * frame.forward[2];
      if (zc < zmin) zmin = zc;
      if (zc > zmax) zmax = zc;
    }
  }
  const span = zmax > zmin ? zmax - zmin : 1;
  for (const el of elements) {
    const isSel = selected.has(el.id);
    const title = el.meshToken !== undefined ? `${el.id} extent=bbox mesh=${el.meshToken.slice(0, 12)}` : `${el.id} extent=bbox`;
    lines.push(`<g class="element" data-id="${esc(el.id)}" data-extent="bbox"${isSel ? ` data-selected="true"` : ""}>`);
    lines.push(`<title>${esc(title)}</title>`);
    if (el.bbox === null) {
      // No realized geometry: an explicit small cross at the world origin.
      line([-0.1, 0, 0], [0.1, 0, 0], "#9ca3af", 1, 1);
      line([0, -0.1, 0], [0, 0.1, 0], "#9ca3af", 1, 1);
    } else {
      const c: Vec3 = [(el.bbox.minX + el.bbox.maxX) / 2, (el.bbox.minY + el.bbox.maxY) / 2, (el.bbox.minZ + el.bbox.maxZ) / 2];
      let opacity = 1;
      if (frame !== null) {
        const rel: Vec3 = [c[0] - camera.eye[0], c[1] - camera.eye[1], c[2] - camera.eye[2]];
        const zc = rel[0] * frame.forward[0] + rel[1] * frame.forward[1] + rel[2] * frame.forward[2];
        const t = Math.min(1, Math.max(0, (zc - zmin) / span));
        opacity = 1 - 0.55 * t;
      }
      const stroke = isSel ? "#b45309" : "#404040";
      const width = isSel ? 1.75 : 1;
      for (const [a, b] of boxEdges(el.bbox)) {
        line(a, b, stroke, width, opacity);
      }
    }
    lines.push(`</g>`);
  }

  // UCS triad at the active UCS origin (domain-standard axis colors).
  if (ucs !== undefined) {
    const axisLen = 1;
    lines.push(`<g class="ucs-triad" data-ucs="${esc(ucs.id)}">`);
    line(ucs.origin, v3Add(ucs.origin, v3Scale(ucs.xAxis, axisLen)), "#dc2626", 1.5, 1);
    line(ucs.origin, v3Add(ucs.origin, v3Scale(ucs.yAxis, axisLen)), "#16a34a", 1.5, 1);
    line(ucs.origin, v3Add(ucs.origin, v3Scale(ucs.zAxis, axisLen)), "#2563eb", 1.5, 1);
    const px = p(v3Add(ucs.origin, v3Scale(ucs.xAxis, axisLen * 1.15)));
    const py = p(v3Add(ucs.origin, v3Scale(ucs.yAxis, axisLen * 1.15)));
    const pz = p(v3Add(ucs.origin, v3Scale(ucs.zAxis, axisLen * 1.15)));
    if (px !== null) lines.push(`<text x="${fmtNum(px.x)}" y="${fmtNum(px.y)}" font-family="monospace" font-size="10" fill="#dc2626">X</text>`);
    if (py !== null) lines.push(`<text x="${fmtNum(py.x)}" y="${fmtNum(py.y)}" font-family="monospace" font-size="10" fill="#16a34a">Y</text>`);
    if (pz !== null) lines.push(`<text x="${fmtNum(pz.x)}" y="${fmtNum(pz.y)}" font-family="monospace" font-size="10" fill="#2563eb">Z</text>`);
    lines.push(`</g>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n") + "\n";
}
