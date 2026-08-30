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
 * CAD-PARITY-011 (Issue #97) adds the Archicad-class authoring solids —
 * every one a closed-form analytic composition over the SAME descriptor
 * vocabulary (extrude/transform/fuse), realizable EXACTLY by both engines:
 *
 *   roof    = the gable prism: the gable TRIANGLE profile (apex up) extruded
 *             along the ridge axis. Realized as ONE extrude of the triangle
 *             in the plane ⟂ the ridge + ONE rigid transform placing it
 *             (rotation by an exact 90° — 0/±1 matrix entries only — plus
 *             translation). Volume (closed form): span · ridgeLength ·
 *             height / 2. The layered/slope-shell roof is OUT of scope.
 *   stair   = the stacked-boxes stair solid: step i spans the tread plan
 *             [i·tread, (i+1)·tread] × width and z ∈ [0, (i+1)·rise] — the
 *             classic solid stair; consecutive steps share one face
 *             (measure-zero union — exact in both engines). Volume (closed
 *             form): tread · width · rise · n(n+1)/2 + landing volume.
 *             rise = derivedRise(stair) — the story-delta rise, one canonical
 *             formula (H·i/n step tops — multiply-then-divide, no drift).
 *   railing = posts at every step boundary (square BIM_RAILING_POST_WIDTH
 *             section, on the walking surface, under the rail) + one sloped
 *             handrail segment per tread (BIM_RAILING_RAIL_THICKNESS section
 *             at the declared height above the walking surface). Posts are
 *             story-local extrudes; rail segments are rigid transforms of a
 *             box (rotation by the stair pitch about the across-run axis);
 *             every part pair is disjoint-or-touching so the exact fuse
 *             holds in both engines. Volume (closed form):
 *             (n+1)·pw²·railH + n·√(tread²+rise²)·pw·railT.
 *   zone / optionGroup = NO solid (a spatial grouping / a lifecycle registry —
 *             typed honest declines, like stories).
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
  RailingEntity,
  RoofEntity,
  SlabEntity,
  SpaceEntity,
  StairEntity,
  WallEntity,
  ZoneEntity,
} from "./elements.js";
import { BIM_COINCIDENCE_EPS, BIM_RAILING_POST_WIDTH, BIM_RAILING_RAIL_THICKNESS } from "./elements.js";
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
  /** CAD-PARITY-011: resolved stairs by element id (railing hosts). */
  readonly stairs: ReadonlyMap<string, StairEntity>;
}

/** Build the derivation context from a set of BIM entities (any iterable of
 *  elements; non-BIM elements are ignored). */
