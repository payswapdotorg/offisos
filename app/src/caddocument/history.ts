/**
 * Model history engine (CAD-IMPLEMENT-003, data-model.md §2/§3, LOCK-005).
 *
 * Owns the immutable, append-only `ModelHistory` log that persists with the
 * CADDocument snapshot (save/open): revision recording, deterministic
 * historical replay, structural validation and canonical hashing.
 *
 * Replay is information-state correct: replaying to revision k consumes ONLY
 * the base plus the first k revisions — no future leakage. The revision log
 * is a deterministic command log: every recorded transition carries the edit
 * that produced it, so folding the log over the base reproduces the element
 * set (and its content hash) at every revision.
 *
 * CADDocument remains the editor representation; this log is document-local
 * version history — NOT the Construction Graph (LOCK-019).
 */

import { createHash } from "node:crypto";
import type { DocumentEdit, Element, VersionMeta } from "../contracts/caddocument.js";
import type { ModelHistory, ModelRevision, RevisionBase, RevisionDelta, RevisionNote } from "../contracts/model.js";
import { canonicalStringify } from "./serialization.js";

/** Fixed deterministic timestamp (same invariant as CADDocument). */
export const HISTORY_NOW = "2026-01-01T00:00:00.000Z";

/** Deterministic revision id: `<entityId>#r<n>(<contentHash12>)`. */
export function makeRevisionId(entityId: string, revisionNumber: number, contentHash: string): string {
  return `${entityId}#r${revisionNumber}(${contentHash.slice(0, 12)})`;
}

/** Content-only hash over {format, formatVersion, sourceArtifactLineage, elements}
 *  — identical inputs to the CADDocument version-id derivation hash. */
export function contentHashOf(
  format: string,
  formatVersion: string,
  sourceArtifactLineage: readonly string[],
  elements: readonly Element[],
): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        format,
        formatVersion,
        sourceArtifactLineage: [...sourceArtifactLineage],
        elements: [...elements],
      }),
    )
    .digest("hex");
}

/** Canonical SHA-256 over any JSON value (hash anchor for histories/events). */
export function canonicalHashOf(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/** Deep-freeze a value (immutability of recorded revisions). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  Object.freeze(value);
  return value;
}

/** Structural clone via canonical JSON (history adoption from parsed input). */
export function cloneHistory(history: ModelHistory): ModelHistory {
  return JSON.parse(canonicalStringify(history)) as ModelHistory;
}

// --- Revision recording -----------------------------------------------------

/** Element-set diff between two element states. Canonical ids, sorted. */
export function diffElements(before: Iterable<Element>, after: Iterable<Element>): RevisionDelta {
  const beforeMap = new Map<string, string>();
  for (const el of before) beforeMap.set(el.id, canonicalStringify(el));
  const afterMap = new Map<string, string>();
  for (const el of after) afterMap.set(el.id, canonicalStringify(el));
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const id of afterMap.keys()) {
    if (!beforeMap.has(id)) added.push(id);
    else if (beforeMap.get(id) !== afterMap.get(id)) updated.push(id);
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) removed.push(id);
  }
  added.sort();
  removed.sort();
  updated.sort();
  return { added, removed, updated };
}

export interface RecordRevisionInput {
  readonly history: ModelHistory;
  readonly fromVersionId: string;
  readonly toVersion: VersionMeta;
  readonly contentHash: string;
  readonly appliedEdit: DocumentEdit;
  readonly note: RevisionNote;
  readonly createdBy: string;
  /** Element state BEFORE the transition (for the delta). */
  readonly beforeElements: readonly Element[];
  /** Element state AFTER the transition (for the delta). */
  readonly afterElements: readonly Element[];
  /** Current mint-sequence counter (persisted on the history). */
  readonly nextElementSequence: number;
}

/** Append one immutable revision to a history (returns a NEW frozen
 *  history; the input history is never mutated — append-only integrity). */
