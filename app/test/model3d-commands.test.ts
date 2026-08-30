/**
 * CAD-PARITY-009 deterministic 3D command tests (Issue #90) — the App API
 * surface over the REFERENCE adapter (engine-free, deterministic analytic
 * geometry): the UCS lifecycle (define/activate/list/update/remove with the
 * ucs_active + reserved-World typed declines), the view3d non-versioned
 * camera commands (set/fit/standard — view state NEVER creates a revision),
 * model3d.box/cylinder/extrude solid creation (UCS-placed descriptors with
 * engine provenance persisted in the SAME atomic revision), the UCS-aware
 * model3d.move/rotate/scale transforms with exact meshBBox changes and exact
 * undo restores, the section-plane lifecycle + the deterministic bounded
 * section preview (stable canonical hash; section_exact_unsupported), the
 * deterministic element-granularity picking (subentity_unsupported), the
 * mesh query (the reference MeshProvider), undo/redo/save-open/replay
 * integrity — and the PARITY ANCHOR: the full deterministic command stream
 * run twice through two fresh handlers produces byte-identical snapshots,
 * section-preview hashes and canonical scene SVG hashes (printed to stdout
 * as `P009 PARITY save=… svg=… section=…` for the parity fixture).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { createReferenceAdapterBundle } from "../src/adapters/reference/index.js";
import type { CADDocumentSnapshot, Camera3DState, UcsRecord } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { buildScene3DSVG, cameraFrame, type BBox3D, type SectionPreviewFacet } from "../src/workspace/model3d/index.js";
import { canonicalStringify, serialize } from "../src/caddocument/serialization.js";
import { createHash } from "node:crypto";

const CONFIG = {
  adapterBundle: createReferenceAdapterBundle(),
  entityId: "cp9-e2e",
  format: "offisos-reference",
  formatVersion: "1",
  createdBy: "cad-parity-009-tests",
};

function make(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function q(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}
function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r as OkResult).value as T;
}
function errCode(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { code: string }).code;
}

async function state(h: AppApiHandler): Promise<CADDocumentSnapshot> {
  return val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
}

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b as never).digest("hex");

/** The persisted surface of one model3d solid element. */
interface SolidProps {
  readonly type: string;
  readonly shape: string;
  readonly meshToken: string;
  readonly meshBBox: readonly number[];
  readonly geometry: unknown;
  readonly geometryEngine: { readonly engineId: string; readonly engineVersion: string };
  readonly ucsId: string;
  readonly at: readonly number[];
}

async function solid(h: AppApiHandler, elementId: string): Promise<SolidProps> {
  const s = await state(h);
  const el = s.elements.find((e) => e.id === elementId);
  assert.ok(el !== undefined, `element ${elementId} must exist`);
  return el.props as unknown as SolidProps;
}

async function commandDepth(h: AppApiHandler): Promise<number> {
  return (await state(h)).editorState.commandDepth;
}

// ---------------------------------------------------------------------------
// UCS lifecycle.
// ---------------------------------------------------------------------------

