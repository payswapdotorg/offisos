/**
 * CAD-PARITY-006 block expansion (Issue #84) — the ONE shared derived
 * content pipeline: block/xref instance → world-space entities.
 *
 * Every consumer of instance content — BOTH host renderers, the pick
 * surfaces, EXPLODE, the bounds/zoom computation — expands through THIS
 * module so the derived view is identical everywhere (LOCK-004 Web/Electron
 * parity; definition → instance propagation without duplication: the
 * instance stores only placement + attribute values, the definition is the
 * single source of content truth, and a definition edit changes every
 * instance on the next expansion).
 *
 * The transform model is a REFLECTED SIMILARITY (COMPAT-CAD-004: uniform
 * positive scale × rotation × optional reflection × translation). The
 * unreflected placement (every pre-COMPAT-CAD-004 instance) is the pure
 * similarity p ↦ (ix, iy) + R(θ)·(s·(p − base)); a MIRRORED instance
 * (created by pattern.mirror) renders through p ↦ (ix, iy) +
 * R(θ)·diag(1, −1)·(s·(p − base)) — the bounded deterministic mirror for
 * symbol instances (no negative/non-uniform scale fields; non-uniform
 * scaling remains a typed unsupported case). Mirroring twice returns to
 * the unreflected form (the placement flips the handedness flag).
 *
 * Geometry is transformed through the verified CAD-PARITY-003 kernel
 * (scaleGeom → rotateGeom → moveGeom about the origin, exact for
 * similarities); text/attdef positions transform the same way with
 * height × s and rotation + θ. Nested references COMPOSE similarities, so
 * arbitrary nesting collapses to one exact similarity per level.
 *
 * Attribute materialization: an attdef renders as a text entity whose value
 * is the instance's stored value for the tag, else the definition default,
 * else nothing (an empty slot). Nested references use their OWN inline
 * attribute values (AutoCAD semantics — only the top-level insert's slots
 * prompt at INSERT time).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { BlockDefinitionRecord, XrefRecord } from "../../contracts/caddocument.js";
import type { Geom } from "../geometry/types.js";
import { propsToGeom } from "../geometry/types.js";
import { mirrorGeom, moveGeom, rotateGeom, scaleGeom } from "../geometry/transform.js";
import { bbox, type BBox } from "../geometry/entities.js";
import { normAngle, Pt, TAU } from "../geometry/math2d.js";
import {
  attributeValue,
  BlockError,
  blockRefFromElement,
  isBlockRefElement,
  isXrefRefElement,
  xrefRefFromElement,
  type BlockRefView,
  type XrefRefView,
} from "./types.js";
import type { Element } from "../../contracts/caddocument.js";

// ---------------------------------------------------------------------------
// The reflected similarity transform (uniform scale × rotation × optional
// reflection × translation — COMPAT-CAD-004 extends the pure similarity
// with the `ref` handedness component; ref = 1 is the exact legacy form).
// ---------------------------------------------------------------------------

export interface Sim2 {
  /** Uniform positive scale. */
  readonly s: number;
  /** Rotation in radians (composed with the reflection law — see
   *  composeSim). */
  readonly rot: number;
  /** The handedness: 1 = the unreflected similarity (the exact legacy
   *  form); −1 = the reflected similarity R(rot)·diag(1, −1)·s. */
  readonly ref: 1 | -1;
  readonly tx: number;
  readonly ty: number;
}

export const IDENTITY_SIM: Sim2 = { s: 1, rot: 0, ref: 1, tx: 0, ty: 0 };

/** The (reflected) similarity of an instance placement:
 *  p ↦ ins + R(rot)·diag(1, ref)·(s·(p − base)). */
export function simFromPlacement(
  ins: Pt,
  base: Pt,
  scale: number,
  rotation: number,
  mirrored?: boolean,
): Sim2 {
  const ref: 1 | -1 = mirrored === true ? -1 : 1;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    s: scale,
    rot: rotation,
    ref,
    tx: ins.x - scale * (cos * base.x - ref * sin * base.y),
    ty: ins.y - scale * (sin * base.x + ref * cos * base.y),
  };
}

