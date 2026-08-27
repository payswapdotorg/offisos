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
  IfcComponentInput,
  IfcFillInput,
  IfcIdentity,
  IfcMaterialInput,
  IfcOpeningInput,
  IfcSlabInput,
  IfcSpaceInput,
  IfcStoryInput,
  IfcWallInput,
} from "../contracts/ifc.js";
import type { BimEntity, DoorEntity, OpeningEntity, SlabEntity, SpaceEntity, StoryEntity, WallEntity, WindowEntity } from "../bim/elements.js";
import type {
  ComponentDefEntity,
  ComponentInstanceEntity,
  GridEntity,
  MaterialEntity,
  ReferencePlaneEntity,
} from "../bim/components.js";
import { effectiveBox, effectiveMaterialId, effectiveParameters } from "../bim/components.js";
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
function customPropsOf(rawProps: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean>> | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (KNOWN_PROPS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function identityOf(id: string, kind: string): IfcIdentity {
  // Identity ONLY — no version metadata (byte-determinism across documents).
  return { DomainId: id, DomainKind: kind };
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
    // COMPAT-BIM-003 (additive).
    readonly materials: number;
    readonly components: number;
    /** Coordination primitives are canonical-only in this slice: they are
     *  NOT exported and the counts report that explicitly (LOCK-007). */
    readonly gridsNotExported: number;
    readonly referencePlanesNotExported: number;
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
  rawPropsById: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  storyLevels: ReadonlyMap<string, number>,
  projectName: string,
): IfcExportOutcome {
  const stories = entities.filter((e): e is StoryEntity => e.type === "bim.story");
  const walls = entities.filter((e): e is WallEntity => e.type === "bim.wall");
  const slabs = entities.filter((e): e is SlabEntity => e.type === "bim.slab");
  const openings = entities.filter((e): e is OpeningEntity => e.type === "bim.opening");
  const doors = entities.filter((e): e is DoorEntity => e.type === "bim.door");
  const windows = entities.filter((e): e is WindowEntity => e.type === "bim.window");
  const spaces = entities.filter((e): e is SpaceEntity => e.type === "bim.space");
  // COMPAT-BIM-003 (additive): materials, component definitions + instances,
  // coordination primitives.
  const materials = entities.filter((e): e is MaterialEntity => e.type === "bim.material");
  const componentDefs = entities.filter((e): e is ComponentDefEntity => e.type === "bim.componentDef");
  const componentInstances = entities.filter((e): e is ComponentInstanceEntity => e.type === "bim.componentInstance");
  const grids = entities.filter((e): e is GridEntity => e.type === "bim.grid");
  const referencePlanes = entities.filter((e): e is ReferencePlaneEntity => e.type === "bim.referencePlane");

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
      identity: identityOf(s.id, "story"),
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
        identity: identityOf(w.id, "wall"),
        qtos: wallQtos(w, openingsByHost.get(w.id) ?? []),
        ...(customPropsOf(rawPropsById.get(w.id) ?? {}) !== undefined ? { custom: customPropsOf(rawPropsById.get(w.id) ?? {})! } : {}),
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
        identity: identityOf(s.id, "slab"),
        qtos: { GrossVolume: w * h * s.thickness * MM_TO_M * MM_TO_M * MM_TO_M },
        ...(customPropsOf(rawPropsById.get(s.id) ?? {}) !== undefined ? { custom: customPropsOf(rawPropsById.get(s.id) ?? {})! } : {}),
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
        identity: identityOf(o.id, "opening"),
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
      identity: identityOf(entity.id, entity.type === "bim.door" ? "door" : "window"),
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
        identity: identityOf(s.id, "space"),
        qtos: { GrossFloorArea: s.area * MM_TO_M * MM_TO_M },
        ...(customPropsOf(rawPropsById.get(s.id) ?? {}) !== undefined ? { custom: customPropsOf(rawPropsById.get(s.id) ?? {})! } : {}),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  // --- COMPAT-BIM-003 (additive): materials + component instances --------------
  const materialGuid = new Map<string, string>(materials.map((m) => [m.id, ifcGuidFor(m.id)] as const));
  const materialInputs: IfcMaterialInput[] = materials
    .map((m): IfcMaterialInput => {
      const properties: Record<string, string | number | boolean> = {};
      if (m.color !== undefined) {
        properties["Color R"] = m.color[0];
        properties["Color G"] = m.color[1];
        properties["Color B"] = m.color[2];
      }
      for (const [key, value] of Object.entries(m.properties)) {
        properties[key] = value;
      }
      return {
        guid: materialGuid.get(m.id)!,
        name: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
        identity: identityOf(m.id, "material"),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid));

  const defById = new Map<string, ComponentDefEntity>(componentDefs.map((d) => [d.id, d] as const));
  const componentInputs: IfcComponentInput[] = componentInstances
    .map((instance): IfcComponentInput => {
      const definition = defById.get(instance.definitionId);
      if (definition === undefined) {
        throw new Error(`IFC export: component instance '${instance.id}' references missing definition '${instance.definitionId}'`);
      }
      const effective = effectiveParameters(definition, instance);
      const [sizeX, sizeY, sizeZ] = effectiveBox(definition, instance);
      const overrideKeys = Object.keys(instance.overrides).sort().join(",");
      const componentPset: Record<string, string | number | boolean> = {
        DefinitionId: definition.id,
        DefinitionName: definition.name,
        Category: definition.category,
        OverrideKeys: overrideKeys,
      };
      for (const [key, value] of Object.entries(effective)) {
        componentPset[`Param.${key}`] = value * MM_TO_M;
      }
      const materialId = effectiveMaterialId(definition, instance);
      return {
        guid: ifcGuidFor(instance.id),
        name: instance.name ?? "",
        storyGuid: storyGuid.get(instance.storyId)!,
        category: definition.category,
        position: [instance.position[0] * MM_TO_M, instance.position[1] * MM_TO_M],
        rotation: instance.rotation,
        baseZ: (levelOf(instance.storyId) + instance.baseOffset) * MM_TO_M,
        size: [sizeX * MM_TO_M, sizeY * MM_TO_M, sizeZ * MM_TO_M],
        identity: identityOf(instance.id, "component-instance"),
        component: componentPset,
        ...(materialId !== null ? { materialGuid: materialGuid.get(materialId)! } : {}),
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
      materials: materialInputs,
      components: componentInputs,
    },
    counts: {
      stories: stories.length,
      walls: walls.length,
      slabs: slabs.length,
      openings: openings.length,
      doors: doors.length,
      windows: windows.length,
      spaces: spaces.length,
      materials: materials.length,
      components: componentInstances.length,
      gridsNotExported: grids.length,
      referencePlanesNotExported: referencePlanes.length,
    },
  };
}
