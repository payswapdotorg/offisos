/**
 * CAD-PARITY-013 (Issue #104) — the Layout Book shared core: master layout
 * composition in the PLOT IR (single-level masters, furniture + title-block
 * placement only), placed title-block rendering (frame/rules/derived text
 * fields incl. the subset custom sheet numbering and the revision join),
 * the reference gates and the byte-identity guarantee for pre-P013
 * layouts.
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
  entityId: "docs-p013-book",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "p013-book",
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

interface PlotIR {
  layout: { id: string; name: string };
  frame: { primitives: readonly Record<string, unknown>[] };
  primitiveCount: number;
}

interface Node { id: string; kind: string; name: string }

async function seed(h: AppApiHandler): Promise<void> {
  await cmd(h, "document.create", { entityId: "p013-book-building" });
  await val(await cmd(h, "bim.createElements", {
    entities: [
      { type: "bim.story", id: "story-gf", name: "Ground Floor", level: 0, height: 3000 },
      { type: "bim.wall", id: "wall-south", storyId: "story-gf", start: [0, 0], end: [6000, 0], width: 300, height: 3000 },
    ],
  }));
}

async function createLayouts(h: AppApiHandler, names: string[]): Promise<void> {
  for (const name of names) {
    await val(await cmd(h, "layout.create", { name }));
  }
}

test("book: master assignment validates (exists, not self, single-level) and composes the IR beneath the layout", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await createLayouts(h, ["Master", "Ground Floor", "First Floor"]);
  // Typed rejections FIRST (no minting, nothing changes).
  const self = errOf(await cmd(h, "layout.update", { id: "lo-000001", patch: { masterId: "lo-000001" } }));
  assert.equal(self.code, "layout_invalid");
  assert.match(self.message, /own master/);
  const missing = errOf(await cmd(h, "layout.update", { id: "lo-000001", patch: { masterId: "lo-999999" } }));
  assert.equal(missing.code, "layout_invalid");
  // A valid assignment.
  val(await cmd(h, "layout.update", { id: "lo-000002", patch: { masterId: "lo-000001" } }));
  // Two-level masters are rejected BOTH ways (master cannot be mastered).
  const twoLevel = errOf(await cmd(h, "layout.update", { id: "lo-000003", patch: { masterId: "lo-000002" } }));
  assert.equal(twoLevel.code, "layout_invalid");
  assert.match(twoLevel.message, /single-level|itself has a master/);
  const masterOfMaster = errOf(await cmd(h, "layout.update", { id: "lo-000001", patch: { masterId: "lo-000003" } }));
  assert.equal(masterOfMaster.code, "layout_invalid");

  // IR composition: the mastered layout renders the master's frame furniture
  // BENEATH its own (master furniture first in the primitive order).
  const masterIR = val<{ ir: PlotIR; hash: string }>(await qq(h, "plot.preview", { name: "Master" }));
  const layoutIR = val<{ ir: PlotIR; hash: string }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  // A3 default: 8 furniture segments (sheet boundary + printable frame).
  const MASTER_FURNITURE = 8;
  assert.equal(masterIR.ir.frame.primitives.length, MASTER_FURNITURE);
  assert.equal(layoutIR.ir.frame.primitives.length, 2 * MASTER_FURNITURE, "the master furniture renders beneath the layout's own");
  // The FIRST 8 primitives are the master's furniture (same construction
  // order); the layout's own furniture follows.
  const first = layoutIR.ir.frame.primitives.slice(0, MASTER_FURNITURE);
  const own = layoutIR.ir.frame.primitives.slice(MASTER_FURNITURE);
  for (const [i, p] of first.entries()) {
    assert.equal(p["kind"], masterIR.ir.frame.primitives[i]!["kind"], `master furniture primitive ${i} mirrors the master IR`);
  }
  for (const [i, p] of own.entries()) {
    assert.equal(p["kind"], masterIR.ir.frame.primitives[i]!["kind"]);
  }
  // The layout's plot policy/sheet stay ITS OWN (master contributes furniture
  // only — never setup): same sheet dims as the unmastered First Floor.
  const plain = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "First Floor" }));
  assert.deepEqual((layoutIR.ir as unknown as { sheet: unknown })["sheet"], (plain.ir as unknown as { sheet: unknown })["sheet"]);
  // Clearing the master restores the plain furniture count (exact inverse).
  val(await cmd(h, "layout.update", { id: "lo-000002", patch: { masterId: null } }));
  const cleared = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  assert.equal(cleared.ir.frame.primitives.length, MASTER_FURNITURE);
});

test("book: layouts WITHOUT P013 fields produce the byte-identical pre-P013 PLOT IR", async () => {
  // Doc A: a plain layout on a document that ALSO carries P013 tables
  // (subsets/title blocks/revisions exist — the inputs flow in but are
  // unread for a layout without master/placement).
  const a = AppApiHandler.create(CONFIG);
  await seed(a);
  await createLayouts(a, ["Plain", "Master"]);
  await val(await cmd(a, "layout.update", { id: "lo-000002", patch: { masterId: "lo-000001" } }));
  const subset = val<{ node: Node }>(await cmd(a, "navigator.createSubset", { name: "S", prefix: "A", numbering: "custom", customNumber: "01" }));
  val(await cmd(a, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  await val(await cmd(a, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 60, rowHeightMm: 12,
    rows: [
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
      { label: "Revisions", field: "revisions" },
    ],
  }));
  await val(await cmd(a, "revision.add", { code: "P01", description: "" }));
  // Doc B: the SAME plain layout with NO P013 state at all.
  const b = AppApiHandler.create(CONFIG);
  await seed(b);
  await createLayouts(b, ["Plain"]);
  const irA = val<{ hash: string }>(await qq(a, "plot.preview", { name: "Plain" }));
  const irB = val<{ hash: string }>(await qq(b, "plot.preview", { name: "Plain" }));
  assert.equal(irA.hash, irB.hash, "identical inputs → identical IR hash (additive fields unread)");
});

test("book: title blocks create/place and render frame + row rules + derived text fields", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await createLayouts(h, ["Ground Floor"]);
  const created = val<{ titleBlock: { id: string; name: string } }>(await cmd(h, "titleblock.create", {
    name: "Standard",
    widthMm: 180,
    heightMm: 72,
    rowHeightMm: 12,
    rows: [
      { label: "Project", field: "text", value: "Offisos Demo" },
      { label: "Layout", field: "layoutName" },
      { label: "Sheet", field: "sheetNumber" },
      { label: "Revisions", field: "revisions" },
      { label: "Author", field: "text", value: "Z" },
      { label: "Date", field: "text", value: "2026-01-01" },
    ],
  }));
  assert.equal(created.titleBlock.id, "tb-000001");
  // Row field grammar: value required iff text; rejected otherwise.
  assert.equal(errOf(await cmd(h, "titleblock.create", {
    name: "Bad", widthMm: 180, heightMm: 24, rowHeightMm: 12,
    rows: [{ label: "L", field: "layoutName", value: "x" }],
  })).code, "titleblock_invalid");
  assert.equal(errOf(await cmd(h, "titleblock.create", {
    name: "Bad2", widthMm: 180, heightMm: 24, rowHeightMm: 12,
    rows: [{ label: "L", field: "text" }],
  })).code, "titleblock_invalid");
  assert.equal(errOf(await cmd(h, "titleblock.create", {
    name: "Bad3", widthMm: 180, heightMm: 12, rowHeightMm: 12, rows: [{ label: "L", field: "layoutName" }],
  })).code, "titleblock_invalid");
  assert.equal(errOf(await cmd(h, "titleblock.create", {
    name: "Standard", widthMm: 180, heightMm: 72, rowHeightMm: 12,
    rows: [{ label: "L", field: "layoutName" }],
  })).code, "titleblock_exists");
  // Place at (10, 10).
  val(await cmd(h, "layout.update", {
    id: "lo-000001",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 10, yMm: 10 } },
  }));
  const preview = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  const frame = preview.ir.frame.primitives;
  // 8 sheet furniture + 4 title-frame segments + 5 row rules + 6 texts = 23.
  assert.equal(frame.length, 8 + 4 + 5 + 6);
  const texts = frame.filter((p) => p["kind"] === "text") as unknown as { value: string; at: { x: number; y: number }; height: number }[];
  assert.deepEqual(
    texts.map((t) => t.value),
    [
      "Project: Offisos Demo",
      "Layout: Ground Floor",
      "Sheet: L01",
      "Revisions: -",
      "Author: Z",
      "Date: 2026-01-01",
    ],
  );
  // Text placement conventions: at the row's left, vertically centered,
  // height = min(4, rowHeight * 0.6).
  for (const t of texts) {
    assert.equal(t.at.x, 10);
    assert.equal(t.height, Math.min(4, 12 * 0.6));
  }
  assert.equal(texts[0]!.at.y, 10 + 72 - 6);
  // The title frame rect: 4 segments spanning (10,10)-(190,82) (endpoints
  // normalized — the construction order is bottom/right/top/left; the rect
  // SPAN is what the placement pins).
  const segments = frame.filter((p) => p["kind"] === "segment") as unknown as { a: { x: number; y: number }; b: { x: number; y: number } }[];
  const titleFrame = segments.slice(8, 12);
  const segKey = (s: { a: { x: number; y: number }; b: { x: number; y: number } }): string => {
    const e1 = `${s.a.x},${s.a.y}`;
    const e2 = `${s.b.x},${s.b.y}`;
    return e1 <= e2 ? `${e1}|${e2}` : `${e2}|${e1}`;
  };
  assert.deepEqual([...titleFrame.map(segKey)].sort(), [
    "10,10|190,10",
    "10,82|190,82",
    "10,10|10,82",
    "190,10|190,82",
  ].sort());
  // Removing the placement restores the plain furniture (exact inverse).
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { titleBlockPlacement: null } }));
  const cleared = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  assert.equal(cleared.ir.frame.primitives.length, 8);
});

test("book: subset custom sheet numbering derives A-01/A-02… and L01…; the title block Sheet field joins it", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await createLayouts(h, ["A1", "A2", "B1"]);
  const subset = val<{ node: Node }>(await cmd(h, "navigator.createSubset", {
    name: "Structural", prefix: "A", numbering: "custom", customNumber: "01",
  }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { subsetId: subset.node.id } }));
  val(await cmd(h, "layout.update", { id: "lo-000002", patch: { subsetId: subset.node.id } }));
  type Book = { layoutBook: { layouts: { name: string; sheetNumber: string }[]; children: { layouts: { name: string; sheetNumber: string }[] }[] } };
  const book = val<Book>(await qq(h, "navigator.tree", {}));
  // Book order inside the custom subset: A-01, A-02 (document order).
  assert.deepEqual(book.layoutBook.children[0]!.layouts.map((l) => [l.name, l.sheetNumber]), [
    ["A1", "A-01"],
    ["A2", "A-02"],
  ]);
  // The subset-less layout numbers among ALL non-custom layouts: L01.
  assert.deepEqual(book.layoutBook.layouts.map((l) => [l.name, l.sheetNumber]), [["B1", "L01"]]);
  // The title block's Sheet field resolves through the SAME derivation.
  await val(await cmd(h, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 24, rowHeightMm: 12,
    rows: [{ label: "Sheet", field: "sheetNumber" }],
  }));
  val(await cmd(h, "layout.update", {
    id: "lo-000001",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 5, yMm: 5 } },
  }));
  const preview = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "A1" }));
  const texts = preview.ir.frame.primitives.filter((p) => p["kind"] === "text") as unknown as { value: string }[];
  assert.deepEqual(texts.map((t) => t.value), ["Sheet: A-01"]);
});

test("book: revisions add/update/remove with unique codes; the layout gate and the title-block Revisions join", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await createLayouts(h, ["Ground Floor", "First Floor"]);
  const rev = val<{ revision: { id: string; code: string; createdAt: string; issued: boolean } }>(
    await cmd(h, "revision.add", { code: "P01", description: "First issue", layoutIds: ["lo-000001"] }),
  );
  assert.equal(rev.revision.id, "rev-000001");
  assert.equal(rev.revision.createdAt, "2026-01-01T00:00:00.000Z", "the FIXED deterministic timestamp — never the wall clock");
  assert.equal(rev.revision.issued, false);
  // Duplicate codes are rejected.
  assert.equal(errOf(await cmd(h, "revision.add", { code: "P01" })).code, "revision_exists");
  // layoutIds must exist.
  assert.equal(
    errOf(await cmd(h, "revision.add", { code: "P02", layoutIds: ["lo-999999"] })).code,
    "revision_invalid",
  );
  // A layout carries the revision through revisionIds (layout.update).
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { revisionIds: ["rev-000001"] } }));
  await val(await cmd(h, "revision.add", { code: "P02", description: "" }));
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { revisionIds: ["rev-000001", "rev-000002"] } }));
  // The title-block Revisions field joins the codes in record order.
  await val(await cmd(h, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 20, rowHeightMm: 12,
    rows: [{ label: "Revisions", field: "revisions" }],
  }));
  val(await cmd(h, "layout.update", {
    id: "lo-000001",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 0, yMm: 0 } },
  }));
  const preview = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  const texts = preview.ir.frame.primitives.filter((p) => p["kind"] === "text") as unknown as { value: string }[];
  assert.deepEqual(texts.map((t) => t.value), ["Revisions: P01,P02"]);
  // revision.update (code kept unique; layoutIds exist).
  val(await cmd(h, "revision.update", { id: "rev-000002", patch: { issued: true } }));
  const listed = val<{ revisions: { code: string; issued: boolean; layoutIds: string[] }[] }>(await qq(h, "revisions.list", {}));
  assert.deepEqual(listed.revisions.map((r) => [r.code, r.issued, r.layoutIds]), [
    ["P01", false, ["lo-000001"]],
    ["P02", true, []],
  ]);
  // The LAYOUT removal gate: a referencing revision blocks layout.remove.
  const gate = errOf(await cmd(h, "layout.remove", { name: "Ground Floor" }));
  assert.equal(gate.code, "layout_invalid");
  assert.match(gate.message, /revision/);
  // revision.remove strips the reference from every referencing layout in the
  // SAME atomic batch (one revision, one undo entry).
  const removed = val<{ removed: string; detachedLayouts: string[] }>(await cmd(h, "revision.remove", { id: "rev-000001" }));
  assert.deepEqual(removed.detachedLayouts, ["lo-000001"]);
  const layoutAfter = val<{ layout: { revisionIds?: string[] } }>(await qq(h, "layouts.list", {}));
  void layoutAfter;
  const previewAfter = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  const textsAfter = previewAfter.ir.frame.primitives.filter((p) => p["kind"] === "text") as unknown as { value: string }[];
  assert.deepEqual(textsAfter.map((t) => t.value), ["Revisions: P02"]);
  // Undo restores BOTH the layout reference and the revision together.
  val(await cmd(h, "document.undo", {}));
  const previewRestored = val<{ ir: PlotIR }>(await qq(h, "plot.preview", { name: "Ground Floor" }));
  const textsRestored = previewRestored.ir.frame.primitives.filter((p) => p["kind"] === "text") as unknown as { value: string }[];
  assert.deepEqual(textsRestored.map((t) => t.value), ["Revisions: P01,P02"]);
  // After the cascade the layout removal works again.
  val(await cmd(h, "revision.remove", { id: "rev-000001" }));
  val(await cmd(h, "revision.remove", { id: "rev-000002" }));
  val(await cmd(h, "layout.remove", { name: "Ground Floor" }));
  assert.equal(errOf(await cmd(h, "revision.remove", { id: "rev-000001" })).code, "revision_not_found");
});

test("book: titleblock.remove is gated by placements; titleblock.update revalidates", async () => {
  const h = AppApiHandler.create(CONFIG);
  await seed(h);
  await createLayouts(h, ["L"]);
  await val(await cmd(h, "titleblock.create", {
    name: "Std", widthMm: 180, heightMm: 20, rowHeightMm: 12,
    rows: [{ label: "Layout", field: "layoutName" }],
  }));
  val(await cmd(h, "layout.update", {
    id: "lo-000001",
    patch: { titleBlockPlacement: { titleBlockId: "tb-000001", xMm: 0, yMm: 0 } },
  }));
  const gate = errOf(await cmd(h, "titleblock.remove", { id: "tb-000001" }));
  assert.equal(gate.code, "titleblock_in_use");
  assert.match(gate.message, /placed on/);
  // Unplace, then remove.
  val(await cmd(h, "layout.update", { id: "lo-000001", patch: { titleBlockPlacement: null } }));
  val(await cmd(h, "titleblock.remove", { id: "tb-000001" }));
  assert.equal(errOf(await cmd(h, "titleblock.remove", { id: "tb-000001" })).code, "titleblock_not_found");
  // update: name uniqueness + full revalidation.
  await val(await cmd(h, "titleblock.create", {
    name: "A", widthMm: 180, heightMm: 20, rowHeightMm: 12,
    rows: [{ label: "Layout", field: "layoutName" }],
  }));
  await val(await cmd(h, "titleblock.create", {
    name: "B", widthMm: 180, heightMm: 20, rowHeightMm: 12,
    rows: [{ label: "Layout", field: "layoutName" }],
  }));
  assert.equal(
    errOf(await cmd(h, "titleblock.update", { id: "tb-000003", patch: { name: "A" } })).code,
    "titleblock_exists",
  );
  assert.equal(
    errOf(await cmd(h, "titleblock.update", { id: "tb-000003", patch: { widthMm: 10 } })).code,
    "titleblock_invalid",
  );
  val(await cmd(h, "titleblock.update", { id: "tb-000003", patch: { name: "B2", rowHeightMm: 12 } }));
  const listed = val<{ layouts: unknown[] }>(await qq(h, "layouts.list", {}));
  void listed;
});
