/**
 * CAD-PARITY-006 block entity types (Issue #84) — the canonical blocks/
 * components/references vocabulary: block definitions, block instances
 * (block-ref elements), attribute definitions and external references.
 *
 * Block INSTANCES are CADDocument ELEMENTS with `kind: "geometry"`, the
 * `drafting: true` marker and `props.type: "block-ref"` (xref instances:
 * `"xref-ref"`). They participate in the CAD-PARITY-004 layer model exactly
 * like geometry/annotation entities (layer name in `props.layer`, display
 * overrides in `props.color/linetype/…`, the execute() locked/frozen gate
 * applies because the marker + layer are present).
 *
 * Storage layout (flat canonical convention — the CAD-PARITY-003/005 style;
 * every number finite — LOCK-007 rejects otherwise; every optional field is
 * ADDITIVE so legacy snapshots and the pinned CAD-PARITY-002/004/005 parity
 * fixtures stay byte-identical):
 *
 *   block-ref:  { drafting, type:"block-ref", layer,
 *                 blockId, x, y, scale, rotation, attributes?,
 *                 color?, linetype?, …display }
 *   xref-ref:   { drafting, type:"xref-ref", layer,
 *                 xrefId, x, y, scale, rotation, …display }
 *
 * Instance content is DERIVED from the referenced definition/xref record at
 * render/pick/explode time through the ONE shared expansion (expand.ts) —
 * never duplicated into the instance (definition → instance propagation).
 *
 * Inline entity vocabulary (definition/xref content — BlockEntityRecord):
 *   geometry — the CAD-PARITY-003 flat convention (line/polyline/circle/
 *              arc/ellipse/spline/point/ray/xline/region) + layer/display;
 *   text     — the CAD-PARITY-005 text convention (x, y, height, rotation,
 *              value, style?);
 *   attdef   — { type:"attdef", tag, prompt?, default?, x, y, height,
 *               rotation?, style? } — an attribute DEFINITION slot;
 *   block-ref— { type:"block-ref", blockId, x, y, scale, rotation,
 *               attributes? } — a NESTED reference (definition coordinates).
 *
 * Nesting is bounded: cycles are rejected and the total nesting depth is
 * capped (MAX_BLOCK_NESTING_DEPTH) at definition write time — render-time
 * expansion can never recurse unboundedly.
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../../contracts/caddocument.js";
import { normAngle, Pt } from "../geometry/math2d.js";
import { propsToGeom } from "../geometry/types.js";
import { makeText } from "../annotation/types.js";

// ---------------------------------------------------------------------------
// Typed failures (stable codes; LOCK-007/008).
// ---------------------------------------------------------------------------

export class BlockError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BlockError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants (bounded first slice — honest, documented limits).
// ---------------------------------------------------------------------------

/** The maximum block nesting depth (a definition referencing definitions
 *  referencing …). Depth 1 = plain content; deeper = nested blocks. */
export const MAX_BLOCK_NESTING_DEPTH = 8;

/** The canonical unresolved-xref placeholder extent (drawing mm) — the box
 *  AutoCAD-class references render when the external content is not
 *  available (bounded deterministic convention). */
export const XREF_PLACEHOLDER_SIZE = 100;

// ---------------------------------------------------------------------------
// Instance views (block-ref / xref-ref elements).
// ---------------------------------------------------------------------------

/** One per-instance attribute value (INSERT prompts each definition attdef;
 *  ATTEDIT rewrites values; absent tags render the definition default). */
export interface AttributeValue {
  readonly tag: string;
  readonly value: string;
}

export interface BlockRefView {
  readonly type: "block-ref";
  readonly layer: string;
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  /** Uniform scale factor (> 0). Non-uniform scaling is an explicit typed
   *  unsupported case in this slice (no negative/mirror scales either). */
  readonly scale: number;
  /** Rotation in radians CCW from +X. */
  readonly rotation: number;
  readonly attributes?: readonly AttributeValue[];
}