test("ucs.define → activate → ucs.list; typed declines; removal gates; undo/redo", async () => {
  const h = make();
  const defined = val<{ ucsId: string; name: string }>(await cmd(h, "ucs.define", {
    name: "East-Plan", origin: [10, 0, 0], xAxis: [0, 1, 0], yAxis: [-1, 0, 0],
  }));
  assert.equal(defined.ucsId, "ucs-000001");
  assert.equal(defined.name, "East-Plan");
  // The explicit right-handed zAxis completion: x × y for the turned plane.
  const s1 = await state(h);
  assert.deepEqual((s1.ucs ?? [])[0]?.zAxis, [0, -0, 1]);

  // activate → the non-versioned current-workplane switch.
  const activated = val<{ activeUcsId: string }>(await cmd(h, "ucs.activate", { id: "ucs-000001" }));
  assert.equal(activated.activeUcsId, "ucs-000001");

  // ucs.list: the inventory + the active id.
  const list = val<{ ucs: readonly { id: string; name: string }[]; activeUcsId: string }>(await q(h, "ucs.list", {}));
  assert.equal(list.activeUcsId, "ucs-000001");
  assert.deepEqual(list.ucs.map((u) => [u.id, u.name]), [["ucs-000001", "East-Plan"]]);

  // Duplicate name → ucs_invalid (bad_payload for malformed shapes).
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "East-Plan", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] })), "ucs_invalid");
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "X", origin: [0, 0, 0], xAxis: [1, 0, 0] })), "bad_payload");
  // Non-orthonormal triple → ucs_invalid (never silently normalized).
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "Skew", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [1, 1, 0] })), "ucs_invalid");
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "LeftHand", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, -1] })), "ucs_invalid");
  // The reserved name "World" (any case) → ucs_invalid.
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "World", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] })), "ucs_invalid");
  assert.equal(errCode(await cmd(h, "ucs.define", { name: "world", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] })), "ucs_invalid");

  // Removing the ACTIVE UCS is the typed ucs_active decline.
  assert.equal(errCode(await cmd(h, "ucs.remove", { id: "ucs-000001" })), "ucs_active");
  // Activate World first → removal succeeds.
  val(await cmd(h, "ucs.activate", { id: "world" }));
  val(await cmd(h, "ucs.remove", { id: "ucs-000001" }));
  assert.equal((await state(h)).ucs?.length ?? 0, 0);
  // The implicit World UCS is never removable — it is not a table record,
  // so every reference form declines bad_id (never ucs_invalid-on-removal:
  // the World record can never be resolved for removal by construction).
  assert.equal(errCode(await cmd(h, "ucs.remove", { name: "World" })), "bad_id");
  assert.equal(errCode(await cmd(h, "ucs.remove", { id: "world" })), "bad_id");
  assert.equal(errCode(await cmd(h, "ucs.remove", { id: "ucs-000404" })), "bad_id");

  // Undo/redo of define/remove (one revision each).
  val(await cmd(h, "document.undo", {})); // undo the remove → the record returns
  assert.equal((await state(h)).ucs?.length, 1);
  val(await cmd(h, "document.redo", {})); // redo the remove
  assert.equal((await state(h)).ucs?.length ?? 0, 0); // canonical-minimal: absent while empty
  val(await cmd(h, "document.undo", {})); // undo the remove again → the record returns
  assert.equal((await state(h)).ucs?.length, 1);
  val(await cmd(h, "document.undo", {})); // undo the define → empty table
  assert.equal((await state(h)).ucs?.length ?? 0, 0);
});

test("ucs.update patches through the shared grammar (name kept unique)", async () => {
  const h = make();
  val(await cmd(h, "ucs.define", { name: "Plan-A", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }));
  val(await cmd(h, "ucs.define", { name: "Plan-B", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }));
  val(await cmd(h, "ucs.update", { id: "ucs-000001", patch: { name: "Plan-A2", origin: [5, 0, 0] } }));
  const s = await state(h);
  assert.equal(s.ucs?.[0]?.name, "Plan-A2");
  assert.deepEqual(s.ucs?.[0]?.origin, [5, 0, 0]);
  // Duplicate rename → ucs_invalid; unknown field → ucs_invalid; bad ref → bad_id.
  assert.equal(errCode(await cmd(h, "ucs.update", { id: "ucs-000001", patch: { name: "Plan-B" } })), "ucs_invalid");
  assert.equal(errCode(await cmd(h, "ucs.update", { id: "ucs-000001", patch: { bogus: 1 } })), "ucs_invalid");
  assert.equal(errCode(await cmd(h, "ucs.update", { id: "ucs-000404", patch: { name: "X" } })), "bad_id");
});

// ---------------------------------------------------------------------------
// view3d — the NON-VERSIONED camera commands.
// ---------------------------------------------------------------------------

test("view3d.set partial updates (mode alone; fovDeg alone) merge onto the persisted camera", async () => {
  const h = make();
  const before = val<{ camera: Camera3DState }>(await q(h, "view3d.state", {})).camera;
  const beforeFrameUp = cameraFrame(before)?.up;
  // Mode switch ALONE: the frame/zoom state preserved (the persisted up is
  // the normalized frame up — deterministic rounding through set).
  const modeSwitch = val<{ camera: Camera3DState }>(await cmd(h, "view3d.set", { mode: "perspective" })).camera;
  assert.equal(modeSwitch.mode, "perspective");
  assert.deepEqual(modeSwitch.eye, before.eye);
  assert.deepEqual(modeSwitch.target, before.target);
  assert.deepEqual(modeSwitch.up, beforeFrameUp);
  assert.equal(modeSwitch.fovDeg, before.fovDeg);
  assert.equal(modeSwitch.orthoHalfHeight, before.orthoHalfHeight);
  // fovDeg ALONE: the mode and the rest stay bit-identical.
  const fov = val<{ camera: Camera3DState }>(await cmd(h, "view3d.set", { fovDeg: 45 })).camera;
  assert.equal(fov.mode, "perspective");
  assert.equal(fov.fovDeg, 45);
  assert.deepEqual(fov.eye, modeSwitch.eye);
  assert.deepEqual(fov.target, modeSwitch.target);
  assert.deepEqual(fov.up, modeSwitch.up);
  // A full frame change persists the normalized frame.
  const moved = val<{ camera: Camera3DState; echo: string }>(await cmd(h, "view3d.set", { eye: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1] })).camera;
  assert.deepEqual(moved.eye, [0, -10, 0]);
  assert.deepEqual(moved.target, [0, 0, 0]);
  assert.deepEqual(moved.up, [0, 0, 1]);
  // The echo-able state query returns the persisted camera.
  const now = val<{ camera: Camera3DState; echo: string }>(await q(h, "view3d.state", {}));
  assert.deepEqual(now.camera, moved);
  assert.ok(now.echo.length > 0);
});