export function applySim(m: Sim2, p: Pt): Pt {
  const cos = Math.cos(m.rot);
  const sin = Math.sin(m.rot);
  return {
    x: m.s * (cos * p.x - m.ref * sin * p.y) + m.tx,
    y: m.s * (sin * p.x + m.ref * cos * p.y) + m.ty,
  };
}

/** Compose: apply(inner) first, then(outer) — the nested-reference matrix.
 *  Reflection law (COMPAT-CAD-004): D(f)·R(a) = R(a·f)·D(f), so
 *  R(b)·D(F)·R(a)·D(f) = R(b + a·F)·D(f·F) — the INNER rotation is
 *  conjugated by the OUTER reflection and the handedness multiplies. With
 *  F = 1 this is exactly the legacy additive law (byte-identical behavior
 *  for every unreflected composition). */
export function composeSim(outer: Sim2, inner: Sim2): Sim2 {
  // outer(inner(p)) = s2·R(r2)·D(F2)·(s1·R(r1)·D(F1)·p + t1) + t2
  const lin = applySimLinear(outer, { x: inner.tx, y: inner.ty });
  return {
    s: inner.s * outer.s,
    rot: outer.rot + inner.rot * outer.ref,
    ref: (inner.ref * outer.ref) as 1 | -1,
    tx: lin.x + outer.tx,
    ty: lin.y + outer.ty,
  };
}

function applySimLinear(m: Sim2, p: Pt): Pt {
  const cos = Math.cos(m.rot);
  const sin = Math.sin(m.rot);
  return { x: m.s * (cos * p.x - m.ref * sin * p.y), y: m.s * (sin * p.x + m.ref * cos * p.y) };
}

/** Transform canonical geometry by a (reflected) similarity (exact: scale
 *  about the origin → [reflected: mirror about the X axis] → rotation about
 *  the origin → translation — the verified CAD-PARITY-003 kernel operators
 *  in composition order; mirrorGeom is exact for arcs/ellipses/regions
 *  (sweep/axis angles reflect — never a guessed approximation). */
export function transformGeomBySim(g: Geom, m: Sim2): Geom {
  let out = g;
  if (m.s !== 1) out = scaleGeom(out, { x: 0, y: 0 }, m.s);
  if (m.ref === -1) out = mirrorGeom(out, { x: 0, y: 0 }, { x: 1, y: 0 });
  if (m.rot !== 0) out = rotateGeom(out, { x: 0, y: 0 }, m.rot);
  if (m.tx !== 0 || m.ty !== 0) out = moveGeom(out, m.tx, m.ty);
  return out;
}

// ---------------------------------------------------------------------------
// The expansion result vocabulary (what hosts render/pick/explode).
// ---------------------------------------------------------------------------

/** One world-space derived entity of an expanded instance. */
export type ExpandedEntity =
  | {
      /** Canonical flat geometry props (CAD-PARITY-003 convention) incl.
       *  the content's own layer/display fields. */
      readonly kind: "geometry";
      readonly props: Record<string, unknown>;
    }
  | {
      /** A materialized text entity (CAD-PARITY-005 text props — content
       *  text or a materialized attribute value). */
      readonly kind: "text";
      readonly props: Record<string, unknown>;
    }
  | {
      /** An unresolved-reference placeholder: a dashed box + label (the
       *  honest diagnostic rendering — never a silent blank). */
      readonly kind: "placeholder";
      readonly box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
      readonly label: string;
    };

/** The table lookups the expansion needs (the document's block/xref tables). */
export interface BlockTable {
  readonly blockDefById: (id: string) => BlockDefinitionRecord | undefined;
  readonly xrefById: (id: string) => XrefRecord | undefined;
}

// ---------------------------------------------------------------------------
// Entity-level transformation.
// ---------------------------------------------------------------------------

const DISPLAY_KEYS: readonly string[] = ["layer", "color", "linetype", "lineweight", "transparency"];

function displayOf(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DISPLAY_KEYS) {
    if (props[key] !== undefined) out[key] = props[key];
  }
  return out;
}

/** Transform one inline entity by a similarity. Returns null when the entity
 *  renders nothing (an attdef whose slot resolves to no value). */
