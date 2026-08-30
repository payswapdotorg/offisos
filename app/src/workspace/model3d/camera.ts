/**
 * CAD-PARITY-009 (Issue #90): the deterministic professional 3D camera.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018) — imported by BOTH
 * hosts and the App API so 3D navigation semantics are THE SAME everywhere
 * (LOCK-004 Web/Electron semantic parity). The persisted state is
 * Camera3DState (contracts — non-versioned editor settings); this module is
 * the pure algebra over it:
 *
 *  - orbit: turntable orbit (yaw about world +Z, pitch about the camera
 *    right axis, elevation clamped to ±89.9° — a documented deterministic
 *    clamp that avoids the polar singularity; a pitch beyond the clamp
 *    saturates at the clamp).
 *  - pan: translate eye+target by (right·dx + up·dy)·worldPerPixel.
 *  - zoom: orthographic scales orthoHalfHeight by 1/factor (clamped to
 *    (1e-6, 1e12]); perspective scales the eye↔target distance by 1/factor
 *    (same clamp on the distance; the target never moves).
 *  - fit: derive the camera from a bounding box + viewport aspect with the
 *    documented margin factor 1.1 (all eight box corners must stay inside
 *    the view). Orthographic derives half-height = max(halfY, halfX/aspect);
 *    perspective solves the EXACT per-corner frustum bound (see
 *    fitCameraToBBox — sufficient for arbitrary direction/aspect/fov).
 *  - standard views: the six canonical views + isometric with EXACT axis
 *    directions (top: eye at +Z·d, up +Y; front: eye at −Y·d, up +Z; right:
 *    eye at +X·d, up +Z; iso: eye direction (1,−1,1)/√3, up +Z — the
 *    Z-up world convention, mirroring the bim camera presets' derivation).
 *  - view cube: the deterministic navigation-surface model (6 faces, 8
 *    corners, 12 edges) with screen-space hit testing (bilinear 3×3 zone
 *    subdivision per visible face — face/edge/corner zones; fixed face
 *    order top→bottom→front→back→left→right for deterministic priority).
 *
 * There is NO mutation anywhere — every operation returns a new validated
 * Camera3DState (normalizeCamera rejects degenerate frames).
 */

import type { Camera3DState } from "../../contracts/caddocument.js";
import type { Vec3 } from "../../contracts/geometry.js";
import {
  EPS3D,
  fmtNum,
  v3Add,
  v3Cross,
  v3Dot,
  v3Length,
  v3Normalize,
  v3Scale,
  v3Sub,
} from "./math3d.js";

