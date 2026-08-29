/**
 * CAD-PARITY-003 entity operations — the shared semantic core for the 2D
 * draw/modify vocabulary (Issue #78; CAD-2D-001 primitives, CAD-2D-002
 * modify operations).
 *
 * Every CAD-PARITY-003 mutation flows through here: the App API
 * `entity.create` / `entity.modify` commands dispatch to these pure
 * functions, and the SAME module is what the prompt-engine command builders
 * describe (the builders only package parameters — the semantics live
 * here, on canonical geometry, never as UI approximations; Issue #78
 * acceptance "modify operations operate on canonical geometry").
 *
 * Model: operations receive the document's elements, resolve them through
 * the geometry bridge (BOTH storage conventions → ONE canonical view),
 * apply the deterministic 2D kernel, and return a SINGLE `applyEdits`
 * DocumentEdit — one versioned command, one revision, one undo entry
 * (§15) — plus a deterministic summary for the command line.
 *
 * Engine-free, host-free (LOCK-003/018). Deterministic: the same elements
 * + the same op produce the same edit and summary on every host, every
 * run (LOCK-004).
 */

import type { DocumentEdit, Element } from "../contracts/caddocument.js";
import type { Geom, GeomType, RegionGeom } from "./geometry/types.js";
import { propsToGeom } from "./geometry/types.js";
import { geomFromElement, isRectangleElement, layerOfElement } from "./geometry/bridge.js";
import { offsetGeom } from "./geometry/offset.js";
import {
  chamferLineLine,
  chamferPolyline,
  filletLineLine,
  filletPolyline,
  GeomOpError,
} from "./geometry/fillet.js";
import {
  breakGeom,
  explodeGeom,
  extendGeom,
  joinGeoms,
  regionFromGeom,
  stretchGeom,
  trimGeom,
} from "./geometry/editops.js";
import { mirrorGeom, moveGeom, rotateGeom, scaleGeom } from "./geometry/transform.js";
import { closestOn } from "./geometry/entities.js";
import { dist, Pt, rotatePt, scalePt, sub } from "./geometry/math2d.js";
// CAD-PARITY-004: display overrides + the standards constants (engine-free
// shared module — the SAME resolution on both hosts, LOCK-004).
import {
  displayOverridesOf,
  isStandardLineweight,
  type EntityDisplayOverrides,
} from "./standards/index.js";
// CAD-PARITY-005: the associative annotation core (engine-free — the
// remeasure cascade over dimension references).
import {
  annotationViewsOf,
  annotationsReferencing,
  remeasureCascade,
} from "./annotation/assoc.js";
// CAD-PARITY-006: the blocks core (engine-free — instance placement edits,
// the one-level explode materialization).
import {
  BlockError,
  blockRefFromElement,
  explodeBlockInstance,
  isBlockRefElement,
  isXrefRefElement,
  normalizedRotation,
  xrefRefFromElement,
} from "./blocks/index.js";
import type { BlockDefinitionRecord, ConstraintRecord } from "../contracts/caddocument.js";
// CAD-PARITY-007: the parametric-constraints core (engine-free — the
// constraint-aware editing cascade: severance + the deterministic re-solve,
// composed with the annotation remeasure cascade in ONE atomic batch).
import {
  constraintCascade,
  collectEditedIds,
  applyEditsInMemory,
} from "./constraints/index.js";

// ---------------------------------------------------------------------------
// Typed failures (stable codes across hosts; LOCK-007/008).
// ---------------------------------------------------------------------------

export class EntityOpError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EntityOpError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Outcomes.
// ---------------------------------------------------------------------------

export interface EntityOpOutcome {
  /** The atomic edit batch (one revision, one undo entry). Null = no-op. */
  readonly edit: DocumentEdit | null;
  /** Deterministic command-line summary. */
  readonly summary: string;
  /** Ids created by the operation (minted by the document on execute). */
  readonly createdCount: number;
  /** Ids modified in place. */
  readonly modifiedCount: number;
  /** Ids removed. */
  readonly removedCount: number;
}

function outcome(
  edits: readonly DocumentEdit[],
  summary: string,
  counts?: { created?: number; modified?: number; removed?: number },
): EntityOpOutcome {
  if (edits.length === 0) {
    return { edit: null, summary, createdCount: 0, modifiedCount: 0, removedCount: 0 };
  }
  // Counts default to the edit-derived truth (create/modify/remove per
  // sub-edit) so every operation reports accurately.
  let created = counts?.created;
  let modified = counts?.modified;
  let removed = counts?.removed;
  if (created === undefined || modified === undefined || removed === undefined) {
    let dc = 0;
    let dm = 0;
    let dr = 0;
    for (const e of edits) {
      if (e.type === "addElement") dc++;
      else if (e.type === "removeElement") dr++;
      else if (e.type === "updateElement") dm++;
    }
    created = created ?? dc;
    modified = modified ?? dm;
    removed = removed ?? dr;
  }
  return {
    edit: { type: "applyEdits", edits: [...edits] },
    summary,
    createdCount: created,
    modifiedCount: modified,
    removedCount: removed,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers over the element world.
// ---------------------------------------------------------------------------

interface EntityView {
  readonly element: Element;
  readonly geom: Geom;
}

function loadEntities(
  elements: readonly Element[],
  ids: readonly string[],
): Map<string, EntityView> {
  const byId = new Map<string, Element>(elements.map((el) => [el.id, el] as const));
  const out = new Map<string, EntityView>();
  for (const id of ids) {
    const el = byId.get(id);
    if (el === undefined) {
      throw new EntityOpError(`entity '${id}' does not exist`, "bad_id");
    }
    const geom = geomFromElement(el);
    if (geom === null) {
      throw new EntityOpError(
        `entity '${id}' is not part of the 2D drawing vocabulary (annotations and BIM elements are excluded; dims/regions unsupported for this operation are named in the command output)`,
        "bad_entity",
      );
    }
    out.set(id, { element: el, geom });
  }
  return out;
}

/** addElement with a mintable placeholder id (the document assigns el-NNNNNN).
 *  CAD-PARITY-004: display overrides (color/linetype/lineweight/transparency)
 *  are carried onto the new entity when provided. */
function addGeomEdit(
  geom: Geom,
  layer: string,
  display: EntityDisplayOverrides | null = null,
): DocumentEdit {
  const props: Record<string, unknown> = { drafting: true, layer, ...(geom as unknown as Record<string, unknown>) };
  if (display !== null) applyDisplayToProps(props, display);
  return {
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props },
  };
}

/** setProps replacing an entity's props with the canonical form (FULL
 *  replacement — stale legacy fields are dropped, not merged; layer and
 *  element identity preserved; rectangle sources materialize as the closed
 *  polyline they mathematically are — never silent). CAD-PARITY-004: the
 *  entity's DISPLAY OVERRIDES are preserved through every geometry modify
 *  (move/rotate/scale/mirror/trim/… never strip professional display
 *  properties — pinned by directed regression). */
function replaceGeomEdit(view: EntityView, geom: Geom): DocumentEdit {
  const layer = layerOfElement(view.element);
  const props: Record<string, unknown> = { drafting: true, layer, ...(geom as unknown as Record<string, unknown>) };
  applyDisplayToProps(props, displayOverridesOf(view.element.props as Record<string, unknown>));
  return { type: "setProps", elementId: view.element.id, patch: props };
}

/** Write validated display overrides into entity props (absent = ByLayer:
 *  no field is materialized unless an override exists). */
function applyDisplayToProps(props: Record<string, unknown>, display: EntityDisplayOverrides): void {
  if (display.color !== null) props.color = display.color;
  if (display.linetype !== null) props.linetype = display.linetype;
  if (display.lineweight !== null) props.lineweight = display.lineweight;
  if (display.transparency !== null) props.transparency = display.transparency;
}

function removeEdit(id: string): DocumentEdit {
  return { type: "removeElement", elementId: id };
}

function plurality(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** THROUGH-mode offset distance resolution (the offset passes through the
 *  picked point). Ported from the verified CAD-PARITY-003 implementation. */
function throughDistance(g: Geom, p: Pt): { distance: number; side: Pt } | null {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const a = { x: g.x1, y: g.y1 };
      const b = { x: g.x2, y: g.y2 };
      const d = sub(b, a);
      const l = Math.hypot(d.x, d.y);
      if (l <= 1e-9) return null;
      const u = { x: d.x / l, y: d.y / l };
      const rel = sub(p, a);
      const crossV = rel.x * u.y - rel.y * u.x;
      if (Math.abs(crossV) <= 1e-9) return null;
      return { distance: Math.abs(crossV), side: p };
    }
    case "circle":
    case "arc": {
      const r = Math.hypot(p.x - g.cx, p.y - g.cy);
      if (r <= 1e-9 || Math.abs(r - g.r) <= 1e-9) return null;
      return { distance: Math.abs(r - g.r), side: p };
    }
    case "polyline": {
      const c = closestOn(g, p).point;
      if (dist(c, p) <= 1e-9) return null;
      return { distance: dist(c, p), side: p };
    }
    default:
      return null;
  }
}

