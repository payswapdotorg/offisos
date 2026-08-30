/**
 * CAD-PARITY-009 deterministic 3D core tests (Issue #90) — the engine-free
 * model3d shared core: the camera algebra (frame derivation/validation/
 * normalization with degenerate frames rejected; turntable orbit with the
 * ±89.9° elevation clamp AND the exact combined diagonal-drag update
 * (pitch about the YAW-UPDATED right axis — the PR #92 review round-2 fix);
 * pan; zoom with clamp bounds in both modes; fit-extents with the unit-box
 * fallback AND the exact per-corner solve in BOTH modes (every corner
 * strictly inside the viewport for arbitrary direction/aspect/fov —
 * including roll and strongly non-cubic boxes; the PR #92 remediation); the
 * exact standard-view frames;
 * the view-cube zone model), the projection math (exact orthographic AND
 * perspective screen math, unprojectAtDepth as the bit-exact inverse,
 * picking rays, the ray/AABB slab test, pickElements with the EXACT
 * (distance, then element id) hit ordering incl. a deliberate tie,
 * projectBoxCorners and the 12 boxEdges in fixed order), the UCS algebra
 * (orthonormal right-handed triples within UCS_ORTHONORMAL_TOLERANCE,
 * world↔UCS exact inverses, grid snap, typed 3D numeric input), the section
 * preview foundation (plane∩box with the canonical polygon order, the
 * facets/missed/noExtent classification, record validation) and the bounded
 * solid descriptors (UCS placement + transform composition).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  // camera
  cameraFrame,
  validateCamera,
  normalizeCamera,
  orbitCamera,
  panCamera,
  zoomCamera,
  ZOOM_MIN,
  ZOOM_MAX,
  FIT_MARGIN,
  fitCameraToBBox,
  STANDARD_VIEW_FRAMES,
  STANDARD_VIEW_NAMES,
  standardCameraFor,
  viewCubeCorners,
  classifyViewCubeZone,
  cameraForViewCubeZone,
  cameraViewDirection,
  EMPTY_BBOX3D,
  // projection
  projectPoint,
  unprojectAtDepth,
  screenRay,
  rayIntersectsBox,
  pickElements,
  projectBoxCorners,
  boxEdges,
  // ucs
  UCS_ORTHONORMAL_TOLERANCE,
  WORLD_UCS,
  validateUcsAxes,
  ucsToWorldMatrix,
  worldToUcsMatrix,
  ucsToWorld,
  worldToUcs,
  ucsDirectionToWorld,
  worldDirectionToUcs,
  snapToUcsGrid,
  snapWorldToUcsGrid,
  parseTypedPoint3D,
  resolveTypedPoint3D,
  // section
  validateSectionPlaneRecord,
  normalizeSectionNormal,
  intersectPlaneBox,
  buildSectionPreview,
  SECTION_PREVIEW_FORMAT,
  // svg3d
  buildScene3DSVG,
  // solids
  placeBox,
  placeCylinder,
  placeExtrude,
  moveDescriptor,
  rotateDescriptor,
  scaleDescriptor,
  // math
  transformPoint,
  mulMatrix,
  IDENTITY_MATRIX4,
  type BBox3D,
  type PickableElement,
  type Ray3,
} from "../src/workspace/model3d/index.js";
import type { Camera3DState, SectionPlaneRecord, UcsRecord } from "../src/contracts/caddocument.js";
import type { GeometryDescriptor, Vec3 } from "../src/contracts/geometry.js";

const NOW = "2026-01-01T00:00:00.000Z";

/** A camera at +X looking at the origin with +Z up (right = +Y). */
const SIDE_CAMERA: Camera3DState = {
  eye: [10, 0, 0], target: [0, 0, 0], up: [0, 0, 1],
  mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60,
};

/** The CAD-PARITY-009 reference workplane: origin [10,0,0], a 90° turn about
 *  world Z (x=[0,1,0], y=[−1,0,0], z=[0,0,1]). */
const EAST_UCS: UcsRecord = {
  id: "ucs-000001", name: "East-Plan", origin: [10, 0, 0],
  xAxis: [0, 1, 0], yAxis: [-1, 0, 0], zAxis: [0, 0, 1], createdAt: NOW,
};

const BOX_10: BBox3D = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 };

/** Assert EVERY one of the 8 box corners projects strictly inside the
 *  viewport through the given camera (the acceptance criterion: fit extents
 *  puts ALL geometry inside the view — perspective included; a corner behind
 *  the eye plane fails via the null projection). Returns the corner count. */
function assertAllCornersInsideViewport(
  camera: Camera3DState,
  box: BBox3D,
  viewport: { width: number; height: number },
): number {
  let n = 0;
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const p = projectPoint(camera, viewport, [x, y, z]);
        assert.ok(p !== null, `corner (${x},${y},${z}) must project (strictly in front of the eye plane)`);
        assert.ok(p!.x > 0 && p!.x < viewport.width, `corner (${x},${y},${z}) screen x ${p!.x} outside (0, ${viewport.width})`);
        assert.ok(p!.y > 0 && p!.y < viewport.height, `corner (${x},${y},${z}) screen y ${p!.y} outside (0, ${viewport.height})`);
        n += 1;
      }
    }
  }
  assert.equal(n, 8);
  return n;
}

function bboxOf(b: readonly number[]): BBox3D {
  assert.ok(Array.isArray(b) && b.length === 6);
  return { minX: b[0]!, minY: b[1]!, minZ: b[2]!, maxX: b[3]!, maxY: b[4]!, maxZ: b[5]! };
}

// ---------------------------------------------------------------------------
// Camera: frame / validation / normalization.
// ---------------------------------------------------------------------------

test("cameraFrame derives the orthonormal view frame; degenerate frames are null", () => {
  const frame = cameraFrame(SIDE_CAMERA);
  assert.deepEqual(frame?.forward, [-1, 0, 0]);
  // right = normalize(forward × up) — the fixed operation order leaves −0 in
  // the z slot ((−1)·0 − 0·0 = −0); the pinned deterministic literal.
  assert.deepEqual(frame?.right, [0, 1, -0]);
  assert.deepEqual(frame?.up, [0, 0, 1]);
  // eye == target → degenerate.
  assert.equal(cameraFrame({ ...SIDE_CAMERA, eye: [0, 0, 0] }), null);
  // up parallel to the view direction → degenerate.
  assert.equal(cameraFrame({ eye: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1], mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60 }), null);
});

test("validateCamera rejects every degenerate shape with the documented messages", () => {
  assert.equal(validateCamera(SIDE_CAMERA), null);
  assert.match(validateCamera({ ...SIDE_CAMERA, eye: [Number.NaN, 0, 0] })!, /finite 3-vectors/);
  assert.match(validateCamera({ ...SIDE_CAMERA, mode: "persp" as never })!, /mode must be/);
  assert.match(validateCamera({ ...SIDE_CAMERA, orthoHalfHeight: -1 })!, /orthoHalfHeight/);
  assert.match(validateCamera({ ...SIDE_CAMERA, fovDeg: 0 })!, /fovDeg/);
  assert.match(validateCamera({ ...SIDE_CAMERA, fovDeg: 180 })!, /fovDeg/);
  assert.match(validateCamera({ ...SIDE_CAMERA, eye: [0, 0, 0] })!, /degenerate/);
});

test("normalizeCamera re-derives up ⊥ forward; degenerate input is null, never repaired", () => {
  const normalized = normalizeCamera({
    eye: [0, 0, 10], target: [0, 0, 0], up: [0.1, 1, 0],
    mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60,
  });
  assert.ok(normalized !== null);
  // The stored up is the exact frame up (unit, ⊥ forward).
  const len = Math.hypot(normalized!.up[0], normalized!.up[1], normalized!.up[2]);
  assert.ok(Math.abs(len - 1) < 1e-12);
  const dot = normalized!.up[0] * 0 + normalized!.up[1] * 0 + normalized!.up[2] * -1;
  assert.ok(Math.abs(dot) < 1e-12);
  assert.deepEqual(normalized!.eye, [0, 0, 10]);
  assert.equal(normalizeCamera({ ...SIDE_CAMERA, eye: [0, 0, 0] }), null);
});

// ---------------------------------------------------------------------------
// Camera: navigation (orbit / pan / zoom / fit).
// ---------------------------------------------------------------------------

test("orbitCamera: turntable yaw about world +Z; target fixed; distance preserved", () => {
  const yawed = orbitCamera(SIDE_CAMERA, 90, 0);
  assert.ok(yawed !== null);
  // eye [10,0,0] yawed 90° about +Z → [0,10,0] (within float noise).
  assert.ok(Math.abs(yawed!.eye[0] - 0) < 1e-12, `eye[0] ${yawed!.eye[0]}`);
  assert.ok(Math.abs(yawed!.eye[1] - 10) < 1e-12, `eye[1] ${yawed!.eye[1]}`);
  assert.ok(Math.abs(yawed!.eye[2] - 0) < 1e-12);
  // The orbit pivot never moves.
  assert.deepEqual(yawed!.target, [0, 0, 0]);
  // Distance preserved exactly through the rotation.
  const dist = Math.hypot(yawed!.eye[0], yawed!.eye[1], yawed!.eye[2]);
  assert.ok(Math.abs(dist - 10) < 1e-9);
  // A degenerate camera declines.
  assert.equal(orbitCamera({ ...SIDE_CAMERA, eye: [0, 0, 0] }, 10, 10), null);
});

