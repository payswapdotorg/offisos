/**
 * Canonical BIM authoring elements (COMPAT-CAD-002, Issue #39 scope).
 *
 * BIM elements are CADDocument ELEMENTS of kind "bim" whose `props` follow
 * the canonical layout defined here (mirroring the drafting-entity precedent
 * from COMPAT-CAD-001). Element identity stays the canonical document
 * identity (§5.4, LOCK-019); `engineId` is null at authoring time — BIM
 * authoring is engine-free semantic modeling. Geometry is DERIVED
 * deterministically from these properties (src/bim/geometry.ts) and realized
 * through the geometry adapter only when a caller explicitly builds it
 * (bim.buildGeometry); the realized provenance (meshToken + engine record)
 * then lives in props as an immutable, replayable revision.
 *
 * SEMANTICS / GEOMETRY SEPARATION (Issue #39): everything in this module is
 * semantic element state — walls are axes + parameters, spaces are footprints
 * + areas, openings are hosted void parameters. No engine vocabulary appears
 * here (LOCK-018: this core is scanned for forbidden imports).
 *
 * Story model: a story is a LEVEL CONTAINER element. Hosted elements carry
 * their story's id; plan coordinates (start/end, corners, footprints) are
 * STORY-LOCAL XY; world Z = story.level + baseOffset. Moving a story is a
 * single-element edit (level) whose derived geometry follows deterministically.
 *
 * Props layout (per type; every number finite — LOCK-007 rejects otherwise):
 *   bim.story:   { bim, type:"bim.story", name, level, height }
 *   bim.wall:    { bim, type:"bim.wall", storyId, start:[x,y], end:[x,y],
 *                  width, height, baseOffset, name? }
 *   bim.slab:    { bim, type:"bim.slab", storyId, corner1:[x,y], corner2:[x,y],
 *                  thickness, baseOffset, name? }
 *   bim.opening: { bim, type:"bim.opening", hostId, distance, width, height,
 *                  sill, name? }   // hosted void in the host wall's axis frame
 *   bim.door:    { bim, type:"bim.door", openingId, storyId, swing,
 *                  leafThickness, name? }   // fills an opening; no own position
 *   bim.window:  { bim, type:"bim.window", openingId, storyId, name? }
 *   bim.space:   { bim, type:"bim.space", storyId, name, footprint:[[x,y]…≥3],
 *                  height, baseOffset, area }   // area computed at creation
 *
 * Openings are parametrized IN the host wall's axis frame: `distance` is the
 * position of the opening's near edge along the wall axis from `start`;
 * `width`/`height` are the opening clear sizes; `sill` is the base offset
 * above the wall's base. Doors/windows reference the opening and derive all
 * geometry from it (moving the opening moves its fills — no dual
 * bookkeeping).
 */

import type { Element } from "../contracts/caddocument.js";
import type { Vec2 } from "../contracts/geometry.js";
import {
  makeComponentDef,
  makeComponentInstance,
  makeGrid,
  makeMaterial,
  makeReferencePlane,
} from "./components.js";
import type {
  ComponentDefEntity,
  ComponentInstanceEntity,
  GridEntity,
  MaterialEntity,
  ReferencePlaneEntity,
} from "./components.js";
import { validateBimMeta, type BimElementMeta } from "./meta.js";

export const BIM_PROPS_MARK = "bim";

export type BimElementType =
  | "bim.story"
  | "bim.wall"
  | "bim.slab"
  | "bim.opening"
  | "bim.door"
  | "bim.window"
  | "bim.space"
  // COMPAT-BIM-003 (additive): reusable parametric components, materials
  // and model coordination.
  | "bim.componentDef"
  | "bim.componentInstance"
  | "bim.material"
  | "bim.grid"
  | "bim.referencePlane"
  // CAD-PARITY-011 (additive, Issue #97): the bounded Archicad-class
  // authoring expansion — roofs, stairs, railings, zones and the bounded
  // design-option lifecycle registry.
  | "bim.roof"
  | "bim.stair"
  | "bim.railing"
  | "bim.zone"
  | "bim.optionGroup";

/** Hosted BIM element types (reference a host element). */
export type DoorSwing = "left" | "right";

/** Declared tolerance for planar degeneracy checks (mm² for areas). */
export const BIM_AREA_EPS = 1e-9;
/** Declared tolerance for point coincidence (mm). */
export const BIM_COINCIDENCE_EPS = 1e-9;
/** Maximum footprint/profile point count (determinism bound). */
export const BIM_MAX_PROFILE_POINTS = 64;
// --- CAD-PARITY-011 (additive, Issue #97) determinism bounds ------------------
/** Maximum stair riser count per flight (bounded run geometry; determinism
 *  bound on the derived step-solid fuse chain). */