/** A world-space axis-aligned bounding box (xmin..xmax, ymin..ymax, zmin..zmax). */
export interface BBox3D {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** The empty extents sentinel (fit on empty content falls back to the unit
 *  box — the EMPTY_MODEL_EXTENTS precedent). */
export const EMPTY_BBOX3D: BBox3D = {
  minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
};

export function bbox3DIsEmpty(b: BBox3D): boolean {
  return b.maxX <= b.minX && b.maxY <= b.minY && b.maxZ <= b.minZ;
}

/** The union hull of two boxes (deterministic component-wise min/max). */
export function bbox3DUnion(a: BBox3D, b: BBox3D): BBox3D {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function bbox3DCenter(b: BBox3D): Vec3 {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
}

/** The box diagonal length (the fit distance basis). */
export function bbox3DDiagonal(b: BBox3D): number {
  const dx = b.maxX - b.minX;
  const dy = b.maxY - b.minY;
  const dz = b.maxZ - b.minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// --- Camera frame + validation ----------------------------------------------

/** The orthonormal camera view frame derived from a Camera3DState. */
export interface CameraFrame {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

/** Derive the orthonormal view frame (forward = normalized target−eye;
 *  right = normalize(forward × upInput); up = right × forward). Returns null
 *  when the frame is degenerate (eye == target, or up ∥ forward). */
export function cameraFrame(camera: Camera3DState): CameraFrame | null {
  const forward = v3Normalize(v3Sub(camera.target, camera.eye));
  if (forward === null) return null;
  const right = v3Normalize(v3Cross(forward, camera.up));
  if (right === null) return null;
  const up = v3Cross(right, forward);
  return { forward, right, up };
}

/** Structural camera validation (finite fields, valid mode, positive
 *  orthoHalfHeight, fov in (0,180), non-degenerate frame). The persisted
 *  state is ALWAYS validated through this before use — a camera that fails
 *  is a typed decline (camera_invalid), never silently repaired. */
export function validateCamera(camera: Camera3DState): string | null {
  const { eye, target, up, mode, orthoHalfHeight, fovDeg } = camera;
  const finiteVec = (v: Vec3) => v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!finiteVec(eye) || !finiteVec(target) || !finiteVec(up)) {
    return "camera eye/target/up must be finite 3-vectors";
  }
  if (mode !== "orthographic" && mode !== "perspective") {
    return "camera mode must be 'orthographic' or 'perspective'";
  }
  if (!(orthoHalfHeight > 0) || !Number.isFinite(orthoHalfHeight)) {
    return "camera orthoHalfHeight must be a finite number > 0";
  }
  if (!(fovDeg > 0 && fovDeg < 180) || !Number.isFinite(fovDeg)) {
    return "camera fovDeg must be a finite number in (0, 180)";
  }
  if (cameraFrame(camera) === null) {
    return "camera frame is degenerate (eye == target or up parallel to the view direction)";
  }
  return null;
}

/** A fully normalized camera: the frame re-derived so up is exactly ⊥
 *  forward (the persisted up input is only a hint; the stored state is the
 *  normalized frame — deterministic rounding through the same arithmetic on
 *  every host). Returns null when degenerate. */
export function normalizeCamera(camera: Camera3DState): Camera3DState | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  return {
    eye: [...camera.eye] as Vec3,
    target: [...camera.target] as Vec3,
    up: frame.up,
    mode: camera.mode,
    orthoHalfHeight: camera.orthoHalfHeight,
    fovDeg: camera.fovDeg,
  };
}

// --- Navigation operations ---------------------------------------------------

/** The orbit elevation clamp (degrees from the horizontal plane — avoids the
 *  turntable polar singularity; documented deterministic saturation). */
export const ORBIT_ELEVATION_CLAMP_DEG = 89.9;

/** Turntable orbit: yaw degrees about world +Z, then pitch degrees about the
 *  camera right axis, elevation clamped to ±ORBIT_ELEVATION_CLAMP_DEG. The
 *  target stays FIXED (the orbit pivot); distance eye↔target is preserved
 *  exactly through both rotations (rotation matrices are applied to the
 *  eye−target vector). Returns null when the input camera is degenerate. */
export function orbitCamera(camera: Camera3DState, yawDeg: number, pitchDeg: number): Camera3DState | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const v = v3Sub(camera.eye, camera.target);
  // Yaw: rotate v about world +Z.
  const yawRad = (yawDeg * Math.PI) / 180;
  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  const afterYaw: Vec3 = [
    v[0] * cy - v[1] * sy,
    v[0] * sy + v[1] * cy,
    v[2],
  ];
  // Pitch: rotate about the camera right axis (pre-yaw right — the screen
  // the user is looking at), then clamp elevation.
  const right = frame.right;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const dotVR = afterYaw[0] * right[0] + afterYaw[1] * right[1] + afterYaw[2] * right[2];
  const crossVR: Vec3 = [
    right[1] * afterYaw[2] - right[2] * afterYaw[1],
    right[2] * afterYaw[0] - right[0] * afterYaw[2],
    right[0] * afterYaw[1] - right[1] * afterYaw[0],
  ];
  let rotated: Vec3 = [
    afterYaw[0] * cp + crossVR[0] * sp + right[0] * dotVR * (1 - cp),
    afterYaw[1] * cp + crossVR[1] * sp + right[1] * dotVR * (1 - cp),
    afterYaw[2] * cp + crossVR[2] * sp + right[2] * dotVR * (1 - cp),
  ];
  // Elevation clamp: the angle of the horizontal projection vs |v|.
  const horiz = Math.sqrt(rotated[0] * rotated[0] + rotated[1] * rotated[1]);
  const len = v3Length(rotated);
  if (len > EPS3D && horiz > 0) {
    const elevRad = Math.atan2(rotated[2], horiz);
    const maxRad = (ORBIT_ELEVATION_CLAMP_DEG * Math.PI) / 180;
    if (elevRad > maxRad || elevRad < -maxRad) {
      const clamped = Math.max(-maxRad, Math.min(maxRad, elevRad));
      const horizLen = Math.sqrt(Math.max(0, len * len - rotated[2] * rotated[2])) || horiz;
      const newHoriz = Math.cos(clamped) * len;
      const scale = horiz > 0 ? newHoriz / horizLen : 0;
      rotated = [rotated[0] * scale, rotated[1] * scale, Math.sin(clamped) * len];
    }
  }
  const eye = v3Add(camera.target, rotated);
  const newFrame = cameraFrame({ ...camera, eye });
  if (newFrame === null) return null;
  return {
    eye,
    target: camera.target,
    up: newFrame.up,
    mode: camera.mode,
    orthoHalfHeight: camera.orthoHalfHeight,
    fovDeg: camera.fovDeg,
  };
}

/** Pan: translate eye AND target by (right·dx + up·dy)·worldPerPixel (the
 *  screen-plane translation; zoom state untouched). */
export function panCamera(camera: Camera3DState, dxPixels: number, dyPixels: number, worldPerPixel: number): Camera3DState | null {
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const sx = dxPixels * worldPerPixel;
  const sy = dyPixels * worldPerPixel;
  const delta: Vec3 = [
    frame.right[0] * sx + frame.up[0] * sy,
    frame.right[1] * sx + frame.up[1] * sy,
    frame.right[2] * sx + frame.up[2] * sy,
  ];
  return {
    eye: v3Add(camera.eye, delta),
    target: v3Add(camera.target, delta),
    up: camera.up,
    mode: camera.mode,
    orthoHalfHeight: camera.orthoHalfHeight,
    fovDeg: camera.fovDeg,
  };
}

/** The zoom clamp bounds (ortho half-height and perspective distance both
 *  stay within [1e-6, 1e12] — deterministic saturation, documented). */
export const ZOOM_MIN = 1e-6;
export const ZOOM_MAX = 1e12;

/** Zoom by a factor (> 1 zooms IN — the world appears `factor`× larger):
 *  orthographic divides orthoHalfHeight; perspective divides the eye↔target
 *  distance (the target stays fixed). */
export function zoomCamera(camera: Camera3DState, factor: number): Camera3DState | null {
  if (!Number.isFinite(factor) || !(factor > 0)) return null;
  if (camera.mode === "orthographic") {
    const h = camera.orthoHalfHeight / factor;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, h));
    return { ...camera, orthoHalfHeight: clamped };
  }
  const frame = cameraFrame(camera);
  if (frame === null) return null;
  const v = v3Sub(camera.eye, camera.target);
  const len = v3Length(v);
  if (len <= EPS3D) return null;
  const newLen = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, len / factor));
  const scaled = v3Scale(v, newLen / len);
  return { ...camera, eye: v3Add(camera.target, scaled) };
}

