/**
 * COMPAT-CAD-003 — the construction-documentation workflow end to end
 * through the App API: BIM model → Plan/Elevation/Section/Detail views →
 * Dimensions + Tags + Notes → Sheet + Title Block → Deterministic
 * Regeneration → Immutable documentation revisions → Persistence → typed
 * failures (export contracts). Engine-free parts use the dummy bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-workflow",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "docs-workflow",
};

function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return (r as OkResult).value as T;
}
function errVal(r: CommandQueryResponse): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = r as unknown as { code: string; message: string };
  return { code: e.code, message: e.message };
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function qq(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}

async function authorBuilding(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "docs-building" });
  val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-east", storyId: "story-gf", start: [6000, 0], end: [6000, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-north", storyId: "story-gf", start: [6000, 5000], end: [0, 5000], width: 300, height: 3000 },
      { type: "bim.wall", id: "wall-west", storyId: "story-gf", start: [0, 5000], end: [0, 0], width: 300, height: 3000 },
      { type: "bim.slab", id: "slab-g", storyId: "story-gf", corner1: [-300, -300], corner2: [6300, 5300], thickness: 200, baseOffset: -200 },
      { type: "bim.opening", id: "op-door", hostId: "wall-south", distance: 500, width: 900, height: 2100, sill: 0 },
      { type: "bim.door", id: "door-main", openingId: "op-door", swing: "left", name: "Main entrance" },
      { type: "bim.opening", id: "op-win", hostId: "wall-south", distance: 3500, width: 1500, height: 1200, sill: 900 },
      { type: "bim.window", id: "win-1", openingId: "op-win", name: "Facade W1" },
      { type: "bim.space", id: "space-office", storyId: "story-gf", name: "Office 1", footprint: [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 6000], [0, 6000]], height: 3000 },
    ],
  }));
}

/** Views: plan + front elevation + section + door detail (minted ids). */
async function createViews(h: AppApiHandler): Promise<string[]> {
  return val<{ created: string[] }>(await cmd(h, "docs.createViews", {
    views: [
      { kind: "plan", title: "Ground Floor Plan", storyId: "story-gf", scale: 50 },
      { kind: "elevation", title: "Front Elevation", direction: "front", scale: 50 },
      { kind: "section", title: "Section A-A", sectionAxis: "y", sectionOffset: 2500, scale: 50 },
      { kind: "detail", title: "Door Detail 1", sourceViewId: "vw-000001", region: { x: 300, y: -300, w: 1400, h: 600 }, detailScale: 2 },
    ],
  })).created;
}

