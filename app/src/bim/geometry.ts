/**
 * BIM solid geometry derivation (COMPAT-CAD-002, Issue #39 scope).
 *
 * PURE, ENGINE-FREE derivation of engine-independent GeometryDescriptors
 * (contracts/geometry.ts) from canonical BIM element semantics. This module
 * contains no engine imports (LOCK-018) and no floating-point surprises: all
 * derivations are closed-form analytic constructions with declared constants,
 * so Web and Electron derive byte-identical descriptors from the same element
 * props (§5.5 parity), and engines (OCCT or the reference adapter) realize
 * them behind the frozen adapter boundary.
 *
 * Derivations (all plan coordinates story-local XY; world Z =
 * story.level + baseOffset):
 *
 *   wall    = extrusion of the wall's world rectangle profile (axis start→end
 *             widened by width/2 on each side) by height, CUT by one cut tool
 *             per hosted opening in deterministic order (distance, then id).
 *   slab    = extrusion of the axis-aligned footprint rectangle by thickness.
 *   space   = extrusion of the footprint polygon by height.
 *   opening = the cut-tool solid (declared overhang — see OPENING_CUT_OVERHANG).
 *   door    = extrusion of the opening rectangle in the wall plane, thickness
 *             = leafThickness, centered on the wall axis (closed leaf; swing
 *             is semantic state, not geometry).
 *   window  = extrusion of the opening rectangle in the wall plane, thickness
 *             = min(40, wall width), centered on the wall axis (panel; frame
 *             modeling is out of scope for this slice).
 *   story   = NO solid (a story is a level container, not a solid). Asking
 *             for a story's solid is a typed unsupported operation.
 *
 * OPENING_CUT_OVERHANG: cut tools overhang the host wall faces by 1 mm per
 * side so the boolean cut removes the full wall thickness without depending
 * on coplanar-face boolean tolerances. The overhang lies strictly outside the
 * wall solid, so the resulting wall volume is EXACT:
 * wallVolume = L·W·H − Σ (openingWidth · openingHeight · W).
 */

import type { Vec2 } from "../contracts/geometry.js";
import type { GeometryDescriptor } from "../contracts/geometry.js";
import type {
  BimEntity,
  DoorEntity,
  OpeningEntity,
  SlabEntity,
  SpaceEntity,
  WallEntity,
} from "./elements.js";
import { BIM_COINCIDENCE_EPS } from "./elements.js";
import type { ComponentDefEntity, ComponentInstanceEntity } from "./components.js";
import { effectiveBox } from "./components.js";

/** Declared boolean-cut overhang per side (mm). See module doc. */
export const OPENING_CUT_OVERHANG = 1;

/** Declared window panel thickness bound (mm). */
export const WINDOW_PANEL_MAX_THICKNESS = 40;

export interface BimGeometryContext {
  /** Resolved stories by element id (level containers). */
  readonly stories: ReadonlyMap<string, BimEntity>;
  /** Resolved walls by element id (opening hosts). */
  readonly walls: ReadonlyMap<string, WallEntity>;
  /** Hosted openings per host wall id, deterministically ordered
   *  (by distance, then id). */
  readonly openingsByHost: ReadonlyMap<string, readonly OpeningEntity[]>;
  /** Component definitions by element id (COMPAT-BIM-003: instance
   *  parametric derivation sources). */
  readonly componentDefs: ReadonlyMap<string, ComponentDefEntity>;
}

/** Build the derivation context from a set of BIM entities (any iterable of
 *  elements; non-BIM elements are ignored). */
