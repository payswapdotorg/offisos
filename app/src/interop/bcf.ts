/**
 * CAD-PARITY-014 (Issue #107) — the BCF exchange classification (D3):
 * the field-level vocabulary of what a BCF topic round-trip preserves.
 *
 * Rides the ifc/report.ts classification vocabulary (exact/tolerance/lossy/
 * unsupported — the same semantics as the IFC reconciliation reports):
 *  - camera fields (viewpoint/direction/up) classify within the DECLARED
 *    1e-6 tolerance (the worker's r9 rounding bound);
 *  - the orthogonal flag + view-to-world scale classify exact;
 *  - the selection references (IfcGuids) classify exact;
 *  - the source-revision lineage classifies exact when carried, unsupported
 *    when the topic carries none (typed, never guessed);
 *  - snapshot bitmaps are UNSUPPORTED by construction (this writer never
 *    writes them — the typed decline, LOCK-007).
 *
 * Pure + engine-free (LOCK-018). Deterministic: fixed field order.
 */

import type { IfcBcfParsedTopic, IfcBcfTopicRequest } from "../contracts/ifc.js";
import type { IfcFieldResult } from "../ifc/report.js";

/** The declared BCF camera tolerance (the r9 rounding bound on the wire). */
export const BCF_CAMERA_TOLERANCE = 1e-6;

function cameraField(field: string, expected: readonly number[], actual: readonly number[] | undefined): IfcFieldResult {
  if (actual === undefined || actual.length !== expected.length) {
    return { field, classification: "lossy", note: `the parsed topic carries no ${field} vector` };
  }
  const delta = Math.max(...expected.map((v, i) => Math.abs(v - (actual[i] ?? Number.NaN))));
  if (delta <= BCF_CAMERA_TOLERANCE) {
    return { field, classification: "tolerance", tolerance: BCF_CAMERA_TOLERANCE };
  }
  return { field, classification: "lossy" };
}

/** Classify one BCF topic round-trip (the authored request vs the parsed
 *  topic) — the per-topic field rows of the exchange classification. */
export function classifyBcfTopic(
  request: IfcBcfTopicRequest,
  parsed: IfcBcfParsedTopic,
): IfcFieldResult[] {
  const rows: IfcFieldResult[] = [];
  rows.push({
    field: "title",
    classification: request.title === parsed.title ? "exact" : "lossy",
  });
  rows.push({
    field: "references",
    classification: request.references.length === parsed.references.length &&
      [...request.references].sort().join(",") === [...parsed.references].sort().join(",")
      ? "exact"
      : "lossy",
  });
  if (request.viewpoint !== undefined) {
    const vp = parsed.viewpoint;
    rows.push(cameraField("cameraViewPoint", request.viewpoint.cameraViewPoint, vp?.cameraViewPoint));
    rows.push(cameraField("cameraDirection", request.viewpoint.cameraDirection, vp?.cameraDirection));
    rows.push(cameraField("cameraUpVector", request.viewpoint.cameraUpVector, vp?.cameraUpVector));
    rows.push({
      field: "orthogonal",
      classification: (request.viewpoint.orthogonal === true) === (vp?.orthogonal ?? false) ? "exact" : "lossy",
    });
    if (request.viewpoint.orthogonal === true) {
      const expected = request.viewpoint.viewToWorldScale ?? null;
      rows.push({
        field: "viewToWorldScale",
        classification: expected !== null && vp?.viewToWorldScale === expected ? "exact" : "lossy",
      });
    }
  } else if (parsed.viewpoint !== null) {
    // The legacy payload (no viewpoint) still carries the container's
    // origin-target default camera — an additive artifact, classified.
    rows.push({ field: "viewpoint", classification: "tolerance", tolerance: BCF_CAMERA_TOLERANCE, note: "the legacy payload carries no authored camera; the parsed topic returns the container's default origin-target viewpoint" });
  }
  if (request.sourceRevision !== undefined) {
    rows.push({
      field: "sourceRevision",
      classification: parsed.sourceRevision === request.sourceRevision ? "exact" : "lossy",
    });
  } else {
    rows.push({
      field: "sourceRevision",
      classification: "unsupported",
      note: "the topic carries no source-revision lineage (the caller did not declare one)",
    });
  }
  // Snapshot bitmaps are never written by this writer — the typed decline.
  rows.push({
    field: "snapshot",
    classification: "unsupported",
    note: "BCF snapshot bitmaps are outside the writer boundary (never written, never parsed)",
  });
  return rows;
}
