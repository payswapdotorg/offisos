/**
 * Standard 3D camera states (COMPAT-CAD-002, Issue #39: "3D viewport
 * navigation and standard camera states").
 *
 * PURE and deterministic: a camera preset + the model's derived world
 * bounding box map to an exact eye/target/up triple with fixed construction
 * rules, so the Web host and the Electron host drive identical view
 * parameters through the same shared module (§5.5 parity — no per-host
 * camera math).
 *
 * Constructions (target = bbox center, extent = bbox diagonal; d = extent·2):
 *   iso   — canonical isometric: azimuth 45°, elevation atan(1/√2)
 *           (≈ 35.264°), the exact corner-view direction (1, −1, 1)/√3.
 *   top   — eye directly above the target (0, 0, d), up = +Y world.
 *   front — eye at (0, −d, 0) looking at the target, up = +Z.
 *   right — eye at (d, 0, 0) looking at the target, up = +Z.
 *
 * The derived eye is target + direction·d (IEEE-754, fixed operation order).
 */

import type { BimCameraPreset } from "../contracts/caddocument.js";
import type { WorldBBox } from "./geometry.js";

export const BIM_CAMERA_PRESET_NAMES: readonly BimCameraPreset[] = ["iso", "top", "front", "right"];

export interface StandardCamera {
  readonly preset: BimCameraPreset;
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

/** Unit view direction (from target toward the eye) per preset. */
function presetDirection(preset: BimCameraPreset): readonly [number, number, number] {
  switch (preset) {
    case "iso": {
      // Exact isometric direction: (1, -1, 1)/sqrt(3).
      const k = 1 / Math.sqrt(3);
      return [k, -k, k];
    }
    case "top":
      return [0, 0, 1];
    case "front":
      return [0, -1, 0];
    case "right":
      return [1, 0, 0];
  }
}

/** World up per preset (top view uses +Y so north stays up on screen). */
function presetUp(preset: BimCameraPreset): readonly [number, number, number] {
  return preset === "top" ? [0, 1, 0] : [0, 0, 1];
}

/** Derive the standard camera for a preset + world bbox. Throws on an
 *  unknown preset or a degenerate bbox (LOCK-007). */
export function standardCamera(preset: unknown, bbox: WorldBBox | null): StandardCamera {
  if (typeof preset !== "string" || !(BIM_CAMERA_PRESET_NAMES as readonly string[]).includes(preset)) {
    throw new Error(`camera preset must be one of ${BIM_CAMERA_PRESET_NAMES.join(" | ")}, got ${JSON.stringify(preset)}`);
  }
  const name = preset as BimCameraPreset;
  if (bbox === null) {
    throw new Error("standardCamera requires a model bounding box (no solid-bearing BIM elements found)");
  }
  const [minX, minY, minZ, maxX, maxY, maxZ] = bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const ex = maxX - minX;
  const ey = maxY - minY;
  const ez = maxZ - minZ;
  const diagonal = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (!(diagonal > 0) || !Number.isFinite(diagonal)) {
    throw new Error("standardCamera requires a non-degenerate model bounding box");
  }
  const distance = diagonal * 2;
  const dir = presetDirection(name);
  const eye: readonly [number, number, number] = [
    cx + dir[0] * distance,
    cy + dir[1] * distance,
    cz + dir[2] * distance,
  ];
  return { preset: name, eye, target: [cx, cy, cz], up: presetUp(name) };
}