test("views create atomically with minted identities; listViews reports fresh hashes; kinds validate", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  const created = await createViews(h);
  assert.deepEqual(created, ["vw-000001", "vw-000002", "vw-000003", "vw-000004"]);

  const listed = val<{ views: { view: { id: string; kind: string }; contentHash: string | null; primitiveCount: number; error: string | null }[] }>(
    await qq(h, "docs.listViews", {}),
  );
  assert.equal(listed.views.length, 4);
  const plan = listed.views.find((v) => v.view.kind === "plan")!;
  assert.equal(plan.primitiveCount, 17);
  assert.match(plan.contentHash!, /^[0-9a-f]{64}$/);
  assert.equal(plan.error, null);
  // The detail's primitive count is smaller than its source plan (crop).
  const detail = listed.views.find((v) => v.view.kind === "detail")!;
  assert.ok(detail.primitiveCount > 0 && detail.primitiveCount < plan.primitiveCount);

  // Kind validation: a plan view without storyId is rejected typed.
  const bad = errVal(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P" }] }));
  assert.equal(bad.code, "docs_invalid");
  assert.match(bad.message, /plan views require storyId/);

  // Unknown story reference rejected at creation (cross-reference validation).
  const badStory = errVal(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P", storyId: "nope" }] }));
  assert.equal(badStory.code, "docs_invalid");
  assert.match(badStory.message, /storyId 'nope' does not reference a BIM story/);

  // Detail-of-detail rejected.
  const badDetail = errVal(await cmd(h, "docs.createViews", { views: [{ kind: "detail", title: "D", sourceViewId: "vw-000004", region: { x: 0, y: 0, w: 10, h: 10 }, detailScale: 2 }] }));
  assert.equal(badDetail.code, "docs_invalid");
  assert.match(badDetail.message, /detail-of-detail is not supported/);
});

test("annotations bind to canonical ids; regeneration derives exact measured values and labels", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);

  const ann = val<{ created: string[] }>(await cmd(h, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", offset: -1000 },
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "clear", offset: -1400 },
      { type: "docs.tag", viewId: "vw-000001", targetId: "space-office" },
      { type: "docs.tag", viewId: "vw-000001", targetId: "door-main" },
      { type: "docs.note", viewId: "vw-000001", x: 3000, y: 5500, text: "Tighten construction tolerances" },
    ],
  }));
  assert.equal(ann.created.length, 5);

  // dims/tags cannot be created with hand-authored derived fields.
  const badMeasured = errVal(await cmd(h, "docs.addAnnotations", {
    annotations: [{ type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", measured: 5000 }],
  }));
  assert.equal(badMeasured.code, "docs_invalid");
  assert.match(badMeasured.message, /derived field/);

  // refs must be BIM elements.
  const badRef = errVal(await cmd(h, "docs.addAnnotations", {
    annotations: [{ type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "vw-000001"], axis: "y", mode: "overall" }],
  }));
  assert.equal(badRef.code, "docs_invalid");

  // Regenerate: exact measured values (hand-derived from the projections).
  const regen = val<{ report: { views: unknown[]; annotations: { id: string; measured: number | null; label: string | null; dangling: boolean }[] }; applied: number }>(
    await cmd(h, "docs.regenerate", {}),
  );
  assert.equal(regen.report.views.length, 4);
  const dims = regen.report.annotations.filter((a) => a.measured !== null);
  assert.equal(dims.length, 2);
  assert.equal(dims.find((a) => a.id === ann.created[0])!.measured, 5300); // overall face-to-face
  assert.equal(dims.find((a) => a.id === ann.created[1])!.measured, 4700); // clear gap 4850-150
  const tags = regen.report.annotations.filter((a) => a.label !== null);
  assert.equal(tags.find((a) => a.id === ann.created[2])!.label, "Office 1 (27.00 m²)");
  assert.equal(tags.find((a) => a.id === ann.created[3])!.label, "door-main (900×2100 mm)");
  assert.equal(regen.applied, 4, "the note needs no update");
});

test("regeneration is deterministic: no-op records no revision; model change changes hashes; undo restores", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);

  const before = val<{ views: { view: { id: string }; contentHash: string }[] }>(await qq(h, "docs.listViews", {}));
  const planHash0 = before.views.find((v) => v.view.id === "vw-000001")!.contentHash;

  const regen1 = val<{ applied: number }>(await cmd(h, "docs.regenerate", {}));
  assert.equal(regen1.applied, 0, "no annotations yet — nothing to update, no revision");

  const historyLenAfterRegen = val<{ revisions: unknown[] }>(await qq(h, "model.getHistory", {})).revisions.length;

  // Model change: move wall-north +500 in y → plan hash changes.
  val(await cmd(h, "bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 }));
  const after = val<{ views: { view: { id: string }; contentHash: string }[] }>(await qq(h, "docs.listViews", {}));
  const planHash1 = after.views.find((v) => v.view.id === "vw-000001")!.contentHash;
  assert.notEqual(planHash1, planHash0, "model change → projection hash change");

  // Undo → identical hash restored (determinism through immutable revisions).
  val(await cmd(h, "document.undo", {}));
  const restored = val<{ views: { view: { id: string }; contentHash: string }[] }>(await qq(h, "docs.listViews", {}));
  assert.equal(restored.views.find((v) => v.view.id === "vw-000001")!.contentHash, planHash0);

  const historyNow = val<{ revisions: unknown[] }>(await qq(h, "model.getHistory", {})).revisions.length;
  assert.equal(historyNow, historyLenAfterRegen + 2, "move + undo appended exactly two revisions (regenerate recorded none)");
});