export function bimGeometryContext(entities: readonly BimEntity[]): BimGeometryContext {
  const stories = new Map<string, BimEntity>();
  const walls = new Map<string, WallEntity>();
  const byHost = new Map<string, OpeningEntity[]>();
  const componentDefs = new Map<string, ComponentDefEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.story") stories.set(entity.id, entity);
    if (entity.type === "bim.wall") walls.set(entity.id, entity);
    if (entity.type === "bim.componentDef") componentDefs.set(entity.id, entity);
    if (entity.type === "bim.opening") {
      const list = byHost.get(entity.hostId) ?? [];
      list.push(entity);
      byHost.set(entity.hostId, list);
    }
  }
  const openingsByHost = new Map<string, readonly OpeningEntity[]>();
  for (const [hostId, list] of byHost) {
    openingsByHost.set(
      hostId,
      [...list].sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.id < b.id ? -1 : 1)),
    );
  }
  return { stories, walls, openingsByHost, componentDefs };
}

// --- Analytic plan helpers (fixed operation order for determinism) -----------

export interface WallFrame {
  /** Axis unit vector (start → end). */
  readonly u: Vec2;
  /** Left normal of the axis (−u.y, u.x). */
  readonly n: Vec2;
  /** Axis length (mm). */
  readonly length: number;
}

export function wallFrame(wall: WallEntity): WallFrame {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= BIM_COINCIDENCE_EPS) {
    throw new Error(`wall '${wall.id}' has a degenerate axis (validated at construction — stored props were mutated illegally)`);
  }
  return { u: [dx / length, dy / length], n: [-dy / length, dx / length], length };
}

/** World rectangle profile of a wall body (4 corners, deterministic order:
 *  start−n·w/2 → end−n·w/2 → end+n·w/2 → start+n·w/2). */
export function wallProfile(wall: WallEntity): readonly Vec2[] {
  const { u, n } = wallFrame(wall);
  const h = wall.width / 2;
  const a: Vec2 = [wall.start[0] - n[0] * h, wall.start[1] - n[1] * h];
  const b: Vec2 = [wall.end[0] - n[0] * h, wall.end[1] - n[1] * h];
  const c: Vec2 = [wall.end[0] + n[0] * h, wall.end[1] + n[1] * h];
  const d: Vec2 = [wall.start[0] + n[0] * h, wall.start[1] + n[1] * h];
  void u;
  return [a, b, c, d];
}

/** World rectangle profile of an opening's clear void in the host wall plane
 *  (thickness = host wall width; no overhang — this is the CLEAR opening). */
export function openingClearProfile(opening: OpeningEntity, host: WallEntity): readonly Vec2[] {
  return openingRectProfile(opening, host, host.width);
}

/** World rectangle profile of a centered in-plane solid of the given
 *  thickness occupying the opening (cut tool with overhang, door leaf,
 *  window panel). */
function openingRectProfile(opening: OpeningEntity, host: WallEntity, thickness: number): readonly Vec2[] {
  const { u, n } = wallFrame(host);
  const halfT = thickness / 2;
  const nearD = opening.distance;
  const farD = opening.distance + opening.width;
  const near: Vec2 = [
    host.start[0] + u[0] * nearD - n[0] * halfT,
    host.start[1] + u[1] * nearD - n[1] * halfT,
  ];
  const farNear: Vec2 = [
    host.start[0] + u[0] * farD - n[0] * halfT,
    host.start[1] + u[1] * farD - n[1] * halfT,
  ];
  const far: Vec2 = [
    host.start[0] + u[0] * farD + n[0] * halfT,
    host.start[1] + u[1] * farD + n[1] * halfT,
  ];
  const nearFar: Vec2 = [
    host.start[0] + u[0] * nearD + n[0] * halfT,
    host.start[1] + u[1] * nearD + n[1] * halfT,
  ];
  return [near, farNear, far, nearFar];
}

/** World Z base of a wall (story level + base offset). */
function storyLevelOf(ctx: BimGeometryContext, storyId: string): number {
  const story = ctx.stories.get(storyId);
  if (story === undefined || story.type !== "bim.story") {
    throw new Error(`referenced story '${storyId}' does not exist (hosted elements require their story)`);
  }
  return story.level;
}