export interface XrefRefView {
  readonly type: "xref-ref";
  readonly layer: string;
  readonly xrefId: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
}

// ---------------------------------------------------------------------------
// Attribute definitions (inline attdef entities).
// ---------------------------------------------------------------------------

export interface AttdefRecord {
  readonly type: "attdef";
  readonly tag: string;
  readonly prompt?: string;
  /** The default value rendered when the instance carries no value for the
   *  tag (absent/empty = the tag itself is NOT rendered — an empty slot). */
  readonly default?: string;
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly rotation: number;
  readonly style?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function fin(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BlockError(`${field} must be a finite number`, "bad_input");
  }
  return v;
}

function pos(v: unknown, field: string): number {
  const n = fin(v, field);
  if (n <= 0) throw new BlockError(`${field} must be > 0`, "bad_input");
  return n;
}

function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new BlockError(`${field} must be a non-empty string`, "bad_input");
  }
  return v;
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return nonEmpty(v, field);
}

function ptOf(v: unknown, field: string): Pt {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new BlockError(`${field} must be {x, y}`, "bad_input");
  }
  const o = v as Record<string, unknown>;
  return { x: fin(o.x, `${field}.x`), y: fin(o.y, `${field}.y`) };
}

/** Attribute tag grammar: uppercase letters, digits, `_`, `-`, `.` — the
 *  drawing-office convention for template keys (e.g. "TITLE", "SHEET_NO"). */
const TAG_RE = /^[A-Z0-9_.-]+$/;

export function validAttributeTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

function attributesOf(v: unknown, field: string): readonly AttributeValue[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new BlockError(`${field} must be an array when present`, "bad_input");
  }
  const out: AttributeValue[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of v.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new BlockError(`${field}[${i}] must be an object`, "bad_input");
    }
    const o = raw as Record<string, unknown>;
    const tag = nonEmpty(o.tag, `${field}[${i}].tag`).toUpperCase();
    if (!validAttributeTag(tag)) {
      throw new BlockError(
        `${field}[${i}].tag must use A-Z, 0-9, '_', '-', '.' (got '${tag}')`,
        "bad_input",
      );
    }
    if (seen.has(tag)) {
      throw new BlockError(`${field}[${i}].tag '${tag}' is duplicated`, "bad_input");
    }
    seen.add(tag);
    if (typeof o.value !== "string") {
      throw new BlockError(`${field}[${i}].value must be a string`, "bad_input");
    }
    out.push({ tag, value: o.value });
  }
  return out.length === 0 ? undefined : out;
}

// ---------------------------------------------------------------------------
// Constructors (strict validation — LOCK-007: reject, never guess).
// ---------------------------------------------------------------------------

