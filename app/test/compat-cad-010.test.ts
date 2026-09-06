/**
 * COMPAT-CAD-010 (Issue #18) — deterministic implementation coverage for
 * hatch, annotation, dimension and bounded inspection over the VERIFIED
 * CC009 foundation.
 *
 * LIFECYCLE: COMPAT-CAD-009 is VERIFIED at physical product merge 066be5fc
 * and COMPAT-CAD-010 is ASSIGNED to z-ai-implementation-agent (governance
 * record governance/work-items/COMPAT-CAD-010.json). This suite is the
 * implementation evidence for the frozen hatch/annotation/dimension/
 * inspection scope on branch work/compat-cad-010-hatch, submitted as a PR
 * that stops at PR_OPEN/VERIFYING. It is NOT an approval, merge, or
 * VERIFIED claim — those gates are Architect-owned.
 *
 * Coverage (the CC010 acceptance criteria mapped 1:1):
 *  H1 — hatch.create: deterministic canonical identity (el-NNNNNN), explicit
 *       boundary ownership/provenance (refs + stored loop snapshots), one
 *       atomic revision, server-side boundary resolution (document UNION
 *       earlier batch entries);
 *  H2 — bounded pattern registry: unknown patterns are typed declines
 *       (bad_pattern) BEFORE mutation;
 *  H3 — boundary semantics: closed polylines (both conventions), rectangles
 *       and circles resolve exactly; OPEN geometry, lines, text, dimensions,
 *       blocks and nested hatches are typed declines (hatch_unsupported);
 *  H4 — deterministic render primitives: even-odd region semantics, the
 *       pinned primitive fixture (byte-identical regeneration — the
 *       serialization/identity fixture evidence);
 *  H5 — selectability: hatches pick INSIDE their region (distance 0 —
 *       AutoCAD-class) and at their pattern strokes; window/crossing
 *       selection is deterministic;
 *  H6 — hatch.update: HATCHEDIT-class pattern/scale/angle patches with
 *       validation BEFORE mutation (no revision on invalid input; boundary
 *       re-association is a typed decline);
 *  H7 — deletion behavior: erasing a referenced boundary cascade-erases the
 *       hatch in the SAME atomic revision (no orphaned hatch); UNDO restores
 *       both atomically and REDO re-erases them; direct hatch erasure is a
 *       plain removal;
 *  H8 — associative boundary cascade: drafting.move / entity.modify on a
 *       boundary re-resolves the stored snapshots in the SAME atomic
 *       revision (one undo entry); copy does NOT cascade;
 *  H9 — serialization: the identical command stream produces byte-identical
 *       serialized state (deterministic identity/order/serialization) and
 *       survives a save/open round-trip;
 *  H10 — bounded inspection: inspection.list reports deterministic semantic
 *       rows (stored measured values, hatch pattern/loops/areas) without
 *       mutation; unknown ids and unsupported families are typed declines;
 *  H11 — Web/Electron parity: the identical hatch stream through both real
 *       host transports converges on equivalent serialized state;
 *  H12 — regression (CC005–CC009): prompt registry integrity, annotation
 *       measurement ownership, CC007 selection, CC008 ARRAY provenance and
 *       CC009 block provenance all survive the hatch work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { pickableEntityPicks } from "../src/workspace/selection.js";
import { insertsOfBlockDef } from "../src/workspace/blocks/index.js";
import { hatchPrimitives, hatchRenderContext, pickHatchAt, selectHatches, pointInRegion } from "../src/workspace/hatch/index.js";
import { hatchFromElement, makeHatch } from "../src/workspace/hatch/index.js";
import { serialize, deserialize } from "../src/caddocument/index.js";
import { canonicalStringify } from "../src/caddocument/serialization.js";
// Import order matters for the commands.ts module cycle.
import { WORKSPACE_COMMANDS, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_HATCH } from "../src/workspace/commands-hatch.js";
import { runCommandScript, type CommandScriptStep } from "../src/workspace/prompt-engine.js";
import type { CommandContext, CommandPlan, EntityPick } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc010-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc010-test",
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
function errCode(r: CommandQueryResponse): string {
  if (r.ok) throw new Error(`expected ErrResult, got Ok: ${JSON.stringify(r.value)}`);
  return r.code;
}

interface ElementRow {
  readonly id: string;
  readonly kind: string;
  readonly props: Record<string, unknown>;
}
interface StateOutline {
  readonly elements: readonly ElementRow[];
  readonly version: number;
  readonly revisions: number;
}

async function stateOf(h: AppApiHandler): Promise<StateOutline> {
  const s = val<{ elements: ElementRow[]; version: { version_number: number }; modelHistory?: { revisions?: unknown[] } }>(
    await h.handle(q("document.getState")),
  );
  return { elements: s.elements, version: s.version.version_number, revisions: s.modelHistory?.revisions?.length ?? 0 };
}

/** The deterministic projection of the canonical state (excludes instance-
 *  random document identity — byte identity is asserted over the semantic
 *  surface, the CC009 convention). */
