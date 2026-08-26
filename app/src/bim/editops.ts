/**
 * BIM editing operations (COMPAT-CAD-002, Issue #39 scope).
 *
 * Pure, engine-free edit-batch builders mirroring the drafting editops
 * precedent (COMPAT-CAD-001): every operation resolves against the current
 * document elements, validates deterministically (LOCK-007: the FIRST failure
 * wins; unsupported operations fail with typed messages — never silently
 * approximated), and returns ONE atomic applyEdits batch (one versioned
 * command, one revision, one undo entry). Ids of new elements are minted by
 * the DOCUMENT on apply.
 *
 * Semantics (documented in the work-item record, asserted in tests):
 *
 *  - move: story → dz only (level shift; plan coordinates are story-local so
 *    hosted geometry follows); wall/slab/space → plan shift (dx, dy) plus
 *    baseOffset shift (dz); opening → ALONG the host wall axis only (the
 *    axis projection of (dx, dy); the cross-axis component must be zero —
 *    typed reject) plus sill shift (dz, still ≥ 0); door/window derive their
 *    geometry from the opening — moving a fill directly is unsupported
 *    (typed reject: move the opening).
 *  - copy: wall/slab/space/opening duplicated and shifted; a wall copy
 *    CASCADE-copies its hosted openings and their fills (a copy without its
 *    hosted voids would not be a faithful duplicate — declared, itemized in
 *    the summary, recorded in the revision delta); an opening copy
 *    cascade-copies its fills; copying fills/stories directly is unsupported.
 *  - delete: plain delete for slab/space/door/window; deleting a wall
 *    cascades its openings + fills; deleting an opening cascades its fills
 *    (a wall deletion leaving orphaned voids would corrupt the model — the
 *    cascade is declared, itemized and recorded, never silent); deleting a
 *    story is REJECTED while hosted elements reference it (removeLayer
 *    precedent: no cascade over semantic containment).
 *  - setProperties: whitelisted per type; the MERGED element is re-validated
 *    through the same constructors (space area recomputed on footprint
 *    changes; opening fit re-checked against the host wall).
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import type { Vec2 } from "../contracts/geometry.js";
import {
  elementToBimEntity,
  elementToBimEntitySafe,
  bimEntityToElement,
  isBimElement,
  makeDoor,
  makeOpening,
  makeSlab,
  makeSpace,
  makeStory,
  makeWall,
  makeWindow,
  type BimEntity,
  type DoorEntity,
  type OpeningEntity,
  type SlabEntity,
  type SpaceEntity,
  type WallEntity,
} from "./elements.js";
import { wallFrame } from "./geometry.js";

/** Result of an edit operation: an atomic batch, or an honest no-op. */
export type BimEditOutcome =
  | { readonly status: "applied"; readonly edit: DocumentEdit; readonly summary: string; readonly createdIds: readonly string[] }
  | { readonly status: "no-op"; readonly reason: string };

// --- Context helpers -----------------------------------------------------------

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

function shift(p: Vec2, dx: number, dy: number): Vec2 {
  return [p[0] + dx, p[1] + dy];
}

/** Rebuild the canonical props for an entity (round-trips through the
 *  element mapping so patches carry the exact canonical layout). */
function entityPatch(entity: BimEntity): Record<string, unknown> {
  const el = bimEntityToElement(entity);
  return { ...(el.props as Record<string, unknown>) };
}

/** Hosted openings of a wall, deterministic order (distance, then id). */
function hostedOpenings(map: ReadonlyMap<string, BimEntity>, wallId: string): OpeningEntity[] {
  const list: OpeningEntity[] = [];
  for (const entity of map.values()) {
    if (entity.type === "bim.opening" && entity.hostId === wallId) list.push(entity);
  }
  list.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.id < b.id ? -1 : 1));
  return list;
}

/** Fills (doors/windows) of an opening, deterministic order (kind, then id). */
function openingFills(map: ReadonlyMap<string, BimEntity>, openingId: string): BimEntity[] {
  const list: BimEntity[] = [];
  for (const entity of map.values()) {
    if ((entity.type === "bim.door" || entity.type === "bim.window") && entity.openingId === openingId) {
      list.push(entity);
    }
  }
  list.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.id < b.id ? -1 : 1));
  return list;
}

// --- Move ----------------------------------------------------------------------

