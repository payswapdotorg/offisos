/**
 * CAD-PARITY-009 (Issue #90): the bounded 3D solid descriptor builders.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018). The modeling
 * commands compose the EXISTING GeometryDescriptor vocabulary (contracts/
 * geometry.ts — box/cylinder/extrude/transform; NO new engine operations in
 * this slice) with UCS placement matrices:
 *
 *  - placeBox: the box's base corner sits at the ACTIVE UCS origin and its
 *    edges run along the UCS axes (local [0..w, 0..d, 0..h] mapped through
 *    the UCS→world matrix) — expressed as a transform-wrapped box descriptor.
 *  - placeCylinder: the cylinder's base center sits at the UCS origin, axis
 *    along the UCS Z axis (the descriptor's native origin/direction).
 *  - placeExtrude: the profile polygon lives in the UCS XY plane (base z
 *    offset supported) extruded along the UCS Z axis by height.
 *  - transformDescriptor: wrap an existing descriptor with an affine matrix
 *    (the modeling MOVE/ROTATE/SCALE composition — deterministic matrix
 *    order documented per builder).
 *
 * Engine ids never appear here — descriptors are engine-neutral geometry
 * DECLARATIONS; the adapter realizes them (meshToken/bbox/provenance).
 */

import type { GeometryDescriptor, Matrix4, Vec3, Vec2 } from "../../contracts/geometry.js";
import type { UcsRecord } from "../../contracts/caddocument.js";
import {
  mulMatrix,
  rotationMatrix,
  scaleMatrix3,
  translationMatrix,
  v3Sub,
} from "./math3d.js";
import { ucsToWorldMatrix } from "./ucs.js";

/** A box placed at the ACTIVE UCS: base corner at the UCS origin, edges
 *  along the UCS axes (local extents [0..width, 0..depth, 0..height]). */
export function placeBox(ucs: UcsRecord, width: number, depth: number, height: number): GeometryDescriptor {
  return {
    shape: "transform",
    matrix: ucsToWorldMatrix(ucs),
    target: { shape: "box", width, depth, height },
  };
}

/** A cylinder placed at the ACTIVE UCS: base center at the UCS origin, axis
 *  along the UCS Z axis (the descriptor's native origin/direction — no
 *  transform wrapper needed). */
export function placeCylinder(ucs: UcsRecord, radius: number, height: number): GeometryDescriptor {
  const world = ucsToWorldMatrix(ucs);
  const origin: Vec3 = [world[3]!, world[7]!, world[11]!];
  const direction: Vec3 = [world[8]!, world[9]!, world[10]!];
  return { shape: "cylinder", radius, height, origin, direction };
}

/** An extrusion placed at the ACTIVE UCS: the profile polygon in the UCS XY
 *  plane (at baseZ along UCS Z), extruded +Z by height. */
export function placeExtrude(ucs: UcsRecord, profile: readonly Vec2[], height: number, baseZ = 0): GeometryDescriptor {
  const world = ucsToWorldMatrix(ucs);
  const base: Vec3 = [
    world[3]! + world[8]! * baseZ,
    world[7]! + world[9]! * baseZ,
    world[11]! + world[10]! * baseZ,
  ];
  return { shape: "extrude", profile, height, base };
}

/** Wrap an existing descriptor with an affine transform (the modeling
 *  composition primitive). */
export function transformDescriptor(matrix: Matrix4, target: GeometryDescriptor): GeometryDescriptor {
  return { shape: "transform", matrix, target };
}

/** MOVE: translate by a world-space delta (UCS-aware numeric input is
 *  resolved to a world delta by the caller through ucsDirectionToWorld). */
export function moveDescriptor(target: GeometryDescriptor, worldDelta: Vec3): GeometryDescriptor {
  return transformDescriptor(translationMatrix(worldDelta), target);
}

/** ROTATE: `deg` degrees about the world axis through `base` along
 *  `worldAxis` (T(base)·R·T(−base) — fixed composition order). Returns null
 *  for a degenerate axis (the caller surfaces the typed decline). */
export function rotateDescriptor(target: GeometryDescriptor, worldAxis: Vec3, deg: number, base: Vec3): GeometryDescriptor | null {
  const r = rotationMatrix(worldAxis, deg);
  if (r === null) return null;
  const m = mulMatrix(mulMatrix(translationMatrix(base), r), translationMatrix(v3Sub([0, 0, 0], base)));
  return transformDescriptor(m, target);
}

/** SCALE: uniform factor about the base point (T(base)·S·T(−base)). */
export function scaleDescriptor(target: GeometryDescriptor, factor: number, base: Vec3): GeometryDescriptor {
  const s = scaleMatrix3(factor, factor, factor);
  const m = mulMatrix(mulMatrix(translationMatrix(base), s), translationMatrix(v3Sub([0, 0, 0], base)));
  return transformDescriptor(m, target);
}