test("orbitCamera: elevation clamps at ±89.9° (deterministic saturation)", () => {
  const up = orbitCamera(SIDE_CAMERA, 0, -90);
  assert.ok(up !== null);
  const elevation = (c: Camera3DState): number => {
    const v: Vec3 = [c.eye[0] - c.target[0], c.eye[1] - c.target[1], c.eye[2] - c.target[2]];
    return (Math.atan2(v[2], Math.hypot(v[0], v[1])) * 180) / Math.PI;
  };
  assert.ok(Math.abs(elevation(up!) - 89.9) < 1e-9, `elev ${elevation(up!)}`);
  // Beyond the clamp it saturates (never crosses the polar singularity).
  const way = orbitCamera(SIDE_CAMERA, 0, -270);
  assert.ok(Math.abs(elevation(way!) + 89.9) < 1e-9, `elev ${elevation(way!)}`);
  // The clamp preserves the eye↔target distance.
  const dist = Math.hypot(up!.eye[0], up!.eye[1], up!.eye[2]);
  assert.ok(Math.abs(dist - 10) < 1e-9);
});

test("orbitCamera: combined diagonal drag is the EXACT turntable update (pitch about the YAW-UPDATED right axis)", () => {
  // The PR #92 review round-2 defect: the pitch was applied about the
  // PRE-yaw right axis, so a diagonal drag (the Web viewport's
  // orbitCamera(camera, dx·0.5°, dy·0.5°) with BOTH non-zero — a normal
  // interaction path) composited a DIFFERENT rotation than the documented
  // turntable: the old composite landed at (6.1237, 7.0711, −3.5355) for a
  // 45°+30° drag from eye (10,0,0) — a 1.74-unit sideways drift from the
  // exact turntable position (6.1237, 6.1237, −5). The yaw-updated right
  // axis is horizontal ⊥ the yawed azimuth, so the pitch changes ONLY the
  // elevation and the combined drag is exactly az += yaw, el −= pitch.
  const azOf = (c: Camera3DState): number =>
    Math.atan2(c.eye[1] - c.target[1], c.eye[0] - c.target[0]);
  const elOf = (c: Camera3DState): number =>
    Math.atan2(c.eye[2] - c.target[2], Math.hypot(c.eye[0] - c.target[0], c.eye[1] - c.target[1]));
  const deg = (rad: number): number => (rad * 180) / Math.PI;
  const distOf = (c: Camera3DState): number =>
    Math.hypot(c.eye[0] - c.target[0], c.eye[1] - c.target[1], c.eye[2] - c.target[2]);
  // From the axis-aligned side camera: (yaw 45, pitch 30) → az +45°, el −30°
  // — the exact turntable position 10·(cos30°·cos45°, cos30°·sin45°, −sin30°).
  const dragged = orbitCamera(SIDE_CAMERA, 45, 30)!;
  assert.ok(dragged !== null);
  assert.ok(Math.abs(deg(azOf(dragged)) - 45) < 1e-9, `az ${deg(azOf(dragged))}`);
  assert.ok(Math.abs(deg(elOf(dragged)) + 30) < 1e-9, `el ${deg(elOf(dragged))}`);
  const c30 = Math.cos((30 * Math.PI) / 180);
  const s30 = Math.sin((30 * Math.PI) / 180);
  const c45 = Math.SQRT1_2;
  const exactTurntable: Vec3 = [10 * c30 * c45, 10 * c30 * c45, -10 * s30];
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(dragged.eye[i]! - exactTurntable[i]!) < 1e-9, `turntable eye[${i}] ${dragged.eye[i]}`);
  }
  assert.ok(Math.abs(distOf(dragged) - 10) < 1e-9, "distance preserved through BOTH rotations");
  assert.deepEqual(dragged.target, [0, 0, 0], "the orbit pivot never moves");
  // From an oblique (iso-like) start with a NON-ZERO start elevation:
  // (yaw 30, pitch −20) → az +30°, el +20° — exact regardless of start pose.
  const isoStart: Camera3DState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60 };
  const az0 = deg(azOf(isoStart)); // −45°
  const el0 = deg(elOf(isoStart)); // atan2(10, √200) ≈ 35.264°
  const dragged2 = orbitCamera(isoStart, 30, -20)!;
  assert.ok(dragged2 !== null);
  assert.ok(Math.abs(deg(azOf(dragged2)) - (az0 + 30)) < 1e-9, `oblique az ${deg(azOf(dragged2))} vs ${az0 + 30}`);
  assert.ok(Math.abs(deg(elOf(dragged2)) - (el0 + 20)) < 1e-9, `oblique el ${deg(elOf(dragged2))} vs ${el0 + 20}`);
  assert.ok(Math.abs(distOf(dragged2) - distOf(isoStart)) < 1e-9, "oblique distance preserved");
  // Negative yaw + positive pitch (the other diagonal) is exact too
  // (positive pitch LOWERS: el −= pitch → el −25°).
  const dragged3 = orbitCamera(SIDE_CAMERA, -60, 25)!;
  assert.ok(Math.abs(deg(azOf(dragged3)) + 60) < 1e-9);
  assert.ok(Math.abs(deg(elOf(dragged3)) + 25) < 1e-9);
  // A diagonal drag landing within 0.1° of the pole saturates at exactly
  // +89.9° with the azimuth exact and the distance preserved (the
  // elevation-only saturation; a pitch that passes fully OVER the pole keeps
  // rotating to the mirrored far side — deterministic pre-existing geometry).
  const clamped = orbitCamera(SIDE_CAMERA, 20, -89.95)!;
  assert.ok(clamped !== null);
  assert.ok(Math.abs(deg(elOf(clamped)) - 89.9) < 1e-9, `clamped el ${deg(elOf(clamped))}`);
  assert.ok(Math.abs(deg(azOf(clamped)) - 20) < 1e-9, `clamped az ${deg(azOf(clamped))}`);
  assert.ok(Math.abs(distOf(clamped) - 10) < 1e-9, "clamped distance preserved");
  // A degenerate camera still declines.
  assert.equal(orbitCamera({ ...SIDE_CAMERA, eye: [0, 0, 0] }, 10, 10), null);
});

test("panCamera translates eye AND target by (right·dx + up·dy)·worldPerPixel exactly", () => {
  const frame = cameraFrame(SIDE_CAMERA)!;
  const panned = panCamera(SIDE_CAMERA, 10, -5, 2)!;
  const sx = 10 * 2;
  const sy = -5 * 2;
  const expected: Vec3 = [
    frame.right[0] * sx + frame.up[0] * sy,
    frame.right[1] * sx + frame.up[1] * sy,
    frame.right[2] * sx + frame.up[2] * sy,
  ];
  assert.deepEqual([panned.eye[0] - SIDE_CAMERA.eye[0], panned.eye[1] - SIDE_CAMERA.eye[1], panned.eye[2] - SIDE_CAMERA.eye[2]], expected);
  assert.deepEqual([panned.target[0] - SIDE_CAMERA.target[0], panned.target[1] - SIDE_CAMERA.target[1], panned.target[2] - SIDE_CAMERA.target[2]], expected);
  // Zoom state untouched.
  assert.equal(panned.orthoHalfHeight, SIDE_CAMERA.orthoHalfHeight);
  assert.equal(panCamera({ ...SIDE_CAMERA, eye: [0, 0, 0] }, 1, 1, 1), null);
});

test("zoomCamera: orthographic divides orthoHalfHeight, perspective divides the distance — both clamped", () => {
  const z1 = zoomCamera(SIDE_CAMERA, 2)!;
  assert.equal(z1.orthoHalfHeight, 2.5);
  // Clamp bounds: [ZOOM_MIN, ZOOM_MAX] saturation.
  const zMin = zoomCamera(SIDE_CAMERA, 1e9)!;
  assert.equal(zMin.orthoHalfHeight, ZOOM_MIN);
  assert.equal(ZOOM_MIN, 1e-6);
  const zMax = zoomCamera({ ...SIDE_CAMERA, orthoHalfHeight: 100 }, 1e-13)!;
  assert.equal(zMax.orthoHalfHeight, ZOOM_MAX);
  assert.equal(ZOOM_MAX, 1e12);
  // Perspective: the eye↔target distance scales by 1/factor; target fixed.
  const persp: Camera3DState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], mode: "perspective", orthoHalfHeight: 5, fovDeg: 60 };
  const zp = zoomCamera(persp, 2)!;
  assert.deepEqual(zp.eye, [0, 0, 5]);
  assert.deepEqual(zp.target, [0, 0, 0]);
  const zpMin = zoomCamera(persp, 1e13)!;
  assert.ok(Math.abs(Math.hypot(zpMin.eye[0], zpMin.eye[1], zpMin.eye[2]) - ZOOM_MIN) < 1e-15);
  // Degenerate factors decline.
  assert.equal(zoomCamera(SIDE_CAMERA, 0), null);
  assert.equal(zoomCamera(SIDE_CAMERA, -1), null);
});

