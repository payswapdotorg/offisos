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
import {
  makeComponentDef,
  makeComponentInstance,
  makeGrid,
  makeMaterial,
  makeReferencePlane,
  validateInstanceAgainstDefinition,
  type ComponentDefEntity,
  type ComponentInstanceEntity,
  type GridEntity,
  type MaterialEntity,
  type ReferencePlaneEntity,
} from "./components.js";
import { wallFrame } from "./geometry.js";
import {
  assertEntityMetaReferences,
  assertOptionMembership,
  assertRoofStoryRelationship,
  assertStairStoryRelationship,
  assertStoryEditIntegrity,
} from "./relationships.js";
import { makeOptionGroup, makeRailing, makeRoof, makeStair, makeZone } from "./elements.js";
import type { OptionGroupEntity, RailingEntity, RoofEntity, StairEntity, ZoneEntity } from "./elements.js";

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

/** Railings hosted on a stair, deterministic order (side, then id) —
 *  CAD-PARITY-011 (the stair→railing hosted cascade). */
function stairRailings(map: ReadonlyMap<string, BimEntity>, stairId: string): RailingEntity[] {
  const list: RailingEntity[] = [];
  for (const entity of map.values()) {
    if (entity.type === "bim.railing" && entity.hostId === stairId) list.push(entity);
  }
  list.sort((a, b) => (a.side !== b.side ? (a.side < b.side ? -1 : 1) : a.id < b.id ? -1 : 1));
  return list;
}

/** Zones that reference a space, deterministic order (id) — the reference
 *  integrity gate for space deletion (CAD-PARITY-011). */
function zonesOfSpace(map: ReadonlyMap<string, BimEntity>, spaceId: string): ZoneEntity[] {
  const list: ZoneEntity[] = [];
  for (const entity of map.values()) {
    if (entity.type === "bim.zone" && entity.spaceIds.includes(spaceId)) list.push(entity);
  }
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return list;
}

/** Elements whose meta overlay references an option group, deterministic
 *  order (id) — the reference integrity gate for option-group deletion
 *  (CAD-PARITY-011). */
function optionGroupMembers(map: ReadonlyMap<string, BimEntity>, groupId: string): BimEntity[] {
  const list: BimEntity[] = [];
  for (const entity of map.values()) {
    if (entity.meta?.optionGroupId === groupId) list.push(entity);
  }
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return list;
}

/** Instances of a component definition, deterministic order (id). */
function definitionInstances(map: ReadonlyMap<string, BimEntity>, definitionId: string): ComponentInstanceEntity[] {
  const list: ComponentInstanceEntity[] = [];
  for (const entity of map.values()) {
    if (entity.type === "bim.componentInstance" && entity.definitionId === definitionId) list.push(entity);
  }
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return list;
}