function sameGeom(a: Geom, b: Geom): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// CREATE (CAD-2D-001 vocabulary — the six types beyond the COMPAT-CAD-001
// set; line/polyline/circle/arc keep flowing through drafting.createEntities).
// ---------------------------------------------------------------------------

export interface EntityCreateOutcome extends EntityOpOutcome {
  /** Placeholders accepted by the payload (informational). */
  readonly requested: number;
}

/**
 * Create canonical 2D entities. Each input is the flat geometry record
 * ({type:"ellipse", cx, cy, rx, ry, rotation} | …) validated through the
 * canonical decoder — malformed or degenerate inputs are REJECTED with
 * typed errors (LOCK-007: no guessing, no silent repair). Region inputs
 * are re-derived: area/perimeter/centroid are recomputed from the boundary
 * and mismatching supplied values are rejected (deterministic,
 * non-forgeable derived properties).
 */
export function createEntities(
  elements: readonly Element[],
  layerExists: (id: string) => boolean,
  inputs: readonly unknown[],
  ltypeResolves?: (name: string) => boolean,
): EntityCreateOutcome {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new EntityOpError("entity.create requires a non-empty entities array", "bad_input");
  }
  const edits: DocumentEdit[] = [];
  let created = 0;

  for (const [index, raw] of inputs.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new EntityOpError(`entities[${index}] must be an object`, "bad_input");
    }
    const input = raw as Record<string, unknown>;
    const layer = typeof input.layer === "string" && input.layer.length > 0 ? input.layer : "0";
    if (!layerExists(layer)) {
      throw new EntityOpError(`entities[${index}]: layer '${layer}' does not exist`, "bad_layer");
    }
    const geom = propsToGeom({ ...input, layer: "" });
    if (geom === null) {
      throw new EntityOpError(
        `entities[${index}]: not a valid canonical 2D geometry record (line/polyline/circle/arc/ellipse/spline/point/ray/xline/region with well-formed finite fields)`,
        "bad_entity",
      );
    }
    if (geom.type === "region") {
      // Derived properties are recomputed from the boundary — supplied
      // values must match (deterministic, associative representation;
      // line/polyline/circle/arc records store identically through the
      // bridge in both conventions).
      const recomputed = regionFromGeom(regionBoundaryAsGeom(geom));
      if (
        Math.abs(recomputed.area - geom.area) > 1e-6 ||
        Math.abs(recomputed.perimeter - geom.perimeter) > 1e-6 ||
        dist(recomputed.centroid, geom.centroid) > 1e-6
      ) {
        throw new EntityOpError(
          `entities[${index}]: region area/perimeter/centroid do not match the boundary (derived properties are recomputed, not trusted)`,
          "bad_entity",
        );
      }
    }
    // CAD-PARITY-004: optional display overrides on creation (validated
    // strictly — the same rules as setDisplay; absent = ByLayer).
    const display: { color: string | null; linetype: string | null; lineweight: number | null; transparency: number | null } = {
      color: null,
      linetype: null,
      lineweight: null,
      transparency: null,
    };
    if (input.color !== undefined && input.color !== "ByLayer") {
      if (typeof input.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
        throw new EntityOpError(`entities[${index}]: color must be 'ByLayer' or #RRGGBB`, "bad_input");
      }
      display.color = input.color;
    }
    if (input.linetype !== undefined && input.linetype !== "ByLayer") {
      if (typeof input.linetype !== "string" || input.linetype.length === 0) {
        throw new EntityOpError(`entities[${index}]: linetype must be 'ByLayer' or a linetype name`, "bad_input");
      }
      if (ltypeResolves !== undefined && !ltypeResolves(input.linetype)) {
        throw new EntityOpError(`entities[${index}]: unknown linetype '${input.linetype}'`, "bad_linetype");
      }
      display.linetype = input.linetype;
    }
    if (input.lineweight !== undefined && input.lineweight !== "ByLayer") {
      if (typeof input.lineweight !== "number" || !Number.isFinite(input.lineweight) || !isStandardLineweight(input.lineweight)) {
        throw new EntityOpError(`entities[${index}]: lineweight must be 'ByLayer' or a standard lineweight (mm)`, "bad_input");
      }
      display.lineweight = input.lineweight;
    }
    if (input.transparency !== undefined && input.transparency !== "ByLayer") {
      if (typeof input.transparency !== "number" || !Number.isInteger(input.transparency) || input.transparency < 0 || input.transparency > 90) {
        throw new EntityOpError(`entities[${index}]: transparency must be 'ByLayer' or an integer 0–90`, "bad_input");
      }
      display.transparency = input.transparency;
    }
    edits.push(addGeomEdit(geom, layer, display));
    created++;
  }

  return {
    ...outcome(edits, `${plurality(created, "entity", "entities")} created`, { created }),
    requested: inputs.length,
  };
}

function regionBoundaryAsGeom(region: RegionGeom): Geom {
  const b = region.boundary;
  if (b.kind === "circle") {
    return { type: "circle", cx: b.cx, cy: b.cy, r: b.r };
  }
  if (b.kind === "ellipse") {
    return { type: "ellipse", cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rotation: b.rotation };
  }
  return { type: "polyline", vertices: b.vertices, closed: true };
}

// ---------------------------------------------------------------------------
// MODIFY (CAD-2D-002 vocabulary).
// ---------------------------------------------------------------------------

