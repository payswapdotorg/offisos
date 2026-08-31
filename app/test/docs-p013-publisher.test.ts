/**
 * CAD-PARITY-013 (Issue #104) — the publisher-set shared core: the
 * pub-NNNNNN records (item targets + the no-duplicate-expansion rule), the
 * NON-VERSIONED publisher.run (book-order expansion, deterministic per-page
 * sha256, the multi-page PDF hash — the plot.publish precedent), the
 * reference gates from layouts/subsets and the typed IFC/documentation
 * exchange report (docs.exchangeReport).
 *
 * Engine-free paths through the dummy bundle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "docs-p013-publisher",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p013-publisher",
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

interface Node { id: string; kind: string; name: string }
interface Page { layoutId: string; layoutName: string; format: string; revisions: string[]; sha256: string }

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p013-publisher-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  }));
}

async function createBook(h: AppApiHandler): Promise<{ subset: { node: Node } }> {
  await val(await cmd(h, "layout.create", { name: "A1" }));
  await val(await cmd(h, "layout.create", { name: "A2" }));
  await val(await cmd(h, "layout.create", { name: "Root 1" }));
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", {
    name: "Structural", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  await val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  await val(await cmd(h, "layout.update", { id: "lo-000002", patch: { subsetId: subset.node.id } }));
  return { subset };
}

test("publisher: sets create with resolved targets; duplicates/unknowns are typed rejections", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { subset } = await createBook(h);
  const created = val<{ publisherSet: { id: string; name: string; items: unknown[] } }>(await cmd(h, "publisher.create", {
    name: "Issue set",
    items: [
      { kind: "subset", id: subset.node.id, format: "pdf" },
      { kind: "layout", id: "lo-000003", format: "pdf" },
    ],
  }));
  assert.equal(created.publisherSet.id, "pub-000001");
  assert.equal(created.publisherSet.items.length, 2);
  // Duplicate name.
  assert.equal(errOf(await cmd(h, "publisher.create", {
    name: "Issue set", items: [{ kind: "layout", id: "lo-000003", format: "pdf" }],
  })).code, "publisher_exists");
  // Unknown layout item.
  assert.equal(errOf(await cmd(h, "publisher.create", {
    name: "X", items: [{ kind: "layout", id: "lo-999999", format: "pdf" }],
  })).code, "publisher_invalid");
  // A folder node is not a subset item target.
  const folder = val<{ node: Node }>(await cmd(h, "navigator.createFolder", { name: "F" }));
  assert.equal(errOf(await cmd(h, "publisher.create", {
    name: "X", items: [{ kind: "subset", id: folder.node.id, format: "pdf" }],
  })).code, "publisher_invalid");
  // The expanded layout list must contain NO duplicate: the subset (A1, A2)
  // overlaps the explicit A1 item.
  const overlap = errOf(await cmd(h, "publisher.create", {
    name: "Y", items: [
      { kind: "subset", id: subset.node.id, format: "pdf" },
      { kind: "layout", id: "lo-000001", format: "svg" },
    ],
  }));
  assert.equal(overlap.code, "publisher_invalid");
  assert.match(overlap.message, /twice/);
});

test("publisher: run expands in book order with per-page sha256 and revision codes; NON-VERSIONED", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { subset } = await createBook(h);
  // A revision carried by A1 (the subset's first layout).
  await val(await cmd(h, "revision.add", { code: "P01", description: "" }));
  await val(await cmd(h, "revision.add", { code: "P02", description: "" }));
  await val(await cmd(h, "layout.update", { id: "lo-000001", patch: { revisionIds: ["rev-000001", "rev-000002"] } }));
  val(await cmd(h, "publisher.create", {
    name: "Issue set",
    items: [
      { kind: "subset", id: subset.node.id, format: "pdf" },
      { kind: "layout", id: "lo-000003", format: "svg" },
    ],
  }));
  const historyBefore = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));

  const run1 = val<{ set: { id: string; name: string }; pages: Page[]; pdfSha256: string; pdfSize: number }>(
    await cmd(h, "publisher.run", { id: "pub-000001" }),
  );
  assert.deepEqual(run1.set, { id: "pub-000001", name: "Issue set" });
  // Book order: the subset's layouts (document order) first, then the
  // explicit root layout.
  assert.deepEqual(run1.pages.map((p) => [p.layoutId, p.layoutName, p.format]), [
    ["lo-000001", "A1", "pdf"],
    ["lo-000002", "A2", "pdf"],
    ["lo-000003", "Root 1", "svg"],
  ]);
  // Revision codes join in record order.
  assert.deepEqual(run1.pages[0]!.revisions, ["P01", "P02"]);
  assert.deepEqual(run1.pages[1]!.revisions, []);
  // Per-page sha256 (svg page → the svg string hash; pdf pages → the
  // canonical IR hash — both 64-hex).
  for (const page of run1.pages) {
    assert.match(page.sha256, /^[0-9a-f]{64}$/);
  }
  // A svg page's sha256 differs from the (canonical IR) pdf page's.
  assert.notEqual(run1.pages[0]!.sha256, run1.pages[2]!.sha256);
  // The multi-page PDF of the pdf-format pages.
  assert.match(run1.pdfSha256, /^[0-9a-f]{64}$/);
  assert.ok(run1.pdfSize > 0);

  // publisher.run records NO revision (the plot.publish precedent).
  const historyAfter = val<{ modelHistory: { revisions: unknown[] } | null }>(await qq(h, "document.getState", {}));
  assert.equal(historyAfter.modelHistory?.revisions.length, historyBefore.modelHistory?.revisions.length);
  // And NO undo entry exists for it: the undo stack top is still the LAST
  // VERSIONED edit (the set create) — undoing removes the SET itself, redo
  // restores it (a run entry would have absorbed the undo as a no-op).
  val(await cmd(h, "document.undo", {}));
  const afterUndo = val<{ publisherSets: unknown[] }>(await qq(h, "publisher.list", {}));
  assert.equal(afterUndo.publisherSets.length, 0, "undo popped the SET create — the run left no undo entry");
  val(await cmd(h, "document.redo", {}));
  const afterRedo = val<{ publisherSets: unknown[] }>(await qq(h, "publisher.list", {}));
  assert.equal(afterRedo.publisherSets.length, 1);

  // The SECOND run is byte-identical (deterministic).
  const run2 = val<{ pages: Page[]; pdfSha256: string; pdfSize: number }>(await cmd(h, "publisher.run", { id: "pub-000001" }));
  assert.deepEqual(run2.pages, run1.pages);
  assert.equal(run2.pdfSha256, run1.pdfSha256);
  assert.equal(run2.pdfSize, run1.pdfSize);

  // A set with no pdf pages: pdfSha256/pdfSize omitted.
  val(await cmd(h, "publisher.create", {
    name: "SVG only", items: [{ kind: "layout", id: "lo-000003", format: "svg" }],
  }));
  const svgRun = val<{ pages: Page[]; pdfSha256?: string; pdfSize?: number }>(await cmd(h, "publisher.run", { id: "pub-000002" }));
  assert.equal(svgRun.pages.length, 1);
  assert.equal(svgRun.pdfSha256, undefined);
  assert.equal(svgRun.pdfSize, undefined);
  // Unknown set / malformed payload.
  assert.equal(errOf(await cmd(h, "publisher.run", { id: "pub-999999" })).code, "publisher_not_found");
  assert.equal(errOf(await cmd(h, "publisher.run", {})).code, "bad_payload");
});

test("publisher: layout/subset removal gates reference the items (no silent cascade)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { subset } = await createBook(h);
  val(await cmd(h, "publisher.create", {
    name: "Set", items: [{ kind: "subset", id: subset.node.id, format: "pdf" }],
  }));
  val(await cmd(h, "publisher.create", {
    name: "Set2", items: [{ kind: "layout", id: "lo-000003", format: "pdf" }],
  }));
  // layout.remove is blocked while a publisher item references the layout.
  const layoutGate = errOf(await cmd(h, "layout.remove", { name: "Root 1" }));
  assert.equal(layoutGate.code, "layout_invalid");
  assert.match(layoutGate.message, /publisher/);
  // removeNavigatorNode is blocked while a subset item references the node
  // (the document gate order is children → views → layouts → publisher, so
  // the layout-subset gate is satisfied first: unassign A1/A2).
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: null } }));
  val(await cmd(h, "layout.update", { id: "lo-000002", patch: { subsetId: null } }));
  const nodeGate = errOf(await cmd(h, "navigator.removeNode", { id: subset.node.id }));
  assert.equal(nodeGate.code, "navigator_in_use");
  assert.match(nodeGate.message, /publisher/);
  // Removing the sets unblocks both.
  val(await cmd(h, "publisher.remove", { id: "pub-000001" }));
  val(await cmd(h, "publisher.remove", { id: "pub-000002" }));
  val(await cmd(h, "navigator.removeNode", { id: subset.node.id }));
  val(await cmd(h, "layout.remove", { name: "Root 1" }));
  assert.equal(errOf(await cmd(h, "publisher.remove", { id: "pub-000001" })).code, "publisher_not_found");
});

test("publisher: list + update (name/items) with the typed codes", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  const { subset } = await createBook(h);
  val(await cmd(h, "publisher.create", {
    name: "Set", items: [{ kind: "subset", id: subset.node.id, format: "pdf" }],
  }));
  const list = val<{ publisherSets: { id: string; name: string; items: { kind: string; id: string; format: string }[] }[] }>(
    await qq(h, "publisher.list", {}),
  );
  assert.deepEqual(list.publisherSets, [
    { id: "pub-000001", name: "Set", items: [{ kind: "subset", id: subset.node.id, format: "pdf" }] },
  ]);
  // Update the name and the items.
  val(await cmd(h, "publisher.update", { id: "pub-000001", patch: { name: "Issue set" } }));
  val(await cmd(h, "publisher.update", {
    id: "pub-000001",
    patch: { items: [{ kind: "layout", id: "lo-000001", format: "plot-ir" }] },
  }));
  const updated = val<{ publisherSets: { name: string; items: { format: string }[] }[] }>(await qq(h, "publisher.list", {}));
  assert.deepEqual(updated.publisherSets[0]!.items.map((i) => i.format), ["plot-ir"]);
  assert.equal(updated.publisherSets[0]!.name, "Issue set");
  // Typed failures.
  assert.equal(errOf(await cmd(h, "publisher.update", { id: "pub-999999", patch: { name: "X" } })).code, "publisher_not_found");
  assert.equal(
    errOf(await cmd(h, "publisher.update", { id: "pub-000001", patch: { items: [{ kind: "layout", id: "lo-999999", format: "pdf" }] } })).code,
    "publisher_invalid",
  );
  // A plot-ir-only run reports the canonical IR page hashes.
  const run = val<{ pages: Page[]; pdfSha256?: string }>(await cmd(h, "publisher.run", { id: "pub-000001" }));
  assert.equal(run.pages.length, 1);
  assert.equal(run.pages[0]!.format, "plot-ir");
  assert.equal(run.pdfSha256, undefined);
  assert.equal(errOf(await cmd(h, "publisher.update", { id: "pub-000001", patch: {} })).code, "bad_payload");
});

test("exchange report: the typed IFC/documentation classification report with current counts", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await val(await cmd(h, "docs.createViews", { views: [{ kind: "plan", title: "P", storyId: "story-gf" }] }));
  await val(await cmd(h, "docs.createSheets", {
    sheets: [{
      title: "S",
      titleBlock: { projectName: "P", sheetTitle: "T", sheetNumber: "A-101" },
      viewPlacements: [{ viewId: "vw-000001", x: 10, y: 10, w: 300, h: 280 }],
    }],
  }));
  const { subset } = await createBook(h);
  await val(await cmd(h, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 20, rowHeightMm: 12,
    rows: [{ label: "Layout", field: "layoutName" }],
  }));
  await val(await cmd(h, "schedule.create", {
    name: "Sch", source: "elements", columns: [{ key: "id", label: "Id" }],
  }));
  await val(await cmd(h, "revision.add", { code: "P01" }));
  val(await cmd(h, "publisher.create", {
    name: "Set", items: [{ kind: "subset", id: subset.node.id, format: "pdf" }],
  }));

  const report = val<{
    contract: string;
    classifications: { concept: string; classification: string; note: string }[];
    counts: Record<string, number>;
  }>(await qq(h, "docs.exchangeReport", {}));
  assert.equal(report.contract, "offisos-docs-exchange/1");
  assert.deepEqual(report.classifications.map((c) => [c.concept, c.classification]), [
    ["model-elements", "exact"],
    ["navigator-structure", "unsupported"],
    ["saved-views", "unsupported"],
    ["sheets", "unsupported"],
    ["layouts", "unsupported"],
    ["title-blocks", "unsupported"],
    ["schedules", "lossy"],
    ["revisions", "unsupported"],
    ["publisher-sets", "unsupported"],
  ]);
  // The classification vocabulary is the ifc/report.ts one.
  for (const c of report.classifications) {
    assert.ok(["exact", "tolerance", "lossy", "unsupported"].includes(c.classification));
    assert.ok(c.note.length > 0);
    assert.ok(!c.note.includes("ICF"), "the IFC typo is fixed");
  }
  // Counts = the CURRENT document tables.
  assert.deepEqual(report.counts, {
    views: 1,
    sheets: 1,
    layouts: 3,
    titleBlocks: 1,
    schedules: 1,
    revisions: 1,
    publisherSets: 1,
    navigatorNodes: 1,
  });
  // Deterministic: two runs identical (a query never mutates).
  const again = val<typeof report>(await qq(h, "docs.exchangeReport", {}));
  assert.deepEqual(again, report);
});