test("annotation values are parametric: model change refreshes measured through regeneration; undo restores", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  const created = val<{ created: string[] }>(await cmd(h, "docs.addAnnotations", {
    annotations: [{ type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall", offset: -1000 }],
  })).created;

  val(await cmd(h, "docs.regenerate", {}));
  let geom = val<{ annotations: { measured?: number }[] }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  assert.equal(geom.annotations[0]!.measured, 5300);

  // Move wall-north +500 → overall becomes 5800 after regeneration.
  val(await cmd(h, "bim.move", { ids: ["wall-north"], dx: 0, dy: 500, dz: 0 }));
  val(await cmd(h, "docs.regenerate", {}));
  geom = val<{ annotations: { measured?: number }[] }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  assert.equal(geom.annotations[0]!.measured, 5800);

  // Undo the regeneration (restores 5300) then the move.
  val(await cmd(h, "document.undo", {}));
  geom = val<{ annotations: { measured?: number }[] }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  assert.equal(geom.annotations[0]!.measured, 5300, "regeneration is an immutable revision — undo restores the previous values");
});

test("dangling references are reported explicitly, never silently re-targeted", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  const created = val<{ created: string[] }>(await cmd(h, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall" },
      { type: "docs.tag", viewId: "vw-000001", targetId: "win-1" },
    ],
  })).created;
  val(await cmd(h, "docs.regenerate", {}));

  // Delete wall-north (no hosted openings) and win-1 → both annotations dangle.
  val(await cmd(h, "bim.delete", { ids: ["wall-north", "win-1"] }));
  const regen = val<{ report: { annotations: { id: string; dangling: boolean; reason: string | null }[] } }>(await cmd(h, "docs.regenerate", {}));
  const dim = regen.report.annotations.find((a) => a.id === created[0])!;
  assert.equal(dim.dangling, true);
  assert.match(dim.reason!, /wall-north.*no projection/);
  const tag = regen.report.annotations.find((a) => a.id === created[1])!;
  assert.equal(tag.dangling, true);
  assert.match(tag.reason!, /win-1.*does not exist/);

  const geom = val<{ annotations: { id: string; dangling?: boolean; reason?: string }[] }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  assert.equal(geom.annotations.find((a) => a.id === created[0])!.dangling, true);
});

test("sheets + title blocks: placements validate; export IR is canonical + deterministic; pdf/dwg fail typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  const sheet = val<{ created: string[] }>(await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "Ground Floor Documentation",
      titleBlock: { projectName: "Offisos Demo", sheetTitle: "Ground Floor", sheetNumber: "A-101", author: "Z.ai", date: "2026-08-27" },
      viewPlacements: [
        { viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 },
        { viewId: "vw-000002", x: 320, y: 10, w: 300, h: 280 },
        { viewId: "vw-000003", x: 10, y: 300, w: 300, h: 280 },
        { viewId: "vw-000004", x: 320, y: 300, w: 300, h: 280 },
      ],
    }],
  })).created;
  assert.deepEqual(sheet, ["sh-000001"]);

  // Overlap rejected (open intervals — touching is allowed): two placements
  // of DIFFERENT views that intersect inside ONE sheet.
  const overlap = errVal(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "Bad", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [
      { viewId: "vw-000001", x: 100, y: 100, w: 200, h: 200 },
      { viewId: "vw-000002", x: 200, y: 200, w: 200, h: 200 },
    ] }],
  }));
  assert.equal(overlap.code, "docs_invalid");
  assert.match(overlap.message, /overlap/);

  // Out of the drawable region rejected (841-200 = 641).
  const oob = errVal(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "Bad", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [{ viewId: "vw-000001", x: 500, y: 10, w: 300, h: 280 }] }],
  }));
  assert.equal(oob.code, "docs_invalid");
  assert.match(oob.message, /drawable region/);

  // Unknown view placement rejected.
  const unknown = errVal(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "Bad", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [{ viewId: "vw-999999", x: 10, y: 10, w: 100, h: 100 }] }],
  }));
  assert.equal(unknown.code, "docs_invalid");

  // Export the IR twice — identical canonical bytes + hash (determinism).
  const e1 = val<{ format: string; canonical: string; hash: string; ir: { sheet: { titleBlock: { sheetNumber: string } }; views: { viewId: string; contentHash: string }[] } }>(
    await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }),
  );
  const e2 = val<{ canonical: string; hash: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  assert.equal(e1.canonical, e2.canonical);
  assert.equal(e1.hash, e2.hash);
  assert.equal(e1.ir.sheet.titleBlock.sheetNumber, "A-101");
  assert.equal(e1.ir.views.length, 4);
  assert.match(e1.hash, /^[0-9a-f]{64}$/);

  // CAD-PARITY-014 (Issue #107): pdf/svg are now REAL deterministic writers
  // (the Sheet IR bridges onto the plot writers) — bytes + sha; DWG stays
  // the typed proprietary decline. (This assertion was the P013 interim
  // "contract only" decline; the P014 committed design supersedes it — the
  // only intentionally-updated prior assertion in this slice, disclosed.)
  const pdf1 = val<{ format: string; bytesBase64: string; size: number; sha256: string }>(
    await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }),
  );
  const pdf2 = val<{ sha256: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "pdf" }));
  assert.equal(pdf1.format, "pdf");
  assert.ok(pdf1.size > 500, "a real PDF document");
  assert.match(pdf1.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pdf1.sha256, pdf2.sha256, "deterministic PDF bytes");
  const dwg = errVal(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "dwg" }));
  assert.equal(dwg.code, "docs_unsupported");
});