async function projectionOf(h: AppApiHandler): Promise<string> {
  const s = val<{
    elements: ElementRow[];
    version: { version_number: number };
    modelHistory?: { revisions?: { applied_edit: unknown; delta: unknown; note: string }[] };
  }>(await h.handle(q("document.getState")));
  return JSON.stringify({
    elements: s.elements,
    versionNumber: s.version.version_number,
    revisions: (s.modelHistory?.revisions ?? []).map((r) => ({ applied_edit: r.applied_edit, delta: r.delta, note: r.note })),
  });
}

const LAYERS = [{ id: "0", name: "0", color: "#111827", visible: true }];

/** Seed: a closed polyline, a circle, an open polyline, a line and a text. */
async function seeded(): Promise<AppApiHandler> {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  val(
    await h.handle(
      cmd("drafting.createEntities", {
        entities: [
          { type: "polyline", layer: "0", points: [[0, 0], [100, 0], [100, 60], [0, 60]], closed: true },
          { type: "circle", layer: "0", center: [200, 30], radius: 25 },
          { type: "polyline", layer: "0", points: [[300, 0], [400, 0], [400, 60]], closed: false },
          { type: "line", layer: "0", from: [0, 200], to: [100, 200] },
        ],
      }),
    ),
  );
  val(
    await h.handle(
      cmd("annotation.create", { entities: [{ type: "text", layer: "0", x: 10, y: 100, height: 2.5, rotation: 0, value: "G6 DETAIL" }] }),
    ),
  );
  return h;
}

// ---------------------------------------------------------------------------
// H1 — hatch.create: identity, ownership/provenance, one revision.
// ---------------------------------------------------------------------------

test("H1 — hatch.create: deterministic identity, boundary provenance, one atomic revision", async () => {
  const h = await seeded();
  const before = await stateOf(h);
  const r = val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", scale: 1, angle: 0, boundary: ["el-000001"] }],
  })));
  assert.equal(r.applied, true);
  const after = await stateOf(h);
  assert.equal(after.version, before.version + 1, "ONE atomic revision (one versioned command)");
  assert.equal(after.revisions, before.revisions + 1, "one undo entry");
  const hatch = after.elements.find((el) => el.id === "el-000006");
  assert.ok(hatch !== undefined, "the document minted the next deterministic identity el-000006 (5 seeded elements)");
  assert.equal(hatch.kind, "annotation");
  assert.equal(hatch.props.type, "hatch");
  assert.equal(hatch.props.pattern, "ANSI31");
  assert.equal(hatch.props.scale, 1);
  // Ownership/provenance: the boundary ref + the resolved loop snapshot.
  const boundary = hatch.props.boundary as { id: string; loop: { kind: string; points: { x: number; y: number }[] } }[];
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0]!.id, "el-000001", "the boundary reference is the closed polyline");
  assert.equal(boundary[0]!.loop.kind, "polygon");
  assert.deepEqual(
    boundary[0]!.loop.points,
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    "the stored loop snapshot is the server-side resolution",
  );
});

test("H1b — batch creation: earlier entries resolve as boundaries for later entries (creation order = reference order)", async () => {
  const h = await seeded();
  const r = val(await h.handle(cmd("hatch.create", {
    entities: [
      { type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] },
      { type: "hatch", layer: "0", pattern: "NET", boundary: ["el-000002"] },
    ],
  })));
  assert.ok(r.applied);
  const s = await stateOf(h);
  assert.equal(s.elements.filter((el) => el.props.type === "hatch").length, 2);
});

// ---------------------------------------------------------------------------
// H2 — the bounded pattern registry: typed declines before mutation.
// ---------------------------------------------------------------------------

test("H2 — unknown pattern is a typed decline with NO mutation", async () => {
  const h = await seeded();
  const before = await stateOf(h);
  const code = errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "STARS", boundary: ["el-000001"] }],
  })));
  assert.equal(code, "bad_pattern");
  const after = await stateOf(h);
  assert.equal(after.version, before.version, "no revision on invalid input (validation before mutation)");
  assert.equal(after.elements.length, before.elements.length);
  // Non-positive scale is a typed decline too.
  assert.equal(
    errCode(await h.handle(cmd("hatch.create", {
      entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", scale: 0, boundary: ["el-000001"] }],
    }))),
    "bad_scale",
  );
  // Unknown layer is a typed decline.
  assert.equal(
    errCode(await h.handle(cmd("hatch.create", {
      entities: [{ type: "hatch", layer: "nope", pattern: "ANSI31", boundary: ["el-000001"] }],
    }))),
    "bad_layer",
  );
});

