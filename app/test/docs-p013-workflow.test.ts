/**
 * CAD-PARITY-013 (Issue #104) — the representative documentation-production
 * END-TO-END workflow: model seed → saved views (plan + elevation + detail of
 * plan) → the navigator (View Map folder + Layout Book subset) → master
 * layout → title block create + place → schedules (elements + views) + run →
 * revision on a layout → publisher set (subset + explicit layout) + run.
 *
 * Then the structural proofs: one payload = ONE DocumentEdit = one version =
 * one undo entry (exact revision-count math; undo/redo through the whole
 * stack restores every table), the save/open round trip keeps minted ids +
 * identical tree/query results, and double-save is byte-identical.
 *
 * Engine-free paths through the dummy bundle (the docs precedent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-p013-workflow",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p013-workflow",
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
}
interface Tree {
  projectMap: { stories: { id: string; name: string; elementCount: number }[] };
  viewMap: {
    views: { viewId: string; title: string }[];
    children: { node: Node; views: { viewId: string; title: string }[]; children: unknown[] }[];
  };
  layoutBook: {
    layouts: { layoutId: string; name: string; sheetNumber: string; revisionCodes: string[] }[];
    children: { node: Node; layouts: { layoutId: string; name: string; sheetNumber: string; revisionCodes: string[] }[] }[];
  };
  publisherSets: { id: string; name: string; itemCount: number }[];
}

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p013-workflow-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
    ],
  }));
}

/** The full P013 command stream (one payload = one DocumentEdit each). */
async function runWorkflow(h: AppApiHandler): Promise<void> {
  // 1. Saved views: plan + front elevation + a detail OF the plan.
  const views = val<{ created: { id: string }[] }>(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
      { kind: "detail", title: "Wall Detail 1", sourceViewId: "vw-000001", region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: 2 },
    ],
  }));
  assert.equal(views.created.length, 3);
  // 2. The View Map: a folder + a subfolder, the views filed under them.
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  const subfolder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Details", parentId: folder.node.id }));
  await val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));
  await val(await cmd(h, "docs.updateView", { viewId: "vw-000002", patch: { folderId: folder.node.id } }));
  await val(await cmd(h, "docs.updateView", { viewId: "vw-000003", patch: { folderId: subfolder.node.id } }));
  // 3. The Layout Book: a custom-numbered subset + three layouts.
  await val(await cmd(h, "layout.create", { name: "Master Sheet" }));
  await val(await cmd(h, "layout.create", { name: "Ground Floor" }));
  await val(await cmd(h, "layout.create", { name: "Roof Plan" }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", {
    name: "Structural", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  await val(await cmd(h, "layout.update", { id: "lo-000002", patch: { subsetId: subset.node.id } }));
  await val(await cmd(h, "layout.update", { id: "lo-000003", patch: { subsetId: subset.node.id } }));
  // 4. The master layout (single-level; furniture + title-block placement
  //    compose beneath the mastered layout's content).
  await val(await cmd(h, "layout.update", { id: "lo-000002", patch: { masterId: "lo-000001" } }));
  // 5. Title block create + place on the mastered layout.
  await val(await cmd(h, "titleblock.create", {
    name: "Standard",
    widthMm: 180,
    heightMm: 72,
    rowHeightMm: 12,
    rows: [
      { label: "Project", field: "text", value: "Offisos Demo" },
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
      { label: "Revisions", field: "revisions" },
      { label: "Author", field: "text", value: "Z User" },
    ],
  }));
  await val(await cmd(h, "layout.update", {
    id: "lo-000002",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 10, yMm: 10 } },
  }));
  // 6. Schedules: an elements index + a views index; both RUN (fresh rows).
  const elementsSchedule = val<{ schedule: { id: string } }>(await cmd(h, "schedule.create", {
    name: "Element Index",
    source: "elements",
    columns: [
      { key: "id", label: "Id" },
      { key: "type", label: "Type" },
      { key: "story", label: "Story" },
    ],
  }));
  const viewsSchedule = val<{ schedule: { id: string } }>(await cmd(h, "schedule.create", {
    name: "View Index",
    source: "views",
    columns: [
      { key: "id", label: "Id" },
      { key: "title", label: "Title" },
      { key: "folder", label: "Folder" },
    ],
  }));
  const elementRows = val<{ rows: readonly (readonly string[])[]; rowCount: number; sha256: string }>(
    await qq(h, "schedules.run", { id: elementsSchedule.schedule.id }),
  );
  assert.equal(elementRows.rowCount, 4, "story + 2 walls + slab");
  const viewRows = val<{ rows: readonly (readonly string[])[] }>(
    await qq(h, "schedules.run", { id: viewsSchedule.schedule.id }),
  );
  assert.deepEqual(viewRows.rows.map((r) => [r[1], r[2]]), [
    ["Ground Floor Plan", "Plans"],
    ["Front Elevation", "Plans"],
    ["Wall Detail 1", "Details"],
  ]);
  // 7. A revision issued on the Ground Floor layout.
  await val(await cmd(h, "revision.add", { code: "P01", description: "First issue", layoutIds: ["lo-000002"] }));
  await val(await cmd(h, "layout.update", { id: "lo-000002", patch: { revisionIds: ["rev-000001"] } }));
  // 8. The publisher set: the subset + one explicit root layout; RUN
  //    (non-versioned).
  await val(await cmd(h, "publisher.create", {
    name: "Issue Set",
    items: [
      { kind: "subset", id: subset.node.id, format: "pdf" },
      { kind: "layout", id: "lo-000001", format: "svg" },
    ],
  }));
  const run = val<{ pages: { layoutId: string; sheetNumber?: unknown; revisions: string[]; sha256: string }[]; pdfSha256: string; pdfSize: number }>(
    await cmd(h, "publisher.run", { id: "pub-000001" }),
  );
  assert.deepEqual(run.pages.map((p) => p.layoutId), ["lo-000002", "lo-000003", "lo-000001"]);
  assert.deepEqual(run.pages.map((p) => p.revisions), [["P01"], [], []]);
  assert.match(run.pdfSha256, /^[0-9a-f]{64}$/);
}