export function makeBlockRef(input: Record<string, unknown>): BlockRefView {
  const layer = nonEmpty(input.layer, "block-ref layer (the canonical default is '0')");
  const blockId = nonEmpty(input.blockId, "block-ref blockId");
  const x = fin(input.x, "block-ref x");
  const y = fin(input.y, "block-ref y");
  const scale = pos(input.scale, "block-ref scale");
  const rotation = fin(input.rotation, "block-ref rotation");
  const attributes = attributesOf(input.attributes, "block-ref attributes");
  return {
    type: "block-ref",
    layer,
    blockId,
    x,
    y,
    scale,
    rotation,
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

export function makeXrefRef(input: Record<string, unknown>): XrefRefView {
  const layer = nonEmpty(input.layer, "xref-ref layer (the canonical default is '0')");
  const xrefId = nonEmpty(input.xrefId, "xref-ref xrefId");
  const x = fin(input.x, "xref-ref x");
  const y = fin(input.y, "xref-ref y");
  const scale = pos(input.scale, "xref-ref scale");
  const rotation = fin(input.rotation, "xref-ref rotation");
  return { type: "xref-ref", layer, xrefId, x, y, scale, rotation };
}

export function makeAttdef(input: Record<string, unknown>): AttdefRecord {
  const tag = nonEmpty(input.tag, "attdef tag").toUpperCase();
  if (!validAttributeTag(tag)) {
    throw new BlockError(`attdef tag must use A-Z, 0-9, '_', '-', '.' (got '${tag}')`, "bad_input");
  }
  const prompt = optString(input.prompt, "attdef prompt");
  const def = input.default === undefined || input.default === null
    ? undefined
    : String(input.default);
  const layer = nonEmpty(input.layer, "attdef layer");
  const x = fin(input.x, "attdef x");
  const y = fin(input.y, "attdef y");
  const height = pos(input.height, "attdef height");
  const rotation = input.rotation === undefined || input.rotation === null ? 0 : fin(input.rotation, "attdef rotation");
  const style = optString(input.style, "attdef style");
  return {
    type: "attdef",
    tag,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(def !== undefined && def.length > 0 ? { default: def } : {}),
    layer,
    x,
    y,
    height,
    rotation,
    ...(style !== undefined ? { style } : {}),
  };
}

// ---------------------------------------------------------------------------
// Element ⇄ instance mapping.
// ---------------------------------------------------------------------------

/** Soft check: is this element a CAD-PARITY-006 block instance? */
export function isBlockRefElement(el: Element): boolean {
  if (el.kind !== "geometry") return false;
  const p = el.props as Record<string, unknown>;
  return p.drafting === true && p.type === "block-ref";
}

/** Soft check: is this element a CAD-PARITY-006 xref instance? */
export function isXrefRefElement(el: Element): boolean {
  if (el.kind !== "geometry") return false;
  const p = el.props as Record<string, unknown>;
  return p.drafting === true && p.type === "xref-ref";
}

/** Write a block instance to element props (flat canonical convention). */
export function blockRefToProps(ref: BlockRefView): Record<string, unknown> {
  const props: Record<string, unknown> = {
    drafting: true,
    type: "block-ref",
    layer: ref.layer,
    blockId: ref.blockId,
    x: ref.x,
    y: ref.y,
    scale: ref.scale,
    rotation: ref.rotation,
  };
  if (ref.attributes !== undefined) props.attributes = ref.attributes.map((a) => ({ tag: a.tag, value: a.value }));
  return props;
}

/** Write an xref instance to element props. */
export function xrefRefToProps(ref: XrefRefView): Record<string, unknown> {
  return {
    drafting: true,
    type: "xref-ref",
    layer: ref.layer,
    xrefId: ref.xrefId,
    x: ref.x,
    y: ref.y,
    scale: ref.scale,
    rotation: ref.rotation,
  };
}

/** Strict parse of a block instance element (LOCK-007: throws on malformed
 *  props — re-validated through the constructor). */
export function elementToBlockRef(el: Element): BlockRefView {
  if (!isBlockRefElement(el)) {
    throw new BlockError(`element '${el.id}' is not a CAD-PARITY-006 block instance`, "bad_input");
  }
  return makeBlockRef(el.props as Record<string, unknown>);
}

/** Strict parse of an xref instance element. */
export function elementToXrefRef(el: Element): XrefRefView {
  if (!isXrefRefElement(el)) {
    throw new BlockError(`element '${el.id}' is not a CAD-PARITY-006 xref instance`, "bad_input");
  }
  return makeXrefRef(el.props as Record<string, unknown>);
}

/** Soft load: the block instance view of an element, or null (malformed
 *  props read as "not a block instance" — honest readers never throw; write
 *  paths validate strictly). */
export function blockRefFromElement(el: Element): BlockRefView | null {
  if (!isBlockRefElement(el)) return null;
  try {
    return elementToBlockRef(el);
  } catch {
    return null;
  }
}

/** Soft load: the xref instance view of an element, or null. */
export function xrefRefFromElement(el: Element): XrefRefView | null {
  if (!isXrefRefElement(el)) return null;
  try {
    return elementToXrefRef(el);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The inline entity vocabulary (definition/xref content validation).
// ---------------------------------------------------------------------------

/** The display/layer fields inline content may carry (the CAD-PARITY-004
 *  vocabulary — resolved by the hosts' display pipeline at render time). */
const CONTENT_DISPLAY_KEYS: readonly string[] = [
  "layer",
  "color",
  "linetype",
  "lineweight",
  "transparency",
];

/**
 * Validate + NORMALIZE one inline entity for storage inside a block
 * definition or a resolved xref (LOCK-007: strict — malformed or
 * out-of-vocabulary records are rejected with a typed failure naming the
 * index). Returns the canonical stored form. The accepted vocabulary:
 *  - the CAD-PARITY-003 geometry types (normalized through the decoder);
 *  - "text" (normalized through the CAD-PARITY-005 text constructor);
 *  - "attdef" (normalized through makeAttdef);
 *  - "block-ref" (a NESTED reference — normalized through makeBlockRef;
 *    the referenced definition must exist; cycle/depth checks happen at the
 *    table level — see assertDefinitionGraph).
 * Unknown types (annotations beyond text, BIM entities, legacy drafting
 * tuples) are rejected — callers convert sources to the canonical
 * convention BEFORE storing (the geometry bridge handles the legacy
 * drafting layouts; xref attach reports skipped elements honestly).
 */
export function normalizeBlockEntity(
  input: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const type = input.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new BlockError(`entities[${index}]: missing entity type`, "bad_input");
  }

  // Geometry (CAD-PARITY-003 flat convention) — normalized through the
  // decoder round-trip so only well-formed finite records are stored.
  if (type !== "text" && type !== "attdef" && type !== "block-ref") {
    const geom = propsToGeom(input);
    if (geom === null) {
      throw new BlockError(
        `entities[${index}]: '${type}' is not part of the block-content vocabulary ` +
          "(line/polyline/circle/arc/ellipse/spline/point/ray/xline/region geometry, text, attdef, block-ref)",
        "bad_input",
      );
    }
    const props: Record<string, unknown> = { ...(geom as unknown as Record<string, unknown>) };
    for (const key of CONTENT_DISPLAY_KEYS) {
      const v = input[key];
      if (v === undefined) continue;
      if (key === "layer") {
        if (typeof v !== "string" || v.length === 0) {
          throw new BlockError(`entities[${index}].layer must be a non-empty string`, "bad_input");
        }
      } else if (key === "lineweight") {
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
          throw new BlockError(`entities[${index}].lineweight must be a positive number`, "bad_input");
        }
      } else if (key === "transparency") {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 90) {
          throw new BlockError(`entities[${index}].transparency must be an integer 0-90`, "bad_input");
        }
      } else {
        if (typeof v !== "string" || v.length === 0) {
          throw new BlockError(`entities[${index}].${key} must be a non-empty string`, "bad_input");
        }
      }
      props[key] = v;
    }
    return props;
  }

  if (type === "text") {
    // The CAD-PARITY-005 text constructor validates + normalizes; the
    // stored inline form is its props projection minus the element markers.
    let text: ReturnType<typeof makeText>;
    try {
      text = makeText(input);
    } catch (e) {
      throw new BlockError(`entities[${index}]: ${(e as Error).message}`, "bad_input");
    }
    const props: Record<string, unknown> = { type: "text", layer: text.layer };
    props.x = text.x;
    props.y = text.y;
    props.height = text.height;
    props.rotation = text.rotation;
    props.value = text.value;
    if (text.style !== undefined) props.style = text.style;
    if (text.hAlign !== undefined) props.hAlign = text.hAlign;
    if (text.vAlign !== undefined) props.vAlign = text.vAlign;
    return props;
  }

  if (type === "attdef") {
    let attdef: AttdefRecord;
    try {
      attdef = makeAttdef(input);
    } catch (e) {
      throw new BlockError(`entities[${index}]: ${(e as Error).message}`, "bad_input");
    }
    const props: Record<string, unknown> = { type: "attdef", tag: attdef.tag };
    if (attdef.prompt !== undefined) props.prompt = attdef.prompt;
    if (attdef.default !== undefined) props.default = attdef.default;
    props.layer = attdef.layer;
    props.x = attdef.x;
    props.y = attdef.y;
    props.height = attdef.height;
    props.rotation = attdef.rotation;
    if (attdef.style !== undefined) props.style = attdef.style;
    return props;
  }

  // Nested block reference (definition coordinates).
  let ref: BlockRefView;
  try {
    ref = makeBlockRef(input);
  } catch (e) {
    throw new BlockError(`entities[${index}]: ${(e as Error).message}`, "bad_input");
  }
  return blockRefToProps(ref);
}

/** Validate + normalize a whole inline entity array. */
export function normalizeBlockEntities(
  entities: readonly unknown[],
): Record<string, unknown>[] {
  if (!Array.isArray(entities)) {
    throw new BlockError("entities must be an array", "bad_input");
  }
  return entities.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new BlockError(`entities[${index}] must be an object`, "bad_input");
    }
    return normalizeBlockEntity(raw as Record<string, unknown>, index);
  });
}