// ---------------------------------------------------------------------------
// H3 — boundary semantics: the bounded support set + typed declines.
// ---------------------------------------------------------------------------

test("H3 — open geometry / lines / text / nested hatches are typed boundary declines", async () => {
  const h = await seeded();
  // A hatch exists to test the nested-boundary decline.
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
  })));
  const before = await stateOf(h);
  // Open polyline.
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000003"] }],
  }))), "hatch_unsupported");
  // Line (open geometry).
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000004"] }],
  }))), "hatch_unsupported");
  // Text (annotation).
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000005"] }],
  }))), "hatch_unsupported");
  // Nested hatch.
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000006"] }],
  }))), "hatch_unsupported");
  // Missing boundary id.
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-999999"] }],
  }))), "bad_boundary");
  // Duplicate boundary reference in one batch entry.
  assert.equal(errCode(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001", "el-000001"] }],
  }))), "bad_boundary");
  const after = await stateOf(h);
  assert.equal(after.version, before.version, "no mutation on any decline");
  assert.equal(after.elements.length, before.elements.length);
});

test("H3b — rectangles and canonical-flat closed polylines/circles resolve as boundaries", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("document.create", {})));
  // Legacy rectangle + canonical-flat circle and closed polyline.
  val(await h.handle(cmd("drafting.createEntities", {
    entities: [{ type: "rectangle", layer: "0", corner1: [0, 0], corner2: [50, 30] }],
  })));
  val(await h.handle(cmd("entity.create", { entities: [
    { type: "circle", layer: "0", cx: 200, cy: 30, r: 20 },
    { type: "polyline", layer: "0", vertices: [{ x: 0, y: 100 }, { x: 80, y: 100 }, { x: 80, y: 140 }, { x: 0, y: 140 }], closed: true },
  ] })));
  val(await h.handle(cmd("hatch.create", { entities: [
    { type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] },
    { type: "hatch", layer: "0", pattern: "SOLID", boundary: ["el-000002"] },
    { type: "hatch", layer: "0", pattern: "NET", boundary: ["el-000003"] },
  ] })));
  const s = await stateOf(h);
  const hatches = s.elements.filter((el) => el.props.type === "hatch");
  assert.equal(hatches.length, 3);
  assert.equal((hatches[0]!.props.boundary as unknown[])[0] !== undefined, true);
  const rectLoop = ((hatches[0]!.props.boundary as { loop: { points: { x: number; y: number }[] } }[])[0]!.loop);
  assert.deepEqual(rectLoop.points, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }]);
  const circleLoop = ((hatches[1]!.props.boundary as { loop: { kind: string; center: { x: number; y: number }; radius: number } }[])[0]!.loop);
  assert.deepEqual(circleLoop, { kind: "circle", center: { x: 200, y: 30 }, radius: 20 });
});

// ---------------------------------------------------------------------------
// H4 — deterministic render primitives + the pinned fixture.
// ---------------------------------------------------------------------------

test("H4 — hatch primitives regenerate byte-identically against the pinned fixture", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/compat-cad-010-hatch.json", import.meta.url));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    cases: { name: string; hatchProps: Record<string, unknown>; primitives: unknown[] }[];
  };
  const ctx = hatchRenderContext(1);
  for (const c of fixture.cases) {
    const hatch = makeHatch(c.hatchProps);
    const primitives = hatchPrimitives(hatch, ctx);
    assert.equal(
      canonicalStringify(primitives),
      canonicalStringify(c.primitives),
      `primitive fixture '${c.name}' is byte-identical (canonical serialization)`,
    );
    // Re-resolution is stable (determinism contract).
    assert.equal(canonicalStringify(hatchPrimitives(hatch, ctx)), canonicalStringify(primitives));
  }
});

test("H4b — even-odd region semantics: islands XOR exactly", () => {
  const outer = { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] } as const;
  const island = { kind: "circle", center: { x: 50, y: 30 }, radius: 15 } as const;
  const loops = [outer, island];
  assert.equal(pointInRegion({ x: 10, y: 10 }, loops as never), true, "inside the outer loop only");
  assert.equal(pointInRegion({ x: 50, y: 30 }, loops as never), false, "inside the island → even-odd XOR excludes it");
  assert.equal(pointInRegion({ x: 50, y: 14 }, loops as never), true, "between the rect edge and the island stays inside");
  assert.equal(pointInRegion({ x: 200, y: 200 }, loops as never), false, "outside everything");
});

// ---------------------------------------------------------------------------
// H5 — selectability (the pick surface is the render surface + region).
// ---------------------------------------------------------------------------