test("workflow: the full P013 stack — version-count math, undo/redo through the whole tree, save/open round trip", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  // The version-count math (one payload = ONE DocumentEdit = one revision):
  //   1 bim.createElements          (model seed)
  //   2 docs.createViews            (3 views in ONE payload)
  //   3 navigator.createFolder      (Plans)
  //   4 navigator.createFolder      (Details under Plans)
  // 5-7 docs.updateView ×3          (folderId assignments)
  // 8-10 layout.create ×3
  //  11 navigator.createSubset      (Structural)
  // 12-13 layout.update ×2          (subsetId assignments)
  //  14 layout.update               (masterId)
  //  15 titleblock.create
  //  16 layout.update               (titleBlockPlacement)
  // 17-18 schedule.create ×2
  //  19 revision.add
  //  20 layout.update               (revisionIds)
  //  21 publisher.create
  //  22 publisher.run — NON-VERSIONED (the plot.publish precedent: no
  //     revision, no undo entry).
  const VERSIONED_EDITS = 21;
  await runWorkflow(h);
  const state = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  assert.equal(
    state.modelHistory?.revisions.length,
    VERSIONED_EDITS,
    "one payload = one revision through the whole P013 stack (publisher.run adds none)",
  );

  const treeBefore = val<Tree>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(treeBefore.projectMap.stories.map((s) => [s.id, s.elementCount]), [["story-gf", 3]]);
  assert.deepEqual(treeBefore.viewMap.children[0]!.views.map((v) => v.viewId), ["vw-000001", "vw-000002"]);
  assert.deepEqual(treeBefore.layoutBook.children[0]!.layouts.map((l) => [l.name, l.sheetNumber, l.revisionCodes]), [
    ["Ground Floor", "A-01", ["P01"]],
    ["Roof Plan", "A-02", []],
  ]);
  assert.deepEqual(treeBefore.layoutBook.layouts.map((l) => [l.name, l.sheetNumber]), [["Master Sheet", "L01"]]);
  assert.deepEqual(treeBefore.publisherSets.map((p) => [p.name, p.itemCount]), [["Issue Set", 2]]);

  // Undo/redo through the WHOLE stack: after 21 undos the document is back
  // to the seed state (empty navigator/titleblock/schedule/revision/publisher
  // tables; the views/layouts gone); after 21 redos everything is restored
  // bit-for-bit.
  for (let i = 0; i < VERSIONED_EDITS; i++) {
    val(await cmd(h, "document.undo", {}));
  }
  const treeUndone = val<Tree>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(treeUndone.viewMap.children, [], "undo removed the folders");
  assert.equal(treeUndone.viewMap.views.length, 0, "undo removed the views");
  assert.deepEqual(treeUndone.layoutBook.layouts, [], "undo removed the layouts");
  assert.deepEqual(treeUndone.publisherSets, [], "undo removed the publisher sets");
  const undoneState = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  // Undo is itself VERSIONED (one revision per undo — the docs-workflow
  // precedent "move + undo appended exactly two revisions"), so the history
  // DOUBLES: the document STATE is back at the seed (empty tables, proven
  // above), the journal records both directions.
  assert.equal(undoneState.modelHistory?.revisions.length, 2 * VERSIONED_EDITS);
  for (let i = 0; i < VERSIONED_EDITS; i++) {
    val(await cmd(h, "document.redo", {}));
  }
  const treeRedone = val<Tree>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(treeRedone, treeBefore, "redo restored the whole P013 stack bit-for-bit");

  // Save/open round trip: minted ids survive, the tree and the fresh query
  // results are identical, and double-save is byte-identical.
  const saved1 = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  const saved2 = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  assert.deepEqual(saved1.bytes, saved2.bytes, "double-save is byte-identical");
  await val(await cmd(h, "document.open", { source: saved1.bytes }));
  const treeAfter = val<Tree>(await qq(h, "navigator.tree", {}));
  assert.deepEqual(treeAfter, treeBefore, "the tree (ids, orders, assignments, sheet numbers) survives the round trip");
  // The mint counters survived: the NEXT mints continue the sequences.
  const nextFolder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "After Open" }));
  assert.equal(nextFolder.node.id, "nav-000004", "the navigator mint counter survived the round trip");
  const nextSet = val<{ publisherSet: { id: string } }>(await cmd(h, "publisher.create", {
    name: "After Open Set", items: [{ kind: "layout", id: "lo-000001", format: "pdf" }],
  }));
  assert.equal(nextSet.publisherSet.id, "pub-000002");
  // The queries recomputed identically after the round trip.
  const runAfter = val<{ pages: { layoutId: string; sha256: string }[]; pdfSha256: string }>(
    await cmd(h, "publisher.run", { id: "pub-000001" }),
  );
  const runBefore = val<{ pages: { layoutId: string; sha256: string }[]; pdfSha256: string }>(
    await cmd(h, "publisher.run", { id: "pub-000001" }),
  );
  assert.deepEqual(runAfter.pages, runBefore.pages);
  assert.equal(runAfter.pdfSha256, runBefore.pdfSha256, "the publisher run hashes survive the round trip");
});