test("view3d.set invalid cameras decline typedly (payload grammar vs camera grammar)", async () => {
  const h = make();
  // Payload-grammar declines (fov 0 / negative orthoHalfHeight / bad mode).
  assert.equal(errCode(await cmd(h, "view3d.set", { fovDeg: 0 })), "bad_payload");
  assert.equal(errCode(await cmd(h, "view3d.set", { orthoHalfHeight: -1 })), "bad_payload");
  assert.equal(errCode(await cmd(h, "view3d.set", { mode: "axonometric" })), "bad_payload");
  // Camera-grammar declines (validateCamera): eye == target, up ∥ forward.
  assert.equal(errCode(await cmd(h, "view3d.set", { eye: [0, 0, 0], target: [0, 0, 0] })), "camera_invalid");
  assert.equal(errCode(await cmd(h, "view3d.set", { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1] })), "camera_invalid");
});

test("view3d.standard: each of the 7 views persists an echo-able standard camera", async () => {
  const h = make();
  for (const view of ["top", "bottom", "front", "back", "left", "right", "iso"]) {
    val(await cmd(h, "view3d.standard", { view }));
    const st = val<{ camera: Camera3DState; echo: string }>(await q(h, "view3d.state", {}));
    assert.ok(st.echo.length > 0, `${view} echo`);
    // The eye sits along the standard frame direction from the target.
    const d = [st.camera.eye[0] - st.camera.target[0], st.camera.eye[1] - st.camera.target[1], st.camera.eye[2] - st.camera.target[2]];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const dir: readonly [number, number, number] = view === "top" ? [0, 0, 1]
      : view === "bottom" ? [0, 0, -1]
      : view === "front" ? [0, -1, 0]
      : view === "back" ? [0, 1, 0]
      : view === "left" ? [-1, 0, 0]
      : view === "right" ? [1, 0, 0]
      : [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(d[i]! / len - dir[i]!) < 1e-12, `${view} eye direction axis ${i}`);
    }
  }
  // An unknown view is a payload decline.
  assert.equal(errCode(await cmd(h, "view3d.standard", { view: "diagonal" })), "bad_payload");
});

test("view3d.fit derives the camera from the model extents (the exact per-corner half-height grows with the model)", async () => {
  const h = make();
  val(await cmd(h, "model3d.box", { width: 10, depth: 10, height: 10, ucsId: "world" }));
  const small = val<{ camera: Camera3DState }>(await cmd(h, "view3d.fit", { aspect: 1 })).camera;
  // The default camera is the ISO view → the fit keeps the iso direction and
  // solves the EXACT per-camera-frame bound: with right = (1,1,0)/√2,
  // up = (−1,1,2)/√6 the binding corner is (−,+,+) → |v·up| = 20/√6 (the
  // world Z axis contributes to the projected height — the old world-extent
  // max(halfY, halfX/aspect)·1.1 = 5.5 ignored it and left 2/8 corners
  // outside the view; the PR #92 review round-2 fix).
  assert.ok(Math.abs(small.orthoHalfHeight - (20 / Math.sqrt(6)) * 1.1) < 1e-9, `small half-height ${small.orthoHalfHeight}`);
  assert.deepEqual(small.target, [5, 5, 5]);
  // A far bigger solid grows the extents → the fitted half-height grows.
  val(await cmd(h, "model3d.box", { width: 100, depth: 100, height: 100, ucsId: "world", at: [200, 0, 0] }));
  const big = val<{ camera: Camera3DState }>(await cmd(h, "view3d.fit", { aspect: 1 })).camera;
  // Extents x∈[0,300], y,z∈[0,100] (halfX 150, halfY/Z 50): the horizontal
  // |v·right| = 200/√2 = 100√2 dominates the vertical 300/√6 → 100√2·1.1.
  assert.ok(Math.abs(big.orthoHalfHeight - 100 * Math.SQRT2 * 1.1) < 1e-9, `big half-height ${big.orthoHalfHeight}`);
  assert.deepEqual(big.target, [150, 50, 50]);
  assert.ok(big.orthoHalfHeight > small.orthoHalfHeight * 10);
});

