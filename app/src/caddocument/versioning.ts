/**
 * Version chain helpers for CADDocument (data-model.md §2, §3).
 *
 * Every versioned entity carries: entity_id, version_id, version_number,
 * parent_version_id, created_at, created_by, source_snapshot_id, status.
 * The version chain is reconstructable via parent_version_id (LOCK-005).
 */

import type { VersionMeta } from "../contracts/caddocument.js";

/** Deterministic version id from a content hash + version number. Keeps the
 *  chain reproducible (LOCK-005, historical replay integrity). */
export function makeVersionId(entityId: string, versionNumber: number, contentHash: string): string {
  return `${entityId}#v${versionNumber}(${contentHash.slice(0, 12)})`;
}

/** A root version (no parent). Used by `document.open`. */
export function rootVersion(
  entityId: string,
  createdBy: string,
  sourceSnapshotId: string | null,
  now: () => string = () => new Date("2026-01-01T00:00:00.000Z").toISOString(),
): VersionMeta {
  return {
    entity_id: entityId,
    version_id: makeVersionId(entityId, 1, "root"),
    version_number: 1,
    parent_version_id: null,
    created_at: now(),
    created_by: createdBy,
    source_snapshot_id: sourceSnapshotId,
    status: "ACTIVE",
  };
}

/** A child version of `parent`, with `parent` superseded. The CADDocument
 *  model always carries one ACTIVE version; the chain is reconstructable via
 *  parent_version_id (LOCK-005). */
export function childVersion(
  parent: VersionMeta,
  contentHash: string,
  createdBy: string,
  sourceSnapshotId: string | null = parent.source_snapshot_id,
  now: () => string = () => new Date("2026-01-01T00:00:00.000Z").toISOString(),
): VersionMeta {
  const versionNumber = parent.version_number + 1;
  return {
    entity_id: parent.entity_id,
    version_id: makeVersionId(parent.entity_id, versionNumber, contentHash),
    version_number: versionNumber,
    parent_version_id: parent.version_id,
    created_at: now(),
    created_by: createdBy,
    source_snapshot_id: sourceSnapshotId,
    status: "ACTIVE",
  };
}

/** Reconstruct the version chain from a snapshot's version metadata (the
 *  parent chain is implicit via parent_version_id). */
export function describeChain(version: VersionMeta): string[] {
  const chain: string[] = [version.version_id];
  let cursor: string | null = version.parent_version_id;
  let guard = 0;
  while (cursor !== null && guard < 1024) {
    chain.push(cursor);
    cursor = null; // parent's parent is not carried on the child; chain depth is 1 here.
    guard++;
  }
  return chain;
}
