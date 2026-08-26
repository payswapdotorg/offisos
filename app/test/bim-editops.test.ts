/**
 * COMPAT-CAD-002 — BIM editing operations through the document command model.
 *
 * Every operation is ONE atomic batch (one revision, one undo entry);
 * unsupported operations fail typed; hosted cascades are declared, itemized
 * and reference-re-pointed. Deterministic expectations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import {
  buildBimCreate,
  copyBimElements,
  deleteBimElements,
  elementToBimEntityOrNull,
  moveBimElements,
  setBimProperties,
  type BimEditOutcome,
} from "../src/bim/commands.js";
import { bimGeometryContext, bimWorldBBox } from "../src/bim/geometry.js";
import type { BimEntity } from "../src/bim/elements.js";

function newDoc(): CADDocument {
  return CADDocument.empty("bim-editops", "offisos-dummy", "1", "test");
}

function mintCounter(start: number): { mint: () => string } {
  let n = start;
  return { mint: () => `minted-${String(n++).padStart(3, "0")}` };
}

function applied(outcome: BimEditOutcome): outcome is Extract<BimEditOutcome, { status: "applied" }> {
  if (outcome.status !== "applied") throw new Error(`expected applied, got no-op: ${outcome.reason}`);
  return true;
}

interface BuildingIds {
  readonly story: string;
  readonly wallSouth: string;
  readonly wallEast: string;
  readonly slab: string;
  readonly opening: string;
  readonly door: string;
  readonly space: string;
}

function editOf(outcome: BimEditOutcome): import("../src/contracts/caddocument.js").DocumentEdit {
  if (outcome.status !== "applied") throw new Error(`expected applied, got no-op: ${outcome.reason}`);
  return outcome.edit;
}

function docWithBuilding(): { doc: CADDocument; ids: BuildingIds } {
  const doc = newDoc();
  const outcome = buildBimCreate([], [
    { type: "bim.story", id: "story-1", name: "Ground Floor", level: 0, height: 3000 },
    { type: "bim.wall", id: "wall-south", storyId: "story-1", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    { type: "bim.wall", id: "wall-east", storyId: "story-1", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
    { type: "bim.slab", id: "slab-1", storyId: "story-1", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
    { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
    { type: "bim.door", id: "door-1", openingId: "op-door", swing: "left" },
    { type: "bim.space", id: "space-1", storyId: "story-1", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
  ]);
  doc.execute(outcome.edit);
  return {
    doc,
    ids: { story: "story-1", wallSouth: "wall-south", wallEast: "wall-east", slab: "slab-1", opening: "op-door", door: "door-1", space: "space-1" },
  };
}

function entitiesOf(doc: CADDocument): BimEntity[] {
  return doc.allElements().map((el) => elementToBimEntityOrNull(el)).filter((x): x is BimEntity => x !== null);
}

function entityById(doc: CADDocument, id: string): BimEntity {
  const entity = entitiesOf(doc).find((e) => e.id === id);
  if (entity === undefined) throw new Error(`no entity ${id}`);
  return entity;
}

test("create batch: one atomic revision, ids minted for unnamed entities", () => {
  const doc = newDoc();
  // Same-batch references require EXPLICIT ids (document-minted identities
  // only exist after apply — the documented batch contract).
  const outcome = buildBimCreate([], [
    { type: "bim.story", id: "story-x", name: "GF", level: 0, height: 3000 },
    { type: "bim.wall", storyId: "story-x", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
  ]);
  assert.deepEqual(outcome.explicitIds, ["story-x"]);
  doc.execute(outcome.edit);
  assert.equal(doc.history.revisions.length, 1, "one revision for the batch");
  assert.deepEqual(doc.allElements().map((e) => e.id), ["story-x", "el-000001"]);
});

test("create batch: reference resolution order (story → wall → opening → fill) and failures", () => {
  const base = [
    { type: "bim.story", id: "s1", name: "GF", level: 0, height: 3000 },
  ];
  // Valid chain within one batch (explicit ids); fill storyId DERIVED.
  const doc = newDoc();
  const ok = buildBimCreate([], [
    ...base,
    { type: "bim.wall", id: "w1", storyId: "s1", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    { type: "bim.opening", id: "o1", hostId: "w1", distance: 100, width: 900, height: 2100, sill: 0 },
    { type: "bim.door", id: "d1", openingId: "o1", swing: "right" },
  ]);
  doc.execute(ok.edit);
  const door = entityById(doc, "d1");
  assert.ok(door.type === "bim.door" && door.storyId === "s1", "door storyId derived from the host wall chain");
  // Unknown story reference.
  assert.throws(
    () => buildBimCreate([], [{ type: "bim.wall", storyId: "nope", start: [0, 0], end: [1, 0], width: 300, height: 3000 }]),
    /does not exist/,
  );
  // Opening host must be a wall.
  assert.throws(
    () => buildBimCreate([], [...base, { type: "bim.opening", hostId: "s1", distance: 0, width: 900, height: 2100, sill: 0 }]),
    /must reference a wall/,
  );
  // Opening must fit the host length.
  assert.throws(
    () => buildBimCreate([], [
      ...base,
      { type: "bim.wall", id: "w1", storyId: "s1", start: [0, 0], end: [1000, 0], width: 300, height: 3000 },
      { type: "bim.opening", id: "o1", hostId: "w1", distance: 500, width: 900, height: 2100, sill: 0 },
    ]),
    /exceeds the host wall length/,
  );
  // sill+height must fit the wall height.
  assert.throws(
    () => buildBimCreate([], [
      ...base,
      { type: "bim.wall", id: "w1", storyId: "s1", start: [0, 0], end: [6000, 0], width: 300, height: 2000 },
      { type: "bim.opening", id: "o1", hostId: "w1", distance: 0, width: 900, height: 2100, sill: 0 },
    ]),
    /exceeds the host wall height/,
  );
});

test("move: story moves in Z only — typed reject for plan components", () => {
  const { doc, ids } = docWithBuilding();
  assert.throws(() => moveBimElements(doc.allElements(), [ids.story], 10, 0, 0), /story.*moves in Z only/);
  assert.throws(() => moveBimElements(doc.allElements(), [ids.story], 0, 5, 0), /story.*moves in Z only/);
  doc.execute(editOf(moveBimElements(doc.allElements(), [ids.story], 0, 0, 3200)));
  const story = entityById(doc, ids.story);
  assert.ok(story.type === "bim.story" && story.level === 3200);
});

test("move: story Z shift deterministically moves derived world geometry", () => {
  const { doc, ids } = docWithBuilding();
  const before = bimWorldBBox(entityById(doc, ids.wallSouth), bimGeometryContext(entitiesOf(doc)))!;
  doc.execute(editOf(moveBimElements(doc.allElements(), [ids.story], 0, 0, 3000)));
  const after = bimWorldBBox(entityById(doc, ids.wallSouth), bimGeometryContext(entitiesOf(doc)))!;
  assert.deepEqual(after, [before[0], before[1], before[2] + 3000, before[3], before[4], before[5] + 3000]);
});

test("move: wall plan shift moves the axis exactly", () => {
  const { doc, ids } = docWithBuilding();
  doc.execute(editOf(moveBimElements(doc.allElements(), [ids.wallSouth], 100, 250, 100)));
  const wall = entityById(doc, ids.wallSouth);
  assert.ok(wall.type === "bim.wall");
  assert.deepEqual(wall.start, [100, 250]);
  assert.deepEqual(wall.end, [6100, 250]);
  assert.equal(wall.baseOffset, 100);
});

test("move: opening moves ALONG the host axis; cross-axis is a typed reject", () => {
  const { doc, ids } = docWithBuilding();
  doc.execute(editOf(moveBimElements(doc.allElements(), [ids.opening], 100, 0, 0)));
  const opening = entityById(doc, ids.opening);
  assert.ok(opening.type === "bim.opening" && opening.distance === 600);
  assert.throws(() => moveBimElements(doc.allElements(), [ids.opening], 0, 50, 0), /cross-axis component/);
});

test("move: opening bounds are enforced (start, end, sill)", () => {
  const { doc, ids } = docWithBuilding();
  assert.throws(() => moveBimElements(doc.allElements(), [ids.opening], -600, 0, 0), /leave the wall start/);
  assert.throws(() => moveBimElements(doc.allElements(), [ids.opening], 6000, 0, 0), /leave the host wall/);
  assert.throws(() => moveBimElements(doc.allElements(), [ids.opening], 0, 0, -10), /sill would be negative/);
  assert.throws(() => moveBimElements(doc.allElements(), [ids.opening], 0, 0, 1000), /exceed the host wall height/);
});

test("move: fills derive from their opening — direct moves are unsupported", () => {
  const { doc, ids } = docWithBuilding();
  assert.throws(() => moveBimElements(doc.allElements(), [ids.door], 10, 0, 0), /supported set/);
});

test("copy: wall copy cascades hosted openings and fills with re-pointed references", () => {
  const { doc, ids } = docWithBuilding();
  const before = doc.allElements().length;
  const { mint } = mintCounter(1);
  const outcome = copyBimElements(doc.allElements(), [ids.wallSouth], 0, 5000, 0, mint);
  assert.ok(applied(outcome));
  assert.equal(outcome.createdIds.length, 3, "wall + opening + door");
  assert.match(outcome.summary, /declared hosted cascades/);
  doc.execute(outcome.edit);
  assert.equal(doc.allElements().length, before + 3);
  const newWallId = outcome.createdIds[0]!;
  const newOpeningId = outcome.createdIds[1]!;
  const newDoorId = outcome.createdIds[2]!;
  const newWall = entityById(doc, newWallId);
  assert.ok(newWall.type === "bim.wall" && newWall.start[1] === 5000 && newWall.end[1] === 5000);
  const newOpening = entityById(doc, newOpeningId);
  assert.ok(
    newOpening.type === "bim.opening" && newOpening.hostId === newWallId && newOpening.distance === 500,
    "hosted copy re-points to the NEW wall with verbatim frame parameters",
  );
  const newDoor = entityById(doc, newDoorId);
  assert.ok(newDoor.type === "bim.door" && newDoor.openingId === newOpeningId, "fill copy re-points to the NEW opening");
});

test("copy: standalone opening copy moves along the host axis (typed cross-axis reject)", () => {
  const { doc, ids } = docWithBuilding();
  const { mint } = mintCounter(1);
  doc.execute(editOf(copyBimElements(doc.allElements(), [ids.opening], 1000, 0, 0, mint)));
  const copies = entitiesOf(doc).filter((e) => e.type === "bim.opening");
  assert.equal(copies.length, 2);
  const copy = copies.find((e) => e.id !== ids.opening)!;
  assert.ok(copy.type === "bim.opening" && copy.distance === 1500 && copy.hostId === ids.wallSouth);
  const { mint: mint2 } = mintCounter(1);
  assert.throws(() => copyBimElements(doc.allElements(), [ids.opening], 0, 100, 0, mint2), /cross-axis component/);
});

test("copy: doors/windows are copied WITH their opening — direct copies unsupported", () => {
  const { doc, ids } = docWithBuilding();
  const { mint } = mintCounter(1);
  assert.throws(() => copyBimElements(doc.allElements(), [ids.door], 10, 0, 0, mint), /supported set/);
});

test("delete: wall deletion cascades openings + fills (itemized in one revision)", () => {
  const { doc, ids } = docWithBuilding();
  const outcome = deleteBimElements(doc.allElements(), [ids.wallSouth]);
  assert.ok(applied(outcome));
  assert.match(outcome.summary, /declared hosted cascades/);
  doc.execute(outcome.edit);
  const remaining = doc.allElements().map((el) => el.id);
  assert.ok(!remaining.includes(ids.wallSouth));
  assert.ok(!remaining.includes(ids.opening));
  assert.ok(!remaining.includes(ids.door));
  const delta = doc.history.revisions[doc.history.revisions.length - 1]!.delta;
  assert.deepEqual([...delta.removed].sort(), [ids.door, ids.opening, ids.wallSouth].sort());
});

test("delete: story deletion is rejected while hosted elements reference it", () => {
  const { doc, ids } = docWithBuilding();
  assert.throws(() => deleteBimElements(doc.allElements(), [ids.story]), /still referenced by/);
  doc.execute(editOf(deleteBimElements(doc.allElements(), [ids.wallSouth, ids.wallEast, ids.slab, ids.space])));
  const outcome = deleteBimElements(doc.allElements(), [ids.story]);
  assert.ok(applied(outcome));
});

test("setProperties: whitelisted keys, merged re-validation, space area recompute", () => {
  const { doc, ids } = docWithBuilding();
  assert.throws(() => setBimProperties(doc.allElements(), ids.wallSouth, { storyId: "x" }), /not a settable property/);
  assert.throws(() => setBimProperties(doc.allElements(), ids.wallSouth, { width: 0 }), /wall\.width/);
  doc.execute(editOf(setBimProperties(doc.allElements(), ids.wallSouth, { width: 250 })));
  const wall = entityById(doc, ids.wallSouth);
  assert.ok(wall.type === "bim.wall" && wall.width === 250);
  doc.execute(editOf(setBimProperties(doc.allElements(), ids.space, { footprint: [[0, 0], [3000, 0], [3000, 3000], [0, 3000]] })));
  const space = entityById(doc, ids.space);
  assert.ok(space.type === "bim.space" && space.area === 9_000_000);
  assert.throws(() => setBimProperties(doc.allElements(), ids.opening, { width: 8000 }), /exceeds the host wall length/);
});

test("undo/redo: every BIM edit inverts exactly (move, copy cascade, delete cascade)", () => {
  const { doc, ids } = docWithBuilding();
  const hash = () => doc.currentContentHash();
  const { mint } = mintCounter(1);

  doc.execute(editOf(moveBimElements(doc.allElements(), [ids.wallSouth], 10, 0, 0)));
  const afterMove = hash();
  doc.undo();
  assert.notEqual(hash(), afterMove);
  doc.redo();
  assert.equal(hash(), afterMove, "redo converges to the same content hash");

  const beforeCopy = hash();
  doc.execute(editOf(copyBimElements(doc.allElements(), [ids.wallSouth], 0, 5000, 0, mint)));
  const afterCopy = hash();
  doc.undo();
  assert.equal(hash(), beforeCopy, "copy cascade undo restores the exact prior content");
  doc.redo();
  assert.equal(hash(), afterCopy);

  // Delete-cascade undo restores the exact element SET (verified semantically,
  // sorted canonical comparison). The content hash itself is insertion-order
  // sensitive by long-standing document-model behavior (§5.4: document order
  // is identity order; removeElement-undo re-adds at the map end) — verified
  // pre-existing with plain non-BIM elements, unchanged by this slice.
  const beforeDeleteCanonical = entitiesOf(doc).map((e) => JSON.stringify(e)).sort();
  doc.execute(editOf(deleteBimElements(doc.allElements(), [ids.wallSouth])));
  assert.ok(!doc.allElements().some((el) => el.id === ids.wallSouth));
  doc.undo();
  const restoredCanonical = entitiesOf(doc).map((e) => JSON.stringify(e)).sort();
  assert.deepEqual(restoredCanonical, beforeDeleteCanonical, "delete cascade undo restores every element exactly");
  const lastRevision = doc.history.revisions.length;
  assert.equal(doc.history.revisions[lastRevision - 1]!.note, "undo", "the delete-undo is recorded as an undo revision");
});