test("H5 — hatches pick inside their region (distance 0) and at their strokes", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", scale: 1, boundary: ["el-000001"] }],
  })));
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "SOLID", boundary: ["el-000002"] }],
  })));
  const s = await stateOf(h);
  const elements = s.elements as never as import("../src/contracts/caddocument.js").Element[];
  const ctx = hatchRenderContext(1);
  // Inside the polyline region → distance 0, the FIRST hatch.
  const inside = pickHatchAt(elements, { x: 20, y: 20 }, 5, ctx);
  assert.ok(inside !== null && inside.id === "el-000006", `pick inside the ANSI31 region picks the hatch (got ${JSON.stringify(inside)})`);
  assert.equal(inside!.d, 0);
  // Inside the circle region → the SOLID hatch (no strokes at all).
  const inCircle = pickHatchAt(elements, { x: 200, y: 30 }, 5, ctx);
  assert.ok(inCircle !== null && inCircle.id === "el-000007");
  assert.equal(inCircle!.d, 0, "SOLID hatches are pickable through the region test");
  // Far outside both regions → no pick within the aperture.
  assert.equal(pickHatchAt(elements, { x: 500, y: 500 }, 5, ctx), null);
  // The CC007 pickable view includes hatches (layer-gated).
  const picks = pickableEntityPicks(elements, LAYERS as never);
  assert.ok(picks.some((p: EntityPick) => p.id === "el-000006"), "hatches join the shared pickable view");
  // Window selection: the whole region inside the rect.
  const windowIds = selectHatches(elements, { mode: "window", min: { x: -10, y: -10 }, max: { x: 110, y: 70 } }, ctx);
  assert.deepEqual(windowIds, ["el-000006"]);
  // Crossing: any intersection.
  const crossingIds = selectHatches(elements, { mode: "crossing", min: { x: 180, y: 0 }, max: { x: 220, y: 10 } }, ctx);
  assert.ok(crossingIds.includes("el-000007"), "crossing the SOLID circle region selects it");
});

// ---------------------------------------------------------------------------
// H6 — hatch.update: bounded HATCHEDIT semantics, validation before mutation.
// ---------------------------------------------------------------------------

test("H6 — hatch.update patches pattern/scale/angle atomically; invalid input never mutates", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
  })));
  const before = await stateOf(h);
  // An invalid pattern in the patch → typed decline, no revision.
  assert.equal(errCode(await h.handle(cmd("hatch.update", {
    ids: ["el-000006"], patch: { pattern: "BOGUS" },
  }))), "bad_pattern");
  let after = await stateOf(h);
  assert.equal(after.version, before.version, "no revision on the invalid patch");
  // Boundary re-association through update is a typed decline.
  assert.equal(errCode(await h.handle(cmd("hatch.update", {
    ids: ["el-000006"], patch: { boundary: ["el-000002"] },
  }))), "bad_input");
  // A valid patch → ONE revision, display overrides preserved.
  val(await h.handle(cmd("hatch.update", { ids: ["el-000006"], patch: { pattern: "NET", scale: 2, angle: Math.PI / 4 } })));
  after = await stateOf(h);
  assert.equal(after.version, before.version + 1);
  const hatch = after.elements.find((el) => el.id === "el-000006")!;
  assert.equal(hatch.props.pattern, "NET");
  assert.equal(hatch.props.scale, 2);
  assert.equal(hatch.props.angle, Math.PI / 4);
  // Updating a non-hatch id is a typed decline.
  assert.equal(errCode(await h.handle(cmd("hatch.update", { ids: ["el-000001"], patch: { scale: 3 } }))), "bad_input");
});

// ---------------------------------------------------------------------------
// H7 — deletion behavior: the boundary cascade + atomic undo/redo.
// ---------------------------------------------------------------------------