test("fitCameraToBBox: all 8 corners land inside the viewport; empty box → unit-box fallback", () => {
  const viewport = { width: 800, height: 600 };
  const aspect = 800 / 600;
  // The fit keeps the CURRENT eye direction — an axis-aligned view direction
  // keeps all eight corners strictly inside (the FIT_MARGIN bound).
  const front = standardCameraFor("front", BOX_10, aspect, 60, "orthographic");
  const fitted = fitCameraToBBox(front, BOX_10, aspect)!;
  assert.ok(fitted !== null);
  assert.deepEqual(fitted.target, [5, 5, 5]);
  // For the six AXIS views the camera frame's right/up coincide with world
  // axes, so the exact per-corner bound degenerates to the previous
  // max(halfY, halfX/aspect) · 1.1 arithmetic EXACTLY (the same float ops).
  assert.equal(fitted.orthoHalfHeight, Math.max(5, 5 / aspect) * 1.1);
  let cornersChecked = 0;
  for (const x of [BOX_10.minX, BOX_10.maxX]) {
    for (const y of [BOX_10.minY, BOX_10.maxY]) {
      for (const z of [BOX_10.minZ, BOX_10.maxZ]) {
        const p = projectPoint(fitted, viewport, [x, y, z])!;
        assert.ok(p !== null, "corner must project");
        assert.ok(p.x > 0 && p.x < viewport.width, `corner x ${p.x} outside`);
        assert.ok(p.y > 0 && p.y < viewport.height, `corner y ${p.y} outside`);
        cornersChecked += 1;
      }
    }
  }
  assert.equal(cornersChecked, 8);
  // The perspective fit solves the EXACT per-corner frustum bound (the PR
  // #92 remediation). Front view: xc = v_x, yc = v_z, alongDir = −v_y, so
  // the binding corners are the NEAR ones (v_y = −5 — a corner nearer the
  // camera occupies more screen angle than its world extent suggests) and
  // the vertical requirement |v_z|/tan(fovY/2) + 5 dominates → the exact
  // minimal distance (5/tan(30°) + 5)·FIT_MARGIN.
  const frontPersp = standardCameraFor("front", BOX_10, aspect, 60, "perspective");
  const fittedPersp = fitCameraToBBox(frontPersp, BOX_10, aspect)!;
  assert.ok(fittedPersp !== null);
  assert.deepEqual(fittedPersp.target, [5, 5, 5]);
  assert.equal(fittedPersp.mode, "perspective");
  const fovRad = (60 * Math.PI) / 180;
  const expectedDist = (5 / Math.tan(fovRad / 2) + 5) * FIT_MARGIN;
  const perspDist = Math.hypot(fittedPersp.eye[0] - 5, fittedPersp.eye[1] - 5, fittedPersp.eye[2] - 5);
  assert.ok(Math.abs(perspDist - expectedDist) < 1e-9, `persp distance ${perspDist} vs ${expectedDist}`);
  // EVERY corner projects STRICTLY INSIDE the viewport (the prior suite only
  // proved the corners stayed in front of the eye plane — the review gap).
  assert.equal(assertAllCornersInsideViewport(fittedPersp, BOX_10, viewport), 8);
  // An arbitrary (iso) direction recenters on the box, derives the EXACT
  // per-corner camera-frame half-height (the PR #92 review round-2 fix — see
  // the dedicated isometric orthographic test below) while keeping the eye
  // direction.
  const iso = standardCameraFor("iso", BOX_10, aspect, 60, "orthographic");
  const fittedIso = fitCameraToBBox(iso, BOX_10, aspect)!;
  assert.deepEqual(fittedIso.target, [5, 5, 5]);
  assert.ok(
    Math.abs(fittedIso.orthoHalfHeight - (20 / Math.sqrt(6)) * FIT_MARGIN) < 1e-9,
    `iso ortho half-height ${fittedIso.orthoHalfHeight}`,
  );
  assert.equal(assertAllCornersInsideViewport(fittedIso, BOX_10, viewport), 8, "iso ortho fit: every corner strictly inside");
  const dirBefore: Vec3 = [iso.eye[0] - 5, iso.eye[1] - 5, iso.eye[2] - 5];
  const dirAfter: Vec3 = [fittedIso.eye[0] - 5, fittedIso.eye[1] - 5, fittedIso.eye[2] - 5];
  const lb = Math.hypot(dirBefore[0], dirBefore[1], dirBefore[2]);
  const la = Math.hypot(dirAfter[0], dirAfter[1], dirAfter[2]);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(dirAfter[i]! / la - dirBefore[i]! / lb) < 1e-12, "fit keeps the eye direction");
  }
  // Empty box → the unit box centered at the origin (EMPTY_MODEL_EXTENTS).
  const fitEmpty = fitCameraToBBox(iso, EMPTY_BBOX3D, 1)!;
  assert.deepEqual(fitEmpty.target, [0, 0, 0]);
  assert.ok(
    Math.abs(fitEmpty.orthoHalfHeight - (2 / Math.sqrt(6)) * FIT_MARGIN) < 1e-9,
    `empty ortho half-height ${fitEmpty.orthoHalfHeight}`,
  );
  // …and BOTH empty fallbacks keep the unit box's corners inside.
  assert.equal(
    assertAllCornersInsideViewport(fitEmpty, { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }, { width: 800, height: 800 }),
    8,
  );
  const fitEmptyPersp = fitCameraToBBox(frontPersp, EMPTY_BBOX3D, 1)!;
  assert.deepEqual(fitEmptyPersp.target, [0, 0, 0]);
  assert.equal(
    assertAllCornersInsideViewport(fitEmptyPersp, { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }, { width: 800, height: 800 }),
    8,
  );
});

test("fitCameraToBBox perspective (isometric): all 8 corners strictly inside the viewport for every aspect/fov — the exact per-corner solve", () => {
  // The Architect review's named failure: the old axis-extent bound put 4/8
  // corners OUTSIDE for the isometric direction (screen x −52.9 / 852.9 on an
  // 800×600 viewport). The exact solve puts every corner strictly inside.
  const isoPersp = standardCameraFor("iso", BOX_10, 800 / 600, 60, "perspective");
  const fitted = fitCameraToBBox(isoPersp, BOX_10, 800 / 600)!;
  assert.ok(fitted !== null);
  assert.deepEqual(fitted.target, [5, 5, 5]);
  assert.equal(fitted.mode, "perspective");
  // The eye direction is the kept iso direction (1,−1,1)/√3.
  const v: Vec3 = [fitted.eye[0] - 5, fitted.eye[1] - 5, fitted.eye[2] - 5];
  const len = Math.hypot(v[0], v[1], v[2]);
  const invSqrt3 = 1 / Math.sqrt(3);
  assert.ok(Math.abs(v[0] / len - invSqrt3) < 1e-12);
  assert.ok(Math.abs(v[1] / len + invSqrt3) < 1e-12);
  assert.ok(Math.abs(v[2] / len - invSqrt3) < 1e-12);
  // The exact closed form: with right = (1,1,0)/√2, up = (−1,1,2)/√6 and
  // dir = (1,−1,1)/√3, the binding corner is (+,−,−) (world (10,0,0) — the
  // corner NEAREST the camera with the largest camera-plane vertical offset,
  // exactly the case axis-extent bounds miss): the vertical requirement
  // |v·up|/tan(fovY/2) + v·dir = (20/√6)·√3 + 5/√3 = 10√2 + 5/√3 dominates →
  // (10√2 + 5/√3)·FIT_MARGIN.
  const aspect = 800 / 600;
  const expectedDist = (10 * Math.SQRT2 + 5 / Math.sqrt(3)) * FIT_MARGIN;
  const dist = Math.hypot(v[0], v[1], v[2]);
  assert.ok(Math.abs(dist - expectedDist) < 1e-9, `iso persp distance ${dist} vs ${expectedDist}`);
  // The regression assertion: EVERY corner strictly inside the viewport,
  // across a fixed table of aspects/fovs (square, wide, tall, narrow fov).
  for (const [w, h, fov] of [
    [800, 600, 60], [600, 600, 60], [1000, 400, 60], [400, 1000, 60],
    [800, 600, 45], [800, 600, 90], [800, 600, 20], [1280, 720, 55],
  ] as const) {
    const cam = fitCameraToBBox(
      { eye: [invSqrt3 * 30, -invSqrt3 * 30, invSqrt3 * 30], target: [0, 0, 0], up: [0, 0, 1], mode: "perspective", orthoHalfHeight: 5, fovDeg: fov },
      BOX_10,
      w / h,
    )!;
    assert.ok(cam !== null);
    assert.equal(assertAllCornersInsideViewport(cam, BOX_10, { width: w, height: h }), 8, `iso fit fov=${fov} ${w}x${h}`);
  }
});

test("fitCameraToBBox perspective (strongly non-cubic boxes): all 8 corners strictly inside from every direction", () => {
  // A wide slab, a tall column, a beam and a zero-height plane — the shapes
  // where axis-extent/bounding-sphere heuristics diverge most from the exact
  // per-corner bound. Fixed direction table: the three axes, iso, a view-cube
  // corner blend and two arbitrary oblique directions.
  const boxes: readonly BBox3D[] = [
    { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 4, maxZ: 6 },   // wide slab 40×4×6
    { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 30 },  // tall column 2×2×30
    { minX: 0, minY: 0, minZ: 0, maxX: 25, maxY: 1, maxZ: 1 },    // beam 25×1×1
    { minX: -5, minY: -5, minZ: 2, maxX: 5, maxY: 5, maxZ: 2 },   // flat plane 10×10×0
  ];
  const dirs: readonly Vec3[] = [
    [0, -1, 0], [0, 0, 1], [1, 0, 0],
    [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)],
    [1, 1, 1].map((n) => n / Math.sqrt(3)) as unknown as Vec3,
    [3, -7, 5], [0.2, 0.9, -0.4],
  ];
  let fits = 0;
  for (const box of boxes) {
    for (const d of dirs) {
      const len = Math.hypot(d[0], d[1], d[2]);
      const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
      // A near-vertical view direction with a +Z up hint is a degenerate
      // frame (correctly declined) — top/bottom directions use a +Y hint.
      const upHint: Vec3 = Math.abs(dir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
      for (const [w, h, fov] of [[800, 600, 60], [600, 800, 45], [1000, 250, 75]] as const) {
        const cam = fitCameraToBBox(
          { eye: [dir[0] * 40, dir[1] * 40, dir[2] * 40], target: [0, 0, 0], up: upHint, mode: "perspective", orthoHalfHeight: 5, fovDeg: fov },
          box,
          w / h,
        )!;
        assert.ok(cam !== null);
        assert.equal(assertAllCornersInsideViewport(cam, box, { width: w, height: h }), 8);
        fits += 1;
      }
    }
  }
  assert.ok(fits >= 80, `expected a broad sweep, got ${fits} fits`);
});

