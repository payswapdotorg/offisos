/**
 * CAD-PARITY-004 deterministic styles/standards tests (Issue #80, CAD-2D-004)
 * — the linetype catalog, the standard lineweight set, user-defined
 * linetype/text-style/dim-style tables and the built-in style resolution.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_LTYPES,
  BUILT_IN_LTYPE_NAMES,
  STANDARD_LINEWEIGHTS,
  STANDARD_DEFAULT_LINEWEIGHT,
  STANDARD_DIM_STYLE,
  STANDARD_TEXT_STYLE,
  formatDimValue,
  isStandardLineweight,
  ltypeExists,
  ltypePattern,
  resolveDimStyle,
  resolveTextStyle,
} from "../src/workspace/standards/index.js";
import {
  applyDimStylePatch,
  applyLtypePatch,
  applyTextStylePatch,
  validateDimStyleRecord,
  validateLtypeRecord,
  validateTextStyleRecord,
} from "../src/caddocument/workspace.js";
import { CADDocument } from "../src/caddocument/index.js";

const TOL = 1e-9;

// ---------------------------------------------------------------------------
// The built-in linetype catalog.
// ---------------------------------------------------------------------------

test("built-in linetype catalog: the nine classic names with even-length patterns", () => {
  assert.deepEqual(BUILT_IN_LTYPE_NAMES, [
    "Continuous", "Dashed", "Hidden", "Center", "Phantom", "Dot", "DashDot", "Divide", "Border",
  ]);
  for (const lt of BUILT_IN_LTYPES) {
    if (lt.name === "Continuous") {
      assert.equal(lt.pattern.length, 0);
    } else {
      assert.ok(lt.pattern.length >= 2 && lt.pattern.length % 2 === 0, `${lt.name} pattern must be even-length`);
      assert.ok(lt.pattern.every((seg) => seg > 0), `${lt.name} pattern segments must be positive`);
    }
  }
});

test("ltypePattern: resolution order (Continuous → catalog → user table); unknown names typed-fail", () => {
  assert.deepEqual(ltypePattern("Continuous"), []);
  assert.deepEqual(ltypePattern("Dashed"), [12, 6]);
  assert.deepEqual(ltypePattern("Hidden"), [6, 3]);
  const user = [{ name: "MyDash", pattern: [8, 4] }];
  assert.deepEqual(ltypePattern("MyDash", user), [8, 4]);
  assert.throws(() => ltypePattern("Nope", user), /unknown linetype 'Nope'/);
});

test("ltypeExists mirrors ltypePattern resolution", () => {
  assert.equal(ltypeExists("Continuous"), true);
  assert.equal(ltypeExists("Center"), true);
  assert.equal(ltypeExists("MyDash", [{ name: "MyDash" }]), true);
  assert.equal(ltypeExists("Ghost"), false);
});

// ---------------------------------------------------------------------------
// The standard lineweight set.
// ---------------------------------------------------------------------------

test("standard lineweights: the canonical set + membership tolerance", () => {
  assert.equal(STANDARD_DEFAULT_LINEWEIGHT, 0.25);
  assert.ok(STANDARD_LINEWEIGHTS.includes(0.25));
  assert.ok(STANDARD_LINEWEIGHTS.includes(2.11));
  assert.equal(STANDARD_LINEWEIGHTS[0], 0.0);
  assert.equal(isStandardLineweight(0.25), true);
  assert.equal(isStandardLineweight(0.26), false);
  assert.equal(isStandardLineweight(0.250000000001), true); // tolerance
});

// ---------------------------------------------------------------------------
// User-defined linetype records.
// ---------------------------------------------------------------------------

test("validateLtypeRecord: strict shape, built-in names immutable, alternating positive pattern", () => {
  const good = validateLtypeRecord({ name: "LongDash", description: "d", pattern: [20, 10] });
  assert.equal(good.name, "LongDash");
  assert.throws(() => validateLtypeRecord({ name: "Dashed", description: "", pattern: [12, 6] }), /built-in/);
  assert.throws(() => validateLtypeRecord({ name: "X", description: "", pattern: [8] })); // odd length
  assert.throws(() => validateLtypeRecord({ name: "X", description: "", pattern: [8, 0] })); // non-positive
  assert.throws(() => validateLtypeRecord({ name: "", description: "", pattern: [8, 4] }));
});

test("applyLtypePatch: name immutable; description/pattern merge", () => {
  const current = { name: "LongDash", description: "old", pattern: [20, 10] as readonly number[] };
  assert.throws(() => applyLtypePatch(current, { name: "Other" }), /identity/);
  const merged = applyLtypePatch(current, { pattern: [30, 10] });
  assert.deepEqual(merged.pattern, [30, 10]);
  assert.equal(merged.description, "old");
  assert.throws(() => applyLtypePatch(current, { bogus: 1 }));
});

// ---------------------------------------------------------------------------
// Text + dimension style records.
// ---------------------------------------------------------------------------

test("validateTextStyleRecord: strict shape; 'Standard' reserved", () => {
  const good = validateTextStyleRecord({ name: "Notes", font: "mono", height: 2.5, widthFactor: 0.9, obliqueAngle: 15 });
  assert.equal(good.font, "mono");
  assert.throws(() => validateTextStyleRecord({ name: "Standard", font: "sans", height: 0, widthFactor: 1, obliqueAngle: 0 }), /reserved/);
  assert.throws(() => validateTextStyleRecord({ name: "X", font: "comic", height: 0, widthFactor: 1, obliqueAngle: 0 }));
  assert.throws(() => validateTextStyleRecord({ name: "X", font: "sans", height: -1, widthFactor: 1, obliqueAngle: 0 }));
  assert.throws(() => validateTextStyleRecord({ name: "X", font: "sans", height: 0, widthFactor: 0, obliqueAngle: 0 }));
  assert.throws(() => validateTextStyleRecord({ name: "X", font: "sans", height: 0, widthFactor: 1, obliqueAngle: 90 }));
});

test("validateDimStyleRecord: strict shape; positive sizes; integer precision 0–6", () => {
  const good = validateDimStyleRecord({ name: "ISO-25", textHeight: 2.5, arrowSize: 2.5, scale: 1, precision: 1 });
  assert.equal(good.precision, 1);
  assert.throws(() => validateDimStyleRecord({ name: "Standard", textHeight: 2.5, arrowSize: 2.5, scale: 1, precision: 0 }), /reserved/);
  assert.throws(() => validateDimStyleRecord({ name: "X", textHeight: 0, arrowSize: 2.5, scale: 1, precision: 0 }));
  assert.throws(() => validateDimStyleRecord({ name: "X", textHeight: 2.5, arrowSize: 2.5, scale: -1, precision: 0 }));
  assert.throws(() => validateDimStyleRecord({ name: "X", textHeight: 2.5, arrowSize: 2.5, scale: 1, precision: 7 }));
});

test("style patches: name immutable, fields merge + validate", () => {
  const ts = { name: "Notes", font: "sans", height: 0, widthFactor: 1, obliqueAngle: 0 };
  assert.throws(() => applyTextStylePatch(ts, { name: "Other" }));
  assert.equal(applyTextStylePatch(ts, { height: 3 }).height, 3);
  assert.throws(() => applyTextStylePatch(ts, { widthFactor: -1 }));

  const ds = { name: "ISO-25", textHeight: 2.5, arrowSize: 2.5, scale: 1, precision: 0 };
  assert.throws(() => applyDimStylePatch(ds, { name: "Other" }));
  assert.equal(applyDimStylePatch(ds, { precision: 2 }).precision, 2);
  assert.throws(() => applyDimStylePatch(ds, { textHeight: 0 }));
});

// ---------------------------------------------------------------------------
// Built-in style resolution + dim formatting.
// ---------------------------------------------------------------------------

test("resolveTextStyle / resolveDimStyle: Standard built-ins; user table; unknown → null", () => {
  assert.deepEqual({ ...resolveTextStyle("Standard")! }, { ...STANDARD_TEXT_STYLE });
  assert.equal(STANDARD_TEXT_STYLE.height, 0);
  const user = [{ name: "Notes", font: "mono" as const, height: 3, widthFactor: 1, obliqueAngle: 0 }];
  assert.equal(resolveTextStyle("Notes", user)!.height, 3);
  assert.equal(resolveTextStyle("Ghost", user), null);
  assert.deepEqual({ ...resolveDimStyle("Standard")! }, { ...STANDARD_DIM_STYLE });
  assert.equal(STANDARD_DIM_STYLE.textHeight, 2.5);
  const userDim = [{ name: "Fine", textHeight: 2, arrowSize: 1.5, scale: 1, precision: 3 }];
  assert.equal(resolveDimStyle("Fine", userDim)!.precision, 3);
  assert.equal(resolveDimStyle("Ghost", userDim), null);
});

test("formatDimValue: precision-driven measurement formatting", () => {
  assert.equal(formatDimValue(123.456789, STANDARD_DIM_STYLE), "123");
  assert.equal(formatDimValue(123.456789, { ...STANDARD_DIM_STYLE, precision: 2 }), "123.46");
  assert.equal(formatDimValue(123.456789, { ...STANDARD_DIM_STYLE, precision: 5 }), "123.45679");
});

// ---------------------------------------------------------------------------
// Document-level style tables.
// ---------------------------------------------------------------------------

test("document ltype/text/dim style tables: CRUD + snapshot round-trip", () => {
  const doc = CADDocument.empty("cp4-styles", "offisos-occt", "1", "t");
  doc.execute({ type: "addLtype", ltype: { name: "LongDash", description: "long", pattern: [20, 10] } });
  doc.execute({ type: "addTextStyle", style: { name: "Notes", font: "mono", height: 3, widthFactor: 1, obliqueAngle: 0 } });
  doc.execute({ type: "addDimStyle", style: { name: "Fine", textHeight: 2, arrowSize: 1.5, scale: 1, precision: 3 } });
  // Duplicate names rejected.
  assert.throws(() => doc.execute({ type: "addLtype", ltype: { name: "LongDash", description: "", pattern: [1, 1] } }));
  assert.throws(() => doc.execute({ type: "addTextStyle", style: { name: "Notes", font: "sans", height: 0, widthFactor: 1, obliqueAngle: 0 } }));
  // Updates merge.
  doc.execute({ type: "updateLtype", ltypeName: "LongDash", patch: { pattern: [40, 10] } });
  assert.deepEqual(doc.ltypeByName("LongDash")!.pattern, [40, 10]);
  doc.execute({ type: "updateDimStyle", styleName: "Fine", patch: { precision: 1 } });
  assert.equal(doc.dimStyleByName("Fine")!.precision, 1);
  // Snapshot round-trip.
  const reopened = CADDocument.open(doc.snapshot(), "t2");
  assert.deepEqual(reopened.ltypeByName("LongDash")!.pattern, [40, 10]);
  assert.equal(reopened.textStyleByName("Notes")!.font, "mono");
  assert.equal(reopened.dimStyleByName("Fine")!.precision, 1);
  // Removal.
  doc.execute({ type: "removeTextStyle", styleName: "Notes" });
  assert.equal(doc.textStyleByName("Notes"), undefined);
});

test("document style removal: the current style blocks (no silent cascade)", () => {
  const doc = CADDocument.empty("cp4-styles2", "offisos-occt", "1", "t");
  doc.execute({ type: "addDimStyle", style: { name: "Fine", textHeight: 2, arrowSize: 1.5, scale: 1, precision: 3 } });
  doc.setDraftingSettings({ ...doc.draftingSettings, dimStyle: "Fine" });
  assert.throws(() => doc.execute({ type: "removeDimStyle", styleName: "Fine" }), /current dimension style/);
  doc.setDraftingSettings({ ...doc.draftingSettings, dimStyle: "Standard" });
  doc.execute({ type: "removeDimStyle", styleName: "Fine" });
  assert.equal(doc.dimStyleByName("Fine"), undefined);
});

test("document dim-style removal: referencing dimension elements block removal", () => {
  const doc = CADDocument.empty("cp4-styles3", "offisos-occt", "1", "t");
  doc.execute({ type: "addDimStyle", style: { name: "Fine", textHeight: 2, arrowSize: 1.5, scale: 1, precision: 3 } });
  doc.execute({
    type: "addElement",
    element: { id: "el-dim", kind: "annotation", engineId: null, props: { type: "dim-linear", layer: "0", style: "Fine", p1: [0, 0], p2: [100, 0], mode: "aligned", offset: 20, measured: 100 } },
  });
  assert.throws(() => doc.execute({ type: "removeDimStyle", styleName: "Fine" }), /referenced by 1 dimension/);
});

test("determinism: identical style command sequences → identical snapshots + histories", () => {
  const run = (): string => {
    const doc = CADDocument.empty("cp4-det", "offisos-occt", "1", "t");
    doc.execute({ type: "addLtype", ltype: { name: "L1", description: "a", pattern: [10, 5] } });
    doc.execute({ type: "addTextStyle", style: { name: "T1", font: "serif", height: 2, widthFactor: 1.1, obliqueAngle: 0 } });
    doc.execute({ type: "addDimStyle", style: { name: "D1", textHeight: 3, arrowSize: 2, scale: 2, precision: 2 } });
    doc.execute({ type: "updateLtype", ltypeName: "L1", patch: { description: "b" } });
    doc.undo();
    return JSON.stringify({ s: doc.snapshot().ltypes, h: doc.getHistoryHash() });
  };
  assert.equal(run(), run());
});
