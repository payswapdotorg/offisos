/**
 * CAD-PARITY-018 (Issue #118) — the architecture toolset: pure
 * composition builders over the VERIFIED BIM primitives (COMPAT-CAD-002
 * + CAD-PARITY-011). Every builder is engine-free (LOCK-018) and emits
 * EXACTLY the entity-input batches the existing `bim.createElements` /
 * `drafting.createEntities` paths validate and apply (buildBimCreate /
 * buildDraftingCreate) — the same strict constructors, the same reference
 * resolution, the same host/story relationship checks. There is NO
 * parallel element semantics and no fabricated geometry here: the
 * unsupported sub-cases are typed declines (LOCK-007).
 *
 * Identity discipline (§5.4): element identities stay DOCUMENT-OWNED.
 * Entities that need IN-BATCH references (junction openings → their host
 * wall; railings → their host stair; doors/windows → their opening)
 * receive PRE-MINTED canonical ids the caller passes in (`el-NNNNNN`
 * minted through CADDocument.mintElementId — the docs.addAnnotations /
 * bim.copy precedent for composite batches inside ONE atomic revision).
 * Entities with no in-batch references carry NO id — the document mints
 * on apply. The toolset never invents identity schemes.
 *
 * Determinism: per-segment name suffixes, junction placement, railing
 * sides/offsets, grid naming (prefix-<col>-<row>) and array cell offsets
 * are fixed formulas — repeated execution over identical inputs yields
 * byte-identical batches.
 */

import {
  TOOLSETS_MAX_ARRAY_CELLS,
  TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS,
  TOOLSETS_MAX_DIM_POINTS,
  TOOLSETS_MAX_GRID_CELLS,
  TOOLSETS_MAX_POLYLINE_VERTICES,
} from "../contracts/toolsets.js";
import { toolsetErr } from "./errors.js";

// ---------------------------------------------------------------------------
// Shared strict value helpers.
// ---------------------------------------------------------------------------

/** The toolsets' 2D point grammar (wire form). */
export interface ToolsetPoint2 {
  readonly x: number;
  readonly y: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requirePoint2(value: unknown, path: string): { x: number; y: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw toolsetErr("toolset_bad_payload", `${path} must be { x, y }`);
  }
  const p = value as Record<string, unknown>;
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
    throw toolsetErr("toolset_bad_payload", `${path}.x/.y must be finite numbers`);
  }
  return { x: p.x as number, y: p.y as number };
}