function transformEntity(
  entity: Record<string, unknown>,
  m: Sim2,
  attributeValues: readonly { tag: string; value: string }[] | undefined,
): ExpandedEntity | null {
  const type = entity.type;

  if (type === "block-ref") {
    // Nested reference — recursed by the caller (expandDefinition).
    return null;
  }

  if (type === "attdef") {
    const tag = typeof entity.tag === "string" ? entity.tag : "";
    const value = attributeValue(
      attributeValues ?? [],
      tag,
      typeof entity.default === "string" ? entity.default : undefined,
    );
    if (value === null) return null;
    return transformTextLike(entity, m, value);
  }

  if (type === "text") {
    const value = typeof entity.value === "string" ? entity.value : "";
    if (value.length === 0) return null;
    return transformTextLike(entity, m, value);
  }

  // Geometry — through the canonical decoder (invalid records cannot be
  // stored; a defensive null is skipped honestly rather than guessed).
  const geom = propsToGeom(entity);
  if (geom === null) return null;
  const world = transformGeomBySim(geom, m);
  const props: Record<string, unknown> = { ...(world as unknown as Record<string, unknown>), ...displayOf(entity) };
  return { kind: "geometry", props };
}

function transformTextLike(
  entity: Record<string, unknown>,
  m: Sim2,
  value: string,
): ExpandedEntity {
  const p = applySim(m, {
    x: typeof entity.x === "number" ? entity.x : 0,
    y: typeof entity.y === "number" ? entity.y : 0,
  });
  const height = (typeof entity.height === "number" ? entity.height : 2.5) * m.s;
  // COMPAT-CAD-004 (MIRRTEXT=0, the drawing-office default): text inside a
  //  MIRRORED instance stays LEGIBLE — the position transforms with the
  //  reflected similarity, the rotation follows the unreflected frame
  //  (local + rot), and when that lands in the upside-down half-plane
  //  (π/2 .. 3π/2) it flips by π so the text reads left-to-right — never
  //  a backwards-reading mirror. Unreflected placements are EXACTLY the
  //  legacy behavior (no flip check runs).
  const base = normAngle((typeof entity.rotation === "number" ? entity.rotation : 0) + m.rot);
  const rotation = m.ref === -1 && base > Math.PI / 2 && base < (3 * Math.PI) / 2 ? normAngle(base + Math.PI) : base;
  const props: Record<string, unknown> = {
    type: "text",
    layer: typeof entity.layer === "string" && entity.layer.length > 0 ? entity.layer : "0",
    x: p.x,
    y: p.y,
    height,
    rotation,
    value,
  };
  if (typeof entity.style === "string") props.style = entity.style;
  if (typeof entity.hAlign === "string") props.hAlign = entity.hAlign;
  if (typeof entity.vAlign === "string") props.vAlign = entity.vAlign;
  return { kind: "text", props };
}

// ---------------------------------------------------------------------------
// The expansion (recursive over nested definitions — bounded by the
// write-time cycle + depth gates).
// ---------------------------------------------------------------------------

/** Expand one definition's inline content under a similarity matrix. */
function expandDefinition(
  def: BlockDefinitionRecord,
  m: Sim2,
  table: BlockTable,
  attributeValues: readonly { tag: string; value: string }[] | undefined,
  out: ExpandedEntity[],
): void {
  for (const entity of def.entities) {
    if (entity.type === "block-ref" && typeof entity.blockId === "string") {
      // Nested reference: compose matrices and recurse. A missing (cannot
      // happen through the reference-checked removal) or malformed nested
      // target renders the honest placeholder instead of crashing a host.
      const child = table.blockDefById(entity.blockId);
      if (child === undefined) {
        out.push(placeholderAt(applySim(m, { x: 0, y: 0 }), `unresolved block ${String(entity.blockId)}`));
        continue;
      }
      const nested: BlockRefView = {
        type: "block-ref",
        layer: typeof entity.layer === "string" ? entity.layer : "0",
        blockId: entity.blockId,
        x: typeof entity.x === "number" ? entity.x : 0,
        y: typeof entity.y === "number" ? entity.y : 0,
        scale: typeof entity.scale === "number" ? entity.scale : 1,
        rotation: typeof entity.rotation === "number" ? entity.rotation : 0,
        ...(Array.isArray(entity.attributes)
          ? { attributes: entity.attributes as { tag: string; value: string }[] }
          : {}),
        // COMPAT-CAD-004 (additive): a nested reference stored in its
        //  mirrored form composes with the parent's reflection law.
        ...(entity.mirrored === true ? { mirrored: true as const } : {}),
      };
      const childSim = simFromPlacement({ x: nested.x, y: nested.y }, child.basePoint, nested.scale, nested.rotation, nested.mirrored);
      expandDefinition(child, composeSim(m, childSim), table, nested.attributes, out);
      continue;
    }
    const expanded = transformEntity(entity, m, attributeValues);
    if (expanded !== null) out.push(expanded);
  }
}

