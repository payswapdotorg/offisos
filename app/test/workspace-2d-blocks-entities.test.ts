/**
 * CAD-PARITY-006 deterministic blocks entity tests (Issue #84) — the
 * canonical blocks/references vocabulary: instance constructors with strict
 * typed validation, the attdef vocabulary, the inline-entity normalizer,
 * the similarity-transform expansion (exact placement math incl. rotation +
 * scale + nesting composition + attribute materialization), the one-level
 * explode materialization, and the definition-graph gates (cycles + depth).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BlockError,
  assertDefinitionGraph,
  attdefTagsOf,
  attributeValue,
  blockRefFromElement,
  blockRefToProps,
  elementToBlockRef,
  isBlockRefElement,
  isXrefRefElement,
  makeAttdef,
  makeBlockRef,
  makeXrefRef,
  MAX_BLOCK_NESTING_DEPTH,
  normalizeBlockEntity,
  normalizeBlockEntities,
  referencedBlockIds,
  validAttributeTag,
  xrefRefToProps,
} from "../src/workspace/blocks/types.js";
import {
  applySim,
  composeSim,
  expandBlockInstance,
  expandXrefInstance,
  explodeBlockInstance,
  expandedBounds,
  simFromPlacement,
  transformGeomBySim,
} from "../src/workspace/blocks/expand.js";
import type { BlockDefinitionRecord, XrefRecord, Element } from "../src/contracts/caddocument.js";

const TOL = 1e-9;
const TAU = Math.PI * 2;

function blockRefElement(props: Record<string, unknown>): Element {
  return { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, ...props } };
}

function def(
  id: string,
  name: string,
  entities: Record<string, unknown>[],
  basePoint: { x: number; y: number } = { x: 0, y: 0 },
): BlockDefinitionRecord {
  return { id, name, basePoint, entities, createdAt: "2026-01-01T00:00:00.000Z" };
}

function tableOf(defs: readonly BlockDefinitionRecord[], xrefs: readonly XrefRecord[] = []) {
  return {
    blockDefById: (id: string) => defs.find((d) => d.id === id),
    xrefById: (id: string) => xrefs.find((x) => x.id === id),
  };
}

// ---------------------------------------------------------------------------
// Constructors: happy paths + typed failures.
// ---------------------------------------------------------------------------

test("makeBlockRef: stores placement + attribute values; scale must be positive", () => {
  const r = makeBlockRef({ layer: "0", blockId: "blk-000001", x: 10, y: -5, scale: 2, rotation: 0.5, attributes: [{ tag: "TITLE", value: "Plan A" }] });
  assert.equal(r.type, "block-ref");
  assert.equal(r.blockId, "blk-000001");
  assert.equal(r.scale, 2);
  assert.deepEqual(r.attributes, [{ tag: "TITLE", value: "Plan A" }]);
  assert.throws(() => makeBlockRef({ layer: "0", blockId: "b", x: 0, y: 0, scale: 0, rotation: 0 }), BlockError);
  assert.throws(() => makeBlockRef({ layer: "0", blockId: "b", x: 0, y: 0, scale: -1, rotation: 0 }), BlockError);
  assert.throws(() => makeBlockRef({ layer: "0", blockId: "b", x: NaN, y: 0, scale: 1, rotation: 0 }), BlockError);
  assert.throws(() => makeBlockRef({ layer: "", blockId: "b", x: 0, y: 0, scale: 1, rotation: 0 }), BlockError);
});

test("makeBlockRef: attribute tags are grammar-checked, uppercased and deduplicated", () => {
  assert.equal(validAttributeTag("TITLE"), true);
  assert.equal(validAttributeTag("SHEET_NO"), true);
  assert.equal(validAttributeTag("REV-2"), true);
  assert.equal(validAttributeTag("invalid tag"), false);
  assert.throws(() => makeBlockRef({ layer: "0", blockId: "b", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "a b", value: "x" }] }), BlockError);
  const r = makeBlockRef({ layer: "0", blockId: "b", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "title", value: "x" }] });
  assert.deepEqual(r.attributes, [{ tag: "TITLE", value: "x" }]);
  assert.throws(
    () => makeBlockRef({ layer: "0", blockId: "b", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "A", value: "1" }, { tag: "A", value: "2" }] }),
    BlockError,
  );
});

test("makeXrefRef: placement validation mirrors block refs", () => {
  const r = makeXrefRef({ layer: "0", xrefId: "xr-000001", x: 1, y: 2, scale: 3, rotation: TAU / 4 });
  assert.equal(r.xrefId, "xr-000001");
  assert.throws(() => makeXrefRef({ layer: "0", xrefId: "x", x: 0, y: 0, scale: 0, rotation: 0 }), BlockError);
});

test("makeAttdef: tag grammar + defaults; the prompt/default are optional", () => {
  const a = makeAttdef({ tag: "sheet_no", prompt: "Sheet number", default: "A-101", layer: "0", x: 5, y: 6, height: 3, rotation: 0 });
  assert.equal(a.tag, "SHEET_NO");
  assert.equal(a.prompt, "Sheet number");
  assert.equal(a.default, "A-101");
  const b = makeAttdef({ tag: "X", layer: "0", x: 0, y: 0, height: 2.5 });
  assert.equal(b.rotation, 0);
  assert.equal(b.default, undefined);
  assert.throws(() => makeAttdef({ tag: "no spaces", layer: "0", x: 0, y: 0, height: 2.5 }), BlockError);
  assert.throws(() => makeAttdef({ tag: "X", layer: "0", x: 0, y: 0, height: 0 }), BlockError);
});

test("element ⇄ view mapping: markers, strict parse + soft load", () => {
  const el = blockRefElement(blockRefToProps(makeBlockRef({ layer: "0", blockId: "blk-000001", x: 1, y: 2, scale: 1, rotation: 0 })));
  assert.equal(isBlockRefElement(el), true);
  assert.equal(isXrefRefElement(el), false);
  const view = elementToBlockRef(el);
  assert.equal(view.blockId, "blk-000001");
  const soft = blockRefFromElement({ ...el, props: { drafting: true, type: "block-ref" } });
  assert.equal(soft, null); // malformed → honest null, never a throw
  const xrefEl = blockRefElement(xrefRefToProps(makeXrefRef({ layer: "0", xrefId: "xr-000001", x: 0, y: 0, scale: 1, rotation: 0 })));
  assert.equal(isXrefRefElement(xrefEl), true);
  assert.equal(isBlockRefElement(xrefEl), false);
});

// ---------------------------------------------------------------------------
// The inline-entity vocabulary (normalization).
// ---------------------------------------------------------------------------

test("normalizeBlockEntity: canonical geometry round-trips + display passthrough", () => {
  const g = normalizeBlockEntity({ type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "Walls", color: "#ff0000" }, 0);
  assert.equal(g.type, "line");
  assert.equal(g.layer, "Walls");
  assert.equal(g.color, "#ff0000");
  const c = normalizeBlockEntity({ type: "circle", cx: 0, cy: 0, r: 5 }, 1);
  assert.deepEqual(c, { type: "circle", cx: 0, cy: 0, r: 5 });
});

test("normalizeBlockEntity: out-of-vocabulary + malformed records are typed failures", () => {
  assert.throws(() => normalizeBlockEntity({ type: "dim-linear" }, 0), BlockError);
  assert.throws(() => normalizeBlockEntity({ type: "bim.wall" }, 0), BlockError);
  assert.throws(() => normalizeBlockEntity({ type: "circle", cx: 0, cy: 0, r: -1 }, 0), BlockError);
  assert.throws(() => normalizeBlockEntity({}, 0), BlockError);
  assert.throws(() => normalizeBlockEntity({ type: "line", x1: "a", y1: 0, x2: 1, y2: 0 }, 0), BlockError);
});

test("normalizeBlockEntity: text + attdef + nested block-ref canonical forms", () => {
  const t = normalizeBlockEntity({ type: "text", layer: "0", x: 1, y: 2, height: 3, rotation: 0, value: "Label", style: "Notes" }, 0);
  assert.equal(t.value, "Label");
  assert.equal(t.style, "Notes");
  assert.throws(() => normalizeBlockEntity({ type: "text", layer: "0", x: 1, y: 2, height: 0, rotation: 0, value: "x" }, 0), BlockError);
  const a = normalizeBlockEntity({ type: "attdef", tag: "REV", default: "0", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 }, 0);
  assert.equal(a.tag, "REV");
  const n = normalizeBlockEntity({ type: "block-ref", layer: "0", blockId: "blk-000002", x: 0, y: 0, scale: 1, rotation: 0 }, 0);
  assert.equal(n.blockId, "blk-000002");
});

test("normalizeBlockEntities: index-named failures", () => {
  try {
    normalizeBlockEntities([{ type: "line", x1: 0, y1: 0, x2: 1, y2: 0 }, { type: "nonsense" }]);
    assert.fail("expected a typed failure");
  } catch (e) {
    assert.ok((e as Error).message.includes("entities[1]"), (e as Error).message);
  }
});

// ---------------------------------------------------------------------------
// The similarity transform (exact math).
// ---------------------------------------------------------------------------

test("simFromPlacement: p ↦ ins + R(rot)·(s·(p − base)) — exact", () => {
  const m = simFromPlacement({ x: 100, y: 50 }, { x: 10, y: 0 }, 2, Math.PI / 2);
  const p = applySim(m, { x: 10, y: 0 }); // the base point maps to the insertion
  assert.ok(Math.abs(p.x - 100) < TOL && Math.abs(p.y - 50) < TOL);
  const q = applySim(m, { x: 20, y: 0 }); // +10 along the def X axis → +20 along world Y
  assert.ok(Math.abs(q.x - 100) < TOL && Math.abs(q.y - 70) < TOL);
});

test("composeSim: nested similarities collapse exactly (outer ∘ inner)", () => {
  const inner = simFromPlacement({ x: 5, y: 5 }, { x: 1, y: 1 }, 2, Math.PI / 2);
  const outer = simFromPlacement({ x: 100, y: 100 }, { x: 0, y: 0 }, 3, Math.PI / 2);
  const composed = composeSim(outer, inner);
  const viaInner = applySim(outer, applySim(inner, { x: 2, y: 1 }));
  const viaComposed = applySim(composed, { x: 2, y: 1 });
  assert.ok(Math.abs(viaInner.x - viaComposed.x) < TOL && Math.abs(viaInner.y - viaComposed.y) < TOL);
});

test("transformGeomBySim: scale → rotate → translate is exact for circles/arcs/lines", () => {
  const m = simFromPlacement({ x: 50, y: 0 }, { x: 0, y: 0 }, 2, Math.PI / 2);
  const circle = transformGeomBySim({ type: "circle", cx: 5, cy: 0, r: 3 }, m);
  if (circle.type !== "circle") assert.fail("circle stays a circle under a similarity");
  assert.ok(Math.abs(circle.cx - 50) < TOL && Math.abs(circle.cy - 10) < TOL && Math.abs(circle.r - 6) < TOL);
  const line = transformGeomBySim({ type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }, m);
  if (line.type !== "line") assert.fail("expected a line");
  assert.ok(Math.abs(line.x2 - 50) < TOL && Math.abs(line.y2 - 20) < TOL);
  const arc = transformGeomBySim({ type: "arc", cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: Math.PI / 2 }, m);
  if (arc.type !== "arc") assert.fail("expected an arc");
  assert.ok(Math.abs(arc.startAngle - Math.PI / 2) < TOL);
});

// ---------------------------------------------------------------------------
// The expansion (definition → instance propagation, derived).
// ---------------------------------------------------------------------------

test("expandBlockInstance: geometry + text transform exactly; layers travel with content", () => {
  const d = def("blk-000001", "SYMBOL", [
    { type: "line", x1: 0, y1: 0, x2: 10, y2: 0, layer: "Content" },
    { type: "circle", cx: 5, cy: 5, r: 2, layer: "0" },
    { type: "text", layer: "0", x: 0, y: -5, height: 2, rotation: 0, value: "TAG" },
  ], { x: 0, y: 0 });
  const out = expandBlockInstance(
    makeBlockRef({ layer: "InstanceLayer", blockId: "blk-000001", x: 100, y: 200, scale: 2, rotation: Math.PI / 2 }),
    tableOf([d]),
  );
  assert.equal(out.length, 3);
  const line = out[0]!;
  assert.equal(line.kind, "geometry");
  if (line.kind === "geometry") {
    assert.equal(line.props.layer, "Content"); // content layer, NOT the instance layer
    assert.equal(line.props.x2, 100); // rotated +10 def-X → +20 world-Y, scaled 2
    assert.ok(Math.abs((line.props.y2 as number) - 220) < TOL);
  }
  const text = out[2]!;
  if (text.kind !== "text") assert.fail("expected materialized text");
  assert.equal(text.props.value, "TAG");
  assert.equal(text.props.height, 4); // height × scale
  assert.ok(Math.abs((text.props.rotation as number) - Math.PI / 2) < TOL); // rotation + instance rotation
});

test("expandBlockInstance: base point anchors the insertion", () => {
  const d = def("blk-000001", "ANCHORED", [{ type: "circle", cx: 30, cy: 40, r: 5 }], { x: 30, y: 40 });
  const out = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000001", x: 500, y: 500, scale: 1, rotation: 0 }),
    tableOf([d]),
  );
  if (out[0]!.kind !== "geometry") assert.fail();
  assert.ok(Math.abs((out[0]!.props.cx as number) - 500) < TOL);
  assert.ok(Math.abs((out[0]!.props.cy as number) - 500) < TOL);
});

test("expandBlockInstance: attributes materialize (value → default → nothing)", () => {
  const d = def("blk-000001", "TITLED", [
    { type: "attdef", tag: "TITLE", default: "Untitled", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
    { type: "attdef", tag: "EMPTY", layer: "0", x: 0, y: 5, height: 2.5, rotation: 0 },
  ]);
  // Instance value wins.
  const withValue = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "TITLE", value: "Plan B" }] }),
    tableOf([d]),
  );
  assert.equal(withValue.length, 1); // TITLE rendered; EMPTY skipped (no value AND no default)
  assert.equal(withValue[0]!.kind, "text");
  if (withValue[0]!.kind === "text") assert.equal(withValue[0]!.props.value, "Plan B");
  // Default renders when no value stored.
  const withDefault = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }),
    tableOf([d]),
  );
  if (withDefault[0]!.kind === "text") assert.equal(withDefault[0]!.props.value, "Untitled");
});

test("expandBlockInstance: nested blocks compose exactly (two levels)", () => {
  const inner = def("blk-000001", "INNER", [{ type: "circle", cx: 0, cy: 0, r: 5 }]);
  // INNER placed at def coords (10, 0), scale 2, rotation 0 inside OUTER.
  const outer = def("blk-000002", "OUTER", [
    { type: "block-ref", layer: "0", blockId: "blk-000001", x: 10, y: 0, scale: 2, rotation: 0 },
  ]);
  // OUTER instance at (100, 100), scale 1, rotation 90°.
  const out = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000002", x: 100, y: 100, scale: 1, rotation: Math.PI / 2 }),
    tableOf([inner, outer]),
  );
  assert.equal(out.length, 1);
  if (out[0]!.kind !== "geometry") assert.fail("nested content expands to geometry");
  // The nested circle center: world = 100,100 + R(90°)·(10, 0) = (100, 110);
  // radius = 5 × 2 (nested scale) × 1 (outer scale) = 10.
  assert.ok(Math.abs((out[0]!.props.cx as number) - 100) < TOL);
  assert.ok(Math.abs((out[0]!.props.cy as number) - 110) < TOL);
  assert.ok(Math.abs((out[0]!.props.r as number) - 10) < TOL);
});

test("expandBlockInstance: nested attdefs use the NESTED ref's own values", () => {
  const inner = def("blk-000001", "INNER", [
    { type: "attdef", tag: "TAG", default: "inner-default", layer: "0", x: 0, y: 0, height: 2.5, rotation: 0 },
  ]);
  const outer = def("blk-000002", "OUTER", [
    { type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "TAG", value: "nested-value" }] },
  ]);
  const out = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000002", x: 0, y: 0, scale: 1, rotation: 0, attributes: [{ tag: "OTHER", value: "top-level-only" }] }),
    tableOf([inner, outer]),
  );
  assert.equal(out.length, 1);
  if (out[0]!.kind === "text") assert.equal(out[0]!.props.value, "nested-value");
});

test("expandBlockInstance: a missing definition renders the honest placeholder", () => {
  const out = expandBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-999999", x: 10, y: 20, scale: 1, rotation: 0 }),
    tableOf([]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "placeholder");
  if (out[0]!.kind === "placeholder") {
    assert.ok(out[0]!.label.includes("blk-999999"));
  }
});

test("expandXrefInstance: loaded content expands at the origin base; unresolved renders the placeholder", () => {
  const loaded: XrefRecord = {
    id: "xr-000001", name: "SITE", path: "site.offisos", status: "loaded",
    sourceHash: "a".repeat(64), attachedAt: "2026-01-01T00:00:00.000Z",
    entities: [{ type: "line", x1: 0, y1: 0, x2: 100, y2: 0, layer: "0" }],
  };
  const unresolved: XrefRecord = {
    id: "xr-000002", name: "MISSING", path: "missing.offisos", status: "unresolved",
    sourceHash: null, attachedAt: "2026-01-01T00:00:00.000Z", entities: [],
  };
  const t = tableOf([], [loaded, unresolved]);
  const a = expandXrefInstance(makeXrefRef({ layer: "0", xrefId: "xr-000001", x: 50, y: 50, scale: 1, rotation: 0 }), t);
  assert.equal(a.length, 1);
  if (a[0]!.kind === "geometry") assert.equal(a[0]!.props.x2, 150);
  const b = expandXrefInstance(makeXrefRef({ layer: "0", xrefId: "xr-000002", x: 0, y: 0, scale: 1, rotation: 0 }), t);
  assert.equal(b.length, 1);
  assert.equal(b[0]!.kind, "placeholder");
  if (b[0]!.kind === "placeholder") assert.ok(b[0]!.label.includes("MISSING"));
  const c = expandXrefInstance(makeXrefRef({ layer: "0", xrefId: "xr-999999", x: 0, y: 0, scale: 1, rotation: 0 }), t);
  assert.equal(c[0]!.kind, "placeholder");
});

test("expandedBounds: unions geometry + text + placeholder boxes", () => {
  const d = def("blk-000001", "B", [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "text", layer: "0", x: 0, y: 10, height: 2, rotation: 0, value: "ABCDE" },
  ]);
  const bounds = expandedBounds(
    expandBlockInstance(makeBlockRef({ layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }), tableOf([d])),
  );
  assert.ok(bounds !== null);
  assert.equal(bounds!.minX, 0);
  assert.equal(bounds!.maxX, 100);
  assert.ok(Math.abs(bounds!.maxY - 12) < TOL); // text top edge
});

// ---------------------------------------------------------------------------
// The one-level explode materialization.
// ---------------------------------------------------------------------------

test("explodeBlockInstance: direct content materializes; nested refs become independent elements; attributes become text", () => {
  const inner = def("blk-000001", "INNER", [{ type: "circle", cx: 0, cy: 0, r: 5 }]);
  const outer = def("blk-000002", "OUTER", [
    { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
    { type: "attdef", tag: "TITLE", default: "D", layer: "0", x: 0, y: 1, height: 2, rotation: 0 },
    { type: "block-ref", layer: "0", blockId: "blk-000001", x: 20, y: 0, scale: 1, rotation: 0 },
  ], { x: 0, y: 0 });
  const pieces = explodeBlockInstance(
    makeBlockRef({ layer: "0", blockId: "blk-000002", x: 100, y: 100, scale: 2, rotation: 0, attributes: [{ tag: "TITLE", value: "V" }] }),
    tableOf([inner, outer]),
  );
  assert.equal(pieces.length, 3);
  // Geometry: scaled ×2 + translated.
  if (pieces[0]!.kind !== "geometry") assert.fail();
  assert.equal(pieces[0]!.props.x2, 120);
  // Attribute → text with the INSTANCE value.
  if (pieces[1]!.kind !== "text") assert.fail();
  assert.equal(pieces[1]!.props.value, "V");
  assert.equal(pieces[1]!.props.height, 4);
  // Nested ref → independent block-ref element with composed placement.
  if (pieces[2]!.kind !== "block-ref") assert.fail();
  assert.equal(pieces[2]!.props.blockId, "blk-000001");
  assert.equal(pieces[2]!.props.x, 140); // (20, 0) × 2 + (100, 100)
  assert.equal(pieces[2]!.props.y, 100);
  assert.equal(pieces[2]!.props.scale, 2);
});

test("explodeBlockInstance: a missing definition is a typed failure", () => {
  assert.throws(
    () => explodeBlockInstance(makeBlockRef({ layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }), tableOf([])),
    BlockError,
  );
});

// ---------------------------------------------------------------------------
// The definition-graph gates (cycles + bounded nesting).
// ---------------------------------------------------------------------------

test("assertDefinitionGraph: self-reference and mutual cycles are typed failures", () => {
  const self: Record<string, unknown>[] = [{ type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }];
  assert.throws(() => assertDefinitionGraph("blk-000001", self, () => self), BlockError);
  const a: Record<string, unknown>[] = [{ type: "block-ref", layer: "0", blockId: "blk-000002", x: 0, y: 0, scale: 1, rotation: 0 }];
  const b: Record<string, unknown>[] = [{ type: "block-ref", layer: "0", blockId: "blk-000001", x: 0, y: 0, scale: 1, rotation: 0 }];
  assert.throws(() => assertDefinitionGraph("blk-000001", a, (id) => (id === "blk-000001" ? a : b)), BlockError);
});

test("assertDefinitionGraph: deep chains beyond the cap are typed failures; the cap is bounded", () => {
  assert.ok(MAX_BLOCK_NESTING_DEPTH >= 2 && MAX_BLOCK_NESTING_DEPTH <= 16);
  // A linear chain of length 9 (depth 9 > 8).
  const chain = new Map<string, Record<string, unknown>[]>();
  for (let i = 1; i <= 9; i++) {
    chain.set(`blk-${String(i).padStart(6, "0")}`, [
      { type: "block-ref", layer: "0", blockId: `blk-${String(i + 1).padStart(6, "0")}`, x: 0, y: 0, scale: 1, rotation: 0 },
    ]);
  }
  chain.set("blk-000010", []);
  assert.throws(
    () => assertDefinitionGraph("blk-000001", chain.get("blk-000001")!, (id) => chain.get(id)),
    (e: unknown) => e instanceof BlockError && e.code === "block_depth",
  );
});

test("referencedBlockIds + attdefTagsOf + attributeValue helpers", () => {
  const entities: Record<string, unknown>[] = [
    { type: "line", x1: 0, y1: 0, x2: 1, y2: 0 },
    { type: "block-ref", layer: "0", blockId: "blk-000009", x: 0, y: 0, scale: 1, rotation: 0 },
    { type: "attdef", tag: "A", layer: "0", x: 0, y: 0, height: 2, rotation: 0 },
  ];
  assert.deepEqual(referencedBlockIds(entities), ["blk-000009"]);
  assert.deepEqual(attdefTagsOf(entities), ["A"]);
  assert.equal(attributeValue([{ tag: "A", value: "v" }], "A", "d"), "v");
  assert.equal(attributeValue([], "A", "d"), "d");
  assert.equal(attributeValue([], "A", undefined), null);
});