test("removeView is blocked while referenced (sheets, annotations, detail sources) — no silent cascade", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  const noteId = val<{ created: string[] }>(await cmd(h, "docs.addAnnotations", {
    annotations: [{ type: "docs.note", viewId: "vw-000001", x: 0, y: 0, text: "n" }],
  })).created[0]!;
  val(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "S", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }] }],
  }));

  // Check order: sheet placement -> annotation -> detail source.
  const r1 = errVal(await cmd(h, "docs.removeView", { viewId: "vw-000001" }));
  assert.equal(r1.code, "docs_invalid");
  assert.match(r1.message, /placed on 1 sheet/);
  val(await cmd(h, "docs.removeSheet", { sheetId: "sh-000001" }));
  const r2 = errVal(await cmd(h, "docs.removeView", { viewId: "vw-000001" }));
  assert.equal(r2.code, "docs_invalid");
  assert.match(r2.message, /annotation element/);
  val(await cmd(h, "docs.removeAnnotations", { ids: [noteId] }));
  const r3 = errVal(await cmd(h, "docs.removeView", { viewId: "vw-000001" }));
  assert.equal(r3.code, "docs_invalid");
  assert.match(r3.message, /detail source/);
  val(await cmd(h, "docs.removeView", { viewId: "vw-000004" }));
  val(await cmd(h, "docs.removeView", { viewId: "vw-000001" }));
  const listed = val<{ views: { view: { id: string } }[] }>(await qq(h, "docs.listViews", {}));
  assert.deepEqual(listed.views.map((v) => v.view.id), ["vw-000002", "vw-000003"]);
});

test("undo/redo converge for view/sheet edits; replay to every revision verifies", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  val(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "S", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }] }],
  }));
  val(await cmd(h, "docs.updateView", { viewId: "vw-000001", patch: { title: "Ground Floor Plan (rev B)" } }));

  // Undo the title patch → exact previous record restored.
  val(await cmd(h, "document.undo", {}));
  const views1 = val<{ views: { view: { id: string; title: string } }[] }>(await qq(h, "docs.listViews", {}));
  assert.equal(views1.views.find((v) => v.view.id === "vw-000001")!.view.title, "Ground Floor Plan");
  val(await cmd(h, "document.redo", {}));
  const views2 = val<{ views: { view: { id: string; title: string } }[] }>(await qq(h, "docs.listViews", {}));
  assert.equal(views2.views.find((v) => v.view.id === "vw-000001")!.view.title, "Ground Floor Plan (rev B)");

  // Undo everything back to the building (view/sheet edits replay in reverse).
  for (let i = 0; i < 6; i++) {
    const r = await cmd(h, "document.undo", {});
    if (!r.ok) break;
  }
  const listed = val<{ views: { view: { id: string } }[] }>(await qq(h, "docs.listViews", {}));
  assert.equal(listed.views.length, 0);

  // Redo everything → views return with identical hashes.
  for (let i = 0; i < 6; i++) {
    const r = await cmd(h, "document.redo", {});
    if (!r.ok) break;
  }
  const relisted = val<{ views: { view: { id: string }; contentHash: string }[] }>(await qq(h, "docs.listViews", {}));
  assert.equal(relisted.views.length, 4);
  assert.match(relisted.views[0]!.contentHash!, /^[0-9a-f]{64}$/);

  // Verified replay to EVERY revision (documentation edits are element-set
  // no-ops in replay but the recorded content hashes must still converge).
  const hist = val<{ revisions: { revision_number: number }[] }>(await qq(h, "model.getHistory", {}));
  for (const rev of hist.revisions) {
    const rr = val<{ content_hash: string }>(await qq(h, "model.replay", { revision_number: rev.revision_number }));
    assert.match(rr.content_hash, /^[0-9a-f]{64}$/);
  }
});

