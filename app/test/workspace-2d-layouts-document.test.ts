/**
 * CAD-PARITY-008 deterministic layout document tests (Issue #88) — the
 * CADDocument layout/viewport tables: lo-/vp-NNNNNN minting (monotonic,
 * never reused), the eight DocumentEdit variants with exact inverses
 * (incl. the key-adding update → full-record restore), undo/redo
 * convergence, the canonical-minimal snapshot/history contract (legacy
 * byte-identity), the reference-checked removal (viewport cascade at the
 * command layer; the last-layout rule), the replay integrity and the
 * open-time validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot, LayoutRecord, ViewportRecord } from "../src/contracts/caddocument.js";
import { DEFAULT_PAGE_SETUP } from "../src/workspace/layouts/paper.js";
import { canonicalStringify, serialize } from "../src/caddocument/serialization.js";
import { verifiedReplay } from "../src/caddocument/history.js";

const NOW = "2026-01-01T00:00:00.000Z";

function empty(): CADDocument {
  return CADDocument.empty("cp8-doc", "offisos-dummy", "1", "cp8-tests");
}

function layout(id: string, name: string): LayoutRecord {
  return { id, name, pageSetup: DEFAULT_PAGE_SETUP, createdAt: NOW };
}

function viewport(id: string, layoutId: string, overrides: Partial<ViewportRecord> = {}): ViewportRecord {
  return {
    id,
    layoutId,
    corner1: [20, 20],
    corner2: [190, 180],
    camera: { centerX: 5000, centerY: 3000 },
    scaleDenominator: 50,
    rotationDeg: 0,
    ...overrides,
  };
}

test("addLayout mints lo-NNNNNN (monotonic, never reused); duplicate ids/names rejected", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000042", "Sheet-A") });
  assert.equal(doc.layoutTable.length, 1);
  assert.equal(doc.layoutById("lo-000042")?.name, "Sheet-A");
  // Empty id mints the first canonical identity (42 was explicit).
  doc.execute({ type: "addLayout", layout: layout("", "Sheet-B") });
  assert.match(doc.layoutTable[1]!.id, /^lo-000001$/);
  // Duplicate id and duplicate name both reject.
  assert.throws(() => doc.execute({ type: "addLayout", layout: layout("lo-000042", "Sheet-C") }));
  assert.throws(() => doc.execute({ type: "addLayout", layout: layout("lo-000002", "Sheet-A") }));
});

test("addLayout validates the record shape (names, page setup) — malformed rejected", () => {
  const doc = empty();
  assert.throws(() => doc.execute({ type: "addLayout", layout: { ...layout("lo-1", ""), createdAt: NOW } as never }));
  assert.throws(() => doc.execute({ type: "addLayout", layout: { ...layout("lo-1", "X"), createdAt: NOW, pageSetup: { ...DEFAULT_PAGE_SETUP, paperSize: "A3", widthMm: 1 } } as never }));
});

test("updateLayout patches name/pageSetup; identity immutable; rename keeps uniqueness", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "First") });
  doc.execute({ type: "addLayout", layout: layout("lo-000002", "Second") });
  doc.execute({ type: "updateLayout", layoutId: "lo-000001", patch: { name: "Renamed" } });
  assert.equal(doc.layoutById("lo-000001")?.name, "Renamed");
  assert.throws(() => doc.execute({ type: "updateLayout", layoutId: "lo-000001", patch: { id: "lo-000099" } }));
  assert.throws(() => doc.execute({ type: "updateLayout", layoutId: "lo-000001", patch: { createdAt: NOW } }));
  assert.throws(() => doc.execute({ type: "updateLayout", layoutId: "lo-000001", patch: { name: "Second" } }));
  // Full page-setup replacement validates as a whole.
  doc.execute({
    type: "updateLayout",
    layoutId: "lo-000001",
    patch: { pageSetup: { ...DEFAULT_PAGE_SETUP, paperSize: "A1", widthMm: 594, heightMm: 841, orientation: "portrait" } },
  });
  assert.equal(doc.layoutById("lo-000001")?.pageSetup.paperSize, "A1");
});

test("removeLayout is reference-checked (viewports); the last-layout rule is the COMMAND layer", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "Only") });
  doc.execute({ type: "addLayout", layout: layout("lo-000002", "Second") });
  doc.execute({ type: "addViewport", viewport: viewport("vp-000001", "lo-000001") });
  // Referenced layout rejects — the cascade lives at the command layer.
  assert.throws(() => doc.execute({ type: "removeLayout", layoutId: "lo-000001" }), /referenced by 1 viewport/);
  // The command-layer cascade: viewports + record leave as ONE atomic batch.
  doc.execute({
    type: "applyEdits",
    edits: [
      { type: "removeViewport", viewportId: "vp-000001" },
      { type: "removeLayout", layoutId: "lo-000001" },
    ],
  });
  assert.equal(doc.layoutTable.length, 1);
  assert.equal(doc.viewportTable.length, 0);
  // The raw removeLayout on the last layout SUCCEEDS at the document level
  // (journal semantics: undo of the first creation replays it) — the
  // last-layout rule is enforced by layout.remove (the command layer).
  doc.execute({ type: "removeLayout", layoutId: "lo-000002" });
  assert.equal(doc.layoutTable.length, 0);
});

test("addViewport mints vp-NNNNNN; unknown layout + duplicate ids reject; degenerate rects reject", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "First") });
  doc.execute({ type: "addViewport", viewport: viewport("", "lo-000001") });
  assert.match(doc.viewportTable[0]!.id, /^vp-000001$/);
  assert.throws(() => doc.execute({ type: "addViewport", viewport: viewport("vp-000009", "lo-000404") }));
  assert.throws(() => doc.execute({ type: "addViewport", viewport: viewport("vp-000001", "lo-000001") }));
  assert.throws(() =>
    doc.execute({ type: "addViewport", viewport: viewport("vp-000003", "lo-000001", { corner2: [20, 180] }) }),
  );
  assert.throws(() =>
    doc.execute({ type: "addViewport", viewport: viewport("vp-000004", "lo-000001", { scaleDenominator: 0 }) }),
  );
  // Layer overrides: at most one entry per layer.
  assert.throws(() =>
    doc.execute({
      type: "addViewport",
      viewport: viewport("vp-000005", "lo-000001", {
        layerOverrides: [{ layerId: "0", visible: false }, { layerId: "0", frozen: true }],
      }),
    }),
  );
});

test("updateViewport patches the view/frame/overrides; identity immutable", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "First") });
  doc.execute({ type: "addViewport", viewport: viewport("vp-000001", "lo-000001") });
  doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { scaleDenominator: 100, locked: true } });
  const updated = doc.viewportById("vp-000001")!;
  assert.equal(updated.scaleDenominator, 100);
  assert.equal(updated.locked, true);
  assert.throws(() => doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { layoutId: "lo-000002" } }));
  assert.throws(() => doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { rotationDeg: "x" as never } }));
  assert.throws(() => doc.execute({ type: "updateViewport", viewportId: "vp-000404", patch: { locked: true } }));
});

test("undo/redo converge exactly across layout/viewport edits (one edit = one undo entry)", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "First") });
  doc.execute({ type: "addViewport", viewport: viewport("vp-000001", "lo-000001") });
  doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { scaleDenominator: 100 } });
  const content = (): string =>
    JSON.stringify({ layouts: doc.layoutTable, viewports: doc.viewportTable });
  const beforeUndo = content();
  doc.undo(); // undo the scale patch
  assert.equal(doc.viewportById("vp-000001")?.scaleDenominator, 50);
  doc.undo(); // undo the viewport
  assert.equal(doc.viewportTable.length, 0);
  doc.undo(); // undo the layout
  assert.equal(doc.layoutTable.length, 0);
  doc.redo();
  doc.redo();
  doc.redo();
  assert.equal(content(), beforeUndo);
});

test("the key-adding updateViewport inverse is the full-record restore (setViewportRecord)", () => {
  const doc = empty();
  doc.execute({ type: "addLayout", layout: layout("lo-000001", "First") });
  doc.execute({ type: "addViewport", viewport: viewport("vp-000001", "lo-000001") });
  // The patch ADDS a key the record lacks (locked is absent on the fresh
  // viewport) → the exact inverse restores the full record so absence of
  // keys is representable on undo/replay.
  doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { locked: true } });
  assert.equal(doc.viewportById("vp-000001")?.locked, true);
  doc.undo();
  const restored = doc.viewportById("vp-000001")!;
  assert.equal(restored.locked, undefined);
  doc.redo();
  assert.equal(doc.viewportById("vp-000001")?.locked, true);
});

test("the canonical-minimal contract: layouts/viewports are ABSENT while empty (legacy byte-identity)", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
  });
  const snapshot: CADDocumentSnapshot = doc.snapshot();
  assert.equal("layouts" in snapshot, false);
  assert.equal("viewports" in snapshot, false);
  const serialized = serialize(snapshot);
  assert.equal(serialized.includes("\"layouts\""), false);
  assert.equal(serialized.includes("\"viewports\""), false);
  assert.equal(serialized.includes("\"next_layout_sequence\""), false);
});

test("save/open round-trips layouts, viewports, counters and the editor context exactly", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 10000, y2: 0 } },
  });
  doc.execute({ type: "addLayout", layout: layout("", "Sheet-A") });
  doc.execute({ type: "addLayout", layout: layout("", "Sheet-B") });
  doc.execute({ type: "addViewport", viewport: viewport("", "lo-000001") });
  doc.setDraftingSettings({ ...doc.draftingSettings, activeLayout: "lo-000001", space: "paper" });
  const saved = serialize(doc.snapshot());
  const reopened = CADDocument.open(JSON.parse(saved), "cp8-reopen");
  assert.equal(reopened.layoutTable.length, 2);
  assert.equal(reopened.layoutTable[0]!.name, "Sheet-A");
  assert.equal(reopened.viewportTable.length, 1);
  assert.equal(reopened.viewportById("vp-000001")?.scaleDenominator, 50);
  assert.equal(reopened.draftingSettings.activeLayout, "lo-000001");
  assert.equal(reopened.draftingSettings.space, "paper");
  // Counters survive the round trip (the next mint continues).
  assert.equal(reopened.layoutSequence, 3);
  assert.equal(reopened.viewportSequence, 2);
  // Content byte-identity of the re-save (the ephemeral editorState —
  // canUndo/commandDepth — is the only legitimate difference: open clears
  // the undo/redo stacks by design).
  const stripEditorState = (text: string): string => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    delete parsed.editorState;
    return canonicalStringify(parsed);
  };
  assert.equal(stripEditorState(serialize(reopened.snapshot())), stripEditorState(saved));
  // The next mint continues monotonically.
  reopened.execute({ type: "addLayout", layout: layout("", "Sheet-C") });
  assert.equal(reopened.layoutTable[2]!.id, "lo-000003");
});

test("open rejects dangling viewport references, duplicate names and a dangling activeLayout", () => {
  const base = empty();
  base.execute({ type: "addLayout", layout: layout("lo-000001", "Only") });
  const snapshot = JSON.parse(serialize(base.snapshot()));
  // Dangling viewport.
  const badViewport = structuredClone(snapshot);
  badViewport.viewports = [viewport("vp-000001", "lo-000404")];
  assert.throws(() => CADDocument.open(badViewport, "x"), /references unknown layout/);
  // Duplicate layout name.
  const dupName = structuredClone(snapshot);
  dupName.layouts = [...dupName.layouts, layout("lo-000002", "Only")];
  assert.throws(() => CADDocument.open(dupName, "x"), /duplicate layout name/);
  // Dangling activeLayout.
  const badActive = structuredClone(snapshot);
  badActive.draftingSettings = { ...badActive.draftingSettings, activeLayout: "lo-000404" };
  assert.throws(() => CADDocument.open(badActive, "x"), /activeLayout/);
});

test("history replay is verified with layout/viewport edits; counters persist canonically-minimal", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
  });
  doc.execute({ type: "addLayout", layout: layout("", "Sheet-A") });
  doc.execute({ type: "addViewport", viewport: viewport("", "lo-000001") });
  doc.execute({ type: "updateViewport", viewportId: "vp-000001", patch: { locked: true } });
  const history = doc.snapshot().modelHistory!;
  // The counters appear only once a mint happened.
  assert.equal(history.next_layout_sequence, 2);
  assert.equal(history.next_viewport_sequence, 2);
  const replay = verifiedReplay(history, history.revisions.length);
  assert.equal(replay.verified, true);
});