/** The cut-tool descriptor for one hosted opening (declared overhang). */
export function openingCutTool(opening: OpeningEntity, host: WallEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, host.storyId);
  return {
    shape: "extrude",
    profile: openingRectProfile(opening, host, host.width + 2 * OPENING_CUT_OVERHANG),
    height: opening.height,
    base: [0, 0, level + host.baseOffset + opening.sill],
  };
}

/** Wall solid: wall body minus every hosted opening (deterministic order). */
export function wallSolid(wall: WallEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, wall.storyId);
  const body: GeometryDescriptor = {
    shape: "extrude",
    profile: wallProfile(wall),
    height: wall.height,
    base: [0, 0, level + wall.baseOffset],
  };
  const openings = ctx.openingsByHost.get(wall.id) ?? [];
  let solid: GeometryDescriptor = body;
  for (const opening of openings) {
    const tool: GeometryDescriptor = {
      shape: "extrude",
      profile: openingRectProfile(opening, wall, wall.width + 2 * OPENING_CUT_OVERHANG),
      height: opening.height,
      base: [0, 0, level + wall.baseOffset + opening.sill],
    };
    solid = { shape: "cut", a: solid, b: tool };
  }
  return solid;
}

/** Slab solid. */
export function slabSolid(slab: SlabEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, slab.storyId);
  const x0 = Math.min(slab.corner1[0], slab.corner2[0]);
  const y0 = Math.min(slab.corner1[1], slab.corner2[1]);
  const x1 = Math.max(slab.corner1[0], slab.corner2[0]);
  const y1 = Math.max(slab.corner1[1], slab.corner2[1]);
  return {
    shape: "extrude",
    profile: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    height: slab.thickness,
    base: [0, 0, level + slab.baseOffset],
  };
}

/** Space solid. */
export function spaceSolid(space: SpaceEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, space.storyId);
  return {
    shape: "extrude",
    profile: [...space.footprint],
    height: space.height,
    base: [0, 0, level + space.baseOffset],
  };
}

/** Door leaf solid (closed position; swing is semantic state). */
export function doorSolid(door: DoorEntity, opening: OpeningEntity, host: WallEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, host.storyId);
  return {
    shape: "extrude",
    profile: openingRectProfile(opening, host, door.leafThickness),
    height: opening.height,
    base: [0, 0, level + host.baseOffset + opening.sill],
  };
}

/** Window panel solid (thickness = min(WINDOW_PANEL_MAX_THICKNESS, wall
 *  width), centered on the wall axis — a declared deterministic bound, not a
 *  modeled frame). */
export function windowSolid(opening: OpeningEntity, host: WallEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, host.storyId);
  const thickness = Math.min(WINDOW_PANEL_MAX_THICKNESS, host.width);
  return {
    shape: "extrude",
    profile: openingRectProfile(opening, host, thickness),
    height: opening.height,
    base: [0, 0, level + host.baseOffset + opening.sill],
  };
}

/** Component instance footprint profile (COMPAT-BIM-003): the parametric
 *  box's rotated rectangle in story-local XY, centered on the instance
 *  position. Deterministic corner order: (−hx,−hy) → (+hx,−hy) →
 *  (+hx,+hy) → (−hx,+hy). */
export function componentInstanceProfile(
  instance: ComponentInstanceEntity,
  definition: ComponentDefEntity,
): readonly Vec2[] {
  const [sizeX, sizeY] = effectiveBox(definition, instance);
  const hx = sizeX / 2;
  const hy = sizeY / 2;
  const cos = Math.cos(instance.rotation);
  const sin = Math.sin(instance.rotation);
  const corner = (sx: number, sy: number): Vec2 => [
    instance.position[0] + cos * sx - sin * sy,
    instance.position[1] + sin * sx + cos * sy,
  ];
  return [corner(-hx, -hy), corner(hx, -hy), corner(hx, hy), corner(-hx, hy)];
}

