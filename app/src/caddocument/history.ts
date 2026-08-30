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
  /** COMPAT-CAD-001: current layer mint-sequence counter (persisted on the
   *  history; never-reused `ly-NNNNNN` identities). */
  readonly nextLayerSequence: number;
  /** COMPAT-CAD-003: current documentation view mint-sequence counter
   *  (persisted on the history; never-reused `vw-NNNNNN` identities). */
  readonly nextViewSequence: number;
  /** COMPAT-CAD-003: current documentation sheet mint-sequence counter
   *  (persisted on the history; never-reused `sh-NNNNNN` identities). */
  readonly nextSheetSequence: number;
  /** COMPAT-IFC-001: the import-record mint counter after this revision. */
  readonly nextIfcImportSequence?: number;
  /** CAD-PARITY-006: the block-definition mint counter after this revision
   *  (never-reused `blk-NNNNNN` identities). */
  readonly nextBlockSequence?: number;
  /** CAD-PARITY-006: the external-reference mint counter after this
   *  revision (never-reused `xr-NNNNNN` identities). */
  readonly nextXrefSequence?: number;
  /** CAD-PARITY-007: the constraint mint counter after this revision
   *  (never-reused `con-NNNNNN` identities). */
  readonly nextConstraintSequence?: number;
  /** CAD-PARITY-008: the layout mint counter after this revision
   *  (never-reused `lo-NNNNNN` identities). */
  readonly nextLayoutSequence?: number;
  /** CAD-PARITY-008: the viewport mint counter after this revision
   *  (never-reused `vp-NNNNNN` identities). */
  readonly nextViewportSequence?: number;
  /** CAD-PARITY-009: the UCS mint counter after this revision
   *  (never-reused `ucs-NNNNNN` identities). */
  readonly nextUcsSequence?: number;
  /** CAD-PARITY-009: the section-plane mint counter after this revision
   *  (never-reused `sp-NNNNNN` identities). */
  readonly nextSectionPlaneSequence?: number;
}

/** Append one immutable revision to a history (returns a NEW frozen
 *  history; the input history is never mutated — append-only integrity).
 *  CAD-PARITY-006: the block/xref mint counters are CANONICAL-MINIMAL —
 *  emitted only once a block/xref identity has actually been minted
 *  (counter > 1) so histories (and saves) of documents that never touch
 *  blocks stay BYTE-IDENTICAL to the pre-006 form (the pinned parity
 *  fixtures; the counters only ever grow — never-reuse — so a materialized
 *  counter never drops back out). */
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
  const nextBlock = Math.max(history.next_block_sequence ?? 1, input.nextBlockSequence ?? 1);
  const nextXref = Math.max(history.next_xref_sequence ?? 1, input.nextXrefSequence ?? 1);
  const nextConstraint = Math.max(history.next_constraint_sequence ?? 1, input.nextConstraintSequence ?? 1);
  const nextLayout = Math.max(history.next_layout_sequence ?? 1, input.nextLayoutSequence ?? 1);
  const nextViewport = Math.max(history.next_viewport_sequence ?? 1, input.nextViewportSequence ?? 1);
  const nextUcs = Math.max(history.next_ucs_sequence ?? 1, input.nextUcsSequence ?? 1);
  const nextSectionPlane = Math.max(history.next_section_plane_sequence ?? 1, input.nextSectionPlaneSequence ?? 1);
  return deepFreeze({
    entity_id: history.entity_id,
    format: history.format,
    formatVersion: history.formatVersion,
    base: history.base,
    next_element_sequence: Math.max(history.next_element_sequence, input.nextElementSequence),
    next_layer_sequence: Math.max(history.next_layer_sequence ?? 1, input.nextLayerSequence),
    next_view_sequence: Math.max(history.next_view_sequence ?? 1, input.nextViewSequence),
    next_sheet_sequence: Math.max(history.next_sheet_sequence ?? 1, input.nextSheetSequence),
    next_ifc_import_sequence: Math.max(history.next_ifc_import_sequence ?? 1, input.nextIfcImportSequence ?? 1),
    ...(nextBlock > 1 ? { next_block_sequence: nextBlock } : {}),
    ...(nextXref > 1 ? { next_xref_sequence: nextXref } : {}),
    ...(nextConstraint > 1 ? { next_constraint_sequence: nextConstraint } : {}),
    ...(nextLayout > 1 ? { next_layout_sequence: nextLayout } : {}),
    ...(nextViewport > 1 ? { next_viewport_sequence: nextViewport } : {}),
    ...(nextUcs > 1 ? { next_ucs_sequence: nextUcs } : {}),
    ...(nextSectionPlane > 1 ? { next_section_plane_sequence: nextSectionPlane } : {}),
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
    next_layer_sequence: 1,
    next_view_sequence: 1,
    next_sheet_sequence: 1,
    next_ifc_import_sequence: 1,
    revisions: [],
  });
}