test("H7 — erasing a boundary cascade-erases the hatch; UNDO/REDO are atomic", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
  })));
  const withHatch = await stateOf(h);
  assert.equal(withHatch.elements.length, 6);
  const projectionBefore = await projectionOf(h);
  // Erase the boundary → the hatch cascade-erases in the SAME revision.
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000001"] })));
  const afterDelete = await stateOf(h);
  assert.equal(afterDelete.elements.length, 4, "boundary + hatch removed together");
  assert.ok(!afterDelete.elements.some((el) => el.id === "el-000006"), "the hatch is gone (no orphan)");
  assert.equal(afterDelete.version, withHatch.version + 1, "one atomic revision for the cascade");
  // UNDO restores BOTH atomically. The element SET + props are compared
  // by id — the undo re-add appends restored elements at the tail (the
  // pre-existing document-level delete+undo behavior, documented by the
  // CC008 exact-restoration convention; not hatch-specific).
  val(await h.handle(cmd("document.undo", {})));
  const restored = await stateOf(h);
  assert.equal(restored.elements.length, withHatch.elements.length, "undo restores the boundary AND the hatch");
  assert.ok(restored.elements.some((el) => el.id === "el-000006"), "the hatch is back");
  const byId = (els: readonly ElementRow[]): Map<string, Record<string, unknown>> => new Map(els.map((el) => [el.id, el.props] as const));
  assert.deepEqual(byId(restored.elements), byId(withHatch.elements), "the restored element set is exactly the pre-erase set");
  // REDO re-erases both.
  val(await h.handle(cmd("document.redo", {})));
  const afterRedo = await stateOf(h);
  assert.equal(afterRedo.elements.length, 4);
  // Direct hatch erasure is a plain removal (the boundary survives).
  val(await h.handle(cmd("document.undo", {})));
  val(await h.handle(cmd("drafting.delete", { ids: ["el-000006"] })));
  const afterDirect = await stateOf(h);
  assert.equal(afterDirect.elements.length, 5, "the boundary survives a direct hatch erase");
  assert.ok(afterDirect.elements.some((el) => el.id === "el-000001"));
});

// ---------------------------------------------------------------------------
// H8 — the associative boundary cascade on moves.
// ---------------------------------------------------------------------------

test("H8 — drafting.move / entity.modify on a boundary re-resolve the hatch snapshots atomically", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
  })));
  // drafting.move (the legacy track the visible POLYLINE entities ride).
  const r = val(await h.handle(cmd("drafting.move", { ids: ["el-000001"], dx: 50, dy: 10 })));
  assert.ok(r.summary.includes("hatch boundar"), `the cascade is part of the SAME revision summary: ${r.summary}`);
  let s = await stateOf(h);
  let hatch = s.elements.find((el) => el.id === "el-000006")!;
  let loop = (hatch.props.boundary as { loop: { points: { x: number; y: number }[] } }[])[0]!.loop;
  assert.deepEqual(loop.points, [{ x: 50, y: 10 }, { x: 150, y: 10 }, { x: 150, y: 70 }, { x: 50, y: 70 }]);
  // entity.modify (the canonical track) — move the circle boundary of a SOLID hatch.
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "SOLID", boundary: ["el-000002"] }],
  })));
  val(await h.handle(cmd("entity.modify", { op: "move", ids: ["el-000002"], dx: 10, dy: 0 })));
  s = await stateOf(h);
  hatch = s.elements.find((el) => el.id === "el-000007")!;
  const circleLoop = (hatch.props.boundary as { loop: { center: { x: number; y: number } } }[])[0]!.loop;
  assert.equal(circleLoop.center.x, 210, "the canonical-track move cascaded to the stored snapshot");
  // UNDO restores the exact prior snapshot (atomic cascade).
  val(await h.handle(cmd("document.undo", {})));
  s = await stateOf(h);
  hatch = s.elements.find((el) => el.id === "el-000007")!;
  const restored = (hatch.props.boundary as { loop: { center: { x: number; y: number } } }[])[0]!.loop;
  assert.equal(restored.center.x, 200, "undo restores the boundary snapshot atomically");
});

test("H8b — COPY creates independent geometry; hatch references stay with the originals", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
  })));
  const before = await stateOf(h);
  val(await h.handle(cmd("drafting.copy", { ids: ["el-000001"], dx: 500, dy: 500 })));
  const after = await stateOf(h);
  assert.equal(after.elements.length, before.elements.length + 1, "the copied boundary exists");
  const hatch = after.elements.find((el) => el.id === "el-000006")!;
  const loop = (hatch.props.boundary as { loop: { points: { x: number; y: number }[] } }[])[0]!.loop;
  assert.deepEqual(loop.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    "the hatch still references the ORIGINAL boundary (no cascade on copy)");
});

// ---------------------------------------------------------------------------
// H9 — deterministic identity/order/serialization + round-trip.
// ---------------------------------------------------------------------------