/** The canonical unresolved placeholder box at a world point. */
function placeholderAt(at: Pt, label: string): ExpandedEntity {
  const s = 100; // XREF_PLACEHOLDER_SIZE — duplicated locally to avoid a cycle-ish re-import noise
  return {
    kind: "placeholder",
    box: { minX: at.x, minY: at.y, maxX: at.x + s, maxY: at.y + s },
    label,
  };
}

/**
 * Expand a block instance into its world-space derived entities (render,
 * pick, explode, bounds — the ONE shared view). A missing definition (the
 * reference-checked removal makes this unreachable through edits; defensive
 * for hand-built documents) renders the honest placeholder.
 */
export function expandBlockInstance(ref: BlockRefView, table: BlockTable): readonly ExpandedEntity[] {
  const def = table.blockDefById(ref.blockId);
  if (def === undefined) {
    return [placeholderAt({ x: ref.x, y: ref.y }, `unresolved block ${ref.blockId}`)];
  }
  const m = simFromPlacement({ x: ref.x, y: ref.y }, def.basePoint, ref.scale, ref.rotation, ref.mirrored);
  const out: ExpandedEntity[] = [];
  expandDefinition(def, m, table, ref.attributes, out);
  return out;
}

/**
 * Expand an xref instance. A LOADED reference expands its inline content
 * (base point fixed at the origin — external snapshot coordinates map
 * directly); an UNRESOLVED reference renders the canonical placeholder box
 * + name (the diagnostic rendering).
 */
export function expandXrefInstance(ref: XrefRefView, table: BlockTable): readonly ExpandedEntity[] {
  const record = table.xrefById(ref.xrefId);
  if (record === undefined) {
    return [placeholderAt({ x: ref.x, y: ref.y }, `unresolved reference`)];
  }
  if (record.status !== "loaded" || record.entities.length === 0) {
    return [placeholderAt({ x: ref.x, y: ref.y }, `${record.name} (unresolved)`)];
  }
  const m = simFromPlacement({ x: ref.x, y: ref.y }, { x: 0, y: 0 }, ref.scale, ref.rotation);
  const out: ExpandedEntity[] = [];
  // Xref content has no nested references (attach converts only geometry +
  // text — bounded slice), so a flat walk over the entities is exact.
  for (const entity of record.entities) {
    if (entity.type === "attdef") continue; // xref content never carries attdefs
    const expanded = transformEntity(entity, m, undefined);
    if (expanded !== null) out.push(expanded);
  }
  return out;
}

/** Expand either instance kind from an element (null for non-instances;
 *  malformed instance props read as their honest placeholder). */
export function expandInstanceElement(el: Element, table: BlockTable): readonly ExpandedEntity[] | null {
  const blockRef = blockRefFromElement(el);
  if (blockRef !== null) return expandBlockInstance(blockRef, table);
  const xrefRef = xrefRefFromElement(el);
  if (xrefRef !== null) return expandXrefInstance(xrefRef, table);
  return null;
}

// ---------------------------------------------------------------------------
// One-level EXPLODE materialization (AutoCAD semantics: the definition's
// DIRECT content becomes independent elements; nested references stay
// references — one level per explode).
// ---------------------------------------------------------------------------

/** One materialized piece of an exploded block instance. */
export type ExplodedPiece =
  | { readonly kind: "geometry"; readonly props: Record<string, unknown> }
  | { readonly kind: "text"; readonly props: Record<string, unknown> }
  | {
      /** A nested reference materialized as an independent block-ref
       *  ELEMENT (composed placement — exploding again descends a level). */
      readonly kind: "block-ref";
      readonly props: Record<string, unknown>;
    };

