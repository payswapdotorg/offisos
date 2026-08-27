/**
 * IFC export mapping (COMPAT-IFC-001 / Issue #47): canonical BIM state →
 * deterministic IFC build request.
 *
 * Pure, engine-free (LOCK-018). The canonical domain is mm (story-local XY
 * + world Z = story level + baseOffset); the IFC wire domain is METRES —
 * every linear value divides by 1000 exactly once at this boundary, and the
 * import path multiplies back by the file's declared length-unit factor
 * (unit normalization with declared tolerances).
 *
 * Element IfcGuids derive deterministically from canonical ids
 * (identity.ts); identity psets carry the canonical id so re-import
 * reconciles on CANONICAL identity, never on engine GlobalIds
 * (RESEARCH-CAD-003 identity finding; LOCK-019).
 */

import type {
  IfcBuildRequest,
  IfcFillInput,
  IfcIdentity,
  IfcOpeningInput,
  IfcSlabInput,
  IfcSpaceInput,
  IfcStoryInput,
  IfcWallInput,
} from "../contracts/ifc.js";
import type { BimEntity, DoorEntity, OpeningEntity, SlabEntity, SpaceEntity, StoryEntity, WallEntity, WindowEntity } from "../bim/elements.js";
import { ifcGuidFor } from "./identity.js";

const MM_TO_M = 0.001;

/** Props that belong to the canonical geometry vocabulary (never exported
 *  as custom pset values). */
const KNOWN_PROPS = new Set([
  "bim", "type", "id", "name", "level", "height", "storyId", "start", "end",
  "width", "baseOffset", "corner1", "corner2", "thickness", "hostId",
  "distance", "sill", "openingId", "swing", "leafThickness", "footprint",
  "area",
]);

