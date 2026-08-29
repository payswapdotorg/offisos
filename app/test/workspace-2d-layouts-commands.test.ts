/**
 * CAD-PARITY-008 deterministic layout command tests (Issue #88) — the App
 * API layout/viewport/plot surface (create/rename/clone/remove/setPageSetup/
 * activate/setSpace + viewport.create(fit|window|scale)/update/remove +
 * plot.export/plot.publish + the layouts.list/plot.preview queries), the
 * atomicity contract (one command = one revision = one undo entry), the
 * typed declines (viewport_locked, layout_last, plot_unsupported), the
 * deterministic plot exports (byte-identical repeated SVG/PDF) and the
 * prompt-engine flows (LAYOUTNEW→MVIEW→PAGESETUP→PREVIEW→PLOT→PUBLISH with
 * dynamic steps and current-value defaults).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
// Import order matters for the commands.ts module cycle.
import { WORKSPACE_COMMANDS, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_LAYOUTS } from "../src/workspace/commands-layouts.js";
import { runCommandScript, type CommandScriptStep } from "../src/workspace/prompt-engine.js";
import type { CommandContext, CommandPlan } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CADDocumentSnapshot } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";
import { createHash } from "node:crypto";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cp8-e2e",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cad-parity-008-tests",
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

async function drawScene(h: AppApiHandler): Promise<void> {
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 10000, y2: 0 },
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 0, y2: 6000 },
    { type: "circle", layer: "0", cx: 5000, cy: 3000, r: 1500 },
  ] }));
}

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b as never).digest("hex");

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

test("COMMANDS_LAYOUTS: exactly the 14 CAD-PARITY-008 commands with their aliases", () => {
  assert.deepEqual(
    COMMANDS_LAYOUTS.map((c) => [c.id, c.name, [...c.aliases].sort()]),
    [
      ["layout", "LAYOUT", ["LO"]],
      ["layoutnew", "LAYOUTNEW", []],
      ["layoutrename", "LAYOUTRENAME", []],
      ["layoutclone", "LAYOUTCLONE", []],
      ["layoutdelete", "LAYOUTDELETE", []],
      ["tilemode", "TILEMODE", ["TM"]],
      ["mspace", "MSPACE", ["MS"]],
      ["pspace", "PSPACE", ["PS"]],
      ["mview", "MVIEW", ["MV"]],
      ["vports", "VPORTS", []],
      ["pagesetup", "PAGESETUP", []],
      ["preview", "PREVIEW", ["PLOTPREVIEW"]],
      ["plot", "PLOT", []],
      ["publish", "PUBLISH", []],
    ],
  );
  // Merged-registry resolution (the command line surface).
  for (const token of ["LAYOUT", "LO", "LAYOUTNEW", "MVIEW", "MV", "VPORTS", "PAGESETUP", "PREVIEW", "PLOTPREVIEW", "PLOT", "PUBLISH", "TILEMODE", "TM", "MSPACE", "MS", "PSPACE", "PS", "LAYOUTRENAME", "LAYOUTCLONE", "LAYOUTDELETE"]) {
    assert.ok(resolveCommand(token) !== null, `resolveCommand('${token}')`);
  }
  assert.ok(WORKSPACE_COMMANDS.some((c) => c.id === "mview"));
});

// ---------------------------------------------------------------------------
// Layout lifecycle.
// ---------------------------------------------------------------------------

test("layout.create/rename/clone/remove — atomic, typed, with the last-layout rule", async () => {
  const h = make();
  const created = val<{ layoutId: string; name: string }>(await cmd(h, "layout.create", { name: "Sheet-A" }));
  assert.equal(created.layoutId, "lo-000001");
  assert.equal(created.name, "Sheet-A");
  // Duplicate name is a typed rejection.
  assert.equal(errCode(await cmd(h, "layout.create", { name: "Sheet-A" })), "layout_invalid");
  assert.equal(errCode(await cmd(h, "layout.create", { name: "  " })), "bad_payload");
  // Rename keeps names unique; viewports reference the immutable id.
  val(await cmd(h, "layout.create", { name: "Sheet-B" }));
  val(await cmd(h, "layout.rename", { name: "Sheet-B", newName: "Sheet-B2" }));
  assert.equal(errCode(await cmd(h, "layout.rename", { name: "Sheet-B2", newName: "Sheet-A" })), "layout_invalid");
  // Clone: the layout AND its viewports in ONE revision.
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A",
    corner1: [20, 20], corner2: [190, 180],
    view: { mode: "fit" },
  }));
  const before = (await state(h)).modelHistory!.revisions.length;
  const cloned = val<{ layoutId: string; clonedViewports: number }>(await cmd(h, "layout.clone", { name: "Sheet-A", newName: "Copy-A" }));
  assert.equal(cloned.layoutId, "lo-000003");
  assert.equal(cloned.clonedViewports, 1);
  const afterClone = (await state(h)).modelHistory!.revisions.length;
  assert.equal(afterClone, before + 1); // ONE revision for the whole clone
  const s = await state(h);
  assert.equal(s.viewports!.length, 2);
  assert.equal(s.viewports![1]!.layoutId, "lo-000003");
  // Remove: the viewport cascade + record in ONE revision.
  val(await cmd(h, "layout.remove", { name: "Sheet-A" }));
  const afterRemove = await state(h);
  assert.equal(afterRemove.viewports!.length, 1);
  // The last remaining layout rejects.
  val(await cmd(h, "layout.remove", { name: "Sheet-B2" }));
  assert.equal(errCode(await cmd(h, "layout.remove", { name: "Copy-A" })), "layout_last");
});

test("layout.setPageSetup patches + validates; a no-op returns unchanged without a revision", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  const before = (await state(h)).modelHistory!.revisions.length;
  // The SAME values → unchanged: true, NO revision.
  const noop = val<{ unchanged: boolean }>(await cmd(h, "layout.setPageSetup", { name: "Sheet-A", patch: { paperSize: "A3", widthMm: 297, heightMm: 420 } }));
  assert.equal(noop.unchanged, true);
  assert.equal((await state(h)).modelHistory!.revisions.length, before);
  // A real patch (A1 portrait + tighter margins + 1:50).
  const updated = val<{ pageSetup: { paperSize: string; plotScale: string } }>(await cmd(h, "layout.setPageSetup", { name: "Sheet-A", patch: {
    paperSize: "A1", widthMm: 594, heightMm: 841, orientation: "portrait",
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
    plotScale: "1:50",
  } }));
  assert.equal(updated.pageSetup.paperSize, "A1");
  assert.equal(updated.pageSetup.plotScale, "1:50");
  // Invalid grammar is typed.
  assert.equal(errCode(await cmd(h, "layout.setPageSetup", { name: "Sheet-A", patch: { plotScale: "half" } })), "layout_invalid");
  assert.equal(errCode(await cmd(h, "layout.setPageSetup", { name: "Nope", patch: { plotScale: "fit" } })), "bad_id");
});

test("layout.activate / layout.setSpace — the non-versioned editor context", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "layout.create", { name: "Sheet-B" }));
  const before = (await state(h)).modelHistory!.revisions.length;
  const activated = val<{ activeLayoutId: string; space: string }>(await cmd(h, "layout.activate", { name: "Sheet-B" }));
  assert.equal(activated.activeLayoutId, "lo-000002");
  assert.equal(activated.space, "paper");
  // No version bump (editor state, the activeLayer precedent).
  assert.equal((await state(h)).modelHistory!.revisions.length, before);
  // TILEMODE/PSPACE/MSPACE semantics.
  const toModel = val<{ space: string }>(await cmd(h, "layout.setSpace", { space: "model" }));
  assert.equal(toModel.space, "model");
  const toPaper = val<{ space: string; activeLayoutId: string }>(await cmd(h, "layout.setSpace", { space: "paper", name: "Sheet-A" }));
  assert.equal(toPaper.space, "paper");
  assert.equal(toPaper.activeLayoutId, "lo-000001");
  assert.equal(errCode(await cmd(h, "layout.setSpace", { space: "void" })), "bad_payload");
  // The context persists through save/open (acceptance #3: page setup AND
  // context survive).
  const saved = val<{ bytes: number[] }>(await cmd(h, "document.save", {}));
  val(await cmd(h, "document.open", { source: Array.from(saved.bytes as number[]) }));
  const ctx = val<{ space: string; activeLayoutId: string }>(await q(h, "layouts.list", {}));
  assert.equal(ctx.space, "paper");
  assert.equal(ctx.activeLayoutId, "lo-000001");
});

// ---------------------------------------------------------------------------
// Viewports.
// ---------------------------------------------------------------------------

test("viewport.create fit/window/scale — the shared transform, one revision each", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  // FIT: the deterministic model extents (0..10000 × 0..6000; circle top 4500).
  const fit = val<{ viewportId: string; scaleDenominator: number; camera: { centerX: number; centerY: number } }>(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  assert.equal(fit.viewportId, "vp-000001");
  // extents = max(10000/170, 4500/160) = max(58.8235, 28.125) → 58.8235...
  assert.ok(Math.abs(fit.scaleDenominator - 10000 / 170) < 1e-9);
  assert.ok(Math.abs(fit.camera.centerX - 5000) < 1e-9);
  // WINDOW: an explicit model window.
  const win = val<{ scaleDenominator: number }>(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [200, 20], corner2: [300, 120],
    view: { mode: "window", x1: 0, y1: 0, x2: 2000, y2: 1000 },
  }));
  assert.ok(Math.abs(win.scaleDenominator - 20) < 1e-9); // max(2000/100, 1000/100)
  // SCALE: an explicit denominator + center.
  const scaled = val<{ scaleDenominator: number }>(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 190], corner2: [190, 280],
    view: { mode: "scale", denominator: 50, centerX: 5000, centerY: 3000 },
  }));
  assert.equal(scaled.scaleDenominator, 50);
  // Typed failures.
  assert.equal(errCode(await cmd(h, "viewport.create", {
    layoutName: "Nope", corner1: [0, 0], corner2: [10, 10], view: { mode: "fit" },
  })), "bad_id");
  assert.equal(errCode(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [0, 0], corner2: [10, 10], view: { mode: "scale", denominator: -1, centerX: 0, centerY: 0 },
  })), "bad_payload");
  assert.equal(errCode(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [0, 0], corner2: [0, 10], view: { mode: "fit" },
  })), "layout_invalid");
});

test("viewport.update — the display-lock gate (view frozen, frame moves) + layer overrides", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180],
    view: { mode: "scale", denominator: 50, centerX: 5000, centerY: 3000 },
  }));
  val(await cmd(h, "viewport.update", { id: "vp-000001", patch: { locked: true } }));
  // The view is frozen while locked (typed viewport_locked).
  assert.equal(errCode(await cmd(h, "viewport.update", { id: "vp-000001", patch: { scaleDenominator: 100 } })), "viewport_locked");
  assert.equal(errCode(await cmd(h, "viewport.update", { id: "vp-000001", patch: { rotationDeg: 90 } })), "viewport_locked");
  assert.equal(errCode(await cmd(h, "viewport.update", { id: "vp-000001", patch: { camera: { centerX: 0, centerY: 0 } } })), "viewport_locked");
  // The frame still moves (corner resize is allowed).
  val(await cmd(h, "viewport.update", { id: "vp-000001", patch: { corner2: [200, 190] } }));
  // Layer overrides: the VPLAYER surface.
  val(await cmd(h, "viewport.update", { id: "vp-000001", patch: { layerOverrides: [{ layerId: "0", visible: false }] } }));
  assert.equal(errCode(await cmd(h, "viewport.update", { id: "vp-000001", patch: { layerOverrides: [{ layerId: "ly-999" }] } })), "layout_invalid");
  // Unlock → view edits pass again.
  val(await cmd(h, "viewport.update", { id: "vp-000001", patch: { locked: false } }));
  const rescaled = val<{ viewport: { scaleDenominator: number } }>(await cmd(h, "viewport.update", { id: "vp-000001", patch: { scaleDenominator: 100, rotationDeg: 90 } }));
  assert.equal(rescaled.viewport.scaleDenominator, 100);
  assert.equal(errCode(await cmd(h, "viewport.update", { id: "vp-000404", patch: { locked: true } })), "bad_id");
  // Remove.
  val(await cmd(h, "viewport.remove", { id: "vp-000001" }));
  const s = await state(h);
  assert.equal((s.viewports ?? []).length, 0); // canonical-minimal: absent while empty
  assert.equal(s.elements.length, 3); // model geometry untouched
});

// ---------------------------------------------------------------------------
// Plot preview + exports.
// ---------------------------------------------------------------------------

test("plot.preview — the canonical IR + stable hash (non-mutating)", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  const before = (await state(h)).modelHistory!.revisions.length;
  const a = val<{ hash: string; ir: { format: string; viewports: { primitiveCount: number }[]; primitiveCount: number; frame: { primitives: unknown[] } } }>(await q(h, "plot.preview", { name: "Sheet-A" }));
  const b = val<{ hash: string }>(await q(h, "plot.preview", { name: "Sheet-A" }));
  assert.equal(a.hash, b.hash);
  assert.equal(a.ir.format, "offisos-plot-ir");
  assert.equal(a.ir.viewports.length, 1);
  assert.ok(a.ir.viewports[0]!.primitiveCount > 0);
  assert.equal(a.ir.primitiveCount, a.ir.frame.primitives.length + a.ir.viewports.reduce((n, v) => n + v.primitiveCount, 0));
  // Non-mutating.
  assert.equal((await state(h)).modelHistory!.revisions.length, before);
});

test("plot.export — deterministic SVG/PDF/IR with byte-identical repeats; typed declines", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  const svg1 = val<{ sha256: string; text: string }>(await cmd(h, "plot.export", { name: "Sheet-A", format: "svg" }));
  const svg2 = val<{ sha256: string }>(await cmd(h, "plot.export", { name: "Sheet-A", format: "svg" }));
  assert.equal(svg1.sha256, svg2.sha256); // acceptance #5: byte-identical
  assert.equal(sha(svg1.text as string), svg1.sha256);
  assert.ok((svg1.text as string).startsWith("<svg"));
  const pdf1 = val<{ sha256: string }>(await cmd(h, "plot.export", { name: "Sheet-A", format: "pdf" }));
  const pdf2 = val<{ sha256: string }>(await cmd(h, "plot.export", { name: "Sheet-A", format: "pdf" }));
  assert.equal(pdf1.sha256, pdf2.sha256);
  const ir1 = val<{ hash: string; irHash?: string }>(await cmd(h, "plot.export", { name: "Sheet-A", format: "plot-ir" }));
  assert.equal(ir1.hash, ir1.irHash ?? ir1.hash);
  // Typed declines: proprietary formats.
  assert.equal(errCode(await cmd(h, "plot.export", { name: "Sheet-A", format: "dwg" })), "plot_unsupported");
  assert.equal(errCode(await cmd(h, "plot.export", { name: "Nope", format: "svg" })), "bad_id");
});

test("plot.export declines a CTB/STB plot style table (the typed limitation)", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "layout.setPageSetup", { name: "Sheet-A", patch: { plotStyleTable: "monochrome.ctb", plotStyleKind: "ctb" } }));
  assert.equal(errCode(await cmd(h, "plot.export", { name: "Sheet-A", format: "svg" })), "plot_unsupported");
  // Back to as-displayed: plotting proceeds.
  val(await cmd(h, "layout.setPageSetup", { name: "Sheet-A", patch: { plotStyleTable: null, plotStyleKind: "none" } }));
  val(await cmd(h, "plot.export", { name: "Sheet-A", format: "svg" }));
});

test("plot.publish — every layout into ONE deterministic multi-page PDF", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "layout.create", { name: "Sheet-B" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  const published = val<{ pageCount: number; pages: { layoutName: string }[]; sha256: string }>(await cmd(h, "plot.publish", { format: "pdf" }));
  assert.equal(published.pageCount, 2);
  assert.equal(published.pages[0]!.layoutName, "Sheet-A");
  const again = val<{ sha256: string }>(await cmd(h, "plot.publish", { format: "pdf" }));
  assert.equal(published.sha256, again.sha256);
  // The SVG set manifest.
  const svgSet = val<{ pageCount: number; text: string }>(await cmd(h, "plot.publish", { format: "svg" }));
  assert.equal(svgSet.pageCount, 2);
  assert.ok((svgSet.text as string).includes("offisos-plot-svg-set"));
  // A subset by ids.
  const subset = val<{ pageCount: number }>(await cmd(h, "plot.publish", { format: "pdf", layoutIds: ["lo-000001"] }));
  assert.equal(subset.pageCount, 1);
  assert.equal(errCode(await cmd(h, "plot.publish", { format: "dwg" })), "bad_payload");
});

test("layouts.list — the tables + editor context", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  const ctx = val<{ layouts: unknown[]; viewports: unknown[]; activeLayoutId: string; space: string }>(await q(h, "layouts.list", {}));
  assert.equal(ctx.layouts.length, 1);
  assert.equal(ctx.viewports.length, 1);
  assert.equal(ctx.activeLayoutId, "lo-000001");
  assert.equal(ctx.space, "model");
});

test("the atomicity contract: every mutating layout/viewport command is ONE undo entry", async () => {
  const h = make();
  await drawScene(h);
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  val(await cmd(h, "viewport.create", {
    layoutName: "Sheet-A", corner1: [20, 20], corner2: [190, 180], view: { mode: "fit" },
  }));
  val(await cmd(h, "layout.clone", { name: "Sheet-A", newName: "Copy" }));
  const revisionsBefore = (await state(h)).modelHistory!.revisions.length;
  // Undo the clone → the layout AND its viewport go together.
  val(await cmd(h, "document.undo", {}));
  const afterUndo = await state(h);
  assert.equal(afterUndo.layouts!.length, 1);
  assert.equal(afterUndo.viewports!.length, 1);
  assert.equal(afterUndo.modelHistory!.revisions.length, revisionsBefore + 1); // undo is one revision
  // Undo the viewport, undo the layout → empty tables, model intact
  // (canonical-minimal: the tables are ABSENT while empty).
  val(await cmd(h, "document.undo", {}));
  val(await cmd(h, "document.undo", {}));
  const emptied = await state(h);
  assert.equal((emptied.viewports ?? []).length, 0);
  assert.equal((emptied.layouts ?? []).length, 0);
  assert.equal(emptied.elements.length, 3);
});

// ---------------------------------------------------------------------------
// Prompt-engine flows (the command-line semantics both hosts share).
// ---------------------------------------------------------------------------

async function runFlow(
  h: AppApiHandler,
  steps: readonly CommandScriptStep[],
  contextOverrides: Partial<CommandContext> = {},
): Promise<{ executed: string[]; lines: readonly string[] }> {
  const executed: string[] = [];
  const plans: CommandPlan[] = [];
  const ctx = (): CommandContext => defaultCommandContext(contextOverrides);
  const { lines } = runCommandScript(steps, ctx(), (plan) => plans.push(plan));
  for (const plan of plans) {
    for (const entry of plan.appApi) {
      executed.push(entry.name);
      const r = await h.handle({ type: "command", name: entry.name as never, payload: entry.payload });
      assert.equal(r.ok, true, `plan command ${entry.name} failed: ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
  return { executed, lines };
}

/** Context factory mirroring the host shells: the layout tables flow from
 *  the document snapshot (a fresh defaultCommandContext per event). */