export type EntityModifyOp =
  | { readonly op: "move"; readonly ids: readonly string[]; readonly dx: number; readonly dy: number }
  | { readonly op: "copy"; readonly ids: readonly string[]; readonly dx: number; readonly dy: number }
  | { readonly op: "rotate"; readonly ids: readonly string[]; readonly base: Pt; readonly angle: number }
  | { readonly op: "scale"; readonly ids: readonly string[]; readonly base: Pt; readonly factor: number }
  | { readonly op: "mirror"; readonly ids: readonly string[]; readonly p1: Pt; readonly p2: Pt; readonly eraseSource: boolean }
  | {
      readonly op: "offset";
      readonly items: readonly {
        readonly targetId: string;
        readonly distance: number;
        readonly side: Pt;
        readonly through: boolean;
      }[];
    }
  | {
      readonly op: "trim";
      readonly edges: readonly string[];
      readonly trims: readonly { readonly targetId: string; readonly pick: Pt }[];
    }
  | {
      readonly op: "extend";
      readonly boundaries: readonly string[];
      readonly targets: readonly { readonly targetId: string; readonly pick: Pt }[];
    }
  | {
      readonly op: "stretch";
      readonly ids: readonly string[];
      readonly winMin: Pt;
      readonly winMax: Pt;
      readonly dx: number;
      readonly dy: number;
    }
  | {
      readonly op: "fillet";
      readonly mode: "pair" | "polyline";
      readonly radius: number;
      readonly firstId?: string;
      readonly firstPick?: Pt;
      readonly secondId?: string;
      readonly secondPick?: Pt;
      readonly polylineId?: string;
    }
  | {
      readonly op: "chamfer";
      readonly mode: "pair" | "polyline";
      readonly d1: number;
      readonly d2: number;
      readonly firstId?: string;
      readonly firstPick?: Pt;
      readonly secondId?: string;
      readonly secondPick?: Pt;
      readonly polylineId?: string;
    }
  | { readonly op: "break"; readonly targetId: string; readonly p1: Pt; readonly p2: Pt | null }
  | { readonly op: "join"; readonly ids: readonly string[] }
  | { readonly op: "explode"; readonly ids: readonly string[]; readonly blockDefById?: (id: string) => BlockDefinitionRecord | undefined }
  | { readonly op: "setGeometry"; readonly id: string; readonly geom: Geom }
  | {
      /** CAD-PARITY-007: deterministic rectangular/polar array (the bounded
       *  pattern surface — path arrays are a typed decline at the command
       *  layer). Copies carry document-minted identities (one atomic batch,
       *  replay-safe); constraint bindings do NOT travel to the copies (they
       *  bind the source canonical identities — documented). */
      readonly op: "array";
      readonly mode: "rectangular" | "polar";
      readonly ids: readonly string[];
      readonly rows?: number;
      readonly columns?: number;
      readonly rowSpacing?: number;
      readonly columnSpacing?: number;
      readonly center?: Pt;
      readonly items?: number;
      readonly angleSpan?: number;
      readonly rotateItems?: boolean;
    }
  | {
      /** CAD-PARITY-004: set display overrides + optional layer reassignment
       *  for a batch of entities — ONE atomic applyEdits revision (CHPROP /
       *  MATCHPROP / the Properties palette write path). */
      readonly op: "setDisplay";
      readonly ids: readonly string[];
      readonly patch: Readonly<Record<string, unknown>>;
      readonly layerExists?: (id: string) => boolean;
      readonly ltypeResolves?: (name: string) => boolean;
    };

/** CAD-PARITY-007: the constraint context for modify operations. When the
 *  declared graph is present, geometry edits run the constraint-aware
 *  cascade (severance for removed/re-topologized targets + the deterministic
 *  re-solve with fixed-restore) inside the SAME atomic batch. */
export interface ModifyContext {
  readonly constraints?: readonly ConstraintRecord[];
}

/** Apply one modify operation. All geometry resolution goes through the
 *  canonical bridge; all computation through the deterministic kernel.
 *  CAD-PARITY-007: the constraint cascade (severance + re-solve) composes
 *  BEFORE the CAD-PARITY-005 annotation remeasure cascade — dimensions
 *  re-measure against the constraint-settled world, all in ONE atomic
 *  revision (one undo entry). */
export function modifyEntities(
  elements: readonly Element[],
  op: EntityModifyOp,
  context: ModifyContext = {},
): EntityOpOutcome {
  const base = modifyEntitiesBase(elements, op);
  if (base.edit === null) return base;
  const baseEdits: DocumentEdit[] =
    base.edit.type === "applyEdits" ? [...base.edit.edits] : [base.edit];
  let edits = [...baseEdits];
  let summary = base.summary;

  // CAD-PARITY-007: the constraint-aware cascade (severance + re-solve).
  if (context.constraints !== undefined && context.constraints.length > 0) {
    const cascade = constraintCascade(
      elements,
      base.edit,
      context.constraints,
      retopologizedIdsOf(op),
    );
    if (cascade.edits.length > 0) {
      edits = [...edits, ...cascade.edits];
      summary = `${summary}; ${cascade.notes.join("; ")}`;
    }
  }

  // CAD-PARITY-005: the ASSOCIATIVE CASCADE — when the edit changes
  // geometry that dimensions reference, the dependent dimensions
  // re-measure inside the SAME atomic batch (one revision, one undo entry).
  // CAD-PARITY-007: the changed-id set covers the base edit AND the
  // constraint patches (a constraint-settled entity's dimensions re-measure
  // against the settled world).
  const currentBatch: DocumentEdit =
    edits.length === baseEdits.length ? base.edit : { type: "applyEdits", edits };
  const changedIds = new Set<string>();
  collectEditedIds(currentBatch, changedIds);
  if (changedIds.size > 0) {
    const annotations = annotationViewsOf(elements);
    const dependent = annotationsReferencing(annotations, changedIds);
    if (dependent.length > 0) {
      const worldAfter = applyEditsInMemory(elements, currentBatch);
      const cascade = remeasureCascade(dependent, worldAfter);
      if (cascade.edits.length > 0) {
        edits = [...edits, ...cascade.edits];
        summary = `${summary}; ${cascade.edits.length} annotation${cascade.edits.length === 1 ? "" : "s"} re-measured`;
      }
    }
  }

  // Nothing appended — the base edit stays EXACTLY as the op produced it
  // (a single setProps stays a single setProps; the op's applyEdits shape
  // is preserved — pinned by the CAD-PARITY-003 suite).
  if (edits.length === baseEdits.length) return base;
  return { ...base, edit: { type: "applyEdits", edits }, summary };
}

/** CAD-PARITY-007: the entity ids a modify op RE-TOPOLOGIZES (their
 *  construction-point identity is broken — the bounded severance rule:
 *  trim/extend/break/fillet/chamfer/join delete the constraints of their
 *  targets; transform ops return the geometry to the re-solve instead). */
function retopologizedIdsOf(op: EntityModifyOp): ReadonlySet<string> {
  const ids = new Set<string>();
  switch (op.op) {
    case "trim":
      for (const t of op.trims) ids.add(t.targetId);
      break;
    case "extend":
      for (const t of op.targets) ids.add(t.targetId);
      break;
    case "break":
      ids.add(op.targetId);
      break;
    case "fillet":
    case "chamfer":
      if (op.firstId !== undefined) ids.add(op.firstId);
      if (op.secondId !== undefined) ids.add(op.secondId);
      if (op.polylineId !== undefined) ids.add(op.polylineId);
      break;
    case "join":
      for (const id of op.ids) ids.add(id);
      break;
    default:
      break;
  }
  return ids;
}

/** The CAD-PARITY-003 modify dispatch (the cascade wraps it). */
function modifyEntitiesBase(elements: readonly Element[], op: EntityModifyOp): EntityOpOutcome {
  switch (op.op) {
    case "move":
      return opMove(elements, op.ids, op.dx, op.dy);
    case "copy":
      return opCopy(elements, op.ids, op.dx, op.dy);
    case "rotate":
      return opRotate(elements, op.ids, op.base, op.angle);
    case "scale":
      return opScale(elements, op.ids, op.base, op.factor);
    case "mirror":
      return opMirror(elements, op.ids, op.p1, op.p2, op.eraseSource);
    case "offset":
      return opOffset(elements, op.items);
    case "trim":
      return opTrim(elements, op.edges, op.trims);
    case "extend":
      return opExtend(elements, op.boundaries, op.targets);
    case "stretch":
      return opStretch(elements, op.ids, op.winMin, op.winMax, op.dx, op.dy);
    case "fillet":
      return opFillet(elements, op);
    case "chamfer":
      return opChamfer(elements, op);
    case "break":
      return opBreak(elements, op.targetId, op.p1, op.p2);
    case "join":
      return opJoin(elements, op.ids);
    case "explode":
      return opExplode(elements, op.ids, op.blockDefById);
    case "setGeometry":
      return opSetGeometry(elements, op.id, op.geom);
    case "array":
      return opArray(elements, op);
    case "setDisplay":
      return opSetDisplay(elements, op);
  }
}