/** The fit margin factor (the camera is pulled back so all eight box corners
 *  sit strictly inside the view with a 10% margin). */
export const FIT_MARGIN = 1.1;

/** Fit a camera to a bounding box for a viewport of the given aspect
 *  (width/height). Empty boxes fall back to the unit box centered at the
 *  origin (the EMPTY_MODEL_EXTENTS precedent). The fitted camera keeps the
 *  CURRENT eye direction (fit does not reorient — it recenters + resizes;
 *  deterministic and non-surprising), and keeps the mode/fovDeg. For
 *  orthographic it derives orthoHalfHeight = max(halfY, halfX/aspect)·
 *  FIT_MARGIN. For PERSPECTIVE the distance is the EXACT per-corner solve:
 *  the camera sits at eye = center + dir·d (dir the kept eye direction, so
 *  forward = −dir and the frame's right/up stay ⊥ dir), and each corner
 *  offset v ∈ {±halfX,±halfY,±halfZ} has camera-plane coordinates
 *  xc = v·right, yc = v·up, depth zc = d − v·dir; the pinhole viewport bound
 *  |xc| ≤ zc·aspect·tan(fovY/2) ∧ |yc| ≤ zc·tan(fovY/2) is LINEAR in d:
 *
 *      d ≥ |v·right| / (aspect·tan(fovY/2)) + v·dir
 *      d ≥ |v·up|   / tan(fovY/2)           + v·dir
 *
 *  The max over all 8 corners is the minimal distance that puts every
 *  corner inside the frustum for ARBITRARY camera direction/aspect/fov (a
 *  bounding-sphere or axis-extent bound cannot guarantee this for oblique
 *  views — a corner nearer the camera occupies more screen angle than its
 *  world extent suggests); · FIT_MARGIN keeps the documented 10% margin,
 *  which also keeps every corner strictly in front of the eye plane (the
 *  antipodal-pair max bounds |v·dir| ≤ d_req, so zc ≥ 0.1·|v·dir| > 0). */
