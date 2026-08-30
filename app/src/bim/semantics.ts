/**
 * BIM semantic extraction (COMPAT-CAD-002, BIM-002: BIM semantics independent
 * of editor implementation and engines).
 *
 * Pure, engine-free extraction of the semantic record of a BIM element from
 * its canonical props (authored semantics are OBSERVED by definition — the
 * user authored them; LOCK-007). This is the module the Construction Graph
 * bridge's uncertainty labels gate on (semantics: OBSERVED for
 * bim-marked elements) and the `bim.getSemantics` query serves.
 *
 * Geometry results (meshToken, bbox) are deliberately NOT part of the
 * semantic record: semantics and geometry are separate concerns (Issue #39).
 */

import type { Element } from "../contracts/caddocument.js";
import { elementToBimEntity, isBimElement } from "./elements.js";
import type { BimElementMeta } from "./meta.js";

/** The extracted semantic record of one BIM element (engine-free). */
export interface BimSemanticRecord {
  readonly elementId: string;
  readonly type: string;
  readonly semantics: Readonly<Record<string, unknown>>;
}

/** The CAD-PARITY-011 meta overlay projection appended to every semantic
 *  record (classification, property sets, renovation status with the
 *  derived default, option membership — only the PRESENT keys; the
 *  renovation status always reports the effective state). */
function metaSemantics(meta: BimElementMeta | undefined): Record<string, unknown> {
  if (meta === undefined) return {};
  const out: Record<string, unknown> = {};
  if (meta.classificationRef !== undefined) out.classificationRef = meta.classificationRef;
  if (meta.propertySets !== undefined && meta.propertySets.length > 0) out.propertySets = meta.propertySets;
  if (meta.renovationStatus !== undefined) out.renovationStatus = meta.renovationStatus;
  if (meta.optionGroupId !== undefined && meta.option !== undefined) {
    out.optionGroupId = meta.optionGroupId;
    out.option = meta.option;
  }
  return out;
}

/** Extract the semantic record of a BIM element. Throws for non-BIM elements
 *  (LOCK-007: no guessing semantics for elements that carry none).
 *  CAD-PARITY-011: records carry the PRESENT meta overlay keys
 *  (classification/propertySets/renovationStatus/option membership) — the
 *  derived default renovation state lives in the dedicated lifecycle query
 *  (bim.getLifecycle) so pre-P011 semantic output is byte-identical. */
export function extractElementSemantics(el: Element): BimSemanticRecord {
  if (!isBimElement(el)) {
    throw new Error(`element '${el.id}' carries no BIM semantics (not a bim-marked element)`);
  }
  const entity = elementToBimEntity(el);
  const p = el.props as Record<string, unknown>;
  const withMeta = (semantics: Record<string, unknown>): BimSemanticRecord => ({
    elementId: el.id,
    type: entity.type,
    semantics: { ...semantics, ...metaSemantics(entity.meta) },
  });
  switch (entity.type) {
    case "bim.story":
      return withMeta({ role: "level-container", name: p.name, level: p.level, height: p.height });
    case "bim.wall":
      return withMeta({
        role: "building-element",
        classification: "wall",
        storyId: p.storyId,
        width: p.width,
        height: p.height,
        baseOffset: p.baseOffset,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.slab":
      return withMeta({
        role: "building-element",
        classification: "slab",
        storyId: p.storyId,
        thickness: p.thickness,
        baseOffset: p.baseOffset,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.opening":
      return withMeta({
        role: "void",
        classification: "opening",
        hostId: p.hostId,
        distance: p.distance,
        width: p.width,
        height: p.height,
        sill: p.sill,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.door":
      return withMeta({
        role: "fill",
        classification: "door",
        openingId: p.openingId,
        storyId: p.storyId,
        swing: p.swing,
        leafThickness: p.leafThickness,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.window":
      return withMeta({
        role: "fill",
        classification: "window",
        openingId: p.openingId,
        storyId: p.storyId,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.space":
      return withMeta({
        role: "spatial-element",
        classification: "space",
        storyId: p.storyId,
        name: p.name,
        area: p.area,
        height: p.height,
        baseOffset: p.baseOffset,
      });
    // --- COMPAT-BIM-003 (additive): components / materials / coordination ---
    case "bim.componentDef":
      return withMeta({
        role: "component-definition",
        classification: entity.category,
        name: p.name,
        category: p.category,
        parameters: p.parameters,
        ...(p.materialId !== undefined ? { materialId: p.materialId } : {}),
      });
    case "bim.componentInstance":
      return withMeta({
        role: "component-instance",
        classification: "component",
        definitionId: p.definitionId,
        storyId: p.storyId,
        position: p.position,
        rotation: p.rotation,
        baseOffset: p.baseOffset,
        overrides: p.overrides,
        ...(p.materialId !== undefined ? { materialId: p.materialId } : {}),
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.material":
      return withMeta({
        role: "domain-data",
        classification: "material",
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.color !== undefined ? { color: p.color } : {}),
        properties: p.properties,
      });
    case "bim.grid":
      return withMeta({
        role: "coordination",
        classification: "grid",
        storyId: p.storyId,
        name: p.name,
        uLines: p.uLines,
        vLines: p.vLines,
      });
    case "bim.referencePlane":
      return withMeta({
        role: "coordination",
        classification: "reference-plane",
        storyId: p.storyId,
        name: p.name,
        start: p.start,
        end: p.end,
      });
    // --- CAD-PARITY-011 (additive, Issue #97): the bounded Archicad-class
    // authoring entities (authored parameters + references; the derived
    // slope/rise/run/stories values are reported by the geometry and
    // lifecycle query surfaces that own their derivation contexts). ---
    case "bim.roof":
      return withMeta({
        role: "building-element",
        classification: "roof",
        storyId: p.storyId,
        ...(p.topStoryId !== undefined ? { topStoryId: p.topStoryId } : {}),
        ridgeAxis: p.ridgeAxis,
        height: p.height,
        baseOffset: p.baseOffset,
        corner1: p.corner1,
        corner2: p.corner2,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.stair":
      return withMeta({
        role: "building-element",
        classification: "stair",
        storyId: p.storyId,
        topStoryId: p.topStoryId,
        start: p.start,
        direction: p.direction,
        width: p.width,
        stepCount: p.stepCount,
        tread: p.tread,
        baseOffset: p.baseOffset,
        ...(p.landingLength !== undefined ? { landingLength: p.landingLength } : {}),
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.railing":
      return withMeta({
        role: "building-element",
        classification: "railing",
        hostId: p.hostId,
        side: p.side,
        height: p.height,
        ...(p.name !== undefined ? { name: p.name } : {}),
      });
    case "bim.zone":
      return withMeta({
        role: "spatial-grouping",
        classification: "zone",
        name: p.name,
        spaceIds: p.spaceIds,
      });
    case "bim.optionGroup":
      return withMeta({
        role: "lifecycle-registry",
        classification: "option-group",
        name: p.name,
        options: p.options,
        activeOption: p.activeOption,
        ...(p.description !== undefined ? { description: p.description } : {}),
      });
  }
}

/** Soft variant: null for non-BIM elements (query support). */
export function extractElementSemanticsSafe(el: Element): BimSemanticRecord | null {
  if (!isBimElement(el)) return null;
  try {
    return extractElementSemantics(el);
  } catch {
    return null;
  }
}
