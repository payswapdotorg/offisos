/**
 * Drafting command support (COMPAT-CAD-001) — the bridge between the App API
 * handlers and the pure drafting core. Everything here is engine-free
 * (LOCK-018): drafting entities, layers, snaps and edit batches are
 * editor-domain state.
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import {
  draftEntityToElement,
  elementToDraftEntity,
  isDraftingElement,
  makeArc,
  makeCircle,
  makeLine,
  makeLinearDimension,
  makePolyline,
  makeRadiusDimension,
  makeRectangle,
  type DraftEntity,
} from "./entities.js";

export { moveEntities, copyEntities, deleteEntities, trimEntity, extendEntity } from "./editops.js";
export type { EditOpOutcome } from "./editops.js";

/** Soft parse: a drafting entity, or null for non-drafting elements. */
export function elementToDraftEntitySafe(el: Element): DraftEntity | null {
  if (!isDraftingElement(el)) return null;
  try {
    return elementToDraftEntity(el);
  } catch {
    return null;
  }
}

export interface DraftingCreateOutcome {
  /** ONE atomic batch (single versioned command). */
  readonly edit: DocumentEdit;
  /** Explicit ids requested by the caller (must not collide — the document
   *  enforces that on apply). */
  readonly explicitIds: readonly string[];
}

/** Build the atomic create batch for `drafting.createEntities`.
 *
 *  Validation order (deterministic, LOCK-007 — the FIRST failure wins):
 *   1. every entity input is validated by its strict constructor;
 *   2. every referenced layer must exist in the document layer table;
 *   3. dim-radius `measured` is (re)computed from the referenced entity —
 *      resolved against the existing document elements UNION the earlier
 *      entities of this same batch (creation order defines reference order).
 *
 *  Ids are minted by the DOCUMENT on apply (addElement with an empty id) so
 *  canonical identity stays a document authority (§5.4). */
export function buildDraftingCreate(
  existing: readonly Element[],
  layerExists: (id: string) => boolean,
  inputs: readonly unknown[],
): DraftingCreateOutcome {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("drafting.createEntities requires a non-empty entities array");
  }
  const known = new Map<string, Element>(existing.map((el) => [el.id, el] as const));
  const edits: DocumentEdit[] = [];
  const explicitIds: string[] = [];

  for (const [index, raw] of inputs.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`entities[${index}] must be an object`);
    }
    const input = raw as Record<string, unknown>;
    const type = input.type;
    let entity: DraftEntity;
    switch (type) {
      case "line":
        entity = withId(makeLine(input), input.id);
        break;
      case "polyline":
        entity = withId(makePolyline(input), input.id);
        break;
      case "circle":
        entity = withId(makeCircle(input), input.id);
        break;
      case "arc":
        entity = withId(makeArc(input), input.id);
        break;
      case "rectangle":
        entity = withId(makeRectangle(input), input.id);
        break;
      case "dim-linear":
        entity = withId(makeLinearDimension(input), input.id);
        break;
      case "dim-radius": {
        const target = input.target;
        const measured = resolveRadiusMeasurement(known, target, index);
        entity = withId(makeRadiusDimension({ ...input, measured }), input.id);
        break;
      }
      default:
        throw new Error(`entities[${index}]: unknown drafting type ${JSON.stringify(type)}`);
    }
    if (!layerExists(entity.layer)) {
      throw new Error(`entities[${index}]: layer '${entity.layer}' does not exist in the document layer table`);
    }
    if (entity.id.length > 0) {
      if (known.has(entity.id)) {
        throw new Error(`entities[${index}]: element id '${entity.id}' already exists`);
      }
      known.set(entity.id, draftEntityToElement(entity));
      explicitIds.push(entity.id);
    }
    edits.push({ type: "addElement", element: draftEntityToElement(entity) });
  }

  return { edit: { type: "applyEdits", edits }, explicitIds };
}

function withId<T extends object>(entity: T, id: unknown): T & { id: string } {
  const resolved = typeof id === "string" && id.length > 0 ? id : "";
  return { ...entity, id: resolved };
}

/** The measured radius for a dim-radius: the referenced circle/arc's radius
 *  — from the existing document or an earlier entity of the same batch. */
function resolveRadiusMeasurement(known: ReadonlyMap<string, Element>, target: unknown, index: number): number {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`entities[${index}]: dim-radius.target must be a non-empty entity id`);
  }
  const el = known.get(target);
  if (el === undefined) {
    throw new Error(
      `entities[${index}]: dim-radius.target '${target}' does not exist (neither in the document nor earlier in this batch)`,
    );
  }
  if (!isDraftingElement(el)) {
    throw new Error(`entities[${index}]: dim-radius.target '${target}' is not a drafting entity`);
  }
  const entity = elementToDraftEntity(el);
  if (entity.type !== "circle" && entity.type !== "arc") {
    throw new Error(`entities[${index}]: dim-radius.target '${target}' must be a circle or arc (got '${entity.type}')`);
  }
  return entity.radius;
}