test("view state NEVER creates a revision (commandDepth unchanged) — the view/model separation", async () => {
  const h = make();
  val(await cmd(h, "ucs.define", { name: "Plan-A", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }));
  const revisionsBefore = (await state(h)).modelHistory!.revisions.length;
  const depthBefore = await commandDepth(h);
  // Every view/activation command is NON-VERSIONED editor state.
  val(await cmd(h, "ucs.activate", { id: "ucs-000001" }));
  val(await cmd(h, "ucs.activate", { id: "world" }));
  val(await cmd(h, "view3d.set", { mode: "perspective", fovDeg: 50 }));
  val(await cmd(h, "view3d.standard", { view: "iso", mode: "orthographic" }));
  val(await cmd(h, "view3d.fit", { aspect: 1.5 }));
  const after = await state(h);
  assert.equal(after.modelHistory!.revisions.length, revisionsBefore);
  assert.equal(after.editorState.commandDepth, depthBefore);
});

// ---------------------------------------------------------------------------
// model3d solid creation.
// ---------------------------------------------------------------------------

test("model3d.box/cylinder/extrude: element shape, provenance, ONE revision each, exact bboxes", async () => {
  const h = make();
  val(await cmd(h, "ucs.define", { name: "East-Plan", origin: [10, 0, 0], xAxis: [0, 1, 0], yAxis: [-1, 0, 0] }));
  val(await cmd(h, "ucs.activate", { id: "ucs-000001" }));

  // BOX through the ACTIVE (turned) UCS: the reference engine's exact world
  // bbox — the local [0..2, 0..3, 0..4] extents map to x∈[10,13], y∈[−2,0],
  // z∈[0,4] (offset by 10 in world X).
  const depthBeforeBox = await commandDepth(h);
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 3, height: 4 }));
  assert.equal(box.elementId, "el-000001");
  const boxProps = await solid(h, box.elementId);
  assert.equal(boxProps.type, "model3d.solid");
  assert.equal(boxProps.shape, "box");
  assert.deepEqual(boxProps.meshBBox, [10, -2, 0, 13, 0, 4]);
  assert.ok(boxProps.meshToken.length > 0);
  assert.deepEqual(boxProps.geometryEngine, { engineId: "reference", engineVersion: "1.1.0" });
  assert.ok(boxProps.geometry !== undefined);
  assert.equal(boxProps.ucsId, "ucs-000001");
  assert.equal(await commandDepth(h), depthBeforeBox + 1); // ONE revision

  // CYLINDER through the same ACTIVE UCS: origin [10,0,0], axis along the
  // UCS Z (the exact radial extents h·|dᵢ| + 2·r·√(1−dᵢ²)).
  const depthBeforeCyl = await commandDepth(h);
  const cyl = val<{ elementId: string }>(await cmd(h, "model3d.cylinder", { radius: 2, height: 5 }));
  const cylProps = await solid(h, cyl.elementId);
  assert.equal(cylProps.type, "model3d.solid");
  assert.equal(cylProps.shape, "cylinder");
  assert.deepEqual(cylProps.meshBBox, [8, -2, 0, 12, 2, 5]);
  assert.equal(await commandDepth(h), depthBeforeCyl + 1);

  // EXTRUDE through the World UCS: the profile AABB × the Z span.
  const depthBeforeExt = await commandDepth(h);
  const ext = val<{ elementId: string }>(await cmd(h, "model3d.extrude", {
    profile: [[0, 0], [4, 0], [4, 3], [0, 3]], height: 5, ucsId: "world",
  }));
  const extProps = await solid(h, ext.elementId);
  assert.equal(extProps.type, "model3d.solid");
  assert.equal(extProps.shape, "extrude");
  assert.deepEqual(extProps.meshBBox, [0, 0, 0, 4, 3, 5]);
  assert.deepEqual(extProps.geometryEngine, { engineId: "reference", engineVersion: "1.1.0" });
  assert.equal(await commandDepth(h), depthBeforeExt + 1);

  // Every meshBBox is 6 finite numbers; every meshToken non-empty.
  for (const id of [box.elementId, cyl.elementId, ext.elementId]) {
    const p = await solid(h, id);
    assert.equal(p.meshBBox.length, 6);
    assert.ok(p.meshBBox.every((n) => typeof n === "number" && Number.isFinite(n)));
    assert.ok(typeof p.meshToken === "string" && p.meshToken.length > 0);
  }

  // Payload + profile grammar declines.
  assert.equal(errCode(await cmd(h, "model3d.box", { width: 0, depth: 1, height: 1, ucsId: "world" })), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.cylinder", { radius: -1, height: 5, ucsId: "world" })), "bad_payload");
  assert.equal(errCode(await cmd(h, "model3d.extrude", { profile: [[0, 0], [1, 0]], height: 5, ucsId: "world" })), "bad_payload");
  // Degenerate (zero-area / coincident-point) profiles → model3d_invalid.
  assert.equal(errCode(await cmd(h, "model3d.extrude", { profile: [[0, 0], [1, 0], [2, 0]], height: 5, ucsId: "world" })), "model3d_invalid");
  assert.equal(errCode(await cmd(h, "model3d.extrude", { profile: [[0, 0], [0, 0], [2, 0], [0, 2]], height: 5, ucsId: "world" })), "model3d_invalid");
  // An unknown UCS reference declines.
  assert.equal(errCode(await cmd(h, "model3d.box", { width: 1, depth: 1, height: 1, ucsId: "ucs-000404" })), "bad_id");
});