test("fitCameraToBBox perspective (arbitrary orientation + roll + narrow fov): all 8 corners strictly inside; direction/up kept", () => {
  // An oblique, non-iso direction with a ROLLED up hint (up not world +Z) —
  // the solve is exact in the camera's own right/up frame, so it must hold
  // under arbitrary roll too — plus a narrow fov and extreme aspects.
  const camera: Camera3DState = {
    eye: [3 * 9, -7 * 9, 5 * 9], target: [1, 2, -1], up: [0.1, 0.2, 1],
    mode: "perspective", orthoHalfHeight: 5, fovDeg: 50,
  };
  const box: BBox3D = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 4, maxZ: 6 };
  for (const [w, h, fov] of [
    [1000, 800, 50], [800, 1000, 50], [1000, 800, 15], [240, 960, 50], [1920, 480, 30],
  ] as const) {
    const cam = fitCameraToBBox({ ...camera, fovDeg: fov }, box, w / h)!;
    assert.ok(cam !== null);
    assert.equal(assertAllCornersInsideViewport(cam, box, { width: w, height: h }), 8, `fov=${fov} ${w}x${h}`);
    // Fit keeps the eye direction exactly and never reorients.
    const before: Vec3 = [camera.eye[0] - camera.target[0], camera.eye[1] - camera.target[1], camera.eye[2] - camera.target[2]];
    const after: Vec3 = [cam.eye[0] - cam.target[0], cam.eye[1] - cam.target[1], cam.eye[2] - cam.target[2]];
    const lb = Math.hypot(before[0], before[1], before[2]);
    const la = Math.hypot(after[0], after[1], after[2]);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(after[i]! / la - before[i]! / lb) < 1e-12, "fit keeps the eye direction");
    }
    assert.deepEqual(cam.up, camera.up);
    // The recenters on the box center.
    assert.deepEqual(cam.target, [20, 2, 3]);
  }
});

test("fitCameraToBBox orthographic (isometric): all 8 corners strictly inside the viewport for every aspect — the exact per-corner bound", () => {
  // The PR #92 review round-2 named failure: the world-extent bound
  // max(halfY, halfX/aspect) put 2/8 corners OUTSIDE for the isometric
  // direction (screen y −145.4 / 745.4 on an 800×600 viewport) — the world Z
  // axis contributes to the projected height, which the world-X/Y-extent
  // bound cannot see. The exact per-corner camera-frame bound puts every
  // corner strictly inside.
  const aspect = 800 / 600;
  const iso = standardCameraFor("iso", BOX_10, aspect, 60, "orthographic");
  const fitted = fitCameraToBBox(iso, BOX_10, aspect)!;
  assert.ok(fitted !== null);
  assert.deepEqual(fitted.target, [5, 5, 5]);
  assert.equal(fitted.mode, "orthographic");
  // The eye direction is the kept iso direction (1,−1,1)/√3.
  const v: Vec3 = [fitted.eye[0] - 5, fitted.eye[1] - 5, fitted.eye[2] - 5];
  const len = Math.hypot(v[0], v[1], v[2]);
  const invSqrt3 = 1 / Math.sqrt(3);
  assert.ok(Math.abs(v[0] / len - invSqrt3) < 1e-12);
  assert.ok(Math.abs(v[1] / len + invSqrt3) < 1e-12);
  assert.ok(Math.abs(v[2] / len - invSqrt3) < 1e-12);
  // The exact closed form: with right = (1,1,0)/√2, up = (−1,1,2)/√6 the
  // binding corner is (−,+,+) (world (0,10,10)): the vertical requirement
  // |v·up| = 20/√6 dominates the horizontal (10/√2)/aspect → (20/√6)·FIT_MARGIN
  // (vs the old insufficient 5·1.1 = 5.5).
  const expectedHalf = (20 / Math.sqrt(6)) * FIT_MARGIN;
  assert.ok(Math.abs(fitted.orthoHalfHeight - expectedHalf) < 1e-9, `iso ortho half-height ${fitted.orthoHalfHeight} vs ${expectedHalf}`);
  // The regression assertion: EVERY corner strictly inside the viewport,
  // across a fixed table of aspects (square, wide, tall).
  for (const [w, h] of [
    [800, 600], [600, 600], [1000, 400], [400, 1000], [1280, 720],
  ] as const) {
    const cam = fitCameraToBBox(
      { eye: [invSqrt3 * 30, -invSqrt3 * 30, invSqrt3 * 30], target: [0, 0, 0], up: [0, 0, 1], mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60 },
      BOX_10,
      w / h,
    )!;
    assert.ok(cam !== null);
    assert.equal(assertAllCornersInsideViewport(cam, BOX_10, { width: w, height: h }), 8, `iso ortho fit ${w}x${h}`);
  }
});

test("fitCameraToBBox orthographic (strongly non-cubic boxes + arbitrary oblique directions): all 8 corners strictly inside", () => {
  // A wide slab, a tall column, a beam and a zero-height plane (the shapes
  // where world-extent heuristics diverge most from the exact camera-frame
  // bound) × the three axes, iso, a view-cube corner blend and two arbitrary
  // oblique directions — every orthographic fit puts ALL 8 corners strictly
  // inside the viewport.
  const boxes: readonly BBox3D[] = [
    { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 4, maxZ: 6 },   // wide slab 40×4×6
    { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 30 },  // tall column 2×2×30
    { minX: 0, minY: 0, minZ: 0, maxX: 25, maxY: 1, maxZ: 1 },    // beam 25×1×1
    { minX: -5, minY: -5, minZ: 2, maxX: 5, maxY: 5, maxZ: 2 },   // flat plane 10×10×0
  ];
  const dirs: readonly Vec3[] = [
    [0, -1, 0], [0, 0, 1], [1, 0, 0],
    [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)],
    [1, 1, 1].map((n) => n / Math.sqrt(3)) as unknown as Vec3,
    [3, -7, 5], [0.2, 0.9, -0.4],
  ];
  let fits = 0;
  for (const box of boxes) {
    for (const d of dirs) {
      const len = Math.hypot(d[0], d[1], d[2]);
      const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
      // A near-vertical view direction with a +Z up hint is a degenerate
      // frame (correctly declined) — top/bottom directions use a +Y hint.
      const upHint: Vec3 = Math.abs(dir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
      for (const [w, h] of [[800, 600], [600, 800], [1000, 250]] as const) {
        const cam = fitCameraToBBox(
          { eye: [dir[0] * 40, dir[1] * 40, dir[2] * 40], target: [0, 0, 0], up: upHint, mode: "orthographic", orthoHalfHeight: 5, fovDeg: 60 },
          box,
          w / h,
        )!;
        assert.ok(cam !== null);
        assert.equal(assertAllCornersInsideViewport(cam, box, { width: w, height: h }), 8);
        fits += 1;
      }
    }
  }
  assert.ok(fits >= 80, `expected a broad sweep, got ${fits} fits`);
});

test("fitCameraToBBox orthographic (rolled camera orientation): all 8 corners strictly inside; direction/up kept", () => {
  // Oblique directions with ROLLED up hints (up not world +Z — the camera's
  // right/up frame is rotated about the view axis): the exact per-corner
  // bound is solved in the camera's OWN right/up frame, so it must hold
  // under arbitrary roll (a world-axis formula cannot even express roll —
  // the projected extents rotate with the frame).
  const rolledUps: readonly Vec3[] = [
    [0.1, 0.2, 1],   // a mild roll
    [1, 0.5, 1],     // a strong roll
  ];
  const box: BBox3D = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 4, maxZ: 6 };
  for (const up of rolledUps) {
    const camera: Camera3DState = {
      eye: [3 * 9, -7 * 9, 5 * 9], target: [1, 2, -1], up,
      mode: "orthographic", orthoHalfHeight: 5, fovDeg: 50,
    };
    for (const [w, h] of [
      [1000, 800], [800, 1000], [240, 960], [1920, 480],
    ] as const) {
      const cam = fitCameraToBBox(camera, box, w / h)!;
      assert.ok(cam !== null);
      assert.equal(assertAllCornersInsideViewport(cam, box, { width: w, height: h }), 8, `rolled ortho fit ${w}x${h} up=${up.join(",")}`);
      // Fit keeps the eye direction exactly, never reorients, keeps the up
      // hint and recenters on the box center.
      const before: Vec3 = [camera.eye[0] - camera.target[0], camera.eye[1] - camera.target[1], camera.eye[2] - camera.target[2]];
      const after: Vec3 = [cam.eye[0] - cam.target[0], cam.eye[1] - cam.target[1], cam.eye[2] - cam.target[2]];
      const lb = Math.hypot(before[0], before[1], before[2]);
      const la = Math.hypot(after[0], after[1], after[2]);
      for (let i = 0; i < 3; i += 1) {
        assert.ok(Math.abs(after[i]! / la - before[i]! / lb) < 1e-12, "fit keeps the eye direction");
      }
      assert.deepEqual(cam.up, camera.up);
      assert.deepEqual(cam.target, [20, 2, 3]);
    }
  }
});

