/**
 * Client-side hit testing for the drafting workbench (COMPAT-CAD-001).
 *
 * Pure math over the SAME drafting core the server runs (LOCK-018: no
 * engine, no host APIs). Browser-safe module.
 */

import type { Element } from "@offisos/cad-app-shell/contracts/caddocument";
import { closestPointOnCurve } from "@offisos/cad-app-shell/drafting/snap";
import type { Vec2 } from "@offisos/cad-app-shell/drafting/precision";
import type { DraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import { entityCurves, isDraftingElement, elementToDraftEntity } from "@offisos/cad-app-shell/drafting/entities";
import * as g from "@offisos/cad-app-shell/drafting/geom2d";

export function parseDraftEntity(el: Element): DraftEntity | null {
  if (!isDraftingElement(el)) return null;
  try {
    return elementToDraftEntity(el);
  } catch {
    return null;
  }
}

/** Closest point on the entity's geometry + its distance to the probe. */
export function closestPointOnEntity(
  entity: DraftEntity,
  p: Vec2,
): { point: Vec2; distance: number } | null {
  let best: { point: Vec2; distance: number } | null = null;
  for (const curve of entityCurves(entity)) {
    const cp = closestPointOnCurve(curve, p);
    if (cp === null) continue;
    const d = g.distance(cp, p);
    if (best === null || d < best.distance) {
      best = { point: cp, distance: d };
    }
  }
  return best;
}

/** Nearest visible entity within `tol` world units. */
export function hitTest(entities: readonly Element[], world: Vec2, tol: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const el of entities) {
    const entity = parseDraftEntity(el);
    if (entity === null) continue;
    const cp = closestPointOnEntity(entity, world);
    if (cp === null) continue;
    if (cp.distance <= tol && (best === null || cp.distance < best.d)) {
      best = { id: el.id, d: cp.distance };
    }
  }
  return best?.id ?? null;
}