test("model3d.move/rotate/scale: exact bbox changes; undo restores meshToken/bbox EXACTLY; typed declines", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 10, depth: 10, height: 10, ucsId: "world" }));
  assert.deepEqual((await solid(h, box.elementId)).meshBBox, [0, 0, 0, 10, 10, 10]);
  const pristine = await solid(h, box.elementId);

  // MOVE [5,0,0]: minX/maxX shift by EXACTLY 5.
  val(await cmd(h, "model3d.move", { elementId: box.elementId, delta: [5, 0, 0], ucsId: "world" }));
  assert.deepEqual((await solid(h, box.elementId)).meshBBox, [5, 0, 0, 15, 10, 10]);

  // SCALE 2 about the world origin: every bound doubles EXACTLY.
  val(await cmd(h, "model3d.scale", { elementId: box.elementId, factor: 2, base: [0, 0, 0], ucsId: "world" }));
  assert.deepEqual((await solid(h, box.elementId)).meshBBox, [10, 0, 0, 30, 20, 20]);

  // UNDO twice → the previous meshToken/bbox/geometry restored EXACTLY
  // (deep-equal the persisted solid surface before/after).
  val(await cmd(h, "document.undo", {}));
  val(await cmd(h, "document.undo", {}));
  const restored = await solid(h, box.elementId);
  assert.deepEqual(restored.meshToken, pristine.meshToken);
  assert.deepEqual(restored.meshBBox, pristine.meshBBox);
  assert.deepEqual(restored.geometry, pristine.geometry);

  // ROTATE 90° about world Z (base origin): the box maps to x∈[−10,0],
  // y∈[0,10] within the rotation's float determinism (1e-12).
  val(await cmd(h, "model3d.rotate", { elementId: box.elementId, axis: [0, 0, 1], deg: 90, ucsId: "world" }));
  const rotated = (await solid(h, box.elementId)).meshBBox;
  assert.ok(Math.abs(rotated[0]! + 10) < 1e-12, `minX ${rotated[0]}`);
  assert.ok(Math.abs(rotated[1]!) < 1e-12, `minY ${rotated[1]}`);
  assert.equal(rotated[2], 0);
  assert.ok(Math.abs(rotated[3]!) < 1e-12, `maxX ${rotated[3]}`);
  assert.ok(Math.abs(rotated[4]! - 10) < 1e-12, `maxY ${rotated[4]}`);
  assert.equal(rotated[5], 10);

  // Typed declines: a non-solid element; the zero rotation axis.
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] }));
  const s = await state(h);
  const lineId = s.elements.find((e) => e.props.type === "line")!.id;
  assert.equal(errCode(await cmd(h, "model3d.move", { elementId: lineId, delta: [1, 0, 0] })), "not_a_solid");
  assert.equal(errCode(await cmd(h, "model3d.rotate", { elementId: box.elementId, axis: [0, 0, 0], deg: 90, ucsId: "world" })), "model3d_invalid");
  assert.equal(errCode(await cmd(h, "model3d.move", { elementId: "el-999999", delta: [1, 0, 0] })), "bad_id");
});

// ---------------------------------------------------------------------------
// Section planes + the bounded preview + picking + mesh.
// ---------------------------------------------------------------------------