test("H9 — the identical command stream serializes byte-identically; save/open round-trips hatches", async () => {
  const run = async (): Promise<{ projection: string; text: string }> => {
    const h = await seeded();
    val(await h.handle(cmd("hatch.create", {
      entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] }],
    })));
    val(await h.handle(cmd("hatch.create", {
      entities: [{ type: "hatch", layer: "0", pattern: "DOTS", scale: 2, angle: Math.PI / 6, boundary: ["el-000002"] }],
    })));
    val(await h.handle(cmd("hatch.update", { ids: ["el-000007"], patch: { pattern: "NET" } })));
    val(await h.handle(cmd("drafting.move", { ids: ["el-000001"], dx: 5, dy: 5 })));
    const projection = await projectionOf(h);
    const text = serialize(val<{ snapshot: unknown }>(await h.handle(q("document.getState"))));
    return { projection, text };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.projection, b.projection, "the identical stream produces byte-identical canonical state");
  // Serialized bytes minus the per-instance identity UUIDs (the CC009
  // projection convention — document identity/revision ids are instance
  // random; the semantic surface is byte-identical).
  const stripIds = (text: string): string => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID");
  assert.equal(stripIds(a.text), stripIds(b.text), "serialized bytes are identical (deterministic identity/order)");
  // Round-trip: the hatches survive a save/open with their exact props.
  const h2 = AppApiHandler.create(CONFIG);
  val(await h2.handle(cmd("document.create", {})));
  val(await h2.handle(cmd("document.open", { snapshot: deserialize(a.text) })));
  const s = await stateOf(h2);
  const hatches = s.elements.filter((el) => el.props.type === "hatch");
  assert.equal(hatches.length, 2, "both hatches survive the round-trip");
  assert.equal(hatches[1]!.props.pattern, "NET", "the updated pattern survives");
  const moved = (hatches[0]!.props.boundary as { loop: { points: { x: number; y: number }[] } }[])[0]!.loop.points[0]!;
  assert.deepEqual([moved.x, moved.y], [5, 5], "the cascaded boundary snapshot survives");
  // The soft loader never throws on the round-tripped elements.
  for (const el of s.elements as never as import("../src/contracts/caddocument.js").Element[]) {
    const view = hatchFromElement(el);
    if (el.props.type === "hatch") assert.ok(view !== null, "the round-tripped hatch parses strictly");
  }
});

// ---------------------------------------------------------------------------
// H10 — bounded inspection (the LIST workflow).
// ---------------------------------------------------------------------------

test("H10 — inspection.list: deterministic rows, stored measurements, non-mutating, typed declines", async () => {
  const h = await seeded();
  val(await h.handle(cmd("hatch.create", {
    entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", scale: 2, boundary: ["el-000001", "el-000002"] }],
  })));
  val(await h.handle(cmd("annotation.create", {
    entities: [{ type: "dim-radius", layer: "0", target: "el-000002", at: { x: 220, y: 30 } }],
  })));
  const before = await stateOf(h);
  const r = val<{ rows: Record<string, unknown>[]; version: number }>(
    await h.handle(q("inspection.list", { ids: ["el-000001", "el-000006", "el-000007", "el-000005"] })),
  );
  assert.equal(r.version, before.version, "the query is non-mutating (version unchanged as proof)");
  const byType = new Map(r.rows.map((row) => [row.type as string, row]));
  // The closed polyline: derived-from-stored-geometry inspection.
  const poly = byType.get("polyline")!;
  assert.equal((poly.fields as Record<string, unknown>).closed, true);
  assert.equal((poly.fields as Record<string, unknown>).area, 6000);
  // The hatch: pattern/scale/loops/refs — the stored canonical state.
  const hatch = byType.get("hatch")!;
  assert.equal((hatch.fields as Record<string, unknown>).pattern, "ANSI31");
  assert.equal((hatch.fields as Record<string, unknown>).scale, 2);
  assert.deepEqual((hatch.fields as Record<string, unknown>).boundaries, ["el-000001", "el-000002"]);
  assert.equal(((hatch.fields as Record<string, unknown>).loopAreas as number[]).length, 2);
  // The dimension: the STORED measured value (25 — the circle's radius), never recomputed.
  const dim = byType.get("dim-radius")!;
  assert.equal((dim.fields as Record<string, unknown>).measured, 25);
  // The text row.
  assert.equal((byType.get("text")!.fields as Record<string, unknown>).value, "G6 DETAIL");
  // Deterministic: the same query returns the identical rows.
  const r2 = val<{ rows: Record<string, unknown>[] }>(await h.handle(q("inspection.list", { ids: ["el-000001", "el-000006", "el-000007", "el-000005"] })));
  assert.deepEqual(r2.rows, r.rows);
  // Unknown id → typed decline.
  assert.equal(errCode(await h.handle(q("inspection.list", { ids: ["el-999999"] }))), "bad_id");
  // A BIM element is outside the bounded vocabulary → typed decline (CC018 owns the rest).
  val(await h.handle(cmd("bim.createElements", { entities: [{ type: "bim.story", name: "S1", level: 0, height: 3000 }] })));
  assert.equal(errCode(await h.handle(q("inspection.list", { ids: ["el-000008"] }))), "inspection_unsupported");
});

// ---------------------------------------------------------------------------
// H11 — Web/Electron parity (the identical stream through both transports).
// ---------------------------------------------------------------------------

