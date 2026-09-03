/**
 * CAD-PARITY-018 (Issue #118) — the raster/underlay toolset: the
 * reference status derivation (ok/stale/missing — computed fresh, never
 * stored) and the typed NON-AUTHORITATIVE trace (the source lineWork
 * vectors mapped from pixel space to document space through the declared
 * transform, with the clipping filter). Engine-free (LOCK-018): exact
 * fixed-formula trigonometry — the canonical 90°-multiple headings use
 * the exact axis table (no trig rounding), general headings use the
 * fixed cos/sin formulas. The trace is never authority: canonical
 * geometry only exists after rasterCommitTrace creates real elements
 * through the existing element-creation edit path.
 */

import type {
  RasterClipping,
  RasterLineVector,
  RasterReferenceData,
  RasterSourceData,
  RasterStatusReport,
  RasterTraceResult,
  RasterTraceVector,
} from "../contracts/toolsets.js";
import { toolsetErr } from "./errors.js";

// ---------------------------------------------------------------------------
// Reference status (the derived staleness/missing table).
// ---------------------------------------------------------------------------

/** Derive one reference's status against the registered sources:
 *  - missing: no source with the reference's sourceRef is registered;
 *  - stale: the source's contentDigest no longer equals the reference's
 *    declaredDigest (the underlay changed after attach);
 *  - ok: the source exists and the digest matches. */
export function referenceStatus(
  reference: { id: string; data: RasterReferenceData },
  sources: readonly { data: RasterSourceData }[],
): RasterStatusReport {
  const source = sources.find((s) => s.data.sourceRef === reference.data.sourceRef);
  if (source === undefined) {
    return {
      referenceId: reference.id,
      sourceRef: reference.data.sourceRef,
      status: "missing",
      reason: `no raster source with sourceRef '${reference.data.sourceRef}' is registered (the underlay is missing)`,
    };
  }
  if (source.data.contentDigest !== reference.data.declaredDigest) {
    return {
      referenceId: reference.id,
      sourceRef: reference.data.sourceRef,
      status: "stale",
      reason: `the raster source '${reference.data.sourceRef}' digest changed since attach (declared '${reference.data.declaredDigest}', current '${source.data.contentDigest}') — the reference is stale`,
    };
  }
  return {
    referenceId: reference.id,
    sourceRef: reference.data.sourceRef,
    status: "ok",
    reason: `the raster source '${reference.data.sourceRef}' matches the declared digest '${reference.data.declaredDigest}'`,
  };
}

// ---------------------------------------------------------------------------
// The trace (pixel space → document space through the transform).
// ---------------------------------------------------------------------------

/** The exact rotation matrix entries for the canonical 90°-multiple
 *  headings (deterministic — no trig rounding); general headings use the
 *  fixed cos/sin formulas. */
function rotationEntries(deg: number): { cos: number; sin: number } {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized === 0) return { cos: 1, sin: 0 };
  if (normalized === 90) return { cos: 0, sin: 1 };
  if (normalized === 180) return { cos: -1, sin: 0 };
  if (normalized === 270) return { cos: 0, sin: -1 };
  const rad = (normalized * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

/** Map ONE pixel-space point to document space: scale first, then rotate
 *  about the pixel origin, then translate to the declared origin
 *  (mm):  doc = origin + R(θ)·(scale·pixel). */
export function mapPoint(
  px: number,
  py: number,
  transform: RasterReferenceData["transform"],
): { x: number; y: number } {
  const { cos, sin } = rotationEntries(transform.rotationDeg);
  const sx = px * transform.scale;
  const sy = py * transform.scale;
  return {
    x: transform.origin.x + cos * sx - sin * sy,
    y: transform.origin.y + sin * sx + cos * sy,
  };
}

/** The clipping containment rule (deterministic): a vector is KEPT iff
 *  its MIDPOINT (pixel space) lies inside the clip rectangle
 *  (inclusive edges). Vectors fully outside are dropped. */
function midpointInClip(v: RasterLineVector, clip: RasterClipping): boolean {
  const mx = (v.x1 + v.x2) / 2;
  const my = (v.y1 + v.y2) / 2;
  return (
    mx >= clip.x && mx <= clip.x + clip.w &&
    my >= clip.y && my <= clip.y + clip.h
  );
}

/** Derive the NON-AUTHORITATIVE trace of one reference: the source's
 *  lineWork vectors mapped through the reference transform (scale →
 *  rotation → origin), with the clip filter applied (midpoint
 *  containment). A source with no lineWork yields the EMPTY vector list
 *  with the typed notice — never an error. The result ALWAYS carries
 *  authoritative:false and the commit notice. */
export function trace(
  reference: { id: string; data: RasterReferenceData },
  source: { data: RasterSourceData },
): RasterTraceResult {
  const lineWork = source.data.lineWork ?? [];
  const vectors: RasterTraceVector[] = [];
  for (const v of lineWork) {
    if (reference.data.clipping !== undefined && !midpointInClip(v, reference.data.clipping)) continue;
    const from = mapPoint(v.x1, v.y1, reference.data.transform);
    const to = mapPoint(v.x2, v.y2, reference.data.transform);
    vectors.push({ from, to });
  }
  const notice =
    lineWork.length === 0
      ? `the raster source '${reference.data.sourceRef}' declares no lineWork vectors — the trace is empty (non-authoritative: commit through toolset.rasterCommitTrace for canonical geometry)`
      : `non-authoritative trace derived from the raster source '${reference.data.sourceRef}' (${vectors.length}/${lineWork.length} vectors kept after clipping) — committing through toolset.rasterCommitTrace is required for canonical geometry`;
  return {
    referenceId: reference.id,
    sourceRef: reference.data.sourceRef,
    vectors,
    authoritative: false,
    notice,
  };
}

/** Select the trace vectors for a commit (all, or the requested subset —
 *  typed decline on an out-of-range index). Returns the vector ORIGINAL
 *  indices alongside (the lineage payload). */
export function selectTraceVectors(
  result: RasterTraceResult,
  vectorIndices: readonly number[] | undefined,
): readonly { index: number; vector: RasterTraceVector }[] {
  if (vectorIndices === undefined) {
    return result.vectors.map((vector, index) => ({ index, vector }));
  }
  if (!Array.isArray(vectorIndices) || vectorIndices.length === 0) {
    throw toolsetErr("toolset_bad_payload", "vectorIndices must be a non-empty array of indices when present");
  }
  if (vectorIndices.length > result.vectors.length) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `vectorIndices exceeds the traced vector count (${result.vectors.length})`,
    );
  }
  const seen = new Set<number>();
  return vectorIndices.map((raw) => {
    if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) >= result.vectors.length) {
      throw toolsetErr(
        "toolset_out_of_bounds",
        `vectorIndex ${JSON.stringify(raw)} is out of range (the trace carries ${result.vectors.length} vectors)`,
      );
    }
    const index = raw as number;
    if (seen.has(index)) {
      throw toolsetErr("toolset_bad_payload", `vectorIndex ${index} is requested twice (unique indices only)`);
    }
    seen.add(index);
    return { index, vector: result.vectors[index]! };
  });
}
