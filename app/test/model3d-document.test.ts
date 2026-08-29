/**
 * CAD-PARITY-009 deterministic 3D document tests (Issue #90) — the
 * CADDocument UCS/workplane + section-plane tables: ucs-/sp-NNNNNN minting
 * (monotonic, never reused; the counters appear on the history ONLY after
 * the first mint — canonical-minimal), the eight DocumentEdit variants with
 * exact inverses (undo after update restores the previous record EXACTLY;
 * the setUcsRecord/setSectionPlaneRecord full-record restores), undo/redo
 * convergence, the canonical-minimal snapshot contract (legacy
 * byte-identity), the reserved World name/id + degenerate axis triples
 * rejected at the document boundary, the id-based activeUcs editor
 * reference, the save/open round trip (records + counters + activeUcs +
 * view3d camera), the dangling-activeUcs defensive repair and the verified
 * history replay.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CADDocument } from "../src/caddocument/index.js";
import type { CADDocumentSnapshot, Camera3DState, SectionPlaneRecord, UcsRecord } from "../src/contracts/caddocument.js";
import { canonicalStringify, serialize } from "../src/caddocument/serialization.js";
import { verifiedReplay } from "../src/caddocument/history.js";

const NOW = "2026-01-01T00:00:00.000Z";

function empty(): CADDocument {
  return CADDocument.empty("cp9-doc", "offisos-dummy", "1", "cp9-tests");
}

function ucs(id: string, name: string, origin: readonly [number, number, number] = [0, 0, 0]): UcsRecord {
  return { id, name, origin, xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], createdAt: NOW };
}

/** A right-handed 90°-about-Z workplane (a non-trivial orthonormal triple). */
function turnedUcs(id: string, name: string): UcsRecord {
  return { id, name, origin: [10, 0, 0], xAxis: [0, 1, 0], yAxis: [-1, 0, 0], zAxis: [0, 0, 1], createdAt: NOW };
}

function plane(id: string, name: string, overrides: Partial<SectionPlaneRecord> = {}): SectionPlaneRecord {
  return { id, name, origin: [0, 0, 0], normal: [0, 0, 1], createdAt: NOW, ...overrides };
}

// ---------------------------------------------------------------------------
// ucs-/sp- minting.
// ---------------------------------------------------------------------------

test("addUcs mints ucs-NNNNNN (monotonic, never reused); duplicates and reserved identities rejected", () => {
  const doc = empty();
  doc.execute({ type: "addUcs", ucs: ucs("ucs-000042", "Explicit") });
  assert.equal(doc.ucsRecords.length, 1);
  assert.equal(doc.ucsById("ucs-000042")?.name, "Explicit");
  // Empty id mints the FIRST canonical identity (42 was explicit — the
  // counter counts MINTS only).
  doc.execute({ type: "addUcs", ucs: ucs("", "Plan-A") });
  assert.equal(doc.ucsRecords[1]!.id, "ucs-000001");
  // Duplicate id and duplicate name both reject.
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("ucs-000042", "Other") }));
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("ucs-000002", "Plan-A") }));
  // Ids are NEVER reused after removal: the next mint continues the sequence.
  doc.execute({ type: "removeUcs", ucsId: "ucs-000001" });
  doc.execute({ type: "addUcs", ucs: ucs("", "Plan-B") });
  assert.equal(doc.ucsRecords.length, 2);
  assert.equal(doc.ucsRecords[1]!.id, "ucs-000002");
  assert.equal(doc.ucsSequence, 3);
});

test("the mint counters appear on the history ONLY after the first mint (canonical-minimal)", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
  });
  // Before any mint the serialized history has NO such key (legacy
  // byte-identity for every pre-009 document).
  const before = JSON.parse(serialize(doc.snapshot())) as { modelHistory: Record<string, unknown> };
  assert.equal("next_ucs_sequence" in before.modelHistory, false);
  assert.equal("next_section_plane_sequence" in before.modelHistory, false);
  assert.equal(before.modelHistory.next_ucs_sequence, undefined);
  assert.equal(before.modelHistory.next_section_plane_sequence, undefined);
  // The first mints materialize the counters.
  doc.execute({ type: "addUcs", ucs: ucs("", "Plan-A") });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut") });
  const after = JSON.parse(serialize(doc.snapshot())) as { modelHistory: Record<string, unknown> };
  assert.equal(after.modelHistory.next_ucs_sequence, 2);
  assert.equal(after.modelHistory.next_section_plane_sequence, 2);
  // The counters never decrease across undo/redo (never-reuse).
  doc.undo();
  doc.undo();
  const undone = JSON.parse(serialize(doc.snapshot())) as { modelHistory: Record<string, unknown> };
  assert.equal(undone.modelHistory.next_ucs_sequence, 2);
  assert.equal(undone.modelHistory.next_section_plane_sequence, 2);
});