export const BIM_STAIR_MAX_STEPS = 24;
/** Minimum stair riser count (a single riser is a step, not a stair). */
export const BIM_STAIR_MIN_STEPS = 2;
/** Declared canonical railing post cross-section width (mm) — a deterministic
 *  construction constant, not an authored parameter (bounded scope). */
export const BIM_RAILING_POST_WIDTH = 60;
/** Declared canonical railing handrail cross-section thickness (mm). */
export const BIM_RAILING_RAIL_THICKNESS = 60;
/** Declared tolerance for unit-direction normalization checks. */
export const BIM_UNIT_DIR_EPS = 1e-9;
/** Declared minimum zone membership (a zone groups ≥ 1 space). */
export const BIM_ZONE_MIN_SPACES = 1;
/** Declared minimum option-group option count (≥ 2 — one option is not a
 *  design choice). */
export const BIM_OPTION_GROUP_MIN_OPTIONS = 2;
/** Maximum option-group option count (determinism bound). */
export const BIM_OPTION_GROUP_MAX_OPTIONS = 8;

export interface BimEntityBase {
  readonly id: string;
}

export interface StoryEntity extends BimEntityBase {
  readonly type: "bim.story";
  /** Human-readable story name (e.g. "Ground Floor"); may be empty. */
  readonly name: string;
  /** Story base elevation (world Z, mm; may be negative for basements). */
  readonly level: number;
  /** Story height (mm, > 0) — the level container's nominal extent. */
  readonly height: number;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay (structural
   *  data only — stories are level containers, so classification/renovation
   *  eligibility is enforced per-type by validateBimMeta). */
  readonly meta?: BimElementMeta;
}
export interface WallEntity extends BimEntityBase {
  readonly type: "bim.wall";
  /** Host story (must exist while the wall exists). */
  readonly storyId: string;
  /** Wall axis start, story-local XY (mm). */
  readonly start: Vec2;
  /** Wall axis end, story-local XY (mm); must differ from start. */
  readonly end: Vec2;
  /** Wall thickness (mm, > 0). */
  readonly width: number;
  /** Wall height (mm, > 0). */
  readonly height: number;
  /** Base offset above the story level (mm, finite; typically 0). */
  readonly baseOffset: number;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}
export interface SlabEntity extends BimEntityBase {
  readonly type: "bim.slab";
  readonly storyId: string;
  /** Axis-aligned footprint corners, story-local XY (non-degenerate). */
  readonly corner1: Vec2;
  readonly corner2: Vec2;
  /** Slab thickness (mm, > 0). */
  readonly thickness: number;
  readonly baseOffset: number;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}
export interface OpeningEntity extends BimEntityBase {
  readonly type: "bim.opening";
  /** Host wall id. */
  readonly hostId: string;
  /** Near-edge position along the host wall axis from `start` (mm, ≥ 0). */
  readonly distance: number;
  /** Clear width along the host wall axis (mm, > 0). */
  readonly width: number;
  /** Clear height (mm, > 0). */
  readonly height: number;
  /** Base offset above the wall base (mm, ≥ 0). */
  readonly sill: number;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}
export interface DoorEntity extends BimEntityBase {
  readonly type: "bim.door";
  /** The filled opening (geometry derives from it). */
  readonly openingId: string;
  /** Derived at creation from the opening's host wall (query convenience). */
  readonly storyId: string;
  readonly swing: DoorSwing;
  /** Door leaf thickness (mm, > 0; default 40). */
  readonly leafThickness: number;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}
export interface WindowEntity extends BimEntityBase {
  readonly type: "bim.window";
  readonly openingId: string;
  readonly storyId: string;
  readonly name?: string;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}
export interface SpaceEntity extends BimEntityBase {
  readonly type: "bim.space";
  readonly storyId: string;
  /** Non-empty space name (spaces are named semantic objects). */
  readonly name: string;
  /** Simple polygon footprint, story-local XY, implicitly closed. */
  readonly footprint: readonly Vec2[];
  readonly height: number;
  readonly baseOffset: number;
  /** Footprint area (mm²) — shoelace magnitude, computed at creation. */
  readonly area: number;
  /** CAD-PARITY-011: the cross-cutting semantic meta overlay. */
  readonly meta?: BimElementMeta;
}

// --- CAD-PARITY-011 (additive, Issue #97): the bounded Archicad-class
// authoring entities — roofs, stairs, railings, zones and the bounded
// design-option lifecycle registry. -----------------------------------------

/** The plan axis a roof ridge runs parallel to (deterministic — no
 *  footprint-shape-dependent ambiguity). */
export type RoofRidgeAxis = "x" | "y";

/** A parametric gable roof: the solid is the full triangular-prism volume
 *  between the eaves plane and the two roof slopes (the material
 *  layered/slope-shell modeling is OUT of the bounded scope — declared
 *  limitation, never silently approximated). */
