/**
 * CADDocument model (§5.4, data-model.md §2, LOCK-019).
 *
 * Exports the editor's canonical working representation: versioned document
 * transactions, canonical serialization, undo/redo semantics, source
 * provenance and — since CAD-IMPLEMENT-003 — the immutable model revision
 * history + deterministic replay. CADDocument identity is editor/file
 * identity, NOT Construction Graph identity (LOCK-019).
 */

export { CADDocument } from "./document.js";
export { rootVersion, childVersion, makeVersionId, describeChain } from "./versioning.js";
export {
  serialize,
  deserialize,
  canonicalHash,
  canonicalStringify,
  roundTripPreservesHash,
} from "./serialization.js";
export {
  HISTORY_NOW,
  appendRevision,
  applyEditToElements,
  baseContentHash,
  canonicalHashOf,
  cloneHistory,
  contentHashOf,
  createdHistory,
  deepFreeze,
  deriveElementSequence,
  diffElements,
  historyHash,
  makeRevisionId,
  openedHistory,
  replayHistoryTo,
  validateHistoryLinkage,
  validateModelHistory,
  verifiedReplay,
} from "./history.js";
// COMPAT-CAD-001: drafting workspace state (layers + settings).
export {
  DEFAULT_LAYER,
  DEFAULT_LAYER_ID,
  SNAP_KIND_PRIORITY,
  canonicalSnapKinds,
  defaultDraftingSettings,
  deriveLayerSequence,
  validateDraftingSettings,
  validateLayerRecord,
} from "./workspace.js";