/**
 * Materialize ONE LEVEL of a block instance: every direct entity of the
 * definition, transformed by the instance similarity; attribute definitions
 * become text entities carrying the instance's value (or the default);
 * nested references become independent block-ref elements with the COMPOSED
 * placement (blockId + the nested ref's own attribute values carried).
 * A missing definition is a typed failure (the reference-checked removal
 * keeps this unreachable through edits; hand-built worlds are rejected).
 */
export function explodeBlockInstance(
  ref: BlockRefView,
  table: BlockTable,
): readonly ExplodedPiece[] {
  const def = table.blockDefById(ref.blockId);
  if (def === undefined) {
    throw new BlockError(`block definition '${ref.blockId}' no longer exists — cannot explode`, "bad_id");
  }
  const m = simFromPlacement({ x: ref.x, y: ref.y }, def.basePoint, ref.scale, ref.rotation, ref.mirrored);
  const out: ExplodedPiece[] = [];
  for (const entity of def.entities) {
    if (entity.type === "block-ref" && typeof entity.blockId === "string") {
      // Nested reference: compose the placement into an independent element.
      // COMPAT-CAD-004: the composed placement follows the reflection law —
      // rotation' = m.rot + nestedRotation·m.ref, handedness multiplies —
      // so exploding a mirrored instance yields correctly-handed nested
      // instances (never a silently flipped copy).
      const nestedX = typeof entity.x === "number" ? entity.x : 0;
      const nestedY = typeof entity.y === "number" ? entity.y : 0;
      const nestedScale = typeof entity.scale === "number" ? entity.scale : 1;
      const nestedRotation = typeof entity.rotation === "number" ? entity.rotation : 0;
      const at = applySim(m, { x: nestedX, y: nestedY });
      const composedMirrored = (entity.mirrored === true) !== (m.ref === -1);
      out.push({
        kind: "block-ref",
        props: {
          drafting: true,
          type: "block-ref",
          layer: typeof entity.layer === "string" && entity.layer.length > 0 ? entity.layer : "0",
          blockId: entity.blockId,
          x: at.x,
          y: at.y,
          scale: m.s * nestedScale,
          rotation: normAngle(m.rot + nestedRotation * m.ref),
          ...(Array.isArray(entity.attributes)
            ? { attributes: entity.attributes as { tag: string; value: string }[] }
            : {}),
          ...(composedMirrored ? { mirrored: true } : {}),
        },
      });
      continue;
    }
    const expanded = transformEntity(entity, m, ref.attributes);
    if (expanded === null) continue;
    if (expanded.kind === "geometry" || expanded.kind === "text") {
      out.push(expanded);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounds (zoom extents / pick prefiltering over the DERIVED content).
// ---------------------------------------------------------------------------

/** The world bounding box of expanded entities (null when nothing draws). */
export function expandedBounds(entities: readonly ExpandedEntity[]): BBox | null {
  let out: BBox | null = null;
  for (const e of entities) {
    if (e.kind === "placeholder") {
      const box: BBox = { minX: e.box.minX, minY: e.box.minY, maxX: e.box.maxX, maxY: e.box.maxY };
      out = out === null ? box : unionBBox(out, box);
      continue;
    }
    if (e.kind === "text") {
      const value = typeof e.props.value === "string" ? e.props.value : "";
      const height = typeof e.props.height === "number" ? e.props.height : 0;
      const x = typeof e.props.x === "number" ? e.props.x : 0;
      const y = typeof e.props.y === "number" ? e.props.y : 0;
      const box: BBox = {
        minX: x,
        minY: y,
        maxX: x + value.length * 0.6 * height,
        maxY: y + height,
      };
      out = out === null ? box : unionBBox(out, box);
      continue;
    }
    const geom = propsToGeom(e.props);
    if (geom === null) continue;
    const geomBox = bbox(geom);
    if (geomBox === null) continue;
    out = out === null ? geomBox : unionBBox(out, geomBox);
  }
  return out;
}

function unionBBox(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Normalize an angle into [0, 2π) (re-exported convenience). */
export { normAngle, TAU };

/** Typed failure re-export (the module's public error surface). */
export { BlockError };