// ---------------------------------------------------------------------------
// Camera: standard views + the view cube.
// ---------------------------------------------------------------------------

test("STANDARD_VIEW_FRAMES: the exact axis directions (Z-up world)", () => {
  assert.deepEqual(STANDARD_VIEW_FRAMES.top, { dir: [0, 0, 1], up: [0, 1, 0] });
  assert.deepEqual(STANDARD_VIEW_FRAMES.front, { dir: [0, -1, 0], up: [0, 0, 1] });
  assert.deepEqual(STANDARD_VIEW_FRAMES.right, { dir: [1, 0, 0], up: [0, 0, 1] });
  const invSqrt3 = 1 / Math.sqrt(3);
  assert.deepEqual(STANDARD_VIEW_FRAMES.iso, { dir: [invSqrt3, -invSqrt3, invSqrt3], up: [0, 0, 1] });
  // The full vocabulary order is fixed.
  assert.deepEqual(STANDARD_VIEW_NAMES, ["top", "bottom", "front", "back", "left", "right", "iso"]);
});

test("standardCameraFor is deterministic and frames the box from the exact view direction", () => {
  const a = standardCameraFor("front", BOX_10, 1.5, 45, "perspective");
  const b = standardCameraFor("front", BOX_10, 1.5, 45, "perspective");
  assert.deepEqual(a, b);
  // eye sits along the view direction from the box center; up is the frame up.
  assert.deepEqual(a.target, [5, 5, 5]);
  const dir: Vec3 = [a.eye[0] - 5, a.eye[1] - 5, a.eye[2] - 5];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  assert.ok(Math.abs(dir[0] / len - 0) < 1e-12);
  assert.ok(Math.abs(dir[1] / len + 1) < 1e-12);
  assert.ok(Math.abs(dir[2] / len - 0) < 1e-12);
  assert.deepEqual(a.up, [0, 0, 1]);
  // The view direction (target − eye) is the exact negative of the frame dir.
  const view = cameraViewDirection(a)!;
  assert.ok(Math.abs(view[0] - 0) < 1e-12 && Math.abs(view[1] - 1) < 1e-12 && Math.abs(view[2] - 0) < 1e-12);
});

test("viewCubeCorners: 8 corners in the fixed lexicographic sign order", () => {
  const corners = viewCubeCorners();
  assert.equal(corners.length, 8);
  const invSqrt3 = 1 / Math.sqrt(3);
  assert.deepEqual(corners, [
    [-invSqrt3, -invSqrt3, -invSqrt3],
    [-invSqrt3, -invSqrt3, invSqrt3],
    [-invSqrt3, invSqrt3, -invSqrt3],
    [-invSqrt3, invSqrt3, invSqrt3],
    [invSqrt3, -invSqrt3, -invSqrt3],
    [invSqrt3, -invSqrt3, invSqrt3],
    [invSqrt3, invSqrt3, -invSqrt3],
    [invSqrt3, invSqrt3, invSqrt3],
  ]);
});

test("classifyViewCubeZone: face/edge/corner with deterministic tie-breaks", () => {
  // Faces: one dominant component.
  assert.deepEqual(classifyViewCubeZone([0, 0, 1]), { kind: "face", face: "top" });
  assert.deepEqual(classifyViewCubeZone([0, 0, -1]), { kind: "face", face: "bottom" });
  assert.deepEqual(classifyViewCubeZone([10, 1, 1]), { kind: "face", face: "right" });
  // Edges: two comparable components (within the 0.9 factor) → faces sorted
  // by the STANDARD_VIEW_NAMES order.
  assert.deepEqual(classifyViewCubeZone([1 / Math.sqrt(2), 1 / Math.sqrt(2), 0]), { kind: "edge", faces: ["back", "right"] });
  assert.deepEqual(classifyViewCubeZone([0.95, 1, 0.05]), { kind: "edge", faces: ["back", "right"] });
  // Corners: all three comparable → the iso octant (faces sorted canonically).
  assert.deepEqual(classifyViewCubeZone([1, 1, 1]), { kind: "corner", faces: ["top", "back", "right"] });
  const invSqrt3 = 1 / Math.sqrt(3);
  assert.deepEqual(classifyViewCubeZone([invSqrt3, -invSqrt3, invSqrt3]), { kind: "corner", faces: ["top", "front", "right"] });
  // Exact ties resolve in x → y → z order (the dominant-axis tie-break).
  assert.deepEqual(classifyViewCubeZone([1, 1, 1]), { kind: "corner", faces: ["top", "back", "right"] });
});