/** Referencers of a material (definitions then instances), deterministic order. */
function materialReferencers(map: ReadonlyMap<string, BimEntity>, materialId: string): BimEntity[] {
  const list: BimEntity[] = [];
  for (const entity of map.values()) {
    if (
      (entity.type === "bim.componentDef" || entity.type === "bim.componentInstance") &&
      entity.materialId === materialId
    ) {
      list.push(entity);
    }
  }
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
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

  // CAD-PARITY-011: story LEVEL moves re-enforce the vertical relationships
  // BEFORE applying (a shift that would break a hosted roof's reach or a
  // stair's derived rise is a typed rejection — the stronger host/story
  // relationship). All story shifts of this batch are combined into ONE
  // adjusted lookup so cross-story interactions validate against the FINAL
  // levels, deterministically.
  const levelDelta = new Map<string, number>();
  if (dz !== 0) {
    for (const id of ids) {
      const entity = requireBimEntity(map, id, "move");
      if (entity.type === "bim.story" && dx === 0 && dy === 0) levelDelta.set(id, dz);
    }
  }
  if (levelDelta.size > 0) {
    const shiftedLookup = (id: string): BimEntity | undefined => {
      const entity = map.get(id);
      if (entity === undefined) return undefined;
      const delta = levelDelta.get(id);
      if (delta !== undefined && entity.type === "bim.story") {
        return { ...entity, level: entity.level + delta } as BimEntity;
      }
      return entity;
    };
    for (const storyId of [...levelDelta.keys()].sort()) {
      assertStoryEditIntegrity(storyId, map.values(), shiftedLookup);
    }
  }

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
      // --- COMPAT-BIM-003 (additive): components / materials / coordination ---
      case "bim.componentInstance": {
        const shifted = makeComponentInstance({
          definitionId: entity.definitionId,
          storyId: entity.storyId,
          position: shift(entity.position, dx, dy),
          rotation: entity.rotation,
          baseOffset: entity.baseOffset + dz,
          overrides: entity.overrides,
          ...(entity.materialId !== undefined ? { materialId: entity.materialId } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.grid": {
        const shifted = makeGrid({
          storyId: entity.storyId,
          name: entity.name,
          uLines: entity.uLines.map((x) => x + dx),
          vLines: entity.vLines.map((y) => y + dy),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.referencePlane": {
        const shifted = makeReferencePlane({
          storyId: entity.storyId,
          name: entity.name,
          start: shift(entity.start, dx, dy),
          end: shift(entity.end, dx, dy),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      // --- CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
      // elements. Roofs move like slabs (plan shift + baseOffset shift);
      // stairs shift their start + baseOffset (the rise stays story-derived);
      // railings derive everything from the host stair — moving one directly
      // is outside the supported set; zones/option groups carry no placement. ---
      case "bim.roof": {
        const shifted = makeRoof({
          storyId: entity.storyId,
          corner1: shift(entity.corner1, dx, dy),
          corner2: shift(entity.corner2, dx, dy),
          ridgeAxis: entity.ridgeAxis,
          height: entity.height,
          baseOffset: entity.baseOffset + dz,
          ...(entity.topStoryId !== undefined ? { topStoryId: entity.topStoryId } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
          ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
        });
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.stair": {
        const shifted = makeStair({
          storyId: entity.storyId,
          topStoryId: entity.topStoryId,
          start: shift(entity.start, dx, dy),
          direction: entity.direction,
          width: entity.width,
          stepCount: entity.stepCount,
          tread: entity.tread,
          baseOffset: entity.baseOffset + dz,
          ...(entity.landingLength !== undefined ? { landingLength: entity.landingLength } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
          ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
        });
        // The vertical relationship re-validates against the SHIFTED
        // baseOffset (the derived rise must stay positive).
        assertStairStoryRelationship({ ...shifted, id }, (sid) => map.get(sid));
        edits.push({ type: "updateElement", elementId: id, patch: entityPatch({ ...shifted, id }) });
        moved.push(id);
        break;
      }
      case "bim.railing":
        throw new Error(
          `move: 'bim.railing' elements derive their geometry from the host stair (outside the supported set for direct moves) — move stair '${entity.hostId}' instead`,
        );
      case "bim.zone":
        throw new Error(
          "move: zones carry no spatial placement (a zone groups spaces — move the member spaces)",
        );
      case "bim.optionGroup":
        throw new Error(
          "move: option groups carry no spatial placement (lifecycle registries are document-global)",
        );
      case "bim.componentDef":
      case "bim.material":
        throw new Error(
          `move: '${entity.type}' elements carry no spatial placement (domain data — outside the supported set for moves)`,
        );
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

/**
 * Copy BIM elements with a declared, itemized hosted cascade.
 *
 * `mint` mints the new canonical identities (document authority, §5.4 — the
 * handler passes CADDocument.mintElementId). Every copy carries a minted id
 * so hosted references can be RE-PONTED inside the same atomic batch: a wall
 * copy's openings point at the NEW wall, and fill copies point at the NEW
 * openings. Hosted cascade copies duplicate their host-frame parameters
 * verbatim (the wall copy carries the displacement).
 */
export function copyBimElements(
  elements: readonly Element[],
  ids: readonly string[],
  dx: number,
  dy: number,
  dz: number,
  mint: () => string,
): BimEditOutcome {
  if (ids.length === 0) return { status: "no-op", reason: "copy: empty selection" };
  if (dx === 0 && dy === 0 && dz === 0) return { status: "no-op", reason: "copy: zero displacement" };
  const map = bimEntities(elements);
  const edits: DocumentEdit[] = [];
  const created: string[] = [];
  const sources: string[] = [];
  /** original id → minted copy id (reference re-pointing for cascades). */
  const remap = new Map<string, string>();

  const copyOne = (entity: BimEntity, shiftDx: number, shiftDy: number, shiftDz: number): string => {
    const newId = mint();
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
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
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
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
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
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.opening": {
        const hostId = remap.get(entity.hostId) ?? entity.hostId;
        let distance = entity.distance;
        let sill = entity.sill;
        if (shiftDx !== 0 || shiftDy !== 0 || shiftDz !== 0) {
          // STANDALONE copy (explicit selection): moves along the host axis.
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
          distance = entity.distance + along;
          sill = entity.sill + shiftDz;
        }
        // HOSTED CASCADE (zero shift): host-frame parameters duplicated
        // verbatim — the wall copy carries the displacement.
        const copy = makeOpening({
          hostId,
          distance,
          width: entity.width,
          height: entity.height,
          sill,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.story":
        throw new Error("copy: stories are outside the supported set for copying in this slice (author a new story)");
      case "bim.componentDef":
        throw new Error(
          `copy: component definition '${entity.id}' is domain data (outside the supported set for copying) — instances copy it by reference; author a new definition for a variant`,
        );
      case "bim.material":
        throw new Error(`copy: material '${entity.id}' is domain data (outside the supported set for copying) — author a new material`);
      case "bim.componentInstance": {
        const copy = makeComponentInstance({
          definitionId: entity.definitionId,
          storyId: entity.storyId,
          position: shift(entity.position, shiftDx, shiftDy),
          rotation: entity.rotation,
          baseOffset: entity.baseOffset + shiftDz,
          overrides: entity.overrides,
          ...(entity.materialId !== undefined ? { materialId: entity.materialId } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.grid": {
        const copy = makeGrid({
          storyId: entity.storyId,
          name: entity.name,
          uLines: entity.uLines.map((x) => x + shiftDx),
          vLines: entity.vLines.map((y) => y + shiftDy),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.referencePlane": {
        const copy = makeReferencePlane({
          storyId: entity.storyId,
          name: entity.name,
          start: shift(entity.start, shiftDx, shiftDy),
          end: shift(entity.end, shiftDx, shiftDy),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.door":
      case "bim.window": {
        // Fills only ever copy as hosted cascades (no own position) — an
        // explicit fill copy is rejected in the selection loop below.
        const openingId = remap.get(entity.openingId) ?? entity.openingId;
        const copy = entity.type === "bim.door"
          ? makeDoor({
              openingId,
              storyId: entity.storyId,
              swing: entity.swing,
              leafThickness: entity.leafThickness,
              ...(entity.name !== undefined ? { name: entity.name } : {}),
              ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
            })
          : makeWindow({
              openingId,
              storyId: entity.storyId,
              ...(entity.name !== undefined ? { name: entity.name } : {}),
              ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
            });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      // --- CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
      // copies. Roofs copy like slabs; a stair copy CASCADE-copies its
      // hosted railings (references re-pointed — the deterministic
      // placement/propagation); railings only ever copy WITH their stair;
      // zones/option groups are grouping/lifecycle data (author new ones). ---
      case "bim.roof": {
        const copy = makeRoof({
          storyId: entity.storyId,
          corner1: shift(entity.corner1, shiftDx, shiftDy),
          corner2: shift(entity.corner2, shiftDx, shiftDy),
          ridgeAxis: entity.ridgeAxis,
          height: entity.height,
          baseOffset: entity.baseOffset + shiftDz,
          ...(entity.topStoryId !== undefined ? { topStoryId: entity.topStoryId } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
          ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.stair": {
        const copy = makeStair({
          storyId: entity.storyId,
          topStoryId: entity.topStoryId,
          start: shift(entity.start, shiftDx, shiftDy),
          direction: entity.direction,
          width: entity.width,
          stepCount: entity.stepCount,
          tread: entity.tread,
          baseOffset: entity.baseOffset + shiftDz,
          ...(entity.landingLength !== undefined ? { landingLength: entity.landingLength } : {}),
          ...(entity.name !== undefined ? { name: entity.name } : {}),
          ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.railing": {
        // Hosted cascade only (zero shift): the host stair copy carries the
        // displacement; the railing re-points at the NEW stair.
        const hostId = remap.get(entity.hostId) ?? entity.hostId;
        const copy = makeRailing({
          hostId,
          side: entity.side,
          height: entity.height,
          ...(entity.name !== undefined ? { name: entity.name } : {}),
          ...(entity.meta !== undefined ? { meta: entity.meta } : {}),
        });
        edits.push({ type: "addElement", element: bimEntityToElement({ ...copy, id: newId }) });
        break;
      }
      case "bim.zone":
        throw new Error(
          `copy: zone '${entity.id}' is grouping data (outside the supported set for copying) — author a new zone with the intended membership`,
        );
      case "bim.optionGroup":
        throw new Error(
          `copy: option group '${entity.id}' is a lifecycle registry (outside the supported set for copying) — author a new group`,
        );
    }
    created.push(newId);
    sources.push(entity.id);
    remap.set(entity.id, newId);
    return newId;
  };

  for (const id of ids) {
    const entity = requireBimEntity(map, id, "copy");
    if (entity.type === "bim.door" || entity.type === "bim.window") {
      throw new Error(
        `copy: '${entity.type}' elements are copied WITH their opening (outside the supported set for direct copies) — copy opening '${entity.openingId}' instead`,
      );
    }
    if (entity.type === "bim.story") {
      throw new Error("copy: stories are outside the supported set for copying in this slice (author a new story)");
    }
    if (entity.type === "bim.componentDef" || entity.type === "bim.material") {
      throw new Error(
        `copy: '${entity.type}' elements are domain data (outside the supported set for copying in this slice)`,
      );
    }
    // CAD-PARITY-011: railings copy WITH their host stair; zones and option
    // groups are grouping/lifecycle data (the copyOne cases reject with the
    // full typed message — reached only through the cascade path never being
    // one, but the selection loop names it first for direct copies).
    if (entity.type === "bim.railing") {
      throw new Error(
        `copy: 'bim.railing' elements are copied WITH their stair (outside the supported set for direct copies) — copy stair '${entity.hostId}' instead`,
      );
    }
    if (entity.type === "bim.zone") {
      throw new Error(
        `copy: zone '${entity.id}' is grouping data (outside the supported set for copying) — author a new zone with the intended membership`,
      );
    }
    if (entity.type === "bim.optionGroup") {
      throw new Error(
        `copy: option group '${entity.id}' is a lifecycle registry (outside the supported set for copying) — author a new group`,
      );
    }
    copyOne(entity, dx, dy, dz);
    if (entity.type === "bim.wall") {
      // Declared cascade: hosted openings + their fills follow the wall copy
      // (host-frame parameters verbatim; references re-pointed via remap).
      for (const opening of hostedOpenings(map, id)) {
        copyOne(opening, 0, 0, 0);
        for (const fill of openingFills(map, opening.id)) {
          copyOne(fill, 0, 0, 0);
        }
      }
    }
    if (entity.type === "bim.opening") {
      for (const fill of openingFills(map, id)) {
        copyOne(fill, 0, 0, 0);
      }
    }
    // CAD-PARITY-011: a stair copy CASCADE-copies its hosted railings
    // (references re-pointed via remap — deterministic propagation).
    if (entity.type === "bim.stair") {
      for (const railing of stairRailings(map, id)) {
        copyOne(railing, 0, 0, 0);
      }
    }
  }

  return {
    status: "applied",
    edit: { type: "applyEdits", edits },
    summary: `copied ${created.length} element(s) (${sources.join(", ")} → ${created.join(", ")}${created.length > ids.length ? "; incl. declared hosted cascades" : ""})`,
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
    // CAD-PARITY-011: deleting a stair cascades its hosted railings (the
    // railing geometry derives from the host — an orphaned railing would be
    // corrupted state; the cascade is declared and itemized).
    if (entity.type === "bim.stair") {
      for (const railing of stairRailings(map, id)) toRemove.add(railing.id);
    }
    if (entity.type === "bim.opening") {
      for (const fill of openingFills(map, id)) toRemove.add(fill.id);
    }
    // CAD-PARITY-011: deleting a space that a zone references is a typed
    // rejection (zone membership is a reference — remove the space from the
    // zone first; no silent zone mutation, the story/def/material precedent).
    if (entity.type === "bim.space") {
      const zones = zonesOfSpace(map, id);
      if (zones.length > 0) {
        throw new Error(
          `delete: space '${id}' is still referenced by ${zones.length} zone(s): ${zones.map((z) => z.id).join(", ")} — remove it from the zone(s) first (no silent membership mutation)`,
        );
      }
    }
    // CAD-PARITY-011: deleting an option group that members reference is a
    // typed rejection (clear the memberships first — the deterministic
    // lifecycle boundary; no destructive cascade).
    if (entity.type === "bim.optionGroup") {
      const members = optionGroupMembers(map, id);
      if (members.length > 0) {
        throw new Error(
          `delete: option group '${id}' is still referenced by ${members.length} element(s): ${members.map((m) => m.id).join(", ")} — clear their option membership first (no destructive cascade)`,
        );
      }
    }
    if (entity.type === "bim.story") {
      const hosted: string[] = [];
      for (const other of map.values()) {
        if (
          other.type !== "bim.story" &&
          other.type !== "bim.opening" &&
          (other.type === "bim.wall" || other.type === "bim.slab" || other.type === "bim.space" ||
            other.type === "bim.door" || other.type === "bim.window" ||
            // CAD-PARITY-011: story-hosted authoring elements keep the same
            // no-cascade rule (roofs host on stories; stairs START at a
            // story — the top story is a separate reference that re-checks).
            other.type === "bim.roof" || other.type === "bim.stair" ||
            // COMPAT-BIM-003: story-hosted component instances and
            // coordination primitives keep the same no-cascade rule.
            other.type === "bim.componentInstance" || other.type === "bim.grid" ||
            other.type === "bim.referencePlane") &&
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
      // CAD-PARITY-011: a story that is a stair's TOP story or a roof's
      // reference story is also referenced (the vertical relationships).
      const verticalRefs: string[] = [];
      for (const other of map.values()) {
        if (other.type === "bim.stair" && other.topStoryId === id) verticalRefs.push(other.id);
        if (other.type === "bim.roof" && other.topStoryId === id) verticalRefs.push(other.id);
      }
      if (verticalRefs.length > 0) {
        throw new Error(
          `delete: story '${id}' is still the vertical reference of ${verticalRefs.length} element(s): ${verticalRefs.sort().join(", ")} — reassign or delete them first (no silent cascade)`,
        );
      }
    }
    if (entity.type === "bim.componentDef") {
      // No cascade over the definition→instance relationship: deleting a
      // definition would orphan every instance's provenance.
      const instances = definitionInstances(map, id);
      if (instances.length > 0) {
        throw new Error(
          `delete: component definition '${id}' is still referenced by ${instances.length} instance(s): ${instances.map((i) => i.id).join(", ")} — delete them first (no silent cascade)`,
        );
      }
    }
    if (entity.type === "bim.material") {
      const referencers = materialReferencers(map, id);
      if (referencers.length > 0) {
        throw new Error(
          `delete: material '${id}' is still referenced by ${referencers.length} element(s): ${referencers.map((r) => r.id).join(", ")} — reassign or delete them first (no silent cascade)`,
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
  // COMPAT-BIM-003 (additive): category is immutable on definitions (it
  // fixes the parameter schema — a category flip would invalidate every
  // instance override); definitionId/storyId are immutable on instances
  // (re-hosting is a delete + re-create in this slice); materialId is
  // settable to another material but cannot be cleared through this
  // surface (declared limitation, never a silent approximation).
  "bim.componentDef": ["name", "parameters", "materialId"],
  "bim.componentInstance": ["position", "rotation", "baseOffset", "overrides", "materialId", "name"],
  // CAD-PARITY-012 (additive): the material parity fields are settable
  // through this surface too (validated by makeMaterial — the category
  // vocabulary + the lineweight range + positive density; absence stays the
  // canonical default form).
  "bim.material": ["name", "description", "color", "properties", "category", "lineweight", "density"],
  "bim.grid": ["name", "uLines", "vLines"],
  "bim.referencePlane": ["name", "start", "end"],
  // CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
  // elements. storyId/topStoryId re-anchoring is immutable here (re-hosting
  // is a delete + re-create — the componentInstance precedent); topStoryId
  // IS settable on roofs (the span declaration re-validates); hostId is
  // immutable on railings (re-hosting is a delete + re-create). The meta
  // overlay is NOT settable through this surface — the dedicated lifecycle
  // commands own it (bim.setClassification/setPropertySets/
  // setRenovation/setOptionMembership/setActiveOption).
  "bim.roof": ["name", "corner1", "corner2", "ridgeAxis", "height", "baseOffset", "topStoryId"],
  "bim.stair": ["name", "start", "direction", "width", "stepCount", "tread", "baseOffset", "landingLength", "topStoryId"],
  "bim.railing": ["name", "side", "height"],
  "bim.zone": ["name", "spaceIds"],
  "bim.optionGroup": ["name", "options", "activeOption", "description"],
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
    case "bim.story": {
      makeStory(merged);
      // CAD-PARITY-011: level/height edits re-enforce the vertical
      // relationships BEFORE applying (the stronger host/story semantics —
      // the shifted story is the post-edit state the relationships see).
      const levelChanged = patch.level !== undefined;
      if (levelChanged) {
        const rebuilt = makeStory(merged);
        const shiftedLookup = (id: string): BimEntity | undefined => {
          const other = map.get(id);
          if (other === undefined) return undefined;
          if (id === elementId && other.type === "bim.story") {
            return { ...other, level: rebuilt.level } as BimEntity;
          }
          return other;
        };
        assertStoryEditIntegrity(elementId, map.values(), shiftedLookup);
      }
      break;
    }
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
    // --- COMPAT-BIM-003 (additive): full re-validation through the strict
    // constructors + cross-element integrity (definition schemas, material
    // existence, material name uniqueness across the document). ---
    case "bim.componentDef": {
      const rebuilt = makeComponentDef(merged);
      if (rebuilt.materialId !== undefined) {
        const material = requireBimEntity(map, rebuilt.materialId, "setProperties");
        if (material.type !== "bim.material") {
          throw new Error(`setProperties: componentDef.materialId '${rebuilt.materialId}' must reference a material (got '${material.type}')`);
        }
      }
      break;
    }
    case "bim.componentInstance": {
      const rebuilt = makeComponentInstance({ ...merged, category: undefined });
      const definition = requireBimEntity(map, rebuilt.definitionId, "setProperties");
      if (definition.type !== "bim.componentDef") {
        throw new Error(`setProperties: componentInstance.definitionId '${rebuilt.definitionId}' must reference a component definition (got '${definition.type}')`);
      }
      validateInstanceAgainstDefinition(definition, { ...rebuilt, id: elementId });
      if (rebuilt.materialId !== undefined) {
        const material = requireBimEntity(map, rebuilt.materialId, "setProperties");
        if (material.type !== "bim.material") {
          throw new Error(`setProperties: componentInstance.materialId '${rebuilt.materialId}' must reference a material (got '${material.type}')`);
        }
      }
      break;
    }
    case "bim.material": {
      makeMaterial(merged);
      // Name uniqueness across the document (the external exchange key):
      const renamed = typeof patch.name === "string" ? patch.name : null;
      if (renamed !== null) {
        for (const other of map.values()) {
          if (other.type === "bim.material" && other.id !== elementId && other.name === renamed) {
            throw new Error(`setProperties: material name '${renamed}' is already taken by material '${other.id}' (names are the document-unique exchange key)`);
          }
        }
      }
      break;
    }
    case "bim.grid":
      makeGrid(merged);
      break;
    case "bim.referencePlane":
      makeReferencePlane(merged);
      break;
    // --- CAD-PARITY-011 (additive, Issue #97): full re-validation through
    // the strict constructors + the cross-element relationship checks. ---
    case "bim.roof": {
      const rebuilt = makeRoof(merged);
      assertRoofStoryRelationship({ ...rebuilt, id: elementId }, (id) => map.get(id));
      break;
    }
    case "bim.stair": {
      const rebuilt = makeStair(merged);
      assertStairStoryRelationship({ ...rebuilt, id: elementId }, (id) => map.get(id));
      break;
    }
    case "bim.railing": {
      const rebuilt = makeRailing(merged);
      const host = requireBimEntity(map, rebuilt.hostId, "setProperties");
      if (host.type !== "bim.stair") {
        throw new Error(`setProperties: railing '${elementId}' host '${rebuilt.hostId}' is not a stair (stored props are inconsistent)`);
      }
      break;
    }
    case "bim.zone": {
      const rebuilt = makeZone(merged);
      for (const [j, spaceId] of rebuilt.spaceIds.entries()) {
        const space = requireBimEntity(map, spaceId, "setProperties");
        if (space.type !== "bim.space") {
          throw new Error(`setProperties: zone.spaceIds[${j}] '${spaceId}' must reference a space (got '${space.type}')`);
        }
      }
      break;
    }
    case "bim.optionGroup": {
      const rebuilt = makeOptionGroup(merged);
      // Removing an option that members still reference is a typed rejection
      // (no silent orphaning of membership — the deterministic boundary).
      const members = optionGroupMembers(map, elementId);
      for (const member of members) {
        const memberOption = member.meta?.option;
        if (memberOption !== undefined && !rebuilt.options.includes(memberOption)) {
          throw new Error(
            `setProperties: option '${memberOption}' still referenced by element '${member.id}' cannot be removed from option group '${elementId}' — clear the membership first (no silent orphaning)`,
          );
        }
      }
      break;
    }
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