async function layoutCtx(h: AppApiHandler): Promise<Partial<CommandContext>> {
  const s = await state(h);
  return {
    layouts: [...(s.layouts ?? [])],
    viewports: [...(s.viewports ?? [])],
    activeLayoutId: s.draftingSettings?.activeLayout ?? s.layouts?.[0]?.id ?? null,
    space: s.draftingSettings?.space ?? "model",
  };
}

test("the LAYOUTNEW→MVIEW→PAGESETUP→PLOT/PUBLISH command stream drives the shared engine", async () => {
  const h = make();
  await drawScene(h);
  // LAYOUTNEW with Enter default (Layout1).
  let flow = await runFlow(h, [
    { event: { type: "start", commandId: "layoutnew" } },
    { event: { type: "enter" } },
  ]);
  assert.deepEqual(flow.executed, ["layout.create", "layout.activate"]);
  // MVIEW: two paper corners + Fit.
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "mview" } },
    { event: { type: "typed", text: "20,20" } },
    { event: { type: "typed", text: "190,180" } },
    { event: { type: "enter" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["viewport.create"]);
  // A second viewport at an explicit 1:100 scale.
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "mview" } },
    { event: { type: "typed", text: "210,20" } },
    { event: { type: "typed", text: "400,180" } },
    { event: { type: "typed", text: "Scale" } },
    { event: { type: "typed", text: "100" } },
    { event: { type: "typed", text: "5000,3000" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["viewport.create"]);
  const ctxNow = await layoutCtx(h);
  assert.equal((ctxNow.viewports ?? []).length, 2);
  assert.equal((ctxNow.viewports ?? [])[1]!.scaleDenominator, 100);
  // PAGESETUP: A2 landscape + 15 mm margins + 1:50 (Enter keeps the rest).
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "pagesetup" } },
    { event: { type: "enter" } }, // layout <active>
    { event: { type: "typed", text: "A2" } },
    { event: { type: "typed", text: "Landscape" } },
    { event: { type: "typed", text: "15" } },
    { event: { type: "typed", text: "1:50" } },
    { event: { type: "enter" } }, // plot style <None>
    { event: { type: "enter" } }, // plot borders <Yes>
  ], ctxNow);
  assert.deepEqual(flow.executed, ["layout.setPageSetup"]);
  const setup = (await layoutCtx(h)).layouts![0]!.pageSetup;
  assert.equal(setup.paperSize, "A2");
  assert.equal(setup.plotScale, "1:50");
  assert.equal(setup.marginsMm.top, 15);
  // TILEMODE 0 → paper space; MSPACE → model; PSPACE → paper.
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "tilemode" } },
    { event: { type: "typed", text: "0" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.setSpace"]);
  flow = await runFlow(h, [{ event: { type: "start", commandId: "mspace" } }], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.setSpace"]);
  flow = await runFlow(h, [{ event: { type: "start", commandId: "pspace" } }], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.setSpace"]);
  // LAYOUTRENAME + LAYOUTCLONE + LAYOUTDELETE.
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "layoutrename" } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "Working" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.rename"]);
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "layoutclone" } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "Working-Copy" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.clone"]);
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "layoutdelete" } },
    { event: { type: "typed", text: "Working-Copy" } },
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["layout.remove"]);
  // PLOT + PUBLISH through the command stream.
  flow = await runFlow(h, [
    { event: { type: "start", commandId: "plot" } },
    { event: { type: "enter" } }, // layout <active>
    { event: { type: "enter" } }, // format <SVG>
  ], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["plot.export"]);
  flow = await runFlow(h, [{ event: { type: "start", commandId: "publish" } }], await layoutCtx(h));
  assert.deepEqual(flow.executed, ["plot.publish"]);
  // PREVIEW is a UI action (no appApi).
  flow = await runFlow(h, [{ event: { type: "start", commandId: "preview" } }], await layoutCtx(h));
  assert.deepEqual(flow.executed, []);
});

