/**
 * CAD-PARITY-013 (Issue #104) — the navigator shared core: View Map folders
 * + Layout Book subsets (ONE kind-tagged document-owned tree), the view
 * folderId / layout subsetId assignment surfaces, the reference gates, the
 * navigator.tree projection (project map + view map + layout book), the
 * undo/redo semantics (one payload = ONE revision = one undo entry), the
 * save/open round trip with stable minted ids and the determinism proofs.
 *
 * Engine-free paths through the dummy bundle (the docs precedent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-p013-navigator",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p013-navigator",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errOf(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, `expected a typed failure, got: ${JSON.stringify(r).slice(0, 300)}`);
  const e = r as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

interface Node {
  id: string;
  kind: "folder" | "subset";
  name: string;
  parentId: string | null;
  order: number;
  prefix?: string;
  numbering?: "none" | "custom";
  customNumber?: string;
}

async function seedModel(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p013-nav-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [0, 3000]], height: 3000 },
    ],
  }));
}

test("navigator: folders and subsets mint canonical ids with deterministic order; malformed input is typed-rejected", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  assert.equal(folder.node.id, "nav-000001");
  assert.equal(folder.node.kind, "folder");
  assert.equal(folder.node.name, "Plans");
  assert.equal(folder.node.parentId, null);
  assert.equal(folder.node.order, 1);
  // A second root folder appends after the first (order 2).
  const folder2 = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Elevations" }));
  assert.equal(folder2.node.id, "nav-000002");
  assert.equal(folder2.node.order, 2);
  // A child folder appends at the end of ITS parent's sibling list.
  const child = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Details", parentId: folder.node.id }));
  assert.equal(child.node.id, "nav-000003");
  assert.equal(child.node.parentId, folder.node.id);
  assert.equal(child.node.order, 1);
  // Subsets carry the subset-only grammar (prefix/numbering/customNumber).
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", {
    name: "Structural", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  assert.equal(subset.node.id, "nav-000004");
  assert.equal(subset.node.kind, "subset");
  assert.equal(subset.node.prefix, "A");
  assert.equal(subset.node.numbering, "custom");
  assert.equal(subset.node.customNumber, "01");
  // Typed rejections.
  assert.equal(errOf(await cmd(h, "navigator.createFolder", { name: "  " })).code, "bad_payload");
  assert.equal(errOf(await cmd(h, "navigator.createFolder", { name: "x".repeat(81) })).code, "bad_payload");
  const badNumbering = errOf(await cmd(h, "navigator.createSubset", { name: "X", numbering: "arabic" }));
  assert.equal(badNumbering.code, "bad_payload");
  const missingCustom = errOf(await cmd(h, "navigator.createSubset", { name: "X", numbering: "custom" }));
  assert.equal(missingCustom.code, "navigator_invalid");
  const folderWithSubsetField = errOf(await cmd(h, "navigator.createFolder", { name: "Y", prefix: "B" }));
  assert.equal(folderWithSubsetField.code, "navigator_invalid");
});

test("navigator: parents must pre-exist and share the kind; update cycles are typed rejections", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", { name: "Structural" }));
  // A folder cannot nest under a subset (and vice versa).
  const mixed = errOf(await cmd(h, "navigator.createFolder", { name: "X", parentId: subset.node.id }));
  assert.equal(mixed.code, "navigator_invalid");
  assert.match(mixed.message, /share the node kind/);
  // Unknown parent.
  const unknown = errOf(await cmd(h, "navigator.createFolder", { name: "X", parentId: "nav-999999" }));
  assert.equal(unknown.code, "navigator_invalid");
  // Re-parenting into a cycle: folder under itself / under its own child.
  const child = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Child", parentId: folder.node.id }));
  const self = errOf(await cmd(h, "document.applyEdit", {
    edit: { type: "updateNavigatorNode", nodeId: folder.node.id, patch: { parentId: folder.node.id } },
  }));
  assert.match(self.message, /own ancestor|share the node kind|does not reference/);
  const cycle = errOf(await cmd(h, "document.applyEdit", {
    edit: { type: "updateNavigatorNode", nodeId: folder.node.id, patch: { parentId: child.node.id } },
  }));
  assert.match(cycle.message, /own ancestor/);
  // A legal rename through the raw edit surface still validates (strict).
  val(await cmd(h, "document.applyEdit", {
    edit: { type: "updateNavigatorNode", nodeId: folder.node.id, patch: { name: "Plans v2" } },
  }));
  const renamed = val<{ viewMap: unknown }>(await qq(h, "navigator.tree", {}));
  void renamed;
});

test("navigator: views file into folders through docs.updateView (folderId patch; null unassigns)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front" },
    ],
  }));
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  // Assign view 1 to the folder (ONE revision, one undo entry).
  const before = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  const historyBefore = before.modelHistory?.revisions.length ?? 0;
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));
  const mid = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  assert.equal((mid.modelHistory?.revisions.length ?? 0) - historyBefore, 1, "one folderId assignment = ONE revision");
  // The tree files the view under the folder.
  let tree = val<{ viewMap: { views: unknown[]; children: { node: Node; views: { viewId: string }[] }[] } }>(await qq(h, "navigator.tree", {}));
  assert.equal(tree.viewMap.views.length, 1, "the second view stays at the map root");
  assert.equal(tree.viewMap.children.length, 1);
  assert.deepEqual(
    tree.viewMap.children[0]!.views.map((v) => v.viewId),
    ["vw-000001"],
  );
  // A non-folder target is rejected (kind check).
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", { name: "S" }));
  const badTarget = errOf(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: subset.node.id } }));
  assert.equal(badTarget.code, "docs_invalid");
  // Unassign with null (the wire representation of absence).
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: null } }));
  tree = val<{ viewMap: { views: unknown[]; children: { node: Node; views: { viewId: string }[] }[] } }>(await qq(h, "navigator.tree", {}));
  assert.equal(tree.viewMap.views.length, 2, "the view is back at the map root");
  assert.equal(tree.viewMap.children[0]!.views.length, 0);
  // Undo restores the assignment exactly (absence round-trips).
  val(await cmd(h, "document.undo", {}));
  tree = val<{ viewMap: { views: unknown[]; children: { node: Node; views: { viewId: string }[] }[] } }>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(tree.viewMap.children[0]!.views.map((v) => v.viewId), ["vw-000001"], "undo restored the folder assignment");
});

test("navigator: layouts file into subsets through layout.update (whitelisted patch; null unassigns)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "layout.create", { name: "Ground Floor" }));
  await val(await cmd(h, "layout.create", { name: "First Floor" }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", { name: "Structural", prefix: "S" }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  let tree = val<{ layoutBook: { layouts: { layoutId: string }[]; children: { node: Node; layouts: { layoutId: string }[] }[] } }>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(tree.layoutBook.layouts.map((l) => l.layoutId), ["lo-000002"], "the second layout stays at the book root");
  assert.deepEqual(tree.layoutBook.children[0]!.layouts.map((l) => l.layoutId), ["lo-000001"]);
  // The patch whitelist: name/pageSetup are NOT layout.update keys.
  const badKey = errOf(await cmd(h, "layout.update", { id: "lo-000001", patch: { name: "X" } }));
  assert.equal(badKey.code, "layout_invalid");
  const missing = errOf(await cmd(h, "layout.update", { id: "lo-999999", patch: { subsetId: null } }));
  assert.equal(missing.code, "layout_not_found");
  // A folder node is not a valid subset target.
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "F" }));
  const mixed = errOf(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: folder.node.id } }));
  assert.equal(mixed.code, "layout_invalid");
  // Unassign.
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: null } }));
  tree = val<{ layoutBook: { layouts: { layoutId: string }[]; children: { node: Node; layouts: { layoutId: string }[] }[] } }>(await qq(h, "navigator.tree", {}));
  assert.equal(tree.layoutBook.children[0]!.layouts.length, 0);
  assert.equal(tree.layoutBook.layouts.length, 2);
});

test("navigator: removeNode is gated by children, views, layouts and publisher items (no silent cascade)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P", storyId: "story-gf" }] }));
  await val(await cmd(h, "layout.create", { name: "L1" }));
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "F" }));
  const child = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "C", parentId: folder.node.id }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", { name: "S" }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  val(await cmd(h, "publisher.create", {
    name: "Set1", items: [{ kind: "subset", id: subset.node.id, format: "pdf" }],
  }));
  // Child gate.
  const childGate = errOf(await cmd(h, "navigator.removeNode", { id: folder.node.id }));
  assert.equal(childGate.code, "navigator_in_use");
  assert.match(childGate.message, /child/);
  val(await cmd(h, "navigator.removeNode", { id: child.node.id }));
  // View gate.
  const viewGate = errOf(await cmd(h, "navigator.removeNode", { id: folder.node.id }));
  assert.equal(viewGate.code, "navigator_in_use");
  assert.match(viewGate.message, /view/);
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: null } }));
  // Layout gate (checked before the publisher items in the document's fixed
  // gate order: children → views → layouts → publisher).
  const layoutGate = errOf(await cmd(h, "navigator.removeNode", { id: subset.node.id }));
  assert.equal(layoutGate.code, "navigator_in_use");
  assert.match(layoutGate.message, /layout/);
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: null } }));
  // Publisher item gate (subset).
  const pubGate = errOf(await cmd(h, "navigator.removeNode", { id: subset.node.id }));
  assert.equal(pubGate.code, "navigator_in_use");
  assert.match(pubGate.message, /publisher/);
  // Removing the set unblocks the node.
  val(await cmd(h, "publisher.remove", { id: "pub-000001" }));
  // Unreferenced now — removal works.
  val(await cmd(h, "navigator.removeNode", { id: subset.node.id }));
  const tree = val<{ layoutBook: { children: unknown[] } }>(await qq(h, "navigator.tree", {}));
  assert.equal(tree.layoutBook.children.length, 0);
  assert.equal(errOf(await cmd(h, "navigator.removeNode", { id: subset.node.id })).code, "navigator_invalid");
});

test("navigator: tree shape — project map element counts, node ordering by (order, id), fresh view hashes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-1u", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.wall", id: "wall-upper", storyId: "story-1u", start: [0, 0], end: [4000, 0], width: 200, height: 3000 },
    ],
  }));
  await val(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Root Plan", storyId: "story-gf" },
      { kind: "plan", title: "Filed Plan", storyId: "story-gf" },
      { kind: "elevation", title: "Nested Elevation", direction: "front" },
    ],
  }));
  // Folders with deliberate (order, id) interleaving: A(order 2) before B(order 1)?
  // The rule is (order, id): create B first but give A a smaller order.
  const folderB = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "B Folder" }));
  const folderA = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "A Folder" }));
  val(await cmd(h, "document.applyEdit", {
    edit: { type: "updateNavigatorNode", nodeId: folderA.node.id, patch: { order: 1 } },
  }));
  val(await cmd(h, "document.applyEdit", {
    edit: { type: "updateNavigatorNode", nodeId: folderB.node.id, patch: { order: 2 } },
  }));
  const subA = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Sub", parentId: folderA.node.id }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000002", patch: { folderId: folderA.node.id } }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000003", patch: { folderId: subA.node.id } }));

  type Tree = {
    projectMap: { stories: { id: string; name: string; level: number; height: number; elementCount: number }[] };
    viewMap: {
      views: { viewId: string; kind: string; title: string; scale?: number; contentHash?: string }[];
      children: { node: Node; views: { viewId: string; contentHash?: string }[]; children: unknown[] }[];
    };
    layoutBook: { layouts: unknown[]; children: unknown[] };
    publisherSets: { id: string; name: string; itemCount: number }[];
  };
  const tree1 = val<Tree>(await qq(h, "navigator.tree", {}));
  const tree2 = val<Tree>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(tree1, tree2, "two runs are identical (deterministic fresh computation)");

  // projectMap: story element counts (storyId OR hosted-by-such).
  assert.deepEqual(tree1.projectMap.stories.map((s) => [s.id, s.name, s.elementCount]), [
    ["story-gf", "Ground Floor", 5],
    ["story-1u", "First Floor", 1],
  ]);
  // children ordered by (order, id): A Folder (order 1) before B Folder (order 2).
  assert.deepEqual(tree1.viewMap.children.map((c) => c.node.name), ["A Folder", "B Folder"]);
  // Views in document order inside a node; nested children present.
  const aFolder = tree1.viewMap.children[0]!;
  assert.deepEqual(aFolder.views.map((v) => v.viewId), ["vw-000002"]);
  assert.equal(aFolder.children.length, 1);
  assert.deepEqual((aFolder.children[0] as { views: { viewId: string }[] }).views.map((v) => v.viewId), ["vw-000003"]);
  // Root views keep document order; hashes are fresh (64-hex).
  assert.deepEqual(tree1.viewMap.views.map((v) => v.viewId), ["vw-000001"]);
  for (const view of [...tree1.viewMap.views, ...aFolder.views, ...(aFolder.children[0] as { views: { contentHash?: string }[] }).views]) {
    assert.match(view.contentHash ?? "", /^[0-9a-f]{64}$/);
  }
  // Empty book + registry.
  assert.deepEqual(tree1.layoutBook.layouts, []);
  assert.deepEqual(tree1.publisherSets, []);
});

test("navigator: save/open round-trip keeps minted ids and the tree identical; double-save is byte-identical", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P", storyId: "story-gf" }] }));
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "F" }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));
  await val(await cmd(h, "layout.create", { name: "L1" }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", {
    name: "S", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));

  const before = val<Tree0>(await qq(h, "navigator.tree", {}));
  const saved1 = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const saved2 = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  assert.deepEqual(saved1.bytes, saved2.bytes, "double-save is byte-identical");

  val(await cmd(h, "document.open", { source: saved1.bytes }));
  const after = val<Tree0>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(after, before, "the tree (ids, orders, assignments) survives the round trip");
  // Minted ids stay stable: the NEXT mint continues the sequence (no reuse).
  const next = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "After" }));
  assert.equal(next.node.id, "nav-000003", "the history mint counter survived (ids never reused)");

  // Undo/redo of the folder create: one revision each way, the tree restores
  // (the pre-existing root folder F survives; the created "After" node is
  // exactly what the undo removes).
  val(await cmd(h, "document.undo", {}));
  const undone = val<Tree0>(await qq(h, "navigator.tree", {}));
  assert.equal(undone.viewMap.children.length, 1, "undo removed the created folder (F alone remains)");
  val(await cmd(h, "document.redo", {}));
  const redone = val<Tree0>(await qq(h, "navigator.tree", {}));
  assert.equal(redone.viewMap.children.length, 2);
});

interface Tree0 {
  viewMap: { views: unknown[]; children: unknown[] };
  layoutBook: { layouts: unknown[]; children: unknown[] };
  projectMap: { stories: unknown[] };
  publisherSets: { id: string; name: string; itemCount: number }[];
}

test("navigator: legacy snapshots carry no new fields (additive-absence guarantee)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seedModel(h);
  await val(await cmd(h, "layout.create", { name: "L1" }));
  await val(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P", storyId: "story-gf" }] }));
  const snap = val<CADDocumentSnapshot>(await qq(h, "document.getState", {}));
  assert.equal(snap.navigatorNodes, undefined);
  assert.equal(snap.titleBlocks, undefined);
  assert.equal(snap.schedules, undefined);
  assert.equal((snap as { revisions?: unknown }).revisions, undefined);
  assert.equal(snap.publisherSets, undefined);
  const layout = (snap.layouts ?? [])[0] as { subsetId?: unknown; masterId?: unknown; titleBlockPlacement?: unknown; revisionIds?: unknown } | undefined;
  assert.ok(layout !== undefined);
  assert.equal(layout!.subsetId, undefined);
  assert.equal(layout!.masterId, undefined);
  assert.equal(layout!.titleBlockPlacement, undefined);
  assert.equal(layout!.revisionIds, undefined);
  const view = (snap.docsViews ?? [])[0] as { folderId?: unknown } | undefined;
  assert.ok(view !== undefined);
  assert.equal(view!.folderId, undefined);
  const history = snap.modelHistory as unknown as Record<string, unknown> | undefined;
  assert.ok(history !== undefined, "a created document always carries a history");
  assert.equal(history["next_navigator_node_sequence"], undefined);
  assert.equal(history["next_title_block_sequence"], undefined);
  assert.equal(history["next_schedule_sequence"], undefined);
  assert.equal(history["next_revision_sequence"], undefined);
  assert.equal(history["next_publisher_set_sequence"], undefined);
});