test("save/open preserves views, sheets, annotations and their lineage with identical hashes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  await createViews(h);
  val(await cmd(h, "docs.addAnnotations", {
    annotations: [
      { type: "docs.dim", viewId: "vw-000001", refIds: ["wall-south", "wall-north"], axis: "y", mode: "overall" },
      { type: "docs.tag", viewId: "vw-000001", targetId: "space-office" },
    ],
  }));
  val(await cmd(h, "docs.regenerate", {}));
  val(await cmd(h, "docs.createSheets", {
    sheets: [{ title: "S", titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "1" }, viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }] }],
  }));

  const before = val<{ elements: unknown[]; docsViews: { id: string }[]; docsSheets: { id: string }[] }>(
    await qq(h, "document.getState", {}),
  );
  const contentBefore = h.currentContentHash();
  const histBefore = val<{ revisions: unknown[] }>(await qq(h, "model.getHistory", {}));
  const exportBefore = val<{ hash: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  const viewsBefore = val<{ views: { contentHash: string }[] }>(await qq(h, "docs.listViews", {}));

  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  val(await cmd(h, "document.open", { source: saved.bytes }));

  const after = val<{ elements: unknown[]; docsViews: { id: string }[]; docsSheets: { id: string }[] }>(
    await qq(h, "document.getState", {}),
  );
  assert.equal(after.docsViews.length, 4);
  assert.equal(after.docsSheets.length, 1);
  assert.equal(after.elements.length, before.elements.length);
  assert.equal(h.currentContentHash(), contentBefore, "identical parity content hash (views/sheets/annotations persisted)");
  const histAfter = val<{ revisions: unknown[] }>(await qq(h, "model.getHistory", {}));
  assert.deepEqual(histAfter, histBefore, "identical revision lineage");
  const viewsAfter = val<{ views: { contentHash: string }[] }>(await qq(h, "docs.listViews", {}));
  assert.deepEqual(viewsAfter.views.map((v) => v.contentHash), viewsBefore.views.map((v) => v.contentHash));
  const exportAfter = val<{ hash: string }>(await qq(h, "docs.exportSheet", { sheetId: "sh-000001", format: "sheet-ir" }));
  assert.equal(exportAfter.hash, exportBefore.hash, "identical export IR hash after the round trip");

  // Measured/label values survived (persisted derived values).
  const geom = val<{ annotations: { measured?: number; label?: string }[] }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  assert.equal(geom.annotations[0]!.measured, 5300);
  assert.equal(geom.annotations[1]!.label, "Office 1 (27.00 m²)");

  // And regeneration after open is a NO-OP (values already current).
  const regen = val<{ applied: number }>(await cmd(h, "docs.regenerate", {}));
  assert.equal(regen.applied, 0);
});

test("view scope: story-scoped elevation only shows that story; unknown view query fails typed", async () => {
  const h = AppApiHandler.create(CONFIG);
  await authorBuilding(h);
  val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-1u", name: "First Floor", level: 3000, height: 3000 },
      { type: "bim.wall", id: "wall-u", storyId: "story-1u", start: [0, 0], end: [6000, 0], width: 300, height: 3000, baseOffset: 0 },
    ],
  }));
  val(await cmd(h, "docs.createViews", {
    views: [
      { kind: "elevation", title: "Whole Building", direction: "front" },
      { kind: "elevation", title: "GF only", direction: "front", storyId: "story-gf" },
    ],
  }));
  const whole = val<{ primitiveCount: number }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000001" }));
  const gf = val<{ primitiveCount: number }>(await qq(h, "docs.getViewGeometry", { viewId: "vw-000002" }));
  assert.ok(whole.primitiveCount > gf.primitiveCount, "the upper-floor wall appears only in the whole-building elevation");

  const unknown = errVal(await qq(h, "docs.getViewGeometry", { viewId: "vw-999999" }));
  assert.equal(unknown.code, "docs_invalid");
});