test("cameraForViewCubeZone: face → the standard view; corner → the iso octant camera", () => {
  const box: BBox3D = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
  // A face zone targets EXACTLY the standard camera of that view.
  const faceZone = classifyViewCubeZone([0, 0, 1]);
  const faceCam = cameraForViewCubeZone(faceZone, box, 1, 60, "orthographic");
  assert.deepEqual(faceCam, standardCameraFor("top", box, 1, 60, "orthographic"));
  // A corner zone targets the iso view of that octant: the eye sits along
  // the corner direction from the box center.
  const cornerZone = classifyViewCubeZone([inv3(), inv3(), inv3()]);
  assert.equal(cornerZone.kind, "corner");
  const cornerCam = cameraForViewCubeZone(cornerZone, box, 1, 60, "orthographic");
  const d: Vec3 = [cornerCam.eye[0], cornerCam.eye[1], cornerCam.eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  assert.ok(Math.abs(d[0] / len - inv3()) < 1e-12);
  assert.ok(Math.abs(d[1] / len - inv3()) < 1e-12);
  assert.ok(Math.abs(d[2] / len - inv3()) < 1e-12);
  // The (+,−,+) octant camera mirrors the sign triple exactly.
  const corner2 = cameraForViewCubeZone(classifyViewCubeZone([inv3(), -inv3(), inv3()]), box, 1, 60, "orthographic");
  assert.ok(Math.abs(corner2.eye[0] / Math.hypot(corner2.eye[0], corner2.eye[1], corner2.eye[2]) - inv3()) < 1e-12);
  assert.ok(corner2.eye[1] < 0 && corner2.eye[2] > 0);
  // An edge zone blends the two faces (the normalized face-center sum).
  const edgeCam = cameraForViewCubeZone(classifyViewCubeZone([1 / Math.sqrt(2), 1 / Math.sqrt(2), 0]), box, 1, 60, "orthographic");
  const ev = cameraViewDirection(edgeCam)!;
  assert.ok(Math.abs(ev[0] + 1 / Math.sqrt(2)) < 1e-12 && Math.abs(ev[1] + 1 / Math.sqrt(2)) < 1e-12 && Math.abs(ev[2]) < 1e-12);
});

function inv3(): number {
  return 1 / Math.sqrt(3);
}

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

/** eye at origin, forward +Z, up +Y (right = −X): the exact-math fixture. */
const AXIS_CAMERA: Camera3DState = {
  eye: [0, 0, 0], target: [0, 0, 10], up: [0, 1, 0],
  mode: "orthographic", orthoHalfHeight: 50, fovDeg: 60,
};
const VP = { width: 200, height: 100 };

test("projectPoint: orthographic exact screen math", () => {
  // scale = height / (2 · orthoHalfHeight) = 100/100 = 1; right = −X, up = +Y.
  // p = [3,4,10]: xc = −3, yc = 4, zc = 10 → x = 100 − 3, y = 50 − 4.
  const p = projectPoint(AXIS_CAMERA, VP, [3, 4, 10])!;
  assert.deepEqual(p, { x: 97, y: 46, zc: 10 });
  // Degenerate camera declines.
  assert.equal(projectPoint({ ...AXIS_CAMERA, eye: [0, 0, 0], target: [0, 0, 0] }, VP, [1, 2, 3]), null);
});

test("projectPoint: perspective exact screen math (focal = (h/2)/tan(fov/2))", () => {
  const persp: Camera3DState = { ...AXIS_CAMERA, mode: "perspective" };
  const focal = 100 / 2 / Math.tan((60 * Math.PI) / 360);
  // p = [−4, 2, 4]: xc = 4, yc = 2, zc = 4 → x = 100 + 4·focal/4, y = 50 − 2·focal/4.
  const expectedX = 100 + (4 * focal) / 4;
  const expectedY = 50 - (2 * focal) / 4;
  const p = projectPoint(persp, VP, [-4, 2, 4])!;
  assert.equal(p.x, expectedX);
  assert.equal(p.y, expectedY);
  assert.equal(p.zc, 4);
  // Points behind the eye plane clip (null), never mirrored.
  assert.equal(projectPoint(persp, VP, [0, 0, -1]), null);
});

test("unprojectAtDepth is the exact inverse of projectPoint (bit-exact round trip, both modes)", () => {
  // Orthographic: integer-valued fixture — bit-identical round trip.
  const po = projectPoint(AXIS_CAMERA, VP, [3, 4, 10])!;
  const backO = unprojectAtDepth(AXIS_CAMERA, VP, po.x, po.y, po.zc)!;
  assert.deepEqual(backO, [3, 4, 10]);
  assert.equal(backO[0], 3);
  assert.equal(backO[1], 4);
  assert.equal(backO[2], 10);
  // Perspective: the pinned bit-exact round-trip fixture (zc a power of two).
  const persp: Camera3DState = { ...AXIS_CAMERA, mode: "perspective" };
  const pp = projectPoint(persp, VP, [-4, 2, 4])!;
  const backP = unprojectAtDepth(persp, VP, pp.x, pp.y, pp.zc)!;
  assert.equal(backP[0], -4);
  assert.equal(backP[1], 2);
  assert.equal(backP[2], 4);
  // The projected screen values are the pinned deterministic literals.
  assert.equal(pp.x, 186.60254037844388);
  assert.equal(pp.y, 6.698729810778062);
  // Behind-eye depths decline.
  assert.equal(unprojectAtDepth(persp, VP, 100, 50, -1), null);
});

test("screenRay: orthographic rays run along forward; perspective rays start at the eye", () => {
  // Ortho: the ray origin is the unprojected screen point on the eye plane.
  const ro = screenRay(AXIS_CAMERA, VP, 97, 46)!;
  assert.deepEqual(ro.origin, [3, 4, 0]);
  assert.deepEqual(ro.direction, [0, 0, 1]);
  // Perspective: origin = the eye; direction through the pixel.
  const persp: Camera3DState = { ...AXIS_CAMERA, mode: "perspective" };
  const rp = screenRay(persp, VP, 100, 50)!;
  assert.deepEqual(rp.origin, [0, 0, 0]);
  assert.deepEqual(rp.direction, [0, 0, 1]);
  // The ray through the [−4,2,4] pixel hits that world point.
  const rp2 = screenRay(persp, VP, 186.60254037844388, 6.698729810778062)!;
  const t = 4 / rp2.direction[2];
  assert.ok(Math.abs(rp2.direction[0] * t - -4) < 1e-9);
  assert.ok(Math.abs(rp2.direction[1] * t - 2) < 1e-9);
  assert.equal(screenRay({ ...AXIS_CAMERA, eye: [0, 0, 0], target: [0, 0, 0] }, VP, 1, 1), null);
});

test("rayIntersectsBox: the slab test (entry distance, misses, degenerate axes)", () => {
  const ray: Ray3 = { origin: [0, 0, 5], direction: [0, 0, -1] };
  const box: BBox3D = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
  assert.equal(rayIntersectsBox(ray, box), 4); // entry at z = 1 → t = 4
  assert.equal(rayIntersectsBox(ray, { minX: 10, minY: 10, minZ: 10, maxX: 20, maxY: 20, maxZ: 20 }), null);
  // A ray parallel to a slab but outside its bounds misses.
  assert.equal(rayIntersectsBox({ origin: [5, 0, 5], direction: [0, 0, -1] }, box), null);
  // A ray parallel and inside passes (no division — bounds check only).
  assert.equal(rayIntersectsBox({ origin: [0, 0, 5], direction: [0, 0, -1] }, { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 }), 4);
  // The origin inside the box → entry distance 0.
  assert.equal(rayIntersectsBox({ origin: [0, 0, 0], direction: [0, 0, -1] }, box), 0);
});

test("pickElements: EXACT ordering — distance first, then element id lexicographic (deliberate tie)", () => {
  const ray: Ray3 = { origin: [0, 0, 5], direction: [0, 0, -1] };
  // The deliberate tie: two DISTINCT elements with the SAME bbox (same hit
  // distance) — the canonical id breaks the tie deterministically,
  // independent of the input order.
  const tied: readonly PickableElement[] = [
    { id: "el-000002", bbox: { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 } },
    { id: "el-000001", bbox: { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 } },
  ];
  assert.deepEqual(pickElements(ray, tied), [
    { elementId: "el-000001", distance: 4 },
    { elementId: "el-000002", distance: 4 },
  ]);
  assert.deepEqual(pickElements(ray, [tied[1]!, tied[0]!]), [
    { elementId: "el-000001", distance: 4 },
    { elementId: "el-000002", distance: 4 },
  ]);
  // Distance dominates: the nearer box hits first regardless of ids.
  const depths: readonly PickableElement[] = [
    { id: "el-000009", bbox: { minX: -1, minY: -1, minZ: 3, maxX: 1, maxY: 1, maxZ: 5 } },
    { id: "el-000001", bbox: { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 } },
  ];
  assert.deepEqual(pickElements(ray, depths).map((h) => [h.elementId, h.distance]), [["el-000009", 0], ["el-000001", 4]]);
  // Elements without a bbox are never hit (no realized geometry).
  assert.deepEqual(pickElements(ray, [{ id: "el-x", bbox: null }]), []);
  // A ray missing everything → empty.
  assert.deepEqual(pickElements({ origin: [50, 50, 5], direction: [0, 0, -1] }, depths), []);
});

test("projectBoxCorners: the screen-space 2D hull of the 8 corners", () => {
  const camera = standardCameraFor("front", BOX_10, 1, 60, "orthographic");
  const viewport = { width: 800, height: 600 };
  const bounds = projectBoxCorners(camera, viewport, BOX_10)!;
  assert.ok(bounds !== null);
  // halfHeight = 5·1.1 = 5.5 → scale = 600/11; the box spans x 0..10 →
  // width 10·scale, centered: exact expected bounds.
  const scale = 600 / (2 * 5.5);
  assert.ok(Math.abs(bounds.maxX - bounds.minX - 10 * scale) < 1e-9);
  assert.ok(Math.abs(bounds.maxY - bounds.minY - 10 * scale) < 1e-9);
  assert.ok(Math.abs((bounds.minX + bounds.maxX) / 2 - 400) < 1e-9);
  assert.ok(Math.abs((bounds.minY + bounds.maxY) / 2 - 300) < 1e-9);
});

test("boxEdges: the 12 edges in the fixed canonical order", () => {
  const box: BBox3D = { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 3, maxZ: 4 };
  const edges = boxEdges(box);
  assert.equal(edges.length, 12);
  assert.deepEqual(edges, [
    // bottom ring (z = min), CCW from (min,min).
    [[0, 0, 0], [2, 0, 0]], [[2, 0, 0], [2, 3, 0]], [[2, 3, 0], [0, 3, 0]], [[0, 3, 0], [0, 0, 0]],
    // top ring (z = max), same order.
    [[0, 0, 4], [2, 0, 4]], [[2, 0, 4], [2, 3, 4]], [[2, 3, 4], [0, 3, 4]], [[0, 3, 4], [0, 0, 4]],
    // the four verticals, corner order matching the bottom ring.
    [[0, 0, 0], [0, 0, 4]], [[2, 0, 0], [2, 0, 4]], [[0, 3, 0], [0, 3, 4]], [[2, 3, 0], [2, 3, 4]],
  ]);
});

// ---------------------------------------------------------------------------
// UCS algebra.
// ---------------------------------------------------------------------------

test("validateUcsAxes: unit + pairwise ⊥ + right-handed within UCS_ORTHONORMAL_TOLERANCE", () => {
  assert.equal(UCS_ORTHONORMAL_TOLERANCE, 1e-9);
  // The World triple validates.
  assert.equal(validateUcsAxes([1, 0, 0], [0, 1, 0], [0, 0, 1]), null);
  // The East-Plan triple (90° turn about Z) validates.
  assert.equal(validateUcsAxes(EAST_UCS.xAxis, EAST_UCS.yAxis, EAST_UCS.zAxis), null);
  // A perturbation WITHIN the tolerance still validates.
  assert.equal(validateUcsAxes([1, 5e-10, 0], [0, 1, 0], [0, 0, 1]), null);
  // Degenerate (zero) vector rejected with the unit-length message.
  assert.match(validateUcsAxes([0, 0, 0], [0, 1, 0], [0, 0, 1])!, /unit length/);
  // Non-unit rejected.
  assert.match(validateUcsAxes([2, 0, 0], [0, 1, 0], [0, 0, 1])!, /unit length/);
  // Non-perpendicular rejected (a 1e-6 shear is outside the tolerance).
  assert.match(validateUcsAxes([1, 1e-6, 0], [0, 1, 0], [0, 0, 1])!, /perpendicular/);
  assert.match(validateUcsAxes([1, 0, 0], [0, 1, 0], [1, 0, 0])!, /perpendicular/);
  // Left-handed triple rejected (x × y = −z).
  assert.match(validateUcsAxes([1, 0, 0], [0, 1, 0], [0, 0, -1])!, /right-handed/);
  // Non-finite rejected.
  assert.match(validateUcsAxes([Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1])!, /finite 3-vector/);
});

test("ucsToWorldMatrix / worldToUcsMatrix are EXACT inverses (bit-identical round trip)", () => {
  const m = ucsToWorldMatrix(EAST_UCS);
  const inv = worldToUcsMatrix(EAST_UCS);
  assert.ok(inv !== null);
  // The composed product is exactly the identity (=== treats −0 === 0).
  const product = mulMatrix(m, inv!);
  assert.ok(product.every((v, i) => v === IDENTITY_MATRIX4[i]), `product ${JSON.stringify(product)}`);
  // Point round trips are bit-identical for a representative point cloud.
  for (const p of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [3, 4, 5], [-2.5, 7.25, 0.5]] as const) {
    const w = transformPoint(m, p);
    const back = transformPoint(inv!, w);
    assert.deepEqual(back, [...p]);
  }
});