function requirePositiveFinite(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || (value as number) <= 0) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a finite number > 0`);
  }
  return value as number;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || (value as number) < 0) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a finite number ≥ 0`);
  }
  return value as number;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a non-empty id`);
  }
  return value;
}

function optionalBoundedString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw toolsetErr("toolset_bad_payload", `${path} must be a string when present`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw toolsetErr("toolset_bad_payload", `${path} must be a trimmed non-empty string (max ${max} chars)`);
  }
  return trimmed;
}

/** Validate a polyline: 2..64 points, finite, no coincident neighbors. */
function requirePolyline(value: unknown, path: string): readonly { x: number; y: number }[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw toolsetErr("toolset_bad_payload", `${path} must be an array of at least 2 points`);
  }
  if (value.length > TOOLSETS_MAX_POLYLINE_VERTICES) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `${path} exceeds the ${TOOLSETS_MAX_POLYLINE_VERTICES}-vertex bound (got ${value.length})`,
    );
  }
  const points = value.map((raw, i) => requirePoint2(raw, `${path}[${i}]`));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x === b.x && a.y === b.y) {
      throw toolsetErr("toolset_bad_payload", `${path}[${i}] coincides with ${path}[${i - 1}] (zero-length segment)`);
    }
  }
  return points;
}

/** Validate a cols/rows array extent (per-axis + total cell bounds). */
function requireGridExtent(cols: unknown, rows: unknown, path: string): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) {
    throw toolsetErr("toolset_bad_payload", `${path} cols/rows must be integers ≥ 1`);
  }
  const c = cols as number;
  const r = rows as number;
  if (c > TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS || r > TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `${path} exceeds the ${TOOLSETS_MAX_ARRAY_CELLS_PER_AXIS}-per-axis bound (got ${c}×${r})`,
    );
  }
  if (c * r > TOOLSETS_MAX_ARRAY_CELLS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `${path} exceeds the ${TOOLSETS_MAX_ARRAY_CELLS}-cell bound (got ${c * r})`,
    );
  }
  if (c * r > TOOLSETS_MAX_GRID_CELLS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `${path} exceeds the ${TOOLSETS_MAX_GRID_CELLS}-grid-cell bound (got ${c * r})`,
    );
  }
  return { cols: c, rows: r };
}

// ---------------------------------------------------------------------------
// buildWallRun — a multi-segment wall run from a polyline.
// ---------------------------------------------------------------------------

export interface WallRunInput {
  readonly storyId: string;
  readonly polyline: readonly ToolsetPoint2[];
  readonly widthMm: number;
  readonly heightMm: number;
  readonly name?: string;
  /** "openings" adds one opening entity at each INTERIOR vertex, hosted
   *  (via the real P011 opening.hostId field) on the wall ENDING at that
   *  vertex; the two-adjacent-wall junction relationship is recorded in
   *  the returned manifest (P011 openings are single-host — the pair
   *  relationship is deliberately NOT fabricated into element props). */
  readonly junctions?: "none" | "openings";
}

/** The junction relationship a wall run reports (the manifest — the
 *  command result carries it; element props stay within the P011
 *  grammar). */
export interface WallJunctionManifest {
  readonly vertexIndex: number;
  readonly vertex: { readonly x: number; readonly y: number };
  /** [the wall ending at the vertex (the opening host), the wall starting
   *  at the vertex]. */
  readonly wallIds: readonly [string, string];
  readonly openingId: string;
}

export interface WallRunPlan {
  /** The `bim.createElements` entity batch (ONE atomic revision). */
  readonly entities: readonly Record<string, unknown>[];
  readonly wallCount: number;
  readonly junctions: readonly WallJunctionManifest[];
}

/** The declared canonical junction opening geometry (deterministic). */
const JUNCTION_OPENING_WIDTH_MM = 500;
const JUNCTION_OPENING_HEIGHT_MM = 2100;

/** How many pre-minted element ids a wall run needs (walls + junction
 *  openings) — the caller mints exactly this many before building. */
export function wallRunIdCount(vertexCount: number, junctions: "none" | "openings"): number {
  const walls = Math.max(1, vertexCount - 1);
  return junctions === "openings" ? walls + Math.max(0, vertexCount - 2) : walls;
}

export function buildWallRun(input: WallRunInput, ids?: readonly string[]): WallRunPlan {
  const storyId = requireId(input.storyId, "wallRun.storyId");
  const polyline = requirePolyline(input.polyline, "wallRun.polyline");
  const widthMm = requirePositiveFinite(input.widthMm, "wallRun.widthMm");
  const heightMm = requirePositiveFinite(input.heightMm, "wallRun.heightMm");
  const junctions = input.junctions ?? "none";
  if (junctions !== "none" && junctions !== "openings") {
    throw toolsetErr("toolset_bad_payload", "wallRun.junctions must be 'none' | 'openings'");
  }
  const base = optionalBoundedString(input.name, "wallRun.name", 48) ?? "wall";
  const wallCount = polyline.length - 1;
  const requiredIds = wallRunIdCount(polyline.length, junctions);
  const idList = ids ?? [];
  if (idList.length !== requiredIds) {
    throw toolsetErr(
      "toolset_bad_payload",
      `wallRun requires exactly ${requiredIds} pre-minted element ids (got ${idList.length})`,
    );
  }
  const entities: Record<string, unknown>[] = [];
  const junctionsOut: WallJunctionManifest[] = [];
  const wallIds: string[] = [];
  for (let i = 0; i < wallCount; i++) {
    const start = polyline[i]!;
    const end = polyline[i + 1]!;
    const wallId = idList[i]!;
    wallIds.push(wallId);
    entities.push({
      type: "bim.wall",
      id: wallId,
      storyId,
      start: [start.x, start.y],
      end: [end.x, end.y],
      width: widthMm,
      height: heightMm,
      name: `${base}-${i + 1}`,
    });
  }
  if (junctions === "openings") {
    for (let k = 1; k < polyline.length - 1; k++) {
      const vertex = polyline[k]!;
      const hostWallId = wallIds[k - 1]!;
      const followingWallId = wallIds[k]!;
      const openingId = idList[wallCount + (k - 1)]!;
      const hostStart = polyline[k - 1]!;
      const hostLen = Math.hypot(vertex.x - hostStart.x, vertex.y - hostStart.y);
      const width = Math.min(JUNCTION_OPENING_WIDTH_MM, hostLen);
      const height = Math.min(JUNCTION_OPENING_HEIGHT_MM, heightMm);
      entities.push({
        type: "bim.opening",
        id: openingId,
        hostId: hostWallId,
        distance: hostLen - width,
        width,
        height,
        sill: 0,
        name: `${base}-junction-${k}`,
      });
      junctionsOut.push({
        vertexIndex: k,
        vertex: { x: vertex.x, y: vertex.y },
        wallIds: [hostWallId, followingWallId],
        openingId,
      });
    }
  }
  return { entities, wallCount, junctions: junctionsOut };
}

// ---------------------------------------------------------------------------
// buildHostedOpening — a door/window hosted in an EXISTING wall (the P011
// host binding: bim.opening.hostId + the fill's openingId).
// ---------------------------------------------------------------------------

export interface HostedOpeningInput {
  readonly wallId: string;
  readonly kind: "door" | "window";
  /** Near-edge position along the host wall axis from `start` (mm). */
  readonly tAlongWall: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly sillMm?: number;
  readonly swing?: "left" | "right";
  readonly name?: string;
}

export interface HostedOpeningPlan {
  readonly entities: readonly Record<string, unknown>[];
  readonly openingId: string;
  readonly fillId: string;
}

/** Two pre-minted ids: the opening + the door/window fill. */
export function hostedOpeningIdCount(): number {
  return 2;
}

export function buildHostedOpening(input: HostedOpeningInput, ids: readonly string[]): HostedOpeningPlan {
  const wallId = requireId(input.wallId, "hostedOpening.wallId");
  if (input.kind !== "door" && input.kind !== "window") {
    throw toolsetErr("toolset_bad_payload", "hostedOpening.kind must be 'door' | 'window'");
  }
  const tAlongWall = requireNonNegativeFinite(input.tAlongWall, "hostedOpening.tAlongWall");
  const widthMm = requirePositiveFinite(input.widthMm, "hostedOpening.widthMm");
  const heightMm = requirePositiveFinite(input.heightMm, "hostedOpening.heightMm");
  const sillMm = input.sillMm === undefined ? 0 : requireNonNegativeFinite(input.sillMm, "hostedOpening.sillMm");
  const swing = input.swing ?? "left";
  if (swing !== "left" && swing !== "right") {
    throw toolsetErr("toolset_bad_payload", "hostedOpening.swing must be 'left' | 'right'");
  }
  const name = optionalBoundedString(input.name, "hostedOpening.name", 48);
  if (ids.length !== 2) {
    throw toolsetErr("toolset_bad_payload", `hostedOpening requires exactly 2 pre-minted element ids (got ${ids.length})`);
  }
  const [openingId, fillId] = [ids[0]!, ids[1]!];
  const entities: Record<string, unknown>[] = [
    {
      type: "bim.opening",
      id: openingId,
      hostId: wallId,
      distance: tAlongWall,
      width: widthMm,
      height: heightMm,
      sill: sillMm,
      ...(name !== undefined ? { name: `${name}-opening` } : {}),
    },
  ];
  if (input.kind === "door") {
    entities.push({
      type: "bim.door",
      id: fillId,
      openingId,
      swing,
      ...(name !== undefined ? { name } : {}),
    });
  } else {
    entities.push({
      type: "bim.window",
      id: fillId,
      openingId,
      ...(name !== undefined ? { name } : {}),
    });
  }
  return { entities, openingId, fillId };
}

// ---------------------------------------------------------------------------
// buildRoof — a parametric gable roof over an axis-aligned footprint
// (the P011 bim.roof primitive, unchanged).
// ---------------------------------------------------------------------------

export interface RoofInput {
  readonly storyId: string;
  readonly corner1: ToolsetPoint2;
  readonly corner2: ToolsetPoint2;
  readonly ridgeAxis?: "x" | "y";
  readonly heightMm: number;
  readonly baseOffsetMm?: number;
  readonly topStoryId?: string;
  readonly name?: string;
}

export interface RoofPlan {
  readonly entities: readonly Record<string, unknown>[];
}

export function buildRoof(input: RoofInput): RoofPlan {
  const storyId = requireId(input.storyId, "roof.storyId");
  const corner1 = requirePoint2(input.corner1, "roof.corner1");
  const corner2 = requirePoint2(input.corner2, "roof.corner2");
  if (corner1.x === corner2.x || corner1.y === corner2.y) {
    throw toolsetErr("toolset_bad_payload", "roof.corner1/corner2 must span a non-degenerate axis-aligned area");
  }
  const ridgeAxis = input.ridgeAxis ?? "x";
  if (ridgeAxis !== "x" && ridgeAxis !== "y") {
    throw toolsetErr("toolset_bad_payload", "roof.ridgeAxis must be 'x' | 'y'");
  }
  const heightMm = requirePositiveFinite(input.heightMm, "roof.heightMm");
  const baseOffsetMm = input.baseOffsetMm === undefined ? 0 : requireNonNegativeFinite(input.baseOffsetMm, "roof.baseOffsetMm");
  const name = optionalBoundedString(input.name, "roof.name", 48);
  const entities: Record<string, unknown>[] = [
    {
      type: "bim.roof",
      storyId,
      corner1: [corner1.x, corner1.y],
      corner2: [corner2.x, corner2.y],
      ridgeAxis,
      height: heightMm,
      baseOffset: baseOffsetMm,
      ...(input.topStoryId !== undefined ? { topStoryId: requireId(input.topStoryId, "roof.topStoryId") } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  ];
  return { entities };
}

// ---------------------------------------------------------------------------
// buildStairRun — a single-flight stair + optional deterministic side
// railings (the P011 bim.stair / bim.railing primitives — the railings
// host on the stair through the real hostId field).
// ---------------------------------------------------------------------------

export type StairRailingOption = "none" | "left" | "right" | "both";

export interface StairRunInput {
  readonly storyId: string;
  readonly topStoryId: string;
  readonly start: ToolsetPoint2;
  /** The run heading in degrees (0 = +X, CCW). Multiples of 90° map to
   *  the exact axis unit directions. */
  readonly directionDeg?: number;
  readonly widthMm: number;
  readonly stepCount: number;
  readonly treadMm: number;
  readonly baseOffsetMm?: number;
  readonly landingLengthMm?: number;
  readonly railings?: StairRailingOption;
  readonly handrailHeightMm?: number;
  readonly name?: string;
}

export interface StairRunPlan {
  readonly entities: readonly Record<string, unknown>[];
  readonly stairId: string;
  readonly railingIds: readonly string[];
}

/** The exact axis unit directions (deterministic — no trig rounding on
 *  the canonical headings). */
function unitDirectionOf(deg: number): { x: number; y: number } {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized === 0) return { x: 1, y: 0 };
  if (normalized === 90) return { x: 0, y: 1 };
  if (normalized === 180) return { x: -1, y: 0 };
  if (normalized === 270) return { x: 0, y: -1 };
  const rad = (normalized * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** How many pre-minted ids a stair run needs (stair + railings). */
export function stairRunIdCount(railings: StairRailingOption): number {
  switch (railings) {
    case "none":
      return 1;
    case "left":
    case "right":
      return 2;
    case "both":
      return 3;
  }
}

export function buildStairRun(input: StairRunInput, ids?: readonly string[]): StairRunPlan {
  const storyId = requireId(input.storyId, "stairRun.storyId");
  const topStoryId = requireId(input.topStoryId, "stairRun.topStoryId");
  const start = requirePoint2(input.start, "stairRun.start");
  const directionDeg = input.directionDeg === undefined ? 0 : requireNonNegativeFinite(input.directionDeg, "stairRun.directionDeg");
  const dir = unitDirectionOf(directionDeg);
  const widthMm = requirePositiveFinite(input.widthMm, "stairRun.widthMm");
  const stepCount = input.stepCount;
  if (!Number.isInteger(stepCount) || (stepCount as number) < 2 || (stepCount as number) > 24) {
    throw toolsetErr("toolset_bad_payload", "stairRun.stepCount must be an integer between 2 and 24 (the bounded single-flight run)");
  }
  const treadMm = requirePositiveFinite(input.treadMm, "stairRun.treadMm");
  const baseOffsetMm = input.baseOffsetMm === undefined ? 0 : requireNonNegativeFinite(input.baseOffsetMm, "stairRun.baseOffsetMm");
  const railings = input.railings ?? "none";
  if (railings !== "none" && railings !== "left" && railings !== "right" && railings !== "both") {
    throw toolsetErr("toolset_bad_payload", "stairRun.railings must be 'none' | 'left' | 'right' | 'both'");
  }
  const handrailHeightMm = input.handrailHeightMm === undefined ? 900 : requirePositiveFinite(input.handrailHeightMm, "stairRun.handrailHeightMm");
  const name = optionalBoundedString(input.name, "stairRun.name", 48);
  const requiredIds = stairRunIdCount(railings);
  const idList = ids ?? [];
  if (idList.length !== requiredIds) {
    throw toolsetErr(
      "toolset_bad_payload",
      `stairRun requires exactly ${requiredIds} pre-minted element ids (got ${idList.length})`,
    );
  }
  const stairId = idList[0]!;
  const entities: Record<string, unknown>[] = [
    {
      type: "bim.stair",
      id: stairId,
      storyId,
      topStoryId,
      start: [start.x, start.y],
      direction: [dir.x, dir.y],
      width: widthMm,
      stepCount: input.stepCount,
      tread: treadMm,
      baseOffset: baseOffsetMm,
      ...(input.landingLengthMm !== undefined && input.landingLengthMm > 0
        ? { landingLength: requirePositiveFinite(input.landingLengthMm, "stairRun.landingLengthMm") }
        : {}),
      ...(name !== undefined ? { name } : {}),
    },
  ];
  const railingIds: string[] = [];
  if (railings !== "none") {
    const sides: readonly ("left" | "right")[] = railings === "both" ? ["left", "right"] : [railings];
    for (const [i, side] of sides.entries()) {
      const railingId = idList[1 + i]!;
      railingIds.push(railingId);
      entities.push({
        type: "bim.railing",
        id: railingId,
        hostId: stairId,
        side,
        height: handrailHeightMm,
        ...(name !== undefined ? { name: `${name}-railing-${side}` } : {}),
      });
    }
  }
  return { entities, stairId, railingIds };
}

// ---------------------------------------------------------------------------
// buildSpaceGrid — a rectangular space grid (prefix-<col>-<row> names).
// ---------------------------------------------------------------------------

export interface SpaceGridInput {
  readonly storyId: string;
  readonly origin: ToolsetPoint2;
  readonly cols: number;
  readonly rows: number;
  readonly cellWidthMm: number;
  readonly cellHeightMm: number;
  readonly prefix?: string;
  readonly heightMm?: number;
  readonly baseOffsetMm?: number;
}

export interface SpaceGridPlan {
  readonly entities: readonly Record<string, unknown>[];
  readonly names: readonly string[];
}

export function buildSpaceGrid(input: SpaceGridInput): SpaceGridPlan {
  const storyId = requireId(input.storyId, "spaceGrid.storyId");
  const origin = requirePoint2(input.origin, "spaceGrid.origin");
  const { cols, rows } = requireGridExtent(input.cols, input.rows, "spaceGrid");
  const cellWidthMm = requirePositiveFinite(input.cellWidthMm, "spaceGrid.cellWidthMm");
  const cellHeightMm = requirePositiveFinite(input.cellHeightMm, "spaceGrid.cellHeightMm");
  const prefix = optionalBoundedString(input.prefix, "spaceGrid.prefix", 32) ?? "space";
  const heightMm = input.heightMm === undefined ? 3000 : requirePositiveFinite(input.heightMm, "spaceGrid.heightMm");
  const baseOffsetMm = input.baseOffsetMm === undefined ? 0 : requireNonNegativeFinite(input.baseOffsetMm, "spaceGrid.baseOffsetMm");
  const entities: Record<string, unknown>[] = [];
  const names: string[] = [];
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const x = origin.x + (col - 1) * cellWidthMm;
      const y = origin.y + (row - 1) * cellHeightMm;
      const name = `${prefix}-${col}-${row}`;
      names.push(name);
      entities.push({
        type: "bim.space",
        storyId,
        name,
        footprint: [
          [x, y],
          [x + cellWidthMm, y],
          [x + cellWidthMm, y + cellHeightMm],
          [x, y + cellHeightMm],
        ],
        height: heightMm,
        baseOffset: baseOffsetMm,
      });
    }
  }
  return { entities, names };
}

// ---------------------------------------------------------------------------
// buildComponentArray — component instances at origin+col*dx, row*dy.
// ---------------------------------------------------------------------------

export interface ComponentArrayInput {
  readonly definitionId: string;
  readonly storyId: string;
  readonly origin: ToolsetPoint2;
  readonly cols: number;
  readonly rows: number;
  readonly dxMm: number;
  readonly dyMm: number;
  readonly rotation?: number;
  readonly baseOffsetMm?: number;
  readonly namePrefix?: string;
}

export interface ComponentArrayPlan {
  readonly entities: readonly Record<string, unknown>[];
  readonly count: number;
}

export function buildComponentArray(input: ComponentArrayInput): ComponentArrayPlan {
  const definitionId = requireId(input.definitionId, "componentArray.definitionId");
  const storyId = requireId(input.storyId, "componentArray.storyId");
  const origin = requirePoint2(input.origin, "componentArray.origin");
  const { cols, rows } = requireGridExtent(input.cols, input.rows, "componentArray");
  const dxMm = requireNonNegativeFinite(input.dxMm, "componentArray.dxMm");
  const dyMm = requireNonNegativeFinite(input.dyMm, "componentArray.dyMm");
  const rotation = input.rotation === undefined ? 0 : requireNonNegativeFinite(input.rotation, "componentArray.rotation");
  const baseOffsetMm = input.baseOffsetMm === undefined ? 0 : requireNonNegativeFinite(input.baseOffsetMm, "componentArray.baseOffsetMm");
  const namePrefix = optionalBoundedString(input.namePrefix, "componentArray.namePrefix", 32);
  const entities: Record<string, unknown>[] = [];
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const x = origin.x + (col - 1) * dxMm;
      const y = origin.y + (row - 1) * dyMm;
      entities.push({
        type: "bim.componentInstance",
        definitionId,
        storyId,
        position: [x, y],
        rotation,
        baseOffset: baseOffsetMm,
        overrides: {},
        ...(namePrefix !== undefined ? { name: `${namePrefix}-${col}-${row}` } : {}),
      });
    }
  }
  return { entities, count: cols * rows };
}

// ---------------------------------------------------------------------------
// buildDimensionChain — aligned linear dimensions between consecutive
// points (the drafting dim-linear primitive — annotation elements).
// ---------------------------------------------------------------------------

export interface DimensionChainInput {
  readonly points: readonly ToolsetPoint2[];
  /** Signed perpendicular offset of every dimension line (mm). */
  readonly offsetMm?: number;
  /** Canonical layer id (default "0"). */
  readonly layer?: string;
}

export interface DimensionChainPlan {
  /** The `drafting.createEntities` entity batch (ONE atomic revision). */
  readonly entities: readonly Record<string, unknown>[];
  readonly dimensionCount: number;
}

export function buildDimensionChain(input: DimensionChainInput): DimensionChainPlan {
  if (!Array.isArray(input.points) || input.points.length < 2) {
    throw toolsetErr("toolset_bad_payload", "dimensionChain.points must be an array of at least 2 points");
  }
  if (input.points.length > TOOLSETS_MAX_DIM_POINTS) {
    throw toolsetErr(
      "toolset_out_of_bounds",
      `dimensionChain.points exceeds the ${TOOLSETS_MAX_DIM_POINTS}-point bound (got ${input.points.length})`,
    );
  }
  const points = input.points.map((raw, i) => requirePoint2(raw, `dimensionChain.points[${i}]`));
  const offsetMm = input.offsetMm === undefined ? 0 : requireNonNegativeFinite(input.offsetMm, "dimensionChain.offsetMm");
  const layer = optionalBoundedString(input.layer, "dimensionChain.layer", 32) ?? "0";
  const entities: Record<string, unknown>[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x === b.x && a.y === b.y) {
      throw toolsetErr(
        "toolset_bad_payload",
        `dimensionChain.points[${i}] coincides with points[${i - 1}] (zero-length dimension)`,
      );
    }
    entities.push({
      type: "dim-linear",
      layer,
      p1: [a.x, a.y],
      p2: [b.x, b.y],
      mode: "aligned",
      offset: offsetMm,
    });
  }
  return { entities, dimensionCount: entities.length };
}
