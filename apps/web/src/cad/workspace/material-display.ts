/**
 * CAD-PARITY-012 (Issue #102) material display helpers (Web host) — the
 * shared view/formatting layer over the bim.material parity fields.
 *
 * Pure functions only (no React, no engines — LOCK-003/018). The SAME
 * vocabulary the shared materials core defines drives every host surface
 * that needs the material color/lineweight resolution: the Model canvas
 * paint loop (entity explicit > material > layer), the Properties
 * inspector swatches, the Coordination palette and the report history
 * lines (LOCK-004 parity by construction).
 */

import type { Element } from "@offisos/cad-app-shell/contracts/caddocument";
import {
  CATEGORY_DEFAULT_COLOR,
  DEFAULT_LINEWEIGHT,
  type MaterialCategory,
} from "@offisos/cad-app-shell/workspace/materials";

// Re-export the material lineweight default (the single display constant
// every host surface formats through).
export { DEFAULT_LINEWEIGHT };

/** The display view of one bim.material element (the SAME data the
 *  materials.list query serves; absent parity fields stay absent). */
export interface MaterialView {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly color?: readonly [number, number, number];
  readonly lineweight?: number;
}

/** The id-sorted material view rows of a snapshot's elements (deterministic
 *  — mirrors the materials.list query exactly). */
export function materialViewsOf(elements: readonly Element[]): readonly MaterialView[] {
  return elements
    .filter((el) => el.kind === "bim" && (el.props as Record<string, unknown>).type === "bim.material")
    .map((el) => {
      const p = el.props as Record<string, unknown>;
      let color: readonly [number, number, number] | undefined;
      if (
        Array.isArray(p.color) &&
        p.color.length === 3 &&
        p.color.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255)
      ) {
        const [r, g, b] = p.color as [number, number, number];
        color = [r, g, b];
      }
      return {
        id: el.id,
        name: typeof p.name === "string" ? p.name : el.id,
        ...(typeof p.category === "string" ? { category: p.category } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(typeof p.lineweight === "number" ? { lineweight: p.lineweight } : {}),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** [r, g, b] 0..255 → #RRGGBB (deterministic display formatting; malformed
 *  values fall back to the Generic category default — honest readers never
 *  guess a broken color). */
export function rgbToHex(rgb: readonly number[] | undefined): string {
  if (
    rgb === undefined || rgb.length !== 3 ||
    !rgb.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255)
  ) {
    return rgbToHex(CATEGORY_DEFAULT_COLOR.Generic);
  }
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** The resolved display color of a material view: the explicit color else
 *  the category default (the Generic default for unknown categories — the
 *  bounded fallback of the shared core). */
export function materialColorHex(material: { readonly category?: string; readonly color?: readonly number[] }): string {
  if (material.color !== undefined && material.color.length === 3) return rgbToHex(material.color);
  return rgbToHex(CATEGORY_DEFAULT_COLOR[(material.category ?? "Generic") as MaterialCategory]);
}

/** The resolved display lineweight of a material view (mm). */
export function materialLineweight(material: { readonly lineweight?: number }): number {
  return typeof material.lineweight === "number" && Number.isFinite(material.lineweight)
    ? material.lineweight
    : DEFAULT_LINEWEIGHT;
}

/** The full material display resolution (color + lineweight) — what the
 *  canvas applies between the entity's explicit override and the layer
 *  fallback. */
export interface MaterialDisplay {
  readonly color: string;
  readonly lineweight: number;
}

/** Resolve the display of a material id against the material table (null
 *  when unassigned or the id no longer resolves — the layer fallback). */
export function materialDisplayOf(
  materialId: string | null,
  materialsById: ReadonlyMap<string, MaterialView>,
): MaterialDisplay | null {
  if (materialId === null) return null;
  const material = materialsById.get(materialId);
  if (material === undefined) return null;
  return { color: materialColorHex(material), lineweight: materialLineweight(material) };
}