/** CAD-PARITY-004 — validate + apply one display/layer patch to a batch of
 *  entities as ONE atomic revision. Patch fields (all optional, validated
 *  strictly — LOCK-007):
 *  - color: "ByLayer" (reset) or a #RRGGBB hex override
 *  - linetype: "ByLayer" (reset) or a resolvable linetype name
 *  - lineweight: "ByLayer" (reset) or a STANDARD lineweight mm value
 *  - transparency: "ByLayer" (reset) or an integer 0–90
 *  - layer: reassign the entity to another EXISTING layer
 *  Locked-layer entities reject the edit (document.execute gate); the
 *  validation here is the pre-flight so failures are typed and stable. */
function opSetDisplay(
  elements: readonly Element[],
  op: { ids: readonly string[]; patch: Readonly<Record<string, unknown>>; layerExists?: (id: string) => boolean; ltypeResolves?: (name: string) => boolean },
): EntityOpOutcome {
  const allowed = ["color", "linetype", "lineweight", "transparency", "layer"] as const;
  for (const key of Object.keys(op.patch)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new EntityOpError(`setDisplay: unknown field '${key}' (allowed: ${allowed.join(", ")})`, "bad_input");
    }
  }
  if (op.patch.color !== undefined) {
    const c = op.patch.color;
    if (c !== "ByLayer" && (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c))) {
      throw new EntityOpError("setDisplay: color must be 'ByLayer' or a #RRGGBB hex string", "bad_input");
    }
  }
  if (op.patch.linetype !== undefined) {
    const lt = op.patch.linetype;
    if (lt !== "ByLayer") {
      if (typeof lt !== "string" || lt.length === 0) {
        throw new EntityOpError("setDisplay: linetype must be 'ByLayer' or a linetype name", "bad_input");
      }
      if (op.ltypeResolves !== undefined && !op.ltypeResolves(lt)) {
        throw new EntityOpError(`setDisplay: unknown linetype '${lt}'`, "bad_linetype");
      }
    }
  }
  if (op.patch.lineweight !== undefined) {
    const lw = op.patch.lineweight;
    if (lw !== "ByLayer") {
      if (typeof lw !== "number" || !Number.isFinite(lw) || !isStandardLineweight(lw)) {
        throw new EntityOpError("setDisplay: lineweight must be 'ByLayer' or a standard lineweight (mm)", "bad_input");
      }
    }
  }
  if (op.patch.transparency !== undefined) {
    const t = op.patch.transparency;
    if (t !== "ByLayer") {
      if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > 90) {
        throw new EntityOpError("setDisplay: transparency must be 'ByLayer' or an integer 0–90", "bad_input");
      }
    }
  }
  if (op.patch.layer !== undefined) {
    const layer = op.patch.layer;
    if (typeof layer !== "string" || layer.length === 0) {
      throw new EntityOpError("setDisplay: layer must be a layer id string", "bad_input");
    }
    if (op.layerExists !== undefined && !op.layerExists(layer)) {
      throw new EntityOpError(`setDisplay: layer '${layer}' does not exist`, "bad_layer");
    }
  }
  if (op.ids.length === 0) {
    throw new EntityOpError("setDisplay requires a non-empty ids array", "bad_input");
  }
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const edits: DocumentEdit[] = [];
  const parts: string[] = [];
  for (const id of op.ids) {
    const el = byId.get(id);
    if (el === undefined) throw new EntityOpError(`entity '${id}' does not exist`, "bad_id");
    const props = el.props as Record<string, unknown>;
    const current = displayOverridesOf(props);
    const next: EntityDisplayOverrides = {
      color: op.patch.color !== undefined ? (op.patch.color === "ByLayer" ? null : (op.patch.color as string)) : current.color,
      linetype: op.patch.linetype !== undefined ? (op.patch.linetype === "ByLayer" ? null : (op.patch.linetype as string)) : current.linetype,
      lineweight: op.patch.lineweight !== undefined ? (op.patch.lineweight === "ByLayer" ? null : (op.patch.lineweight as number)) : current.lineweight,
      transparency: op.patch.transparency !== undefined ? (op.patch.transparency === "ByLayer" ? null : (op.patch.transparency as number)) : current.transparency,
    };
    const patch: Record<string, unknown> = {};
    if (next.color !== null) patch.color = next.color;
    if (next.linetype !== null) patch.linetype = next.linetype;
    if (next.lineweight !== null) patch.lineweight = next.lineweight;
    if (next.transparency !== null) patch.transparency = next.transparency;
    if (op.patch.layer !== undefined) patch.layer = op.patch.layer;
    // A ByLayer RESET must REMOVE the override field — updateElement merges
    // patches, so a key can only disappear through a FULL setProps (the
    // COMPAT-CAD-002 exact-inverse precedent). Mixed batches pick the edit
    // kind PER ENTITY (only entities carrying a field to drop need setProps).
    const resetting =
      (op.patch.color === "ByLayer" && current.color !== null) ||
      (op.patch.linetype === "ByLayer" && current.linetype !== null) ||
      (op.patch.lineweight === "ByLayer" && current.lineweight !== null) ||
      (op.patch.transparency === "ByLayer" && current.transparency !== null);
    if (resetting) {
      const full: Record<string, unknown> = { ...props, ...patch };
      if (next.color === null) delete full.color;
      if (next.linetype === null) delete full.linetype;
      if (next.lineweight === null) delete full.lineweight;
      if (next.transparency === null) delete full.transparency;
      edits.push({ type: "setProps", elementId: id, patch: full });
    } else {
      edits.push({ type: "updateElement", elementId: id, patch });
    }
  }
  if (op.patch.color !== undefined) parts.push(`color ${op.patch.color}`);
  if (op.patch.linetype !== undefined) parts.push(`linetype ${op.patch.linetype}`);
  if (op.patch.lineweight !== undefined) parts.push(`lineweight ${String(op.patch.lineweight)}`);
  if (op.patch.transparency !== undefined) parts.push(`transparency ${String(op.patch.transparency)}`);
  if (op.patch.layer !== undefined) parts.push(`layer ${op.patch.layer}`);
  return outcome(edits, `${plurality(op.ids.length, "entity", "entities")} — ${parts.join(", ")}`, {
    modified: op.ids.length,
  });
}

// ---------------------------------------------------------------------------
// CAD-PARITY-006: instance-aware modify — block-ref/xref-ref elements are
// transformed through their PLACEMENT (x/y/scale/rotation); content is
// derived from the definition at expansion time and never duplicated here.
// ---------------------------------------------------------------------------

/** Is this element a CAD-PARITY-006 block/xref instance? */
function isInstanceElement(el: Element | undefined): boolean {
  if (el === undefined) return false;
  return isBlockRefElement(el) || isXrefRefElement(el);
}

/** Partition ids into instance elements and canonical-geometry ids (missing
 *  ids stay in geomIds so loadEntities reports bad_id — LOCK-007). */