export function bimGeometryContext(entities: readonly BimEntity[]): BimGeometryContext {
  const stories = new Map<string, BimEntity>();
  const walls = new Map<string, WallEntity>();
  const byHost = new Map<string, OpeningEntity[]>();
  const componentDefs = new Map<string, ComponentDefEntity>();
  const stairs = new Map<string, StairEntity>();
  for (const entity of entities) {
    if (entity.type === "bim.story") stories.set(entity.id, entity);
    if (entity.type === "bim.wall") walls.set(entity.id, entity);
    if (entity.type === "bim.componentDef") componentDefs.set(entity.id, entity);
    if (entity.type === "bim.stair") stairs.set(entity.id, entity);
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
  return { stories, walls, openingsByHost, componentDefs, stairs };
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

// ---------------------------------------------------------------------------
// CAD-PARITY-011 (Issue #97): vertical (story) relationships + the
// Archicad-class authoring solid derivations. All closed-form analytic —
// the SAME canonical formulas back the descriptors, the closed-form volume
// assertions and the tests (one canonical source; LOCK-007).
// ---------------------------------------------------------------------------

/** The story of `id` (throws when missing — hosted elements require their
 *  story; the command layer validated at authoring time). */
function storyOf(ctx: BimGeometryContext, id: string): { readonly level: number } {
  const story = ctx.stories.get(id);
  if (story === undefined || story.type !== "bim.story") {
    throw new Error(`referenced story '${id}' does not exist (hosted elements require their story)`);
  }
  return story;
}

/** The derived TOTAL RISE of a stair: the story-delta vertical relationship
 *  (top story level − host story level − baseOffset). Positive by the
 *  command-layer validation; the geometry layer re-derives it — never a
 *  stored copy (LOCK-007). */
export function stairTotalRise(stair: StairEntity, ctx: BimGeometryContext): number {
  const host = storyOf(ctx, stair.storyId);
  const top = storyOf(ctx, stair.topStoryId);
  return top.level - host.level - stair.baseOffset;
}

/** The derived RISER height: totalRise / stepCount. */
export function stairRise(stair: StairEntity, ctx: BimGeometryContext): number {
  return stairTotalRise(stair, ctx) / stair.stepCount;
}

/** The CANONICAL step-top Z formula (world): level + baseOffset + H·i/n —
 *  multiply-then-divide in ONE fixed order so every surface (steps, posts,
 *  rail segments, tests) derives bit-identical values. */
export function stairStepTopZ(stair: StairEntity, ctx: BimGeometryContext, i: number): number {
  const host = storyOf(ctx, stair.storyId);
  return host.level + stair.baseOffset + (stairTotalRise(stair, ctx) * i) / stair.stepCount;
}

/** The derived roof SLOPE (radians): atan(2·height / span) where span is the
 *  footprint extent PERPENDICULAR to the ridge axis. */
export function roofSlope(roof: RoofEntity): number {
  const extent = roofSpanAndLength(roof);
  return Math.atan((2 * roof.height) / extent.span);
}

/** The roof footprint extents split by the ridge axis: span = the extent
 *  PERPENDICULAR to the ridge (the sloped direction); ridgeLength = the
 *  extent ALONG the ridge. */
export function roofSpanAndLength(roof: RoofEntity): { readonly span: number; readonly ridgeLength: number } {
  const minX = Math.min(roof.corner1[0], roof.corner2[0]);
  const maxX = Math.max(roof.corner1[0], roof.corner2[0]);
  const minY = Math.min(roof.corner1[1], roof.corner2[1]);
  const maxY = Math.max(roof.corner1[1], roof.corner2[1]);
  return roof.ridgeAxis === "x"
    ? { span: maxY - minY, ridgeLength: maxX - minX }
    : { span: maxX - minX, ridgeLength: maxY - minY };
}

/** Roof solid: the gable prism — the gable triangle profile extruded along
 *  the ridge and placed by ONE rigid transform (an exact 90° rotation about
 *  the appropriate plan axis + translation; matrix entries are exactly
 *  0 / ±1 / the coordinates — no trigonometry in the matrix). Deterministic
 *  profile order: base start → base end → apex UP. The corner mapping is
 *  asserted against the analytic gable corners in the P011 test suites. */
export function roofSolid(roof: RoofEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, roof.storyId);
  const minX = Math.min(roof.corner1[0], roof.corner2[0]);
  const maxX = Math.max(roof.corner1[0], roof.corner2[0]);
  const minY = Math.min(roof.corner1[1], roof.corner2[1]);
  const maxY = Math.max(roof.corner1[1], roof.corner2[1]);
  const { span, ridgeLength } = roofSpanAndLength(roof);
  const baseZ = level + roof.baseOffset;
  // The gable triangle profile in the extrude's local space: base start →
  // base end → apex UP (+height). The rigid placement matrix maps
  // (px, py, z) → world so the profile spans the footprint direction
  // PERPENDICULAR to the ridge (rising to the ridge) and the +Z extrusion
  // runs ALONG the ridge. Matrices derived directly from the target corner
  // mapping (orthonormal, det = +1; entries exactly 0/±1/coordinates).
  const profile: readonly Vec2[] = [
    [0, 0],
    [span, 0],
    [span / 2, roof.height],
  ];
  if (roof.ridgeAxis === "x") {
    // (px, py, z) → (minX + z, minY + px, baseZ + py): the section lives in
    // the YZ plane (y ∈ [minY, maxY], apex up), the ridge runs along +X.
    return {
      shape: "transform",
      matrix: [
        0, 0, 1, minX,
        1, 0, 0, minY,
        0, 1, 0, baseZ,
        0, 0, 0, 1,
      ],
      target: { shape: "extrude", profile, height: ridgeLength },
    };
  }
  // ridgeAxis "y": (px, py, z) → (minX + px, minY + z, baseZ + py): the
  // section lives in the XZ plane (x ∈ [minX, maxX], apex up), the ridge
  // runs along +Y.
  return {
    shape: "transform",
    matrix: [
      1, 0, 0, minX,
      0, 0, 1, minY,
      0, 1, 0, baseZ,
      0, 0, 0, 1,
    ],
    target: { shape: "extrude", profile, height: ridgeLength },
  };
}

/** The closed-form roof volume: span · ridgeLength · height / 2. */
export function roofVolume(roof: RoofEntity): number {
  const { span, ridgeLength } = roofSpanAndLength(roof);
  return (span * ridgeLength * roof.height) / 2;
}

/** Fuse an ordered list of descriptors into ONE balanced binary fuse tree
 *  (deterministic structure — the tree is a pure function of the ordered
 *  list; balanced so the descriptor depth stays logarithmic under the
 *  32-level adapter bound). */
export function fuseAll(parts: readonly GeometryDescriptor[]): GeometryDescriptor {
  if (parts.length === 0) throw new Error("fuseAll requires at least one part");
  let level: GeometryDescriptor[] = [...parts];
  while (level.length > 1) {
    const next: GeometryDescriptor[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push({ shape: "fuse", a: level[i]!, b: level[i + 1]! });
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

/** Stair solid: the stacked-boxes canonical form — step i's extrude spans the
 *  tread plan rectangle (story-local, centered on the run axis) and z ∈
 *  [level+baseOffset, stairStepTopZ(i+1)]; the optional top landing spans the
 *  plan beyond the last tread at full height. Face-touching parts only — the
 *  exact fuse holds in both engines. */
export function stairSolid(stair: StairEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const level = storyLevelOf(ctx, stair.storyId);
  const baseZ = level + stair.baseOffset;
  const n = stair.stepCount;
  const [dx, dy] = stair.direction;
  // The run axis frame: u = direction; n̂ = left normal (−u.y, u.x). The run
  // plan is CENTERED on the axis: points start ± n̂·width/2.
  const nx = -dy;
  const ny = dx;
  const halfW = stair.width / 2;
  const corner = (along: number, across: number): Vec2 => [
    stair.start[0] + dx * along + nx * across,
    stair.start[1] + dy * along + ny * across,
  ];
  const parts: GeometryDescriptor[] = [];
  for (let i = 0; i < n; i++) {
    const a = corner(i * stair.tread, -halfW);
    const b = corner((i + 1) * stair.tread, -halfW);
    const c = corner((i + 1) * stair.tread, halfW);
    const d = corner(i * stair.tread, halfW);
    // The step's top z uses the canonical formula — bit-identical everywhere.
    parts.push({
      shape: "extrude",
      profile: [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]]],
      height: stairStepTopZ(stair, ctx, i + 1) - baseZ,
      base: [0, 0, baseZ],
    });
  }
  if (stair.landingLength !== undefined && stair.landingLength > 0) {
    const a = corner(n * stair.tread, -halfW);
    const b = corner(n * stair.tread + stair.landingLength, -halfW);
    const c = corner(n * stair.tread + stair.landingLength, halfW);
    const d = corner(n * stair.tread, halfW);
    parts.push({
      shape: "extrude",
      profile: [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]]],
      height: stairStepTopZ(stair, ctx, n) - baseZ,
      base: [0, 0, baseZ],
    });
  }
  return fuseAll(parts);
}