export function fitCameraToBBox(
  camera: Camera3DState,
  box: BBox3D,
  aspect: number,
): Camera3DState | null {
  const frame = cameraFrame(camera);
  if (frame === null || !Number.isFinite(aspect) || !(aspect > 0)) return null;
  const effective = bbox3DIsEmpty(box)
    ? { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }
    : box;
  const cx = (effective.minX + effective.maxX) / 2;
  const cy = (effective.minY + effective.maxY) / 2;
  const cz = (effective.minZ + effective.maxZ) / 2;
  const halfX = (effective.maxX - effective.minX) / 2;
  const halfY = (effective.maxY - effective.minY) / 2;
  const halfZ = (effective.maxZ - effective.minZ) / 2;
  if (camera.mode === "orthographic") {
    const halfHeight = Math.max(halfY, halfX / aspect) * FIT_MARGIN;
    // Keep the current eye DIRECTION; distance irrelevant for ortho —
    // keep the current distance (deterministic: reuse the existing offset).
    const v = v3Sub(camera.eye, camera.target);
    return {
      eye: v3Add([cx, cy, cz], v),
      target: [cx, cy, cz],
      up: camera.up,
      mode: camera.mode,
      orthoHalfHeight: halfHeight,
      fovDeg: camera.fovDeg,
    };
  }
  // Perspective: the EXACT per-corner frustum bound (see the doc comment —
  // each corner contributes a LINEAR lower bound on the distance; the max
  // over the 8 corners is minimal-sufficient for any direction/aspect/fov).
  const fovRad = (camera.fovDeg * Math.PI) / 180;
  const tanY = Math.tan(fovRad / 2);
  const tanX = tanY * aspect;
  const dir = v3Normalize(v3Sub(camera.eye, camera.target));
  if (dir === null) return null;
  // frame.right/frame.up are the kept-direction camera-plane axes (both ⊥
  // dir — frame derives from the same forward/up the returned camera keeps).
  let required = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const v: Vec3 = [sx * halfX, sy * halfY, sz * halfZ];
        const alongDir = v3Dot(v, dir);
        const xc = v3Dot(v, frame.right);
        const yc = v3Dot(v, frame.up);
        required = Math.max(required, Math.abs(xc) / tanX + alongDir, Math.abs(yc) / tanY + alongDir);
      }
    }
  }
  const dist = required * FIT_MARGIN;
  return {
    eye: v3Add([cx, cy, cz], v3Scale(dir, dist)),
    target: [cx, cy, cz],
    up: camera.up,
    mode: camera.mode,
    orthoHalfHeight: camera.orthoHalfHeight,
    fovDeg: camera.fovDeg,
  };
}