// ---------------------------------------------------------------------------
// UCS lifecycle with exact inverses.
// ---------------------------------------------------------------------------

test("addUcs/updateUcs/setUcsRecord/removeUcs lifecycle with undo/redo exact inverses after every step", () => {
  const doc = empty();
  doc.execute({ type: "addUcs", ucs: turnedUcs("ucs-000001", "East-Plan") });
  const original = doc.ucsById("ucs-000001")!;

  // updateUcs patch → undo restores the previous record EXACTLY (full
  // deep-equal, not just the patched fields).
  doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { name: "East-Plan-2", origin: [5, 0, 0] } });
  assert.equal(doc.ucsById("ucs-000001")?.name, "East-Plan-2");
  assert.deepEqual(doc.ucsById("ucs-000001")?.origin, [5, 0, 0]);
  doc.undo();
  assert.deepEqual(doc.ucsById("ucs-000001"), original);
  doc.redo();
  assert.equal(doc.ucsById("ucs-000001")?.name, "East-Plan-2");

  // setUcsRecord — the full-record restore edit used as the key-adding
  // update inverse — replaces the record; its own inverse restores the
  // previous record exactly (absence of keys representable).
  const replacement: UcsRecord = { id: "ucs-000001", name: "East-Plan-3", origin: [1, 2, 3], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], createdAt: NOW };
  doc.execute({ type: "setUcsRecord", ucsId: "ucs-000001", ucs: replacement });
  assert.deepEqual(doc.ucsById("ucs-000001"), replacement);
  doc.undo();
  assert.equal(doc.ucsById("ucs-000001")?.name, "East-Plan-2");
  doc.redo();
  assert.deepEqual(doc.ucsById("ucs-000001"), replacement);
  // setUcsRecord identity mismatch rejects.
  assert.throws(() => doc.execute({ type: "setUcsRecord", ucsId: "ucs-000001", ucs: { ...replacement, id: "ucs-000009" } }));

  // removeUcs → undo restores the exact record; redo removes again.
  doc.execute({ type: "removeUcs", ucsId: "ucs-000001" });
  assert.equal(doc.ucsRecords.length, 0);
  doc.undo();
  assert.deepEqual(doc.ucsById("ucs-000001"), replacement);
  doc.redo();
  assert.equal(doc.ucsRecords.length, 0);
  // Unknown ids reject everywhere.
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000404", patch: { name: "X" } }));
  assert.throws(() => doc.execute({ type: "removeUcs", ucsId: "ucs-000404" }));
});

test("updateUcs: identity immutable; unknown fields rejected; names stay unique", () => {
  const doc = empty();
  doc.execute({ type: "addUcs", ucs: ucs("ucs-000001", "Plan-A") });
  doc.execute({ type: "addUcs", ucs: ucs("ucs-000002", "Plan-B") });
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { id: "ucs-000099" } }));
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { createdAt: "2030-01-01T00:00:00.000Z" } }));
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { bogus: 1 } }));
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { name: "Plan-B" } }));
  // A merged record re-validates as a whole (a degenerate merged triple rejects).
  assert.throws(() => doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { yAxis: [1, 0, 0] } }));
  // A valid rename succeeds and keeps uniqueness.
  doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { name: "Plan-A2" } });
  assert.equal(doc.ucsByName("Plan-A2")?.id, "ucs-000001");
});