/** The closed-form stair volume: tread · width · rise · n(n+1)/2 (+ the
 *  landing prism when present). */
export function stairVolume(stair: StairEntity, ctx: BimGeometryContext): number {
  const rise = stairRise(stair, ctx);
  const n = stair.stepCount;
  let volume = stair.tread * stair.width * rise * ((n * (n + 1)) / 2);
  if (stair.landingLength !== undefined && stair.landingLength > 0) {
    volume += stair.landingLength * stair.width * stairTotalRise(stair, ctx);
  }
  return volume;
}

/** Railing solid: (n+1) posts at the step boundaries on the declared side
 *  (square BIM_RAILING_POST_WIDTH section on the walking surface, height =
 *  railing.height) + n sloped handrail segments (one per tread, section
 *  BIM_RAILING_POST_WIDTH across × BIM_RAILING_RAIL_THICKNESS vertical,
 *  bottom face through the post tops along the pitch). Every part pair is
 *  disjoint-or-touching (posts touch their adjacent segments' bottoms at the
 *  boundaries; consecutive segments share end faces) — the exact fuse holds
 *  in both engines. */
export function railingSolid(railing: RailingEntity, ctx: BimGeometryContext): GeometryDescriptor {
  const stair = ctx.stairs.get(railing.hostId);
  if (stair === undefined) {
    throw new Error(`railing '${railing.id}': host stair '${railing.hostId}' does not exist`);
  }
  const level = storyLevelOf(ctx, stair.storyId);
  const baseZ = level + stair.baseOffset;
  const n = stair.stepCount;
  const [dx, dy] = stair.direction;
  const nx = -dy;
  const ny = dx;
  // The side line offset from the run centerline: left = −n̂·width/2,
  // right = +n̂·width/2 (facing the run direction).
  const sideSign = railing.side === "left" ? -1 : 1;
  const across = sideSign * (stair.width / 2);
  const edge = (along: number): Vec2 => [
    stair.start[0] + dx * along + nx * across,
    stair.start[1] + dy * along + ny * across,
  ];
  const pw = BIM_RAILING_POST_WIDTH;
  const railT = BIM_RAILING_RAIL_THICKNESS;
  const railH = railing.height;
  const parts: GeometryDescriptor[] = [];
  // Posts at every step boundary i = 0..n: plan square centered on the edge
  // line (±pw/2 along the run AND across), z ∈ [stepTop(i), stepTop(i)+railH].
  for (let i = 0; i <= n; i++) {
    const p = edge(i * stair.tread);
    const a: Vec2 = [p[0] + dx * (-pw / 2) + nx * (-pw / 2), p[1] + dy * (-pw / 2) + ny * (-pw / 2)];
    const b: Vec2 = [p[0] + dx * (pw / 2) + nx * (-pw / 2), p[1] + dy * (pw / 2) + ny * (-pw / 2)];
    const c: Vec2 = [p[0] + dx * (pw / 2) + nx * (pw / 2), p[1] + dy * (pw / 2) + ny * (pw / 2)];
    const d: Vec2 = [p[0] + dx * (-pw / 2) + nx * (pw / 2), p[1] + dy * (-pw / 2) + ny * (pw / 2)];
    parts.push({
      shape: "extrude",
      profile: [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]]],
      height: railH,
      base: [0, 0, stairStepTopZ(stair, ctx, i)],
    });
  }
  // Handrail segments k = 0..n−1: box(pw across, railT thick, ℓ long along
  // the slope) placed by a rigid transform. Local frame: X = across-run
  // (n̂3), Y = rail thickness direction (û × n̂3), Z = slope direction û.
  // The box corner (0,0,0) maps to the segment's bottom-near corner: at
  // boundary k on the edge line, shifted −n̂3·pw/2 (centered across), z =
  // stepTop(k) + railH.
  const rise = stairRise(stair, ctx);
  const slopeLen = Math.sqrt(stair.tread * stair.tread + rise * rise);
  const uHat: readonly [number, number, number] = [
    (dx * stair.tread) / slopeLen,
    (dy * stair.tread) / slopeLen,
    rise / slopeLen,
  ];
  const nHat: readonly [number, number, number] = [nx, ny, 0];
  // Ŷ = û × n̂ (completes the right-handed frame: X̂ × Ŷ = Ẑ).
  const yHat: readonly [number, number, number] = [
    uHat[1] * nHat[2] - uHat[2] * nHat[1],
    uHat[2] * nHat[0] - uHat[0] * nHat[2],
    uHat[0] * nHat[1] - uHat[1] * nHat[0],
  ];
  for (let k = 0; k < n; k++) {
    const p = edge(k * stair.tread);
    const origin: readonly [number, number, number] = [
      p[0] + nHat[0] * (-pw / 2),
      p[1] + nHat[1] * (-pw / 2),
      stairStepTopZ(stair, ctx, k) + railH,
    ];
    parts.push({
      shape: "transform",
      matrix: [
        nHat[0], yHat[0], uHat[0], origin[0],
        nHat[1], yHat[1], uHat[1], origin[1],
        nHat[2], yHat[2], uHat[2], origin[2],
        0, 0, 0, 1,
      ],
      target: { shape: "box", width: pw, depth: railT, height: slopeLen },
    });
  }
  return fuseAll(parts);
}

