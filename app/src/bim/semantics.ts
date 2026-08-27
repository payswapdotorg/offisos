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

/** The extracted semantic record of one BIM element (engine-free). */
export interface BimSemanticRecord {
  readonly elementId: string;
  readonly type: string;
  readonly semantics: Readonly<Record<string, unknown>>;
}

/** Extract the semantic record of a BIM element. Throws for non-BIM elements
 *  (LOCK-007: no guessing semantics for elements that carry none). */
export function extractElementSemantics(el: Element): BimSemanticRecord {
  if (!isBimElement(el)) {
    throw new Error(`element '${el.id}' carries no BIM semantics (not a bim-marked element)`);
  }
  const entity = elementToBimEntity(el);
  const p = el.props as Record<string, unknown>;
  switch (entity.type) {
    case "bim.story":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: { role: "level-container", name: p.name, level: p.level, height: p.height },
      };
    case "bim.wall":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "building-element",
          classification: "wall",
          storyId: p.storyId,
          width: p.width,
          height: p.height,
          baseOffset: p.baseOffset,
          ...(p.name !== undefined ? { name: p.name } : {}),
        },
      };
    case "bim.slab":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "building-element",
          classification: "slab",
          storyId: p.storyId,
          thickness: p.thickness,
          baseOffset: p.baseOffset,
          ...(p.name !== undefined ? { name: p.name } : {}),
        },
      };
    case "bim.opening":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "void",
          classification: "opening",
          hostId: p.hostId,
          distance: p.distance,
          width: p.width,
          height: p.height,
          sill: p.sill,
          ...(p.name !== undefined ? { name: p.name } : {}),
        },
      };
    case "bim.door":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "fill",
          classification: "door",
          openingId: p.openingId,
          storyId: p.storyId,
          swing: p.swing,
          leafThickness: p.leafThickness,
          ...(p.name !== undefined ? { name: p.name } : {}),
        },
      };
    case "bim.window":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "fill",
          classification: "window",
          openingId: p.openingId,
          storyId: p.storyId,
          ...(p.name !== undefined ? { name: p.name } : {}),
        },
      };
    case "bim.space":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "spatial-element",
          classification: "space",
          storyId: p.storyId,
          name: p.name,
          area: p.area,
          height: p.height,
          baseOffset: p.baseOffset,
        },
      };
    // --- COMPAT-BIM-003 (additive): components / materials / coordination ---
    case "bim.componentDef":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "component-definition",
          classification: entity.category,
          name: p.name,
          category: p.category,
          parameters: p.parameters,
          ...(p.materialId !== undefined ? { materialId: p.materialId } : {}),
        },
      };
    case "bim.componentInstance":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
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
        },
      };
    case "bim.material":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "domain-data",
          classification: "material",
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.color !== undefined ? { color: p.color } : {}),
          properties: p.properties,
        },
      };
    case "bim.grid":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "coordination",
          classification: "grid",
          storyId: p.storyId,
          name: p.name,
          uLines: p.uLines,
          vLines: p.vLines,
        },
      };
    case "bim.referencePlane":
      return {
        elementId: el.id,
        type: entity.type,
        semantics: {
          role: "coordination",
          classification: "reference-plane",
          storyId: p.storyId,
          name: p.name,
          start: p.start,
          end: p.end,
        },
      };
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