// --- Standard views ----------------------------------------------------------

/** The six canonical standard views + isometric (the professional
 *  navigation vocabulary; exact axis directions, Z-up world). */
export type StandardViewName = "top" | "bottom" | "front" | "back" | "left" | "right" | "iso";

export const STANDARD_VIEW_NAMES: readonly StandardViewName[] = [
  "top", "bottom", "front", "back", "left", "right", "iso",
];

/** The exact eye DIRECTION (unit) and up vector per standard view. */
export const STANDARD_VIEW_FRAMES: Readonly<Record<StandardViewName, { readonly dir: Vec3; readonly up: Vec3 }>> = {
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  // The exact isometric direction (1,−1,1)/√3 — matches bim/camera.ts iso.
  iso: { dir: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], up: [0, 0, 1] },
};

/** The default camera derived when none is persisted: the isometric view of
 *  the unit box (deterministic baseline for every host). */
export function defaultCamera(): Camera3DState {
  return standardCameraFor("iso", {
    minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5,
  }, 1, 60, "orthographic");
}

/** The camera for a standard view of a bounding box: the exact view frame at
 *  a distance covering the box (orthographic half-height = max(halfY,
 *  halfX/aspect)·FIT_MARGIN; perspective distance as in fitCameraToBBox;
 *  distance for ortho = the same perspective-consistent distance so the two
 *  modes frame identically). */
export function standardCameraFor(
  view: StandardViewName,
  box: BBox3D,
  aspect: number,
  fovDeg: number,
  mode: "orthographic" | "perspective",
): Camera3DState {
  const effective = bbox3DIsEmpty(box)
    ? { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }
    : box;
  const cx = (effective.minX + effective.maxX) / 2;
  const cy = (effective.minY + effective.maxY) / 2;
  const cz = (effective.minZ + effective.maxZ) / 2;
  const halfX = (effective.maxX - effective.minX) / 2;
  const halfY = (effective.maxY - effective.minY) / 2;
  const halfZ = (effective.maxZ - effective.minZ) / 2;
  const fitHalf = Math.max(halfY, halfX / aspect, halfZ);
  const fovRad = (fovDeg * Math.PI) / 180;
  const dist = Math.max((fitHalf / Math.sin(fovRad / 2)) * FIT_MARGIN, bbox3DDiagonal(effective) * 1.5);
  const halfHeight = Math.max(halfY, halfX / aspect) * FIT_MARGIN;
  const { dir, up } = STANDARD_VIEW_FRAMES[view];
  return {
    eye: v3Add([cx, cy, cz], v3Scale(dir, dist)),
    target: [cx, cy, cz],
    up,
    mode,
    orthoHalfHeight: halfHeight,
    fovDeg,
  };
}

/** Canonical camera echo for command-line/UI text (deterministic). */
export function formatCamera(camera: Camera3DState): string {
  return `eye ${fmtNum(camera.eye[0])},${fmtNum(camera.eye[1])},${fmtNum(camera.eye[2])} target ${fmtNum(camera.target[0])},${fmtNum(camera.target[1])},${fmtNum(camera.target[2])} ${camera.mode}${camera.mode === "perspective" ? ` fov ${fmtNum(camera.fovDeg)}` : ` half ${fmtNum(camera.orthoHalfHeight)}`}`;
}

// --- View cube (the navigation surface model) --------------------------------

/** A view-cube face/corner/edge zone (the deterministic hit model). */
export type ViewCubeZone =
  | { readonly kind: "face"; readonly face: StandardViewName }
  | { readonly kind: "edge"; readonly faces: readonly [StandardViewName, StandardViewName] }
  | { readonly kind: "corner"; readonly faces: readonly [StandardViewName, StandardViewName, StandardViewName] };