test("ucsToWorld / worldToUcs / direction round trips (the fixed operation order)", () => {
  // The pinned mapping of the East-Plan UCS: [a,b,c] → [10 + b, −a, c].
  assert.deepEqual(ucsToWorld(EAST_UCS, [1, 0, 0]), [10, -1, 0]);
  assert.deepEqual(ucsToWorld(EAST_UCS, [0, 1, 0]), [11, 0, 0]);
  assert.deepEqual(ucsToWorld(EAST_UCS, [3, 4, 5]), [14, -3, 5]);
  assert.deepEqual(worldToUcs(EAST_UCS, [14, -3, 5]), [3, 4, 5]);
  // Direction maps (free vectors — the axes as the basis).
  assert.deepEqual(ucsDirectionToWorld(EAST_UCS, [1, 0, 0]), [0, 1, 0]);
  assert.deepEqual(ucsDirectionToWorld(EAST_UCS, [0, 1, 0]), [-1, 0, 0]);
  assert.deepEqual(worldDirectionToUcs(EAST_UCS, [0, 1, 0]), [1, 0, 0]);
  // Full round trips on the World UCS are the identity.
  assert.deepEqual(ucsToWorld(WORLD_UCS, [3, 4, 5]), [3, 4, 5]);
  assert.deepEqual(worldToUcs(WORLD_UCS, [3, 4, 5]), [3, 4, 5]);
  assert.deepEqual(ucsDirectionToWorld(WORLD_UCS, [3, 4, 5]), [3, 4, 5]);
  assert.deepEqual(worldDirectionToUcs(WORLD_UCS, [3, 4, 5]), [3, 4, 5]);
  // world→UCS→world and UCS→world→UCS round trip exactly.
  const w = ucsToWorld(EAST_UCS, [2.5, -1.25, 4]);
  assert.deepEqual(worldToUcs(EAST_UCS, w), [2.5, -1.25, 4]);
  const d = ucsDirectionToWorld(EAST_UCS, [2.5, -1.25, 4]);
  assert.deepEqual(worldDirectionToUcs(EAST_UCS, d), [2.5, -1.25, 4]);
});

test("snapToUcsGrid / snapWorldToUcsGrid: world→UCS→snap→world exact", () => {
  // Direct UCS-plane snapping: XY snap to the grid, Z preserved.
  assert.deepEqual(snapToUcsGrid([3.2, 4.3, 5.7], 1), [3, 4, 5.7]);
  assert.deepEqual(snapToUcsGrid([-2.5, 0.4, 1], 2), [-2, 0, 1]);
  // A non-positive grid size is a no-op (declined upstream, never silent).
  assert.deepEqual(snapToUcsGrid([3.2, 4.3, 5.7], 0), [3.2, 4.3, 5.7]);
  // World-space snapping through the East-Plan workplane: the world point
  // [14.3, −3.2, 5] has UCS coords [3.2, 4.3, 5] → snapped [3, 4, 5] →
  // world [14, −3, 5] EXACTLY.
  assert.deepEqual(snapWorldToUcsGrid(EAST_UCS, [14.3, -3.2, 5], 1), [14, -3, 5]);
  // World UCS: snapping is the identity on already-snapped points.
  assert.deepEqual(snapWorldToUcsGrid(WORLD_UCS, [14.3, -3.2, 5], 1), [14, -3, 5]);
});

test("parseTypedPoint3D: absolute and @relative triples; anything else is null", () => {
  assert.deepEqual(parseTypedPoint3D("3,4,5"), { point: [3, 4, 5], relative: false });
  assert.deepEqual(parseTypedPoint3D("  3 , 4 , 5  "), { point: [3, 4, 5], relative: false });
  assert.deepEqual(parseTypedPoint3D("@2,-1,0.5"), { point: [2, -1, 0.5], relative: true });
  assert.deepEqual(parseTypedPoint3D(" @ 2 , -1 , 0.5 "), { point: [2, -1, 0.5], relative: true });
  // Invalid inputs → null (the prompt engine falls back to other kinds).
  assert.equal(parseTypedPoint3D(""), null);
  assert.equal(parseTypedPoint3D("3,4"), null);
  assert.equal(parseTypedPoint3D("3,4,5,6"), null);
  assert.equal(parseTypedPoint3D("a,b,c"), null);
  assert.equal(parseTypedPoint3D("3,4,x"), null);
  assert.equal(parseTypedPoint3D("3;4;5"), null);
  assert.equal(parseTypedPoint3D("@"), null);
});

test("resolveTypedPoint3D: absolute maps UCS→world; relative adds to the base in UCS coords", () => {
  // Absolute: the UCS triple maps through ucsToWorld.
  const abs = resolveTypedPoint3D(EAST_UCS, { point: [1, 2, 3], relative: false }, null)!;
  assert.deepEqual(abs, [12, -1, 3]);
  // Absolute through the World UCS is the identity.
  assert.deepEqual(resolveTypedPoint3D(WORLD_UCS, { point: [1, 2, 3], relative: false }, null), [1, 2, 3]);
  // Relative: base [14,−3,5] has UCS coords [3,4,5]; +[1,0,0] → [4,4,5] →
  // world [14,−4,5].
  const rel = resolveTypedPoint3D(EAST_UCS, { point: [1, 0, 0], relative: true }, [14, -3, 5])!;
  assert.deepEqual(rel, [14, -4, 5]);
  // Relative with no base declines (null — the caller surfaces the typed error).
  assert.equal(resolveTypedPoint3D(EAST_UCS, { point: [1, 0, 0], relative: true }, null), null);
  // Relative through the World UCS adds in world coordinates directly.
  assert.deepEqual(resolveTypedPoint3D(WORLD_UCS, { point: [1, 2, 3], relative: true }, [10, 10, 10]), [11, 12, 13]);
});

// ---------------------------------------------------------------------------
// Section preview foundation.
// ---------------------------------------------------------------------------

const CUBE: BBox3D = { minX: -2, minY: -2, minZ: -2, maxX: 2, maxY: 2, maxZ: 2 };

test("intersectPlaneBox: axis-aligned center cut → the exact rectangle in canonical order", () => {
  const poly = intersectPlaneBox([0, 0, 0], [0, 0, 1], CUBE);
  assert.deepEqual(poly, [[2, -2, 0], [2, 2, 0], [-2, 2, 0], [-2, -2, 0]]);
});

test("intersectPlaneBox: corner touch (≤2 crossings) and miss both → empty", () => {
  // The plane through the single corner (2,2,2) touches measure-zero → < 3
  // distinct crossings → empty.
  assert.deepEqual(intersectPlaneBox([2, 2, 2], [-1, -1, -1], CUBE), []);
  // A plane far above the box misses entirely.
  assert.deepEqual(intersectPlaneBox([0, 0, 10], [0, 0, 1], CUBE), []);
  // An empty/degenerate box declines.
  assert.deepEqual(intersectPlaneBox([0, 0, 0], [0, 0, 1], EMPTY_BBOX3D), []);
});

test("intersectPlaneBox: canonical ordering is rotation-invariant (the same polygon pattern)", () => {
  // The z-cut and the x-cut of the same cube produce the SAME canonical
  // (u, v) sign pattern — the vertex order is a property of the polygon,
  // not of the box orientation that produced it.
  const zCut = intersectPlaneBox([0, 0, 0], [0, 0, 1], CUBE);
  const xCut = intersectPlaneBox([0, 0, 0], [1, 0, 0], CUBE);
  const patternOf = (poly: readonly Vec3[], a: 0 | 1 | 2, b: 0 | 1 | 2): readonly (readonly [number, number])[] =>
    poly.map((v) => [v[a], v[b]] as const);
  // z-cut polygon lives in (x, y); x-cut polygon lives in (y, z) — the
  // canonical pattern is identical.
  assert.deepEqual(patternOf(zCut, 0, 1), [[2, -2], [2, 2], [-2, 2], [-2, -2]]);
  assert.deepEqual(patternOf(xCut, 1, 2), [[2, -2], [2, 2], [-2, 2], [-2, -2]]);
  // A diagonal cut through the center produces the pinned hexagon (each
  // vertex exactly on the plane, canonical angle order).
  const hex = intersectPlaneBox([0, 0, 0], [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], CUBE);
  assert.equal(hex.length, 6);
  assert.deepEqual(hex, [[2, -2, 0], [2, 0, -2], [0, 2, -2], [-2, 2, 0], [-2, 0, 2], [0, -2, 2]]);
});

test("buildSectionPreview: facets / missed / noExtent classification", () => {
  const plane: SectionPlaneRecord = { id: "sp-000001", name: "Cut", origin: [0, 0, 0], normal: [0, 0, 1], createdAt: NOW };
  const preview = buildSectionPreview(plane, [
    { id: "el-hit", bbox: CUBE },
    { id: "el-missed", bbox: { minX: -2, minY: -2, minZ: 5, maxX: 2, maxY: 2, maxZ: 9 } },
    { id: "el-no-extent", bbox: null },
  ]);
  assert.equal(preview.format, SECTION_PREVIEW_FORMAT);
  assert.equal(preview.version, "1");
  assert.equal(preview.sectionPlaneId, "sp-000001");
  assert.deepEqual(preview.origin, [0, 0, 0]);
  assert.deepEqual(preview.normal, [0, 0, 1]);
  assert.equal(preview.facets.length, 1);
  assert.equal(preview.facets[0]!.elementId, "el-hit");
  assert.equal(preview.facets[0]!.polygon.length, 4);
  assert.deepEqual(preview.missedElementIds, ["el-missed"]);
  assert.deepEqual(preview.noExtentElementIds, ["el-no-extent"]);
});