/** Seeded history for an opened snapshot WITHOUT a persisted history
 *  (legacy artifact): the opened state becomes the base (origin "opened").
 *  CAD-PARITY-006: the block/xref counters stay ABSENT until the first
 *  mint (canonical-minimal — legacy-fixture byte-identity). */
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
    next_layer_sequence: 1,
    next_view_sequence: 1,
    next_sheet_sequence: 1,
    next_ifc_import_sequence: 1,
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
 *  semantics; throws on missing operands — no guessed state, LOCK-007).
 *
 *  COMPAT-CAD-001: `applyEdits` batches fold their sub-edits in order;
 *  layer-table edits (addLayer/updateLayer/removeLayer) are element-set
 *  NO-OPS by design — the layer table is snapshot-carried workspace
 *  structure whose lineage lives in the recorded applied edits, and the
 *  replay/verification contract is the ELEMENT content hash. Their operands
 *  are still structurally validated (LOCK-007). */
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
    case "applyEdits": {
      if (edit.edits.length === 0) throw new Error("replay: applyEdits requires at least one sub-edit");
      for (const sub of edit.edits) applyEditToElements(map, sub);
      break;
    }
    case "addLayer": {
      if (edit.layer === undefined) throw new Error("replay: addLayer requires layer");
      break; // layer-table edit: element-set no-op (see doc comment)
    }
    case "updateLayer": {
      if (edit.layerId === undefined) throw new Error("replay: updateLayer requires layerId");
      break; // layer-table edit: element-set no-op
    }
    case "removeLayer": {
      if (edit.layerId === undefined) throw new Error("replay: removeLayer requires layerId");
      break; // layer-table edit: element-set no-op
    }
    case "addView": {
      if (edit.view === undefined) throw new Error("replay: addView requires view");
      break; // view-table edit: element-set no-op (annotations are elements and replay above)
    }
    case "updateView": {
      if (edit.viewId === undefined) throw new Error("replay: updateView requires viewId");
      break; // view-table edit: element-set no-op
    }
    case "removeView": {
      if (edit.viewId === undefined) throw new Error("replay: removeView requires viewId");
      break; // view-table edit: element-set no-op
    }
    case "addSheet": {
      if (edit.sheet === undefined) throw new Error("replay: addSheet requires sheet");
      break; // sheet-table edit: element-set no-op
    }
    case "updateSheet": {
      if (edit.sheetId === undefined) throw new Error("replay: updateSheet requires sheetId");
      break; // sheet-table edit: element-set no-op
    }
    case "removeSheet": {
      if (edit.sheetId === undefined) throw new Error("replay: removeSheet requires sheetId");
      break; // sheet-table edit: element-set no-op
    }
    case "setViewRecord": {
      if (edit.viewId === undefined || edit.view === undefined) throw new Error("replay: setViewRecord requires viewId + view");
      break; // view-table edit: element-set no-op
    }
    case "setSheetRecord": {
      if (edit.sheetId === undefined || edit.sheet === undefined) throw new Error("replay: setSheetRecord requires sheetId + sheet");
      break; // sheet-table edit: element-set no-op
    }
    case "addIfcImport": {
      if (edit.record === undefined) throw new Error("replay: addIfcImport requires record");
      break; // import-record-table edit: element-set no-op
    }
    case "removeIfcImport": {
      if (edit.recordId === undefined) throw new Error("replay: removeIfcImport requires recordId");
      break; // import-record-table edit: element-set no-op
    }
    // CAD-PARITY-004: standards/style-table + layer-state edits are
    // element-set no-ops (the tables replay through the recorded applied
    // edits; the element delta stays empty).
    case "addLtype": {
      if (edit.ltype === undefined) throw new Error("replay: addLtype requires ltype");
      break;
    }
    case "updateLtype": {
      if (edit.ltypeName === undefined) throw new Error("replay: updateLtype requires ltypeName");
      break;
    }
    case "removeLtype": {
      if (edit.ltypeName === undefined) throw new Error("replay: removeLtype requires ltypeName");
      break;
    }
    case "addTextStyle": {
      if (edit.style === undefined) throw new Error("replay: addTextStyle requires style");
      break;
    }
    case "updateTextStyle": {
      if (edit.styleName === undefined) throw new Error("replay: updateTextStyle requires styleName");
      break;
    }
    case "removeTextStyle": {
      if (edit.styleName === undefined) throw new Error("replay: removeTextStyle requires styleName");
      break;
    }
    case "addDimStyle": {
      if (edit.style === undefined) throw new Error("replay: addDimStyle requires style");
      break;
    }
    case "updateDimStyle": {
      if (edit.styleName === undefined) throw new Error("replay: updateDimStyle requires styleName");
      break;
    }
    case "removeDimStyle": {
      if (edit.styleName === undefined) throw new Error("replay: removeDimStyle requires styleName");
      break;
    }
    case "addLayerState": {
      if (edit.state === undefined) throw new Error("replay: addLayerState requires state");
      break; // layer-state-table edit: element-set no-op
    }
    case "removeLayerState": {
      if (edit.stateName === undefined) throw new Error("replay: removeLayerState requires stateName");
      break; // layer-state-table edit: element-set no-op
    }
    // CAD-PARITY-006: block-definition + xref table edits are element-set
    // no-ops (the tables replay through the recorded applied edits; the
    // element delta stays empty — the layer/ltype precedent).
    case "addBlockDef": {
      if (edit.block === undefined) throw new Error("replay: addBlockDef requires block");
      break;
    }
    case "updateBlockDef": {
      if (edit.blockId === undefined) throw new Error("replay: updateBlockDef requires blockId");
      break;
    }
    case "setBlockDefRecord": {
      if (edit.blockId === undefined || edit.block === undefined) throw new Error("replay: setBlockDefRecord requires blockId + block");
      break;
    }
    case "removeBlockDef": {
      if (edit.blockId === undefined) throw new Error("replay: removeBlockDef requires blockId");
      break;
    }
    case "addXref": {
      if (edit.xref === undefined) throw new Error("replay: addXref requires xref");
      break;
    }
    case "updateXref": {
      if (edit.xrefId === undefined) throw new Error("replay: updateXref requires xrefId");
      break;
    }
    case "setXrefRecord": {
      if (edit.xrefId === undefined || edit.xref === undefined) throw new Error("replay: setXrefRecord requires xrefId + xref");
      break;
    }
    case "removeXref": {
      if (edit.xrefId === undefined) throw new Error("replay: removeXref requires xrefId");
      break;
    }
    // CAD-PARITY-007: constraint-table edits are element-set no-ops (the
    // table replays through the recorded applied edits; the element delta
    // stays empty — the block/xref precedent).
    case "addConstraint": {
      if (edit.constraint === undefined) throw new Error("replay: addConstraint requires constraint");
      break;
    }
    case "updateConstraint": {
      if (edit.constraintId === undefined) throw new Error("replay: updateConstraint requires constraintId");
      break;
    }
    case "setConstraintRecord": {
      if (edit.constraintId === undefined || edit.constraint === undefined) {
        throw new Error("replay: setConstraintRecord requires constraintId + constraint");
      }
      break;
    }
    case "removeConstraint": {
      if (edit.constraintId === undefined) throw new Error("replay: removeConstraint requires constraintId");
      break;
    }
    // CAD-PARITY-008: layout/viewport-table edits are element-set no-ops
    // (the table replays through the recorded applied edits; the element
    // delta stays empty — the constraint precedent).
    case "addLayout": {
      if (edit.layout === undefined) throw new Error("replay: addLayout requires layout");
      break;
    }
    case "updateLayout": {
      if (edit.layoutId === undefined) throw new Error("replay: updateLayout requires layoutId");
      break;
    }
    case "setLayoutRecord": {
      if (edit.layoutId === undefined || edit.layout === undefined) {
        throw new Error("replay: setLayoutRecord requires layoutId + layout");
      }
      break;
    }
    case "removeLayout": {
      if (edit.layoutId === undefined) throw new Error("replay: removeLayout requires layoutId");
      break;
    }
    case "addViewport": {
      if (edit.viewport === undefined) throw new Error("replay: addViewport requires viewport");
      break;
    }
    case "updateViewport": {
      if (edit.viewportId === undefined) throw new Error("replay: updateViewport requires viewportId");
      break;
    }
    case "setViewportRecord": {
      if (edit.viewportId === undefined || edit.viewport === undefined) {
        throw new Error("replay: setViewportRecord requires viewportId + viewport");
      }
      break;
    }
    case "removeViewport": {
      if (edit.viewportId === undefined) throw new Error("replay: removeViewport requires viewportId");
      break;
    }
    // CAD-PARITY-009: UCS-/section-plane-table edits are element-set no-ops
    // (the tables replay through the recorded applied edits; the element
    // delta stays empty — the layout-table precedent).
    case "addUcs": {
      if (edit.ucs === undefined) throw new Error("replay: addUcs requires ucs");
      break;
    }
    case "updateUcs": {
      if (edit.ucsId === undefined) throw new Error("replay: updateUcs requires ucsId");
      break;
    }
    case "setUcsRecord": {
      if (edit.ucsId === undefined || edit.ucs === undefined) {
        throw new Error("replay: setUcsRecord requires ucsId + ucs");
      }
      break;
    }
    case "removeUcs": {
      if (edit.ucsId === undefined) throw new Error("replay: removeUcs requires ucsId");
      break;
    }
    case "addSectionPlane": {
      if (edit.sectionPlane === undefined) throw new Error("replay: addSectionPlane requires sectionPlane");
      break;
    }
    case "updateSectionPlane": {
      if (edit.sectionPlaneId === undefined) throw new Error("replay: updateSectionPlane requires sectionPlaneId");
      break;
    }
    case "setSectionPlaneRecord": {
      if (edit.sectionPlaneId === undefined || edit.sectionPlane === undefined) {
        throw new Error("replay: setSectionPlaneRecord requires sectionPlaneId + sectionPlane");
      }
      break;
    }
    case "removeSectionPlane": {
      if (edit.sectionPlaneId === undefined) throw new Error("replay: removeSectionPlane requires sectionPlaneId");
      break;
    }
    default: {
      const _exhaustive = edit satisfies never;
      throw new Error(`replay: unreachable edit type: ${JSON.stringify(_exhaustive)}`);
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
  // COMPAT-CAD-001/003 additive edit types share the structural contract.
  if (
    v.type !== "addElement" && v.type !== "removeElement" && v.type !== "updateElement" &&
    v.type !== "setProps" && v.type !== "applyEdits" &&
    v.type !== "addLayer" && v.type !== "updateLayer" && v.type !== "removeLayer" &&
    v.type !== "addView" && v.type !== "updateView" && v.type !== "removeView" &&
    v.type !== "addSheet" && v.type !== "updateSheet" && v.type !== "removeSheet" &&
    v.type !== "setViewRecord" && v.type !== "setSheetRecord" &&
    v.type !== "addIfcImport" && v.type !== "removeIfcImport" &&
    // CAD-PARITY-004 additive edit types (name-keyed tables + layer states).
    v.type !== "addLtype" && v.type !== "updateLtype" && v.type !== "removeLtype" &&
    v.type !== "addTextStyle" && v.type !== "updateTextStyle" && v.type !== "removeTextStyle" &&
    v.type !== "addDimStyle" && v.type !== "updateDimStyle" && v.type !== "removeDimStyle" &&
    v.type !== "addLayerState" && v.type !== "removeLayerState" &&
    // CAD-PARITY-006 additive edit types (block definitions + xrefs).
    v.type !== "addBlockDef" && v.type !== "updateBlockDef" && v.type !== "removeBlockDef" &&
    v.type !== "setBlockDefRecord" &&
    v.type !== "addXref" && v.type !== "updateXref" && v.type !== "removeXref" &&
    v.type !== "setXrefRecord" &&
    // CAD-PARITY-007 additive edit types (the parametric constraint table).
    v.type !== "addConstraint" && v.type !== "updateConstraint" && v.type !== "removeConstraint" &&
    v.type !== "setConstraintRecord" &&
    // CAD-PARITY-008 additive edit types (the layout + viewport tables).
    v.type !== "addLayout" && v.type !== "updateLayout" && v.type !== "removeLayout" &&
    v.type !== "setLayoutRecord" &&
    v.type !== "addViewport" && v.type !== "updateViewport" && v.type !== "removeViewport" &&
    v.type !== "setViewportRecord" &&
    // CAD-PARITY-009 additive edit types (the UCS + section-plane tables).
    v.type !== "addUcs" && v.type !== "updateUcs" && v.type !== "removeUcs" &&
    v.type !== "setUcsRecord" &&
    v.type !== "addSectionPlane" && v.type !== "updateSectionPlane" && v.type !== "removeSectionPlane" &&
    v.type !== "setSectionPlaneRecord"
  ) {
    return false;
  }
  if (v.elementId !== undefined && typeof v.elementId !== "string") return false;
  if (v.element !== undefined && !isPlainObject(v.element)) return false;
  if (v.patch !== undefined && !isPlainObject(v.patch)) return false;
  // CAD-PARITY-009: the UCS + section-plane record shapes (structural —
  // semantic validation runs at the document boundary through the shared
  // grammar).
  if (v.type === "addUcs" || v.type === "setUcsRecord") {
    if (!isPlainObject(v.ucs)) return false;
    const u = v.ucs as Record<string, unknown>;
    return typeof u.id === "string" && u.id.length > 0 && typeof u.name === "string";
  }
  if (v.type === "updateUcs" || v.type === "removeUcs") {
    return typeof v.ucsId === "string" && v.ucsId.length > 0;
  }
  if (v.type === "addSectionPlane" || v.type === "setSectionPlaneRecord") {
    if (!isPlainObject(v.sectionPlane)) return false;
    const sp = v.sectionPlane as Record<string, unknown>;
    return typeof sp.id === "string" && sp.id.length > 0 && typeof sp.name === "string";
  }
  if (v.type === "updateSectionPlane" || v.type === "removeSectionPlane") {
    return typeof v.sectionPlaneId === "string" && v.sectionPlaneId.length > 0;
  }
  if (v.type === "applyEdits") {
    return Array.isArray(v.edits) && v.edits.length > 0 && v.edits.every((sub) => isValidDocumentEdit(sub));
  }
  if (v.type === "addLayer") {
    if (!isPlainObject(v.layer)) return false;
    const l = v.layer as Record<string, unknown>;
    return (
      typeof l.id === "string" && l.id.length > 0 &&
      typeof l.name === "string" && typeof l.color === "string" && typeof l.visible === "boolean"
    );
  }
  if (v.type === "updateLayer" || v.type === "removeLayer") {
    return typeof v.layerId === "string" && v.layerId.length > 0;
  }
  // CAD-PARITY-004: the name-keyed standards/style/state edits.
  if (v.type === "addLtype" || v.type === "addTextStyle" || v.type === "addDimStyle" || v.type === "addLayerState") {
    const record = (v.ltype ?? v.style ?? v.state) as unknown;
    return isPlainObject(record) && typeof (record as Record<string, unknown>).name === "string";
  }
  if (
    v.type === "updateLtype" || v.type === "removeLtype" ||
    v.type === "updateTextStyle" || v.type === "removeTextStyle" ||
    v.type === "updateDimStyle" || v.type === "removeDimStyle" ||
    v.type === "removeLayerState"
  ) {
    return (
      (v.ltypeName === undefined || typeof v.ltypeName === "string") &&
      (v.styleName === undefined || typeof v.styleName === "string") &&
      (v.stateName === undefined || typeof v.stateName === "string")
    );
  }
  if (v.type === "addView") {
    if (!isPlainObject(v.view)) return false;
    const w = v.view as Record<string, unknown>;
    return typeof w.id === "string" && w.id.length > 0 && typeof w.kind === "string" && typeof w.title === "string";
  }
  if (v.type === "updateView" || v.type === "removeView") {
    return typeof v.viewId === "string" && v.viewId.length > 0;
  }
  if (v.type === "addSheet") {
    if (!isPlainObject(v.sheet)) return false;
    const sh = v.sheet as Record<string, unknown>;
    return typeof sh.id === "string" && sh.id.length > 0 && typeof sh.title === "string" && Array.isArray(sh.viewPlacements);
  }
  if (v.type === "updateSheet" || v.type === "removeSheet") {
    return typeof v.sheetId === "string" && v.sheetId.length > 0;
  }
  if (v.type === "addIfcImport") {
    return isPlainObject(v.record) && typeof (v.record as Record<string, unknown>).sourceHash === "string";
  }
  if (v.type === "removeIfcImport") {
    return typeof v.recordId === "string" && v.recordId.length > 0;
  }
  if (v.type === "setViewRecord") {
    if (!isPlainObject(v.view)) return false;
    const w = v.view as Record<string, unknown>;
    return typeof v.viewId === "string" && v.viewId.length > 0 &&
      typeof w.id === "string" && w.id.length > 0 && typeof w.kind === "string" && typeof w.title === "string";
  }
  if (v.type === "setSheetRecord") {
    if (!isPlainObject(v.sheet)) return false;
    const sh = v.sheet as Record<string, unknown>;
    return typeof v.sheetId === "string" && v.sheetId.length > 0 &&
      typeof sh.id === "string" && sh.id.length > 0 && typeof sh.title === "string" && Array.isArray(sh.viewPlacements);
  }
  // CAD-PARITY-006: the block-definition + xref record shapes.
  if (v.type === "addBlockDef" || v.type === "setBlockDefRecord") {
    if (!isPlainObject(v.block)) return false;
    const b = v.block as Record<string, unknown>;
    return typeof b.id === "string" && b.id.length > 0 && typeof b.name === "string" && Array.isArray(b.entities);
  }
  if (v.type === "updateBlockDef" || v.type === "removeBlockDef") {
    return typeof v.blockId === "string" && v.blockId.length > 0;
  }
  if (v.type === "addXref" || v.type === "setXrefRecord") {
    if (!isPlainObject(v.xref)) return false;
    const x = v.xref as Record<string, unknown>;
    return typeof x.id === "string" && x.id.length > 0 && typeof x.name === "string" && typeof x.path === "string";
  }
  if (v.type === "updateXref" || v.type === "removeXref") {
    return typeof v.xrefId === "string" && v.xrefId.length > 0;
  }
  // CAD-PARITY-007: the constraint record shapes.
  if (v.type === "addConstraint" || v.type === "setConstraintRecord") {
    if (!isPlainObject(v.constraint)) return false;
    const c = v.constraint as Record<string, unknown>;
    return typeof c.id === "string" && c.id.length > 0 && typeof c.kind === "string" && Array.isArray(c.targets);
  }
  if (v.type === "updateConstraint" || v.type === "removeConstraint") {
    return typeof v.constraintId === "string" && v.constraintId.length > 0;
  }
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
  if (
    history.next_layer_sequence !== undefined &&
    (typeof history.next_layer_sequence !== "number" ||
      !Number.isInteger(history.next_layer_sequence) ||
      history.next_layer_sequence < 1)
  ) {
    throw new Error("modelHistory.next_layer_sequence must be a positive integer when present");
  }
  if (
    history.next_view_sequence !== undefined &&
    (typeof history.next_view_sequence !== "number" ||
      !Number.isInteger(history.next_view_sequence) ||
      history.next_view_sequence < 1)
  ) {
    throw new Error("modelHistory.next_view_sequence must be a positive integer when present");
  }
  if (
    history.next_sheet_sequence !== undefined &&
    (typeof history.next_sheet_sequence !== "number" ||
      !Number.isInteger(history.next_sheet_sequence) ||
      history.next_sheet_sequence < 1)
  ) {
    throw new Error("modelHistory.next_sheet_sequence must be a positive integer when present");
  }
  if (
    history.next_ifc_import_sequence !== undefined &&
    (typeof history.next_ifc_import_sequence !== "number" ||
      !Number.isInteger(history.next_ifc_import_sequence) ||
      history.next_ifc_import_sequence < 1)
  ) {
    throw new Error("modelHistory.next_ifc_import_sequence must be a positive integer when present");
  }
  if (
    history.next_block_sequence !== undefined &&
    (typeof history.next_block_sequence !== "number" ||
      !Number.isInteger(history.next_block_sequence) ||
      history.next_block_sequence < 1)
  ) {
    throw new Error("modelHistory.next_block_sequence must be a positive integer when present");
  }
  if (
    history.next_xref_sequence !== undefined &&
    (typeof history.next_xref_sequence !== "number" ||
      !Number.isInteger(history.next_xref_sequence) ||
      history.next_xref_sequence < 1)
  ) {
    throw new Error("modelHistory.next_xref_sequence must be a positive integer when present");
  }
  if (
    history.next_constraint_sequence !== undefined &&
    (typeof history.next_constraint_sequence !== "number" ||
      !Number.isInteger(history.next_constraint_sequence) ||
      history.next_constraint_sequence < 1)
  ) {
    throw new Error("modelHistory.next_constraint_sequence must be a positive integer when present");
  }
  if (
    history.next_layout_sequence !== undefined &&
    (typeof history.next_layout_sequence !== "number" ||
      !Number.isInteger(history.next_layout_sequence) ||
      history.next_layout_sequence < 1)
  ) {
    throw new Error("modelHistory.next_layout_sequence must be a positive integer when present");
  }
  if (
    history.next_viewport_sequence !== undefined &&
    (typeof history.next_viewport_sequence !== "number" ||
      !Number.isInteger(history.next_viewport_sequence) ||
      history.next_viewport_sequence < 1)
  ) {
    throw new Error("modelHistory.next_viewport_sequence must be a positive integer when present");
  }
  if (
    history.next_ucs_sequence !== undefined &&
    (typeof history.next_ucs_sequence !== "number" ||
      !Number.isInteger(history.next_ucs_sequence) ||
      history.next_ucs_sequence < 1)
  ) {
    throw new Error("modelHistory.next_ucs_sequence must be a positive integer when present");
  }
  if (
    history.next_section_plane_sequence !== undefined &&
    (typeof history.next_section_plane_sequence !== "number" ||
      !Number.isInteger(history.next_section_plane_sequence) ||
      history.next_section_plane_sequence < 1)
  ) {
    throw new Error("modelHistory.next_section_plane_sequence must be a positive integer when present");
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