test("sectionplane.create/update/remove + the deterministic section preview", async () => {
  const h = make();
  val(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, ucsId: "world" }));
  // The un-normalized normal [0,0,3] normalizes to [0,0,1] EXACTLY.
  const created = val<{ sectionPlaneId: string; normal: readonly number[] }>(await cmd(h, "sectionplane.create", {
    name: "Mid-Z", origin: [0, 0, 2], normal: [0, 0, 3],
  }));
  assert.equal(created.sectionPlaneId, "sp-000001");
  assert.deepEqual(created.normal, [0, 0, 1]);
  const s = await state(h);
  assert.deepEqual(s.sectionPlanes?.[0]?.normal, [0, 0, 1]);
  assert.deepEqual(s.sectionPlanes?.[0]?.origin, [0, 0, 2]);
  // The zero normal is a typed decline; duplicates reject.
  assert.equal(errCode(await cmd(h, "sectionplane.create", { name: "Zero", origin: [0, 0, 0], normal: [0, 0, 0] })), "sectionplane_invalid");
  assert.equal(errCode(await cmd(h, "sectionplane.create", { name: "Mid-Z", origin: [0, 0, 0], normal: [0, 0, 1] })), "sectionplane_invalid");

  // The deterministic preview: a stable hash (same state queried twice) +
  // the facet polygons.
  const p1 = val<{ hash: string; preview: { facets: readonly { elementId: string; polygon: readonly number[][] }[] } }>(await q(h, "model3d.sectionPreview", { id: "sp-000001" }));
  const p2 = val<{ hash: string }>(await q(h, "model3d.sectionPreview", { id: "sp-000001" }));
  assert.equal(p1.hash, p2.hash);
  assert.equal(p1.preview.facets.length, 1);
  assert.equal(p1.preview.facets[0]!.elementId, "el-000001");
  assert.equal(p1.preview.facets[0]!.polygon.length, 4);
  // Exact cross-sections are the typed section_exact_unsupported decline.
  assert.equal(errCode(await q(h, "model3d.sectionPreview", { id: "sp-000001", exact: true })), "section_exact_unsupported");
  assert.equal(errCode(await q(h, "model3d.sectionPreview", { id: "sp-000404" })), "bad_id");

  // update: the plane moves → the preview hash CHANGES deterministically.
  val(await cmd(h, "sectionplane.update", { id: "sp-000001", patch: { origin: [0, 0, 5] } }));
  const s2 = await state(h);
  assert.deepEqual(s2.sectionPlanes?.[0]?.origin, [0, 0, 5]);
  const p3 = val<{ hash: string }>(await q(h, "model3d.sectionPreview", { id: "sp-000001" }));
  assert.notEqual(p3.hash, p1.hash);
  // A re-normalized normal patch stores the unit normal exactly.
  val(await cmd(h, "sectionplane.update", { id: "sp-000001", patch: { normal: [0, 2, 0] } }));
  assert.deepEqual((await state(h)).sectionPlanes?.[0]?.normal, [0, 1, 0]);
  assert.equal(errCode(await cmd(h, "sectionplane.update", { id: "sp-000001", patch: { bogus: 1 } })), "sectionplane_invalid");

  // remove → the preview declines afterwards.
  val(await cmd(h, "sectionplane.remove", { id: "sp-000001" }));
  assert.equal((await state(h)).sectionPlanes?.length ?? 0, 0);
  assert.equal(errCode(await q(h, "model3d.sectionPreview", { id: "sp-000001" })), "bad_id");
});

test("model3d.pick: exactly-ordered hits, misses and the sub-entity decline", async () => {
  const h = make();
  // A controlled camera: eye [0,−20,2] looking +Y at height 2 (ortho).
  val(await cmd(h, "view3d.set", { eye: [0, -20, 2], target: [0, 0, 2], up: [0, 0, 1], mode: "orthographic", orthoHalfHeight: 10, fovDeg: 60 }));
  // Two boxes at different depths along the view axis.
  const near = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, ucsId: "world", at: [-2, -2, 0] }));
  const far = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 4, depth: 4, height: 4, ucsId: "world", at: [-2, 3, 0] }));
  // Screen center (400,300) of an 800×600 viewport → the ray from (0,−20,2)
  // along +Y: the NEAR box (y∈[−2,2]) hits first, then the FAR box (y∈[3,7]).
  const hit = val<{ hits: readonly { elementId: string; distance: number }[]; count: number }>(await q(h, "model3d.pick", {
    screenX: 400, screenY: 300, viewport: { width: 800, height: 600 },
  }));
  assert.equal(hit.count, 2);
  assert.deepEqual(hit.hits.map((x) => x.elementId), [near.elementId, far.elementId]);
  assert.equal(hit.hits[0]!.distance, 18);
  assert.equal(hit.hits[1]!.distance, 23);
  // A screen point missing both → the exactly-empty hit list.
  const miss = val<{ hits: readonly unknown[]; count: number }>(await q(h, "model3d.pick", {
    screenX: 700, screenY: 300, viewport: { width: 800, height: 600 },
  }));
  assert.equal(miss.count, 0);
  assert.deepEqual(miss.hits, []);
  // Sub-entity (face/edge/vertex) picking is the typed decline.
  assert.equal(errCode(await q(h, "model3d.pick", { screenX: 400, screenY: 300, viewport: { width: 800, height: 600 }, subEntity: true })), "subentity_unsupported");
  // Payload grammar declines.
  assert.equal(errCode(await q(h, "model3d.pick", { screenX: 1, viewport: { width: 10, height: 10 } })), "bad_payload");
});

