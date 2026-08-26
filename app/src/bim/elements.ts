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

export const BIM_PROPS_MARK = "bim";

export type BimElementType =
  | "bim.story"
  | "bim.wall"
  | "bim.slab"
  | "bim.opening"
  | "bim.door"
  | "bim.window"
  | "bim.space";

/** Hosted BIM element types (reference a host element). */
export type DoorSwing = "left" | "right";

/** Declared tolerance for planar degeneracy checks (mm² for areas). */
export const BIM_AREA_EPS = 1e-9;
/** Declared tolerance for point coincidence (mm). */
export const BIM_COINCIDENCE_EPS = 1e-9;
/** Maximum footprint/profile point count (determinism bound). */
export const BIM_MAX_PROFILE_POINTS = 64;

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
}
export interface WindowEntity extends BimEntityBase {
  readonly type: "bim.window";
  readonly openingId: string;
  readonly storyId: string;
  readonly name?: string;
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
}

export type BimEntity =
  | StoryEntity
  | WallEntity
  | SlabEntity
  | OpeningEntity
  | DoorEntity
  | WindowEntity
  | SpaceEntity;

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

export function makeStory(input: Record<string, unknown>): Omit<StoryEntity, "id"> {
  const name = input.name === undefined ? "" : requireString(input.name, "story.name");
  const level = assertFinite(input.level, "story.level");
  const height = assertPositiveFinite(input.height, "story.height");
  return { type: "bim.story", name, level, height };
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
  return name === undefined
    ? { type: "bim.wall", storyId, start, end, width, height, baseOffset }
    : { type: "bim.wall", storyId, start, end, width, height, baseOffset, name };
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
  return name === undefined
    ? { type: "bim.slab", storyId, corner1, corner2, thickness, baseOffset }
    : { type: "bim.slab", storyId, corner1, corner2, thickness, baseOffset, name };
}

export function makeOpening(input: Record<string, unknown>): Omit<OpeningEntity, "id"> {
  const hostId = requireId(input.hostId, "opening.hostId");
  const distance = assertNonNegativeFinite(input.distance, "opening.distance");
  const width = assertPositiveFinite(input.width, "opening.width");
  const height = assertPositiveFinite(input.height, "opening.height");
  const sill = assertNonNegativeFinite(input.sill, "opening.sill");
  const name = optionalName(input.name, "opening.name");
  return name === undefined
    ? { type: "bim.opening", hostId, distance, width, height, sill }
    : { type: "bim.opening", hostId, distance, width, height, sill, name };
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
  return name === undefined
    ? { type: "bim.door", openingId, storyId, swing, leafThickness }
    : { type: "bim.door", openingId, storyId, swing, leafThickness, name };
}

export function makeWindow(input: Record<string, unknown>): Omit<WindowEntity, "id"> {
  const openingId = requireId(input.openingId, "window.openingId");
  const storyId = requireId(input.storyId, "window.storyId");
  const name = optionalName(input.name, "window.name");
  return name === undefined
    ? { type: "bim.window", openingId, storyId }
    : { type: "bim.window", openingId, storyId, name };
}

export function makeSpace(input: Record<string, unknown>): Omit<SpaceEntity, "id"> {
  const storyId = requireId(input.storyId, "space.storyId");
  const name = requireString(input.name, "space.name");
  if (name.length === 0) throw new Error("space.name must be a non-empty string");
  const footprint = validatePolygon(input.footprint, "space.footprint");
  const height = assertPositiveFinite(input.height, "space.height");
  const baseOffset = input.baseOffset === undefined ? 0 : assertFinite(input.baseOffset, "space.baseOffset");
  const area = polygonArea(footprint);
  return { type: "bim.space", storyId, name, footprint, height, baseOffset, area };
}

// --- Element ⇄ entity mapping --------------------------------------------------

/** Build the CADDocument element for a BIM entity. `id` may be empty — the
 *  DOCUMENT mints the canonical identity on addElement. */
export function bimEntityToElement(entity: BimEntityInput): Element {
  const id = entity.id !== undefined && entity.id.length > 0 ? entity.id : "";
  const props: Record<string, unknown> = { bim: true, type: entity.type };
  switch (entity.type) {
    case "bim.story":
      props.name = entity.name;
      props.level = entity.level;
      props.height = entity.height;
      break;
    case "bim.wall":
      props.storyId = entity.storyId;
      props.start = entity.start;
      props.end = entity.end;
      props.width = entity.width;
      props.height = entity.height;
      props.baseOffset = entity.baseOffset;
      if (entity.name !== undefined) props.name = entity.name;
      break;
    case "bim.slab":
      props.storyId = entity.storyId;
      props.corner1 = entity.corner1;
      props.corner2 = entity.corner2;
      props.thickness = entity.thickness;
      props.baseOffset = entity.baseOffset;
      if (entity.name !== undefined) props.name = entity.name;
      break;
    case "bim.opening":
      props.hostId = entity.hostId;
      props.distance = entity.distance;
      props.width = entity.width;
      props.height = entity.height;
      props.sill = entity.sill;
      if (entity.name !== undefined) props.name = entity.name;
      break;
    case "bim.door":
      props.openingId = entity.openingId;
      props.storyId = entity.storyId;
      props.swing = entity.swing;
      props.leafThickness = entity.leafThickness;
      if (entity.name !== undefined) props.name = entity.name;
      break;
    case "bim.window":
      props.openingId = entity.openingId;
      props.storyId = entity.storyId;
      if (entity.name !== undefined) props.name = entity.name;
      break;
    case "bim.space":
      props.storyId = entity.storyId;
      props.name = entity.name;
      props.footprint = entity.footprint;
      props.height = entity.height;
      props.baseOffset = entity.baseOffset;
      props.area = entity.area;
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
