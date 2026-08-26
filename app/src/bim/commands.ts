/**
 * BIM command support (COMPAT-CAD-002) — the bridge between the App API
 * handlers and the pure BIM core, mirroring the drafting commands precedent
 * (COMPAT-CAD-001). Everything here is engine-free (LOCK-018).
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import {
  bimEntityToElement,
  elementToBimEntity,
  isBimElement,
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  type BimEntity,
  type OpeningEntity,
  type WallEntity,
} from "./elements.js";
import { assertOpeningFits } from "./editops.js";

export { moveBimElements, copyBimElements, deleteBimElements, setBimProperties } from "./editops.js";
export type { BimEditOutcome } from "./editops.js";

/** Soft parse: a BIM entity, or null for non-BIM elements. */
export function elementToBimEntityOrNull(el: Element): BimEntity | null {
  if (!isBimElement(el)) return null;
  try {
    return elementToBimEntity(el);
  } catch {
    return null;
  }
}

export interface BimCreateOutcome {
  /** ONE atomic batch (single versioned command). */
  readonly edit: DocumentEdit;
  /** Explicit ids requested by the caller (must not collide — the document
   *  enforces that on apply). */
  readonly explicitIds: readonly string[];
}

/** Build the atomic create batch for `bim.createElements`.
 *
 *  Validation order (deterministic, LOCK-007 — the FIRST failure wins):
 *   1. every entity input is validated by its strict constructor;
 *   2. storyId references resolve against the existing document elements
 *      UNION the earlier entities of this same batch (creation order defines
 *      reference order);
 *   3. opening hostId references resolve to a wall (existing or earlier in
 *      the batch) and the opening FITS the host (distance+width ≤ length,
 *      sill+height ≤ wall height);
 *   4. door/window openingId references resolve to an opening (existing or
 *      earlier in the batch); their storyId is DERIVED from the opening's
 *      host wall chain (an explicit storyId input is ignored — derived state
 *      is never trusted, LOCK-007).
 *
 *  Ids are minted by the DOCUMENT on apply (addElement with an empty id) so
 *  canonical identity stays a document authority (§5.4). */
export function buildBimCreate(
  existing: readonly Element[],
  inputs: readonly unknown[],
): BimCreateOutcome {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("bim.createElements requires a non-empty entities array");
  }
  const known = new Map<string, Element>(existing.map((el) => [el.id, el] as const));
  const knownEntities = new Map<string, BimEntity>();
  for (const el of existing) {
    const entity = elementToBimEntityOrNull(el);
    if (entity !== null) knownEntities.set(el.id, entity);
  }
  const edits: DocumentEdit[] = [];
  const explicitIds: string[] = [];

  const resolveEntity = (id: string): BimEntity => {
    const entity = knownEntities.get(id);
    if (entity === undefined) {
      throw new Error(`element '${id}' does not exist (neither in the document nor earlier in this batch)`);
    }
    return entity;
  };

  for (const [index, raw] of inputs.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`entities[${index}] must be an object`);
    }
    const input = raw as Record<string, unknown>;
    const type = input.type;
    let entity: BimEntity;
    switch (type) {
      case "bim.story": {
        entity = withId(makeStory(input), input.id);
        break;
      }
      case "bim.wall": {
        const wall = withId(makeWall(input), input.id);
        resolveStory(wall.storyId, index);
        entity = wall;
        break;
      }
      case "bim.slab": {
        const slab = withId(makeSlab(input), input.id);
        resolveStory(slab.storyId, index);
        entity = slab;
        break;
      }
      case "bim.space": {
        const space = withId(makeSpace(input), input.id);
        resolveStory(space.storyId, index);
        entity = space;
        break;
      }
      case "bim.opening": {
        const opening = withId(makeOpening(input), input.id);
        const host = resolveEntity(opening.hostId);
        if (host.type !== "bim.wall") {
          throw new Error(`entities[${index}]: opening.hostId '${opening.hostId}' must reference a wall (got '${host.type}')`);
        }
        assertOpeningFits(opening as OpeningEntity, host as WallEntity);
        entity = opening;
        break;
      }
      case "bim.door": {
        // openingId resolved FIRST (raw), then storyId DERIVED from the host
        // wall chain — never trusted from input (LOCK-007).
        const rawOpeningId = requireRawId(input.openingId, index, "door.openingId");
        const chain = resolveOpeningChain(rawOpeningId, index);
        const door = withId(
          makeDoor({ ...input, storyId: chain.wall.storyId, openingId: rawOpeningId }),
          input.id,
        );
        entity = door;
        break;
      }
      case "bim.window": {
        const rawOpeningId = requireRawId(input.openingId, index, "window.openingId");
        const chain = resolveOpeningChain(rawOpeningId, index);
        entity = withId(makeWindow({ ...input, storyId: chain.wall.storyId, openingId: rawOpeningId }), input.id);
        break;
      }
      default:
        throw new Error(`entities[${index}]: unknown BIM element type ${JSON.stringify(type)}`);
    }
    if (entity.id.length > 0) {
      if (known.has(entity.id)) {
        throw new Error(`entities[${index}]: element id '${entity.id}' already exists`);
      }
      known.set(entity.id, bimEntityToElement(entity));
      knownEntities.set(entity.id, entity);
      explicitIds.push(entity.id);
    }
    // Note: same-batch references require an EXPLICIT id on the referenced
    // entity (document-minted identities only exist after apply — callers
    // cannot know them in advance, so referencing them is impossible by
    // construction; the drafting batch precedent has the same contract).
    edits.push({ type: "addElement", element: bimEntityToElement(entity) });
  }

  return { edit: { type: "applyEdits", edits }, explicitIds };

  function resolveStory(storyId: string, index: number): void {
    const story = resolveEntity(storyId);
    if (story.type !== "bim.story") {
      throw new Error(`entities[${index}]: storyId '${storyId}' must reference a story (got '${story.type}')`);
    }
  }

  function resolveOpeningChain(openingId: string, index: number): { wall: WallEntity } {
    const opening = resolveEntity(openingId);
    if (opening.type !== "bim.opening") {
      throw new Error(`entities[${index}]: openingId '${openingId}' must reference an opening (got '${opening.type}')`);
    }
    const wall = resolveEntity(opening.hostId);
    if (wall.type !== "bim.wall") {
      throw new Error(`entities[${index}]: opening '${openingId}' host '${opening.hostId}' is not a wall (inconsistent stored props)`);
    }
    return { wall: wall as WallEntity };
  }
}

function withId<T extends object>(entity: T, id: unknown): T & { id: string } {
  const resolved = typeof id === "string" && id.length > 0 ? id : "";
  return { ...entity, id: resolved };
}

/** Raw non-empty id extraction with the batch index in the error message. */
function requireRawId(value: unknown, index: number, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`entities[${index}]: ${path} must be a non-empty element id`);
  }
  return value;
}