export interface RoofEntity extends BimEntityBase {
  readonly type: "bim.roof";
  /** Host story — the story whose level anchors the eaves base. */
  readonly storyId: string;
  /** Axis-aligned footprint corners, story-local XY (non-degenerate). */
  readonly corner1: Vec2;
  readonly corner2: Vec2;
  /** The plan axis the ridge line runs parallel to. */
  readonly ridgeAxis: RoofRidgeAxis;
  /** Ridge height above the eaves base (mm, > 0). The slope is DERIVED
   *  (atan(2·height/span) perpendicular to the ridge) — never authored. */
  readonly height: number;
  /** Eaves base offset above the host story level (mm, finite). */
  readonly baseOffset: number;
  /** Optional reference story the roof spans TO (the explicit vertical
   *  relationship): strictly above the host story, and the ridge must
   *  REACH OR EXCEED its level (validated at authoring AND re-validated
   *  whenever either story's level is edited — the stronger host/story
   *  relationship). */
  readonly topStoryId?: string;
  readonly name?: string;
  readonly meta?: BimElementMeta;
}

/** Which side of a stair run a railing occupies, facing the run direction
 *  ("left" = the −normal side of the run axis, "right" = +normal). */
export type RailingSide = "left" | "right";

/** A straight single-flight stair connecting two stories: the total rise is
 *  DERIVED from the story levels (LOCK-007 — derived state is never
 *  authored), the riser height = rise / stepCount (derived), and each step
 *  solid spans the full height below its tread (the stacked-boxes canonical
 *  form; volume = tread · width · rise · n(n+1)/2 in closed form). */
export interface StairEntity extends BimEntityBase {
  readonly type: "bim.stair";
  /** The story the stair STARTS at (bottom). */
  readonly storyId: string;
  /** The story the stair ENDS at (top landing level — the vertical
   *  relationship; total rise = topStory.level − story.level − baseOffset). */
  readonly topStoryId: string;
  /** Bottom step start point on the run CENTERLINE, story-local XY. */
  readonly start: Vec2;
  /** Unit run direction, story-local XY (‖direction‖ = 1; arbitrary heading). */
  readonly direction: Vec2;
  /** Stair width across the run (mm, > 0; the run is centered on the axis). */
  readonly width: number;
  /** Number of risers (BIM_STAIR_MIN_STEPS..BIM_STAIR_MAX_STEPS). */
  readonly stepCount: number;
  /** Tread depth per step along the run direction (mm, > 0). */
  readonly tread: number;
  /** Bottom offset above the host story level (mm, finite; consumes part of
   *  the story delta — the derived rise must stay > 0). */
  readonly baseOffset: number;
  /** Optional top landing platform length beyond the last tread (mm, ≥ 0;
   *  0/absent = no landing — the bounded landing geometry). */
  readonly landingLength?: number;
  readonly name?: string;
  readonly meta?: BimElementMeta;
}

/** A balustrade railing hosted on a stair: posts at every step boundary
 *  (BIM_RAILING_POST_WIDTH square section) + one sloped handrail segment per
 *  tread (BIM_RAILING_RAIL_THICKNESS section) at the declared handrail
 *  height above the walking surface. The ENTIRE geometry derives from the
 *  host stair — placement/propagation is deterministic (moving/editing the
 *  stair moves/re-derives the railing; no dual bookkeeping). */
export interface RailingEntity extends BimEntityBase {
  readonly type: "bim.railing";
  /** The host stair. */
  readonly hostId: string;
  /** Which side of the run (facing the run direction). */
  readonly side: RailingSide;
  /** Handrail height above the walking surface (mm, > 0). */
  readonly height: number;
  readonly name?: string;
  readonly meta?: BimElementMeta;
}

/** A zone: a named spatial grouping of spaces (the IfcZone precedent —
 *  membership lives ON the zone, so a space may join several zones). The
 *  zone's story relationships are DERIVED from the member spaces (never
 *  stored — LOCK-007) and participate in the vertical semantics. */
export interface ZoneEntity extends BimEntityBase {
  readonly type: "bim.zone";
  /** Zone name (non-empty — zones are named semantic groupings). */
  readonly name: string;
  /** Member space ids (BIM_ZONE_MIN_SPACES.., unique, all bim.space). */
  readonly spaceIds: readonly string[];
  readonly meta?: BimElementMeta;
}

/** A design-option group: the bounded lifecycle registry for design-option
 *  membership. Elements reference (optionGroupId, option) through the meta
 *  overlay; the group declares the option vocabulary and the ACTIVE option
 *  (deterministic active-option behavior — queries/builds skip inactive
 *  members with explicit reasons; NOTHING is ever duplicated or destroyed). */