/** Author-set extra props (e.g. FireRating) → Pset_OffisosCustom. */
function customPropsOf(entity: BimEntity): Readonly<Record<string, string | number | boolean>> | undefined {
  const source = entity as unknown as Readonly<Record<string, unknown>>;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_PROPS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function identityOf(id: string, kind: string, modelRevision: string): IfcIdentity {
  return { DomainId: id, DomainKind: kind, ModelRevision: modelRevision };
}

/** Deterministic wall length (mm). */
function wallLengthMm(wall: WallEntity): number {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Wall deterministic quantities (m³, matching the canonical geometry math:
 *  gross = L·W·H; net = L·W·H − Σ openings·W). */
function wallQtos(wall: WallEntity, openings: readonly OpeningEntity[]): Readonly<Record<string, number>> {
  const l = wallLengthMm(wall);
  const gross = l * wall.width * wall.height;
  const cuts = openings.reduce((sum, o) => sum + o.width * o.height * wall.width, 0);
  return {
    Length: l * MM_TO_M,
    Width: wall.width * MM_TO_M,
    Height: wall.height * MM_TO_M,
    GrossVolume: gross * MM_TO_M * MM_TO_M * MM_TO_M,
    NetVolume: (gross - cuts) * MM_TO_M * MM_TO_M * MM_TO_M,
  };
}

export interface IfcExportOutcome {
  readonly request: IfcBuildRequest;
  /** Canonical ids exported per kind (for reporting). */
  readonly counts: {
    readonly stories: number;
    readonly walls: number;
    readonly slabs: number;
    readonly openings: number;
    readonly doors: number;
    readonly windows: number;
    readonly spaces: number;
  };
}

/** Build the deterministic IFC build request from the canonical BIM state.
 *
 * `entities` are the document's BIM entities (any order — the request is
 * canonically sorted); `storyLevels` maps storyId → level (world Z, mm);
 * `modelRevision` labels every identity pset (the document revision id).
 * `projectName` names the IfcProject. */
export function buildIfcExportRequest(
  entities: readonly BimEntity[],
  storyLevels: ReadonlyMap<string, number>,
  modelRevision: string,
  projectName: string,
): IfcExportOutcome {
  const stories = entities.filter((e): e is StoryEntity => e.type === "bim.story");
  const walls = entities.filter((e): e is WallEntity => e.type === "bim.wall");
  const slabs = entities.filter((e): e is SlabEntity => e.type === "bim.slab");
  const openings = entities.filter((e): e is OpeningEntity => e.type === "bim.opening");
  const doors = entities.filter((e): e is DoorEntity => e.type === "bim.door");
  const windows = entities.filter((e): e is WindowEntity => e.type === "bim.window");
  const spaces = entities.filter((e): e is SpaceEntity => e.type === "bim.space");

  const storyGuid = new Map<string, string>(stories.map((s) => [s.id, ifcGuidFor(s.id)] as const));
  const wallGuid = new Map<string, string>(walls.map((w) => [w.id, ifcGuidFor(w.id)] as const));
  const openingGuid = new Map<string, string>(openings.map((o) => [o.id, ifcGuidFor(o.id)] as const));
  const levelOf = (storyId: string): number => {
    const level = storyLevels.get(storyId);
    if (level === undefined) {
      throw new Error(`IFC export: story '${storyId}' referenced by a hosted element does not exist`);
    }
    return level;
  };
  const wallById = new Map(walls.map((w) => [w.id, w] as const));
  const openingsByHost = new Map<string, OpeningEntity[]>();
  for (const o of openings) {
    const list = openingsByHost.get(o.hostId) ?? [];
    list.push(o);
    openingsByHost.set(o.hostId, list);
  }

  const storyInputs: IfcStoryInput[] = stories
    .map((s): IfcStoryInput => ({
      guid: storyGuid.get(s.id)!,
      name: s.name,
      elevation: s.level * MM_TO_M,
      height: s.height * MM_TO_M,
      identity: identityOf(s.id, "story", modelRevision),
    }))
    .sort((a, b) => a.guid.localeCompare(b.guid));

  const wallInputs: IfcWallInput[] = walls
    .map((w): IfcWallInput => {
      const length = wallLengthMm(w);
      const angle = Math.atan2(w.end[1] - w.start[1], w.end[0] - w.start[0]);
      return {
        guid: wallGuid.get(w.id)!,
        name: w.name ?? "",
        storyGuid: storyGuid.get(w.storyId)!,
        start: [w.start[0] * MM_TO_M, w.start[1] * MM_TO_M],
        angle,
        length: length * MM_TO_M,
        height: w.height * MM_TO_M,
        thickness: w.width * MM_TO_M,
        baseZ: (levelOf(w.storyId) + w.baseOffset) * MM_TO_M,
        identity: identityOf(w.id, "wall", modelRevision),
        qtos: wallQtos(w, openingsByHost.get(w.id) ?? []),
        ...(customPropsOf(w) !== undefined ? { custom: customPropsOf(w)! } : {}),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  const slabInputs: IfcSlabInput[] = slabs
    .map((s): IfcSlabInput => {
      const w = Math.abs(s.corner1[0] - s.corner2[0]);
      const h = Math.abs(s.corner1[1] - s.corner2[1]);
      return {
        guid: ifcGuidFor(s.id),
        name: s.name ?? "",
        storyGuid: storyGuid.get(s.storyId)!,
        corner1: [s.corner1[0] * MM_TO_M, s.corner1[1] * MM_TO_M],
        corner2: [s.corner2[0] * MM_TO_M, s.corner2[1] * MM_TO_M],
        thickness: s.thickness * MM_TO_M,
        baseZ: (levelOf(s.storyId) + s.baseOffset) * MM_TO_M,
        identity: identityOf(s.id, "slab", modelRevision),
        qtos: { GrossVolume: w * h * s.thickness * MM_TO_M * MM_TO_M * MM_TO_M },
        ...(customPropsOf(s) !== undefined ? { custom: customPropsOf(s)! } : {}),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  const openingInputs: IfcOpeningInput[] = openings
    .map((o): IfcOpeningInput => {
      const host = wallById.get(o.hostId);
      if (host === undefined) {
        throw new Error(`IFC export: opening '${o.id}' references missing host wall '${o.hostId}'`);
      }
      return {
        guid: openingGuid.get(o.id)!,
        name: o.name ?? "",
        hostGuid: wallGuid.get(o.hostId)!,
        distance: o.distance * MM_TO_M,
        sill: o.sill * MM_TO_M,
        width: o.width * MM_TO_M,
        height: o.height * MM_TO_M,
        thickness: host.width * MM_TO_M,
        identity: identityOf(o.id, "opening", modelRevision),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  const fillOf = (openingId: string): OpeningEntity | undefined =>
    openings.find((o) => o.id === openingId);

  const toFill = (entity: DoorEntity | WindowEntity): IfcFillInput => {
    const opening = fillOf(entity.openingId);
    if (opening === undefined) {
      throw new Error(`IFC export: ${entity.type} '${entity.id}' references missing opening '${entity.openingId}'`);
    }
    const base: IfcFillInput = {
      guid: ifcGuidFor(entity.id),
      name: entity.name ?? "",
      openingGuid: openingGuid.get(entity.openingId)!,
      storyGuid: storyGuid.get(entity.storyId)!,
      overallWidth: opening.width * MM_TO_M,
      overallHeight: opening.height * MM_TO_M,
      identity: identityOf(entity.id, entity.type === "bim.door" ? "door" : "window", modelRevision),
    };
    if (entity.type === "bim.door") {
      return { ...base, params: { Swing: entity.swing, LeafThickness: entity.leafThickness } };
    }
    return base;
  };

  const doorInputs: IfcFillInput[] = doors.map(toFill).sort((a, b) => a.guid.localeCompare(b.guid));
  const windowInputs: IfcFillInput[] = windows.map(toFill).sort((a, b) => a.guid.localeCompare(b.guid));

  const spaceInputs: IfcSpaceInput[] = spaces
    .map((s): IfcSpaceInput => {
      const xs = s.footprint.map((p) => p[0]);
      const ys = s.footprint.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return {
        guid: ifcGuidFor(s.id),
        name: s.name,
        storyGuid: storyGuid.get(s.storyId)!,
        position: [minX * MM_TO_M, minY * MM_TO_M],
        z: (levelOf(s.storyId) + s.baseOffset) * MM_TO_M,
        footprint: s.footprint.map((p) => [(p[0] - minX) * MM_TO_M, (p[1] - minY) * MM_TO_M] as const),
        height: s.height * MM_TO_M,
        longName: s.name,
        identity: identityOf(s.id, "space", modelRevision),
        qtos: { GrossFloorArea: s.area * MM_TO_M * MM_TO_M },
        ...(customPropsOf(s) !== undefined ? { custom: customPropsOf(s)! } : {}),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  return {
    request: {
      projectName,
      stories: storyInputs,
      walls: wallInputs,
      slabs: slabInputs,
      openings: openingInputs,
      doors: doorInputs,
      windows: windowInputs,
      spaces: spaceInputs,
    },
    counts: {
      stories: stories.length,
      walls: walls.length,
      slabs: slabs.length,
      openings: openings.length,
      doors: doors.length,
      windows: windows.length,
      spaces: spaces.length,
    },
  };
}