/** The view-cube geometry: a unit cube centered at the world origin with
 *  face centers at the ±unit axes (the standard views' directions). Corners
 *  are the (±1,±1,±1)/√3 octant directions (the iso views). Edges are the
 *  two-face junctions. Deterministic construction — no randomness. */
export const VIEW_CUBE_FACE_CENTERS: Readonly<Record<StandardViewName, Vec3>> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  iso: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)],
};

/** The view-cube model corners in a fixed deterministic order (sign triples
 *  ordered lexicographically by (x,y,z) signs: (−,−,−) first … (+,+,+)
 *  last, each normalized to the unit sphere octant). */
export function viewCubeCorners(): readonly (readonly [number, number, number])[] {
  const out: Array<readonly [number, number, number]> = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const len = Math.sqrt(3);
        out.push([sx / len, sy / len, sz / len]);
      }
    }
  }
  return out;
}

/** Classify a direction ON the view cube into a face/edge/corner zone by its
 *  dominant components: the largest |component| dominates (face); two
 *  components within the documented 0.9 cosine of each other and larger than
 *  the third (edge); all three within it (corner). Deterministic tie-breaks
 *  in x→y→z order. This is the mathematical hit model both hosts' view-cube
 *  widgets share (a screen click maps to a ray; the ray's cube intersection
 *  point classifies through this function). */
export function classifyViewCubeZone(p: Vec3): ViewCubeZone {
  const ax = Math.abs(p[0]);
  const ay = Math.abs(p[1]);
  const az = Math.abs(p[2]);
  const sx = p[0] >= 0 ? 1 : -1;
  const sy = p[1] >= 0 ? 1 : -1;
  const sz = p[2] >= 0 ? 1 : -1;
  const faceOf = (axis: 0 | 1 | 2, sign: number): StandardViewName => {
    if (axis === 0) return sign > 0 ? "right" : "left";
    if (axis === 1) return sign > 0 ? "back" : "front";
    return sign > 0 ? "top" : "bottom";
  };
  // Sorted axes (descending) with deterministic tie-breaks (x before y
  // before z on exact ties).
  const entries: Array<{ axis: 0 | 1 | 2; mag: number }> = [
    { axis: 0, mag: ax },
    { axis: 1, mag: ay },
    { axis: 2, mag: az },
  ];
  entries.sort((a, b) => (a.mag === b.mag ? a.axis - b.axis : b.mag - a.mag));
  const [first, second, third] = entries as [ { axis: 0 | 1 | 2; mag: number }, { axis: 0 | 1 | 2; mag: number }, { axis: 0 | 1 | 2; mag: number } ];
  const signOf = (axis: 0 | 1 | 2): number => (axis === 0 ? sx : axis === 1 ? sy : sz);
  // Edge/corner threshold: components within a factor corresponding to a
  // 25.8° angular band share dominance (cos ≈ 0.9).
  const near = (a: number, b: number): boolean => b > 0 && a / b > 0.9;
  const f1 = faceOf(first.axis, signOf(first.axis));
  if (near(third.mag, first.mag)) {
    // All three comparable → corner (iso octant).
    const f2 = faceOf(second.axis, signOf(second.axis));
    const f3 = faceOf(third.axis, signOf(third.axis));
    const faces = [f1, f2, f3].sort((a, b) => STANDARD_VIEW_NAMES.indexOf(a) - STANDARD_VIEW_NAMES.indexOf(b)) as [StandardViewName, StandardViewName, StandardViewName];
    return { kind: "corner", faces };
  }
  if (near(second.mag, first.mag)) {
    const f2 = faceOf(second.axis, signOf(second.axis));
    const faces = [f1, f2].sort((a, b) => STANDARD_VIEW_NAMES.indexOf(a) - STANDARD_VIEW_NAMES.indexOf(b)) as [StandardViewName, StandardViewName];
    return { kind: "edge", faces };
  }
  return { kind: "face", face: f1 };
}