test("LAYOUT/VPORTS instant commands echo the inventory + open the palette", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  const ctx = await layoutCtx(h);
  const plans: CommandPlan[] = [];
  runCommandScript([{ event: { type: "start", commandId: "layout" } }], defaultCommandContext(ctx), (plan) => plans.push(plan));
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.ui, [{ action: "palette.show", payload: { palette: "layouts" } }]);
  assert.ok(plans[0]!.echo.some((l) => l.includes("Sheet-A")));
  const vpPlans: CommandPlan[] = [];
  runCommandScript([{ event: { type: "start", commandId: "vports" } }], defaultCommandContext(ctx), (plan) => vpPlans.push(plan));
  assert.ok(vpPlans[0]!.echo.some((l) => l.includes("none — MVIEW places one")));
});

test("the MVIEW dynamic steps reject unknown view modes with an actionable message", async () => {
  const h = make();
  val(await cmd(h, "layout.create", { name: "Sheet-A" }));
  const { lines } = await runFlow(h, [
    { event: { type: "start", commandId: "mview" } },
    { event: { type: "typed", text: "20,20" } },
    { event: { type: "typed", text: "190,180" } },
    { event: { type: "typed", text: "Diagonal" } },
  ], await layoutCtx(h));
  assert.ok(lines.some((l) => l.includes("unknown view mode") || l.includes("Diagonal")), JSON.stringify(lines));
});