// ---------------------------------------------------------------------------
// Definition graph checks (cycles + nesting depth — enforced at write time).
// ---------------------------------------------------------------------------

/** The block ids an inline entity array references (nested block-refs). */
export function referencedBlockIds(entities: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (e.type === "block-ref" && typeof e.blockId === "string") out.push(e.blockId);
  }
  return out;
}

/**
 * Assert the definition graph stays acyclic and depth-bounded after writing
 * `blockId` with `entities`. `defEntitiesById` maps every definition to its
 * inline entities in the POST-WRITE world (the caller passes the would-be
 * table view, with the new entities already substituted for `blockId`).
 * Throws a typed BlockError on a cycle or an over-deep chain.
 */
export function assertDefinitionGraph(
  blockId: string,
  entities: readonly Record<string, unknown>[],
  defEntitiesById: (id: string) => readonly Record<string, unknown>[] | undefined,
): void {
  const visiting = new Set<string>();
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      throw new BlockError(
        `circular block reference through '${id}' — definitions must not reference themselves (directly or through nesting)`,
        "block_cycle",
      );
    }
    visiting.add(id);
    const entitiesOf = defEntitiesById(id) ?? [];
    let depth = 1;
    for (const child of referencedBlockIds(entitiesOf)) {
      depth = Math.max(depth, 1 + depthOf(child));
    }
    visiting.delete(id);
    depthCache.set(id, depth);
    return depth;
  };
  const total = depthOf(blockId);
  if (total > MAX_BLOCK_NESTING_DEPTH) {
    throw new BlockError(
      `block nesting exceeds the supported depth ${MAX_BLOCK_NESTING_DEPTH} (got ${total})`,
      "block_depth",
    );
  }
}

/** The attdef tags of an inline entity array (definition attribute slots). */
export function attdefTagsOf(entities: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (e.type === "attdef" && typeof e.tag === "string") out.push(e.tag);
  }
  return out;
}

/** Resolve an instance's rendered attribute value for a tag (instance
 *  value first, definition default second, null when the slot renders
 *  nothing — an empty default on an instance without a value). */
export function attributeValue(
  attributes: readonly AttributeValue[],
  tag: string,
  defDefault: string | undefined,
): string | null {
  const stored = attributes.find((a) => a.tag === tag);
  if (stored !== undefined) return stored.value;
  return defDefault !== undefined && defDefault.length > 0 ? defDefault : null;
}

/** Normalize a rotation to [0, 2π) (the canonical storage convention for
 *  instance placement edits). */
export function normalizedRotation(rotation: number): number {
  return normAngle(rotation);
}

// Re-export the point helper for the expansion module's consumers.
export { ptOf as blockPtOf };