test("validateSectionPlaneRecord: zero vector and non-unit normals rejected; normalizeSectionNormal", () => {
  const base: Omit<SectionPlaneRecord, "normal"> = { id: "sp-000001", name: "Cut", origin: [0, 0, 0], createdAt: NOW };
  assert.equal(validateSectionPlaneRecord({ ...base, normal: [0, 0, 1] }), null);
  assert.equal(validateSectionPlaneRecord({ ...base, normal: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] }), null);
  assert.match(validateSectionPlaneRecord({ ...base, normal: [0, 0, 0] })!, /non-zero/);
  assert.match(validateSectionPlaneRecord({ ...base, normal: [0, 0, 3] })!, /unit length/);
  // The explicit command-layer normalization path.
  assert.deepEqual(normalizeSectionNormal([0, 0, 3]), [0, 0, 1]);
  assert.equal(normalizeSectionNormal([0, 0, 0]), null);
});

// ---------------------------------------------------------------------------
// Canonical 3D scene SVG.
// ---------------------------------------------------------------------------

test("buildScene3DSVG: deterministic, id-sorted, selection highlight, UCS triad colors", () => {
  const camera = standardCameraFor("front", { minX: -5, minY: -5, minZ: -5, maxX: 30, maxY: 10, maxZ: 15 }, 1.5, 60, "orthographic");
  const ucs: UcsRecord = EAST_UCS;
  const input = {
    viewport: { width: 800, height: 600 },
    camera,
    elements: [
      { id: "el-000002", bbox: bboxOf([20, 0, 0, 25, 5, 5]) as BBox3D, meshToken: "ref:0f73e3a602131fa7" },
      { id: "el-000001", bbox: bboxOf([0, 0, 0, 10, 10, 10]) as BBox3D, meshToken: "ref:1a2b3c4d5e6f7a8b" },
      { id: "el-000003", bbox: null },
    ],
    ucs,
    grid: [
      { a: [10, -10, 0] as Vec3, b: [10, 10, 0] as Vec3 },
      { a: [-10, 0, 0] as Vec3, b: [30, 0, 0] as Vec3 },
    ],
    sectionFacets: [
      { elementId: "el-000001", polygon: intersectPlaneBox([5, 5, 5], [0, 0, 1], bboxOf([0, 0, 0, 10, 10, 10])) },
    ],
    selectedIds: ["el-000001"],
  };
  const svg1 = buildScene3DSVG(input);
  const svg2 = buildScene3DSVG(input);
  assert.equal(svg1, svg2); // byte-identical determinism
  assert.ok(svg1.startsWith("<svg"));
  assert.ok(svg1.includes('data-format="offisos-scene3d-svg"'));
  // Elements sorted by canonical id (input order was reversed).
  const i1 = svg1.indexOf('data-id="el-000001"');
  const i2 = svg1.indexOf('data-id="el-000002"');
  const i3 = svg1.indexOf('data-id="el-000003"');
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0);
  assert.ok(i1 < i2 && i2 < i3, "element groups must be sorted by canonical id");
  // Selection highlight present ONLY on the selected element.
  assert.ok(svg1.includes('data-id="el-000001" data-extent="bbox" data-selected="true"'));
  assert.ok(!svg1.includes('data-id="el-000002" data-extent="bbox" data-selected'));
  // The UCS triad with the domain-standard axis colors (X red, Y green, Z blue).
  assert.ok(svg1.includes('class="ucs-triad"'));
  assert.ok(svg1.includes('stroke="#dc2626"'));
  assert.ok(svg1.includes('stroke="#16a34a"'));
  assert.ok(svg1.includes('stroke="#2563eb"'));
  assert.ok(svg1.includes('fill="#dc2626">X<'));
  assert.ok(svg1.includes('fill="#16a34a">Y<'));
  assert.ok(svg1.includes('fill="#2563eb">Z<'));
  // Grid + section groups labeled.
  assert.ok(svg1.includes('class="grid" data-plane="ucs-xy"'));
  assert.ok(svg1.includes('class="section-preview" data-level="extent"'));
  // The null-bbox element renders the explicit no-geometry marker cross.
  assert.ok(svg1.includes("el-000003 extent=bbox"));
  // Engine provenance is text-only (the meshToken prefix — first 12 chars).
  assert.ok(svg1.includes("mesh=ref:1a2b3c4d"));
});

// ---------------------------------------------------------------------------
// Solid descriptors.
// ---------------------------------------------------------------------------

test("placeBox/placeCylinder/placeExtrude: the exact UCS-placed descriptor shapes", () => {
  // Box: transform-wrapped with the UCS→world matrix; local extents
  // [0..width, 0..depth, 0..height].
  const box = placeBox(EAST_UCS, 2, 3, 4);
  const expectedBox: GeometryDescriptor = {
    shape: "transform",
    matrix: ucsToWorldMatrix(EAST_UCS),
    target: { shape: "box", width: 2, depth: 3, height: 4 },
  };
  assert.deepEqual(box, expectedBox);
  // The local box corner (2,3,0) maps to world [13, −2, 0] through the
  // descriptor matrix ([a,b,c] → [10 + b, −a, c]).
  assert.deepEqual(transformPoint((box as { matrix: readonly number[] }).matrix, [2, 3, 0]), [13, -2, 0]);
  // Cylinder: the descriptor's NATIVE world origin/direction carry the UCS
  // origin and the UCS Z axis.
  const cyl = placeCylinder(EAST_UCS, 2, 5);
  assert.deepEqual(cyl, { shape: "cylinder", radius: 2, height: 5, origin: [10, 0, 0], direction: [0, 0, 1] });
  // Extrude: the profile lives in the UCS XY plane; the base is the UCS
  // origin offset along the UCS Z by baseZ.
  const profile = [[0, 0], [2, 0], [2, 3]] as const;
  const ext = placeExtrude(EAST_UCS, profile, 5, 1);
  assert.deepEqual(ext, { shape: "extrude", profile: [[0, 0], [2, 0], [2, 3]], height: 5, base: [10, 0, 1] });
  // baseZ default 0 → the base is the UCS origin.
  assert.deepEqual(placeExtrude(WORLD_UCS, profile, 5), { shape: "extrude", profile: [[0, 0], [2, 0], [2, 3]], height: 5, base: [0, 0, 0] });
});

test("moveDescriptor/rotateDescriptor/scaleDescriptor: exact matrix composition", () => {
  const target: GeometryDescriptor = { shape: "box", width: 1, depth: 1, height: 1 };
  // MOVE: a known point translates by the world delta exactly.
  const moved = moveDescriptor(target, [5, -2, 3]);
  assert.equal(moved.shape, "transform");
  assert.deepEqual(transformPoint((moved as { matrix: readonly number[] }).matrix, [1, 1, 1]), [6, -1, 4]);
  // ROTATE 90° about Z maps [1,0,0] → [0,1,0] within 1e-12.
  const rotated = rotateDescriptor(target, [0, 0, 1], 90, [0, 0, 0])!;
  assert.ok(rotated !== null);
  const r = transformPoint((rotated as { matrix: readonly number[] }).matrix, [1, 0, 0]);
  assert.ok(Math.abs(r[0] - 0) < 1e-12 && Math.abs(r[1] - 1) < 1e-12 && Math.abs(r[2] - 0) < 1e-12, `rotated ${r}`);
  // Rotation about a base point: T(base)·R·T(−base) — [1,0,0] about base
  // [1,1,0] by 90° → [2,1,0]... i.e. the point orbits the base.
  const rotatedAbout = rotateDescriptor(target, [0, 0, 1], 90, [1, 1, 0])!;
  const r2 = transformPoint((rotatedAbout as { matrix: readonly number[] }).matrix, [2, 1, 0]);
  assert.ok(Math.abs(r2[0] - 1) < 1e-12 && Math.abs(r2[1] - 2) < 1e-12 && Math.abs(r2[2] - 0) < 1e-12, `rotatedAbout ${r2}`);
  // A degenerate (zero) rotation axis declines.
  assert.equal(rotateDescriptor(target, [0, 0, 0], 90, [0, 0, 0]), null);
  // SCALE 2 about base [1,1,1] maps [2,1,1] → [3,1,1] EXACTLY.
  const scaled = scaleDescriptor(target, 2, [1, 1, 1]);
  assert.deepEqual(transformPoint((scaled as { matrix: readonly number[] }).matrix, [2, 1, 1]), [3, 1, 1]);
  // Scaling about the world origin doubles [2,1,1] → [4,2,2].
  const scaledOrigin = scaleDescriptor(target, 2, [0, 0, 0]);
  assert.deepEqual(transformPoint((scaledOrigin as { matrix: readonly number[] }).matrix, [2, 1, 1]), [4, 2, 2]);
  // Non-uniform points stay exact: scale 0.5 about [0,0,0] maps [2,1,1] → [1, 0.5, 0.5].
  assert.deepEqual(transformPoint((scaleDescriptor(target, 0.5, [0, 0, 0]) as { matrix: readonly number[] }).matrix, [2, 1, 1]), [1, 0.5, 0.5]);
});