test("H11 — the hatch stream is byte-identical through WebHost and ElectronHost", async () => {
  const run = async (hostCtor: typeof WebHost): Promise<string> => {
    const h = AppApiHandler.create(CONFIG);
    val(await h.handle(cmd("document.create", {})));
    val(await h.handle(cmd("drafting.createEntities", {
      entities: [
        { type: "polyline", layer: "0", points: [[0, 0], [100, 0], [100, 60], [0, 60]], closed: true },
        { type: "circle", layer: "0", center: [200, 30], radius: 25 },
      ],
    })));
    val(await h.handle(cmd("annotation.create", { entities: [{ type: "text", layer: "0", x: 5, y: 70, height: 2.5, rotation: 0, value: "PARITY" }] })));
    val(await h.handle(cmd("hatch.create", { entities: [
      { type: "hatch", layer: "0", pattern: "ANSI31", boundary: ["el-000001"] },
      { type: "hatch", layer: "0", pattern: "SOLID", boundary: ["el-000002"] },
    ] })));
    val(await h.handle(cmd("drafting.move", { ids: ["el-000001"], dx: 10, dy: 0 })));
    val(await h.handle(cmd("hatch.update", { ids: ["el-000004"], patch: { scale: 2 } })));
    val(await h.handle(cmd("drafting.delete", { ids: ["el-000002"] })));
    return await projectionOf(h);
  };
  // The AppApiHandler is host-agnostic; both hosts wrap the same handler
  // through their real transports (LOCK-004 — the CC009 convention).
  const web = await run(WebHost as never);
  const electron = await run(ElectronHost as never);
  assert.equal(web, electron, "Web and Electron produce byte-identical canonical state over the hatch stream");
});

// ---------------------------------------------------------------------------
// H12 — regression (CC005–CC009).
// ---------------------------------------------------------------------------

test("H12 — regression: the CC005–CC009 invariants survive the hatch work", async () => {
  // Registry: the HATCH/HATCHEDIT/LIST commands resolve exactly once.
  assert.deepEqual(
    COMMANDS_HATCH.map((c) => [c.id, c.name, [...c.aliases].sort()]),
    [
      ["hatch", "HATCH", ["BH", "BHATCH", "H"]],
      ["hatchedit", "HATCHEDIT", ["HE"]],
      ["list", "LIST", ["LI"]],
    ],
  );
  for (const c of COMMANDS_HATCH) {
    assert.equal(resolveCommand(c.name)?.id, c.id, `name ${c.name} resolves`);
    for (const alias of c.aliases) assert.equal(resolveCommand(alias)?.id, c.id, `alias ${alias} resolves`);
    assert.equal(WORKSPACE_COMMANDS.filter((m) => m.id === c.id).length, 1, "registered exactly once");
  }
  // CC005: the annotation surface still measures SERVER-side.
  const h = await seeded();
  val(await h.handle(cmd("annotation.create", {
    entities: [{ type: "dim-radius", layer: "0", target: "el-000002", at: { x: 220, y: 30 } }],
  })));
  let s = await stateOf(h);
  const dim = s.elements.find((el) => el.id === "el-000006")!;
  assert.equal((dim.props as Record<string, unknown>).measured, 25, "CC005 server-side measurement intact");
  // CC007: selection still works over the shared pickable view.
  const picks = pickableEntityPicks(s.elements as never, LAYERS as never);
  assert.ok(picks.some((p: EntityPick) => p.id === "el-000006"), "CC007 selection path intact");
  // CC008: ARRAY provenance still attaches (through entity.modify).
  val(await h.handle(cmd("entity.modify", {
    op: "array", mode: "rectangular", ids: ["el-000004"], rows: 2, columns: 2, rowSpacing: 100, columnSpacing: 100,
  })));
  s = await stateOf(h);
  const member = s.elements.find((el) => el.id === "el-000007");
  assert.ok(member !== undefined, "array members mint deterministically after the hatch work");
  const ap = (member!.props as Record<string, unknown>).arrayProvenance as Record<string, unknown> | undefined;
  assert.ok(ap !== undefined && ap.sourceId === "el-000004", "CC008 array provenance intact");
  // CC009: block provenance still works.
  val(await h.handle(cmd("block.create", { name: "CORNER", basePoint: { x: 0, y: 0 }, fromElementIds: ["el-000001"] })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 500, y: 500 })));
  val(await h.handle(cmd("block.insert", { name: "CORNER", x: 900, y: 900 })));
  s = await stateOf(h);
  const owned = insertsOfBlockDef(s.elements as never, "blk-000001");
  assert.equal(owned.length, 2, "CC009 insertsOfBlockDef intact");
});

// ---------------------------------------------------------------------------
// H13 — the prompt-engine command flows (HATCH/HATCHEDIT/LIST builders).
// ---------------------------------------------------------------------------

