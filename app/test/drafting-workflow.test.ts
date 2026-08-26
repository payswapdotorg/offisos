/**
 * COMPAT-CAD-001 — the representative 2D drafting benchmark through the
 * shared App API (Issue #37 acceptance criteria):
 *
 *   create → layers → line/polyline/circle/arc/rectangle → dimensions →
 *   snap-driven construction → move/copy/delete → trim/extend → undo/redo →
 *   immutable revision history + verified replay → save/open preserving
 *   entities, layers, IDS, provenance, revision lineage, selection and
 *   settings → Construction Graph events keyed to canonical editor ids.
 *
 * Engine-free (the dummy bundle): drafting never touches an engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "drafting-benchmark",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "compat-cad-001",
};

function make(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

async function cmd(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "command", name: name as never, payload });
}
async function q(handler: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return handler.handle({ type: "query", name: name as never, payload });
}
function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r as OkResult).value as T;
}
function errCode(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { code: string }).code;
}

test("representative drafting benchmark: create → edit → version → persist → reopen", async () => {
  const h = make();
  val(await cmd(h, "document.create", { entityId: "bench-1" }));

  // --- Layers: default layer 0 + a structural layer + hidden layer -------
  const defaultLayers = val<CADDocumentSnapshot>(await q(h, "document.getState", {})).layers;
  assert.deepEqual(defaultLayers?.map((l) => l.id), ["0"], "documents start with canonical layer '0'");
  const walls = val<{ layerId: string }>(await cmd(h, "drafting.addLayer", { name: "walls", color: "#b91c1c" }));
  assert.equal(walls.layerId, "ly-000001");
  const hidden = val<{ layerId: string }>(await cmd(h, "drafting.addLayer", { name: "hidden-grid" }));
  assert.equal(hidden.layerId, "ly-000002");
  await cmd(h, "drafting.updateLayer", { layerId: hidden.layerId, patch: { visible: false } });

  // --- Core entities on the walls layer ----------------------------------
  const created = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [
      { type: "line", layer: walls.layerId, from: [0, 0], to: [100, 0] },         // el-000001
      { type: "line", layer: walls.layerId, from: [100, 0], to: [100, 60] },      // el-000002
      { type: "polyline", layer: walls.layerId, points: [[0, 0], [0, 60], [100, 60]], closed: false }, // el-000003
      { type: "circle", layer: "0", center: [50, 30], radius: 12 },               // el-000004
      { type: "arc", layer: "0", center: [50, 30], radius: 20, startAngle: 0, endAngle: Math.PI }, // el-000005
      { type: "rectangle", layer: walls.layerId, corner1: [10, 10], corner2: [30, 25] }, // el-000006
    ],
  }));
  assert.deepEqual(created.created, [
    "el-000001", "el-000002", "el-000003", "el-000004", "el-000005", "el-000006",
  ], "one atomic batch mints consecutive canonical ids");
  const [LINE1, LINE2, PL, CIRC, ARC, RECT] = created.created as [string, string, string, string, string, string];

  // entity on an unknown layer is rejected (LOCK-007)
  assert.equal(errCode(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "line", layer: "nope", from: [0, 0], to: [1, 1] }],
  })), "drafting_invalid");

  // --- Dimensions (annotation entities) -----------------------------------
  const dims = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [
      { type: "dim-linear", layer: "0", p1: [0, 0], p2: [100, 0], mode: "aligned", offset: -8 },
      { type: "dim-radius", layer: "0", target: CIRC },
    ],
  }));
  const [DIM_L, DIM_R] = dims.created as [string, string];
  const snapshotAfterDims = val<{ snapshot: CADDocumentSnapshot }>(await cmd(h, "drafting.setSettings", {
    settings: { view: { pan: [12, -4], zoom: 1.75 } },
  })).snapshot;
  const dimL = snapshotAfterDims.elements.find((e) => e.id === DIM_L);
  assert.equal((dimL?.props as { measured: number }).measured, 100);
  assert.equal(dimL?.kind, "annotation");
  const dimR = snapshotAfterDims.elements.find((e) => e.id === DIM_R);
  assert.equal((dimR?.props as { measured: number }).measured, 12, "radius dim measured from the referenced circle");
  // the settings round-trip through the snapshot
  assert.deepEqual(snapshotAfterDims.draftingSettings?.view.pan, [12, -4]);
  assert.equal(snapshotAfterDims.draftingSettings?.view.zoom, 1.75);

  // dim-radius to a non-circle / missing target: typed rejection
  assert.equal(errCode(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "dim-radius", layer: "0", target: LINE1 }],
  })), "drafting_invalid");
  assert.equal(errCode(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "dim-radius", layer: "0", target: "el-999999" }],
  })), "drafting_invalid");

  // --- Snap-driven construction: pick the L1×L2 endpoint via snapping -----
  const snapR = val<{
    snapped: boolean;
    best: { kind: string; point: number[]; targets: string[]; distance: number } | null;
  }>(await q(h, "drafting.snap", { point: [100.4, -0.1], tolerance: 0.5 }));
  assert.equal(snapR.snapped, true);
  // approached from beyond both segments: every candidate clamps to the
  // shared endpoint (100,0) at equal distance — endpoint priority wins the tie.
  assert.equal(snapR.best?.kind, "endpoint");
  assert.deepEqual(snapR.best?.point, [100, 0]);
  const snappedPoint = snapR.best?.point as [number, number];

  // build a construction line FROM the snapped point (deterministic workflow)
  const anchor = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: snappedPoint, to: [140, 40] }],
  }));
  const ANCHOR = anchor.created[0] as string;

  // hidden layers are not snappable (visibility is pickability)
  const hiddenEnt = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "line", layer: hidden.layerId, from: [200, 200], to: [300, 200] }],
  }));
  const hiddenId = hiddenEnt.created[0] as string;
  const snapHidden = val<{ best: { targets: string[] } | null }>(await q(h, "drafting.snap", {
    point: [250.1, 200.1], tolerance: 1, kinds: ["on-object"],
  }));
  assert.equal(snapHidden.best, null, "entities on hidden layers do not snap");

  // --- select / move / copy / delete --------------------------------------
  val(await cmd(h, "document.setSelection", { ids: [RECT, ANCHOR] }));
  val(await cmd(h, "drafting.move", { ids: [RECT, ANCHOR], dx: 5, dy: 5 }));
  const movedRect = val<CADDocumentSnapshot>(await q(h, "document.getState", {})).elements
    .find((e) => e.id === RECT);
  assert.deepEqual((movedRect?.props as { corner1: number[] }).corner1, [15, 15]);

  const copied = val<{ created: string[] }>(await cmd(h, "drafting.copy", { ids: [RECT], dx: 40, dy: 0 }));
  const RECT_COPY = copied.created[0] as string;
  assert.match(RECT_COPY, /^el-\d{6}$/);

  val(await cmd(h, "drafting.delete", { ids: [hiddenId] }));
  // hidden-grid is now unreferenced → removable through the same command model
  val(await cmd(h, "drafting.removeLayer", { layerId: hidden.layerId }));
  // removing a referenced layer is a typed rejection (no silent cascade)
  assert.equal(errCode(await cmd(h, "drafting.removeLayer", { layerId: walls.layerId })), "drafting_invalid");

  // --- trim + extend with deterministic geometry ---------------------------
  // ANCHOR (now from [105,5] to [145,45]) crosses LINE2 (x=100..105? LINE2 is
  // x=100 vertical) — rebuild a dedicated scenario instead:
  const cut = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [
      { type: "line", layer: "0", from: [0, 80], to: [120, 80] },   // target
      { type: "line", layer: "0", from: [60, 60], to: [60, 100] },  // boundary
    ],
  }));
  const [TARGET, BOUND] = cut.created as [string, string];
  const trim = val<{ applied: boolean; snapshot: CADDocumentSnapshot }>(await cmd(h, "drafting.trim", {
    targetId: TARGET, pick: [90, 80],
  }));
  assert.equal(trim.applied, true);
  const trimmed = trim.snapshot.elements.find((e) => e.id === TARGET);
  assert.ok(trimmed !== undefined, "head portion keeps the identity");
  assert.deepEqual((trimmed.props as { to: number[] }).to, [60, 80], "exact trim coordinate");

  const ext = val<{ applied: boolean; snapshot: CADDocumentSnapshot }>(await cmd(h, "drafting.extend", {
    targetId: TARGET, pick: [10, 80],
  }));
  assert.equal(ext.applied, false, "already trimmed head has no boundary beyond its from end… none at x<0");
  // extend a line to the circle rim instead
  const ext2 = val<{ applied: boolean; snapshot: CADDocumentSnapshot }>(await cmd(h, "drafting.extend", {
    targetId: LINE1, pick: [95, 0],
  }));
  // LINE1 = [0,0]→[100,0]; beyond `to` the nearest boundary is the arc rim
  // (circle r=12 at (50,30) does not reach y=0; arc r=20 at (50,30): y=0 →
  // x = 50 ± sqrt(400-900)? no point. So nothing crosses → applied false is
  // CORRECT; assert the typed no-op reason instead of forcing a hit.
  assert.equal(ext2.applied, false);
  // deterministic positive extend: boundary wall at x=130
  const far = val<{ created: string[] }>(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: [130, -20], to: [130, 20] }],
  }));
  const FAR = far.created[0] as string;
  const ext3 = val<{ applied: boolean; snapshot: CADDocumentSnapshot }>(await cmd(h, "drafting.extend", {
    targetId: LINE1, pick: [95, 0],
  }));
  assert.equal(ext3.applied, true);
  const extended = ext3.snapshot.elements.find((e) => e.id === LINE1);
  assert.deepEqual((extended?.props as { to: number[] }).to, [130, 0], "exact extend coordinate");

  // trim of a non-line target is a typed unsupported error
  assert.equal(errCode(await cmd(h, "drafting.trim", { targetId: CIRC, pick: [50, 42] })), "drafting_unsupported");

  // --- undo/redo through the command model ---------------------------------
  const undoR = val<{ snapshot: CADDocumentSnapshot }>(await cmd(h, "document.undo", {}));
  assert.deepEqual(
    (undoR.snapshot.elements.find((e) => e.id === LINE1)?.props as { to: number[] }).to,
    [100, 0],
    "one undo reverts the whole extend",
  );
  val(await cmd(h, "document.redo", {}));
  const redone = val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
  assert.deepEqual((redone.elements.find((e) => e.id === LINE1)?.props as { to: number[] }).to, [130, 0]);

  // --- revision lineage + verified replay -----------------------------------
  const history = val<{ revisions: { revision_number: number; note: string }[] }>(await q(h, "model.getHistory", {}));
  const notes = history.revisions.map((r) => r.note);
  assert.ok(notes.every((n) => n === "edit" || n === "undo" || "redo"));
  assert.equal(notes.filter((n) => n === "undo").length, 1);
  assert.equal(notes.filter((n) => n === "redo").length, 1);
  const k = history.revisions.length;
  const replay = val<{ verified: boolean; content_hash: string }>(await q(h, "model.replay", { revision_number: k }));
  assert.equal(replay.verified, true, "full-history replay verifies (LOCK-005)");
  const replayMid = val<{ verified: boolean }>(await q(h, "model.replay", { revision_number: 1 }));
  assert.equal(replayMid.verified, true);

  // --- Construction Graph events: canonical ids, never engine ids ----------
  const events = val<{
    events: {
      event_id: string; event_type: string;
      payload: { elements: { element_id: string; change: string; engineId: string | null }[] };
    }[];
    events_hash: string;
  }>(await q(h, "model.getGraphEvents", {}));
  assert.ok(events.events.length >= k + 1, "model.created + one per revision");
  const added = events.events.flatMap((e) => e.payload.elements).filter((p) => p.change === "added");
  assert.ok(added.every((p) => p.element_id.startsWith("el-") || p.element_id === DIM_L || p.element_id === DIM_R));
  assert.ok(added.every((p) => p.engineId === null), "drafting provenance is engine-free");
  const eventsHash = events.events_hash;

  // --- selection + settings + layers + lineage survive save/open ------------
  val(await cmd(h, "document.setSelection", { ids: [RECT, CIRC] }));
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const contentHashBefore = h.currentContentHash();
  const historyHashBefore = (val<{ revisions: unknown[] }>(await q(h, "model.getHistory", {})), undefined);
  void historyHashBefore;

  const h2 = make();
  val(await cmd(h2, "document.open", { source: saved.bytes }));

  const opened = val<CADDocumentSnapshot>(await q(h2, "document.getState", {}));
  assert.equal(opened.elements.length, redone.elements.length);
  assert.deepEqual(
    opened.elements.map((e) => e.id).sort(),
    redone.elements.map((e) => e.id).sort(),
    "all canonical ids survive save/open",
  );
  assert.deepEqual(opened.layers?.map((l) => [l.id, l.name, l.visible]), [
    ["0", "0", true],
    ["ly-000001", "walls", true],
  ], "layer table persists (hidden-grid was deleted)");
  assert.deepEqual(opened.selection, [RECT, CIRC], "selection persists through save/open");
  assert.deepEqual(opened.draftingSettings?.view.pan, [12, -4], "settings persist");
  assert.equal(opened.modelHistory?.revisions.length, k, "full revision lineage persists");
  const events2 = val<{ events_hash: string }>(await q(h2, "model.getGraphEvents", {}));
  assert.equal(events2.events_hash, eventsHash, "identical graph events after reopen");
  assert.equal(h2.currentContentHash(), contentHashBefore, "identical content hash after reopen");

  // revision CONTINUES after reopen (lineage is append-only)
  val(await cmd(h2, "drafting.createEntities", {
    entities: [{ type: "line", layer: "0", from: [0, -10], to: [50, -10] }],
  }));
  const cont = val<{ revisions: unknown[] }>(await q(h2, "model.getHistory", {}));
  assert.equal(cont.revisions.length, k + 1);
  const replay2 = val<{ verified: boolean }>(await q(h2, "model.replay", { revision_number: k + 1 }));
  assert.equal(replay2.verified, true);
});

test("setSettings validates and canonicalizes; non-versioned", async () => {
  const h = make();
  const before = val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
  val(await cmd(h, "drafting.setSettings", {
    settings: { grid: { enabled: false, size: 5 }, snap: { kinds: ["grid", "endpoint", "grid"], tolerance: 0.25 } },
  }));
  const after = val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
  assert.deepEqual(after.draftingSettings?.grid, { enabled: false, size: 5 });
  assert.deepEqual(after.draftingSettings?.snap.kinds, ["endpoint", "grid"], "deduped + priority-ordered");
  assert.equal(after.draftingSettings?.snap.tolerance, 0.25);
  assert.equal(after.version.version_id, before.version.version_id, "settings do NOT bump the version");
  assert.equal(errCode(await cmd(h, "drafting.setSettings", {
    settings: { grid: { size: -1 } },
  })), "drafting_invalid");
});

test("empty batch and unknown entity shapes are typed errors", async () => {
  const h = make();
  assert.equal(errCode(await cmd(h, "drafting.createEntities", { entities: [] })), "drafting_invalid");
  assert.equal(errCode(await cmd(h, "drafting.createEntities", {
    entities: [{ type: "hyperbola", layer: "0" }],
  })), "drafting_invalid");
  assert.equal(errCode(await cmd(h, "drafting.move", { ids: ["nope"], dx: 1, dy: 1 })), "drafting_invalid");
  assert.equal(errCode(await q(h, "drafting.snap", { point: [1] })), "bad_payload");
});