test("model3d.mesh: the reference adapter provides the mesh (MeshProvider)", async () => {
  const h = make();
  const box = val<{ elementId: string }>(await cmd(h, "model3d.box", { width: 2, depth: 3, height: 4, ucsId: "world" }));
  const mesh = val<{ meshToken: string; meshAvailable: boolean; mesh: { vertices: readonly number[]; indices: readonly number[] } | null }>(
    await q(h, "model3d.mesh", { elementId: box.elementId }),
  );
  assert.equal(mesh.meshAvailable, true);
  assert.ok(mesh.mesh !== null);
  // A box mesh: 8 corners × 3 coordinates, 12 triangles × 3 indices.
  assert.equal(mesh.mesh!.vertices.length, 24);
  assert.equal(mesh.mesh!.indices.length, 36);
  assert.equal(mesh.meshToken.length > 0, true);
  assert.equal(errCode(await q(h, "model3d.mesh", { elementId: "el-999999" })), "bad_id");
});

// ---------------------------------------------------------------------------
// The deterministic parity stream (shared by the integrity + anchor tests).
// ---------------------------------------------------------------------------

interface StreamResult {
  readonly saveHash: string;
  readonly svgHash: string;
  readonly sectionHash: string;
  readonly sectionPlaneId: string;
}

/** The full deterministic P009 command stream over a fresh handler. */
async function runDeterministic3DStream(h: AppApiHandler): Promise<StreamResult> {
  const ucs = val<{ ucsId: string }>(await cmd(h, "ucs.define", {
    name: "East-Plan", origin: [10, 0, 0], xAxis: [0, 1, 0], yAxis: [-1, 0, 0],
  }));
  assert.equal(ucs.ucsId, "ucs-000001");
  val(await cmd(h, "ucs.activate", { id: "ucs-000001" }));
  // Solids: one through the ACTIVE UCS, three through the World UCS.
  val(await cmd(h, "model3d.box", { width: 2, depth: 3, height: 4 }));
  val(await cmd(h, "model3d.box", { width: 10, depth: 10, height: 10, ucsId: "world" }));
  val(await cmd(h, "model3d.cylinder", { radius: 2, height: 5, ucsId: "world" }));
  val(await cmd(h, "model3d.extrude", { profile: [[0, 0], [4, 0], [4, 3], [0, 3]], height: 5, ucsId: "world" }));
  // Transforms (UCS-aware, World-resolved).
  val(await cmd(h, "model3d.move", { elementId: "el-000002", delta: [5, 0, 0], ucsId: "world" }));
  val(await cmd(h, "model3d.rotate", { elementId: "el-000002", axis: [0, 0, 1], deg: 90, ucsId: "world" }));
  val(await cmd(h, "model3d.scale", { elementId: "el-000003", factor: 2, base: [0, 0, 0], ucsId: "world" }));
  // A section plane (un-normalized input normalized exactly).
  const plane = val<{ sectionPlaneId: string }>(await cmd(h, "sectionplane.create", {
    name: "Mid-Z", origin: [0, 0, 2], normal: [0, 0, 3],
  }));
  // View state (non-versioned, but persisted — part of the save hash).
  val(await cmd(h, "view3d.set", { mode: "perspective", fovDeg: 50 }));
  val(await cmd(h, "view3d.standard", { view: "iso", mode: "orthographic" }));

  // The save hash: the serialized snapshot with the ephemeral editorState
  // stripped (the P008 comparison pattern).
  const snapshot = await state(h);
  const stripped = JSON.parse(serialize(snapshot)) as Record<string, unknown>;
  delete stripped.editorState;
  const saveHash = sha(canonicalStringify(stripped));

  // The section-preview canonical hash.
  const preview = val<{ hash: string; preview: { facets: readonly SectionPreviewFacet[] } }>(
    await q(h, "model3d.sectionPreview", { id: plane.sectionPlaneId }),
  );

  // The canonical 3D scene SVG hash (the shared deterministic renderer).
  const settings = snapshot.draftingSettings!;
  const camera = settings.view3d;
  assert.ok(camera !== undefined, "the stream persists a view3d camera");
  const activeUcs = (snapshot.ucs ?? [])[0] as UcsRecord | undefined;
  assert.ok(activeUcs !== undefined);
  const svg = buildScene3DSVG({
    viewport: { width: 800, height: 600 },
    camera,
    elements: snapshot.elements.map((el): { id: string; bbox: BBox3D | null; meshToken?: string } => {
      const p = el.props as unknown as { meshBBox?: unknown; meshToken?: unknown };
      const b = Array.isArray(p.meshBBox) && p.meshBBox.length === 6 ? (p.meshBBox as readonly number[]) : null;
      const tok = typeof p.meshToken === "string" ? p.meshToken : undefined;
      const out: { id: string; bbox: BBox3D | null; meshToken?: string } = {
        id: el.id,
        bbox: b === null ? null : { minX: b[0]!, minY: b[1]!, minZ: b[2]!, maxX: b[3]!, maxY: b[4]!, maxZ: b[5]! },
      };
      if (tok !== undefined) out.meshToken = tok;
      return out;
    }),
    ucs: activeUcs,
    sectionFacets: preview.preview.facets,
    selectedIds: ["el-000001"],
  });
  return {
    saveHash,
    svgHash: sha(svg),
    sectionHash: preview.hash,
    sectionPlaneId: plane.sectionPlaneId,
  };
}