/** The closed-form railing volume: (n+1)·pw²·railH + n·ℓ·pw·railT. */
export function railingVolume(railing: RailingEntity, ctx: BimGeometryContext): number {
  const stair = ctx.stairs.get(railing.hostId);
  if (stair === undefined) {
    throw new Error(`railing '${railing.id}': host stair '${railing.hostId}' does not exist`);
  }
  const n = stair.stepCount;
  const rise = stairRise(stair, ctx);
  const slopeLen = Math.sqrt(stair.tread * stair.tread + rise * rise);
  const pw = BIM_RAILING_POST_WIDTH;
  const railT = BIM_RAILING_RAIL_THICKNESS;
  return (n + 1) * pw * pw * railing.height + n * slopeLen * pw * railT;
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
    // --- CAD-PARITY-011 (additive, Issue #97): the Archicad-class authoring
    // solids + the honest no-solid declines. ---
    case "bim.roof":
      return { descriptor: roofSolid(entity, ctx), reason: null };
    case "bim.stair":
      return { descriptor: stairSolid(entity, ctx), reason: null };
    case "bim.railing": {
      if (!ctx.stairs.has(entity.hostId)) {
        return { descriptor: null, reason: `railing '${entity.id}': host stair '${entity.hostId}' does not exist` };
      }
      return { descriptor: railingSolid(entity, ctx), reason: null };
    }
    case "bim.zone":
      return {
        descriptor: null,
        reason: `zone '${entity.id}' is a spatial grouping — member spaces carry the geometry, the zone carries the semantics`,
      };
    case "bim.optionGroup":
      return {
        descriptor: null,
        reason: `option group '${entity.id}' is a lifecycle registry — member elements carry the geometry; the group carries the option vocabulary and the active selection`,
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
    // --- CAD-PARITY-011 (additive): the new authoring solids + declines ---
    case "bim.roof": {
      const level = storyLevelOf(ctx, entity.storyId);
      const minX = Math.min(entity.corner1[0], entity.corner2[0]);
      const maxX = Math.max(entity.corner1[0], entity.corner2[0]);
      const minY = Math.min(entity.corner1[1], entity.corner2[1]);
      const maxY = Math.max(entity.corner1[1], entity.corner2[1]);
      return [
        minX,
        minY,
        level + entity.baseOffset,
        maxX,
        maxY,
        level + entity.baseOffset + entity.height,
      ];
    }
    case "bim.stair": {
      // The run plan corners (axis ± width/2 at both run ends) + the z span
      // [level+baseOffset, stairStepTopZ(n)] — the exact analytic bbox of the
      // stacked-boxes solid + landing (the AABB of the plan corners).
      const level = storyLevelOf(ctx, entity.storyId);
      const [dx, dy] = entity.direction;
      const nx = -dy;
      const ny = dx;
      const halfW = entity.width / 2;
      const runLength = entity.stepCount * entity.tread +
        (entity.landingLength !== undefined ? entity.landingLength : 0);
      const pts: readonly Vec2[] = [
        [entity.start[0] + nx * halfW, entity.start[1] + ny * halfW],
        [entity.start[0] - nx * halfW, entity.start[1] - ny * halfW],
        [entity.start[0] + dx * runLength + nx * halfW, entity.start[1] + dy * runLength + ny * halfW],
        [entity.start[0] + dx * runLength - nx * halfW, entity.start[1] + dy * runLength - ny * halfW],
      ];
      return profileBBox(pts, level + entity.baseOffset, stairStepTopZ(entity, ctx, entity.stepCount));
    }
    case "bim.railing": {
      const stair = ctx.stairs.get(entity.hostId);
      if (stair === undefined) return null;
      const [dx, dy] = stair.direction;
      const nx = -dy;
      const ny = dx;
      const sideSign = entity.side === "left" ? -1 : 1;
      const across = sideSign * (stair.width / 2);
      const pw = BIM_RAILING_POST_WIDTH;
      const railT = BIM_RAILING_RAIL_THICKNESS;
      const runLength = stair.stepCount * stair.tread;
      // EXACT bbox: the posts span boundary ± pw/2 along the run (boundary 0
      // and boundary n) and edge ± pw/2 across; the rails stay inside. The
      // z span runs from the post bases (stepTop(0)) to the top rail's
      // top-far corner: stepTop(n) + railH + railT·(tread/ℓ) — the rail
      // thickness is perpendicular to the slope, so its vertical component
      // is railT·cos(pitch) = railT·tread/ℓ.
      const rise = stairRise(stair, ctx);
      const slopeLen = Math.sqrt(stair.tread * stair.tread + rise * rise);
      const railTop = stairStepTopZ(stair, ctx, stair.stepCount) + entity.height + (railT * stair.tread) / slopeLen;
      const alongs: readonly [number, number][] = [[-pw / 2, across - pw / 2], [-pw / 2, across + pw / 2], [runLength + pw / 2, across - pw / 2], [runLength + pw / 2, across + pw / 2]];
      const pts: readonly Vec2[] = alongs.map(([along, ac]) => [
        stair.start[0] + dx * along + nx * ac,
        stair.start[1] + dy * along + ny * ac,
      ]);
      return profileBBox(pts, stairStepTopZ(stair, ctx, 0), railTop);
    }
    case "bim.zone":
    case "bim.optionGroup":
      return null; // spatial grouping / lifecycle registry — no solid extent
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
