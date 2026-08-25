/**
 * CADDocument model (§5.4, data-model.md §2, LOCK-019).
 *
 * Exports the editor's canonical working representation: versioned document
 * transactions, canonical serialization, undo/redo semantics and source
 * provenance. CADDocument identity is editor/file identity, NOT Construction
 * Graph identity (LOCK-019).
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