function partitionInstances(
  elements: readonly Element[],
  ids: readonly string[],
): { byId: Map<string, Element>; instanceEls: readonly Element[]; geomIds: readonly string[] } {
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const instanceEls: Element[] = [];
  const geomIds: string[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (el === undefined) {
      geomIds.push(id); // loadEntities reports the typed bad_id failure
      continue;
    }
    if (isInstanceElement(el)) instanceEls.push(el);
    else geomIds.push(id);
  }
  return { byId, instanceEls, geomIds };
}

/** The placed instance fields of an element (x/y/scale/rotation). */
function instancePlacement(el: Element): { x: number; y: number; scale: number; rotation: number } {
  const p = el.props as Record<string, unknown>;
  return {
    x: typeof p.x === "number" ? p.x : 0,
    y: typeof p.y === "number" ? p.y : 0,
    scale: typeof p.scale === "number" ? p.scale : 1,
    rotation: typeof p.rotation === "number" ? p.rotation : 0,
  };
}

function opMove(elements: readonly Element[], ids: readonly string[], dx: number, dy: number): EntityOpOutcome {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EntityOpError("displacement must be finite", "bad_input");
  const { instanceEls, geomIds } = partitionInstances(elements, ids);
  const edits: DocumentEdit[] = [];
  for (const el of instanceEls) {
    const at = instancePlacement(el);
    edits.push({ type: "updateElement", elementId: el.id, patch: { x: at.x + dx, y: at.y + dy } });
  }
  let convertedNote = "";
  if (geomIds.length > 0) {
    const views = loadEntities(elements, geomIds);
    const converted: string[] = [];
    for (const view of views.values()) {
      if (isRectangleElement(view.element)) converted.push(view.element.id);
      edits.push(replaceGeomEdit(view, moveGeom(view.geom, dx, dy)));
    }
    if (converted.length > 0) {
      convertedNote = ` (rectangle${converted.length === 1 ? "" : "s"} materialized as closed polyline)`;
    }
  }
  return outcome(edits, `${plurality(ids.length, "entity", "entities")} moved by (${dx}, ${dy})${convertedNote}`, {
    modified: ids.length,
  });
}

function opCopy(elements: readonly Element[], ids: readonly string[], dx: number, dy: number): EntityOpOutcome {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EntityOpError("displacement must be finite", "bad_input");
  const { instanceEls, geomIds } = partitionInstances(elements, ids);
  const edits: DocumentEdit[] = [];
  // CAD-PARITY-006: instance copies keep the full placement + attribute
  // values + display overrides (the layer travels via the props copy).
  for (const el of instanceEls) {
    const at = instancePlacement(el);
    edits.push({
      type: "addElement",
      element: {
        id: "",
        kind: "geometry",
        engineId: null,
        props: { ...el.props, x: at.x + dx, y: at.y + dy },
      },
    });
  }
  if (geomIds.length > 0) {
    const views = loadEntities(elements, geomIds);
    for (const view of views.values()) {
      // CAD-PARITY-004: copies inherit the source's display overrides
      // (AutoCAD-class COPY semantics — display properties travel with the
      // copy; the layer assignment travels too via layerOfElement).
      edits.push(addGeomEdit(moveGeom(view.geom, dx, dy), layerOfElement(view.element), displayOverridesOf(view.element.props as Record<string, unknown>)));
    }
  }
  return outcome(edits, `${plurality(ids.length, "copy", "copies")} created`, { created: ids.length });
}

function opSetGeometry(elements: readonly Element[], id: string, geom: Geom): EntityOpOutcome {
  const view = loadEntities(elements, [id]).get(id)!;
  // The replacement geometry must itself be a well-formed canonical record
  // (the callers derive it from the shared grip semantics; the op still
  // re-validates through the decoder — LOCK-007).
  const roundTrip = propsToGeom({ ...(geom as unknown as Record<string, unknown>) });
  if (roundTrip === null || JSON.stringify(roundTrip) !== JSON.stringify(geom)) {
    throw new EntityOpError("replacement geometry is not a well-formed canonical record", "bad_entity");
  }
  return outcome([replaceGeomEdit(view, geom)], `geometry of '${id}' updated`, { modified: 1 });
}

/** CAD-PARITY-007: the deterministic array/pattern op (rectangular +
 *  polar — the bounded pattern surface). ONE atomic batch of copies with
 *  document-minted identities (replay-safe: the batch is a single recorded
 *  revision); constraint bindings do NOT travel to the copies (they bind
 *  the SOURCE canonical identities — the honest bounded rule, echoed by
 *  the commands). */
function opArray(
  elements: readonly Element[],
  op: Extract<EntityModifyOp, { op: "array" }>,
): EntityOpOutcome {
  if (op.ids.length === 0) throw new EntityOpError("array requires at least one source entity", "bad_input");
  const { instanceEls, geomIds } = partitionInstances(elements, op.ids);
  const views = geomIds.length > 0 ? loadEntities(elements, geomIds) : new Map<string, EntityView>();
  const edits: DocumentEdit[] = [];

  const placeInstanceCopy = (el: Element, dx: number, dy: number, rotationDelta: number): void => {
    const at = instancePlacement(el);
    edits.push({
      type: "addElement",
      element: {
        id: "",
        kind: "geometry",
        engineId: null,
        props: {
          ...el.props,
          x: at.x + dx,
          y: at.y + dy,
          rotation: normalizedRotation(at.rotation + rotationDelta),
        },
      },
    });
  };
  const placeGeomCopy = (view: EntityView, dx: number, dy: number, rotationDelta: number, pivot: Pt): void => {
    let geom = moveGeom(view.geom, dx, dy);
    if (rotationDelta !== 0) geom = rotateGeom(geom, pivot, rotationDelta);
    edits.push(addGeomEdit(geom, layerOfElement(view.element), displayOverridesOf(view.element.props as Record<string, unknown>)));
  };
  /** The classic polar-array copy: rotateItems=true rotates the whole
   *  geometry about the array center (pure rotation — endpoints map
   *  p ↦ R(center, angle)·p); rotateItems=false translates by the rotated
   *  bounding-box-center delta with the orientation preserved. */
  const placePolarGeomCopy = (view: EntityView, angle: number, center: Pt, rotateItems: boolean): void => {
    if (rotateItems) {
      edits.push(
        addGeomEdit(
          rotateGeom(view.geom, center, angle),
          layerOfElement(view.element),
          displayOverridesOf(view.element.props as Record<string, unknown>),
        ),
      );
      return;
    }
    const box = geometryBounds(view.geom);
    const px = box.minX + (box.maxX - box.minX) / 2;
    const py = box.minY + (box.maxY - box.minY) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = center.x + cos * (px - center.x) - sin * (py - center.y);
    const ry = center.y + sin * (px - center.x) + cos * (py - center.y);
    placeGeomCopy(view, rx - px, ry - py, 0, center);
  };

  if (op.mode === "rectangular") {
    const rows = op.rows ?? 1;
    const columns = op.columns ?? 1;
    const rowSpacing = op.rowSpacing ?? 0;
    const columnSpacing = op.columnSpacing ?? 0;
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1) {
      throw new EntityOpError("array rows/columns must be integers >= 1", "bad_input");
    }
    if (!Number.isFinite(rowSpacing) || !Number.isFinite(columnSpacing)) {
      throw new EntityOpError("array spacings must be finite", "bad_input");
    }
    const copies = rows * columns - 1;
    if (copies <= 0) {
      return {
        edit: null,
        summary: `rectangular array is a single item (rows ${rows} x columns ${columns}) — nothing to create`,
        createdCount: 0,
        modifiedCount: 0,
        removedCount: 0,
      };
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        if (r === 0 && c === 0) continue; // the source stays
        const dx = c * columnSpacing;
        const dy = r * rowSpacing;
        for (const el of instanceEls) placeInstanceCopy(el, dx, dy, 0);
        for (const view of views.values()) placeGeomCopy(view, dx, dy, 0, { x: 0, y: 0 });
      }
    }
    return outcome(
      edits,
      `rectangular array: ${copies} cop${copies === 1 ? "y" : "ies"} created (${rows} x ${columns}, spacing (${columnSpacing}, ${rowSpacing}))`,
      { created: copies * op.ids.length },
    );
  }

  // Polar.
  const center = op.center;
  if (center === undefined || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    throw new EntityOpError("polar array requires a finite center", "bad_input");
  }
  const items = op.items ?? 2;
  if (!Number.isInteger(items) || items < 2) {
    throw new EntityOpError("polar array requires an integer item count >= 2 (including the source)", "bad_input");
  }
  const span = op.angleSpan ?? Math.PI * 2;
  if (!Number.isFinite(span) || span <= 0) {
    throw new EntityOpError("polar array angle span must be > 0", "bad_input");
  }
  const full = span >= Math.PI * 2 - 1e-9;
  const step = full ? Math.PI * 2 / items : span / (items - 1);
  for (let i = 1; i < items; i++) {
    const angle = i * step;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const el of instanceEls) {
      const at = instancePlacement(el);
      const rx = center.x + cos * (at.x - center.x) - sin * (at.y - center.y);
      const ry = center.y + sin * (at.x - center.x) + cos * (at.y - center.y);
      placeInstanceCopy(el, rx - at.x, ry - at.y, op.rotateItems === false ? 0 : angle);
    }
    for (const view of views.values()) {
      placePolarGeomCopy(view, angle, center, op.rotateItems !== false);
    }
  }
  const spanNote = full ? "full circle" : `${span * 180 / Math.PI}° span`;
  const copies = items - 1;
  return outcome(
    edits,
    `polar array: ${copies} cop${copies === 1 ? "y" : "ies"} created (${items} items, ${spanNote}${op.rotateItems === false ? ", items not rotated" : ""})`,
    { created: copies * op.ids.length },
  );
}