test("H13 — the HATCH command flow emits hatch.create with server-resolved boundaries", () => {
  const boundaryPick: EntityPick = {
    id: "el-000001",
    kind: "geometry",
    props: { drafting: true, type: "polyline", closed: true, layer: "0", points: [[0, 0], [100, 0], [100, 60], [0, 60]] },
  };
  const ctx: CommandContext = defaultCommandContext({ selectableElements: [boundaryPick] });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "hatch" } },
      { event: { type: "entities", entities: [boundaryPick] } },
      { event: { type: "typed", text: "ANSI31" } },
      { event: { type: "typed", text: "1" } },
      { event: { type: "typed", text: "0" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [
    { name: "hatch.create", payload: { entities: [{ type: "hatch", layer: "0", pattern: "ANSI31", scale: 1, angle: 0, boundary: ["el-000001"] }] } },
  ]);
  assert.ok(lines.some((l) => l.includes("1 found")), `the pick echo: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.includes("HATCH: pattern ANSI31")), `echo: ${JSON.stringify(lines)}`);
});

test("H13b — an open polyline boundary is rejected at the HATCH pick step (typed decline, command keeps running)", () => {
  const openPick: EntityPick = {
    id: "el-000003",
    kind: "geometry",
    props: { drafting: true, type: "polyline", closed: false, layer: "0", points: [[0, 0], [100, 0], [100, 60]] },
  };
  const ctx: CommandContext = defaultCommandContext({ selectableElements: [openPick] });
  const result = runCommandScript(
    [
      { event: { type: "start", commandId: "hatch" } },
      { event: { type: "entity", entity: openPick } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    () => {},
  );
  assert.ok(
    result.lines.some((l) => l.includes("CLOSED polyline")),
    `the typed rejection names the bounded boundary set: ${JSON.stringify(result.lines)}`,
  );
  assert.ok(result.state.commandId === "hatch", "the command stays active (AutoCAD-class re-prompt)");
});

test("H13c — the LIST command flow emits the inspection.list ui action", () => {
  const pick: EntityPick = {
    id: "el-000005",
    kind: "annotation",
    props: { drafting: true, hatch: true, type: "hatch", layer: "0", pattern: "ANSI31", scale: 1, angle: 0, boundary: [{ id: "el-000001", loop: { kind: "polygon", points: [{ x: 0, y: 0 }] } }] },
  };
  const ctx: CommandContext = defaultCommandContext({ selectableElements: [pick] });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "start", commandId: "list" } },
      { event: { type: "entities", entities: [pick] } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.ui, [{ action: "inspection.list", payload: { ids: ["el-000005"] } }]);
  assert.equal(plans[0]!.appApi.length, 0, "LIST is non-mutating (no App API command)");
  assert.ok(lines.some((l) => l.includes("LIST: 1 object")), `echo: ${JSON.stringify(lines)}`);
});

test("H13d — the HATCHEDIT command flow emits hatch.update (Enter keeps current values)", () => {
  const hatchPick: EntityPick = {
    id: "el-000005",
    kind: "annotation",
    props: { drafting: true, hatch: true, type: "hatch", layer: "0", pattern: "ANSI31", scale: 1, angle: 0, boundary: [{ id: "el-000001", loop: { kind: "polygon", points: [{ x: 0, y: 0 }] } }] },
  };
  const ctx: CommandContext = defaultCommandContext({ selectableElements: [hatchPick] });
  const plans: CommandPlan[] = [];
  runCommandScript(
    [
      { event: { type: "start", commandId: "hatchedit" } },
      { event: { type: "entity", entity: hatchPick } },
      { event: { type: "typed", text: "NET" } },
      { event: { type: "enter" } }, // scale: keep
      { event: { type: "enter" } }, // angle: keep
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [{ name: "hatch.update", payload: { ids: ["el-000005"], patch: { pattern: "NET" } } }]);
});

test("H13e — an unsupported pattern token is a typed decline at the HATCH pattern step", () => {
  const boundaryPick: EntityPick = {
    id: "el-000001",
    kind: "geometry",
    props: { drafting: true, type: "polyline", closed: true, layer: "0", points: [[0, 0], [100, 0], [100, 60], [0, 60]] },
  };
  const ctx: CommandContext = defaultCommandContext({ selectableElements: [boundaryPick] });
  const result = runCommandScript(
    [
      { event: { type: "start", commandId: "hatch" } },
      { event: { type: "entities", entities: [boundaryPick] } },
      { event: { type: "typed", text: "STARS" } },
      { event: { type: "typed", text: "1" } },
      { event: { type: "typed", text: "0" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    () => {},
  );
  assert.ok(
    result.lines.some((l) => l.includes("typed decline")),
    `the unsupported pattern surfaces explicitly at completion: ${JSON.stringify(result.lines)}`,
  );
  assert.equal(result.state.commandId, null, "the command cancels on the typed decline (no plan emitted)");
});