export interface OptionGroupEntity extends BimEntityBase {
  readonly type: "bim.optionGroup";
  /** Group name (non-empty). */
  readonly name: string;
  /** The declared options (BIM_OPTION_GROUP_MIN_OPTIONS..MAX distinct
   *  non-empty names — the closed vocabulary members reference). */
  readonly options: readonly string[];
  /** The currently active option (∈ options; the deterministic selection). */
  readonly activeOption: string;
  readonly description?: string;
  readonly meta?: BimElementMeta;
}

export type BimEntity =
  | StoryEntity
  | WallEntity
  | SlabEntity
  | OpeningEntity
  | DoorEntity
  | WindowEntity
  | SpaceEntity
  // COMPAT-BIM-003 (additive).
  | ComponentDefEntity
  | ComponentInstanceEntity
  | MaterialEntity
  | GridEntity
  | ReferencePlaneEntity
  // CAD-PARITY-011 (additive, Issue #97).
  | RoofEntity
  | StairEntity
  | RailingEntity
  | ZoneEntity
  | OptionGroupEntity;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type BimEntityInput = DistributiveOmit<BimEntity, "id"> & { id?: string };

// --- Shared strict value helpers (LOCK-007: reject, never guess) -------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function assertFinite(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new Error(`${path} must be a finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertPositiveFinite(value: unknown, path: string): number {
  const n = assertFinite(value, path);
  if (n <= 0) throw new Error(`${path} must be > 0 (got ${n})`);
  return n;
}

function assertNonNegativeFinite(value: unknown, path: string): number {
  const n = assertFinite(value, path);
  if (n < 0) throw new Error(`${path} must be ≥ 0 (got ${n})`);
  return n;
}

export function assertVec2(value: unknown, path: string): Vec2 {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber)) {
    throw new Error(`${path} must be [x, y] finite numbers`);
  }
  return [value[0] as number, value[1] as number];
}

function optionalName(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string when present`);
  return value;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty element id`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

/** Shoelace area magnitude of an implicitly-closed polygon (mm²). */
export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % n] as Vec2;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** Validate a planar footprint/profile polygon: ≥ 3 finite points, no
 *  consecutive coincident points, first point not repeated at the end
 *  (implicit closure), non-degenerate shoelace area. Self-intersection is a
 *  declared assumption (simple polygon required); engines reject invalid
 *  constructions at realization time with typed failures. */