/** Component instance solid (COMPAT-BIM-003): the parametric box from the
 *  EFFECTIVE parameters (definition defaults ⊕ instance overrides), centered
 *  on the instance position in story-local XY, rotated by the instance
 *  rotation about +Z, extruded +Z by the effective height from the story
 *  level + baseOffset. Closed-form analytic construction — identical on every
 *  host (§5.5 parity). */
export function componentInstanceSolid(
  instance: ComponentInstanceEntity,
  definition: ComponentDefEntity,
  ctx: BimGeometryContext,
): GeometryDescriptor {
  const level = storyLevelOf(ctx, instance.storyId);
  const [, , sizeZ] = effectiveBox(definition, instance);
  return {
    shape: "extrude",
    profile: componentInstanceProfile(instance, definition),
    height: sizeZ,
    base: [0, 0, level + instance.baseOffset],
  };
}

/** Derive the solid descriptor for a BIM entity, or explain honestly why
 *  there is none (LOCK-007: a story is a level container, not a solid). */
export function bimSolidDescriptor(
  entity: BimEntity,
  ctx: BimGeometryContext,
): { readonly descriptor: GeometryDescriptor; readonly reason: null } | { readonly descriptor: null; readonly reason: string } {
  switch (entity.type) {
    case "bim.wall":
      return { descriptor: wallSolid(entity, ctx), reason: null };
    case "bim.slab":
      return { descriptor: slabSolid(entity, ctx), reason: null };
    case "bim.space":
      return { descriptor: spaceSolid(entity, ctx), reason: null };
    case "bim.opening": {
      const host = ctx.walls.get(entity.hostId);
      if (host === undefined) {
        return { descriptor: null, reason: `opening '${entity.id}': host wall '${entity.hostId}' does not exist` };
      }
      return { descriptor: openingCutTool(entity, host, ctx), reason: null };
    }
    case "bim.door": {
      const hostChain = resolveOpeningHost(entity.openingId, ctx);
      if (hostChain === null) {
        return { descriptor: null, reason: `door '${entity.id}': opening '${entity.openingId}' does not exist` };
      }
      return { descriptor: doorSolid(entity, hostChain.opening, hostChain.host, ctx), reason: null };
    }
    case "bim.window": {
      const hostChain = resolveOpeningHost(entity.openingId, ctx);
      if (hostChain === null) {
        return { descriptor: null, reason: `window '${entity.id}': opening '${entity.openingId}' does not exist` };
      }
      return { descriptor: windowSolid(hostChain.opening, hostChain.host, ctx), reason: null };
    }
    case "bim.story":
      return {
        descriptor: null,
        reason: `story '${entity.id}' is a level container — it has no own solid (hosted elements carry the geometry)`,
      };
    // --- COMPAT-BIM-003 (additive): components / materials / coordination ---
    case "bim.componentInstance": {
      const definition = ctx.componentDefs.get(entity.definitionId);
      if (definition === undefined) {
        return { descriptor: null, reason: `component instance '${entity.id}': definition '${entity.definitionId}' does not exist` };
      }
      return { descriptor: componentInstanceSolid(entity, definition, ctx), reason: null };
    }
    case "bim.componentDef":
      return {
        descriptor: null,
        reason: `component definition '${entity.id}' is parametric domain data — instances carry the realized geometry`,
      };
    case "bim.material":
      return {
        descriptor: null,
        reason: `material '${entity.id}' is canonical domain data — it has no solid (associations carry it)`,
      };
    case "bim.grid":
      return {
        descriptor: null,
        reason: `grid '${entity.id}' is a coordination primitive — it has no solid (coordination data, not building geometry)`,
      };
    case "bim.referencePlane":
      return {
        descriptor: null,
        reason: `reference plane '${entity.id}' is an infinite coordination plane — it has no solid`,
      };
  }
}

