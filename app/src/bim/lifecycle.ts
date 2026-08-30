/**
 * BIM lifecycle + classification edit builders (CAD-PARITY-011, Issue #97).
 *
 * The dedicated command surface for the cross-cutting meta overlay — the
 * structured semantic edits that are NOT per-type property patches:
 *
 *   - setBimClassification   — the canonical classification reference
 *                              (set or clear; validated against the closed
 *                              table + the element type);
 *   - setBimPropertySets    — replace the structured property sets wholesale
 *                              (atomic, validated: canonical keys, typed
 *                              values, bounded counts);
 *   - setBimRenovation      — the bounded renovation lifecycle state
 *                              (existing | new | to-be-demolished; eligible
 *                              element types only);
 *   - setBimOptionMembership— design-option membership (set/clear the
 *                              (group, option) pair; the group registry and
 *                              vocabulary are validated);
 *   - setBimActiveOption    — the active option of a group (∈ its options).
 *
 * Every builder resolves against the current document elements, validates
 * deterministically (first failure wins — LOCK-007), and returns ONE atomic
 * updateElement batch carrying the merged canonical meta overlay (one
 * versioned command, one revision, one undo entry — the editops precedent).
 * The element's canonical identity never changes: lifecycle edits are
 * versioned STATE edits, never destructive duplication.
 *
 * Engine-free semantic modeling (LOCK-018).
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import { elementToBimEntitySafe, type BimEntity } from "./elements.js";
import {
  BIM_RENOVATION_ELIGIBLE,
  BIM_RENOVATION_STATES,
  validateBimMeta,
  validatePropertySets,
  type BimElementMeta,
  type BimRenovationStatus,
} from "./meta.js";
import { assertOptionMembership } from "./relationships.js";

export type BimLifecycleOutcome =
  | { readonly status: "applied"; readonly edit: DocumentEdit; readonly summary: string; readonly meta: BimElementMeta | undefined }
  | { readonly status: "no-op"; readonly reason: string };

function bimEntities(elements: readonly Element[]): Map<string, BimEntity> {
  const map = new Map<string, BimEntity>();
  for (const el of elements) {
    const entity = elementToBimEntitySafe(el);
    if (entity !== null) map.set(el.id, entity);
  }
  return map;
}

function requireBimEntity(map: ReadonlyMap<string, BimEntity>, id: string, op: string): BimEntity {
  const entity = map.get(id);
  if (entity === undefined) {
    throw new Error(`${op}: element '${id}' does not exist or is not a BIM element`);
  }
  return entity;
}

/** The stored meta overlay of an entity (or undefined). */
function storedMeta(entity: BimEntity): BimElementMeta | undefined {
  return entity.meta;
}

/** Validate the merged overlay against the element type and rebuild the
 *  canonical element patch carrying it (the props layout keeps the single
 *  canonical "meta" key; absent when empty). */
function metaPatch(entity: BimEntity, meta: BimElementMeta | undefined): Record<string, unknown> {
  // Round-trip through the strict validator — the merged overlay must be
  // structurally canonical for THIS element type (LOCK-007).
  const validated = validateBimMeta(entity.type, meta, "meta");
  return validated === undefined ? {} : { meta: validated };
}

/** The generic single-element meta edit: merge the stored overlay with the
 *  patch function, validate, return the atomic update batch. */
function editMeta(
  elements: readonly Element[],
  elementId: string,
  op: string,
  patchMeta: (meta: BimElementMeta | undefined) => BimElementMeta | undefined,
  summary: (entity: BimEntity, before: BimElementMeta | undefined) => string,
): BimLifecycleOutcome {
  const map = bimEntities(elements);
  const entity = requireBimEntity(map, elementId, op);
  const before = storedMeta(entity);
  const after = patchMeta(before);
  const patch = metaPatch(entity, after);
  if (before === undefined && after === undefined) {
    return { status: "no-op", reason: `${op}: element '${elementId}' carries no meta overlay to edit` };
  }
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return { status: "no-op", reason: `${op}: element '${elementId}' already carries the requested state` };
  }
  return {
    status: "applied",
    edit: { type: "updateElement", elementId, patch },
    summary: summary(entity, before),
    meta: after,
  };
}

/** bim.setClassification — set (or clear with null) the canonical
 *  classification reference. The code must exist in the closed table AND
 *  apply to the element's type. */
export function setBimClassification(
  elements: readonly Element[],
  elementId: string,
  classificationRef: string | null,
): BimLifecycleOutcome {
  return editMeta(
    elements,
    elementId,
    "setClassification",
    (meta) => {
      const next: Record<string, unknown> = { ...(meta ?? {}) };
      if (classificationRef === null) delete next.classificationRef;
      else next.classificationRef = classificationRef;
      return Object.keys(next).length > 0 ? (next as BimElementMeta) : undefined;
    },
    (entity) =>
      classificationRef === null
        ? `cleared the classification of ${entity.type} '${elementId}'`
        : `classified ${entity.type} '${elementId}' as '${classificationRef}'`,
  );
}

/** bim.setPropertySets — replace the structured property sets wholesale
 *  (validated: canonical names/keys, typed values, bounded counts; [] clears
 *  them). Insertion order is the canonical order. */