/** The world-space bounds of a geometry (the polar-array translation
 *  basis — deterministic, exact for the flat vocabulary). */
function geometryBounds(g: Geom): { minX: number; minY: number; maxX: number; maxY: number } {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline":
      return { minX: Math.min(g.x1, g.x2), minY: Math.min(g.y1, g.y2), maxX: Math.max(g.x1, g.x2), maxY: Math.max(g.y1, g.y2) };
    case "circle":
    case "arc":
      return { minX: g.cx - g.r, minY: g.cy - g.r, maxX: g.cx + g.r, maxY: g.cy + g.r };
    case "ellipse": {
      const reach = Math.max(g.rx, g.ry);
      return { minX: g.cx - reach, minY: g.cy - reach, maxX: g.cx + reach, maxY: g.cy + reach };
    }
    case "point":
      return { minX: g.x, minY: g.y, maxX: g.x, maxY: g.y };
    case "polyline": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const v of g.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { minX, minY, maxX, maxY };
    }
    case "spline": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const v of g.controlPoints) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { minX, minY, maxX, maxY };
    }
    case "region": {
      const b = g.boundary;
      if (b.kind === "circle") return { minX: b.cx - b.r, minY: b.cy - b.r, maxX: b.cx + b.r, maxY: b.cy + b.r };
      if (b.kind === "ellipse") return { minX: b.cx - b.rx, minY: b.cy - b.ry, maxX: b.cx + b.rx, maxY: b.cy + b.ry };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const v of b.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { minX, minY, maxX, maxY };
    }
  }
}

function requireFinitePt(p: Pt, what: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new EntityOpError(`${what} must be finite`, "bad_input");
  }
}

function opRotate(elements: readonly Element[], ids: readonly string[], base: Pt, angle: number): EntityOpOutcome {
  if (!Number.isFinite(angle)) throw new EntityOpError("angle must be finite", "bad_input");
  requireFinitePt(base, "base point");
  const { instanceEls, geomIds } = partitionInstances(elements, ids);
  const edits: DocumentEdit[] = [];
  // CAD-PARITY-006: instance rotation = rotate the insertion point about
  // the base + add the angle to the instance rotation (exact similarity
  // composition — the content transform derives from the definition).
  for (const el of instanceEls) {
    const at = instancePlacement(el);
    const rotated = rotatePt({ x: at.x, y: at.y }, base, angle);
    edits.push({
      type: "updateElement",
      elementId: el.id,
      patch: { x: rotated.x, y: rotated.y, rotation: normalizedRotation(at.rotation + angle) },
    });
  }
  let convNote = "";
  if (geomIds.length > 0) {
    const views = loadEntities(elements, geomIds);
    const converted: string[] = [];
    for (const view of views.values()) {
      if (isRectangleElement(view.element)) converted.push(view.element.id);
      edits.push(replaceGeomEdit(view, rotateGeom(view.geom, base, angle)));
    }
    if (converted.length > 0) {
      convNote = ` (rectangle${converted.length === 1 ? "" : "s"} materialized as closed polyline)`;
    }
  }
  const deg = (angle * 180) / Math.PI;
  return outcome(edits, `${plurality(ids.length, "entity", "entities")} rotated ${deg.toFixed(2)}°${convNote}`, {
    modified: ids.length,
  });
}

function opScale(elements: readonly Element[], ids: readonly string[], base: Pt, factor: number): EntityOpOutcome {
  if (!(factor > 0)) throw new EntityOpError("scale factor must be positive", "bad_factor");
  requireFinitePt(base, "base point");
  const { instanceEls, geomIds } = partitionInstances(elements, ids);
  const edits: DocumentEdit[] = [];
  // CAD-PARITY-006: instance scaling = scale the insertion point distance
  // from the base + multiply the uniform instance scale.
  for (const el of instanceEls) {
    const at = instancePlacement(el);
    const scaled = scalePt({ x: at.x, y: at.y }, base, factor);
    edits.push({
      type: "updateElement",
      elementId: el.id,
      patch: { x: scaled.x, y: scaled.y, scale: at.scale * factor },
    });
  }
  let convNote = "";
  if (geomIds.length > 0) {
    const views = loadEntities(elements, geomIds);
    const converted: string[] = [];
    for (const view of views.values()) {
      if (isRectangleElement(view.element)) converted.push(view.element.id);
      edits.push(replaceGeomEdit(view, scaleGeom(view.geom, base, factor)));
    }
    if (converted.length > 0) {
      convNote = ` (rectangle${converted.length === 1 ? "" : "s"} materialized as closed polyline)`;
    }
  }
  return outcome(edits, `${plurality(ids.length, "entity", "entities")} scaled ×${factor.toFixed(4)}${convNote}`, {
    modified: ids.length,
  });
}