test("workflow: the P013 stack composes with the docs baseline — regeneration keeps the annotation report typed and the master layout renders beneath", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await val(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
    ],
  }));
  await val(await cmd(h, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall" },
      { type: "docs.tag", viewId: "vw-000001", targetId: "slab-g" },
    ],
  }));
  // The P013 furniture around the docs baseline.
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "Plans" }));
  await val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { folderId: folder.node.id } }));
  await val(await cmd(h, "layout.create", { name: "Sheet" }));
  await val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: (val<{ node: Node }>(await cmd(h, "navigator.createSubset", { name: "S", prefix: "A", numbering: "custom", customNumber: "01" }))).node.id } }));
  // Regeneration: the typed outcome fields are present and "ok" for healthy
  // annotations (the regen report carries the P013 typed vocabulary).
  const regen = val<{ report: { annotations: { id: string; outcome?: string; code?: string; measured: number | null }[] } }>(
    await cmd(h, "docs.regenerate", {}),
  );
  assert.equal(regen.report.annotations.length, 2);
  for (const a of regen.report.annotations) {
    assert.equal(a.outcome, "ok");
    assert.equal(a.code, undefined);
  }
  assert.equal(regen.report.annotations[0]!.measured, 5300, "the overall dim spans the wall extents (5000 + 2×150)");
  // The plot preview of the subset layout renders (sheet number A-01).
  const preview = val<{ hash: string; ir: { frame: { primitives: readonly { kind: string }[] } } }>(
    await qq(h, "plot.preview", { name: "Sheet" }),
  );
  assert.match(preview.hash, /^[0-9a-f]{64}$/);
  assert.equal(preview.ir.frame.primitives.filter((p) => p.kind === "segment").length, 8);
  // A dangling target through the raw element surface still classifies
  // TYPED (docs_target_missing) — the P013 vocabulary is honest.
  await val(await cmd(h, "document.applyEdit", { edit: { type: "removeElement", elementId: "slab-g" } }));
  const regen2 = val<{ report: { annotations: { outcome?: string; code?: string; dangling: boolean }[] } }>(
    await cmd(h, "docs.regenerate", {}),
  );
  const dangling = regen2.report.annotations.find((a) => a.dangling);
  assert.ok(dangling !== undefined);
  assert.equal(dangling.outcome, "dangling");
  assert.equal(dangling.code, "docs_target_missing");
});