test("the reserved name 'World' (any case) and the reserved id 'world' are rejected; degenerate triples reject at the document boundary", () => {
  const doc = empty();
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("ucs-000001", "World") }), /reserved/);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("ucs-000001", "world") }), /reserved/);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("ucs-000001", "  WORLD ") }), /reserved/);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: ucs("world", "W") }), /implicit World UCS/);
  // Degenerate / non-orthonormal / left-handed triples reject.
  assert.throws(() => doc.execute({ type: "addUcs", ucs: { ...ucs("ucs-000001", "Zero"), xAxis: [0, 0, 0] } }), /unit length/);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: { ...ucs("ucs-000001", "NonUnit"), yAxis: [0, 2, 0] } }), /unit length/);
  // A UNIT but non-perpendicular y axis (45° off) → the perpendicular rule.
  const skew = 1 / Math.sqrt(2);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: { ...ucs("ucs-000001", "Skew"), yAxis: [skew, skew, 0] } }), /perpendicular/);
  assert.throws(() => doc.execute({ type: "addUcs", ucs: { ...ucs("ucs-000001", "LeftHand"), zAxis: [0, 0, -1] } }), /right-handed/);
  assert.equal(doc.ucsRecords.length, 0);
});

test("renaming keeps the activeUcs editor reference intact (id-based)", () => {
  const doc = empty();
  doc.execute({ type: "addUcs", ucs: ucs("ucs-000001", "Plan-A") });
  doc.setDraftingSettings({ ...doc.draftingSettings, activeUcs: "ucs-000001" });
  doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { name: "Plan-A-Renamed" } });
  assert.equal(doc.draftingSettings.activeUcs, "ucs-000001");
  assert.equal(doc.ucsById(doc.draftingSettings.activeUcs!)?.name, "Plan-A-Renamed");
  // The active reference survives undo/redo of the rename too.
  doc.undo();
  assert.equal(doc.draftingSettings.activeUcs, "ucs-000001");
  assert.equal(doc.ucsById("ucs-000001")?.name, "Plan-A");
});

// ---------------------------------------------------------------------------
// The section-plane table (the same lifecycle coverage).
// ---------------------------------------------------------------------------

test("section planes: minting, update patch, full-record restore, remove, duplicates and normals", () => {
  const doc = empty();
  // sp-NNNNNN minting (monotonic, never reused).
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut-1") });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut-2") });
  assert.deepEqual(doc.sectionPlaneRecords.map((s) => s.id), ["sp-000001", "sp-000002"]);
  doc.execute({ type: "removeSectionPlane", sectionPlaneId: "sp-000002" });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut-3") });
  assert.equal(doc.sectionPlaneRecords[1]!.id, "sp-000003");
  assert.equal(doc.sectionPlaneSequence, 4);
  // Duplicate ids / names reject.
  assert.throws(() => doc.execute({ type: "addSectionPlane", sectionPlane: plane("sp-000001", "Other") }), /already exists/);
  assert.throws(() => doc.execute({ type: "addSectionPlane", sectionPlane: plane("sp-000009", "Cut-1") }), /unique/);
  // The table stores UNIT normals only — the zero vector and non-unit
  // normals reject through validateSectionPlaneTableRecord (un-normalized
  // input is accepted ONLY through the explicit command-layer path).
  assert.throws(() => doc.execute({ type: "addSectionPlane", sectionPlane: plane("sp-000004", "Zero", { normal: [0, 0, 0] }) }), /non-zero/);
  assert.throws(() => doc.execute({ type: "addSectionPlane", sectionPlane: plane("sp-000004", "NonUnit", { normal: [0, 0, 3] }) }), /unit length/);
  // updateSectionPlane patch → undo restores the previous record EXACTLY.
  doc.execute({ type: "updateSectionPlane", sectionPlaneId: "sp-000001", patch: { origin: [0, 0, 5], name: "Cut-1-High" } });
  assert.equal(doc.sectionPlaneById("sp-000001")?.name, "Cut-1-High");
  assert.deepEqual(doc.sectionPlaneById("sp-000001")?.origin, [0, 0, 5]);
  doc.undo();
  assert.deepEqual(doc.sectionPlaneById("sp-000001"), plane("sp-000001", "Cut-1"));
  // setSectionPlaneRecord full-record restore + its inverse.
  const replacement: SectionPlaneRecord = { id: "sp-000001", name: "Cut-1-Flat", origin: [1, 1, 1], normal: [0, 1, 0], createdAt: NOW };
  doc.execute({ type: "setSectionPlaneRecord", sectionPlaneId: "sp-000001", sectionPlane: replacement });
  assert.deepEqual(doc.sectionPlaneById("sp-000001"), replacement);
  doc.undo();
  assert.deepEqual(doc.sectionPlaneById("sp-000001"), plane("sp-000001", "Cut-1"));
  doc.redo();
  assert.deepEqual(doc.sectionPlaneById("sp-000001"), replacement);
  // Identity immutable / unknown fields rejected.
  assert.throws(() => doc.execute({ type: "updateSectionPlane", sectionPlaneId: "sp-000001", patch: { id: "sp-000099" } }));
  assert.throws(() => doc.execute({ type: "updateSectionPlane", sectionPlaneId: "sp-000001", patch: { bogus: 1 } }));
  // remove → undo restores; unknown ids reject.
  doc.execute({ type: "removeSectionPlane", sectionPlaneId: "sp-000001" });
  assert.equal(doc.sectionPlaneRecords.length, 1);
  doc.undo();
  assert.equal(doc.sectionPlaneRecords.length, 2);
  assert.throws(() => doc.execute({ type: "removeSectionPlane", sectionPlaneId: "sp-000404" }));
});