function opMirror(
  elements: readonly Element[],
  ids: readonly string[],
  p1: Pt,
  p2: Pt,
  eraseSource: boolean,
): EntityOpOutcome {
  requireFinitePt(p1, "axis point 1");
  requireFinitePt(p2, "axis point 2");
  if (dist(p1, p2) <= 1e-9) throw new EntityOpError("mirror axis needs two distinct points", "degenerate");
  // CAD-PARITY-006: mirroring a block/xref instance requires mirroring the
  // CONTENT (a negative/uniform-anisotropic scale), which this bounded slice
  // does not support — a typed failure naming the limitation (LOCK-007/008:
  // explicit unsupported, never a silent approximation).
  const { instanceEls, geomIds } = partitionInstances(elements, ids);
  if (instanceEls.length > 0) {
    throw new EntityOpError(
      `mirroring block/reference instances is unsupported in this build (mirrored content needs negative or non-uniform scales) — instance${instanceEls.length === 1 ? "" : "s"} '${instanceEls.map((el) => el.id).join("', '")}' declined`,
      "mirror_unsupported",
    );
  }
  const views = loadEntities(elements, geomIds);
  const edits: DocumentEdit[] = [];
  const converted: string[] = [];
  for (const view of views.values()) {
    if (isRectangleElement(view.element)) converted.push(view.element.id);
    const mirrored = mirrorGeom(view.geom, p1, p2);
    if (eraseSource) {
      edits.push(replaceGeomEdit(view, mirrored));
    } else {
      edits.push(addGeomEdit(mirrored, layerOfElement(view.element)));
    }
  }
  const convNote = converted.length > 0 ? ` (rectangle${converted.length === 1 ? "" : "s"} materialized as closed polyline)` : "";
  const kept = eraseSource ? "" : " (source kept)";
  return outcome(
    edits,
    `${plurality(ids.length, "entity", "entities")} mirrored${kept}${convNote}`,
    eraseSource ? { modified: ids.length } : { created: ids.length },
  );
}

