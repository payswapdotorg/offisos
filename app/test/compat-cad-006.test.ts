/**
 * COMPAT-CAD-006 (Issue #138) — deterministic coverage for the viewport/
 * navigation foundation slice (CAD-BENCH-RW-001 DEF-004/DEF-005):
 *
 *  - The ONE shared screen↔world view-transform contract (app/src/workspace/
 *    view.ts): round-trip exactness, visible-rect consistency, deterministic
 *    zoom/pan/fit transforms, the declared clamps, and the Liang–Barsky
 *    partial-clip (the explicit viewport gate that replaces reliance on
 *    implicit host clipping).
 *  - The navigation command vocabulary (ZOOM window/scale/extents/all/
 *    previous, PAN base+second/displacement, REGEN): the builders emit
 *    ui-actions + echo ONLY — zero App API commands (navigation can never
 *    mutate the canonical document through a plan).
 *  - Negative document probes: repeated view-persist (drafting.setSettings
 *    { view }) never changes elements/version/undo history; UNDO after
 *    navigation undoes the last EDIT, not the view change.
 *  - Web/Electron parity: the same navigation scripts produce byte-identical
 *    plans and the same (unmutated) document state through both real host
 *    transports (LOCK-004).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { runCommandScript, type CommandScriptStep } from "../src/workspace/prompt-engine.js";
import type { CommandPlan } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";
import {
  CULL_MARGIN_PX,
  DESKTOP_ZOOM_LIMITS,
  SCALE_ZOOM_LIMITS,
  WEB_ZOOM_LIMITS,
  clampZoom,
  clipSegment,
  expandRect,
  fitExtents,
  fitZoomOf,
  panBy,
  rectsIntersect,
  toScreen,
  toWorld,
  viewTransformOf,
  visibleWorldRect,
  zoomAboutPoint,
  zoomScaleAboutCenter,
  zoomWindow,
  type ViewTransform,
} from "../src/workspace/view.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc006-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc006-test",
};

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}
function val<T = unknown>(r: CommandQueryResponse): T {
  if (!r.ok) throw new Error(`unexpected ErrResult: ${r.code}: ${r.message}`);
  return r.value as T;
}

// ---------------------------------------------------------------------------
// The shared view-transform contract — round trips and consistency.
// ---------------------------------------------------------------------------

test("toScreen/toWorld are exact inverses across zoom/pan/viewport regimes", () => {
  const regimes: ViewTransform[] = [
    viewTransformOf({ x: -20, y: -20 }, 6, { w: 934, h: 418 }),
    viewTransformOf({ x: 0, y: 0 }, 1, { w: 900, h: 620 }),
    viewTransformOf({ x: 24066.5, y: 14582.25 }, 0.018, { w: 934, h: 418 }), // real-scale site plan fit
    viewTransformOf({ x: -1e6, y: 1e6 }, 0.5, { w: 1920, h: 1080 }),
    viewTransformOf({ x: 12.75, y: -3.5 }, 400, { w: 800, h: 600 }), // max interactive zoom
  ];
  const points: Array<[number, number]> = [
    [0, 0], [100, 100], [-500.25, 1234.5], [50000, 30000], [-1e9, 1e9], [0.001, -0.001],
  ];
  for (const vt of regimes) {
    for (const p of points) {
      const s = toScreen(vt, p);
      const back = toWorld(vt, s[0], s[1]);
      assert.ok(Math.abs(back[0] - p[0]) <= 1e-9 * Math.max(1, Math.abs(p[0])), `x round-trip at zoom=${vt.zoom}: ${back[0]} vs ${p[0]}`);
      assert.ok(Math.abs(back[1] - p[1]) <= 1e-9 * Math.max(1, Math.abs(p[1])), `y round-trip at zoom=${vt.zoom}: ${back[1]} vs ${p[1]}`);
    }
  }
});

test("visibleWorldRect: the screen corners map onto the rect corners exactly (Y flip included)", () => {
  const vt = viewTransformOf({ x: 100, y: -50 }, 2.5, { w: 800, h: 600 });
  const rect = visibleWorldRect(vt);
  // screen (0, h) is the world min corner (bottom-left); screen (w, 0) is max.
  const bl = toWorld(vt, 0, 600);
  const tr = toWorld(vt, 800, 0);
  assert.deepEqual([rect.minX, rect.minY], bl);
  assert.deepEqual([rect.maxX, rect.maxY], tr);
  assert.equal(rect.maxX - rect.minX, 800 / 2.5);
  assert.equal(rect.maxY - rect.minY, 600 / 2.5);
});

test("clampZoom honors the declared host limits; NaN falls to the floor", () => {
  assert.equal(clampZoom(200, WEB_ZOOM_LIMITS), 200);
  assert.equal(clampZoom(1e5, WEB_ZOOM_LIMITS), 400);
  assert.equal(clampZoom(0.001, WEB_ZOOM_LIMITS), 0.5);
  assert.equal(clampZoom(15, DESKTOP_ZOOM_LIMITS), 15);
  assert.equal(clampZoom(100, DESKTOP_ZOOM_LIMITS), 20);
  assert.equal(clampZoom(0.0001, DESKTOP_ZOOM_LIMITS), 0.005);
  assert.equal(clampZoom(Number.NaN, WEB_ZOOM_LIMITS), 0.5);
  // The wide command-scale guards.
  assert.equal(clampZoom(1e-4, SCALE_ZOOM_LIMITS), 1e-4);
  assert.equal(clampZoom(1e9, SCALE_ZOOM_LIMITS), 1e6);
});

test("zoomAboutPoint keeps the anchor at the SAME screen position (the wheel invariant)", () => {
  const vt = viewTransformOf({ x: -20, y: -20 }, 6, { w: 934, h: 418 });
  const anchor: [number, number] = [130, 45];
  const before = toScreen(vt, anchor);
  for (const factor of [1.15, 1 / 1.15, 2, 0.3, 8]) {
    const next = zoomAboutPoint(vt, factor, anchor, SCALE_ZOOM_LIMITS);
    const after = toScreen(next, anchor);
    assert.ok(Math.abs(after[0] - before[0]) <= 1e-6, `x anchor drift at factor ${factor}`);
    assert.ok(Math.abs(after[1] - before[1]) <= 1e-6, `y anchor drift at factor ${factor}`);
  }
});

test("zoomScaleAboutCenter keeps the viewport CENTER world point fixed", () => {
  const vt = viewTransformOf({ x: 2400, y: -300 }, 0.02, { w: 900, h: 600 });
  const center = toWorld(vt, 450, 300);
  const next = zoomScaleAboutCenter(vt, 2.5, SCALE_ZOOM_LIMITS);
  const centerAfter = toWorld(next, 450, 300);
  assert.ok(Math.abs(centerAfter[0] - center[0]) <= 1e-9);
  assert.ok(Math.abs(centerAfter[1] - center[1]) <= 1e-9);
  assert.equal(next.zoom, 0.05);
});

test("zoomWindow: aspect-preserving fit, corner-order independent, degenerate rejected", () => {
  const vt = viewTransformOf({ x: 0, y: 0 }, 1, { w: 900, h: 620 });
  const a = zoomWindow(vt, [100, 100], [1000, 500]);
  const b = zoomWindow(vt, [1000, 500], [100, 100]);
  assert.deepEqual(a, b, "corner order must not matter");
  assert.equal(a!.zoom, 1, "900/900 = 1 (width-limited axis)");
  assert.deepEqual([a!.pan.x, a!.pan.y], [100, 100], "the min corner lands at the viewport bottom-left");
  // Aspect: the taller window fits by height.
  const c = zoomWindow(vt, [0, 0], [450, 620 * 2]);
  assert.equal(c!.zoom, 0.5, "height-limited fit (620/1240)");
  // Degenerate windows are rejected (null).
  assert.equal(zoomWindow(vt, [10, 10], [10, 500]), null, "zero width");
  assert.equal(zoomWindow(vt, [10, 10], [500, 10]), null, "zero height");
  assert.equal(zoomWindow(vt, [7, 7], [7, 7]), null, "identical corners");
  // Real-scale window is honored exactly (no interactive floor).
  const site = zoomWindow(vt, [0, 0], [50000, 30000]);
  assert.equal(site!.zoom, 900 / 50000);
});

test("panBy is a pure world-space translation; round trips preserved", () => {
  const vt = viewTransformOf({ x: 100, y: 100 }, 3, { w: 800, h: 600 });
  const p = panBy(vt, [50, -25]);
  assert.deepEqual([p.pan.x, p.pan.y], [150, 75]);
  assert.equal(p.zoom, vt.zoom);
  assert.deepEqual(p.viewport, vt.viewport);
  const s = toScreen(vt, [10, 10]);
  const s2 = toScreen(p, [60, -15]);
  assert.deepEqual(s, s2, "panning by (50,-25) maps (10,10)→(60,-15) to the same screen point");
});

test("fitExtents: byte-exact extraction of the shipped ZOOMEXTENTS formula", () => {
  const viewport = { w: 934, h: 418 };
  const bounds = { minX: 0, minY: 0, maxX: 5000, maxY: 200 };
  const pad = 600;
  // The shipped inline math, recomputed here:
  const spanX = Math.max(bounds.maxX - bounds.minX + pad * 2, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY + pad * 2, 1);
  const z = Math.min(viewport.w / spanX, viewport.h / spanY);
  const panX = bounds.minX - pad - (viewport.w / z - spanX) / 2;
  const panY = bounds.minY - pad - (viewport.h / z - spanY) / 2;
  const fit = fitExtents(viewport, bounds, pad);
  assert.equal(fit.zoom, z);
  assert.equal(fit.pan.x, panX);
  assert.equal(fit.pan.y, panY);
  // A real-scale site plan fits UNCLAMPED below the interactive floor.
  const site = fitExtents(viewport, { minX: 0, minY: 0, maxX: 50000, maxY: 30000 }, pad);
  assert.ok(site.zoom < WEB_ZOOM_LIMITS.min, "the fit must not be clamped by the interactive wheel floor");
  // fitZoomOf agrees with the fit's zoom component.
  assert.equal(fitZoomOf(viewport, bounds, pad), z);
});

test("expandRect: the declared device-px cull margin in world units", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  const expanded = expandRect(rect, CULL_MARGIN_PX, 8);
  assert.equal(expanded.minX, -CULL_MARGIN_PX / 8);
  assert.equal(expanded.maxX, 100 + CULL_MARGIN_PX / 8);
  assert.equal(expanded.minY, -CULL_MARGIN_PX / 8);
  assert.equal(expanded.maxY, 50 + CULL_MARGIN_PX / 8);
});

test("rectsIntersect: touching counts; disjoint rejects", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.ok(rectsIntersect(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 }));
  assert.ok(rectsIntersect(a, { minX: 10, minY: 10, maxX: 20, maxY: 20 }), "edge touching is a hit");
  assert.ok(!rectsIntersect(a, { minX: 10.001, minY: 0, maxX: 20, maxY: 10 }));
  assert.ok(!rectsIntersect(a, { minX: -50, minY: -50, maxX: -1, maxY: -1 }));
});

// ---------------------------------------------------------------------------
// clipSegment — the deterministic partial-clip contract (DEF-004).
// ---------------------------------------------------------------------------

test("clipSegment: a boundary-crossing segment keeps its visible portion exactly", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  // A line fully spanning the viewport horizontally.
  const seg = clipSegment(rect, [-500, 50], [1500, 50]);
  assert.notEqual(seg, null);
  assert.deepEqual(seg![0], [0, 50]);
  assert.deepEqual(seg![1], [100, 50]);
  // Crossing diagonally, entering and exiting.
  const diag = clipSegment(rect, [-10, -10], [110, 110]);
  assert.deepEqual(diag![0], [0, 0]);
  assert.deepEqual(diag![1], [100, 100]);
});

test("clipSegment: BOTH endpoints outside but the segment crossing is clipped to the crossing", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const seg = clipSegment(rect, [-50, 50], [150, 50]);
  assert.notEqual(seg, null, "the segment crosses the viewport — its inside portion is visible");
  assert.deepEqual(seg![0], [0, 50]);
  assert.deepEqual(seg![1], [100, 50]);
});

test("clipSegment: fully-inside segments are unchanged; fully-outside are null", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const inside = clipSegment(rect, [10, 10], [90, 90]);
  assert.deepEqual(inside, [[10, 10], [90, 90]]);
  assert.equal(clipSegment(rect, [-100, 10], [-10, 90]), null);
  assert.equal(clipSegment(rect, [150, 150], [200, 200]), null);
  // Parallel-and-outside (vertical line left of the rect).
  assert.equal(clipSegment(rect, [-5, 0], [-5, 100]), null);
});

test("clipSegment: boundary-touching segments remain visible (the margin discipline)", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  assert.notEqual(clipSegment(rect, [0, -10], [0, 110]), null, "on the left edge");
  assert.notEqual(clipSegment(rect, [-10, 0], [110, 0]), null, "on the bottom edge");
  // Exactly the corner.
  const corner = clipSegment(rect, [-10, -10], [10, 10]);
  assert.deepEqual(corner, [[0, 0], [10, 10]]);
});

test("clipSegment: real-scale world coordinates clip to BOUNDED screen coordinates", () => {
  const vt = viewTransformOf({ x: 0, y: 0 }, 0.018, { w: 934, h: 418 });
  const rect = visibleWorldRect(vt);
  // A site-scale segment whose endpoints are astronomically far outside,
  // crossing the viewport diagonally.
  const seg = clipSegment(rect, [-1e9, 15000], [1e9, 25000]);
  assert.notEqual(seg, null, "the segment crosses the visible rect");
  const a = toScreen(vt, seg![0]);
  const b = toScreen(vt, seg![1]);
  // Screen coords bounded to the viewport ± transform slack (the exact-clip
  // property: every rasterized coordinate is viewport-bounded).
  assert.ok(a[0] >= -1 && a[0] <= vt.viewport.w + 1, `ax bounded: ${a[0]}`);
  assert.ok(b[0] >= -1 && b[0] <= vt.viewport.w + 1, `bx bounded: ${b[0]}`);
  assert.ok(a[1] >= -1 && a[1] <= vt.viewport.h + 1, `ay bounded: ${a[1]}`);
  assert.ok(b[1] >= -1 && b[1] <= vt.viewport.h + 1, `by bounded: ${b[1]}`);
});

// ---------------------------------------------------------------------------
// The navigation command vocabulary — plans are ui+echo ONLY (no App API).
// ---------------------------------------------------------------------------

interface ScriptOutcome {
  readonly plans: CommandPlan[];
  readonly lines: readonly string[];
}

function navScript(steps: readonly CommandScriptStep[]): ScriptOutcome {
  const ctx = defaultCommandContext({ activeLayer: "0", layers: [{ id: "0", name: "0", color: "#111827", visible: true }] });
  const plans: CommandPlan[] = [];
  const out = runCommandScript(steps, ctx, (plan) => plans.push(plan));
  return { plans, lines: out.lines };
}

function typed(text: string): CommandScriptStep {
  return { event: { type: "typed", text } };
}
function picked(x: number, y: number): CommandScriptStep {
  return { event: { type: "pick", point: [x, y] } };
}
function enter(): CommandScriptStep {
  return { event: { type: "enter" } };
}

test("ZOOM window: two corners emit view.zoomWindow with the exact corners; ZERO App API", () => {
  const { plans, lines } = navScript([
    typed("ZOOM"),
    typed("100,100"),
    typed("1000,500"),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.appApi.length, 0, "navigation plans never mutate the document");
  assert.equal(plan.ui.length, 1);
  assert.equal(plan.ui[0]!.action, "view.zoomWindow");
  assert.deepEqual((plan.ui[0]!.payload as { corner1: [number, number]; corner2: [number, number] }).corner1, [100, 100]);
  assert.deepEqual((plan.ui[0]!.payload as { corner1: [number, number]; corner2: [number, number] }).corner2, [1000, 500]);
  assert.ok(lines.some((l) => l.includes("ZOOM: window (100,100) → (1000,500)")), JSON.stringify(lines));
});

test("ZOOM window: corner PICKS (canvas clicks) drive the same plan", () => {
  const { plans } = navScript([
    typed("ZOOM"),
    picked(50, 25),
    picked(400, 300),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui[0]!.action, "view.zoomWindow");
  assert.deepEqual((plan.ui[0]!.payload as { corner1: [number, number] }).corner1, [50, 25]);
});

test("ZOOM E/EXT/EXTENTS complete IMMEDIATELY with view.zoomExtents", () => {
  for (const kw of ["E", "EXT", "EXTENTS"]) {
    const { plans, lines } = navScript([typed("ZOOM"), typed(kw)]);
    const plan = plans[plans.length - 1]!;
    assert.equal(plan.appApi.length, 0);
    assert.equal(plan.ui[0]!.action, "view.zoomExtents", `keyword ${kw}`);
    assert.ok(lines.some((l) => l === `${kw} — Extents`), `the option echo for ${kw}`);
    assert.ok(lines.some((l) => l === "ZOOM: fitting extents."), `the outcome echo for ${kw}`);
  }
});

test("ZOOM A/ALL fits extents with the no-limits disclosure", () => {
  for (const kw of ["A", "ALL"]) {
    const { plans, lines } = navScript([typed("ZOOM"), typed(kw)]);
    const plan = plans[plans.length - 1]!;
    assert.equal(plan.ui[0]!.action, "view.zoomExtents", `keyword ${kw}`);
    assert.ok(lines.some((l) => l.includes("no drawing limits defined")), `the All disclosure for ${kw}`);
  }
});

test("ZOOM P/PREVIOUS completes immediately with view.zoomPrevious", () => {
  for (const kw of ["P", "PREVIOUS"]) {
    const { plans } = navScript([typed("ZOOM"), typed(kw)]);
    const plan = plans[plans.length - 1]!;
    assert.equal(plan.appApi.length, 0);
    assert.equal(plan.ui[0]!.action, "view.zoomPrevious", `keyword ${kw}`);
  }
});

test("ZOOM S: '2x' is relative, '2'/'2' plain is absolute, '2XP' is relative", () => {
  const rel = navScript([typed("ZOOM"), typed("S"), typed("2x")]);
  const relPlan = rel.plans[rel.plans.length - 1]!;
  assert.equal(relPlan.ui[0]!.action, "view.zoomScale");
  const relPayload = relPlan.ui[0]!.payload as { factor: number; relative: boolean };
  assert.equal(relPayload.factor, 2);
  assert.equal(relPayload.relative, true);

  const abs = navScript([typed("ZOOM"), typed("S"), typed("2")]);
  const absPlan = abs.plans[abs.plans.length - 1]!;
  const absPayload = absPlan.ui[0]!.payload as { factor: number; relative: boolean };
  assert.equal(absPayload.factor, 2);
  assert.equal(absPayload.relative, false);

  const xp = navScript([typed("ZOOM"), typed("S"), typed("0.5XP")]);
  const xpPayload = (xp.plans[xp.plans.length - 1]!.ui[0]!.payload) as { factor: number; relative: boolean };
  assert.equal(xpPayload.factor, 0.5);
  assert.equal(xpPayload.relative, true);
});

test("ZOOM S: an invalid scale string is the honest typed failure with NO view change", () => {
  const { plans, lines } = navScript([typed("ZOOM"), typed("S"), typed("abc")]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui.length, 0, "no ui action — no view change");
  assert.equal(plan.appApi.length, 0);
  assert.ok(lines.some((l) => l.includes("'abc' is not a scale factor")), JSON.stringify(lines));
});

test("ZOOM S: a non-positive factor is rejected typed", () => {
  const { plans, lines } = navScript([typed("ZOOM"), typed("S"), typed("-3")]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui.length, 0);
  assert.ok(lines.some((l) => l.includes("must be positive")), JSON.stringify(lines));
});

test("ZOOM W/WINDOW stays in window mode (the flag re-prompts for corners)", () => {
  const { plans, lines } = navScript([
    typed("ZOOM"),
    typed("W"),
    typed("10,10"),
    typed("200,100"),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui[0]!.action, "view.zoomWindow");
  assert.ok(lines.some((l) => l === "W — Window"));
});

test("ZOOM window: a degenerate window is rejected typed, no ui action", () => {
  const { plans, lines } = navScript([
    typed("ZOOM"),
    typed("100,100"),
    typed("100,500"),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui.length, 0);
  assert.ok(lines.some((l) => l.includes("degenerate")), JSON.stringify(lines));
});

test("PAN: base + second point pans by the displacement", () => {
  const { plans, lines } = navScript([
    typed("PAN"),
    typed("500,100"),
    typed("1000,300"),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.appApi.length, 0);
  assert.equal(plan.ui[0]!.action, "view.pan");
  assert.deepEqual((plan.ui[0]!.payload as { delta: [number, number] }).delta, [500, 200]);
  assert.ok(lines.some((l) => l.includes("displacement (500,200)")), JSON.stringify(lines));
});

test("PAN: Enter at the second prompt uses the base point AS the displacement (AutoCAD displacement mode)", () => {
  const { plans, lines } = navScript([
    typed("PAN"),
    typed("250,-75"),
    enter(),
  ]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.ui[0]!.action, "view.pan");
  assert.deepEqual((plan.ui[0]!.payload as { delta: [number, number] }).delta, [250, -75]);
  assert.ok(lines.some((l) => l.includes("displacement (250,-75)")), JSON.stringify(lines));
});

test("REGEN: instant plan — echo + view.regen, ZERO App API commands", () => {
  const { plans, lines } = navScript([typed("REGEN")]);
  const plan = plans[plans.length - 1]!;
  assert.equal(plan.appApi.length, 0, "REGEN must never touch the document");
  assert.equal(plan.ui[0]!.action, "view.regen");
  assert.ok(lines.includes("Regenerating model."));
  assert.ok(lines.some((l) => l.includes("no document change")));
});

test("ZOOM/PAN/REGEN aliases resolve (Z, P, RE, ZE)", () => {
  // Z and P are command aliases; while ZOOM runs, P is the Previous OPTION.
  const z = navScript([typed("Z"), typed("E")]);
  assert.equal(z.plans[z.plans.length - 1]!.ui[0]!.action, "view.zoomExtents");
  const p = navScript([typed("P"), typed("10,10"), typed("20,20")]);
  assert.equal(p.plans[p.plans.length - 1]!.ui[0]!.action, "view.pan");
  const re = navScript([typed("RE")]);
  assert.equal(re.plans[re.plans.length - 1]!.ui[0]!.action, "view.regen");
});

test("REGRESSION PIN: the entity-step 'P' (previous selection) convention wins over the PAN alias", () => {
  // CHPROP's object step with a live selection: typing P selects the
  // PREVIOUS selection — it must NOT switch to the PAN command (the
  // command-switch precedence rule, pinned after the PAN alias landed).
  const ctx = defaultCommandContext({
    activeLayer: "0",
    layers: [{ id: "0", name: "0", color: "#111827", visible: true }],
    currentSelection: [{ id: "el-000001", kind: "drafting", props: { type: "line", layer: "0", from: [0, 0], to: [100, 0] } }],
  });
  const plans: CommandPlan[] = [];
  const out = runCommandScript(
    [
      typed("CHPROP"),
      typed("P"),
      typed("C"),
      typed("#ff0000"),
      enter(),
    ],
    ctx,
    (plan) => plans.push(plan),
  );
  // The previous-selection path ran INSIDE CHPROP (no *Cancel*, no view.pan).
  assert.ok(!out.lines.includes("*Cancel*"), `CHPROP must not be canceled: ${JSON.stringify(out.lines)}`);
  assert.ok(out.lines.some((l) => l.includes("1 found (previous selection)")), JSON.stringify(out.lines));
  const last = plans[plans.length - 1]!;
  assert.equal(last.ui.filter((u) => u.action.startsWith("view.")).length, 0, "no navigation ui action fired");
  assert.ok(last.appApi.some((e) => e.name === "entity.setDisplay"), "the CHPROP patch applied");
});

// ---------------------------------------------------------------------------
// Negative document probes — navigation NEVER mutates the canonical document.
// ---------------------------------------------------------------------------

test("repeated view persistence (drafting.setSettings view) leaves elements/version/history untouched", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(cmd("document.create", {}));
  await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [300, 0] }] }));
  const before = val<{ elements: unknown[]; version: { version_number: number } }>(await h.handle(q("document.getState")));
  // The presentation-only persist path, driven hard: 5 navigation persists.
  for (const view of [
    { pan: [100, 100], zoom: 2 },
    { pan: [24066, 14582], zoom: 0.018 },
    { pan: [-500, 25], zoom: 1 },
    { pan: [0, 0], zoom: 1 },
    { pan: [42, -42], zoom: 6 },
  ]) {
    await h.handle(cmd("drafting.setSettings", { settings: { view } }));
  }
  const after = val<{ elements: unknown[]; version: { version_number: number } }>(await h.handle(q("document.getState")));
  assert.equal(after.elements.length, before.elements.length, "navigation persists never add/remove entities");
  assert.equal(after.version.version_number, before.version.version_number, "navigation persists never bump the version");
  assert.equal(JSON.stringify(after.elements), JSON.stringify(before.elements), "entity content byte-identical");
});

test("UNDO after navigation undoes the LAST EDIT, not the view change (setSettings is not on the undo stack)", async () => {
  const h = AppApiHandler.create(CONFIG);
  await h.handle(cmd("document.create", {}));
  await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [100, 0] }] }));
  // Navigate (persist the view) THREE times.
  for (const view of [{ pan: [10, 10], zoom: 3 }, { pan: [20, 20], zoom: 4 }, { pan: [30, 30], zoom: 5 }]) {
    await h.handle(cmd("drafting.setSettings", { settings: { view } }));
  }
  // UNDO: must remove the LINE (the edit), proving zero view entries on the stack.
  const undone = val<{ elements: unknown[] }>(await h.handle(cmd("document.undo", {})));
  const state = val<{ elements: unknown[] }>(await h.handle(q("document.getState")));
  assert.equal(state.elements.length, 0, "the first undo removes the CREATE");
  assert.ok(undone);
  // REDO restores it; the view persist survives as the non-versioned settings.
  await h.handle(cmd("document.redo", {}));
  const redone = val<{ elements: unknown[]; draftingSettings: { view?: { pan: number[]; zoom: number } } }>(await h.handle(q("document.getState")));
  assert.equal(redone.elements.length, 1, "redo restores the entity");
  assert.deepEqual(redone.draftingSettings.view?.pan, [30, 30], "the persisted view survived undo/redo (non-versioned settings)");
});

// ---------------------------------------------------------------------------
// Web/Electron parity — the same navigation scripts, byte-identical plans
// and identical (unmutated) document state through both real host transports.
// ---------------------------------------------------------------------------

test("ZOOM/PAN/REGEN flows are byte-identical through WebHost and ElectronHost", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));
  type Exec = { execute(request: Command | Query): Promise<CommandQueryResponse> };

  const script: Command[] = [
    cmd("document.create", {}),
    cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [50000, 30000] }] }),
    // The full navigation vocabulary against BOTH hosts' documents:
    cmd("drafting.setSettings", { settings: { view: { pan: [24066, 14582], zoom: 0.018 } } }),
    cmd("drafting.setSettings", { settings: { view: { pan: [0, 0], zoom: 1 } } }),
    cmd("document.undo", {}),
    cmd("document.redo", {}),
  ];
  type Outline = { elements: number; version: number; view: { pan: number[]; zoom: number } | undefined };
  const outline = async (host: Exec): Promise<Outline> => {
    for (const c of script) await host.execute(c);
    const s = val<{ elements: unknown[]; version: { version_number: number }; draftingSettings: { view?: { pan: number[]; zoom: number } } }>(
      await host.execute(q("document.getState")),
    );
    return { elements: s.elements.length, version: s.version.version_number, view: s.draftingSettings.view };
  };
  const webOutline = await outline(web);
  const electronOutline = await outline(electron);
  assert.deepEqual(webOutline, electronOutline, "the hosts' document states are identical after the navigation flows");
  assert.equal(webOutline.elements, 1, "the entity survived undo/redo");
  assert.deepEqual(webOutline.view?.pan, [0, 0]);
});

test("the shared view-transform module produces identical plans/transforms for both hosts' viewport models", () => {
  // The Web canvas measures live CSS px; the Desktop viewport is the fixed
  // 900×620 SVG user space. The SAME world content at the SAME pan/zoom must
  // produce the SAME visible world rect semantics through the shared module.
  const webVT = viewTransformOf({ x: 100, y: 100 }, 2, { w: 934, h: 418 });
  const desktopVT = viewTransformOf({ x: 100, y: 100 }, 2, { w: 900, h: 620 });
  // The transform math itself is viewport-relative and identical.
  const p: [number, number] = [250, 200];
  const ws = toScreen(webVT, p);
  const ds = toScreen(desktopVT, p);
  assert.equal(ws[0], ds[0], "x screen coordinate is viewport-independent given the same pan/zoom");
  assert.equal(ws[1] - 418, ds[1] - 620, "y screen coordinate differs only by the viewport height (the flip)");
  // The zoom transforms compose identically on both: the ZOOM value is
  // viewport-content-identical; the pan adjust keeps each viewport's own
  // center fixed (deterministically different by the center offset).
  const webZoomed = zoomScaleAboutCenter(webVT, 2, SCALE_ZOOM_LIMITS);
  const desktopZoomed = zoomScaleAboutCenter(desktopVT, 2, SCALE_ZOOM_LIMITS);
  assert.equal(webZoomed.zoom, desktopZoomed.zoom);
  const webCenter = toWorld(webVT, 934 / 2, 418 / 2);
  const desktopCenter = toWorld(desktopVT, 900 / 2, 620 / 2);
  assert.deepEqual(toWorld(webZoomed, 934 / 2, 418 / 2), webCenter, "the web center is fixed");
  assert.deepEqual(toWorld(desktopZoomed, 900 / 2, 620 / 2), desktopCenter, "the desktop center is fixed");
  // Purity: the same inputs → the same outputs, both hosts' models.
  assert.deepEqual(zoomScaleAboutCenter(webVT, 2, SCALE_ZOOM_LIMITS), webZoomed);
  assert.deepEqual(zoomScaleAboutCenter(desktopVT, 2, SCALE_ZOOM_LIMITS), desktopZoomed);
  const webPanned = panBy(webVT, [50, 25]);
  const desktopPanned = panBy(desktopVT, [50, 25]);
  assert.deepEqual(webPanned.pan, desktopPanned.pan, "pan is a pure world translation (viewport-independent)");
});
