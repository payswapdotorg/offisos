/**
 * CAD-PARITY-006 blocks/reuse subsystem barrel (Issue #84).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). Both hosts and the
 * App API layer import through this barrel — the ONE shared semantic core
 * for block definitions, instances, attributes, expansion and external
 * references (LOCK-004 Web/Electron parity).
 */

export {
  BlockError,
  MAX_BLOCK_NESTING_DEPTH,
  XREF_PLACEHOLDER_SIZE,
  validAttributeTag,
  makeBlockRef,
  makeXrefRef,
  makeAttdef,
  isBlockRefElement,
  isXrefRefElement,
  blockRefToProps,
  xrefRefToProps,
  elementToBlockRef,
  elementToXrefRef,
  blockRefFromElement,
  xrefRefFromElement,
  normalizeBlockEntity,
  normalizeBlockEntities,
  referencedBlockIds,
  assertDefinitionGraph,
  attdefTagsOf,
  attributeValue,
  normalizedRotation,
  blockPtOf,
} from "./types.js";
export type {
  AttributeValue,
  BlockRefView,
  XrefRefView,
  AttdefRecord,
} from "./types.js";

export {
  IDENTITY_SIM,
  simFromPlacement,
  applySim,
  composeSim,
  transformGeomBySim,
  expandBlockInstance,
  expandXrefInstance,
  expandInstanceElement,
  explodeBlockInstance,
  expandedBounds,
} from "./expand.js";
export type {
  Sim2,
  ExpandedEntity,
  ExplodedPiece,
  BlockTable,
} from "./expand.js";