// ---------------------------------------------------------------------------
// Snapshot canonical-minimality + save/open.
// ---------------------------------------------------------------------------

test("snapshot canonical-minimal: no UCS/section planes → no keys (legacy byte-identity); records appear when present", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
  });
  const snapshot: CADDocumentSnapshot = doc.snapshot();
  assert.equal("ucs" in snapshot, false);
  assert.equal("sectionPlanes" in snapshot, false);
  const serialized = serialize(snapshot);
  assert.equal(serialized.includes("\"ucs\""), false);
  assert.equal(serialized.includes("\"sectionPlanes\""), false);
  // With records they appear.
  doc.execute({ type: "addUcs", ucs: ucs("", "Plan-A") });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut") });
  const withRecords = serialize(doc.snapshot());
  assert.equal(withRecords.includes("\"ucs\""), true);
  assert.equal(withRecords.includes("\"sectionPlanes\""), true);
});

test("save/open round-trips UCS records, section planes, counters, activeUcs and the view3d camera", () => {
  const doc = empty();
  doc.execute({ type: "addUcs", ucs: turnedUcs("", "East-Plan") });
  doc.execute({ type: "addUcs", ucs: ucs("", "Plan-B") });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut", { origin: [0, 0, 2] }) });
  const camera: Camera3DState = { eye: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1], mode: "orthographic", orthoHalfHeight: 7, fovDeg: 45 };
  doc.setDraftingSettings({ ...doc.draftingSettings, activeUcs: "ucs-000001", view3d: camera });

  const saved = serialize(doc.snapshot());
  const reopened = CADDocument.open(JSON.parse(saved), "cp9-reopen");
  // UCS records survive exactly (incl. the turned axes).
  assert.deepEqual(reopened.ucsRecords, doc.ucsRecords);
  assert.equal(reopened.ucsRecords[0]!.name, "East-Plan");
  assert.deepEqual(reopened.ucsRecords[0]!.xAxis, [0, 1, 0]);
  // Section planes survive exactly.
  assert.deepEqual(reopened.sectionPlaneRecords, doc.sectionPlaneRecords);
  assert.deepEqual(reopened.sectionPlaneById("sp-000001")?.origin, [0, 0, 2]);
  // Counters survive (the next mint continues monotonically).
  assert.equal(reopened.ucsSequence, 3);
  assert.equal(reopened.sectionPlaneSequence, 2);
  // Editor state: activeUcs + the normalized view3d camera.
  assert.equal(reopened.draftingSettings.activeUcs, "ucs-000001");
  assert.deepEqual(reopened.draftingSettings.view3d, camera);
  // Content byte-identity of the re-save (editorState — canUndo/commandDepth
  // — is the only legitimate difference: open clears the undo/redo stacks).
  const stripEditorState = (text: string): string => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    delete parsed.editorState;
    return canonicalStringify(parsed);
  };
  assert.equal(stripEditorState(serialize(reopened.snapshot())), stripEditorState(saved));
  // The next mints continue monotonically after the reopen.
  reopened.execute({ type: "addUcs", ucs: ucs("", "Plan-C") });
  reopened.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut-2") });
  assert.equal(reopened.ucsRecords[2]!.id, "ucs-000003");
  assert.equal(reopened.sectionPlaneRecords[1]!.id, "sp-000002");
});