export function setBimPropertySets(
  elements: readonly Element[],
  elementId: string,
  propertySets: unknown,
): BimLifecycleOutcome {
  const map = bimEntities(elements);
  const entity = requireBimEntity(map, elementId, "setPropertySets");
  // Validate the incoming structure FIRST (independent of the element) so a
  // malformed payload is a structural rejection.
  const sets = validatePropertySets(propertySets, "propertySets");
  return editMeta(
    elements,
    elementId,
    "setPropertySets",
    (meta) => {
      const next: Record<string, unknown> = { ...(meta ?? {}) };
      if (sets.length === 0) delete next.propertySets;
      else next.propertySets = sets;
      return Object.keys(next).length > 0 ? (next as BimElementMeta) : undefined;
    },
    () =>
      sets.length === 0
        ? `cleared the property sets of ${entity.type} '${elementId}'`
        : `set ${sets.length} property set(s) (${sets.map((s) => s.name).join(", ")}) on ${entity.type} '${elementId}'`,
  );
}

/** bim.setRenovation — set the bounded renovation lifecycle state. Eligible
 *  element types only (building/spatial content); the canonical states are
 *  the closed three-state vocabulary. */
export function setBimRenovation(
  elements: readonly Element[],
  elementId: string,
  status: unknown,
): BimLifecycleOutcome {
  if (typeof status !== "string" || !(BIM_RENOVATION_STATES as readonly string[]).includes(status)) {
    throw new Error(`setRenovation: status must be one of ${BIM_RENOVATION_STATES.join(" | ")} (got ${JSON.stringify(status)})`);
  }
  const map = bimEntities(elements);
  const entity = requireBimEntity(map, elementId, "setRenovation");
  if (!BIM_RENOVATION_ELIGIBLE.includes(entity.type)) {
    throw new Error(
      `setRenovation: renovation status is not supported on ${entity.type} elements (supported types: ${BIM_RENOVATION_ELIGIBLE.join(", ")})`,
    );
  }
  const renovationStatus = status as BimRenovationStatus;
  return editMeta(
    elements,
    elementId,
    "setRenovation",
    (meta) => {
      const next: Record<string, unknown> = { ...(meta ?? {}) };
      // "existing" is the derived default — storing it would be redundant
      // state; the canonical form OMITS it (pre-P011 documents stay
      // byte-identical; the effective status derives as "existing").
      if (renovationStatus === "existing") delete next.renovationStatus;
      else next.renovationStatus = renovationStatus;
      return Object.keys(next).length > 0 ? (next as BimElementMeta) : undefined;
    },
    () => `set the renovation status of ${entity.type} '${elementId}' to '${renovationStatus}'`,
  );
}

/** bim.setOptionMembership — set (or clear with a null group) the design
 *  option membership pair. The group must exist and the option must be in
 *  its declared vocabulary. */
export function setBimOptionMembership(
  elements: readonly Element[],
  elementId: string,
  optionGroupId: string | null,
  option: string | null,
): BimLifecycleOutcome {
  const map = bimEntities(elements);
  const entity = requireBimEntity(map, elementId, "setOptionMembership");
  if ((optionGroupId === null) !== (option === null)) {
    throw new Error("setOptionMembership: optionGroupId and option must be set or cleared TOGETHER (a membership is a pair)");
  }
  if (optionGroupId !== null && option !== null) {
    assertOptionMembership(optionGroupId, option, (id) => map.get(id), "setOptionMembership");
  }
  return editMeta(
    elements,
    elementId,
    "setOptionMembership",
    (meta) => {
      const next: Record<string, unknown> = { ...(meta ?? {}) };
      if (optionGroupId === null) {
        delete next.optionGroupId;
        delete next.option;
      } else {
        next.optionGroupId = optionGroupId;
        next.option = option;
      }
      return Object.keys(next).length > 0 ? (next as BimElementMeta) : undefined;
    },
    () =>
      optionGroupId === null
        ? `cleared the design-option membership of ${entity.type} '${elementId}'`
        : `set the design-option membership of ${entity.type} '${elementId}' to group '${optionGroupId}' option '${option}'`,
  );
}

/** bim.setActiveOption — set the ACTIVE option of an option group (must be
 *  one of its declared options). The deterministic active-option behavior:
 *  inactive members are excluded from builds with explicit reasons, never
 *  deleted. */
export function setBimActiveOption(
  elements: readonly Element[],
  optionGroupId: string,
  option: string,
): BimLifecycleOutcome {
  const map = bimEntities(elements);
  const group = requireBimEntity(map, optionGroupId, "setActiveOption");
  if (group.type !== "bim.optionGroup") {
    throw new Error(`setActiveOption: element '${optionGroupId}' is not an option group (got '${group.type}')`);
  }
  if (!group.options.includes(option)) {
    throw new Error(
      `setActiveOption: option '${option}' is not declared by option group '${optionGroupId}' (declared options: ${group.options.join(", ")})`,
    );
  }
  if (group.activeOption === option) {
    return { status: "no-op", reason: `setActiveOption: '${option}' is already the active option of group '${optionGroupId}'` };
  }
  return {
    status: "applied",
    edit: { type: "updateElement", elementId: optionGroupId, patch: { activeOption: option } },
    summary: `set the active option of group '${optionGroupId}' to '${option}'`,
    meta: group.meta,
  };
}
