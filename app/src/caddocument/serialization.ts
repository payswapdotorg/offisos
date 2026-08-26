/**
 * Canonical serialization for CADDocument snapshots (LOCK-005, LOCK-012).
 *
 * Canonical JSON (sorted keys, stable formatting) makes round-trip identity
 * verifiable and gives a reproducible hash for parity + CI reproducibility
 * evidence. Source provenance is preserved (LOCK-012); the format/version
 * metadata travels with the snapshot.
 */

import { createHash } from "node:crypto";
import type { CADDocumentSnapshot } from "../contracts/caddocument.js";
import { validateModelHistory } from "./history.js";

/** Recursively sort object keys for canonical JSON. Arrays preserve order. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

/** Stable SHA-256 over the canonical encoding. Same snapshot → same hash. */
export function canonicalHash(snapshot: CADDocumentSnapshot): string {
  return createHash("sha256").update(canonicalStringify(snapshot)).digest("hex");
}

/** Serialize a snapshot to canonical JSON text. */
export function serialize(snapshot: CADDocumentSnapshot): string {
  return canonicalStringify(snapshot);
}

/** Deserialize canonical JSON text back to a snapshot. Throws on malformed
 *  input (LOCK-007: no inferred/guessed values presented as observed fact). */
export function deserialize(text: string): CADDocumentSnapshot {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("deserialize: expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version === undefined || typeof version !== "object" || version === null) {
    throw new Error("deserialize: missing version metadata");
  }
  const v = version as Record<string, unknown>;
  if (
    typeof v.entity_id !== "string" ||
    typeof v.version_id !== "string" ||
    typeof v.version_number !== "number" ||
    (v.parent_version_id !== null && typeof v.parent_version_id !== "string") ||
    typeof v.created_at !== "string" ||
    typeof v.created_by !== "string" ||
    (v.source_snapshot_id !== null && typeof v.source_snapshot_id !== "string") ||
    typeof v.status !== "string"
  ) {
    throw new Error("deserialize: version metadata does not satisfy data-model.md §2");
  }
  if (typeof obj.format !== "string" || typeof obj.formatVersion !== "string") {
    throw new Error("deserialize: missing format/formatVersion (§5.4)");
  }
  if (!Array.isArray(obj.elements) || !Array.isArray(obj.sourceArtifactLineage)) {
    throw new Error("deserialize: missing elements/lineage arrays");
  }
  const editorState = obj.editorState;
  if (editorState === undefined || typeof editorState !== "object" || editorState === null) {
    throw new Error("deserialize: missing editorState");
  }
  const es = editorState as Record<string, unknown>;
  if (typeof es.canUndo !== "boolean" || typeof es.canRedo !== "boolean" || typeof es.commandDepth !== "number") {
    throw new Error("deserialize: editorState fields missing/invalid");
  }
  if (obj.modelHistory !== undefined) {
    // CAD-IMPLEMENT-003 (additive, LOCK-007): structurally validate the
    // persisted model revision history — never guess or silently repair.
    try {
      validateModelHistory(obj.modelHistory);
    } catch (e) {
      throw new Error(`deserialize: ${(e as Error).message}`);
    }
  }
  return obj as unknown as CADDocumentSnapshot;
}

/** Round-trip identity check: serialize → deserialize → canonical hash equal. */
export function roundTripPreservesHash(snapshot: CADDocumentSnapshot): boolean {
  return canonicalHash(deserialize(serialize(snapshot))) === canonicalHash(snapshot);
}