export function moveBimElements(
  elements: readonly Element[],
  ids: readonly string[],
  dx: number,
  dy: number,
  dz: number,
): BimEditOutcome {
  if (ids.length === 0) return { status: "no-op", reason: "move: empty selection" };
  if (dx === 0 && dy === 0 && dz === 0) return { status: "no-op", reason: "move: zero displacement" };
  const map = bimEntities(elements);
  const edits: DocumentEdit[] = [];
  const moved: string[] = [];

  for (const id of ids) {
    const entity = requireBimEntity(map, id, "move");
    switch (entity.type) {
      case "bim.story": {
        if (dx !== 0 || dy !== 0) {
          throw new Error(
            `move: story '${id}' moves in Z only (plan coordinates are story-local) — dx/dy must be 0 (got ${dx}, ${dy})`,
          );
        }
        const shifted = makeStory({ name: entity.name, level: entity.level + dz, height: entity.height });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.wall": {
        const shifted = makeWall({
          storyId: entity.storyId,
          start: shift(entity.start, dx, dy),
          end: shift(entity.end, dx, dy),
          width: entity.width,
          height: entity.height,
          baseOffset: entity.baseOffset + dz,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.slab": {
        const shifted = makeSlab({
          storyId: entity.storyId,
          corner1: shift(entity.corner1, dx, dy),
          corner2: shift(entity.corner2, dx, dy),
          thickness: entity.thickness,
          baseOffset: entity.baseOffset + dz,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.space": {
        const shifted = makeSpace({
          storyId: entity.storyId,
          name: entity.name,
          footprint: entity.footprint.map((p) => shift(p, dx, dy)),
          height: entity.height,
          baseOffset: entity.baseOffset + dz,
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.opening": {
        const host = requireBimEntity(map, entity.hostId, "move");
        if (host.type !== "bim.wall") {
          throw new Error(`move: opening '${id}' host '${entity.hostId}' is not a wall (stored props are inconsistent)`);
        }
        const frame = wallFrame(host);
        const along = dx * frame.u[0] + dy * frame.u[1];
        const cross = dx * frame.n[0] + dy * frame.n[1];
        if (Math.abs(cross) > 1e-9) {
          throw new Error(
            `move: opening '${id}' moves ALONG the host wall axis only — the cross-axis component (${cross.toFixed(12)} mm) must be 0 (unsupported set; no silent approximation)`,
          );
        }
        const newDistance = entity.distance + along;
        const newSill = entity.sill + dz;
        if (newDistance < 0) {
          throw new Error(`move: opening '${id}' would leave the wall start (distance ${newDistance} < 0) — rejected`);
        }
        if (newDistance + entity.width > frame.length) {
          throw new Error(
            `move: opening '${id}' would leave the host wall (distance+width ${newDistance + entity.width} > length ${frame.length}) — rejected`,
          );
        }
        if (newSill < 0) {
          throw new Error(`move: opening '${id}' sill would be negative (${newSill}) — rejected`);
        }
        if (newSill + entity.height > host.height) {
          throw new Error(
            `move: opening '${id}' would exceed the host wall height (sill+height ${newSill + entity.height} > ${host.height}) — rejected`,
          );
        }
        const shifted = makeOpening({
          hostId: entity.hostId,
          distance: newDistance,
          width: entity.width,
          height: entity.height,
          sill: newSill,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.door":
      case "bim.window": {
        throw new Error(
          `move: '${entity.type}' elements derive their geometry from the referenced opening (outside the supported set for direct moves) — move opening '${entity.openingId}' instead`,
        );
      }
    }
  }

  if (edits.length === 0) return { status: "no-op", reason: "move: nothing movable in the selection" };
  return {
    status: "applied",
    edit: { type: "applyEdits", edits },
    summary: `moved ${moved.length} element(s): ${moved.join(", ")}`,
    createdIds: [],
  };
}

// --- Copy ----------------------------------------------------------------------

export function copyBimElements(
  elements: readonly Element[],
  ids: readonly string[],
  dx: number,
  dy: number,
  dz: number,
): BimEditOutcome {
  if (ids.length === 0) return { status: "no-op", reason: "copy: empty selection" };
  if (dx === 0 && dy === 0 && dz === 0) return { status: "no-op", reason: "copy: zero displacement" };
  const map = bimEntities(elements);
  const edits: DocumentEdit[] = [];
  const created: string[] = [];

  const copyOne = (entity: BimEntity, shiftDx: number, shiftDy: number, shiftDz: number): void => {
    switch (entity.type) {
      case "bim.wall": {
        const copy = makeWall({
          storyId: entity.storyId,
          start: shift(entity.start, shiftDx, shiftDy),
          end: shift(entity.end, shiftDx, shiftDy),
          width: entity.width,
          height: entity.height,
          baseOffset: entity.baseOffset + shiftDz,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: "" }) });
        created.push(entity.id);
        break;
      }
      case "bim.slab": {
        const copy = makeSlab({
          storyId: entity.storyId,
          corner1: shift(entity.corner1, shiftDx, shiftDy),
          corner2: shift(entity.corner2, shiftDx, shiftDy),
          thickness: entity.thickness,
          baseOffset: entity.baseOffset + shiftDz,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: "" }) });
        created.push(entity.id);
        break;
      }
      case "bim.space": {
        const copy = makeSpace({
          storyId: entity.storyId,
          name: entity.name,
          footprint: entity.footprint.map((p) => shift(p, shiftDx, shiftDy)),
          height: entity.height,
          baseOffset: entity.baseOffset + shiftDz,
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: "" }) });
        created.push(entity.id);
        break;
      }
      case "bim.opening": {
        const host = requireBimEntity(map, entity.hostId, "copy");
        if (host.type !== "bim.wall") {
          throw new Error(`copy: opening '${entity.id}' host '${entity.hostId}' is not a wall (stored props are inconsistent)`);
        }
        const frame = wallFrame(host);
        const along = shiftDx * frame.u[0] + shiftDy * frame.u[1];
        const cross = shiftDx * frame.n[0] + shiftDy * frame.n[1];
        if (Math.abs(cross) > 1e-9) {
          throw new Error(
            `copy: opening '${entity.id}' copies ALONG the host wall axis only — the cross-axis component (${cross.toFixed(12)} mm) must be 0 (unsupported set; no silent approximation)`,
          );
        }
        const copy = makeOpening({
          hostId: entity.hostId,
          distance: entity.distance + along,
          width: entity.width,
          height: entity.height,
          sill: entity.sill + shiftDz,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: "" }) });
        created.push(entity.id);
        break;
      }
      case "bim.story":
        throw new Error("copy: stories are outside the supported set for copying in this slice (author a new story)");
      case "bim.door":
      case "bim.window":
        throw new Error(
          `copy: '${entity.type}' elements are copied WITH their opening (outside the supported set for direct copies) — copy opening '${entity.openingId}' instead`,
        );
    }
  };

  for (const id of ids) {
    const entity = requireBimEntity(map, id, "copy");
    copyOne(entity, dx, dy, dz);
    if (entity.type === "bim.wall") {
      // Declared cascade: hosted openings + their fills follow the wall copy.
      for (const opening of hostedOpenings(map, id)) {
        copyOne(opening, dx, dy, dz);
        for (const fill of openingFills(map, opening.id)) {
          copyOne(fill, dx, dy, dz);
        }
      }
    }
    if (entity.type === "bim.opening") {
      for (const fill of openingFills(map, id)) {
        copyOne(fill, dx, dy, dz);
      }
    }
  }

  return {
    status: "applied",
    edit: { type: "applyEdits", edits },
    summary: `copied ${created.length} element(s) (incl. declared hosted cascades): ${created.join(", ")}`,
    createdIds: created,
  };
}

// --- Delete --------------------------------------------------------------------

export function deleteBimElements(elements: readonly Element[], ids: readonly string[]): BimEditOutcome {
  if (ids.length === 0) return { status: "no-op", reason: "delete: empty selection" };
  const map = bimEntities(elements);
  const toRemove = new Set<string>();

  for (const id of ids) {
    const entity = requireBimEntity(map, id, "delete");
    toRemove.add(id);
    if (entity.type === "bim.wall") {
      // Declared cascade: hosted voids and their fills go with the wall.
      for (const opening of hostedOpenings(map, id)) {
        toRemove.add(opening.id);
        for (const fill of openingFills(map, opening.id)) toRemove.add(fill.id);
      }
    }
    if (entity.type === "bim.opening") {
      for (const fill of openingFills(map, id)) toRemove.add(fill.id);
    }
    if (entity.type === "bim.story") {
      const hosted: string[] = [];
      for (const other of map.values()) {
        if (
          other.type !== "bim.story" &&
          other.type !== "bim.opening" &&
          (other.type === "bim.wall" || other.type === "bim.slab" || other.type === "bim.space" ||
            other.type === "bim.door" || other.type === "bim.window") &&
          other.storyId === id
        ) {
          hosted.push(other.id);
        }
      }
      if (hosted.length > 0) {
        throw new Error(
          `delete: story '${id}' is still referenced by ${hosted.length} hosted element(s): ${hosted.sort().join(", ")} — reassign or delete them first (no silent cascade)`,
        );
      }
    }
  }

  const ordered = [...toRemove].sort();
  if (ordered.length === 0) return { status: "no-op", reason: "delete: nothing to remove" };
  const edits: DocumentEdit[] = ordered.map((id) => ({ type: "removeElement" as const, elementId: id }));
  const cascaded = ordered.filter((id) => !ids.includes(id));
  return {
    status: "applied",
    edit: { type: "applyEdits", edits },
    summary:
      cascaded.length > 0
        ? `deleted ${ordered.length} element(s): ${ordered.join(", ")} (incl. declared hosted cascades: ${cascaded.join(", ")})`
        : `deleted ${ordered.length} element(s): ${ordered.join(", ")}`,
    createdIds: [],
  };
}

// --- Property editing ----------------------------------------------------------

/** Whitelisted property keys per element type (anything else is rejected —
 *  no silent partial application, LOCK-007). */
const PROPERTY_KEYS: Record<BimEntity["type"], readonly string[]> = {
  "bim.story": ["name", "level", "height"],
  "bim.wall": ["name", "start", "end", "width", "height", "baseOffset"],
  "bim.slab": ["name", "corner1", "corner2", "thickness", "baseOffset"],
  "bim.opening": ["name", "distance", "width", "height", "sill"],
  "bim.door": ["name", "swing", "leafThickness"],
  "bim.window": ["name"],
  "bim.space": ["name", "footprint", "height", "baseOffset"],
};

export function setBimProperties(
  elements: readonly Element[],
  elementId: string,
  patch: Readonly<Record<string, unknown>>,
): BimEditOutcome {
  const map = bimEntities(elements);
  const entity = requireBimEntity(map, elementId, "setProperties");
  const allowed = PROPERTY_KEYS[entity.type];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `setProperties: '${key}' is not a settable property of ${entity.type} (allowed: ${allowed.join(", ")})`,
      );
    }
  }
  // Merge: stored props form the base, the patch wins — then FULL
  // re-validation through the strict constructors (LOCK-007).
  const stored = elements.find((el) => el.id === elementId)!.props as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...stored, ...patch };
  switch (entity.type) {
    case "bim.story":
      makeStory(merged);
      break;
    case "bim.wall":
      makeWall(merged);
      break;
    case "bim.slab":
      makeSlab(merged);
      break;
    case "bim.opening": {
      const rebuilt = makeOpening(merged);
      const host = requireBimEntity(map, entity.hostId, "setProperties");
      if (host.type !== "bim.wall") {
        throw new Error(`setProperties: opening '${elementId}' host '${entity.hostId}' is not a wall (stored props are inconsistent)`);
      }
      assertOpeningFits({ ...rebuilt, id: elementId }, host);
      break;
    }
    case "bim.door":
      makeDoor(merged);
      break;
    case "bim.window":
      makeWindow(merged);
      break;
    case "bim.space":
      makeSpace(merged); // recomputes area for footprint edits
      break;
  }
  return {
    status: "applied",
    edit: { type: "updateElement", elementId, patch: { ...patch } },
    summary: `updated ${Object.keys(patch).length} propert${Object.keys(patch).length === 1 ? "y" : "ies"} of ${entity.type} '${elementId}': ${Object.keys(patch).join(", ")}`,
    createdIds: [],
  };
}

/** Opening fit invariant against its host wall (typed rejects; ≤ at the wall
 *  ends is allowed — the cut tool touches the end faces exactly). */
export function assertOpeningFits(opening: OpeningEntity, host: WallEntity): void {
  const frame = wallFrame(host);
  if (opening.distance + opening.width > frame.length) {
    throw new Error(
      `opening '${opening.id}': distance+width (${opening.distance + opening.width}) exceeds the host wall length (${frame.length})`,
    );
  }
  if (opening.sill + opening.height > host.height) {
    throw new Error(
      `opening '${opening.id}': sill+height (${opening.sill + opening.height}) exceeds the host wall height (${host.height})`,
    );
  }
}