export function validatePolygon(value: unknown, path: string): readonly Vec2[] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${path} must be an array of at least 3 points`);
  }
  if (value.length > BIM_MAX_PROFILE_POINTS) {
    throw new Error(`${path} exceeds the ${BIM_MAX_PROFILE_POINTS}-point bound`);
  }
  const points = value.map((p, i) => assertVec2(p, `${path}[${i}]`));
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    if (Math.sqrt(dx * dx + dy * dy) <= BIM_COINCIDENCE_EPS) {
      throw new Error(`${path}: point ${i % points.length} coincides with its successor (implicit closure — do not repeat the first point at the end)`);
    }
  }
  if (polygonArea(points) <= BIM_AREA_EPS) {
    throw new Error(`${path} must span a non-degenerate area (shoelace magnitude > ${BIM_AREA_EPS})`);
  }
  return points;
}

// --- Construction + validation (deterministic; first failure wins) -----------

/** The validated meta overlay of an entity input, spread into the built
 *  entity (CAD-PARITY-011) — absent when the input carries no overlay. */
function metaField(type: BimElementType, input: Record<string, unknown>, path: string): { meta?: BimElementMeta } {
  const meta = validateBimMeta(type, input.meta, path);
  return meta === undefined ? {} : { meta };
}

export function makeStory(input: Record<string, unknown>): Omit<StoryEntity, "id"> {
  const name = input.name === undefined ? "" : requireString(input.name, "story.name");
  const level = assertFinite(input.level, "story.level");
  const height = assertPositiveFinite(input.height, "story.height");
  return { type: "bim.story", name, level, height, ...metaField("bim.story", input, "story.meta") };
}

export function makeWall(input: Record<string, unknown>): Omit<WallEntity, "id"> {
  const storyId = requireId(input.storyId, "wall.storyId");
  const start = assertVec2(input.start, "wall.start");
  const end = assertVec2(input.end, "wall.end");
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (Math.sqrt(dx * dx + dy * dy) <= BIM_COINCIDENCE_EPS) {
    throw new Error("wall.start and wall.end must not coincide (zero-length walls are rejected)");
  }
  const width = assertPositiveFinite(input.width, "wall.width");
  const height = assertPositiveFinite(input.height, "wall.height");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "wall.baseOffset");
  const name = optionalName(input.name, "wall.name");
  const meta = metaField("bim.wall", input, "wall.meta");
  return name === undefined
    ? { type: "bim.wall", storyId, start, end, width, height, baseOffset, ...meta }
    : { type: "bim.wall", storyId, start, end, width, height, baseOffset, name, ...meta };
}

export function makeSlab(input: Record<string, unknown>): Omit<SlabEntity, "id"> {
  const storyId = requireId(input.storyId, "slab.storyId");
  const corner1 = assertVec2(input.corner1, "slab.corner1");
  const corner2 = assertVec2(input.corner2, "slab.corner2");
  const w = Math.abs(corner1[0] - corner2[0]);
  const h = Math.abs(corner1[1] - corner2[1]);
  if (w <= BIM_COINCIDENCE_EPS || h <= BIM_COINCIDENCE_EPS) {
    throw new Error("slab corners must span a non-degenerate axis-aligned area (zero width/height rejected)");
  }
  const thickness = assertPositiveFinite(input.thickness, "slab.thickness");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "slab.baseOffset");
  const name = optionalName(input.name, "slab.name");
  const meta = metaField("bim.slab", input, "slab.meta");
  return name === undefined
    ? { type: "bim.slab", storyId, corner1, corner2, thickness, baseOffset, ...meta }
    : { type: "bim.slab", storyId, corner1, corner2, thickness, baseOffset, name, ...meta };
}

export function makeOpening(input: Record<string, unknown>): Omit<OpeningEntity, "id"> {
  const hostId = requireId(input.hostId, "opening.hostId");
  const distance = assertNonNegativeFinite(input.distance, "opening.distance");
  const width = assertPositiveFinite(input.width, "opening.width");
  const height = assertPositiveFinite(input.height, "opening.height");
  const sill = assertNonNegativeFinite(input.sill, "opening.sill");
  const name = optionalName(input.name, "opening.name");
  const meta = metaField("bim.opening", input, "opening.meta");
  return name === undefined
    ? { type: "bim.opening", hostId, distance, width, height, sill, ...meta }
    : { type: "bim.opening", hostId, distance, width, height, sill, name, ...meta };
}

export function makeDoor(input: Record<string, unknown>): Omit<DoorEntity, "id"> {
  const openingId = requireId(input.openingId, "door.openingId");
  const storyId = requireId(input.storyId, "door.storyId");
  const swing = input.swing === undefined ? "left" : input.swing;
  if (swing !== "left" && swing !== "right") {
    throw new Error("door.swing must be 'left' | 'right'");
  }
  const leafThickness = input.leafThickness === undefined ? 40 : assertPositiveFinite(input.leafThickness, "door.leafThickness");
  const name = optionalName(input.name, "door.name");
  const meta = metaField("bim.door", input, "door.meta");
  return name === undefined
    ? { type: "bim.door", openingId, storyId, swing, leafThickness, ...meta }
    : { type: "bim.door", openingId, storyId, swing, leafThickness, name, ...meta };
}

export function makeWindow(input: Record<string, unknown>): Omit<WindowEntity, "id"> {
  const openingId = requireId(input.openingId, "window.openingId");
  const storyId = requireId(input.storyId, "window.storyId");
  const name = optionalName(input.name, "window.name");
  const meta = metaField("bim.window", input, "window.meta");
  return name === undefined
    ? { type: "bim.window", openingId, storyId, ...meta }
    : { type: "bim.window", openingId, storyId, name, ...meta };
}

export function makeSpace(input: Record<string, unknown>): Omit<SpaceEntity, "id"> {
  const storyId = requireId(input.storyId, "space.storyId");
  const name = requireString(input.name, "space.name");
  if (name.length === 0) throw new Error("space.name must be a non-empty string");
  const footprint = validatePolygon(input.footprint, "space.footprint");
  const height = assertPositiveFinite(input.height, "space.height");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "space.baseOffset");
  const area = polygonArea(footprint);
  return { type: "bim.space", storyId, name, footprint, height, baseOffset, area, ...metaField("bim.space", input, "space.meta") };
}

// --- CAD-PARITY-011 (additive, Issue #97): the bounded Archicad-class
// authoring constructors. Cross-ELEMENT references (story existence/order,
// the roof's story-reach, the railing's host, the zone's spaces, the option
// group registry) are resolved at the command layer — the constructors
// validate the per-entity STRUCTURE deterministically (first failure wins).

/** The axis-aligned footprint extent helper (min/max over the corners). */
function axisExtent(corner1: Vec2, corner2: Vec2): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(corner1[0], corner2[0]),
    minY: Math.min(corner1[1], corner2[1]),
    maxX: Math.max(corner1[0], corner2[0]),
    maxY: Math.max(corner1[1], corner2[1]),
  };
}

export function makeRoof(input: Record<string, unknown>): Omit<RoofEntity, "id"> {
  const storyId = requireId(input.storyId, "roof.storyId");
  const corner1 = assertVec2(input.corner1, "roof.corner1");
  const corner2 = assertVec2(input.corner2, "roof.corner2");
  const extent = axisExtent(corner1, corner2);
  if (extent.maxX - extent.minX <= BIM_COINCIDENCE_EPS || extent.maxY - extent.minY <= BIM_COINCIDENCE_EPS) {
    throw new Error("roof corners must span a non-degenerate axis-aligned area (zero width/depth rejected)");
  }
  const ridgeAxis = input.ridgeAxis === undefined ? "x" : input.ridgeAxis;
  if (ridgeAxis !== "x" && ridgeAxis !== "y") {
    throw new Error("roof.ridgeAxis must be 'x' | 'y' (the plan axis the ridge runs parallel to)");
  }
  const height = assertPositiveFinite(input.height, "roof.height");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "roof.baseOffset");
  const topStoryId = input.topStoryId === undefined ? undefined : requireId(input.topStoryId, "roof.topStoryId");
  const name = optionalName(input.name, "roof.name");
  const meta = metaField("bim.roof", input, "roof.meta");
  const base: Omit<RoofEntity, "id"> = {
    type: "bim.roof",
    storyId,
    corner1: [corner1[0], corner1[1]],
    corner2: [corner2[0], corner2[1]],
    ridgeAxis,
    height,
    baseOffset,
    ...(topStoryId !== undefined ? { topStoryId } : {}),
    ...meta,
  };
  return name === undefined ? base : { ...base, name };
}

/** Validate a unit plan direction (‖d‖ = 1 within the declared tolerance). */
export function assertUnitDirection(value: unknown, path: string): Vec2 {
  const d = assertVec2(value, path);
  const norm = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
  if (Math.abs(norm - 1) > BIM_UNIT_DIR_EPS) {
    throw new Error(`${path} must be a unit vector (length 1, got ${norm}) — normalize before authoring (no silent normalization)`);
  }
  return [d[0], d[1]];
}

export function makeStair(input: Record<string, unknown>): Omit<StairEntity, "id"> {
  const storyId = requireId(input.storyId, "stair.storyId");
  const topStoryId = requireId(input.topStoryId, "stair.topStoryId");
  const start = assertVec2(input.start, "stair.start");
  const direction = assertUnitDirection(input.direction, "stair.direction");
  const width = assertPositiveFinite(input.width, "stair.width");
  const stepCount = assertFinite(input.stepCount, "stair.stepCount");
  if (!Number.isInteger(stepCount) || stepCount < BIM_STAIR_MIN_STEPS || stepCount > BIM_STAIR_MAX_STEPS) {
    throw new Error(`stair.stepCount must be an integer between ${BIM_STAIR_MIN_STEPS} and ${BIM_STAIR_MAX_STEPS} (got ${stepCount}) — the bounded single-flight run`);
  }
  const tread = assertPositiveFinite(input.tread, "stair.tread");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "stair.baseOffset");
  const landingLength = input.landingLength === undefined ? undefined : assertNonNegativeFinite(input.landingLength, "stair.landingLength");
  const name = optionalName(input.name, "stair.name");
  const meta = metaField("bim.stair", input, "stair.meta");
  const base: Omit<StairEntity, "id"> = {
    type: "bim.stair",
    storyId,
    topStoryId,
    start: [start[0], start[1]],
    direction,
    width,
    stepCount,
    tread,
    baseOffset,
    ...(landingLength !== undefined && landingLength > 0 ? { landingLength } : {}),
    ...meta,
  };
  return name === undefined ? base : { ...base, name };
}

export function makeRailing(input: Record<string, unknown>): Omit<RailingEntity, "id"> {
  const hostId = requireId(input.hostId, "railing.hostId");
  const side = input.side === undefined ? "left" : input.side;
  if (side !== "left" && side !== "right") {
    throw new Error("railing.side must be 'left' | 'right' (facing the host stair's run direction)");
  }
  const height = assertPositiveFinite(input.height, "railing.height");
  const name = optionalName(input.name, "railing.name");
  const meta = metaField("bim.railing", input, "railing.meta");
  return name === undefined
    ? { type: "bim.railing", hostId, side, height, ...meta }
    : { type: "bim.railing", hostId, side, height, name, ...meta };
}

export function makeZone(input: Record<string, unknown>): Omit<ZoneEntity, "id"> {
  const name = requireString(input.name, "zone.name");
  if (name.length === 0) throw new Error("zone.name must be a non-empty string");
  if (!Array.isArray(input.spaceIds)) {
    throw new Error("zone.spaceIds must be an array of space element ids");
  }
  const spaceIds = input.spaceIds.map((id, i) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`zone.spaceIds[${i}] must be a non-empty element id`);
    }
    return id;
  });
  if (spaceIds.length < BIM_ZONE_MIN_SPACES) {
    throw new Error(`zone.spaceIds must reference at least ${BIM_ZONE_MIN_SPACES} space (a zone groups spaces — got ${spaceIds.length})`);
  }
  const unique = new Set(spaceIds);
  if (unique.size !== spaceIds.length) {
    throw new Error("zone.spaceIds must not repeat a space (duplicate membership is rejected)");
  }
  return { type: "bim.zone", name, spaceIds, ...metaField("bim.zone", input, "zone.meta") };
}

export function makeOptionGroup(input: Record<string, unknown>): Omit<OptionGroupEntity, "id"> {
  const name = requireString(input.name, "optionGroup.name");
  if (name.length === 0) throw new Error("optionGroup.name must be a non-empty string");
  if (!Array.isArray(input.options)) {
    throw new Error("optionGroup.options must be an array of option names");
  }
  const options = input.options.map((o, i) => {
    if (typeof o !== "string" || o.length === 0) {
      throw new Error(`optionGroup.options[${i}] must be a non-empty string`);
    }
    return o;
  });
  if (options.length < BIM_OPTION_GROUP_MIN_OPTIONS) {
    throw new Error(`optionGroup.options must declare at least ${BIM_OPTION_GROUP_MIN_OPTIONS} options (a design choice needs alternatives — got ${options.length})`);
  }
  if (options.length > BIM_OPTION_GROUP_MAX_OPTIONS) {
    throw new Error(`optionGroup.options exceeds the ${BIM_OPTION_GROUP_MAX_OPTIONS}-option bound (got ${options.length})`);
  }
  const unique = new Set(options);
  if (unique.size !== options.length) {
    throw new Error("optionGroup.options must not repeat an option name (distinct alternatives)");
  }
  const activeOption = requireString(input.activeOption, "optionGroup.activeOption");
  if (!unique.has(activeOption)) {
    throw new Error(`optionGroup.activeOption '${activeOption}' must be one of the declared options (${options.join(", ")})`);
  }
  const description = optionalName(input.description, "optionGroup.description");
  const meta = metaField("bim.optionGroup", input, "optionGroup.meta");
  const base: Omit<OptionGroupEntity, "id"> = { type: "bim.optionGroup", name, options, activeOption, ...meta };
  return description === undefined ? base : { ...base, description };
}

// --- Element ⇄ entity mapping --------------------------------------------------

/** Build the CADDocument element for a BIM entity. `id` may be empty — the
 *  DOCUMENT mints the canonical identity on addElement. */
export function bimEntityToElement(entity: BimEntityInput): Element {
  const id = entity.id !== undefined && entity.id.length > 0 ? entity.id : "";
  const props: Record<string, unknown> = { bim: true, type: entity.type };
  const setMeta = (e: { meta?: unknown }): void => {
    if (e.meta !== undefined) props.meta = e.meta;
  };
  switch (entity.type) {
    case "bim.story":
      props.name = entity.name;
      props.level = entity.level;
      props.height = entity.height;
      setMeta(entity);
      break;
    case "bim.wall":
      props.storyId = entity.storyId;
      props.start = entity.start;
      props.end = entity.end;
      props.width = entity.width;
      props.height = entity.height;
      props.baseOffset = entity.baseOffset;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.slab":
      props.storyId = entity.storyId;
      props.corner1 = entity.corner1;
      props.corner2 = entity.corner2;
      props.thickness = entity.thickness;
      props.baseOffset = entity.baseOffset;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.opening":
      props.hostId = entity.hostId;
      props.distance = entity.distance;
      props.width = entity.width;
      props.height = entity.height;
      props.sill = entity.sill;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.door":
      props.openingId = entity.openingId;
      props.storyId = entity.storyId;
      props.swing = entity.swing;
      props.leafThickness = entity.leafThickness;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.window":
      props.openingId = entity.openingId;
      props.storyId = entity.storyId;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.space":
      props.storyId = entity.storyId;
      props.name = entity.name;
      props.footprint = entity.footprint;
      props.height = entity.height;
      props.baseOffset = entity.baseOffset;
      props.area = entity.area;
      setMeta(entity);
      break;
    // --- COMPAT-BIM-003 (additive): components / materials / coordination ---
    case "bim.componentDef":
      props.name = entity.name;
      props.category = entity.category;
      props.parameters = entity.parameters;
      if (entity.materialId !== undefined) props.materialId = entity.materialId;
      setMeta(entity);
      break;
    case "bim.componentInstance":
      props.definitionId = entity.definitionId;
      props.storyId = entity.storyId;
      props.position = entity.position;
      props.rotation = entity.rotation;
      props.baseOffset = entity.baseOffset;
      props.overrides = entity.overrides;
      if (entity.materialId !== undefined) props.materialId = entity.materialId;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.material":
      props.name = entity.name;
      if (entity.description !== undefined) props.description = entity.description;
      if (entity.color !== undefined) props.color = entity.color;
      props.properties = entity.properties;
      // CAD-PARITY-012 (additive parity fields): written ONLY when set so
      // pre-P012 snapshots stay byte-identical (absence = canonical default
      // form, never an undefined value).
      if (entity.category !== undefined) props.category = entity.category;
      if (entity.lineweight !== undefined) props.lineweight = entity.lineweight;
      if (entity.density !== undefined) props.density = entity.density;
      setMeta(entity);
      break;
    case "bim.grid":
      props.storyId = entity.storyId;
      props.name = entity.name;
      props.uLines = entity.uLines;
      props.vLines = entity.vLines;
      setMeta(entity);
      break;
    case "bim.referencePlane":
      props.storyId = entity.storyId;
      props.name = entity.name;
      props.start = entity.start;
      props.end = entity.end;
      setMeta(entity);
      break;
    // --- CAD-PARITY-011 (additive, Issue #97): the bounded Archicad-class
    // authoring entities. ---
    case "bim.roof":
      props.storyId = entity.storyId;
      props.corner1 = entity.corner1;
      props.corner2 = entity.corner2;
      props.ridgeAxis = entity.ridgeAxis;
      props.height = entity.height;
      props.baseOffset = entity.baseOffset;
      if (entity.topStoryId !== undefined) props.topStoryId = entity.topStoryId;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.stair":
      props.storyId = entity.storyId;
      props.topStoryId = entity.topStoryId;
      props.start = entity.start;
      props.direction = entity.direction;
      props.width = entity.width;
      props.stepCount = entity.stepCount;
      props.tread = entity.tread;
      props.baseOffset = entity.baseOffset;
      if (entity.landingLength !== undefined) props.landingLength = entity.landingLength;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.railing":
      props.hostId = entity.hostId;
      props.side = entity.side;
      props.height = entity.height;
      if (entity.name !== undefined) props.name = entity.name;
      setMeta(entity);
      break;
    case "bim.zone":
      props.name = entity.name;
      props.spaceIds = entity.spaceIds;
      setMeta(entity);
      break;
    case "bim.optionGroup":
      props.name = entity.name;
      props.options = entity.options;
      props.activeOption = entity.activeOption;
      if (entity.description !== undefined) props.description = entity.description;
      setMeta(entity);
      break;
  }
  return { id, kind: "bim", engineId: null, props };
}

/** Soft check: is this element a BIM authoring element? */
export function isBimElement(el: Element): boolean {
  const p = el.props as Record<string, unknown>;
  return (
    p !== null && typeof p === "object" &&
    p[BIM_PROPS_MARK] === true &&
    typeof p.type === "string" &&
    (p.type as string).startsWith("bim.")
  );
}

/** Strict parse of a BIM element (LOCK-007: throws on malformed props).
 *  Re-validated through the same constructors — no trusting stored props. */
export function elementToBimEntity(el: Element): BimEntity {
  if (!isBimElement(el)) {
    throw new Error(`element '${el.id}' is not a BIM authoring element`);
  }
  const p = el.props as Record<string, unknown>;
  const base = { id: el.id };
  switch (p.type) {
    case "bim.story":
      return { ...base, ...makeStory(p) };
    case "bim.wall":
      return { ...base, ...makeWall(p) };
    case "bim.slab":
      return { ...base, ...makeSlab(p) };
    case "bim.opening":
      return { ...base, ...makeOpening(p) };
    case "bim.door":
      return { ...base, ...makeDoor(p) };
    case "bim.window":
      return { ...base, ...makeWindow(p) };
    case "bim.space":
      return { ...base, ...makeSpace(p) };
    // --- COMPAT-BIM-003 (additive): strict re-validation through the same
    // constructors (instance overrides validate structurally here; the
    // definition-schema cross-check happens at the command/query layer). ---
    case "bim.componentDef":
      return { ...base, ...makeComponentDef(p) };
    case "bim.componentInstance":
      return { ...base, ...makeComponentInstance(p) };
    case "bim.material":
      return { ...base, ...makeMaterial(p) };
    case "bim.grid":
      return { ...base, ...makeGrid(p) };
    case "bim.referencePlane":
      return { ...base, ...makeReferencePlane(p) };
    // --- CAD-PARITY-011 (additive, Issue #97): strict re-validation through
    // the same constructors (the meta overlay re-validates structurally;
    // cross-element references are the command layer's authority). ---
    case "bim.roof":
      return { ...base, ...makeRoof(p) };
    case "bim.stair":
      return { ...base, ...makeStair(p) };
    case "bim.railing":
      return { ...base, ...makeRailing(p) };
    case "bim.zone":
      return { ...base, ...makeZone(p) };
    case "bim.optionGroup":
      return { ...base, ...makeOptionGroup(p) };
    default:
      throw new Error(`element '${el.id}': unknown BIM element type '${String(p.type)}'`);
  }
}

/** Soft parse: a BIM entity, or null for non-BIM elements (throws never). */
export function elementToBimEntitySafe(el: Element): BimEntity | null {
  if (!isBimElement(el)) return null;
  try {
    return elementToBimEntity(el);
  } catch {
    return null;
  }
}