test("undo-all → redo-all reproduces the same snapshot content; save → open preserves the P009 state", async () => {
  const h = make();
  await runDeterministic3DStream(h);
  const depth = await commandDepth(h);
  assert.equal(depth, 9); // 1 UCS + 4 solids + 3 transforms + 1 section plane
  const hashBefore = h.currentContentHash();

  // Undo ALL (each undo is one revision; the stream replays backwards).
  for (let i = 0; i < depth; i += 1) {
    val(await cmd(h, "document.undo", {}));
  }
  assert.equal(errCode(await cmd(h, "document.undo", {})), "nothing_to_undo");
  const emptied = await state(h);
  assert.equal(emptied.elements.length, 0);
  assert.equal(emptied.ucs?.length ?? 0, 0);
  assert.equal(emptied.sectionPlanes?.length ?? 0, 0);
  // The NON-VERSIONED view/UCS editor state survives undo (view ≠ model).
  assert.equal(emptied.draftingSettings?.activeUcs, "ucs-000001");
  assert.ok(emptied.draftingSettings?.view3d !== undefined);

  // Redo ALL → the same snapshot content hash.
  for (let i = 0; i < depth; i += 1) {
    val(await cmd(h, "document.redo", {}));
  }
  assert.equal(errCode(await cmd(h, "document.redo", {})), "nothing_to_redo");
  assert.equal(h.currentContentHash(), hashBefore);

  // save → open → the same ucs/camera/solids state (editorState-strip byte
  // identity — the P008 pattern). NOTE: the undo/redo cycle legitimately
  // appended revisions to the model history, so the byte comparison is
  // against the post-redo state (the state that was saved).
  const afterRedo = await state(h);
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  val(await cmd(h, "document.open", { source: Array.from(saved.bytes) }));
  const reopened = await state(h);
  const stripEditorState = (snap: CADDocumentSnapshot): string => {
    const parsed = JSON.parse(serialize(snap)) as Record<string, unknown>;
    delete parsed.editorState;
    return canonicalStringify(parsed);
  };
  assert.equal(stripEditorState(reopened), stripEditorState(afterRedo));
  // UCS records + the active workplane + the camera + the solids survive
  // (the ucs comparison goes through the canonical serialization — the
  // derived zAxis carries −0 in memory, canonically 0 on the wire).
  assert.equal(canonicalStringify(reopened.ucs), canonicalStringify(afterRedo.ucs));
  assert.equal(reopened.ucs?.length, 1);
  assert.equal(reopened.ucs?.[0]?.name, "East-Plan");
  assert.equal(reopened.draftingSettings?.activeUcs, "ucs-000001");
  assert.deepEqual(reopened.draftingSettings?.view3d, afterRedo.draftingSettings?.view3d);
  assert.equal(reopened.elements.length, 4);
  for (const el of reopened.elements) {
    const p = el.props as unknown as SolidProps;
    assert.equal(p.type, "model3d.solid");
    assert.ok(p.meshToken.length > 0);
    assert.deepEqual(p.geometryEngine, { engineId: "reference", engineVersion: "1.1.0" });
  }
  // The reopened document continues the mints monotonically.
  const nextUcs = val<{ ucsId: string }>(await cmd(h, "ucs.define", { name: "Plan-B", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }));
  assert.equal(nextUcs.ucsId, "ucs-000002");
});

test("PARITY ANCHOR: the deterministic command stream is byte-identical across two fresh handlers", async () => {
  const a = await runDeterministic3DStream(make());
  const b = await runDeterministic3DStream(make());
  assert.equal(a.saveHash, b.saveHash, "save hashes must be byte-identical");
  assert.equal(a.svgHash, b.svgHash, "scene SVG hashes must be byte-identical");
  assert.equal(a.sectionHash, b.sectionHash, "section preview hashes must be byte-identical");
  console.log(`P009 PARITY save=${a.saveHash} svg=${a.svgHash} section=${a.sectionHash}`);
});