test("open: duplicate UCS ids/names, duplicate section-plane ids/names and a malformed counter reject", () => {
  const base = empty();
  base.execute({ type: "addUcs", ucs: ucs("ucs-000001", "Only") });
  base.execute({ type: "addSectionPlane", sectionPlane: plane("sp-000001", "Cut") });
  const snapshot = JSON.parse(serialize(base.snapshot()));
  // Duplicate UCS id.
  const dupUcsId = structuredClone(snapshot);
  dupUcsId.ucs = [...dupUcsId.ucs, ucs("ucs-000001", "Other")];
  assert.throws(() => CADDocument.open(dupUcsId, "x"), /duplicate UCS id/);
  // Duplicate UCS name.
  const dupUcsName = structuredClone(snapshot);
  dupUcsName.ucs = [...dupUcsName.ucs, ucs("ucs-000002", "Only")];
  assert.throws(() => CADDocument.open(dupUcsName, "x"), /duplicate UCS name/);
  // Duplicate section-plane id.
  const dupSpId = structuredClone(snapshot);
  dupSpId.sectionPlanes = [...dupSpId.sectionPlanes, plane("sp-000001", "Other")];
  assert.throws(() => CADDocument.open(dupSpId, "x"), /duplicate section plane id/);
  // Duplicate section-plane name.
  const dupSpName = structuredClone(snapshot);
  dupSpName.sectionPlanes = [...dupSpName.sectionPlanes, plane("sp-000002", "Cut")];
  assert.throws(() => CADDocument.open(dupSpName, "x"), /duplicate section plane name/);
  // A malformed mint counter rejects on open.
  const badCounter = structuredClone(snapshot);
  badCounter.modelHistory = { ...badCounter.modelHistory, next_ucs_sequence: 0 };
  assert.throws(() => CADDocument.open(badCounter, "x"));
});

test("the dangling-activeUcs defensive repair: a hand-crafted dangling reference opens with World", () => {
  const base = empty();
  base.execute({ type: "addUcs", ucs: ucs("ucs-000001", "Plan-A") });
  base.setDraftingSettings({ ...base.draftingSettings, activeUcs: "ucs-000001" });
  const snapshot = JSON.parse(serialize(base.snapshot()));
  // Hand-craft the dangling reference (a corrupt hand-edited save).
  const dangling = structuredClone(snapshot);
  dangling.draftingSettings = { ...dangling.draftingSettings, activeUcs: "ucs-999999" };
  const reopened = CADDocument.open(dangling, "repair-test");
  // Open succeeds with the dangling reference dropped → World (absent).
  assert.equal(reopened.draftingSettings.activeUcs, undefined);
  assert.equal(reopened.ucsRecords.length, 1);
});

// ---------------------------------------------------------------------------
// History replay.
// ---------------------------------------------------------------------------

test("history replay is verified across the P009 edit vocabulary", () => {
  const doc = empty();
  doc.execute({
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 } },
  });
  doc.execute({ type: "addUcs", ucs: turnedUcs("", "East-Plan") });
  doc.execute({ type: "updateUcs", ucsId: "ucs-000001", patch: { name: "East-Plan-2", origin: [1, 1, 1] } });
  doc.execute({ type: "setUcsRecord", ucsId: "ucs-000001", ucs: turnedUcs("ucs-000001", "East-Plan-3") });
  doc.execute({ type: "addSectionPlane", sectionPlane: plane("", "Cut") });
  doc.execute({ type: "updateSectionPlane", sectionPlaneId: "sp-000001", patch: { origin: [0, 0, 5] } });
  doc.execute({ type: "removeSectionPlane", sectionPlaneId: "sp-000001" });
  doc.execute({ type: "removeUcs", ucsId: "ucs-000001" });
  const history = doc.snapshot().modelHistory!;
  assert.ok(history.revisions.length >= 7);
  for (let k = 0; k <= history.revisions.length; k += 1) {
    const replayed = verifiedReplay(history, k);
    assert.equal(replayed.verified, true, `revision ${k} must replay verified`);
  }
});