export function appendRevision(input: RecordRevisionInput): ModelHistory {
  const { history } = input;
  const revisionNumber = history.revisions.length + 1;
  const delta = diffElements(input.beforeElements, input.afterElements);
  const revision: ModelRevision = deepFreeze({
    revision_number: revisionNumber,
    revision_id: makeRevisionId(history.entity_id, revisionNumber, input.contentHash),
    from_version_id: input.fromVersionId,
    version: input.toVersion,
    content_hash: input.contentHash,
    applied_edit: input.appliedEdit,
    delta,
    note: input.note,
    created_at: HISTORY_NOW,
    created_by: input.createdBy,
  });
  return deepFreeze({
    entity_id: history.entity_id,
    format: history.format,
    formatVersion: history.formatVersion,
    base: history.base,
    next_element_sequence: Math.max(history.next_element_sequence, input.nextElementSequence),
    revisions: deepFreeze([...history.revisions, revision]),
  });
}

/** Fresh history for a newly created document (empty root base). */
export function createdHistory(entityId: string, format: string, formatVersion: string, root: VersionMeta): ModelHistory {
  return deepFreeze({
    entity_id: entityId,
    format,
    formatVersion,
    base: deepFreeze({
      origin: "created",
      version: root,
      elements: [],
      sourceArtifactLineage: [],
    }),
    next_element_sequence: 1,
    revisions: [],
  });
}

/** Seeded history for an opened snapshot WITHOUT a persisted history
 *  (legacy artifact): the opened state becomes the base (origin "opened"). */
export function openedHistory(
  entityId: string,
  format: string,
  formatVersion: string,
  version: VersionMeta,
  elements: readonly Element[],
  lineage: readonly string[],
): ModelHistory {
  return deepFreeze({
    entity_id: entityId,
    format,
    formatVersion,
    base: deepFreeze({
      origin: "opened",
      version,
      elements: [...elements],
      sourceArtifactLineage: [...lineage],
    }),
    next_element_sequence: deriveElementSequence(elements),
    revisions: [],
  });
}