function resolveOpeningHost(openingId: string, ctx: BimGeometryContext): { opening: OpeningEntity; host: WallEntity } | null {
  for (const openings of ctx.openingsByHost.values()) {
    for (const opening of openings) {
      if (opening.id === openingId) {
        const host = ctx.walls.get(opening.hostId);
        if (host === undefined) return null;
        return { opening, host };
      }
    }
  }
  return null;
}

// --- Analytic world bounding boxes (pure, engine-free) -----------------------

export type WorldBBox = readonly [number, number, number, number, number, number];

/** Axis-aligned world bbox of a plan rectangle extruded between z0 and z1. */
function profileBBox(profile: readonly Vec2[], z0: number, z1: number): WorldBBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of profile) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, Math.min(z0, z1), maxX, maxY, Math.max(z0, z1)];
}

/** Analytic world bbox of one BIM entity (or null when it has no solid). */
export function bimWorldBBox(entity: BimEntity, ctx: BimGeometryContext): WorldBBox | null {
  switch (entity.type) {
    case "bim.story":
      return null; // level container — no solid, no world extent of its own
    case "bim.wall": {
      const level = storyLevelOf(ctx, entity.storyId);
      return profileBBox(wallProfile(entity), level + entity.baseOffset, level + entity.baseOffset + entity.height);
    }
    case "bim.slab": {
      const level = storyLevelOf(ctx, entity.storyId);
      return profileBBox(
        [
          [entity.corner1[0], entity.corner1[1]],
          [entity.corner2[0], entity.corner2[1]],
        ],
        level + entity.baseOffset,
        level + entity.baseOffset + entity.thickness,
      );
    }
    case "bim.space": {
      const level = storyLevelOf(ctx, entity.storyId);
      return profileBBox(entity.footprint, level + entity.baseOffset, level + entity.baseOffset + entity.height);
    }
    case "bim.opening": {
      const host = ctx.walls.get(entity.hostId);
      if (host === undefined) return null;
      const level = storyLevelOf(ctx, host.storyId);
      return profileBBox(
        openingClearProfile(entity, host),
        level + host.baseOffset + entity.sill,
        level + host.baseOffset + entity.sill + entity.height,
      );
    }
    case "bim.door":
    case "bim.window": {
      const openingId = entity.type === "bim.door" ? entity.openingId : entity.openingId;
      const hostChain = resolveOpeningHost(openingId, ctx);
      if (hostChain === null) return null;
      const level = storyLevelOf(ctx, hostChain.host.storyId);
      return profileBBox(
        openingClearProfile(hostChain.opening, hostChain.host),
        level + hostChain.host.baseOffset + hostChain.opening.sill,
        level + hostChain.host.baseOffset + hostChain.opening.sill + hostChain.opening.height,
      );
    }
    // --- COMPAT-BIM-003 (additive) ---
    case "bim.componentInstance": {
      const definition = ctx.componentDefs.get(entity.definitionId);
      if (definition === undefined) return null;
      const [, , sizeZ] = effectiveBox(definition, entity);
      const level = storyLevelOf(ctx, entity.storyId);
      return profileBBox(
        componentInstanceProfile(entity, definition),
        level + entity.baseOffset,
        level + entity.baseOffset + sizeZ,
      );
    }
    case "bim.componentDef":
    case "bim.material":
    case "bim.grid":
    case "bim.referencePlane":
      return null; // domain data / coordination primitives — no solid extent
  }
}

/** Union world bbox over all solid-bearing BIM entities (null when none). */
export function bimModelBBox(entities: readonly BimEntity[], ctx: BimGeometryContext): WorldBBox | null {
  let acc: WorldBBox | null = null;
  for (const entity of entities) {
    const box = bimWorldBBox(entity, ctx);
    if (box === null) continue;
    acc = acc === null
      ? box
      : [
          Math.min(acc[0], box[0]),
          Math.min(acc[1], box[1]),
          Math.min(acc[2], box[2]),
          Math.max(acc[3], box[3]),
          Math.max(acc[4], box[4]),
          Math.max(acc[5], box[5]),
        ];
  }
  return acc;
}