function opOffset(
  elements: readonly Element[],
  items: readonly { targetId: string; distance: number; side: Pt; through: boolean }[],
): EntityOpOutcome {
  const edits: DocumentEdit[] = [];
  const messages: string[] = [];
  let n = 0;
  for (const item of items) {
    const view = loadEntities(elements, [item.targetId]).get(item.targetId)!;
    try {
      let distance = item.distance;
      let side = item.side;
      if (item.through) {
        const through = throughDistance(view.geom, item.side);
        if (through === null) {
          messages.push("through point is on the curve — zero offset");
          continue;
        }
        distance = through.distance;
        side = through.side;
      }
      const g = offsetGeom(view.geom, distance, side);
      edits.push(addGeomEdit(g, layerOfElement(view.element)));
      n++;
    } catch (err) {
      if (err instanceof GeomOpError) {
        messages.push(`${view.element.id}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (n === 0 && messages.length > 0) {
    throw new EntityOpError(messages[0]!, "offset_failed");
  }
  return outcome(edits, `${plurality(n, "offset")} created${messages.length > 0 ? `; skipped: ${messages.join("; ")}` : ""}`, {
    created: n,
  });
}

function opTrim(
  elements: readonly Element[],
  edges: readonly string[],
  trims: readonly { targetId: string; pick: Pt }[],
): EntityOpOutcome {
  if (trims.length === 0) throw new EntityOpError("trim requires at least one target pick", "bad_input");
  // Implied "all edges" when no cutting edges were selected (AutoCAD Enter
  // semantics): every OTHER canonical entity is a potential edge.
  const trimmedIds = new Set(trims.map((t) => t.targetId));
  const edgeIds =
    edges.length > 0
      ? edges
      : elements.filter((el) => geomFromElement(el) !== null && !trimmedIds.has(el.id)).map((el) => el.id);
  const edgeViews = loadEntities(elements, edgeIds);
  const edgeGeoms = [...edgeViews.values()].map((v) => v.geom);

  const edits: DocumentEdit[] = [];
  const messages: string[] = [];
  let trimmed = 0;
  for (const t of trims) {
    const view = loadEntities(elements, [t.targetId]).get(t.targetId)!;
    try {
      const result = trimGeom(view.geom, edgeGeoms, t.pick);
      if (result === null) {
        edits.push(removeEdit(view.element.id));
        trimmed++;
        continue;
      }
      if (result.length === 1) {
        edits.push(replaceGeomEdit(view, result[0]!));
        trimmed++;
        continue;
      }
      // Split: replace with the first piece, add the rest.
      edits.push(replaceGeomEdit(view, result[0]!));
      for (const extra of result.slice(1)) {
        edits.push(addGeomEdit(extra, layerOfElement(view.element)));
      }
      trimmed++;
    } catch (err) {
      if (err instanceof GeomOpError) {
        messages.push(`${view.element.id}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (trimmed === 0 && messages.length > 0) {
    throw new EntityOpError(messages[0]!, "trim_failed");
  }
  return outcome(
    edits,
    `${plurality(trimmed, "trim")} applied${messages.length > 0 ? `; skipped: ${messages.join("; ")}` : ""}`,
  );
}

function opExtend(
  elements: readonly Element[],
  boundaries: readonly string[],
  targets: readonly { targetId: string; pick: Pt }[],
): EntityOpOutcome {
  if (targets.length === 0) throw new EntityOpError("extend requires at least one target pick", "bad_input");
  const targetIds = new Set(targets.map((t) => t.targetId));
  const boundaryIds =
    boundaries.length > 0
      ? boundaries
      : elements.filter((el) => geomFromElement(el) !== null && !targetIds.has(el.id)).map((el) => el.id);
  const boundaryViews = loadEntities(elements, boundaryIds);
  const boundaryGeoms = [...boundaryViews.values()].map((v) => v.geom);

  const edits: DocumentEdit[] = [];
  const messages: string[] = [];
  let extended = 0;
  for (const t of targets) {
    const view = loadEntities(elements, [t.targetId]).get(t.targetId)!;
    try {
      const g = extendGeom(view.geom, boundaryGeoms, t.pick);
      edits.push(replaceGeomEdit(view, g));
      extended++;
    } catch (err) {
      if (err instanceof GeomOpError) {
        messages.push(`${view.element.id}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (extended === 0 && messages.length > 0) {
    throw new EntityOpError(messages[0]!, "extend_failed");
  }
  return outcome(
    edits,
    `${plurality(extended, "entity", "entities")} extended${messages.length > 0 ? `; skipped: ${messages.join("; ")}` : ""}`,
  );
}

function opStretch(
  elements: readonly Element[],
  ids: readonly string[],
  winMin: Pt,
  winMax: Pt,
  dx: number,
  dy: number,
): EntityOpOutcome {
  requireFinitePt(winMin, "window corner 1");
  requireFinitePt(winMax, "window corner 2");
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EntityOpError("displacement must be finite", "bad_input");
  const views = loadEntities(elements, ids);
  const edits: DocumentEdit[] = [];
  const converted: string[] = [];
  let stretched = 0;
  for (const view of views.values()) {
    const stretchedGeom = stretchGeom(view.geom, winMin, winMax, dx, dy);
    if (sameGeom(view.geom, stretchedGeom)) continue; // outside the window — untouched
    if (isRectangleElement(view.element)) converted.push(view.element.id);
    edits.push(replaceGeomEdit(view, stretchedGeom));
    stretched++;
  }
  const convNote = converted.length > 0 ? ` (rectangle${converted.length === 1 ? "" : "s"} materialized as closed polyline)` : "";
  return outcome(edits, `${plurality(stretched, "entity", "entities")} stretched${convNote}`, {
    modified: stretched,
  });
}

function opFillet(
  elements: readonly Element[],
  op: Extract<EntityModifyOp, { op: "fillet" }>,
): EntityOpOutcome {
  const edits: DocumentEdit[] = [];
  if (op.mode === "polyline") {
    if (typeof op.polylineId !== "string") throw new EntityOpError("polyline fillet requires polylineId", "bad_input");
    const view = loadEntities(elements, [op.polylineId]).get(op.polylineId)!;
    if (view.geom.type !== "polyline") {
      throw new EntityOpError("entity is not a polyline", "bad_entity");
    }
    const { pieces, arcs } = filletPolyline(view.geom, op.radius);
    edits.push(removeEdit(view.element.id));
    const layer = layerOfElement(view.element);
    for (const p of pieces) edits.push(addGeomEdit(p, layer));
    for (const a of arcs) edits.push(addGeomEdit(a, layer));
    return outcome(
      edits,
      `polyline filleted: ${pieces.length} segment${pieces.length === 1 ? "" : "s"} + ${arcs.length} corner arc${arcs.length === 1 ? "" : "s"} (corners split into arcs — straight-segment polylines)`,
      { removed: 1, created: pieces.length + arcs.length },
    );
  }
  if (typeof op.firstId !== "string" || typeof op.secondId !== "string" ||
      op.firstPick === undefined || op.secondPick === undefined) {
    throw new EntityOpError("fillet requires two entity picks", "bad_input");
  }
  const a = loadEntities(elements, [op.firstId]).get(op.firstId)!;
  const b = loadEntities(elements, [op.secondId]).get(op.secondId)!;
  const res = filletLineLine(a.geom, b.geom, op.firstPick, op.secondPick, op.radius);
  if (res.a !== null) edits.push(replaceGeomEdit(a, res.a));
  else edits.push(removeEdit(a.element.id));
  if (res.b !== null) edits.push(replaceGeomEdit(b, res.b));
  else edits.push(removeEdit(b.element.id));
  if (res.arc !== null) edits.push(addGeomEdit(res.arc, layerOfElement(a.element)));
  return outcome(
    edits,
    op.radius > 0 ? `fillet radius ${op.radius} applied` : "corner joined (radius 0)",
  );
}

function opChamfer(
  elements: readonly Element[],
  op: Extract<EntityModifyOp, { op: "chamfer" }>,
): EntityOpOutcome {
  const edits: DocumentEdit[] = [];
  if (op.mode === "polyline") {
    if (typeof op.polylineId !== "string") throw new EntityOpError("polyline chamfer requires polylineId", "bad_input");
    const view = loadEntities(elements, [op.polylineId]).get(op.polylineId)!;
    if (view.geom.type !== "polyline") {
      throw new EntityOpError("entity is not a polyline", "bad_entity");
    }
    edits.push(replaceGeomEdit(view, chamferPolyline(view.geom, op.d1, op.d2)));
    return outcome(edits, `polyline chamfered (${op.d1} × ${op.d2})`, { modified: 1 });
  }
  if (typeof op.firstId !== "string" || typeof op.secondId !== "string" ||
      op.firstPick === undefined || op.secondPick === undefined) {
    throw new EntityOpError("chamfer requires two entity picks", "bad_input");
  }
  const a = loadEntities(elements, [op.firstId]).get(op.firstId)!;
  const b = loadEntities(elements, [op.secondId]).get(op.secondId)!;
  const res = chamferLineLine(a.geom, b.geom, op.firstPick, op.secondPick, op.d1, op.d2);
  if (res.a !== null) edits.push(replaceGeomEdit(a, res.a));
  else edits.push(removeEdit(a.element.id));
  if (res.b !== null) edits.push(replaceGeomEdit(b, res.b));
  else edits.push(removeEdit(b.element.id));
  if (res.chamfer !== null) edits.push(addGeomEdit(res.chamfer, layerOfElement(a.element)));
  return outcome(edits, `chamfer ${op.d1} × ${op.d2} applied`);
}

function opBreak(
  elements: readonly Element[],
  targetId: string,
  p1: Pt,
  p2: Pt | null,
): EntityOpOutcome {
  const view = loadEntities(elements, [targetId]).get(targetId)!;
  const result = breakGeom(view.geom, p1, p2);
  const edits: DocumentEdit[] = [];
  if (result === null) {
    edits.push(removeEdit(view.element.id));
    return outcome(edits, "entity removed by break", { removed: 1 });
  }
  if (result.length === 1 && sameGeom(view.geom, result[0]!)) {
    return outcome([], "break had no effect");
  }
  edits.push(replaceGeomEdit(view, result[0]!));
  for (const extra of result.slice(1)) {
    edits.push(addGeomEdit(extra, layerOfElement(view.element)));
  }
  return outcome(edits, `broken into ${result.length} piece${result.length === 1 ? "" : "s"}`);
}

function opJoin(elements: readonly Element[], ids: readonly string[]): EntityOpOutcome {
  if (ids.length < 2) throw new EntityOpError("join needs at least two entities", "bad_input");
  const views = loadEntities(elements, ids);
  const ordered = ids.map((id) => views.get(id)!);
  let joined: Geom;
  try {
    joined = joinGeoms(ordered.map((v) => v.geom));
  } catch (err) {
    // Typed failure at the API surface (Architect review): geometry-level
    // declines (gap between collinear lines / same-circle arcs, non-
    // joinable types) surface as join_failed — never the generic
    // entity_invalid catch-all.
    if (err instanceof GeomOpError) throw new EntityOpError(err.message, "join_failed");
    throw err;
  }
  const edits: DocumentEdit[] = [];
  edits.push(replaceGeomEdit(ordered[0]!, joined));
  for (const v of ordered.slice(1)) {
    edits.push(removeEdit(v.element.id));
  }
  return outcome(edits, `joined into one ${joined.type}`, { modified: 1, removed: ids.length - 1 });
}

function opExplode(
  elements: readonly Element[],
  ids: readonly string[],
  blockDefById?: (id: string) => BlockDefinitionRecord | undefined,
): EntityOpOutcome {
  const edits: DocumentEdit[] = [];
  const messages: string[] = [];
  let n = 0;
  let materialized = 0;
  for (const id of ids) {
    const el = elements.find((e) => e.id === id);
    // CAD-PARITY-006: block instances explode through the ONE shared
    // materialization (definition content at the instance transform;
    // attributes become text entities; nested references stay references —
    // one level per explode, AutoCAD semantics).
    if (el !== undefined && isBlockRefElement(el)) {
      const ref = blockRefFromElement(el);
      if (ref === null) {
        messages.push(`${id}: malformed block instance props`);
        continue;
      }
      if (blockDefById === undefined) {
        messages.push(`${id}: explode requires the block-definition table`);
        continue;
      }
      try {
        const pieces = explodeBlockInstance(ref, { blockDefById, xrefById: () => undefined });
        edits.push(removeEdit(el.id));
        for (const piece of pieces) {
          if (piece.kind === "text") {
            edits.push({
              type: "addElement",
              element: {
                id: "",
                kind: "annotation",
                engineId: null,
                props: { drafting: true, annotation: true, ...piece.props },
              },
            });
          } else {
            edits.push({
              type: "addElement",
              element: { id: "", kind: "geometry", engineId: null, props: piece.props },
            });
          }
          materialized++;
        }
        n++;
      } catch (err) {
        if (err instanceof BlockError) {
          messages.push(`${id}: ${err.message}`);
        } else {
          throw err;
        }
      }
      continue;
    }
    if (el !== undefined && isXrefRefElement(el)) {
      // Bounded slice: exploding an xref instance would BIND its content —
      // explicitly unsupported (typed skip, never a silent approximation).
      messages.push(`${id}: exploding external references is unsupported in this build (binding is a non-goal of the bounded xref slice)`);
      continue;
    }
    const view = loadEntities(elements, [id]).get(id)!;
    try {
      const parts = explodeGeom(view.geom);
      edits.push(removeEdit(view.element.id));
      for (const p of parts) edits.push(addGeomEdit(p, layerOfElement(view.element)));
      n++;
    } catch (err) {
      if (err instanceof GeomOpError) {
        messages.push(`${view.element.id}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (n === 0 && messages.length > 0) {
    throw new EntityOpError(messages[0]!, "explode_failed");
  }
  const note = materialized > 0 ? ` (${materialized} content entit${materialized === 1 ? "y" : "ies"} materialized)` : "";
  return outcome(
    edits,
    `${plurality(n, "entity", "entities")} exploded${note}${messages.length > 0 ? `; skipped: ${messages.join("; ")}` : ""}`,
  );
}