/** The camera command for a view-cube zone click: a face targets that
 *  standard view; an edge targets the 45° blend of its two faces (the exact
 *  normalized sum of the two face directions); a corner targets the iso view
 *  of that octant (the exact normalized sign triple). All through
 *  standardCameraFor-equivalent framing on the given box. */
export function cameraForViewCubeZone(
  zone: ViewCubeZone,
  box: BBox3D,
  aspect: number,
  fovDeg: number,
  mode: "orthographic" | "perspective",
): Camera3DState {
  if (zone.kind === "face") {
    return standardCameraFor(zone.face, box, aspect, fovDeg, mode);
  }
  if (zone.kind === "edge") {
    const a = VIEW_CUBE_FACE_CENTERS[zone.faces[0]];
    const b = VIEW_CUBE_FACE_CENTERS[zone.faces[1]];
    return blendViewCamera(v3Add(a, b), box, aspect, fovDeg, mode);
  }
  const corners = viewCubeCorners();
  const want = zone.faces.map((f) => f).join("+");
  // Find the octant whose three faces match the corner zone's faces.
  for (const c of corners) {
    const sx = c[0] >= 0 ? 1 : -1;
    const sy = c[1] >= 0 ? 1 : -1;
    const sz = c[2] >= 0 ? 1 : -1;
    const faces = ["right", "left", "back", "front", "top", "bottom"].filter((f) => {
      if (f === "right") return sx > 0;
      if (f === "left") return sx < 0;
      if (f === "back") return sy > 0;
      if (f === "front") return sy < 0;
      if (f === "top") return sz > 0;
      return sz < 0;
    }).sort((a, b) => STANDARD_VIEW_NAMES.indexOf(a as StandardViewName) - STANDARD_VIEW_NAMES.indexOf(b as StandardViewName)).join("+");
    if (faces === want) {
      return blendViewCamera(c, box, aspect, fovDeg, mode);
    }
  }
  // Unreachable for well-formed corner zones; deterministic fallback = iso.
  return standardCameraFor("iso", box, aspect, fovDeg, mode);
}

/** A camera looking along an arbitrary unit view direction with +Z up
 *  (the blend camera for edge/corner zones). */
function blendViewCamera(
  dirUnnormalized: Vec3,
  box: BBox3D,
  aspect: number,
  fovDeg: number,
  mode: "orthographic" | "perspective",
): Camera3DState {
  const dir = v3Normalize(dirUnnormalized) ?? [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const effective = bbox3DIsEmpty(box)
    ? { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }
    : box;
  const cx = (effective.minX + effective.maxX) / 2;
  const cy = (effective.minY + effective.maxY) / 2;
  const cz = (effective.minZ + effective.maxZ) / 2;
  const halfX = (effective.maxX - effective.minX) / 2;
  const halfY = (effective.maxY - effective.minY) / 2;
  const halfZ = (effective.maxZ - effective.minZ) / 2;
  const fitHalf = Math.max(halfY, halfX / aspect, halfZ);
  const fovRad = (fovDeg * Math.PI) / 180;
  const dist = Math.max((fitHalf / Math.sin(fovRad / 2)) * FIT_MARGIN, bbox3DDiagonal(effective) * 1.5);
  const halfHeight = Math.max(halfY, halfX / aspect) * FIT_MARGIN;
  return {
    eye: v3Add([cx, cy, cz], v3Scale(dir, dist)),
    target: [cx, cy, cz],
    up: [0, 0, 1],
    mode,
    orthoHalfHeight: halfHeight,
    fovDeg,
  };
}

/** The view direction of a camera (unit target−eye) — the shared input to
 *  classifyViewCubeZone from any host. */
export function cameraViewDirection(camera: Camera3DState): Vec3 | null {
  return v3Normalize(v3Sub(camera.target, camera.eye));
}