/** Derive the mint-sequence counter from existing minted ids (`el-NNNNNN`). */
export function deriveElementSequence(elements: readonly Element[]): number {
  let max = 0;
  for (const el of elements) {
    const m = /^el-(\d{6,})$/.exec(el.id);
    if (m !== null && m[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

// --- Deterministic historical replay ----------------------------------------

/** Apply a DocumentEdit to a mutable element map (mirrors CADDocument.applyEdit
 *  semantics; throws on missing operands — no guessed state, LOCK-007). */
export function applyEditToElements(map: Map<string, Element>, edit: DocumentEdit): void {
  switch (edit.type) {
    case "addElement": {
      if (edit.element === undefined) throw new Error("replay: addElement requires element");
      if (map.has(edit.element.id)) {
        throw new Error(`replay: duplicate element id '${edit.element.id}'`);
      }
      map.set(edit.element.id, edit.element);
      break;
    }
    case "removeElement": {
      if (edit.elementId === undefined) throw new Error("replay: removeElement requires elementId");
      if (!map.has(edit.elementId)) throw new Error(`replay: no element '${edit.elementId}'`);
      map.delete(edit.elementId);
      break;
    }
    case "updateElement": {
      if (edit.elementId === undefined || edit.patch === undefined) {
        throw new Error("replay: updateElement requires elementId + patch");
      }
      const el = map.get(edit.elementId);
      if (el === undefined) throw new Error(`replay: no element '${edit.elementId}'`);
      map.set(edit.elementId, { ...el, props: { ...el.props, ...edit.patch } });
      break;
    }
    case "setProps": {
      if (edit.elementId === undefined || edit.patch === undefined) {
        throw new Error("replay: setProps requires elementId + patch");
      }
      const el = map.get(edit.elementId);
      if (el === undefined) throw new Error(`replay: no element '${edit.elementId}'`);
      map.set(edit.elementId, { ...el, props: edit.patch });
      break;
    }
    default: {
      const _exhaustive: never = edit.type;
      throw new Error(`replay: unreachable edit type: ${_exhaustive}`);
    }
  }
}

/** Content-only hash of the history base (revision 0 reference). */
export function baseContentHash(history: ModelHistory): string {
  return contentHashOf(history.format, history.formatVersion, history.base.sourceArtifactLineage, history.base.elements);
}

/** Deterministic replay to revision k (0 = base). Consumes ONLY the base and
 *  the first k revisions — information-state correct, no future leakage. */
export function replayHistoryTo(history: ModelHistory, upto: number): {
  elements: Element[];
  content_hash: string;
} {
  if (typeof upto !== "number" || !Number.isInteger(upto) || upto < 0 || upto > history.revisions.length) {
    throw new Error(`replay: revision number ${JSON.stringify(upto)} out of range 0..${history.revisions.length}`);
  }
  const k = upto;
  const map = new Map<string, Element>();
  for (const el of history.base.elements) {
    if (map.has(el.id)) throw new Error(`replay: duplicate base element id '${el.id}'`);
    map.set(el.id, el);
  }
  for (let i = 0; i < k; i++) {
    const rev = history.revisions[i];
    if (rev === undefined) throw new Error(`replay: missing revision ${i + 1}`);
    applyEditToElements(map, rev.applied_edit);
  }
  const elements = [...map.values()];
  const content_hash = contentHashOf(
    history.format,
    history.formatVersion,
    history.base.sourceArtifactLineage,
    elements,
  );
  return { elements, content_hash };
}

// --- Structural validation (LOCK-007) ----------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidVersionMeta(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.entity_id === "string" &&
    typeof v.version_id === "string" &&
    typeof v.version_number === "number" &&
    (v.parent_version_id === null || typeof v.parent_version_id === "string") &&
    typeof v.created_at === "string" &&
    typeof v.created_by === "string" &&
    (v.source_snapshot_id === null || typeof v.source_snapshot_id === "string") &&
    (v.status === "ACTIVE" || v.status === "SUPERSEDED")
  );
}

function isValidDelta(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return (
    Array.isArray(v.added) && v.added.every((x) => typeof x === "string") &&
    Array.isArray(v.removed) && v.removed.every((x) => typeof x === "string") &&
    Array.isArray(v.updated) && v.updated.every((x) => typeof x === "string")
  );
}

function isValidDocumentEdit(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (v.type !== "addElement" && v.type !== "removeElement" && v.type !== "updateElement" && v.type !== "setProps") {
    return false;
  }
  if (v.elementId !== undefined && typeof v.elementId !== "string") return false;
  if (v.element !== undefined && !isPlainObject(v.element)) return false;
  if (v.patch !== undefined && !isPlainObject(v.patch)) return false;
  return true;
}

function isValidElement(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (v.kind !== "geometry" && v.kind !== "bim" && v.kind !== "annotation") return false;
  if (v.engineId !== null && typeof v.engineId !== "string") return false;
  if (!isPlainObject(v.props)) return false;
  return true;
}

/** Structural validation of a ModelHistory (LOCK-007: reject malformed input
 *  instead of guessing). Throws with a descriptive message on violation. */
export function validateModelHistory(history: unknown): asserts history is ModelHistory {
  if (!isPlainObject(history)) throw new Error("modelHistory must be an object");
  if (typeof history.entity_id !== "string" || history.entity_id.length === 0) {
    throw new Error("modelHistory.entity_id must be a non-empty string");
  }
  if (typeof history.format !== "string" || typeof history.formatVersion !== "string") {
    throw new Error("modelHistory.format/formatVersion must be strings");
  }
  const base = history.base;
  if (!isPlainObject(base)) throw new Error("modelHistory.base must be an object");
  if (base.origin !== "created" && base.origin !== "opened") {
    throw new Error("modelHistory.base.origin must be 'created' or 'opened'");
  }
  if (!isValidVersionMeta(base.version)) throw new Error("modelHistory.base.version does not satisfy data-model.md §2");
  if (!Array.isArray(base.elements) || !base.elements.every(isValidElement)) {
    throw new Error("modelHistory.base.elements must be an array of valid elements");
  }
  if (!Array.isArray(base.sourceArtifactLineage) || !base.sourceArtifactLineage.every((x) => typeof x === "string")) {
    throw new Error("modelHistory.base.sourceArtifactLineage must be a string array");
  }
  if (
    typeof history.next_element_sequence !== "number" ||
    !Number.isInteger(history.next_element_sequence) ||
    history.next_element_sequence < 1
  ) {
    throw new Error("modelHistory.next_element_sequence must be a positive integer");
  }
  if (!Array.isArray(history.revisions)) throw new Error("modelHistory.revisions must be an array");
  for (const [i, rev] of history.revisions.entries()) {
    if (!isPlainObject(rev)) throw new Error(`modelHistory.revisions[${i}] must be an object`);
    if (rev.revision_number !== i + 1) {
      throw new Error(`modelHistory.revisions[${i}].revision_number must be ${i + 1} (append-only log)`);
    }
    if (typeof rev.revision_id !== "string" || rev.revision_id.length === 0) {
      throw new Error(`modelHistory.revisions[${i}].revision_id must be a string`);
    }
    if (typeof rev.from_version_id !== "string") {
      throw new Error(`modelHistory.revisions[${i}].from_version_id must be a string`);
    }
    if (!isValidVersionMeta(rev.version)) {
      throw new Error(`modelHistory.revisions[${i}].version does not satisfy data-model.md §2`);
    }
    if (typeof rev.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(rev.content_hash)) {
      throw new Error(`modelHistory.revisions[${i}].content_hash must be a sha-256 hex string`);
    }
    if (!isValidDocumentEdit(rev.applied_edit)) {
      throw new Error(`modelHistory.revisions[${i}].applied_edit must be a valid DocumentEdit`);
    }
    if (!isValidDelta(rev.delta)) {
      throw new Error(`modelHistory.revisions[${i}].delta must be {added,removed,updated} string arrays`);
    }
    if (rev.note !== "edit" && rev.note !== "undo" && rev.note !== "redo") {
      throw new Error(`modelHistory.revisions[${i}].note must be edit|undo|redo`);
    }
    if (typeof rev.created_at !== "string" || typeof rev.created_by !== "string") {
      throw new Error(`modelHistory.revisions[${i}].created_at/created_by must be strings`);
    }
  }
}

/** Validate the linkage between a snapshot and its carried history: the
 *  snapshot's current version must be the last revision's version (or the
 *  base version when there are no revisions), and the entity ids must match. */
export function validateHistoryLinkage(
  history: ModelHistory,
  version: VersionMeta,
  format: string,
  formatVersion: string,
): void {
  if (history.entity_id !== version.entity_id) {
    throw new Error("modelHistory entity_id does not match the snapshot version entity_id");
  }
  if (history.format !== format || history.formatVersion !== formatVersion) {
    throw new Error("modelHistory format/formatVersion does not match the snapshot");
  }
  const last = history.revisions[history.revisions.length - 1];
  const expectedVersionId = last !== undefined ? last.version.version_id : history.base.version.version_id;
  if (version.version_id !== expectedVersionId) {
    throw new Error(
      `modelHistory linkage violation: snapshot version ${version.version_id} is not the history head ${expectedVersionId}`,
    );
  }
}

/** Canonical hash of a model history (persistence/parity anchor). */
export function historyHash(history: ModelHistory): string {
  return canonicalHashOf(history);
}

/** Exported for tests: replay with integrity verification against the
 *  recorded revision content hashes (LOCK-005). */
export function verifiedReplay(history: ModelHistory, upto: number): { elements: Element[]; content_hash: string; verified: boolean } {
  const result = replayHistoryTo(history, upto);
  if (upto === 0) {
    return { ...result, verified: result.content_hash === baseContentHash(history) };
  }
  const recorded = history.revisions[upto - 1]?.content_hash;
  return { ...result, verified: recorded === result.content_hash };
}

/** Type re-exports for convenience. */
export type { ModelHistory, ModelRevision, RevisionBase, RevisionDelta, RevisionNote };
